import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadAloud, speechChunks } from '../apps/client/src/read-aloud.js';

test('read aloud has one owner, pause/resume, bounded speech chunks and ignores late callbacks after stop or replacement', () => {
  const utterances: SpeechSynthesisUtterance[] = [], calls: string[] = [];
  const reader = new ReadAloud(() => ({ speech: { speak: u => { utterances.push(u); }, cancel: () => { calls.push('cancel'); }, pause: () => { calls.push('pause'); }, resume: () => { calls.push('resume'); } }, utterance: text => ({ text }) as SpeechSynthesisUtterance }));
  reader.start('one', 'First. '.repeat(500)); const first = utterances[0]; assert.equal(reader.getSnapshot().phase, 'speaking'); assert.ok(first.text.length <= 1600);
  reader.toggle(); assert.equal(reader.getSnapshot().phase, 'paused'); reader.toggle(); assert.equal(reader.getSnapshot().phase, 'speaking'); assert.ok(calls.includes('pause') && calls.includes('resume'));
  reader.start('two', 'Second message.'); assert.equal(reader.getSnapshot().messageId, 'two'); const count = utterances.length;
  first.onend?.call(first, {} as SpeechSynthesisEvent); first.onerror?.call(first, { error: 'canceled' } as SpeechSynthesisErrorEvent); assert.equal(utterances.length, count); assert.equal(reader.getSnapshot().messageId, 'two');
  const second = utterances.at(-1)!; reader.stop(); second.onend?.call(second, {} as SpeechSynthesisEvent); assert.equal(reader.getSnapshot().phase, 'idle'); assert.equal(utterances.length, count);
  const chunks = speechChunks('word '.repeat(3000)); assert.ok(chunks.every(c => c.length <= 1600)); assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), 'word '.repeat(3000).trim());
});

test('read aloud reports unsupported speech and device rejection without a false playing state', () => {
  const unavailable = new ReadAloud(() => undefined); unavailable.start('one', 'Reply'); assert.equal(unavailable.getSnapshot().phase, 'error'); unavailable.stop(); assert.equal(unavailable.getSnapshot().phase, 'idle');
  let utterance: SpeechSynthesisUtterance;
  const reader = new ReadAloud(() => ({ speech: { speak: u => { utterance = u; }, cancel() {}, pause() {}, resume() {} }, utterance: text => ({ text }) as SpeechSynthesisUtterance })); reader.start('one', 'Reply'); utterance!.onerror?.call(utterance!, { error: 'not-allowed' } as SpeechSynthesisErrorEvent); assert.match(reader.getSnapshot().error!, /did not allow/);
});
