import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceAudioMeter, type VoiceLevels } from '../apps/client/src/voice-audio-meter';
import { VoiceController } from '../apps/client/src/voice-controller';
import type { Conversation } from '../packages/domain/assistant';

type Signal = MediaStream & { amplitude: number };
class Analyser {
  fftSize = 512; disconnected = false; reads = 0; signal?: Signal;
  getFloatTimeDomainData(samples: Float32Array) { this.reads++; samples.forEach((_, index) => { samples[index] = (index % 2 ? -1 : 1) * (this.signal?.amplitude ?? 0); }); }
  disconnect() { this.disconnected = true; }
}
class Source {
  disconnected = false; connected?: Analyser;
  constructor(readonly signal: Signal) {}
  connect(analyser: Analyser) { this.connected = analyser; analyser.signal = this.signal; return analyser; }
  disconnect() { this.disconnected = true; }
}
class Context extends EventTarget {
  state = 'running'; sources: Source[] = []; analysers: Analyser[] = []; closed = false;
  createMediaStreamSource(signal: Signal) { const source = new Source(signal); this.sources.push(source); return source; }
  createAnalyser() { const analyser = new Analyser(); this.analysers.push(analyser); return analyser; }
  resume() { this.state = 'running'; this.dispatchEvent(new Event('statechange')); return Promise.resolve(); }
  close() { this.closed = true; this.state = 'closed'; this.dispatchEvent(new Event('statechange')); return Promise.resolve(); }
}
function globals(t: TestContext, target: object, name: PropertyKey, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, value });
  t.after(() => { if (previous) Object.defineProperty(target, name, previous); else Reflect.deleteProperty(target, name); });
}
function clock(t: TestContext) {
  let id = 0, now = 0;
  const frames = new Map<number, FrameRequestCallback>();
  globals(t, globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  globals(t, globalThis, 'cancelAnimationFrame', (frame: number) => { frames.delete(frame); });
  globals(t, globalThis, 'performance', { now: () => now });
  return { frames, step(ms = 34) { now += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)); } };
}
function meterFixture(t: TestContext) {
  let meter!: VoiceAudioMeter;
  t.after(() => meter?.dispose());
  const timing = clock(t), context = new Context(), gates = { input: true, output: true };
  const input = { amplitude: 0 } as Signal, output = { amplitude: 0 } as Signal;
  let levels: VoiceLevels = { input: 0, output: 0 }, speaking = false, notifications = 0;
  meter = new VoiceAudioMeter(context as unknown as AudioContext, () => gates, (value, audible) => { levels = value; speaking = audible; notifications++; });
  meter.setInput(input); meter.setOutput(output);
  return { ...timing, context, gates, input, output, meter, get levels() { return levels; }, get speaking() { return speaking; }, get notifications() { return notifications; } };
}

test('real microphone and playback samples produce independent bounded envelopes, and silence settles', t => {
  const f = meterFixture(t); f.step(); assert.deepEqual(f.levels, { input: 0, output: 0 });
  f.input.amplitude = 0.015; f.output.amplitude = 0.25; f.step();
  assert.ok(f.levels.input > 0 && f.levels.output > f.levels.input && f.levels.output <= 1);
  assert.equal(f.speaking, true);
  f.input.amplitude = f.output.amplitude = 0;
  for (let index = 0; index < 25; index++) f.step();
  assert.deepEqual(f.levels, { input: 0, output: 0 }); assert.equal(f.speaking, false);
  const notifications = f.notifications; f.step(); assert.equal(f.notifications, notifications, 'silence does not create repeated updates');
});

test('microphone permission/admission and blocked playback gates suppress real samples immediately', t => {
  const f = meterFixture(t); f.input.amplitude = f.output.amplitude = 0.2;
  f.gates.input = f.gates.output = false; f.step(); assert.deepEqual(f.levels, { input: 0, output: 0 });
  f.gates.input = f.gates.output = true; f.step(); assert.ok(f.levels.input > 0 && f.levels.output > 0);
  f.gates.input = false; f.meter.refresh(); assert.equal(f.levels.input, 0); assert.ok(f.levels.output > 0);
  f.gates.output = false; f.meter.refresh(); assert.deepEqual(f.levels, { input: 0, output: 0 }); assert.equal(f.speaking, false);
});

test('suspending the context clears stale activity and resumed sampling uses current sound', async t => {
  const f = meterFixture(t); f.input.amplitude = f.output.amplitude = 0.1; f.step();
  f.context.state = 'suspended'; f.context.dispatchEvent(new Event('statechange'));
  assert.deepEqual(f.levels, { input: 0, output: 0 }); assert.equal(f.speaking, false);
  f.input.amplitude = f.output.amplitude = 0; await f.context.resume(); f.step();
  assert.deepEqual(f.levels, { input: 0, output: 0 });
  f.input.amplitude = 0.1; f.step(); assert.ok(f.levels.input > 0); assert.equal(f.levels.output, 0);
});

test('replacement remote tracks disconnect old analysis nodes and keep exactly one sampler', t => {
  const f = meterFixture(t), oldSource = f.context.sources[1], oldAnalyser = f.context.analysers[1];
  f.output.amplitude = 0.3; f.step(); assert.ok(f.levels.output > 0);
  f.meter.setOutput({ amplitude: 0 } as Signal);
  assert.equal(oldSource.disconnected, true); assert.equal(oldAnalyser.disconnected, true);
  assert.equal(f.frames.size, 1); assert.equal(f.levels.output, 0); f.step(); assert.equal(f.levels.output, 0);
  assert.ok(f.context.sources.every(source => source.connected instanceof Analyser), 'meter graph never routes microphone or playback to the speaker destination');
});

test('meter disposal releases both graphs and every scheduled callback without owning media tracks', t => {
  const f = meterFixture(t); f.input.amplitude = f.output.amplitude = 0.2; f.step();
  const lateFrame = [...f.frames.values()][0]; f.meter.dispose();
  assert.equal(f.frames.size, 0); assert.ok(f.context.sources.every(source => source.disconnected)); assert.ok(f.context.analysers.every(analyser => analyser.disconnected));
  assert.deepEqual(f.levels, { input: 0, output: 0 });
  const notifications = f.notifications; lateFrame(500); f.context.dispatchEvent(new Event('statechange')); f.meter.setOutput(f.output);
  assert.equal(f.frames.size, 0); assert.equal(f.notifications, notifications);
});

test('invalid audio and quiet microphone hiss never invent motion', t => {
  const f = meterFixture(t); f.input.amplitude = 0.002; f.output.amplitude = Number.NaN;
  for (let index = 0; index < 4; index++) f.step();
  assert.deepEqual(f.levels, { input: 0, output: 0 }); assert.equal(f.speaking, false);
});

test('meter samples at a bounded cadence instead of running analysis for every display frame', t => {
  const f = meterFixture(t); f.input.amplitude = 0.1;
  f.step(16); f.step(16); f.step(16); f.step(16);
  assert.equal(f.context.analysers[0].reads, 2); assert.equal(f.frames.size, 1);
});

for (const playbackRecovery of [false, true]) test(playbackRecovery
  ? 'successful replacement playback restores metering and ignores stale play success or failure'
  : 'controller isolates fast level notifications, fences mute/interruption, and releases the actual call graphs', async t => {
  let voice!: VoiceController;
  t.after(async () => { if (voice) await voice.end(); });
  const timing = clock(t), values = new Map<string, string>(), calls: string[] = [];
  globals(t, globalThis, 'localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  const track = { enabled: true, readyState: 'live', onended: null as null | (() => void), stopped: false, stop() { this.stopped = true; this.readyState = 'ended'; } };
  const stream = { amplitude: 0, getTracks: () => [track], getAudioTracks: () => [track] } as unknown as Signal;
  const remote = { amplitude: 0.2 } as Signal;
  globals(t, navigator, 'mediaDevices', { getUserMedia: async () => stream });
  let context!: Context;
  globals(t, globalThis, 'AudioContext', class extends Context { constructor() { super(); context = this; } });
  let audio!: { muted: boolean; paused: boolean };
  let nextPlay: (() => Promise<void>) | undefined;
  globals(t, globalThis, 'Audio', class { autoplay = false; muted = false; paused = true; srcObject: unknown; onpause?: () => void; constructor() { audio = this; } async play() { await nextPlay?.(); this.paused = false; } pause() { this.paused = true; this.onpause?.(); } });
  const attempt = { id: 'fixture', state: 'ready', context: 'Captured context', contextDigest: 'digest', entries: [], consults: [] };
  globals(t, globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(url.endsWith('/offer') ? { sdp: 'v=0' } : { ...attempt, state: url.endsWith('/end') ? 'ended' : url.endsWith('/pulse') ? 'active' : 'ready' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  voice = new VoiceController('meter-call-fixture'); const internal = voice as any;
  let peerClosed = false;
  globals(t, globalThis, 'RTCPeerConnection', class {
    ontrack?: (event: unknown) => void; connectionState = 'connected';
    createDataChannel() { return { readyState: 'open', send() {}, close() {} }; }
    addTrack() {} async createOffer() { return { sdp: 'v=0' }; } async setLocalDescription() {}
    async setRemoteDescription() {
      this.ontrack?.({ streams: [remote], track: { stop() {} } });
      timing.step(); assert.deepEqual(voice.getLevelsSnapshot(), { input: 0, output: 0 }, 'audio is gated before context admission');
      await internal.providerEvent(JSON.stringify({ type: 'session.created', session: { instructions: 'Provider instructions' } }), internal.generation);
      await internal.providerEvent(JSON.stringify({ type: 'session.updated', session: { instructions: internal.contextInstructions, audio: { input: { transcription: { model: 'gpt-live-transcribe', delay: 'medium' }, turn_detection: { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true } } } } }), internal.generation);
    }
    close() { peerClosed = true; }
  });
  await voice.start({ id: 'conversation', revision: 1 } as Conversation, 'epoch', 0);
  assert.equal(voice.getSnapshot().phase, 'connected'); assert.equal(track.enabled, true);
  let durable = 0, fast = 0;
  const offView = voice.subscribe(() => { durable++; }), offLevels = voice.subscribeLevels(() => { fast++; });
  stream.amplitude = 0.04; timing.step(); assert.ok(voice.getLevelsSnapshot().input > 0); assert.equal(voice.getLevelsSnapshot().output, 0);
  stream.amplitude = 0.15; timing.step(); assert.equal(durable, 0); assert.ok(fast >= 2);
  voice.mute(); assert.equal(voice.getLevelsSnapshot().input, 0); assert.equal(track.enabled, false);
  await internal.providerEvent(JSON.stringify({ type: 'response.created', response: { id: 'response' } }), internal.generation);
  await internal.providerEvent(JSON.stringify({ type: 'output_audio_buffer.started', response_id: 'response' }), internal.generation);
  assert.equal(audio.muted, false); timing.step(); assert.ok(voice.getLevelsSnapshot().output > 0);
  if (playbackRecovery) {
    const replacement = { amplitude: 0.25 } as Signal;
    const replace = (signal = replacement) => internal.resources.peer.ontrack({ streams: [signal], track: { stop() {} } });
    const settled = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); timing.step(); };
    nextPlay = () => Promise.reject(new Error('Autoplay blocked')); replace(); await settled();
    assert.equal(voice.getSnapshot().soundBlocked, true); assert.equal(voice.getLevelsSnapshot().output, 0);
    nextPlay = undefined; replace(); await settled();
    assert.equal(voice.getSnapshot().soundBlocked, false); assert.equal(voice.getSnapshot().speaking, true); assert.ok(voice.getLevelsSnapshot().output > 0);
    let rejectOld!: (reason: Error) => void;
    nextPlay = () => new Promise<void>((_, reject) => { rejectOld = reject; }); replace();
    nextPlay = undefined; replace(); await settled();
    rejectOld(new Error('Stale autoplay rejection')); await settled();
    assert.equal(voice.getSnapshot().soundBlocked, false); assert.ok(voice.getLevelsSnapshot().output > 0);
    let resolveOld!: () => void;
    nextPlay = () => new Promise<void>(resolve => { resolveOld = resolve; }); replace();
    nextPlay = () => Promise.reject(new Error('Current autoplay blocked')); replace(); await settled();
    resolveOld(); await settled();
    assert.equal(voice.getSnapshot().soundBlocked, true); assert.equal(voice.getLevelsSnapshot().output, 0);
    nextPlay = undefined; await voice.enableSound(); timing.step();
    assert.equal(voice.getSnapshot().soundBlocked, false); assert.ok(voice.getLevelsSnapshot().output > 0);
  }
  voice.interrupt(); assert.equal(audio.muted, true); assert.equal(voice.getLevelsSnapshot().output, 0);
  await voice.end();
  assert.deepEqual(voice.getLevelsSnapshot(), { input: 0, output: 0 }); assert.equal(timing.frames.size, 0);
  assert.equal(track.stopped, true); assert.equal(context.closed, true); assert.equal(peerClosed, true);
  assert.ok(context.sources.every(source => source.disconnected)); assert.ok(context.analysers.every(analyser => analyser.disconnected));
  assert.equal(calls.filter(url => url.endsWith('/start')).length, 1);
  offView(); offLevels();
});
