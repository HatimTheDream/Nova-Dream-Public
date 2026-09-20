/** Provider-independent display contract. This module never admits or dispatches work. */
export type TranscriptEvent = { attemptId: string; turnId: string; eventId: string; sequence: number; role: 'user' | 'assistant'; mode: 'delta' | 'partial' | 'final'; text: string };
export type TranscriptTurn = { attemptId: string; turnId: string; role: 'user' | 'assistant'; text: string; original: string; final: boolean; edited: boolean; sequence: number; seen: string[] };
export function reconcileTranscript(current: TranscriptTurn | undefined, event: TranscriptEvent): TranscriptTurn {
  if (current && (current.attemptId !== event.attemptId || current.turnId !== event.turnId || current.role !== event.role)) throw new Error('Transcript identity mismatch');
  const turn = current ?? { attemptId: event.attemptId, turnId: event.turnId, role: event.role, text: '', original: '', final: false, edited: false, sequence: -1, seen: [] };
  if (turn.seen.includes(event.eventId) || event.sequence <= turn.sequence || turn.final) return turn;
  const original = event.mode === 'delta' ? turn.original + event.text : event.text;
  return { ...turn, original, text: turn.edited ? turn.text : original, final: event.mode === 'final', sequence: event.sequence, seen: [...turn.seen, event.eventId] };
}
export function editTranscript(turn: TranscriptTurn, text: string): TranscriptTurn { return { ...turn, text, edited: true }; }

// Input captions use separate ASR from the model that hears and answers the call.
// More audio context improves the accuracy tradeoff without changing response VAD.
export const liveTranscription = { model: 'gpt-live-transcribe', delay: 'medium' } as const;
export function confirmsLiveTranscription(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const transcription = value as Record<string, unknown>;
  // Delay is a quality hint the provider may omit or normalize. Only the
  // caption model is an admission requirement; the controller also binds context.
  return transcription.model === liveTranscription.model;
}

/** Only maps exact documented/observed event families. No automatic alternate runner. */
export function mapRealtimeTranscript(attemptId: string, sequence: number, input: Record<string, unknown>): TranscriptEvent | null {
  const type = input.type;
  const role = type === 'conversation.item.input_audio_transcription.delta' || type === 'conversation.item.input_audio_transcription.completed' ? 'user' : type === 'response.output_audio_transcript.delta' || type === 'response.output_audio_transcript.done' ? 'assistant' : null;
  if (!role || typeof input.item_id !== 'string' || typeof input.event_id !== 'string') return null;
  const mode = String(type).endsWith('.delta') ? 'delta' : 'final';
  const text = mode === 'delta' ? input.delta : input.transcript;
  if (typeof text !== 'string') return null;
  return { attemptId, sequence, role, turnId: input.item_id, eventId: input.event_id, mode, text };
}
