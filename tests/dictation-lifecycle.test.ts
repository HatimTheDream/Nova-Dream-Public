import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { DictationAttempt } from '../packages/domain/dictation';
import { DictationDraft } from '../apps/client/src/dictation-draft';

const harnessKey = Symbol.for('nova.test.dictation-lifecycle');
// Run the real hook with a deterministic React/clock host. The transport itself
// has separate tests; this fixture controls only its asynchronous lifecycle.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/apps/client/src/useDictation')) {
      if (specifier === 'react') return { url: 'nova-test:dictation-react', shortCircuit: true };
      if (specifier === './browser-dictation') return { url: 'nova-test:dictation-browser', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:dictation-react') return { format: 'module', shortCircuit: true, source: `
      const host = () => globalThis[Symbol.for('nova.test.dictation-lifecycle')];
      export const useState = value => host().state(value);
      export const useRef = value => host().ref(value);
      export const useEffect = (effect, deps) => host().effect(effect, deps);
    ` };
    if (url === 'nova-test:dictation-browser') return { format: 'module', shortCircuit: true, source: `
      await globalThis[Symbol.for('nova.test.dictation-lifecycle')].browserLoad();
      export class BrowserDictation {
        constructor(epoch, attempt, update, failed) { Object.assign(this, { attempt, update, failed, closed: false }); this.host = globalThis[Symbol.for('nova.test.dictation-lifecycle')]; this.host.browsers.push(this); }
        start() { return this.host.browserStart(this); }
        finish() { return Promise.resolve(); }
        close() { this.closed = true; }
      }
    ` };
    return next(url, context);
  },
});
const { useDictation } = await import('../apps/client/src/useDictation');
after(() => hooks.deregister());

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function microphone() {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}
type BrowserFixture = { attempt: DictationAttempt; closed: boolean; update(text: string): void; failed(error: Error): void };
function host(options: { route?: 'browser'; acquire?: () => Promise<MediaStream>; closeAudio?: () => Promise<void>; browserLoad?: () => Promise<void>; browserStart?: (browser: BrowserFixture) => Promise<void>; update?: (text: string, attemptId: string) => boolean; save?: (key: string) => boolean; recovery?: { text: string; attemptId?: string }; respond?: (path: string, value: any, fallback: () => DictationAttempt) => unknown | Promise<unknown> } = {}) {
  let cursor = 0, dirty = true, now = 0, timerId = 0, output: ReturnType<typeof useDictation>, mounted = true, nextAttempt = 0;
  const cells: any[] = [], pending: (() => void)[] = [], storage = new Map<string, string>(), calls: { path: string; value: any }[] = [], inserted: string[] = [], updates: { text: string; attemptId: string }[] = [];
  if (options.recovery) storage.set('e3:dictation:epoch:draft', JSON.stringify(options.recovery));
  const timers = new Map<number, { at: number; run: () => void; repeat?: number }>();
  const attempts = new Map<string, DictationAttempt>(), requestAttempts = new Map<string, DictationAttempt>(), microphones: ReturnType<typeof microphone>[] = [], browsers: BrowserFixture[] = [], processors: { onaudioprocess?: (event: any) => void }[] = [];
  const interval = (run: () => void, delay: number, repeat?: number) => { const id = ++timerId; timers.set(id, { at: now + delay, run, repeat }); return id; };
  const fixture = {
    browsers, browserStart: options.browserStart ?? (() => Promise.resolve()), browserLoad: options.browserLoad ?? (() => Promise.resolve()),
    state(value: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
    ref(value: any) { const i = cursor++; return cells[i] ??= { current: value }; },
    effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, before = cells[i]; if (!before || deps.some((value, index) => !Object.is(value, before.deps[index]))) { cells[i] = { deps, cleanup: before?.cleanup }; pending.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
  };
  const values: Record<PropertyKey, unknown> = {
    [harnessKey]: fixture,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { if (options.save?.(key) === false) throw Error('Storage full'); storage.set(key, value); }, removeItem: (key: string) => storage.delete(key) },
    navigator: { mediaDevices: { getUserMedia: () => { if (options.acquire) return options.acquire(); const m = microphone(); microphones.push(m); return Promise.resolve(m.stream); } } },
    AudioContext: class {
      sampleRate: number; destination = {};
      constructor(input: { sampleRate: number }) { this.sampleRate = input.sampleRate; }
      resume() { return Promise.resolve(); } close() { return options.closeAudio?.() ?? Promise.resolve(); }
      createMediaStreamSource() { return { connect() {} }; }
      createScriptProcessor() { const node = { connect() {}, disconnect() {}, onaudioprocess: undefined }; processors.push(node); return node; }
    },
    setTimeout: (run: () => void, delay: number) => interval(run, delay), clearTimeout: (id: number) => timers.delete(id),
    setInterval: (run: () => void, delay: number) => interval(run, delay, delay), clearInterval: (id: number) => timers.delete(id),
    fetch: async (url: string, init: RequestInit) => {
      const path = url.replace('/api/', ''), value = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, value });
      const fallback = () => {
        if (path.endsWith('/start')) {
          const prior = requestAttempts.get(value.requestId); if (prior) return attempts.get(prior.id)!;
          const a: DictationAttempt = { id: `attempt-${++nextAttempt}`, requestId: value.requestId, epoch: value.epoch, draftId: value.draftId, deviceId: 'device', generation: 'generation', state: 'listening', text: '', final: false, sequence: -1, updatedAt: now, ...(options.route ? { route: options.route } : { encoding: 'pcm16', sampleRate: 24000 }) };
          attempts.set(a.id, a); requestAttempts.set(value.requestId, a); return a;
        }
        const id = value?.attemptId ?? path.split('/').at(-1), a = attempts.get(id)!;
        if (!a) throw Error(`Unexpected fixture attempt: ${id}`);
        if (path.endsWith('/end')) { const ended = { ...a, state: 'ended' as const }; attempts.set(id, ended); return ended; }
        return a;
      };
      const result = options.respond ? await options.respond(path, value, fallback) : fallback();
      return new Response(JSON.stringify(result), { status: 200 });
    },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const flush = async () => {
    for (let pass = 0; pass < 20; pass++) {
      if (mounted && dirty) { dirty = false; cursor = 0; output = useDictation('epoch', 'draft', (text, attemptId) => { updates.push({ text, attemptId }); const retained = options.update?.(text, attemptId) ?? true; if (retained) inserted.push(text); return retained; }); while (pending.length) pending.shift()!(); }
      for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    }
  };
  const unmount = () => { if (!mounted) return; mounted = false; for (const cell of cells) cell?.cleanup?.(); };
  return {
    storage, calls, inserted, updates, microphones, browsers, attempts, flush, unmount, get current() { return output; }, get timerCount() { return timers.size; },
    audio(index = processors.length - 1) { processors[index].onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(128) } }); },
    async advance(ms: number) { const until = now + ms; for (;;) { const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; if (next[1].repeat) next[1].at += next[1].repeat; else timers.delete(next[0]); next[1].run(); await flush(); } now = until; await flush(); },
    async close() { unmount(); await flush(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

test('microphone cancellation stops a late permission grant without starting or affecting the retry', async () => {
  const late = deferred<MediaStream>(), old = microphone(), fresh = microphone(); let acquisitions = 0;
  const f = host({ acquire: () => ++acquisitions === 1 ? late.promise : Promise.resolve(fresh.stream) });
  try {
    await f.flush(); const first = f.current.start(); await f.flush(); assert.equal(f.current.phase, 'connecting');
    await f.current.cancel(); await first; await f.flush(); assert.equal(f.current.phase, 'idle'); assert.equal(f.current.error, ''); assert.equal(f.calls.length, 0);
    await f.current.start(); await f.flush(); assert.equal(f.current.phase, 'listening');
    late.resolve(old.stream); await f.flush(); assert.equal(old.track.stopped, true); assert.equal(fresh.track.stopped, false);
    assert.equal(f.calls.filter(call => call.path.endsWith('/start')).length, 1); assert.deepEqual(f.inserted, []);
  } finally { await f.close(); }
});

test('unanswered microphone permission times out and stops a later stream without dispatching', async () => {
  const late = deferred<MediaStream>(), mic = microphone(), f = host({ acquire: () => late.promise });
  try {
    await f.flush(); const started = f.current.start(); await f.flush(); await f.advance(20000); await started;
    assert.equal(f.current.phase, 'idle'); assert.match(f.current.error, /Microphone access timed out/); assert.equal(f.calls.length, 0);
    late.resolve(mic.stream); await f.flush(); assert.equal(mic.track.stopped, true); assert.equal(f.timerCount, 0);
  } finally { await f.close(); }
});

test('cancel waits for an outstanding start receipt then closes that exact attempt before retry', async () => {
  const response = deferred<DictationAttempt>(); let held: DictationAttempt | undefined;
  const f = host({ respond: (path, _value, fallback) => { if (path.endsWith('/start') && !held) { held = fallback(); return response.promise; } return fallback(); } });
  try {
    await f.flush(); const started = f.current.start(); await f.flush();
    const cancelled = f.current.cancel(); await f.flush(); assert.equal(f.current.phase, 'finishing'); assert.equal(f.microphones[0].track.stopped, true);
    await f.current.start(); assert.equal(f.calls.filter(call => call.path.endsWith('/start')).length, 1, 'Retry cannot race cancellation of the original receipt');
    response.resolve(held!); await Promise.all([started, cancelled]); await f.flush();
    assert.equal(f.current.phase, 'idle'); assert.equal(f.storage.has('e3:dictation:epoch:draft:start'), false);
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/end')).map(call => call.value.attemptId), [held!.id]);
    await f.current.start(); await f.flush(); assert.equal(f.current.phase, 'listening');
    const starts = f.calls.filter(call => call.path.endsWith('/start')); assert.notEqual(starts[0].value.requestId, starts[1].value.requestId);
  } finally { await f.close(); }
});

test('cancel retains pending receipt words even when the end reply is lost', async () => {
  const response = deferred<DictationAttempt>(); let held: DictationAttempt | undefined;
  const f = host({ respond: (path, _value, fallback) => {
    if (path.endsWith('/start')) { held = { ...fallback(), text: 'Available receipt words' }; return response.promise; }
    throw Error('End reply lost');
  } });
  try {
    await f.flush(); const started = f.current.start(); await f.flush(); const cancelled = f.current.cancel(); await f.flush();
    response.resolve(held!); await Promise.all([started, cancelled]); await f.flush();
    assert.equal(f.current.phase, 'idle'); assert.match(f.current.error, /End reply lost/);
    assert.deepEqual(f.inserted, ['Available receipt words']); assert.equal(f.current.preview, '');
    assert.equal(f.storage.has('e3:dictation:epoch:draft:start'), true);
  } finally { await f.close(); }
});

test('confirmed failed starts retire their receipt even when cleanup acknowledgement is lost', async () => {
  let first = true;
  const f = host({ respond: (path, _value, fallback) => {
    if (path.endsWith('/start') && first) { first = false; return { ...fallback(), state: 'failed', error: 'Provider unavailable' }; }
    if (path.endsWith('/end')) throw Error('Lost cleanup reply');
    return fallback();
  } });
  try {
    await f.flush(); await f.current.start(); await f.flush(); assert.equal(f.current.phase, 'idle'); assert.match(f.current.error, /Provider unavailable/);
    assert.equal(f.storage.has('e3:dictation:epoch:draft:start'), false);
    await f.current.start(); await f.flush(); assert.equal(f.current.phase, 'listening');
    const starts = f.calls.filter(call => call.path.endsWith('/start')); assert.notEqual(starts[0].value.requestId, starts[1].value.requestId);
  } finally { await f.close(); }
});

test('an unknown start outcome reuses the original receipt instead of creating duplicate work', async () => {
  let first = true;
  const f = host({ respond: (path, _value, fallback) => { const a = fallback(); if (path.endsWith('/start') && first) { first = false; throw Error('Lost start reply'); } return a; } });
  try {
    await f.flush(); await f.current.start(); await f.flush(); assert.equal(f.current.phase, 'idle'); assert.equal(f.storage.has('e3:dictation:epoch:draft:start'), true);
    await f.current.start(); await f.flush(); assert.equal(f.current.phase, 'listening');
    const starts = f.calls.filter(call => call.path.endsWith('/start')); assert.equal(starts[0].value.requestId, starts[1].value.requestId); assert.equal(f.attempts.size, 1);
  } finally { await f.close(); }
});

test('a stale relay poll failure cannot stop a newer recording', async () => {
  const stale = deferred<DictationAttempt>(); let held = false;
  const f = host({ respond: (path, _value, fallback) => { if (path.endsWith('/attempt-1') && !held) { held = true; return stale.promise; } return fallback(); } });
  try {
    await f.flush(); await f.current.start(); await f.flush(); await f.advance(650);
    await f.current.stop(); await f.flush(); await f.current.start(); await f.flush();
    assert.equal(f.current.phase, 'listening'); stale.reject(Error('Old poll disconnected')); await f.flush();
    assert.equal(f.current.phase, 'listening'); assert.equal(f.current.error, ''); assert.equal(f.microphones[1].track.stopped, false);
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/end')).map(call => call.value.attemptId), ['attempt-1']);
  } finally { await f.close(); }
});

test('on-demand browser transport loading keeps its lease alive and cannot revive after cancellation', async () => {
  const loaded = deferred<void>(), f = host({ route: 'browser', browserLoad: () => loaded.promise });
  try {
    await f.flush(); const started = f.current.start(); await f.flush(); assert.equal(f.current.phase, 'connecting');
    await f.advance(4000); assert.equal(f.calls.filter(call => call.path.endsWith('/attempt-1')).length, 2);
    assert.equal(f.browsers.length, 0); await f.current.cancel(); await f.flush(); assert.equal(f.current.phase, 'idle');
    loaded.resolve(); await started; await f.flush();
    assert.equal(f.browsers.length, 0); assert.equal(f.microphones[0].track.stopped, true); assert.equal(f.timerCount, 0);
  } finally { loaded.resolve(); await f.close(); }
});

test('browser setup keeps its attempt alive while SDP is pending and cancels without reviving later', async () => {
  const connection = deferred<void>(); const f = host({ route: 'browser', browserStart: () => connection.promise });
  try {
    await f.flush(); const started = f.current.start(); await f.flush(); assert.equal(f.current.phase, 'connecting');
    await f.advance(16000); assert.equal(f.calls.filter(call => call.path.endsWith('/attempt-1')).length, 8, 'Heartbeat runs during setup, before the listening UI appears');
    await f.current.cancel(); await f.flush(); assert.equal(f.current.phase, 'idle'); assert.equal(f.browsers[0].closed, true); assert.equal(f.timerCount, 0);
    connection.resolve(); await started; await f.flush(); assert.equal(f.current.phase, 'idle'); assert.deepEqual(f.inserted, []);
    f.browsers[0].failed(Error('Late handshake failure')); await f.flush(); assert.equal(f.current.error, '');
  } finally { await f.close(); }
});

test('repeated start before a render acquires only one microphone and unmount stops pending permission', async () => {
  const late = deferred<MediaStream>(), mic = microphone(); let acquisitions = 0;
  const f = host({ acquire: () => { acquisitions++; return late.promise; } });
  try {
    await f.flush(); const start = f.current.start, first = start(); await start(); assert.equal(acquisitions, 1);
    f.unmount(); await first; late.resolve(mic.stream); await f.flush(); assert.equal(mic.track.stopped, true); assert.equal(f.calls.length, 0); assert.equal(f.timerCount, 0);
  } finally { await f.close(); }
});

test('microphone failures explain how to recover and never start a provider attempt', async () => {
  for (const [name, message] of [['NotAllowedError', /Allow microphone access/], ['NotFoundError', /No microphone was found/], ['NotReadableError', /another app is using it/]] as const) {
    const f = host({ acquire: () => Promise.reject(Object.assign(Error('Opaque browser error'), { name })) });
    try { await f.flush(); await f.current.start(); await f.flush(); assert.equal(f.current.phase, 'idle'); assert.match(f.current.error, message); assert.equal(f.calls.length, 0); assert.equal(f.timerCount, 0); }
    finally { await f.close(); }
  }
});

test('normal Stop flushes queued relay frames before ending and inserts the final text once', async () => {
  const first = deferred<DictationAttempt>(); let held: DictationAttempt | undefined;
  const f = host({ respond: (path, value, fallback) => {
    if (path.endsWith('/audio') && value.sequence === 0) { held = fallback(); return first.promise; }
    if (path.endsWith('/end')) return { ...fallback(), text: 'A complete sentence.', final: true };
    return fallback();
  } });
  try {
    await f.flush(); await f.current.start(); await f.flush(); f.audio(); f.audio(); f.audio(); await f.flush();
    const stopped = f.current.stop(); await f.flush(); assert.equal(f.current.phase, 'finishing'); assert.equal(f.microphones[0].track.stopped, true);
    assert.equal(f.calls.filter(call => call.path.endsWith('/end')).length, 0);
    first.resolve(held!); await stopped; await f.flush();
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/audio')).map(call => call.value.sequence), [0, 1, 2]);
    assert.deepEqual(f.inserted, ['A complete sentence.']); assert.equal(f.current.preview, ''); assert.equal(f.current.error, '');
  } finally { await f.close(); }
});

test('failed relay queues cannot resume after a newer recording starts', async () => {
  const first = deferred<DictationAttempt>();
  const f = host({ respond: (path, value, fallback) => {
    if (path.endsWith('/audio') && value.attemptId === 'attempt-1') return first.promise;
    if (path.endsWith('/attempt-1')) throw Error('Connection interrupted');
    return fallback();
  } });
  try {
    await f.flush(); await f.current.start(); await f.flush(); f.audio(); f.audio(); f.audio(); await f.flush(); await f.advance(650);
    assert.equal(f.current.phase, 'idle'); await f.current.start(); await f.flush();
    first.reject(Error('Late old audio response')); await f.flush(); f.audio(); await f.flush();
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/audio')).map(call => [call.value.attemptId, call.value.sequence]), [['attempt-1', 0], ['attempt-2', 0]]);
    assert.equal(f.current.phase, 'listening'); assert.equal(f.current.error, ''); assert.equal(f.microphones[1].track.stopped, false);
  } finally { await f.close(); }
});

test('an audio failure during Stop closes the original attempt and retains available words in the draft', async () => {
  const frame = deferred<DictationAttempt>();
  const f = host({ respond: (path, _value, fallback) => path.endsWith('/audio') ? frame.promise : path.endsWith('/end') ? { ...fallback(), text: 'Available words', final: false } : fallback() });
  try {
    await f.flush(); await f.current.start(); await f.flush(); f.audio(); await f.flush(); const stopped = f.current.stop(); await f.flush();
    frame.reject(Error('Audio delivery lost')); await stopped; await f.flush();
    assert.equal(f.current.phase, 'idle'); assert.match(f.current.error, /interrupted/); assert.equal(f.current.preview, ''); assert.deepEqual(f.inserted, ['Available words']);
    assert.equal(f.calls.filter(call => call.path.endsWith('/end')).length, 1); f.current.useText(); assert.deepEqual(f.inserted, ['Available words']);
  } finally { await f.close(); }
});

test('an ended attempt retains unconfirmed words in the draft and explains the interruption', async () => {
  const f = host({ respond: (path, _value, fallback) => path.endsWith('/end') ? { ...fallback(), text: 'Unconfirmed phrase', final: false, error: 'The last spoken phrase was not confirmed. Available words are kept.' } : fallback() });
  try {
    await f.flush(); await f.current.start(); await f.flush(); await f.current.stop(); await f.flush();
    assert.equal(f.current.phase, 'idle'); assert.match(f.current.error, /not confirmed/); assert.equal(f.current.preview, ''); assert.deepEqual(f.inserted, ['Unconfirmed phrase']);
    f.current.useText(); assert.deepEqual(f.inserted, ['Unconfirmed phrase']);
  } finally { await f.close(); }
});

test('an empty successful recording gives no-speech feedback and cleanup rejection is handled', async () => {
  const f = host({ closeAudio: () => Promise.reject(Error('AudioContext already closed')) });
  try {
    await f.flush(); await f.current.start(); await f.flush(); await f.current.stop(); await f.flush();
    assert.equal(f.current.phase, 'idle'); assert.match(f.current.error, /No speech was detected/); assert.deepEqual(f.inserted, []); assert.equal(f.timerCount, 0);
  } finally { await f.close(); }
});

test('browser interim snapshots reach the draft immediately, journal first, without a separate preview or Stop insertion', async () => {
  const f = host({ route: 'browser', update: (text, attemptId) => {
    assert.deepEqual(JSON.parse(f.storage.get('e3:dictation:epoch:draft')!), { text, attemptId }); return true;
  } });
  try {
    await f.flush(); await f.current.start(); await f.flush();
    f.browsers[0].update('Hello'); assert.deepEqual(f.inserted, ['Hello']);
    f.browsers[0].update('Hello world'); f.browsers[0].update('Hello world'); f.browsers[0].update('Hello, world.'); await f.flush();
    assert.deepEqual(f.inserted, ['Hello', 'Hello world', 'Hello, world.']);
    assert.equal(f.current.phase, 'listening'); assert.equal(f.current.preview, ''); assert.equal(f.storage.has('e3:dictation:epoch:draft'), false);
    await f.current.stop(); await f.flush();
    assert.deepEqual(f.inserted, ['Hello', 'Hello world', 'Hello, world.']); assert.equal(f.current.phase, 'idle');
    await f.current.start(); await f.flush(); f.browsers[1].update('Another sentence');
    f.browsers[0].update('Old late completion'); await f.flush();
    assert.equal(f.updates.at(-1)?.attemptId, 'attempt-2'); assert.equal(f.inserted.at(-1), 'Another sentence');
    assert.equal(f.current.phase, 'listening'); assert.equal(f.current.preview, '');
  } finally { await f.close(); }
});

test('relay audio and polling project partial text before Stop and accepted drain updates are not dropped', async () => {
  const held = deferred<DictationAttempt>(); let last: DictationAttempt | undefined;
  const f = host({ respond: (path, value, fallback) => {
    const a = fallback();
    if (path.endsWith('/audio')) {
      last = { ...a, text: value.sequence ? 'Partial sentence completed' : 'Partial sentence', sequence: value.sequence };
      return value.sequence ? held.promise : last;
    }
    if (path.endsWith('/attempt-1')) return { ...a, text: 'Partial sentence continued' };
    if (path.endsWith('/end')) return { ...a, text: 'Partial sentence completed', final: true };
    return a;
  } });
  try {
    await f.flush(); await f.current.start(); await f.flush(); f.audio(); await f.flush();
    assert.deepEqual(f.inserted, ['Partial sentence']); assert.equal(f.current.phase, 'listening');
    await f.advance(650); assert.equal(f.inserted.at(-1), 'Partial sentence continued');
    f.audio(); await f.flush(); const stopped = f.current.stop(); await f.flush(); held.resolve(last!); await stopped; await f.flush();
    assert.deepEqual(f.inserted, ['Partial sentence', 'Partial sentence continued', 'Partial sentence completed']); assert.equal(f.current.preview, '');
  } finally { await f.close(); }
});

test('browser failure and cancellation preserve projected interim words and allow another recording', async () => {
  const f = host({ route: 'browser' });
  try {
    await f.flush(); await f.current.start(); await f.flush(); f.browsers[0].update('Words before interruption');
    f.browsers[0].failed(Error('Connection interrupted')); await f.flush();
    assert.equal(f.current.phase, 'idle'); assert.match(f.current.error, /interrupted/); assert.equal(f.current.preview, '');
    assert.deepEqual(f.inserted, ['Words before interruption']); assert.equal(f.browsers[0].closed, true);
    await f.current.start(); await f.flush(); f.browsers[1].update('Words before editing'); await f.current.cancel(); await f.flush();
    assert.deepEqual(f.inserted, ['Words before interruption', 'Words before editing']); assert.equal(f.current.phase, 'idle');
    await f.current.start(); await f.flush(); assert.equal(f.current.phase, 'listening'); assert.equal(f.browsers.length, 3);
  } finally { await f.close(); }
});

test('failed draft retention leaves full recovery text and the original token until Use transcript succeeds', async () => {
  let retained = false;
  const f = host({ route: 'browser', update: () => retained });
  try {
    await f.flush(); await f.current.start(); await f.flush(); f.browsers[0].update('Recover these words'); await f.current.stop(); await f.flush();
    assert.equal(f.current.preview, 'Recover these words'); assert.equal(f.current.canInsertRecovery, true); assert.deepEqual(f.inserted, []);
    assert.deepEqual(JSON.parse(f.storage.get('e3:dictation:epoch:draft')!), { text: 'Recover these words', attemptId: 'attempt-1' });
    await f.current.start(); assert.equal(f.microphones.length, 1, 'Unretained words prevent another recording');
    f.current.useText(); await f.flush(); assert.equal(f.current.preview, 'Recover these words');
    retained = true; f.current.useText(); await f.flush();
    assert.deepEqual(f.inserted, ['Recover these words']); assert.equal(f.updates.at(-1)?.attemptId, 'attempt-1');
    assert.equal(f.storage.has('e3:dictation:epoch:draft'), false); assert.equal(f.current.preview, '');
    f.current.useText(); assert.deepEqual(f.inserted, ['Recover these words']);
    await f.current.start(); await f.flush(); assert.equal(f.current.phase, 'listening');
  } finally { await f.close(); }
});

test('remounted recovery is copy-only so previously saved words cannot be inserted twice', async () => {
  for (const attemptId of ['saved-attempt', undefined]) {
    const f = host({ recovery: { text: 'Saved speech', attemptId } });
    try {
      await f.flush(); assert.equal(f.current.preview, 'Saved speech'); assert.equal(f.current.canInsertRecovery, false);
      f.current.useText(); await f.flush(); assert.deepEqual(f.updates, []); assert.equal(f.current.preview, 'Saved speech');
      assert.deepEqual(JSON.parse(f.storage.get('e3:dictation:epoch:draft')!), { text: 'Saved speech', ...(attemptId ? { attemptId } : {}) });
      await f.current.start(); assert.equal(f.microphones.length, 0);
      f.current.discard(); await f.flush(); assert.equal(f.current.preview, ''); assert.equal(f.current.canInsertRecovery, true);
      await f.current.start(); await f.flush(); assert.equal(f.current.phase, 'listening');
    } finally { await f.close(); }
  }
});

test('storage failures never discard unretained words and a saved composer can own text without the fallback journal', async () => {
  let retained = false;
  const f = host({ route: 'browser', save: key => key.endsWith(':start'), update: () => retained });
  try {
    await f.flush(); await f.current.start(); await f.flush(); f.browsers[0].update('Keep these words'); await f.current.stop(); await f.flush();
    assert.equal(f.current.preview, 'Keep these words'); assert.match(f.current.error, /could not be saved/); assert.deepEqual(f.inserted, []);
    retained = true; f.current.useText(); await f.flush(); assert.equal(f.current.preview, ''); assert.deepEqual(f.inserted, ['Keep these words']);
    await f.current.start(); await f.flush(); f.browsers[1].update('Saved in composer'); await f.current.stop(); await f.flush();
    assert.equal(f.current.preview, ''); assert.equal(f.current.error, ''); assert.equal(f.inserted.at(-1), 'Saved in composer');
  } finally { await f.close(); }
});

test('a projection exception stops once and preserves copy-only recovery without an end/retry loop', async () => {
  let full = true;
  const f = host({ route: 'browser', update: () => { if (full) throw Error('This draft is full. Shorten it before adding more dictated words.'); return true; } });
  try {
    await f.flush(); await f.current.start(); await f.flush(); f.browsers[0].update('Words exceeding the draft limit'); await f.flush();
    assert.equal(f.current.phase, 'idle'); assert.equal(f.browsers[0].closed, true); assert.match(f.current.error, /draft is full/);
    assert.equal(f.current.preview, 'Words exceeding the draft limit'); assert.equal(f.updates.length, 1);
    assert.equal(f.calls.filter(call => call.path.endsWith('/end')).length, 1);
    full = false; f.current.useText(); await f.flush(); assert.deepEqual(f.inserted, []); assert.equal(f.current.canInsertRecovery, false);
    assert.equal(f.current.preview, 'Words exceeding the draft limit'); assert.equal(f.updates.length, 1);
    f.current.discard(); await f.flush(); await f.current.start(); await f.flush(); f.browsers[1].update('A fresh recording'); await f.flush();
    assert.equal(f.current.canInsertRecovery, true); assert.deepEqual(f.inserted, ['A fresh recording']);
  } finally { await f.close(); }
});

test('external edits that detach projection cannot silently consume uninserted recovery words', async () => {
  const projection = new DictationDraft(); let draft = 'Notes:'; projection.begin(draft);
  const f = host({ route: 'browser', update: (text, id) => { draft = projection.update(draft, text, id); return true; } });
  try {
    await f.flush(); await f.current.start(); await f.flush(); f.browsers[0].update('first words');
    assert.equal(draft, 'Notes: first words'); draft = 'An externally replaced draft';
    f.browsers[0].update('first words continued'); await f.flush();
    assert.equal(f.current.phase, 'idle'); assert.equal(f.current.canInsertRecovery, false); assert.match(f.current.error, /draft changed/);
    assert.equal(f.current.preview, 'first words continued');
    f.current.useText(); await f.flush();
    assert.equal(draft, 'An externally replaced draft'); assert.equal(f.updates.length, 2);
    assert.deepEqual(JSON.parse(f.storage.get('e3:dictation:epoch:draft')!), { text: 'first words continued', attemptId: 'attempt-1' });
    assert.equal(f.current.preview, 'first words continued');
  } finally { await f.close(); }
});

test('late end text after unmount is retained in the original journal and never invokes the draft callback', async () => {
  const late = deferred<DictationAttempt>(); let ended: DictationAttempt | undefined;
  const f = host({ respond: (path, _value, fallback) => { if (path.endsWith('/end')) { ended = { ...fallback(), text: 'Late final words', final: true }; return late.promise; } return fallback(); } });
  try {
    await f.flush(); await f.current.start(); await f.flush(); f.unmount(); await f.flush();
    late.resolve(ended!); await f.flush(); assert.deepEqual(f.updates, []);
    assert.deepEqual(JSON.parse(f.storage.get('e3:dictation:epoch:draft')!), { text: 'Late final words', attemptId: 'attempt-1' });
  } finally { await f.close(); }
});

test('unmount during a pending start retains its eventual final words without calling a replacement editor', async () => {
  const late = deferred<DictationAttempt>(); let started: DictationAttempt | undefined;
  const f = host({ respond: (path, _value, fallback) => {
    if (path.endsWith('/start')) { started = fallback(); return late.promise; }
    return { ...fallback(), text: 'Recovered final words', final: true };
  } });
  try {
    await f.flush(); const start = f.current.start(); await f.flush(); f.unmount();
    late.resolve(started!); await start; await f.flush(); assert.deepEqual(f.updates, []);
    assert.deepEqual(JSON.parse(f.storage.get('e3:dictation:epoch:draft')!), { text: 'Recovered final words', attemptId: 'attempt-1' });
    assert.equal(f.calls.filter(call => call.path.endsWith('/end')).length, 1);
    assert.equal(f.storage.has('e3:dictation:epoch:draft:start'), false);
  } finally { await f.close(); }
});

test('unmount retains words returned by a pending start even when ending cannot be confirmed', async () => {
  const late = deferred<DictationAttempt>(); let started: DictationAttempt | undefined;
  const f = host({ respond: (path, _value, fallback) => {
    if (path.endsWith('/start')) { started = { ...fallback(), text: 'Receipt words' }; return late.promise; }
    throw Error('End reply lost');
  } });
  try {
    await f.flush(); const start = f.current.start(); await f.flush(); f.unmount();
    late.resolve(started!); await start; await f.flush(); assert.deepEqual(f.updates, []);
    assert.deepEqual(JSON.parse(f.storage.get('e3:dictation:epoch:draft')!), { text: 'Receipt words', attemptId: 'attempt-1' });
    assert.equal(f.storage.has('e3:dictation:epoch:draft:start'), true, 'An unconfirmed attempt keeps its receipt');
  } finally { await f.close(); }
});

test('a stale old audio completion cannot write into a new recording', async () => {
  const late = deferred<DictationAttempt>(); let old: DictationAttempt | undefined;
  const f = host({ respond: (path, value, fallback) => {
    if (path.endsWith('/audio') && value.attemptId === 'attempt-1') { old = { ...fallback(), text: 'Old late words' }; return late.promise; }
    if (path.endsWith('/attempt-1')) throw Error('Disconnected');
    return fallback();
  } });
  try {
    await f.flush(); await f.current.start(); await f.flush(); f.audio(); await f.flush(); await f.advance(650);
    await f.current.start(); await f.flush(); late.resolve(old!); await f.flush();
    assert.equal(f.current.phase, 'listening'); assert.deepEqual(f.updates, []); assert.equal(f.current.error, '');
    assert.equal(f.storage.has('e3:dictation:epoch:draft'), false);
  } finally { await f.close(); }
});
