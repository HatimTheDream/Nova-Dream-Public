import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../apps/client/src/voice-controller.js';
import type { Conversation } from '../packages/domain/assistant.js';

function memoryStorage(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); });
}

test('End while microphone permission is pending stops every late track and never admits a provider call', async () => {
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const originalPeer = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');
  let resolve!: (stream: MediaStream) => void;
  const tracks = [{ enabled: true, stopped: false, stop() { this.stopped = true; } }, { enabled: true, stopped: false, stop() { this.stopped = true; } }];
  let closed = false;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>(accept => { resolve = accept; }) } });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: class {} });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class { resume() { return Promise.resolve(); } close() { closed = true; return Promise.resolve(); } } });
  try {
    const voice = new VoiceController('permission-fixture');
    const starting = voice.start({ id: 'unused', revision: 1 } as Conversation, 'unused', 0);
    assert.equal(voice.getSnapshot().phase, 'permission');
    await voice.end();
    resolve({ getTracks: () => tracks } as unknown as MediaStream);
    await starting;
    assert.ok(tracks.every(track => !track.enabled && track.stopped));
    assert.equal(closed, true);
    assert.equal(voice.getSnapshot().attempt, undefined);
    await voice.recover(); assert.equal(voice.getSnapshot().phase, 'idle');
  } finally {
    for (const [target, name, descriptor] of [[navigator, 'mediaDevices', originalMedia], [globalThis, 'AudioContext', originalContext], [globalThis, 'RTCPeerConnection', originalPeer]] as const) { if (descriptor) Object.defineProperty(target, name, descriptor); else Reflect.deleteProperty(target, name); }
  }
});

test('mute fences local audio before notifying the UI and cannot enable a track during connection setup', () => {
  const voice = new VoiceController('mute-fixture');
  const internal = voice as any;
  const track = { enabled: true };
  const sent: any[] = [];
  internal.resources = { stream: { getAudioTracks: () => [track] }, channel: { readyState: 'open', send: (body: string) => sent.push(JSON.parse(body)) } };
  internal.view = { ...voice.getSnapshot(), muted: false, phase: 'connected' };
  let checked = false;
  const unsubscribe = voice.subscribe(() => { if (voice.getSnapshot().muted) { assert.equal(track.enabled, false); checked = true; } });
  voice.mute();
  assert.equal(checked, true); assert.equal(sent[0].type, 'input_audio_buffer.clear');
  internal.view = { ...voice.getSnapshot(), phase: 'connecting' };
  voice.mute(); assert.equal(track.enabled, false);
  unsubscribe();
});

test('local interruption silences playback in the input handler before provider acknowledgement', () => {
  const voice = new VoiceController('interrupt-fixture');
  const audio = { muted: false };
  const sent: any[] = [];
  (voice as any).resources = { audio, channel: { readyState: 'open', send: (body: string) => { assert.equal(audio.muted, true); sent.push(JSON.parse(body)); } } };
  voice.interrupt();
  assert.equal(audio.muted, true);
  assert.deepEqual(sent.map(event => event.type), ['response.cancel', 'output_audio_buffer.clear']);
});

test('interruption fences late responses until a newly committed input has its own audio stream', async t => {
  memoryStorage(t);
  const voice = new VoiceController('late-response-fixture'), internal = voice as any;
  const audio = { muted: false };
  internal.view = { ...voice.getSnapshot(), phase: 'connected', muted: false };
  internal.journal = { attempt: { id: 'fixture' }, entries: [], turns: [] };
  internal.resources = { audio, channel: { readyState: 'open', send: () => undefined } };
  const event = (value: any) => internal.providerEvent(JSON.stringify(value), 0);
  await event({ type: 'response.created', response: { id: 'old' } });
  voice.interrupt();
  await event({ type: 'input_audio_buffer.speech_started', item_id: 'new-input' });
  await event({ type: 'response.created', response: { id: 'late-old' } });
  await event({ type: 'output_audio_buffer.started', response_id: 'late-old' });
  assert.equal(audio.muted, true);
  await event({ type: 'input_audio_buffer.committed', item_id: 'new-input' });
  await event({ type: 'output_audio_buffer.started', response_id: 'old' });
  assert.equal(audio.muted, true);
  await event({ type: 'response.created', response: { id: 'new-response' } });
  assert.equal(audio.muted, true, 'response creation is not an audio boundary');
  await event({ type: 'output_audio_buffer.started', response_id: 'new-response' });
  assert.equal(audio.muted, false);
  assert.equal(voice.getSnapshot().processing, true);
  await event({ type: 'response.done', response: { id: 'old' } });
  assert.equal(voice.getSnapshot().processing, true);
  voice.interrupt();
  await event({ type: 'response.created', response: { id: 'late-old' } });
  await event({ type: 'output_audio_buffer.started', response_id: 'late-old' });
  assert.equal(audio.muted, true);
});

test('a commit after manual Stop or Mute cannot reopen cancelled playback or dispatch late tools', async t => {
  memoryStorage(t);
  for (const action of ['stop', 'mute']) {
    const voice = new VoiceController('cancelled-tools-' + action), internal = voice as any;
    const audio = { muted: false };
    internal.view = { ...voice.getSnapshot(), phase: 'connected', muted: false };
    internal.journal = { attempt: { id: 'fixture' }, entries: [], turns: [] };
    internal.resources = { audio, channel: { readyState: 'open', send: () => undefined } };
    const event = (value: any) => internal.providerEvent(JSON.stringify(value), 0);
    await event({ type: 'input_audio_buffer.speech_started', item_id: 'input' });
    if (action === 'stop') voice.interrupt(); else voice.mute();
    await event({ type: 'input_audio_buffer.committed', item_id: 'input' });
    await event({ type: 'response.created', response: { id: 'late' } });
    await event({ type: 'output_audio_buffer.started', response_id: 'late' });
    await event({ type: 'response.function_call_arguments.done', response_id: 'late', call_id: 'late-tool', name: 'openclaw_agent_consult', arguments: '{}' });
    assert.equal(audio.muted, true);
    assert.equal(internal.seenTools.size, 0);
  }
});

test('voice setup requests streaming captions alongside the complete Project instructions', async () => {
  const voice = new VoiceController('caption-setup-fixture'), internal = voice as any;
  const sent: any[] = [];
  internal.view = { ...voice.getSnapshot(), phase: 'connecting' };
  internal.journal = { attempt: { context: 'Project purpose: copper moon seven' } };
  internal.resources = { channel: { readyState: 'open', send: (body: string) => sent.push(JSON.parse(body)) } };
  await internal.providerEvent(JSON.stringify({ type: 'session.created', session: { instructions: 'Original provider instructions' } }), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].session.instructions, 'Original provider instructions\n\nProject purpose: copper moon seven');
  assert.deepEqual(sent[0].session.audio.input.transcription, { model: 'gpt-live-transcribe', delay: 'medium' });
});

test('Project acknowledgement alone cannot enable audio without the streaming transcription model', async () => {
  const voice = new VoiceController('caption-ack-fixture'), internal = voice as any;
  const track = { enabled: false };
  internal.view = { ...voice.getSnapshot(), phase: 'connecting', muted: false };
  internal.contextInstructions = 'Confirmed Project instructions';
  internal.resources = { stream: { getAudioTracks: () => [track] } };
  await internal.providerEvent(JSON.stringify({ type: 'session.updated', session: { instructions: internal.contextInstructions, audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' } } } } }), 0);
  assert.equal(track.enabled, false);
  assert.equal(voice.getSnapshot().phase, 'connecting');
});

test('microphone admission requires the acknowledged transcription model and delay together', async t => {
  memoryStorage(t);
  const previous = globalThis.fetch;
  let admitted = 0;
  globalThis.fetch = async () => { admitted++; return new Response(JSON.stringify({ id: 'fixture', state: 'active', entries: [], consults: [] }), { headers: { 'Content-Type': 'application/json' } }); };
  t.after(() => { globalThis.fetch = previous; });
  const voice = new VoiceController('caption-delay-fixture'), internal = voice as any, track = { enabled: false };
  internal.view = { ...voice.getSnapshot(), phase: 'connecting', muted: false };
  internal.contextInstructions = 'Confirmed Project instructions';
  internal.journal = { start: { epoch: 'fixture' }, attempt: { id: 'fixture', contextDigest: 'digest' }, entries: [], turns: [] };
  internal.resources = { stream: { getAudioTracks: () => [track] } };
  const ack = (transcription: unknown) => internal.providerEvent(JSON.stringify({ type: 'session.updated', session: { instructions: internal.contextInstructions, audio: { input: { transcription } } } }), 0);
  for (const transcription of [undefined, null, { model: 'gpt-live-transcribe' }, { model: 'gpt-live-transcribe', delay: 'low' }, { model: 'gpt-4o-mini-transcribe', delay: 'medium' }]) {
    await ack(transcription); assert.equal(track.enabled, false); assert.equal(admitted, 0);
  }
  await ack({ model: 'gpt-live-transcribe', delay: 'medium' });
  assert.equal(admitted, 1); assert.equal(track.enabled, true); assert.equal(voice.getSnapshot().phase, 'connected');
});

test('a late Enable sound completion cannot change an ended call or replay released audio', async () => {
  const voice = new VoiceController('late-enable-fixture'), internal = voice as any;
  let resume!: () => void, played = 0;
  internal.view = { ...voice.getSnapshot(), phase: 'connected', soundBlocked: true };
  internal.resources = { context: { resume: () => new Promise<void>(resolve => { resume = resolve; }), close: () => Promise.resolve() }, audio: { pause() {}, play() { played++; return Promise.resolve(); } } };
  const enabling = voice.enableSound();
  await voice.end(); resume(); await enabling;
  assert.equal(played, 0); assert.equal(voice.getSnapshot().phase, 'idle'); assert.equal(voice.getSnapshot().soundBlocked, true);
  assert.deepEqual(voice.getLevelsSnapshot(), { input: 0, output: 0 });
});

test('pre-commit streaming captions remain after earlier turns without reserving a history ordinal', async () => {
  const voice = new VoiceController('caption-order-fixture'), internal = voice as any;
  internal.view = { ...voice.getSnapshot(), phase: 'connected', turns: [{ attemptId: 'fixture', turnId: 'previous', role: 'assistant', text: 'Earlier reply', original: 'Earlier reply', final: true, edited: false, sequence: 1, seen: [] }] };
  internal.order = ['previous'];
  internal.journal = { attempt: { id: 'fixture' } };
  await internal.providerEvent(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'new-input', event_id: 'partial-1', delta: 'A new ' }), 0);
  await internal.providerEvent(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'new-input', event_id: 'partial-2', delta: 'thought' }), 0);
  assert.deepEqual(voice.getSnapshot().turns.map(turn => turn.text), ['Earlier reply', 'A new thought']);
  assert.equal(voice.getSnapshot().turns[1].final, false);
  assert.deepEqual(internal.order, ['previous']);
  assert.equal(internal.pendingFinals.size, 0);
});

function hangupFixture(t: TestContext, options: { caption?: boolean; partial?: boolean; pendingFinal?: boolean; unsavedRemote?: boolean; endState?: string; networkFailure?: boolean } = {}) {
  memoryStorage(t);
  const voice = new VoiceController('hangup-fixture'), internal = voice as any, paths: string[] = [];
  const entry = { entryId: 'spoken-turn', ordinal: 0, role: 'user', text: 'Keep these spoken words', timestamp: 1, saved: false };
  const turn = { attemptId: 'attempt', turnId: entry.entryId, role: 'user', text: entry.text, original: entry.text, final: !options.partial, edited: false, sequence: 1, seen: [] };
  internal.view = { ...voice.getSnapshot(), phase: 'connected', turns: options.caption || options.partial || options.pendingFinal ? [turn] : [] };
  internal.journal = { start: { epoch: 'epoch' }, attempt: { id: 'attempt', state: 'active', entries: [], consults: [] }, entries: options.caption ? [entry] : [], turns: [] };
  if (options.pendingFinal) internal.pendingFinals.set(turn.turnId, turn);
  const previous = globalThis.fetch;
  globalThis.fetch = async input => {
    const path = String(input); paths.push(path);
    if (options.networkFailure || options.unsavedRemote && path.endsWith('/finals')) throw new Error('Connection unavailable');
    return new Response(JSON.stringify({ id: 'attempt', state: path.endsWith('/end') ? options.endState ?? 'ended' : 'active',
      entries: options.caption || options.unsavedRemote ? [{ ...entry, saved: !options.unsavedRemote }] : [], consults: [],
      message: options.unsavedRemote ? 'Captions still need saving.' : 'Call ended. Final captions are saved.' }), { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = previous; });
  return { voice, internal, paths, stored: () => localStorage.getItem('e3:voice-call:hangup-fixture') };
}

test('hanging up a confirmed saved call dismisses it without a second close or recovery request', async t => {
  const f = hangupFixture(t, { caption: true });
  await f.voice.end();
  assert.equal(f.voice.getSnapshot().phase, 'idle'); assert.equal(f.voice.getSnapshot().unsaved, 0);
  assert.equal(f.internal.journal, undefined); assert.equal(f.stored(), null);
  assert.deepEqual(f.paths, ['/api/assistant/voice/finals', '/api/assistant/voice/end']);
  assert.equal(f.voice.getSnapshot().turns[0].text, 'Keep these spoken words');
});

test('hangup keeps unsaved local and server captions available for recovery', async t => {
  const f = hangupFixture(t, { caption: true, unsavedRemote: true });
  await f.voice.end();
  assert.equal(f.voice.getSnapshot().phase, 'ended'); assert.equal(f.voice.getSnapshot().unsaved, 1);
  assert.equal(f.internal.journal.entries[0].saved, false);
  assert.equal(JSON.parse(f.stored()!).entries[0].text, 'Keep these spoken words');
});

test('a retained call still retries its original captions and closes after confirmed recovery', async t => {
  const options = { caption: true, unsavedRemote: true }, f = hangupFixture(t, options);
  await f.voice.end(); assert.equal(f.voice.getSnapshot().phase, 'ended');
  options.unsavedRemote = false;
  await f.voice.recover();
  assert.equal(f.voice.getSnapshot().phase, 'idle'); assert.equal(f.stored(), null); assert.equal(f.internal.journal, undefined);
  assert.deepEqual(f.paths, ['/api/assistant/voice/finals', '/api/assistant/voice/end', '/api/assistant/voice/finals', '/api/assistant/voice/end']);
});

test('server-only unsaved captions also prevent automatic dismissal', async t => {
  const f = hangupFixture(t, { unsavedRemote: true });
  await f.voice.end();
  assert.equal(f.voice.getSnapshot().phase, 'ended'); assert.ok(f.internal.journal); assert.ok(f.stored());
  assert.equal(f.voice.getSnapshot().attempt?.entries[0].saved, false);
});

test('lost hangup acknowledgement keeps the original call and reports missing confirmation', async t => {
  const f = hangupFixture(t, { networkFailure: true });
  await f.voice.end();
  assert.equal(f.voice.getSnapshot().phase, 'ended'); assert.equal(f.internal.journal.attempt.id, 'attempt');
  assert.match(f.voice.getSnapshot().message, /confirmation/); assert.ok(f.stored());
  assert.deepEqual(f.paths, ['/api/assistant/voice/end']);
});

for (const endState of ['interrupted', 'failed']) test(`hangup retains ${endState} closure for review`, async t => {
  const f = hangupFixture(t, { endState }); await f.voice.end();
  assert.equal(f.voice.getSnapshot().phase, 'ended'); assert.ok(f.internal.journal); assert.ok(f.stored());
});

for (const options of [{ partial: true }, { pendingFinal: true }]) test(`hangup preserves ${options.partial ? 'provisional words' : 'pending final captions'} instead of silently dismissing`, async t => {
  const f = hangupFixture(t, options); await f.voice.end();
  assert.equal(f.voice.getSnapshot().phase, 'ended'); assert.match(f.voice.getSnapshot().message, /unconfirmed/);
  assert.equal(f.voice.getSnapshot().turns[0].text, 'Keep these spoken words');
  assert.equal(JSON.parse(f.stored()!).turns[0].text, 'Keep these spoken words'); assert.ok(f.internal.journal);
});

test('an error remains visible even when its remote cleanup succeeds', async t => {
  const f = hangupFixture(t); await f.internal.fail('Microphone disconnected.');
  assert.equal(f.voice.getSnapshot().phase, 'error'); assert.ok(f.internal.journal); assert.ok(f.stored());
});
