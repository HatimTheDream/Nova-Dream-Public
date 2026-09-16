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
    const ended = await service.end(device, { requestId: randomUUID(), epoch: store.epoch, attemptId: a.id }); assert.equal(ended.state, 'ended');
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
