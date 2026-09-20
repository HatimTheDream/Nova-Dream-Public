import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmsLiveTurnDetection, editTranscript, liveTurnDetection, mapRealtimeAssistantItem, mapRealtimeTranscript, reconcileTranscript, type TranscriptEvent, type TranscriptTurn } from '../packages/adapters/voice-transcript.js';

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

test('a blank final retains visible words as unconfirmed without inventing a stored transcript', () => {
  const partial = reconcileTranscript(undefined, event(1, 'Please move my appointment to Friday'));
  const final = reconcileTranscript(partial, event(2, '', 'final'));
  assert.equal(final.text, partial.text); assert.equal(final.original, '');
  assert.equal(final.final, true); assert.equal(final.unconfirmed, true);
  // Once a final may have been journalled, late events cannot change its receipt.
  for (const late of [event(2, '', 'final'), event(3, ' corrected', 'delta'), event(4, 'A different final', 'final')]) {
    assert.equal(reconcileTranscript(final, late), final);
  }
  const silent = reconcileTranscript(undefined, event(5, '', 'final'));
  assert.equal(silent.text, ''); assert.equal(silent.original, ''); assert.equal(silent.unconfirmed, false);
  const edited = editTranscript(partial, 'Keep my reviewed wording');
  const editedFinal = reconcileTranscript(edited, event(6, '  ', 'final'));
  assert.equal(editedFinal.text, edited.text); assert.equal(editedFinal.original, '  '); assert.equal(editedFinal.unconfirmed, true);
});

test('terminal assistant items settle exact audio, text and silent messages without guessing absent content', () => {
  const terminal = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'response.output_item.done', event_id: 'terminal-event', item: { id: 'reply', role: 'assistant', type: 'message', status: 'incomplete', content, ...extra } });
  for (const [content, text] of [
    [[{ type: 'output_audio', transcript: 'Exact spoken words.' }], 'Exact spoken words.'],
    [[{ type: 'output_text', text: 'Exact text.' }], 'Exact text.'],
    [[{ type: 'output_audio', transcript: 'First.' }, { type: 'output_audio', transcript: 'Second.' }], 'First.\nSecond.'],
    [[], ''],
  ] as const) assert.deepEqual(mapRealtimeAssistantItem('attempt-1', 1, terminal(content)), { attemptId: 'attempt-1', sequence: 1, role: 'assistant', turnId: 'reply', eventId: 'terminal-event', mode: 'final', text });
  for (const input of [
    terminal(undefined), terminal(null), terminal([{}]), terminal([{ type: 'output_audio' }]),
    terminal([{ type: 'input_audio', transcript: 'User words' }]), terminal([], { role: 'user' }),
    terminal([], { type: 'function_call' }), terminal([], { status: 'in_progress' }), terminal([], { id: '' }),
    { ...terminal([]), type: 'response.output_item.added' }, { ...terminal([]), event_id: undefined },
    { ...terminal([]), type: 'conversation.item.created' },
  ]) assert.equal(mapRealtimeAssistantItem('attempt-1', 1, input), null);
});

test('semantic turn acknowledgement requires natural-pause boundaries and live conversation controls', () => {
  assert.deepEqual(liveTurnDetection, { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true });
  for (const eagerness of ['medium', 'auto', undefined]) assert.equal(confirmsLiveTurnDetection({ ...liveTurnDetection, eagerness }), true);
  for (const value of [null, [], {}, { ...liveTurnDetection, type: 'server_vad' }, { ...liveTurnDetection, eagerness: 'high' }, { ...liveTurnDetection, eagerness: 'low' }, { ...liveTurnDetection, eagerness: null }, { ...liveTurnDetection, create_response: false }, { ...liveTurnDetection, interrupt_response: false }]) assert.equal(confirmsLiveTurnDetection(value), false);
});

test('three spoken turns keep a blank middle final visible through interleaved and late finals', () => {
  const turns = new Map<string, TranscriptTurn>(); let sequence = 0;
  const accept = (turnId: string, role: 'user' | 'assistant', text: string, final: boolean) => {
    const input = { type: role === 'user' ? `conversation.item.input_audio_transcription.${final ? 'completed' : 'delta'}` : `response.output_audio_transcript.${final ? 'done' : 'delta'}`, item_id: turnId, event_id: `event-${++sequence}`, ...(final ? { transcript: text } : { delta: text }) };
    const mapped = mapRealtimeTranscript('attempt-1', sequence, input)!;
    turns.set(turnId, reconcileTranscript(turns.get(turnId), mapped));
  };
  accept('speech-1', 'user', 'Just talking', false);
  accept('reply-1', 'assistant', 'I am listening.', true);
  accept('speech-2', 'user', 'Please keep the whole thought', false);
  accept('reply-2', 'assistant', 'Take your time.', true);
  accept('speech-3', 'user', 'And this is my third sentence', false);
  accept('speech-3', 'user', 'And this is my third sentence.', true);
  accept('speech-2', 'user', '', true);
  accept('speech-1', 'user', 'Just talking.', true);
  accept('reply-3', 'assistant', 'I heard the third sentence.', true);
  assert.deepEqual(['speech-1', 'speech-2', 'speech-3'].map(id => turns.get(id)?.text), ['Just talking.', 'Please keep the whole thought', 'And this is my third sentence.']);
  assert.equal(turns.get('speech-2')?.original, ''); assert.equal(turns.get('speech-2')?.unconfirmed, true);
  assert.equal(turns.get('speech-1')?.unconfirmed, false); assert.equal(turns.get('speech-3')?.unconfirmed, false);
  assert.equal(turns.size, 6); assert.ok([...turns.values()].every(turn => turn.final));
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
