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
