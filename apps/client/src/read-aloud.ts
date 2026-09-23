import { request } from './api';
import type { SpeechAudio, SpeechCatalog } from '../../../packages/domain/read-aloud';
import { speechChunks, speechText, selectSpeechVoice } from './speech-text';
export { speechChunks } from './speech-text';

export type ReadingState = { phase: 'idle' | 'preparing' | 'speaking' | 'paused' | 'error'; messageId?: string; error?: string; route?: 'provider' | 'device'; canUseDevice?: boolean };
type DeviceSpeech = Pick<SpeechSynthesis, 'speak' | 'cancel' | 'pause' | 'resume'> & Partial<Pick<SpeechSynthesis, 'getVoices'>>;
export type SpeechPlatform = { speech: DeviceSpeech; utterance: (text: string) => SpeechSynthesisUtterance; language?: string; ready?: () => Promise<void> };
export type ReadingAudio = { play(): Promise<void>; pause(): void; dispose(): void; onplaying?: () => void; onpause?: () => void; onended?: () => void; onerror?: () => void };
export type ReadingProvider = { catalog(signal: AbortSignal): Promise<SpeechCatalog>; speak(input: { requestId: string; epoch: string; text: string; language?: string }, signal: AbortSignal): Promise<SpeechAudio> };
type Options = { device?: () => SpeechPlatform | undefined; provider?: ReadingProvider; audio?: (value: SpeechAudio) => ReadingAudio; language?: () => string };

function devicePlatform(): SpeechPlatform | undefined {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const speech = window.speechSynthesis;
  return { speech, utterance: text => new SpeechSynthesisUtterance(text), ready: () => new Promise(resolve => {
    if (speech.getVoices().length) { resolve(); return; }
    const done = () => { clearTimeout(timer); speech.removeEventListener('voiceschanged', done); resolve(); };
    const timer = setTimeout(done, 500); speech.addEventListener('voiceschanged', done, { once: true });
  }) };
}
function browserAudio(value: SpeechAudio): ReadingAudio {
  const bytes = Uint8Array.from(atob(value.audioBase64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: value.mimeType }));
  const audio = new Audio(url);
  const output: ReadingAudio = {
    play: () => audio.play(), pause: () => audio.pause(),
    dispose: () => { audio.onplaying = audio.onpause = audio.onended = audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); },
  };
  audio.onplaying = () => output.onplaying?.(); audio.onpause = () => { if (!audio.ended) output.onpause?.(); };
  audio.onended = () => output.onended?.(); audio.onerror = () => output.onerror?.();
  return output;
}
const serverProvider: ReadingProvider = {
  catalog: signal => request('assistant/read-aloud/catalog', undefined, signal),
  speak: (input, signal) => request('assistant/read-aloud/speak', input, signal, 50000),
};

/** One owner for preparation, audio and device speech. Late results cannot restart a stopped reader. */
export class ReadAloud {
  private state: ReadingState = { phase: 'idle' };
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort?: AbortController;
  private audio?: ReadingAudio;
  private speech?: DeviceSpeech;
  private utterance?: SpeechSynthesisUtterance;
  private continueDevice?: () => void;
  private source?: { id: string; text: string };
  private pauseRequested = false;
  private chunks: string[] = [];
  private language: string;
  private options: Options;
  constructor(options: Options = {}) {
    this.options = options;
    this.language = options.language?.() ?? (typeof document !== 'undefined' && document.documentElement.lang || typeof navigator !== 'undefined' && navigator.language || 'en-US');
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private publish(state: ReadingState) { this.state = state; for (const fn of this.listeners) fn(); }
  private live(generation: number) { return generation === this.generation && !this.abort?.signal.aborted; }
  private cleanup() {
    this.generation++; this.abort?.abort(); this.abort = undefined;
    this.audio?.dispose(); this.audio = undefined;
    this.speech?.cancel(); this.speech = undefined; this.utterance = undefined; this.continueDevice = undefined; this.pauseRequested = false;
  }
  stop = () => { this.cleanup(); this.source = undefined; this.chunks = []; this.publish({ phase: 'idle' }); };
  private begin(messageId: string, text: string, route: 'provider' | 'device') {
    this.cleanup(); this.source = { id: messageId, text };
    this.chunks = speechChunks(speechText(text), 1600, this.language);
    if (!this.chunks.length) { this.stop(); return; }
    this.abort = new AbortController();
    this.publish({ phase: 'preparing', messageId, route }); return this.generation;
  }
  private fail(generation: number, error: string, fallback: boolean) {
    if (!this.live(generation)) return;
    const source = this.source, route = this.state.route; this.cleanup(); this.source = source;
    this.publish({ phase: 'error', messageId: source?.id, route, error, canUseDevice: fallback && !!(this.options.device ?? devicePlatform)() });
  }
  start = (messageId: string, text: string) => { void this.startProvider(messageId, text); };
  private async startProvider(messageId: string, text: string) {
    const generation = this.begin(messageId, text, 'provider'); if (generation === undefined) return;
    const signal = this.abort!.signal, provider = this.options.provider ?? serverProvider;
    try {
      const catalog = await provider.catalog(signal);
      if (!this.live(generation)) return;
      if (catalog.state !== 'available') { this.fail(generation, catalog.message, true); return; }
      const chunks = [...this.chunks];
      const synthesize = (index: number) => provider.speak({ requestId: crypto.randomUUID(), epoch: catalog.epoch, text: chunks[index], language: this.language }, signal);
      let prepared: Promise<SpeechAudio> | undefined;
      const next = async (index: number): Promise<void> => {
        if (!this.live(generation)) return;
        if (index >= chunks.length) { this.stop(); return; }
        this.publish({ ...this.state, phase: 'preparing' });
        try {
          const value = await (prepared ?? synthesize(index)); prepared = undefined;
          if (!this.live(generation)) return;
          const audio = (this.options.audio ?? browserAudio)(value); this.audio?.dispose(); this.audio = audio;
          const current = () => this.live(generation) && this.audio === audio;
          audio.onplaying = () => { if (current()) this.publish({ ...this.state, phase: 'speaking', error: undefined }); };
          audio.onpause = () => { if (current()) { this.pauseRequested = true; this.publish({ ...this.state, phase: 'paused' }); } };
          audio.onerror = () => { if (current()) this.fail(generation, 'Reading audio could not play. You can restart using your device voice.', true); };
          audio.onended = () => { if (!current()) return; audio.dispose(); this.audio = undefined; void next(index + 1); };
          // Only one look-ahead chunk: reduce gaps without synthesizing an entire unused answer.
          if (index + 1 < chunks.length) { prepared = synthesize(index + 1); void prepared.catch(() => undefined); }
          if (this.pauseRequested) { this.publish({ ...this.state, phase: 'paused' }); return; }
          await this.play(generation, audio);
        } catch { this.fail(generation, 'The reading audio was not returned. You can restart using your device voice.', true); }
      };
      await next(0);
    } catch { this.fail(generation, 'Reading voice availability could not be confirmed. You can use your device voice.', true); }
  }
  private async play(generation: number, audio: ReadingAudio) {
    try { await audio.play(); }
    catch (reason) {
      if (!this.live(generation) || this.audio !== audio) return;
      if (reason instanceof Error && reason.name === 'NotAllowedError') {
        this.pauseRequested = true; this.publish({ ...this.state, phase: 'paused', error: 'Audio is ready. Choose Resume to allow playback.' });
      } else this.fail(generation, 'Reading audio could not start. You can restart using your device voice.', true);
    }
  }
  /** Explicit fallback; restarting is disclosed by the player, never substituted silently. */
  useDeviceVoice = () => { if (this.source) void this.startDevice(this.source.id, this.source.text); };
  private async startDevice(messageId: string, text: string) {
    const generation = this.begin(messageId, text, 'device'); if (generation === undefined) return;
    const platform = (this.options.device ?? devicePlatform)();
    if (!platform) { this.fail(generation, 'Device speech is unavailable in this browser.', false); return; }
    this.speech = platform.speech;
    try { await platform.ready?.(); }
    catch { this.fail(generation, 'Device speech could not prepare its voice.', false); return; }
    if (!this.live(generation)) return;
    const language = platform.language ?? this.language;
    const voice = selectSpeechVoice(platform.speech.getVoices?.() ?? [], language), chunks = [...this.chunks];
    const next = () => {
      if (!this.live(generation)) return;
      if (this.pauseRequested) { this.continueDevice = next; this.publish({ ...this.state, phase: 'paused' }); return; }
      const text = chunks.shift(); if (text === undefined) { this.stop(); return; }
      const utterance = platform.utterance(text);
      this.utterance = utterance;
      const current = () => this.live(generation) && this.utterance === utterance;
      utterance.lang = language; if (voice) utterance.voice = voice; utterance.rate = 1; utterance.pitch = 1;
      utterance.onstart = () => { if (current()) this.publish({ ...this.state, phase: 'speaking' }); };
      utterance.onpause = () => { if (current()) this.publish({ ...this.state, phase: 'paused' }); };
      utterance.onresume = () => { if (current()) this.publish({ ...this.state, phase: 'speaking' }); };
      utterance.onend = () => { if (current()) { this.utterance = undefined; next(); } };
      utterance.onerror = event => { if (current()) this.fail(generation, event.error === 'not-allowed' ? 'Your device did not allow read aloud. Start it again from the reply.' : 'Device reading stopped. Start it again from the reply.', false); };
      this.publish({ ...this.state, phase: 'preparing' });
      try { platform.speech.speak(utterance); } catch { this.fail(generation, 'Device speech could not start.', false); }
    };
    next();
  }
  toggle = () => {
    if (this.state.phase === 'speaking') {
      this.pauseRequested = true; this.audio?.pause(); this.speech?.pause();
    } else if (this.state.phase === 'paused') {
      this.pauseRequested = false;
      if (this.audio) void this.play(this.generation, this.audio);
      else if (this.continueDevice) { const next = this.continueDevice; this.continueDevice = undefined; next(); }
      else this.speech?.resume();
    }
  };
}
