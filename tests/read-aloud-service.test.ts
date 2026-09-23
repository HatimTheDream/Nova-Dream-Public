import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SpeechPlayback } from '../apps/service/read-aloud.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { AssistantConnection } from '../packages/domain/assistant.js';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
// A minimal PCM WAV envelope; playback/voice quality is deliberately not inferred from it.
const wave = Buffer.alloc(46); wave.write('RIFF', 0); wave.writeUInt32LE(38, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(2, 40);
const audio = { provider: 'fixture', audioBase64: wave.toString('base64'), mimeType: 'audio/wav' };
const catalog = () => ({ speech: { ready: true, activeProvider: 'fixture-alias', providers: [{ id: 'fixture', label: 'Configured voice', configured: true, aliases: ['fixture-alias'], secret: 'not-for-client' }] }, realtime: { ready: false } });
function fixture() {
  const connection: AssistantConnection = { state: 'ready', message: '', methods: ['talk.catalog', 'talk.speak'], grantedScopes: ['operator.read', 'operator.talk'], generation: 'generation-a', modelAuthReady: false };
  const calls: { method: string; params: unknown }[] = [];
  const state = { epoch: 'workspace-a', rawCatalog: catalog() as unknown, rawAudio: audio as unknown, catalogResult: undefined as Promise<unknown> | undefined, speakResult: undefined as Promise<unknown> | undefined };
  const gateway: AssistantTransport = {
    status: () => structuredClone(connection), subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
    async request<T>(method: string, params: unknown) { calls.push({ method, params }); return await (method === 'talk.catalog' ? state.catalogResult ?? state.rawCatalog : state.speakResult ?? state.rawAudio) as T; },
  };
  const input = (text = 'A clear reply.') => ({ requestId: randomUUID(), epoch: state.epoch, text, language: 'en-US' });
  return { gateway, connection, state, calls, input, service: new SpeechPlayback(gateway, () => state.epoch) };
}

test('speech catalog requires actual talk scope, supported methods and configured speech readiness independently of live voice', async () => {
  const f = fixture();
  f.connection.grantedScopes = ['operator.read', 'operator.write'];
  assert.equal((await f.service.catalog()).state, 'unavailable'); assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.speak('device', f.input()), /has not granted speech/); assert.equal(f.calls.length, 0);
  f.connection.grantedScopes.push('operator.talk'); f.connection.methods = ['talk.catalog'];
  assert.equal((await f.service.catalog()).state, 'unavailable'); assert.equal(f.calls.length, 0);
  f.connection.methods.push('talk.speak'); f.state.rawCatalog = { speech: { ...catalog().speech, ready: false }, realtime: { ready: true } };
  assert.equal((await f.service.catalog()).state, 'unavailable');
  f.state.rawCatalog = catalog();
  assert.deepEqual(await f.service.catalog(), { state: 'available', epoch: 'workspace-a', message: 'A configured speech provider is available.', provider: 'fixture', providerLabel: 'Configured voice' });
  assert.doesNotMatch(JSON.stringify(await f.service.catalog()), /secret|not-for-client|realtime/);
  f.state.rawCatalog = { speech: { ...catalog().speech, providers: [{ id: 'fixture', label: 'Voice', configured: false }] } };
  assert.equal((await f.service.catalog()).state, 'unavailable');
});

test('lazy preparation remains independent of ordinary chat and failure offers truthful device fallback', async () => {
  const f = fixture(); let prepared = 0;
  f.connection.state = 'unconfigured'; f.connection.grantedScopes = [];
  const lazy = new SpeechPlayback(f.gateway, () => f.state.epoch, Date.now, async () => { prepared++; f.connection.state = 'ready'; f.connection.generation = 'lazy-connection'; f.connection.grantedScopes = ['operator.read', 'operator.talk']; });
  assert.equal((await lazy.speak('device', f.input())).provider, 'fixture'); assert.equal(prepared, 1);
  assert.deepEqual(f.calls.map(call => call.method), ['talk.catalog', 'talk.speak']);
  assert.deepEqual(f.calls[1].params, { text: 'A clear reply.', language: 'en-US' });
  const denied = new SpeechPlayback(f.gateway, () => f.state.epoch, Date.now, async () => { throw Error('pairing requires permission'); });
  const unavailable = await denied.catalog(); assert.equal(unavailable.state, 'unavailable'); assert.match(unavailable.message, /device voice/); assert.equal(f.calls.length, 2);
});

test('workspace, connection and grant changes fence catalog and audio results', async () => {
  for (const change of ['epoch', 'generation', 'scope'] as const) {
    const f = fixture(), pending = deferred<unknown>(); f.state.catalogResult = pending.promise;
    const result = f.service.catalog(); await tick();
    if (change === 'epoch') f.state.epoch = 'workspace-b';
    if (change === 'generation') f.connection.generation = 'generation-b';
    if (change === 'scope') f.connection.grantedScopes = [];
    pending.resolve(catalog()); assert.equal((await result).state, 'unavailable');
  }
  for (const change of ['epoch', 'generation', 'scope', 'disconnect'] as const) {
    const f = fixture(), pending = deferred<unknown>(); f.state.speakResult = pending.promise;
    const result = f.service.speak('device', f.input()); await tick();
    if (change === 'epoch') f.state.epoch = 'workspace-b';
    if (change === 'generation') f.connection.generation = 'generation-b';
    if (change === 'scope') f.connection.grantedScopes = [];
    if (change === 'disconnect') f.connection.state = 'unconfigured';
    pending.resolve(audio); await assert.rejects(result, /connection changed before/);
  }
  const f = fixture(); await assert.rejects(f.service.speak('device', { ...f.input(), epoch: 'old-workspace' }), /workspace changed/); assert.equal(f.calls.length, 0);
});

test('speech rejects malformed, non-audio, mismatched and unsupported payloads and accepts verified extension fallback', async () => {
  for (const rawAudio of [
    {}, { ...audio, audioBase64: 'garbage??' }, { ...audio, audioBase64: 'AA=A' },
    { ...audio, audioBase64: Buffer.from('<html>an error</html>').toString('base64') },
    { ...audio, mimeType: 'text/html' }, { ...audio, mimeType: 'audio/ogg' },
    { ...audio, audioBase64: '' },
  ]) {
    const f = fixture(); f.state.rawAudio = rawAudio;
    await assert.rejects(f.service.speak('device', f.input()), /audio/);
  }
  const f = fixture(); f.state.rawAudio = { audioBase64: audio.audioBase64, provider: 'fixture', fileExtension: '.wav', unrelated: 'not-for-client' };
  assert.deepEqual(await f.service.speak('device', f.input()), audio);
});

test('concurrent retries share one synthesis and uncertain failures are not automatically repeated', async () => {
  const f = fixture(), pending = deferred<unknown>(), input = f.input(); f.state.speakResult = pending.promise;
  const first = f.service.speak('device', input), repeat = f.service.speak('device', input); await tick();
  assert.equal(f.calls.filter(call => call.method === 'talk.speak').length, 1);
  await assert.rejects(f.service.speak('device', { ...input, text: 'Different text' }), /different text/);
  pending.resolve(audio); assert.deepEqual(await first, audio); assert.deepEqual(await repeat, audio);
  const uncertain = fixture(), failure = deferred<unknown>(), same = uncertain.input(); uncertain.state.speakResult = failure.promise;
  const attempt = uncertain.service.speak('device', same); await tick(); failure.reject(Error('response lost'));
  await assert.rejects(attempt, /not returned/); await assert.rejects(uncertain.service.speak('device', same), /not returned/);
  assert.equal(uncertain.calls.filter(call => call.method === 'talk.speak').length, 1);
});

test('long replies pass eight cached chunks while evicted request identities cannot synthesize twice', async () => {
  const f = fixture(), first = f.input('First chunk.');
  await f.service.speak('device', first);
  for (let index = 1; index < 24; index++) assert.deepEqual(await f.service.speak('device', f.input(`Chunk ${index}.`)), audio);
  assert.equal(f.calls.filter(call => call.method === 'talk.speak').length, 24);
  await assert.rejects(f.service.speak('device', first), /no longer retained/);
  assert.equal(f.calls.filter(call => call.method === 'talk.speak').length, 24);
});

test('bounded concurrent synthesis rejects extra work without dispatching it', async () => {
  const f = fixture(), pending = deferred<unknown>(); f.state.speakResult = pending.promise;
  const requests = Array.from({ length: 8 }, (_, i) => f.service.speak('device', f.input(`Chunk ${i}.`))); await tick();
  await assert.rejects(f.service.speak('device', f.input('Ninth concurrent chunk.')), /reader is busy/);
  assert.equal(f.calls.filter(call => call.method === 'talk.speak').length, 8);
  pending.resolve(audio); await Promise.all(requests);
});
