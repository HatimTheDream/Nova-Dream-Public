/** Provider-independent display contract. This module never admits or dispatches work. */
export type TranscriptEvent = { attemptId: string; turnId: string; eventId: string; sequence: number; role: 'user' | 'assistant'; mode: 'delta' | 'partial' | 'final'; text: string };
export type TranscriptTurn = { attemptId: string; turnId: string; role: 'user' | 'assistant'; text: string; original: string; final: boolean; unconfirmed?: boolean; edited: boolean; sequence: number; seen: string[] };
export function reconcileTranscript(current: TranscriptTurn | undefined, event: TranscriptEvent): TranscriptTurn {
  if (current && (current.attemptId !== event.attemptId || current.turnId !== event.turnId || current.role !== event.role)) throw new Error('Transcript identity mismatch');
  const turn = current ?? { attemptId: event.attemptId, turnId: event.turnId, role: event.role, text: '', original: '', final: false, edited: false, sequence: -1, seen: [] };
  if (turn.seen.includes(event.eventId) || event.sequence <= turn.sequence || turn.final) return turn;
  const original = event.mode === 'delta' ? turn.original + event.text : event.text;
  // An empty final must not erase words already shown, or pass them off as a
  // confirmed transcript. Keep the provider's exact final separate for storage.
  const unconfirmed = event.mode === 'final' && !original.trim() && !!turn.text.trim();
  return { ...turn, original, text: turn.edited || unconfirmed ? turn.text : original, final: event.mode === 'final', unconfirmed, sequence: event.sequence, seen: [...turn.seen, event.eventId] };
}
export function editTranscript(turn: TranscriptTurn, text: string): TranscriptTurn { return { ...turn, text, edited: true }; }

// Input captions use separate ASR from the model that hears and answers the call.
// More audio context improves the accuracy tradeoff without changing response VAD.
export const liveTranscription = { model: 'gpt-live-transcribe', delay: 'medium' } as const;
// Semantic turn boundaries give unfinished thoughts room for natural pauses.
export const liveTurnDetection = { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true } as const;
export function confirmsLiveTurnDetection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const detection = value as Record<string, unknown>;
  // The documented default is auto, which is equivalent to medium.
  return detection.type === liveTurnDetection.type && [undefined, 'auto', 'medium'].includes(detection.eagerness as string | undefined)
    && detection.create_response === true && detection.interrupt_response === true;
}
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

/** A terminal assistant item also settles messages cancelled before any audio
 * content was produced. Never infer missing words or map replayed user history. */
export function mapRealtimeAssistantItem(attemptId: string, sequence: number, input: Record<string, unknown>): TranscriptEvent | null {
  if (input.type !== 'response.output_item.done' || typeof input.event_id !== 'string' || !input.event_id
    || !input.item || typeof input.item !== 'object' || Array.isArray(input.item)) return null;
  const item = input.item as Record<string, unknown>;
  if (item.type !== 'message' || item.role !== 'assistant' || typeof item.id !== 'string' || !item.id
    || item.status === 'in_progress' || !Array.isArray(item.content)) return null;
  const text: string[] = [];
  for (const part of item.content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
    const value = part.type === 'output_audio' ? part.transcript : part.type === 'output_text' ? part.text : undefined;
    if (typeof value !== 'string') return null;
    text.push(value);
  }
  return { attemptId, sequence, role: 'assistant', turnId: item.id, eventId: input.event_id, mode: 'final', text: text.join('\n') };
}
