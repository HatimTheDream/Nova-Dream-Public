export type ReadingState = { phase: 'idle' | 'speaking' | 'paused' | 'error'; messageId?: string; error?: string };
type Speech = Pick<SpeechSynthesis, 'speak' | 'cancel' | 'pause' | 'resume'>;
export function speechChunks(text: string): string[] {
  const chunks: string[] = []; let rest = text.trim();
  while (rest) { let end = Math.min(1600, rest.length); if (end < rest.length) { const boundary = rest.slice(0, end).search(/[.!?\n][^.!?\n]*$/); if (boundary > 800) end = boundary + 1; else { const space = rest.lastIndexOf(' ', end); if (space > 800) end = space; } } chunks.push(rest.slice(0, end)); rest = rest.slice(end).trimStart(); }
  return chunks;
}
/** One reader per chat editor; virtualization does not own or duplicate audio. */
export class ReadAloud {
  private state: ReadingState = { phase: 'idle' };
  private listeners = new Set<() => void>();
  private generation = 0;
  private speech?: Speech;
  constructor(private platform: () => { speech: Speech; utterance: (text: string) => SpeechSynthesisUtterance } | undefined = () => typeof window !== 'undefined' && 'speechSynthesis' in window ? { speech: window.speechSynthesis, utterance: text => new SpeechSynthesisUtterance(text) } : undefined) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private publish(state: ReadingState) { this.state = state; for (const fn of this.listeners) fn(); }
  stop = () => { this.generation++; this.speech?.cancel(); this.speech = undefined; this.publish({ phase: 'idle' }); };
  start = (messageId: string, text: string) => {
    this.stop(); const platform = this.platform();
    if (!platform) { this.publish({ phase: 'error', error: 'Read aloud is unavailable in this browser.' }); return; }
    const chunks = speechChunks(text); if (!chunks.length) return;
    const generation = this.generation; this.speech = platform.speech;
    const next = () => {
      if (generation !== this.generation) return;
      const chunk = chunks.shift(); if (!chunk) { this.speech = undefined; this.publish({ phase: 'idle' }); return; }
      const utterance = platform.utterance(chunk);
      utterance.onend = () => { if (generation === this.generation) next(); };
      utterance.onerror = event => { if (generation !== this.generation) return; this.generation++; this.speech = undefined; this.publish({ phase: 'error', error: event.error === 'not-allowed' ? 'Your device did not allow read aloud. Try again from the reply menu.' : 'Read aloud stopped. You can try again from the reply menu.' }); };
      try { platform.speech.speak(utterance); } catch { this.generation++; this.publish({ phase: 'error', error: 'Read aloud could not start on this device.' }); }
    };
    this.publish({ phase: 'speaking', messageId }); next();
  };
  toggle = () => { if (this.state.phase === 'speaking') { this.speech?.pause(); this.publish({ ...this.state, phase: 'paused' }); } else if (this.state.phase === 'paused') { this.speech?.resume(); this.publish({ ...this.state, phase: 'speaking' }); } };
}
