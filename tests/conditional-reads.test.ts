import test from 'node:test';
import assert from 'node:assert/strict';
import { ConditionalReads } from '../apps/client/src/conditional-reads.js';
import { RefreshReader } from '../apps/client/src/refresh-reader.js';

const first = '"e3-' + 'a'.repeat(64) + '"', second = '"e3-' + 'b'.repeat(64) + '"';
test('unchanged reads reuse a bounded memory copy without sharing mutable objects or accepting an unknown tag', () => {
  const cache = new ConditionalReads();
  const value = cache.accept('snapshot', cache.begin('snapshot'), first, '{"tasks":["original"]}') as { tasks: string[] }; value.tasks.push('caller mutation');
  assert.deepEqual(cache.accept('snapshot', cache.begin('snapshot'), first, undefined), { tasks: ['original'] });
  assert.throws(() => cache.accept('snapshot', cache.begin('snapshot'), second, undefined));
  assert.throws(() => cache.accept('assistant/state', cache.begin('assistant/state'), first, undefined));
  assert.deepEqual(cache.accept('snapshot', cache.begin('snapshot'), second, '{"tasks":["newer"]}'), { tasks: ['newer'] });
  assert.equal(cache.begin('snapshot').entry?.tag, second);
});
test('session replacement rejects in-flight old reads and uncacheable or excessive responses stay uncached', () => {
  const cache = new ConditionalReads();
  cache.accept('snapshot', cache.begin('snapshot'), first, '{}'); const old = cache.begin('snapshot'); cache.clear();
  assert.throws(() => cache.accept('snapshot', old, first, undefined));
  assert.throws(() => cache.accept('snapshot', old, first, '{}'));
  assert.equal(cache.begin('snapshot').entry, undefined);
  cache.accept('snapshot', cache.begin('snapshot'), 'not-an-app-tag', '{}'); assert.equal(cache.begin('snapshot').entry, undefined);
  cache.accept('mail/content', cache.begin('mail/content'), first, '{}'); assert.equal(cache.begin('mail/content').entry, undefined);
  cache.accept('snapshot', cache.begin('snapshot'), first, JSON.stringify('x'.repeat(4 * 1024 * 1024))); assert.equal(cache.begin('snapshot').entry, undefined);
});
test('idle Assistant polls back off briefly while workspace polling and explicit refresh remain immediate', async () => {
  let now = 0, count = 0;
  const cache = new ConditionalReads(() => now);
  for (const path of ['snapshot', 'assistant/state']) { cache.accept(path, cache.begin(path), first, '{}'); cache.accept(path, cache.begin(path), first, undefined); }
  assert.equal(cache.mayPoll('snapshot'), true); assert.equal(cache.mayPoll('assistant/state'), false);
  const reader = new RefreshReader({ identity: () => 'owner', mayPoll: () => cache.mayPoll('assistant/state'), read: async () => ++count, accept: () => {} });
  await reader.poll(); assert.equal(count, 0);
  await reader.refresh(); assert.equal(count, 1);
  now = 5000; await reader.poll(); assert.equal(count, 2);
  cache.accept('assistant/state', cache.begin('assistant/state'), second, '{"changed":true}'); assert.equal(cache.mayPoll('assistant/state'), true);
});
