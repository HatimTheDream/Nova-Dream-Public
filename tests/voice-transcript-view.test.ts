import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingVoiceTurns } from '../apps/client/src/voice-transcript.js';

test('live voice remains in its original conversation until exact native history takes ownership', () => {
  const chat: any = { id: 'chat', nativeId: 'native' }, history: any = { nativeId: 'native', messages: [] };
  const first = { turnId: 'one', role: 'user', text: 'Hello', final: true }, second = { turnId: 'two', role: 'user', text: 'Hello', final: false };
  const voice: any = { attempt: { id: 'call', target: { conversation: chat }, entries: [{ entryId: 'one', saved: true }] }, turns: [first, second] };
  assert.deepEqual(pendingVoiceTurns(voice, chat, history), [first, second]);
  history.messages.push({ id: 'voice:call:one', role: 'user', text: 'Hello' });
  assert.deepEqual(pendingVoiceTurns(voice, chat, history), [second]);
  assert.deepEqual(pendingVoiceTurns(voice, { ...chat, id: 'other' }, history), []);
  assert.deepEqual(pendingVoiceTurns(voice, { ...chat, nativeId: 'replacement' }, history), []);
});

import { groupVoiceMessages, voiceHistoryMessages, transcriptText, transcriptContains, type TranscriptMessage } from '../apps/client/src/voice-transcript.js';
const call = '345f2170-979e-4fb6-b773-5e22baebd103';
const message = (entry: string, text: string, role: TranscriptMessage['role'] = 'user', callId = call): TranscriptMessage => ({ id: `voice:${callId}:${entry}`, role, text, textHash: `hash-${entry}`, attachments: [] });

test('continuous voice segments form one display bubble with exact words and immutable native parts', () => {
  const first = message('one', "I'm just testing the voice chat right now."), second = message('two', "I'm doing an iPhone voice check. I'm on the iPhone right now.");
  const reply = message('reply', 'Audio is clear.', 'assistant'), next = message('next', 'Next question.');
  const original = structuredClone([first, second, reply, next]), grouped = groupVoiceMessages([first, second, reply, next]);
  assert.equal(grouped.length, 3); assert.equal(grouped[0].id, first.id);
  assert.equal(transcriptText(grouped[0]), `${first.text} ${second.text}`);
  assert.deepEqual(grouped[0].voiceParts, [first, second]); assert.equal(grouped[0].textHash, first.textHash);
  assert(transcriptContains(grouped[0], second.id, 'user')); assert(!transcriptContains(grouped[0], second.id, 'assistant'));
  assert.deepEqual([first, second, reply, next], original); assert.equal(grouped[2], next);
});

test('voice grouping cannot cross calls, typed messages, tools, replies, silence or attached files', () => {
  const first = message('one', 'Repeat.'), repeat = message('two', 'Repeat.');
  assert.equal(transcriptText(groupVoiceMessages([first, repeat])[0]), 'Repeat. Repeat.', 'identical speech is never deduplicated');
  for (const boundary of [
    message('new-call', 'Other call.', 'user', '00000000-0000-4000-8000-000000000000'),
    { ...message('typed', 'Typed words.'), id: 'typed-message' },
    message('reply', 'A reply.', 'assistant'), message('tool', 'Tool output.', 'tool'), message('silent', ''),
    { ...message('file', 'A file.'), attachments: [{ artifactId: 'file', name: 'file.txt' }] },
  ]) assert.equal(groupVoiceMessages([first, boundary, repeat]).length, 3);
});

test('a live continuation stays in the same bubble as its saved half through acknowledgements and reload', () => {
  const first = message('one', 'Start the thought.'), second = message('two', 'Continue the thought.');
  const chat: any = { id: 'chat', nativeId: 'native' };
  const voice: any = { attempt: { id: call, target: { conversation: chat }, entries: [] }, turns: [{ turnId: 'one', role: 'user', text: first.text, final: true }, { turnId: 'two', role: 'user', text: second.text, final: false }] };
  const history: any = { nativeId: 'native', messages: [] };
  const view = () => groupVoiceMessages(voiceHistoryMessages(voice, chat, history));
  assert.equal(view().length, 1); assert.equal(view()[0].streaming, true);
  history.messages = [first];
  assert.equal(view().length, 1); assert.equal(view()[0].voiceParts!.length, 2); assert.equal(view()[0].voiceParts![0].pendingVoice, undefined);
  voice.turns[1].final = true; history.messages = [first, second];
  assert.equal(view().length, 1); assert.equal(view()[0].streaming, false);
  assert.equal(transcriptText(view()[0]), `${first.text} ${second.text}`);
  assert.deepEqual(view()[0].voiceParts, groupVoiceMessages(history.messages)[0].voiceParts, 'reloaded history agrees with the live view');
  history.messages = [first]; history.hasNewer = true;
  assert.equal(voiceHistoryMessages(voice, chat, history).length, 1, 'older pages never append current speech');
});
