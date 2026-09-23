import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import { Store } from '../apps/service/store.js';
import { DictationService } from '../apps/service/dictation.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { encodeDictation } from '../apps/client/src/useDictation.js';
import type { DictationAttempt } from '../packages/domain/dictation.js';

test('dictation retains distinct turns, fences stale partials and audio, and never sends a chat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e3-dictation-')), store = new Store(dir), device = store.session().deviceId;
  const generation = randomUUID(), calls: { method: string; params: any }[] = []; let emit = (_e: EventFrame) => {};
  const gateway: AssistantTransport = {
    status: () => ({ state: 'ready', generation, message: 'fixture', methods: [], grantedScopes: ['operator.write'], modelAuthReady: true }),
    models: async () => [], attachmentPolicy: () => ({}), subscribe: fn => { emit = fn; return () => {}; },
    request: async <T>(method: string, params: any): Promise<T> => { calls.push({ method, params }); return (method === 'talk.catalog' ? { transcription: { activeProvider: 'fixture', providers: [{ id: 'fixture', configured: true }] } } : method === 'talk.session.create' ? { sessionId: 'native', transcriptionSessionId: 'transcript', mode: 'transcription', transport: 'gateway-relay', brain: 'none', audio: { inputEncoding: 'g711_ulaw', inputSampleRateHz: 8000 } } : {}) as T; },
  };
  const service = new DictationService(store, gateway);
  try {
    const input = { requestId: randomUUID(), epoch: store.epoch, draftId: `draft:${device}` };
    const a = service.start(device, input); await new Promise(r => setTimeout(r, 0));
    assert.equal(service.read(device, a.id).encoding, 'mulaw');
    assert.equal(service.start(device, input).id, a.id); assert.equal(calls.filter(c => c.method === 'talk.session.create').length, 1);
    const event = (turn: string, text: string, final: boolean) => emit({ type: 'event', event: 'talk.event', payload: { transcriptionSessionId: 'transcript', type: final ? 'transcript' : 'partial', text, final, talkEvent: { turnId: turn } } });
    event('one', 'First sentence.', true); event('one', 'obsolete partial', false); event('two', 'Second sentence.', true); event('two', 'Second sentence.', true);
    assert.equal(service.read(device, a.id).text, 'First sentence.\nSecond sentence.');
    const audio = { requestId: randomUUID(), epoch: store.epoch, attemptId: a.id, sequence: 0, audio: encodeDictation(new Float32Array(4096), 'mulaw') };
    await service.audio(device, audio); await service.audio(device, audio); assert.equal(calls.filter(c => c.method === 'talk.session.appendAudio').length, 1);
    await assert.rejects(service.audio('another-device', { ...audio, sequence: 1 }), /another device/);
    await assert.rejects(service.audio(device, { ...audio, sequence: 2 }), /interrupted/);
    event('three', 'Unconfirmed words.', false); event('three', '', true);
    const ended = await service.end(device, { requestId: randomUUID(), epoch: store.epoch, attemptId: a.id }); assert.equal(ended.state, 'ended');
    assert.equal(ended.text, 'First sentence.\nSecond sentence.\nUnconfirmed words.'); assert.equal(ended.turns?.[2].final, false); assert.equal(ended.final, false); assert.match(ended.error!, /not confirmed/);
    event('three', 'late text', true); assert.equal(service.read(device, a.id).text, ended.text);
    await assert.rejects(service.audio(device, { ...audio, sequence: 1 }), /ended/);
    assert.equal(calls.some(c => c.method === 'chat.send'), false);
    assert.equal(calls.filter(c => c.method === 'talk.session.close').length, 1);
    const conversationId = randomUUID();
    store.internalWrite(`assistant:removal:${conversationId}`, { conversationId, state: 'prepared' });
    assert.throws(() => service.start(device, { ...input, requestId: randomUUID(), draftId: `draft:${device}:${conversationId}` }), { code: 'conversation_removed' });
    assert.equal(calls.filter(c => c.method === 'talk.session.create').length, 1);

  } finally { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('audio encoding preserves PCM sign and μ-law silence', () => {
  const pcm = Buffer.from(encodeDictation(new Float32Array([-1, 0, 1]), 'pcm16'), 'base64');
  assert.equal(pcm.readInt16LE(0), -32767); assert.equal(pcm.readInt16LE(2), 0); assert.equal(pcm.readInt16LE(4), 32767);
  assert.deepEqual([...Buffer.from(encodeDictation(new Float32Array([0]), 'mulaw'), 'base64')], [255]);
});

test('browser captions preserve spoken order, compatible legacy captions, and immutable words through recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e3-dictation-order-')), store = new Store(dir), device = store.session().deviceId, generation = randomUUID();
  const gateway = { status: () => ({ state: 'ready', generation, grantedScopes: ['operator.write'] }), subscribe: () => () => {}, request: async () => ({}) } as unknown as AssistantTransport;
  const service = new DictationService(store, gateway);
  const attempt: DictationAttempt = { id: randomUUID(), requestId: randomUUID(), epoch: store.epoch, deviceId: device, draftId: `draft:${device}`, generation, state: 'listening', route: 'browser', text: '', final: false, sequence: -1, updatedAt: Date.now() };
  store.internalWrite(`dictation:${attempt.id}`, attempt);
  const caption = (turnId: string, text: string, metadata: object = {}) => ({ requestId: randomUUID(), epoch: store.epoch, attemptId: attempt.id, turnId, text, final: true, ...metadata });
  try {
    const second = caption('second', 'Second.', { order: 1, previousTurnId: 'first' });
    service.caption(device, second); service.caption(device, second);
    service.caption(device, caption('first', 'First.', { order: 0, previousTurnId: null }));
    service.caption(device, caption('legacy', 'Legacy caller.'));
    assert.equal(service.read(device, attempt.id).text, 'First.\nSecond.\nLegacy caller.');
    assert.equal(service.read(device, attempt.id).turns?.length, 3);
    assert.throws(() => service.caption(device, caption('first', 'Changed.')), { code: 'dictation_caption_changed' });
    assert.throws(() => service.caption(device, caption('first', 'First.', { order: 2 })), { code: 'dictation_caption_changed' });
    assert.throws(() => service.caption('other-device', caption('third', 'Other device.')), { code: 'dictation_owner' });
    assert.throws(() => service.caption(device, { ...caption('third', 'Old workspace.'), epoch: randomUUID() }), { code: 'dictation_ended' });
    assert.throws(() => service.caption(device, caption('oversized', 'x'.repeat(100000))), { code: 'dictation_limit' });
    assert.equal(service.read(device, attempt.id).text, 'First.\nSecond.\nLegacy caller.');
    const ended = await service.end(device, { requestId: randomUUID(), epoch: store.epoch, attemptId: attempt.id });
    assert.equal(ended.text, 'First.\nSecond.\nLegacy caller.');
    const saved = store.internalRead<DictationAttempt>(`dictation:${attempt.id}`)!;
    assert.deepEqual(saved.turns?.map(turn => [turn.id, turn.order, turn.previousTurnId]), [['first', 0, null], ['second', 1, 'first'], ['legacy', undefined, undefined]]);
    assert.throws(() => service.caption(device, caption('third', 'Late.')), { code: 'dictation_ended' });
  } finally { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('late predecessor metadata corrects final caption order without changing saved words', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e3-dictation-predecessor-')), store = new Store(dir), device = store.session().deviceId, generation = randomUUID();
  const gateway = { status: () => ({ state: 'ready', generation, grantedScopes: ['operator.write'] }), subscribe: () => () => {}, request: async () => ({}) } as unknown as AssistantTransport;
  const service = new DictationService(store, gateway);
  const attempt: DictationAttempt = { id: randomUUID(), requestId: randomUUID(), epoch: store.epoch, deviceId: device, draftId: `draft:${device}`, generation, state: 'listening', route: 'browser', text: '', final: false, sequence: -1, updatedAt: Date.now() };
  store.internalWrite(`dictation:${attempt.id}`, attempt);
  const caption = (turnId: string, text: string, metadata: object = {}) => ({ requestId: randomUUID(), epoch: store.epoch, attemptId: attempt.id, turnId, text, final: true, ...metadata });
  try {
    service.caption(device, caption('second', 'Second.', { order: 0 }));
    service.caption(device, caption('first', 'First.', { order: 1 }));
    service.caption(device, caption('second', 'Second.', { order: 0, previousTurnId: 'first' }));
    assert.equal(service.read(device, attempt.id).text, 'First.\nSecond.');
    assert.throws(() => service.caption(device, caption('second', 'Second.', { previousTurnId: null })), { code: 'dictation_caption_changed' });
    assert.equal(service.read(device, attempt.id).text, 'First.\nSecond.');
  } finally { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
