import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editTranscript, mapRealtimeTranscript, reconcileTranscript, type TranscriptEvent, type TranscriptTurn } from '../packages/adapters/voice-transcript.js';

const event = (sequence: number, text: string, mode: TranscriptEvent['mode'] = 'delta'): TranscriptEvent => ({ attemptId: 'attempt-1', turnId: 'turn-1', eventId: `event-${sequence}`, sequence, role: 'user', mode, text });
test('live user delta maps before final; unknown or unidentifiable event cannot acquire identity', () => {
  const mapped = mapRealtimeTranscript('attempt-1', 1, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'turn-1', event_id: 'event-1', delta: 'Plan my' });
  assert.equal(mapped?.text, 'Plan my'); assert.equal(mapped?.mode, 'delta');
  assert.equal(mapRealtimeTranscript('attempt-1', 2, { type: 'conversation.item.input_audio_transcription.delta', delta: 'Unbound' }), null);
});
test('duplicate/out-of-order deltas do not multiply text; replacement and final reconcile one turn', () => {
  let turn = reconcileTranscript(undefined, event(1, 'I really '));
  turn = reconcileTranscript(turn, event(2, 'really want '));
  turn = reconcileTranscript(turn, event(1, 'I really '));
  assert.equal(turn.text, 'I really really want ');
  turn = reconcileTranscript(turn, event(3, 'I really want this', 'partial'));
  turn = reconcileTranscript(turn, event(4, 'I really want this.', 'final'));
  assert.equal(turn.text, 'I really want this.'); assert.equal(turn.final, true);
  assert.equal(reconcileTranscript(turn, event(5, ' late')).text, 'I really want this.');
});
test('user edits own the text; provider final is retained separately and never overwrites edits', () => {
  let turn = editTranscript(reconcileTranscript(undefined, event(1, 'Draft a plan')), 'Draft a short plan for Friday');
  turn = reconcileTranscript(turn, event(2, 'Draft a plan for Monday.', 'final'));
  assert.equal(turn.text, 'Draft a short plan for Friday'); assert.equal(turn.original, 'Draft a plan for Monday.'); assert.equal(turn.final, true);
});
test('attempt, turn, and role changes cannot retarget a late callback', () => {
  const turn = reconcileTranscript(undefined, event(1, 'Keep me'));
  for (const change of [{ attemptId: 'attempt-2' }, { turnId: 'turn-2' }, { role: 'assistant' as const }]) assert.throws(() => reconcileTranscript(turn, { ...event(2, 'Wrong target'), ...change }), /identity mismatch/);
});

test('provider finals replace provisional words by item identity despite interleaved replies and later input', () => {
  const turns = new Map<string, TranscriptTurn>();
  let sequence = 0;
  const accept = (input: Record<string, unknown>) => {
    const mapped = mapRealtimeTranscript('attempt-1', ++sequence, input);
    assert.ok(mapped);
    turns.set(mapped.turnId, reconcileTranscript(turns.get(mapped.turnId), mapped));
  };
  accept({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first-input', event_id: 'input-1', delta: 'Turn left at' });
  accept({ type: 'response.output_audio_transcript.delta', item_id: 'reply', event_id: 'reply-1', delta: 'Yes, I can' });
  accept({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'second-input', event_id: 'input-2', delta: 'And keep going' });
  accept({ type: 'response.output_audio_transcript.done', item_id: 'reply', event_id: 'reply-final', transcript: 'Yes, I can hear you.' });
  accept({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'second-input', event_id: 'second-final', transcript: 'And keep going.' });
  accept({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first-input', event_id: 'first-final', transcript: 'Can you hear this clearly?' });
  accept({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first-input', event_id: 'late-input', delta: ' the next street' });
  accept({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first-input', event_id: 'first-final', transcript: 'Can you hear this clearly?' });
  assert.deepEqual([...turns.values()].map(({ turnId, role, text, original, final }) => ({ turnId, role, text, original, final })), [
    { turnId: 'first-input', role: 'user', text: 'Can you hear this clearly?', original: 'Can you hear this clearly?', final: true },
    { turnId: 'reply', role: 'assistant', text: 'Yes, I can hear you.', original: 'Yes, I can hear you.', final: true },
    { turnId: 'second-input', role: 'user', text: 'And keep going.', original: 'And keep going.', final: true },
  ]);
});
