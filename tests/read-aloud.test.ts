import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadAloud, type ReadingAudio, type SpeechPlatform } from '../apps/client/src/read-aloud.js';
import { speechChunks, speechText, selectSpeechVoice } from '../apps/client/src/speech-text.js';
import type { SpeechAudio, SpeechCatalog } from '../packages/domain/read-aloud.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const audioValue: SpeechAudio = { audioBase64: 'UklGRg==', mimeType: 'audio/wav', provider: 'fixture' };
const available: SpeechCatalog = { state: 'available', epoch: 'fixture', message: '', provider: 'fixture' };
const unavailable: SpeechCatalog = { state: 'unavailable', epoch: 'fixture', message: 'No configured reading voice.' };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function deviceFixture() {
  const utterances: SpeechSynthesisUtterance[] = [], calls: string[] = [];
  const platform: SpeechPlatform = { speech: { speak: value => utterances.push(value), cancel: () => { calls.push('cancel'); }, pause: () => { calls.push('pause'); }, resume: () => { calls.push('resume'); } }, utterance: text => ({ text }) as SpeechSynthesisUtterance };
  return { platform, utterances, calls };
}
function audioFixture() {
  const players: (ReadingAudio & { plays: number; pauses: number; disposed: boolean })[] = [];
  return { players, create: () => { const player = { plays: 0, pauses: 0, disposed: false, play: async () => { player.plays++; }, pause: () => { player.pauses++; }, dispose: () => { player.disposed = true; } } as typeof players[number]; players.push(player); return player; } };
}
const fire = (u: SpeechSynthesisUtterance, event: 'onstart' | 'onpause' | 'onresume' | 'onend') => u[event]?.call(u, {} as SpeechSynthesisEvent);

test('speech preparation removes presentation while retaining numbers, order, link labels, code and meaningful symbols', () => {
  const input = '# Budget\n\n**Total:** $23.50; 2 * 3 = 6.\n\n1. Read [the policy](https://example.test/a_(b)).\n2. Keep `account_id` and x < 3.\n\n- [x] Done\n- [ ] Still needed\n\n```ts\nconst x = a * b;\n```\n\n![A blue chart](chart.png)';
  const spoken = speechText(input);
  assert.match(spoken, /^Budget/); assert.match(spoken, /Total: \$23\.50; 2 \* 3 = 6\./);
  assert.match(spoken, /1\. Read the policy\./); assert.match(spoken, /2\. Keep account_id and x < 3\./);
  assert.match(spoken, /Completed: Done/); assert.match(spoken, /Not completed: Still needed/);
  assert.match(spoken, /Code block\.\nconst x = a \* b;\nEnd of code block\./); assert.match(spoken, /Image: A blue chart\./);
  assert.doesNotMatch(spoken, /https:|```|\*\*|\[x\]/);
  assert.equal(speechText('Read [the note][n].\n\n[n]: https://example.test'), 'Read the note.');
  assert.equal(speechText('Use `a ** b ** c` and `[label](path)` literally.'), 'Use a ** b ** c and [label](path) literally.');
  assert.equal(speechText('| Name | Value |\n| --- | --- |\n| Total | $23.50 |'), 'Name; Value.\n\nTotal; $23.50.');
});

test('sentence chunks preserve full text, paragraph boundaries and unicode without losing long input', () => {
  const text = 'Dr. Smith paid $12.50 on Sept. 3. The measurement was 3.14159.\n\n' + 'A complete sentence stays together. '.repeat(120);
  const chunks = speechChunks(text, 150);
  assert.ok(chunks.every(value => value.length <= 150)); assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim());
  assert.ok(chunks.some(value => value.includes('\n\n')));
  const long = '👩🏽‍💻'.repeat(60), parts = speechChunks(long, 40);
  assert.equal(parts.join(''), long); assert.ok(parts.every(part => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(part)));
  assert.equal(speechChunks('word '.repeat(3000)).join(' ').replace(/\s+/g, ' ').trim(), 'word '.repeat(3000).trim());
  const cluster = 'a' + '\u0301'.repeat(2000), exceptional = speechChunks(cluster);
  assert.equal(exceptional.join(''), cluster); assert.ok(exceptional.every(part => part.length <= 1600));
});

test('device voice selection chooses matching language, exact locale and stable default instead of an unrelated voice', () => {
  const voices = [{ name: 'French', lang: 'fr-FR', default: true }, { name: 'UK', lang: 'en-GB', default: false }, { name: 'US', lang: 'en-US', default: true }] as SpeechSynthesisVoice[];
  assert.equal(selectSpeechVoice(voices, 'en-GB')?.name, 'UK'); assert.equal(selectSpeechVoice(voices, 'en-AU')?.name, 'US'); assert.equal(selectSpeechVoice(voices, 'ja-JP'), undefined);
});

test('provider preparation does not claim playback; actual events control pause/resume and Stop disposes audio', async () => {
  const fixture = audioFixture();
  const reader = new ReadAloud({ provider: { catalog: async () => available, speak: async () => audioValue }, audio: fixture.create });
  reader.start('one', '**Hello.**'); assert.equal(reader.getSnapshot().phase, 'preparing'); await tick();
  const audio = fixture.players[0]; assert.equal(reader.getSnapshot().phase, 'preparing');
  audio.onplaying?.(); assert.equal(reader.getSnapshot().phase, 'speaking');
  reader.toggle(); assert.equal(audio.pauses, 1); assert.equal(reader.getSnapshot().phase, 'speaking');
  audio.onpause?.(); assert.equal(reader.getSnapshot().phase, 'paused'); reader.toggle(); await tick(); assert.equal(audio.plays, 2);
  audio.onplaying?.(); assert.equal(reader.getSnapshot().phase, 'speaking'); reader.stop(); audio.onended?.(); audio.onerror?.();
  assert.equal(reader.getSnapshot().phase, 'idle'); assert.equal(audio.disposed, true);
});

test('Stop during catalog or synthesis aborts preparation and late results never create audio', async () => {
  for (const atCatalog of [true, false]) {
    const catalog = deferred<SpeechCatalog>(), synthesis = deferred<SpeechAudio>(), fixture = audioFixture(); let signal!: AbortSignal;
    const reader = new ReadAloud({ provider: { catalog: async input => { signal = input; return atCatalog ? catalog.promise : available; }, speak: async () => synthesis.promise }, audio: fixture.create });
    reader.start('one', 'Hello'); await tick(); reader.stop(); assert.equal(signal.aborted, true);
    catalog.resolve(available); synthesis.resolve(audioValue); await tick(); assert.equal(fixture.players.length, 0); assert.equal(reader.getSnapshot().phase, 'idle');
  }
});

test('replacement rejects old audio events and limits look-ahead to one chunk', async () => {
  const fixture = audioFixture(), requests: { text: string; signal: AbortSignal }[] = [];
  const reader = new ReadAloud({ provider: { catalog: async () => available, speak: async (input, signal) => { requests.push({ text: input.text, signal }); return audioValue; } }, audio: fixture.create });
  reader.start('one', 'A long sentence. '.repeat(400)); await tick(); assert.equal(requests.length, 2);
  const old = fixture.players[0]; reader.start('two', 'New reply.'); await tick();
  old.onplaying?.(); old.onended?.(); old.onerror?.(); assert.equal(reader.getSnapshot().messageId, 'two'); assert.equal(fixture.players.length, 2); assert.equal(requests[0].signal.aborted, true);
  fixture.players[1].onplaying?.(); fixture.players[1].onended?.(); assert.equal(reader.getSnapshot().phase, 'idle');
});

test('unavailable or failed provider never silently speaks on the device; explicit fallback uses event-driven playback', async () => {
  const device = deviceFixture();
  const reader = new ReadAloud({ provider: { catalog: async () => unavailable, speak: async () => { throw Error('must not synthesize'); } }, device: () => device.platform });
  reader.start('one', '# A reply\n\nRead **this**.'); await tick(); assert.equal(reader.getSnapshot().phase, 'error'); assert.equal(reader.getSnapshot().canUseDevice, true); assert.equal(device.utterances.length, 0);
  reader.useDeviceVoice(); await tick(); const u = device.utterances[0]; assert.equal(reader.getSnapshot().phase, 'preparing'); assert.match(u.text, /Read this/);
  fire(u, 'onstart'); reader.toggle(); assert.equal(reader.getSnapshot().phase, 'speaking'); fire(u, 'onpause'); assert.equal(reader.getSnapshot().phase, 'paused');
  reader.toggle(); fire(u, 'onresume'); assert.equal(reader.getSnapshot().phase, 'speaking'); assert.deepEqual(device.calls.slice(-2), ['pause', 'resume']);
  reader.stop(); fire(u, 'onend'); u.onerror?.call(u, { error: 'canceled' } as SpeechSynthesisErrorEvent); assert.equal(reader.getSnapshot().phase, 'idle');
});

test('device fallback cancels while voices load and reports a rejected utterance honestly', async () => {
  const device = deviceFixture(), voices = deferred<void>(); device.platform.ready = () => voices.promise;
  const reader = new ReadAloud({ provider: { catalog: async () => unavailable, speak: async () => audioValue }, device: () => device.platform });
  reader.start('one', 'Reply'); await tick(); reader.useDeviceVoice(); reader.stop(); voices.resolve(); await tick(); assert.equal(device.utterances.length, 0);
  reader.start('two', 'Second'); await tick(); reader.useDeviceVoice(); await tick(); const u = device.utterances[0];
  u.onerror?.call(u, { error: 'not-allowed' } as SpeechSynthesisErrorEvent); assert.equal(reader.getSnapshot().phase, 'error'); assert.match(reader.getSnapshot().error!, /did not allow/);
});

test('browser autoplay denial retains prepared provider audio for an explicit Resume without resynthesis', async () => {
  const fixture = audioFixture(); let synthesized = 0;
  const reader = new ReadAloud({ provider: { catalog: async () => available, speak: async () => { synthesized++; return audioValue; } }, audio: () => { const player = fixture.create(); player.play = async () => { player.plays++; if (player.plays === 1) throw new DOMException('Denied', 'NotAllowedError'); }; return player; } });
  reader.start('one', 'Reply'); await tick(); assert.equal(reader.getSnapshot().phase, 'paused'); assert.match(reader.getSnapshot().error!, /Resume/);
  reader.toggle(); await tick(); fixture.players[0].onplaying?.(); assert.equal(reader.getSnapshot().phase, 'speaking'); assert.equal(synthesized, 1); reader.stop();
});

test('an external audio pause is displayed honestly and late errors after Stop stay stopped', async () => {
  const fixture = audioFixture();
  const reader = new ReadAloud({ provider: { catalog: async () => available, speak: async () => audioValue }, audio: fixture.create });
  reader.start('one', 'Reply'); await tick(); const player = fixture.players[0]; player.onplaying?.(); player.onpause?.();
  assert.equal(reader.getSnapshot().phase, 'paused'); reader.toggle(); await tick(); assert.equal(player.plays, 2);
  reader.stop(); player.onplaying?.(); player.onerror?.(); assert.equal(reader.getSnapshot().phase, 'idle');
});

test('provider playback advances through a long reply once per chunk and reports later synthesis failure without switching voices', async () => {
  const fixture = audioFixture(), device = deviceFixture(), requests: string[] = [];
  const text = 'This sentence remains complete and readable. '.repeat(500), expected = speechChunks(text);
  const reader = new ReadAloud({ provider: { catalog: async () => available, speak: async input => { requests.push(input.text); return audioValue; } }, audio: fixture.create, device: () => device.platform });
  reader.start('long', text); await tick();
  for (let index = 0; index < expected.length; index++) { assert.ok(fixture.players[index]); fixture.players[index].onplaying?.(); fixture.players[index].onended?.(); await tick(); }
  assert.deepEqual(requests, expected); assert.equal(reader.getSnapshot().phase, 'idle'); assert.ok(requests.length > 8);
  let count = 0;
  const failed = new ReadAloud({ provider: { catalog: async () => available, speak: async () => { if (++count > 1) throw Error('provider disconnected'); return audioValue; } }, audio: fixture.create, device: () => device.platform });
  failed.start('fail', text); await tick(); const player = fixture.players.at(-1)!; player.onplaying?.(); player.onended?.(); await tick();
  assert.equal(failed.getSnapshot().phase, 'error'); assert.equal(failed.getSnapshot().canUseDevice, true); assert.equal(device.utterances.length, 0);
});

test('device pause at a chunk boundary holds the next utterance until explicit resume', async () => {
  const device = deviceFixture();
  const reader = new ReadAloud({ provider: { catalog: async () => unavailable, speak: async () => audioValue }, device: () => device.platform });
  reader.start('one', 'A sentence. '.repeat(400)); await tick(); reader.useDeviceVoice(); await tick();
  const first = device.utterances[0]; fire(first, 'onstart'); reader.toggle(); fire(first, 'onend');
  assert.equal(reader.getSnapshot().phase, 'paused'); assert.equal(device.utterances.length, 1);
  reader.toggle(); assert.equal(device.utterances.length, 2); assert.equal(reader.getSnapshot().phase, 'preparing');
  fire(first, 'onstart'); assert.equal(reader.getSnapshot().phase, 'preparing'); reader.stop();
});
