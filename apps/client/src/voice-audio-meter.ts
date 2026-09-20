export type VoiceLevels = Readonly<{ input: number; output: number }>;
export const silentVoiceLevels: VoiceLevels = { input: 0, output: 0 };
type Tap = { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer> };
type Gates = { input: boolean; output: boolean };

/** Measures only; neither microphone nor remote audio is routed to the speakers. */
export class VoiceAudioMeter {
  private input?: Tap;
  private output?: Tap;
  private frame?: number;
  private previous?: number;
  private lastSound?: number;
  private levels: VoiceLevels = silentVoiceLevels;
  private speaking = false;
  private disposed = false;
  constructor(private context: AudioContext, private gates: () => Gates, private changed: (levels: VoiceLevels, speaking: boolean) => void) {
    context.addEventListener('statechange', this.refresh);
  }
  setInput(stream: MediaStream) { this.replace('input', stream); }
  setOutput(stream: MediaStream) { this.replace('output', stream); }
  private disconnect(tap?: Tap) {
    try { tap?.source.disconnect(); } catch { /* A closed audio graph is already disconnected. */ }
    try { tap?.analyser.disconnect(); } catch { /* Meter nodes never own playback. */ }
  }
  private replace(kind: 'input' | 'output', stream: MediaStream) {
    if (this.disposed) return;
    this.disconnect(this[kind]); this[kind] = undefined;
    let source: MediaStreamAudioSourceNode | undefined, analyser: AnalyserNode | undefined;
    try {
      source = this.context.createMediaStreamSource(stream); analyser = this.context.createAnalyser();
      analyser.fftSize = 512; source.connect(analyser);
      this[kind] = { source, analyser, samples: new Float32Array(analyser.fftSize) };
    } catch {
      // Visualization failure must not admit, interrupt, or invent activity for a call.
      try { source?.disconnect(); analyser?.disconnect(); } catch { /* Already closed. */ }
    }
    if (kind === 'output') this.lastSound = undefined;
    this.publish({ ...this.levels, [kind]: 0 }, kind === 'output' ? false : this.speaking);
    if (this.frame === undefined) this.frame = requestAnimationFrame(this.tick);
  }
  private rms(tap?: Tap) {
    if (!tap) return 0;
    try {
      tap.analyser.getFloatTimeDomainData(tap.samples);
      let sum = 0;
      for (const value of tap.samples) { if (!Number.isFinite(value)) return 0; sum += value * value; }
      return Math.sqrt(sum / tap.samples.length);
    } catch { return 0; }
  }
  private envelope(rms: number, current: number, elapsed: number) {
    // A small noise floor avoids idle microphone hiss moving the artwork.
    const target = Math.min(1, Math.sqrt(Math.max(0, (rms - 0.004) / 0.16)));
    const value = current + (target - current) * (1 - Math.exp(-elapsed / (target > current ? 45 : 100)));
    return value < 0.005 ? 0 : Math.round(value * 1000) / 1000;
  }
  private publish(levels: VoiceLevels, speaking: boolean) {
    if (levels.input === this.levels.input && levels.output === this.levels.output && speaking === this.speaking) return;
    this.levels = levels; this.speaking = speaking; this.changed(levels, speaking);
  }
  private sample(now: number, force = false) {
    if (this.disposed || !force && this.previous !== undefined && now - this.previous < 32) return;
    const elapsed = this.previous === undefined ? 33 : Math.max(1, Math.min(80, now - this.previous));
    this.previous = now;
    const gates = this.gates(), running = this.context.state === 'running';
    const input = running && gates.input && !!this.input;
    const output = running && gates.output && !!this.output;
    const inputRms = input ? this.rms(this.input) : 0, outputRms = output ? this.rms(this.output) : 0;
    if (!output) this.lastSound = undefined;
    else if (outputRms > 0.002) this.lastSound = now;
    this.publish({ input: input ? this.envelope(inputRms, this.levels.input, elapsed) : 0,
      output: output ? this.envelope(outputRms, this.levels.output, elapsed) : 0 },
    output && this.lastSound !== undefined && now - this.lastSound < 160);
  }
  private tick = (now: number) => {
    this.frame = undefined; this.sample(now);
    if (!this.disposed) this.frame = requestAnimationFrame(this.tick);
  };
  refresh = () => this.sample(performance.now(), true);
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.context.removeEventListener('statechange', this.refresh);
    this.disconnect(this.input); this.disconnect(this.output); this.input = this.output = undefined;
    this.publish(silentVoiceLevels, false);
  }
}
