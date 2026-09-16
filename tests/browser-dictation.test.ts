import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BrowserDictation as Client } from '../apps/client/src/browser-dictation.js';
import { BrowserDictation as Host } from '../apps/service/browser-dictation.js';
import type { DictationAttempt } from '../packages/domain/dictation.js';
import type { AssistantTransport } from '../apps/service/gateway.js';

const attempt = (): DictationAttempt => ({ id: randomUUID(), requestId: randomUUID(), epoch: randomUUID(), deviceId: 'device', draftId: 'draft', generation: 'generation', state: 'listening', route: 'browser', text: '', final: false, sequence: -1, updatedAt: Date.now() });
function clientFixture() {
  const sent: any[] = [], requests: any[] = [], updates: string[] = [], errors: Error[] = [];
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const channel: any = { readyState: 'open', send(value: string) { sent.push(JSON.parse(value)); }, close() {} };
  const event = (value: any) => channel.onmessage({ data: JSON.stringify(value) });
  const peer: any = { addTrack() {}, createDataChannel: () => channel, createOffer: async () => ({ sdp: 'v=0\r\n' }), setLocalDescription: async () => {}, setRemoteDescription: async () => { event({ type: 'session.created' }); }, close() {} };
  const api: any = async (path: string, value: any) => { requests.push({ path, value }); return path.endsWith('/offer') ? { sdp: 'v=0\r\n' } : {}; };
  const a = attempt(), client = new Client(a.epoch, a, text => updates.push(text), e => errors.push(e), api, () => peer);
  const ack = () => event({ type: 'session.updated', session: { tools: [], tool_choice: 'none', audio: { input: { transcription: { model: 'gpt-live-transcribe' }, turn_detection: { create_response: false } } } } });
  return { client, event, ack, track, stream, sent, requests, updates, errors };
}
test('dictation keeps microphone muted until no-response acknowledgement and saves final phrases once', async () => {
  const f = clientFixture();
  try {
    const started = f.client.start(f.stream); await new Promise(r => setTimeout(r, 0));
    assert.equal(f.track.enabled, false); assert.equal(f.sent[0].session.tool_choice, 'none');
    f.ack(); await started; assert.equal(f.track.enabled, true);
    const delta = { type: 'conversation.item.input_audio_transcription.delta', event_id: 'delta1', item_id: 'one', delta: 'Hello' };
    f.event(delta); f.event(delta); assert.equal(f.updates.at(-1), 'Hello');
    f.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'Hello.' });
    f.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: 'stale' });
    f.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'two', transcript: 'Hello.' });
    const finished = f.client.finish(); assert.equal(f.track.enabled, false);
    f.event({ type: 'error', error: { code: 'input_audio_buffer_commit_empty' } }); await finished;
    assert.equal(f.updates.at(-1), 'Hello.\nHello.');
    assert.equal(f.requests.filter(r => r.path.endsWith('/caption')).length, 2);
    assert.equal(f.requests.some(r => /chat|submit/.test(r.path)), false);
    assert.equal(f.sent.some(e => e.type === 'response.create'), false); assert.equal(f.errors.length, 0);
  } finally { f.client.close(); }
  assert.equal(f.track.stopped, true);
});
test('dictation rejects an unexpected reply and retains words on connection interruption', async () => {
  const f = clientFixture();
  const started = f.client.start(f.stream); await new Promise(r => setTimeout(r, 0)); f.ack(); await started;
  f.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: 'Retain this' });
  f.event({ type: 'response.created' });
  assert.equal(f.track.stopped, true); assert.equal(f.updates.at(-1), 'Retain this'); assert.equal(f.errors.length, 1);
  await assert.rejects(f.client.finish(), /last words/);
});
test('host uses one-use voice SDP and removes only the exact empty dictation session', async () => {
  const a = attempt(), calls: any[] = []; let exchanges = 0;
  const gateway = { status: () => ({ generation: a.generation, url: 'ws://127.0.0.1:1234' }), request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'sessions.create') return { key: `agent:main:${params.key}`, sessionId: 'exact-empty-session' };
    if (method === 'sessions.describe') return { session: { key: params.key, sessionId: 'exact-empty-session' } };
    if (method === 'sessions.delete') { assert.equal(params.archivedOnly, true); return { ok: true, key: params.key, deleted: true }; }
    if (method === 'talk.client.create') return { provider: 'openai', transport: 'webrtc', voiceSessionId: a.id, clientSecret: 'fixture-ephemeral', offerUrl: '/plugins/openai/realtime/calls' };
    return {};
  } } as unknown as AssistantTransport;
  const host = new Host(gateway, (async (url: any, options: any) => { exchanges++; assert.equal(url, 'http://127.0.0.1:1234/plugins/openai/realtime/calls'); assert.equal(options.headers.Authorization, 'Bearer fixture-ephemeral'); return new Response('v=0\r\n'); }) as typeof fetch);
  const identity = await host.prepare(a, { realtime: { providers: [{ id: 'openai', configured: true, supportsBrowserSession: true, transports: ['webrtc'], models: ['gpt-realtime-2.1'] }] } });
  assert.equal(JSON.stringify(identity).includes('fixture-ephemeral'), false);
  await host.offer({ ...a, ...identity }, 'v=0\r\n'); await assert.rejects(host.offer({ ...a, ...identity }, 'v=0\r\n'), /expired/); assert.equal(exchanges, 1);
  assert.equal(await host.close({ ...a, ...identity }), true);
  assert.equal(calls.find(c => c.method === 'sessions.delete').params.expectedSessionId, 'exact-empty-session');
  assert.equal(calls.some(c => ['chat.send', 'talk.client.transcript', 'talk.client.toolResult'].includes(c.method)), false);
  const count = calls.length; assert.equal(await host.close({ ...a, ...identity, generation: 'replacement' }), false); assert.equal(calls.length, count);
});

test('dictation cleanup recovers lost deletion without touching replacement or active sessions', async () => {
  const a = { ...attempt(), nativeKey: '', browserNativeId: 'original' }; a.nativeKey = `agent:main:e3:dictation:${a.id}`;
  let session: any = { key: a.nativeKey, sessionId: 'original' }, deleted = 0, patched = 0;
  const gateway = { status: () => ({ generation: a.generation }), request: async (method: string, params: any) => {
    if (method === 'sessions.describe') return { session };
    if (method === 'sessions.patch') { assert.equal(params.expectedSessionId, 'original'); assert.equal(params.archived, true); patched++; return {}; }
    if (method === 'sessions.delete') { assert.equal(params.expectedSessionId, 'original'); assert.equal(params.archivedOnly, true); deleted++; session = null; throw Error('Lost acknowledgement'); }
    return { ok: true };
  } } as unknown as AssistantTransport;
  const host = new Host(gateway);
  assert.equal(await host.close(a), false); assert.equal(await host.close(a), true); assert.equal(deleted, 1); assert.equal(patched, 1);
  session = { key: a.nativeKey, sessionId: 'replacement' }; assert.equal(await host.close(a), false);
  session = { key: a.nativeKey, sessionId: 'original', hasActiveRun: true }; assert.equal(await host.close(a), false);
  assert.equal(deleted, 1); assert.equal(patched, 1);
});
test('dictation captures backing identity before provider preparation can fail', async () => {
  const a = attempt(); let captured: any;
  const gateway = { status: () => ({ generation: a.generation }), request: async (method: string, params: any) => {
    if (method === 'sessions.create') return { key: `agent:main:${params.key}`, sessionId: 'kept-identity' };
    if (method === 'talk.client.create') throw Error('Provider unavailable');
    throw Error('Connection interrupted');
  } } as unknown as AssistantTransport;
  await assert.rejects(new Host(gateway).prepare(a, { realtime: { providers: [{ id: 'openai', configured: true, supportsBrowserSession: true, transports: ['webrtc'], models: ['gpt-realtime-2.1'] }] } }, identity => { captured = identity; }), /Provider unavailable/);
  assert.equal(captured.browserNativeId, 'kept-identity'); assert.equal(captured.nativeKey, `agent:main:e3:dictation:${a.id}`);
});
