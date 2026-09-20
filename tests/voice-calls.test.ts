import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import type { AssistantConnection } from '../packages/domain/assistant.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { Store } from '../apps/service/store.js';
import { AssistantService } from '../apps/service/assistant.js';
import { VoiceSetup } from '../apps/service/voice.js';
import { VoiceCalls } from '../apps/service/voice-calls.js';
import { captureVoiceSources, voiceSourceContext, voiceSourceFileLimit } from '../apps/service/voice-sources.js';
import { sourceMime } from '../packages/domain/source-transfer.js';

class Transport implements AssistantTransport {
  generation = randomUUID(); nativeId = randomUUID();
  calls: { method: string; params: any }[] = [];
  listeners = new Set<(event: EventFrame) => void>();
  holdHistory?: Promise<void>; holdCreate?: Promise<void>; holdSource?: Promise<void>; nativeSources = false; wrongSourceTarget = false;
  offerUrl = '/plugins/openai/realtime/calls'; failTranscript = false; failConsult = false; maxPayload?: number;
  historyTitle?: string;
  status(): AssistantConnection { return { state: 'ready', url: 'ws://127.0.0.1:19999', generation: this.generation, message: 'Fixture', methods: this.nativeSources ? ['e3.sources.stage'] : [], grantedScopes: ['operator.read', 'operator.write'], modelAuthReady: true }; }
  models() { return Promise.resolve([]); } attachmentPolicy() { return { maxPayload: this.maxPayload }; }
  subscribe(fn: (event: EventFrame) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'sessions.create') return { key: params.key, sessionId: this.nativeId } as T;
    if (method === 'chat.history') { await this.holdHistory; return { sessionId: this.nativeId, messages: [], sessionInfo: { activeRunIds: [], ...(this.historyTitle ? { label: this.historyTitle } : {}) } } as T; }
    if (method === 'talk.catalog') return { realtime: { ready: true, providers: [{ id: 'openai', label: 'OpenAI', configured: true, models: ['gpt-realtime-2.1'], voices: ['marin'], modes: ['realtime'], brains: ['agent-consult'], transports: ['webrtc'], supportsBrowserSession: true }] } } as T;
    if (method === 'talk.client.create') { await this.holdCreate; return { provider: 'openai', transport: 'webrtc', voiceSessionId: params.voiceSessionId, clientSecret: 'fixture-private-one-use-secret', offerUrl: this.offerUrl } as T; }
    if (method === 'e3.sources.stage') { await this.holdSource; return { epoch: params.epoch, nativeKey: params.nativeKey, nativeId: this.wrongSourceTarget ? randomUUID() : params.nativeId, file: params.file, mimeType: sourceMime(params.file.name), mediaId: `source-${params.file.id}.pdf`, path: `/fixture/native/source-${params.file.id}.pdf` } as T; }
    if (method === 'talk.client.transcript' && this.failTranscript) throw new Error('Lost transcript receipt');
    if (method === 'talk.client.toolCall') {
      if (this.failConsult) throw new Error('Lost acceptance');
      for (const fn of this.listeners) fn({ type: 'event', event: 'chat', payload: { runId: 'exact-run', sessionKey: params.sessionKey, state: 'final', message: { content: 'Exact backing answer' } } });
      return { runId: 'exact-run', agentSessionKey: params.sessionKey } as T;
    }
    return { ok: true } as T;
  }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function fixture(run: (f: { store: Store; gateway: Transport; assistant: AssistantService; voice: VoiceCalls; device: string; start: any; exchanges: any[]; action: (id: string) => { requestId: string; epoch: string; attemptId: string } }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-voice-'));
  const store = new Store(directory), gateway = new Transport(), assistant = new AssistantService(store, gateway), exchanges: any[] = [];
  const voice = new VoiceCalls(store, gateway, assistant, new VoiceSetup(gateway), (async (url, options) => { exchanges.push({ url, options }); return new Response('v=0\r\nfixture-answer', { headers: { 'Content-Type': 'application/sdp' } }); }) as typeof fetch);
  const device = store.session().deviceId, projectId = `project:${randomUUID()}`;
  store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, entityId: projectId, expectedRevision: 0, kind: 'project', payload: { name: 'Full context', purpose: `${'Long context. '.repeat(500)}END_SENTINEL_COPPER_MOON` } });
  const conversation = await assistant.create(device, { requestId: randomUUID(), epoch: store.epoch, title: 'Original voice conversation', projectId });
  const start = { requestId: randomUUID(), epoch: store.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, projectRevision: 1 };
  try { await run({ store, gateway, assistant, voice, device, start, exchanges, action: id => ({ requestId: randomUUID(), epoch: store.epoch, attemptId: id }) }); }
  finally { gateway.holdCreate = undefined; gateway.holdHistory = undefined; await voice.close(); assistant.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('one owned call captures the full Project and exchanges one-use SDP without storing credentials', () => fixture(async f => {
  const attempt = f.voice.start(f.device, f.start); await tick();
  assert.equal(f.voice.start(f.device, f.start).id, attempt.id);
  assert.equal(f.gateway.calls.filter(c => c.method === 'talk.client.create').length, 1);
  assert.match(f.voice.read(f.device, attempt.id).context, /END_SENTINEL_COPPER_MOON/);
  assert.throws(() => f.voice.start(f.device, { ...f.start, requestId: randomUUID() }), /already open/);
  assert.throws(() => f.voice.read(randomUUID(), attempt.id), /another device/);
  const offer = { ...f.action(attempt.id), sdp: 'v=0\r\nfixture-private-offer' };
  assert.match((await f.voice.offer(f.device, offer)).sdp, /^v=0/);
  await assert.rejects(f.voice.offer(f.device, offer), /already attempted/);
  assert.equal(f.exchanges.length, 1);
  assert.equal(f.exchanges[0].url, 'http://127.0.0.1:19999/plugins/openai/realtime/calls');
  const persisted = JSON.stringify(f.store.internalList('voice:'));
  assert.ok(!persisted.includes('fixture-private-one-use-secret')); assert.ok(!persisted.includes('fixture-private-offer'));
  assert.equal((await f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest })).state, 'active');
  await assert.rejects(f.assistant.edit(f.device, { requestId: randomUUID(), epoch: f.store.epoch, conversationId: f.start.conversationId, expectedRevision: 1, title: 'Changed' }), /End the voice/);
}));

test('the first spoken title waits until End without interrupting the captured call', () => fixture(async f => {
  const conversation = await f.assistant.create(f.device, { requestId: randomUUID(), epoch: f.store.epoch, title: 'Voice chat', autoTitle: true, projectId: null });
  const attempt = f.voice.start(f.device, { ...f.start, conversationId: conversation.id, conversationRevision: conversation.revision, projectRevision: 0 }); await tick();
  await f.voice.offer(f.device, { ...f.action(attempt.id), sdp: 'v=0\r\nfixture' });
  await f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest });
  f.gateway.historyTitle = 'Hello, check one, check two';
  await f.voice.finals(f.device, { ...f.action(attempt.id), entries: [{ entryId: 'spoken_check', ordinal: 0, role: 'user', text: 'Hello, check one, check two.', timestamp: 1234 }] });
  assert.equal((await f.voice.pulse(f.device, f.action(attempt.id))).state, 'active');
  assert.equal(f.assistant.conversations().find(c => c.id === conversation.id)!.title, 'Voice chat');
  assert.equal(f.voice.read(f.device, attempt.id).entries[0].saved, true);
  assert.equal(f.gateway.calls.filter(call => call.method === 'talk.client.close').length, 0);
  await f.voice.end(f.device, f.action(attempt.id));
  await f.assistant.history(conversation.id);
  const after = f.assistant.conversations().find(c => c.id === conversation.id)!;
  assert.equal(after.title, f.gateway.historyTitle);
  assert.equal(after.nativeId, conversation.nativeId);
  assert.equal(after.revision, conversation.revision);
  assert.equal(f.gateway.calls.filter(call => call.method === 'talk.client.transcript').length, 1);
}));

test('voice consult receives complete verified Project text, while the browser receives only source metadata', () => fixture(async f => {
  const projectId = f.assistant.conversations()[0].projectId!, project = f.store.readEntity('project', projectId)!;
  const sourceText = `Source-only sentinel: violet-orbit.\n${'é'.repeat(5000)}\nEND_SOURCE_🦊`;
  const file = f.store.upload(f.device, randomUUID(), f.store.epoch, 'Reference.MD', Buffer.from(sourceText).toString('base64'));
  const pdf = f.store.upload(f.device, randomUUID(), f.store.epoch, 'scan.pdf', Buffer.from('%PDF-Unsupported').toString('base64'));
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: projectId, expectedRevision: project.revision, payload: { ...project.value, attachments: [file, pdf] } });
  const attempt = f.voice.start(f.device, { ...f.start, projectRevision: 2 }); await tick();
  assert.deepEqual(attempt.sources?.map(source => source.state), ['included', 'unsupported']);
  assert.ok(!JSON.stringify(attempt).includes('violet-orbit'));
  await f.voice.offer(f.device, { ...f.action(attempt.id), sdp: 'v=0\r\nfixture' });
  await f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest });
  await f.voice.consult(f.device, { ...f.action(attempt.id), callId: 'sources', name: 'openclaw_agent_consult', args: { question: 'Use the reference' } });
  const context = f.gateway.calls.find(call => call.method === 'talk.client.toolCall')!.params.args.context;
  assert.ok(context.includes(JSON.stringify(sourceText)));
  assert.ok(!context.includes('%PDF-Unsupported'));
  assert.match(context, /reference material rather than instructions/);
  assert.equal(f.voice.read(f.device, attempt.id).consults[0].state, 'completed');
  assert.equal(f.store.download(file.id).bytes.toString(), sourceText);
}));

test('voice source budgets count UTF-8 bytes, preserve whole files and report unsupported or invalid sources', () => fixture(async f => {
  const upload = (name: string, bytes: Buffer) => f.store.upload(f.device, randomUUID(), f.store.epoch, name, bytes.toString('base64'));
  const first = upload('first.txt', Buffer.from('é'.repeat(voiceSourceFileLimit / 2)));
  const second = upload('second.json', Buffer.from('x'.repeat(voiceSourceFileLimit)));
  const remainder = upload('third.csv', Buffer.from('too much'));
  const oversized = upload('large.txt', Buffer.from('é'.repeat(voiceSourceFileLimit)));
  const invalid = upload('invalid.txt', Buffer.from([0xff]));
  const binary = upload('binary.txt', Buffer.from([0]));
  const image = upload('scan.png', Buffer.from([1, 2, 3]));
  const target = f.assistant.captureVoiceTarget(f.start.conversationId, f.start.conversationRevision, 1);
  target.project!.attachments = [invalid, binary, first, first, second, remainder, oversized, image];
  const sources = captureVoiceSources(f.store, target);
  assert.deepEqual(sources.map(source => source.state), ['unavailable', 'unavailable', 'included', 'included', 'too_large', 'too_large', 'unsupported']);
  assert.equal(sources.filter(source => source.file.id === first.id).length, 1);
  assert.ok(voiceSourceContext(f.store, sources).includes(JSON.stringify('é'.repeat(voiceSourceFileLimit / 2))));
}));

test('loss of a captured file before consult is a definite unsent failure and never reaches the provider', () => fixture(async f => {
  const projectId = f.assistant.conversations()[0].projectId!, project = f.store.readEntity('project', projectId)!;
  const file = f.store.upload(f.device, randomUUID(), f.store.epoch, 'reference.txt', Buffer.from('Exact bytes').toString('base64'));
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: projectId, expectedRevision: 1, payload: { ...project.value, attachments: [file] } });
  const attempt = f.voice.start(f.device, { ...f.start, projectRevision: 2 }); await tick();
  await f.voice.offer(f.device, { ...f.action(attempt.id), sdp: 'v=0\r\nfixture' });
  await f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest });
  const download = f.store.download.bind(f.store); f.store.download = id => { if (id === file.id) throw new Error('Lost source'); return download(id); };
  const request = { ...f.action(attempt.id), callId: 'missing_source', name: 'openclaw_agent_consult', args: { question: 'Read it' } };
  await f.voice.consult(f.device, request); await f.voice.consult(f.device, { ...request, requestId: randomUUID() });
  assert.equal(f.gateway.calls.filter(call => call.method === 'talk.client.toolCall').length, 0);
  assert.equal(f.voice.read(f.device, attempt.id).consults[0].state, 'failed');
  assert.match(f.voice.read(f.device, attempt.id).consults[0].text!, /source is unavailable or changed/);
}));

test('voice rejects over-limit serialized consults before dispatch instead of reporting uncertain execution', () => fixture(async f => {
  const attempt = f.voice.start(f.device, f.start); await tick();
  await f.voice.offer(f.device, { ...f.action(attempt.id), sdp: 'v=0\r\nfixture' });
  await f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest });
  f.gateway.maxPayload = 1024;
  await f.voice.consult(f.device, { ...f.action(attempt.id), callId: 'too_large', name: 'openclaw_agent_consult', args: { question: 'Read it' } });
  assert.equal(f.gateway.calls.filter(call => call.method === 'talk.client.toolCall').length, 0);
  assert.equal(f.voice.read(f.device, attempt.id).consults[0].state, 'failed');
  assert.match(f.voice.read(f.device, attempt.id).consults[0].text!, /connection limit/);
}));

test('voice refinement captures only the exact saved output version and rejects missing provenance', () => fixture(async f => {
  const file = f.store.upload(f.device, randomUUID(), f.store.epoch, 'original.md', Buffer.from('ORIGINAL_OUTPUT_SENTINEL').toString('base64'));
  const id = randomUUID(), projectId = f.assistant.conversations()[0].projectId!;
  f.store.internalWrite(`assistant:output:${id}`, { id, version: 1, projectId, file, state: 'ready' });
  const refinement = await f.assistant.create(f.device, { requestId: randomUUID(), epoch: f.store.epoch, title: 'Refine original', projectId, refineSource: { outputId: id, version: 1, sha256: file.sha256 } });
  const target = f.assistant.captureVoiceTarget(refinement.id, refinement.revision, 1);
  assert.equal(target.refineFile?.sha256, file.sha256);
  const sources = captureVoiceSources(f.store, target);
  assert.equal(sources[0].origin, 'refinement');
  assert.match(voiceSourceContext(f.store, sources), /ORIGINAL_OUTPUT_SENTINEL/);
  f.store.internalWrite(`assistant:output:${id}`, { id, version: 2, projectId, file, state: 'ready' });
  assert.throws(() => f.assistant.captureVoiceTarget(refinement.id, refinement.revision, 1), /original refinement file is unavailable/);
}));

test('native voice sources finish preparing before audio creation and only verified paths reach a consult', () => fixture(async f => {
  f.gateway.nativeSources = true;
  const projectId = f.assistant.conversations()[0].projectId!, project = f.store.readEntity('project', projectId)!;
  const pdf = f.store.upload(f.device, randomUUID(), f.store.epoch, 'reference.pdf', Buffer.from('%PDF-full binary fixture').toString('base64'));
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: projectId, expectedRevision: 1, payload: { ...project.value, attachments: [pdf] } });
  let release!: () => void; f.gateway.holdSource = new Promise(resolve => { release = resolve; });
  const starting = f.voice.start(f.device, { ...f.start, projectRevision: 2 }); await tick();
  assert.equal(starting.sources?.[0].state, 'preparing'); assert.equal(f.gateway.calls.filter(call => call.method === 'talk.client.create').length, 0);
  release(); await tick(); const ready = f.voice.read(f.device, starting.id);
  assert.equal(ready.state, 'ready'); assert.equal(ready.sources?.[0].state, 'native'); assert.notEqual(ready.contextDigest, starting.contextDigest);
  assert.ok(!JSON.stringify(ready).includes('/fixture/native'));
  await f.voice.offer(f.device, { ...f.action(ready.id), sdp: 'v=0\r\nfixture' });
  await f.voice.pulse(f.device, { ...f.action(ready.id), contextDigest: ready.contextDigest });
  await f.voice.consult(f.device, { ...f.action(ready.id), callId: 'native_sources', name: 'openclaw_agent_consult', args: { question: 'Read this PDF' } });
  assert.equal(f.gateway.calls.filter(call => call.method === 'e3.sources.stage').length, 2);
  const consult = f.gateway.calls.find(call => call.method === 'talk.client.toolCall')!;
  assert.match(consult.params.args.context, /\/fixture\/native\//); assert.match(consult.params.args.context, /pdf tool/);
  assert.ok(!consult.params.args.context.includes('%PDF-full binary fixture')); assert.equal(f.voice.read(f.device, ready.id).consults[0].state, 'completed');
}));

test('ending during source preparation prevents late audio creation', () => fixture(async f => {
  f.gateway.nativeSources = true;
  const projectId = f.assistant.conversations()[0].projectId!, project = f.store.readEntity('project', projectId)!;
  const pdf = f.store.upload(f.device, randomUUID(), f.store.epoch, 'reference.pdf', Buffer.from('%PDF-fixture').toString('base64'));
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: projectId, expectedRevision: 1, payload: { ...project.value, attachments: [pdf] } });
  let release!: () => void; f.gateway.holdSource = new Promise(resolve => { release = resolve; });
  const attempt = f.voice.start(f.device, { ...f.start, projectRevision: 2 }); await tick();
  const closing = f.voice.end(f.device, f.action(attempt.id)); release(); await closing;
  assert.equal(f.voice.read(f.device, attempt.id).state, 'ended'); assert.equal(f.gateway.calls.filter(call => call.method === 'talk.client.create').length, 0);
}));

test('a native file receipt for another conversation prevents audio creation', () => fixture(async f => {
  f.gateway.nativeSources = true; f.gateway.wrongSourceTarget = true;
  const projectId = f.assistant.conversations()[0].projectId!, project = f.store.readEntity('project', projectId)!;
  const image = f.store.upload(f.device, randomUUID(), f.store.epoch, 'reference.png', Buffer.from('Image fixture').toString('base64'));
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: projectId, expectedRevision: 1, payload: { ...project.value, attachments: [image] } });
  const attempt = f.voice.start(f.device, { ...f.start, projectRevision: 2 }); await tick();
  assert.equal(f.voice.read(f.device, attempt.id).state, 'failed'); assert.equal(f.gateway.calls.filter(call => call.method === 'talk.client.create').length, 0);
}));

test('voice discovery overlaps history verification but audio creation waits for the captured target', () => fixture(async f => {
  let release!: () => void; f.gateway.holdHistory = new Promise<void>(resolve => { release = resolve; });
  const attempt = f.voice.start(f.device, f.start);
  try {
    await tick();
    assert.equal(f.gateway.calls.filter(c => c.method === 'talk.catalog').length, 1);
    assert.equal(f.gateway.calls.filter(c => c.method === 'talk.client.create').length, 0);
    assert.equal(f.voice.read(f.device, attempt.id).state, 'preparing');
  } finally { release(); }
  await tick(); assert.equal(f.voice.read(f.device, attempt.id).state, 'ready');
}));

test('repeated context admission preserves captions and consultations saved during its preflight', () => fixture(async f => {
  const attempt = f.voice.start(f.device, f.start); await tick();
  await f.voice.offer(f.device, { ...f.action(attempt.id), sdp: 'v=0\r\nfixture' });
  await f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); f.assistant.setApprovalReview(() => held);
  const repeated = f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest });
  let consulting: Promise<unknown> | undefined;
  try {
    await f.voice.finals(f.device, { ...f.action(attempt.id), entries: [{ entryId: 'during_admission', ordinal: 0, role: 'user', text: 'Synthetic caption', timestamp: 1234 }] });
    consulting = f.voice.consult(f.device, { ...f.action(attempt.id), callId: 'during_admission', name: 'openclaw_agent_consult', args: { question: 'Synthetic request' } });
    await tick();
    assert.equal(f.voice.read(f.device, attempt.id).entries[0].saved, true);
    assert.equal(f.voice.read(f.device, attempt.id).consults.length, 1);
  } finally { release(); }
  await repeated; await consulting;
  const current = f.voice.read(f.device, attempt.id);
  assert.equal(current.state, 'active');
  assert.equal(current.entries[0]?.entryId, 'during_admission'); assert.equal(current.entries[0]?.saved, true);
  assert.equal(current.consults[0]?.callId, 'during_admission'); assert.equal(current.consults[0]?.state, 'completed');
}));

test('context admission cannot reactivate a call ended during its preflight', () => fixture(async f => {
  const attempt = f.voice.start(f.device, f.start); await tick();
  await f.voice.offer(f.device, { ...f.action(attempt.id), sdp: 'v=0\r\nfixture' });
  await f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); f.assistant.setApprovalReview(() => held);
  const admission = assert.rejects(f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest }), { code: 'voice_context_changed' });
  try { assert.equal((await f.voice.end(f.device, f.action(attempt.id))).state, 'ended'); }
  finally { release(); }
  await admission; assert.equal(f.voice.read(f.device, attempt.id).state, 'ended');
}));

test('a Project change during preflight prevents voice admission to the provider', () => fixture(async f => {
  let release!: () => void; f.gateway.holdHistory = new Promise<void>(resolve => { release = resolve; });
  const attempt = f.voice.start(f.device, f.start), project = attempt.target.project!;
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: project.id, expectedRevision: 1, payload: { name: project.name, purpose: 'Changed' } });
  release(); await tick();
  assert.equal(f.voice.read(f.device, attempt.id).state, 'failed');
  assert.equal(f.gateway.calls.filter(c => c.method === 'talk.client.create').length, 0);
}));

test('End during provider creation closes only its captured voice session after the late response', () => fixture(async f => {
  let release!: () => void; f.gateway.holdCreate = new Promise<void>(resolve => { release = resolve; });
  const attempt = f.voice.start(f.device, f.start); await tick();
  const closing = f.voice.end(f.device, f.action(attempt.id)); release(); await closing;
  assert.equal(f.voice.read(f.device, attempt.id).state, 'ended');
  assert.deepEqual(f.gateway.calls.filter(c => c.method === 'talk.client.close').map(c => c.params), [{ sessionKey: attempt.target.conversation.nativeKey, voiceSessionId: attempt.id }]);
  assert.equal(f.exchanges.length, 0);
}));

test('unexpected offer destinations are rejected before any credential-bearing fetch', () => fixture(async f => {
  f.gateway.offerUrl = 'https://untrusted.example/collect';
  const attempt = f.voice.start(f.device, f.start); await tick();
  assert.notEqual(f.voice.read(f.device, attempt.id).state, 'ready');
  assert.equal(f.exchanges.length, 0);
}));

test('late finals retain causal order and an unknown transcript acknowledgement retries the same entry', () => fixture(async f => {
  const attempt = f.voice.start(f.device, f.start); await tick();
  const entry = (id: string, ordinal: number, role: 'user' | 'assistant') => ({ entryId: id, ordinal, role, text: `${role} final words`, timestamp: 1234 });
  await f.voice.finals(f.device, { ...f.action(attempt.id), entries: [entry('assistant_item', 1, 'assistant')] });
  assert.equal(f.gateway.calls.filter(c => c.method === 'talk.client.transcript').length, 0);
  f.gateway.failTranscript = true;
  const first = { ...f.action(attempt.id), entries: [entry('user_item', 0, 'user')] };
  await assert.rejects(f.voice.finals(f.device, first), /Lost transcript/);
  assert.equal(f.voice.read(f.device, attempt.id).entries.length, 2);
  f.gateway.failTranscript = false; await f.voice.finals(f.device, first);
  assert.deepEqual(f.gateway.calls.filter(c => c.method === 'talk.client.transcript').map(c => c.params.entryId), ['user_item', 'user_item', 'assistant_item']);
  assert.ok(f.voice.read(f.device, attempt.id).entries.every(e => e.saved));
  await assert.rejects(f.voice.finals(f.device, { ...f.action(attempt.id), entries: [{ ...entry('user_item', 0, 'user'), text: 'Changed' }] }), /changed identity/);
}));

test('consult forwards the full captured Project once and reconciles an early exact-run completion', () => fixture(async f => {
  const attempt = f.voice.start(f.device, f.start); await tick();
  await f.voice.offer(f.device, { ...f.action(attempt.id), sdp: 'v=0\r\nfixture' });
  await f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest });
  const input = { ...f.action(attempt.id), callId: 'call_one', name: 'openclaw_agent_consult', args: { question: 'Use the last Project sentinel', context: 'Additional spoken context' } };
  await f.voice.consult(f.device, input); await f.voice.consult(f.device, input);
  await f.voice.consult(f.device, { ...input, requestId: randomUUID() });
  const calls = f.gateway.calls.filter(c => c.method === 'talk.client.toolCall');
  assert.equal(calls.length, 1); assert.match(calls[0].params.args.context, /END_SENTINEL_COPPER_MOON/);
  assert.equal(f.voice.read(f.device, attempt.id).consults[0].text, 'Exact backing answer');
  assert.equal(f.voice.read(f.device, attempt.id).consults[0].state, 'completed');
  await f.voice.end(f.device, f.action(attempt.id));
  await assert.rejects(f.voice.consult(f.device, { ...input, requestId: randomUUID(), callId: 'call_after_end' }), /no longer accepting/);
}));

test('lost consult admission is never dispatched a second time', () => fixture(async f => {
  const attempt = f.voice.start(f.device, f.start); await tick();
  await f.voice.offer(f.device, { ...f.action(attempt.id), sdp: 'v=0\r\nfixture' });
  await f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest });
  f.gateway.failConsult = true;
  const input = { ...f.action(attempt.id), callId: 'call_unknown', name: 'openclaw_agent_consult', args: { question: 'Test unknown receipt' } };
  await f.voice.consult(f.device, input); await f.voice.consult(f.device, { ...input, requestId: randomUUID() });
  assert.equal(f.gateway.calls.filter(c => c.method === 'talk.client.toolCall').length, 1);
  assert.equal(f.voice.read(f.device, attempt.id).consults[0].state, 'unknown');
}));

test('a silent final settles its place without writing an invented native message', () => fixture(async f => {
  const attempt = f.voice.start(f.device, f.start); await tick();
  const result = await f.voice.finals(f.device, { ...f.action(attempt.id), entries: [{ entryId: 'empty_item', ordinal: 0, role: 'assistant', text: '', timestamp: 100 }, { entryId: 'next_item', ordinal: 1, role: 'user', text: 'Real words', timestamp: 200 }] });
  assert.ok(result.entries.every(e => e.saved));
  assert.deepEqual(f.gateway.calls.filter(c => c.method === 'talk.client.transcript').map(c => c.params.text), ['Real words']);
}));

test('native incarnation replacement during a live call stops new audio authority and retains the original target', () => fixture(async f => {
  const attempt = f.voice.start(f.device, f.start); await tick();
  await f.voice.offer(f.device, { ...f.action(attempt.id), sdp: 'v=0\r\nfixture' });
  await f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest });
  f.gateway.nativeId = randomUUID();
  await assert.rejects(f.voice.pulse(f.device, f.action(attempt.id)), /lost its original/);
  await tick();
  assert.equal(f.voice.read(f.device, attempt.id).target.conversation.nativeId, attempt.target.conversation.nativeId);
  assert.equal(f.voice.read(f.device, attempt.id).state, 'ended');
}));

test('a same-host reconnect closes the original call instead of silently resuming its microphone', () => fixture(async f => {
  const attempt = f.voice.start(f.device, f.start); await tick();
  for (const listener of f.gateway.listeners) listener({ type: 'event', event: 'e3.connected', payload: {} });
  await tick();
  assert.equal(f.voice.read(f.device, attempt.id).state, 'ended');
  assert.equal(f.gateway.calls.filter(c => c.method === 'talk.client.create').length, 1);
}));


test('voice and backing consult use the same captured memory, while removal affects the next call', () => fixture(async f => {
  const memory = { requestId: randomUUID(), epoch: f.store.epoch, id: randomUUID(), expectedRevision: 0, action: 'save', text: 'For this workspace, use violet-compass.', projectId: null };
  f.assistant.memory.change(f.device, memory);
  const attempt = f.voice.start(f.device, f.start); await tick();
  assert.ok(attempt.context.includes('violet-compass'));
  f.assistant.memory.change(f.device, { requestId: randomUUID(), epoch: f.store.epoch, id: memory.id, expectedRevision: 1, action: 'remove' });
  await f.voice.offer(f.device, { ...f.action(attempt.id), sdp: 'v=0\r\nfixture' });
  await f.voice.pulse(f.device, { ...f.action(attempt.id), contextDigest: attempt.contextDigest });
  await f.voice.consult(f.device, { ...f.action(attempt.id), callId: 'memory-consult', name: 'openclaw_agent_consult', args: { question: 'What preference should I use?' } });
  assert.ok(f.gateway.calls.find(call => call.method === 'talk.client.toolCall')!.params.args.context.includes('violet-compass'));
  assert.deepEqual(f.assistant.captureVoiceTarget(f.start.conversationId, 1, 1).memory?.entries, []);
}));
