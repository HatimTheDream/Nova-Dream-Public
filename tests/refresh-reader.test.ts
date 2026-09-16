import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefreshReader } from '../apps/client/src/refresh-reader.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  let identity = 'workspace-a';
  const reads: { signal: AbortSignal; resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  const values: string[] = [], errors: unknown[] = [];
  const reader = new RefreshReader({ identity: () => identity, read: signal => new Promise<string>((resolve, reject) => reads.push({ signal, resolve, reject })), accept: value => values.push(value), fail: error => errors.push(error) });
  return { reader, reads, values, errors, scope: (next: string) => { identity = next; } };
}

test('slow successful reads publish despite frequent polls with only one request in flight', async () => {
  const f = fixture(), done = f.reader.poll(); await flush();
  for (let i = 0; i < 20; i++) { assert.equal(f.reader.poll(), done); await flush(); }
  assert.equal(f.reads.length, 1); f.reads[0].resolve('ready'); await done;
  assert.deepEqual(f.values, ['ready']);
  const next = f.reader.poll(); await flush(); assert.equal(f.reads.length, 2);
  f.reads[1].resolve('updated'); await next; assert.deepEqual(f.values, ['ready', 'updated']);
});

test('acknowledged mutations invalidate the older read and coalesce into one fresh read', async () => {
  const f = fixture(), poll = f.reader.poll(); await flush();
  let finished = false;
  const refresh = f.reader.refresh().then(() => { finished = true; });
  for (let i = 0; i < 10; i++) assert.equal(f.reader.refresh(), poll);
  f.reads[0].resolve('before mutation'); await flush();
  assert.deepEqual(f.values, []); assert.equal(finished, false); assert.equal(f.reads.length, 2);
  assert.equal(f.reader.poll(), poll);
  f.reads[1].resolve('after mutation'); await refresh;
  assert.deepEqual(f.values, ['after mutation']); assert.equal(finished, true);
});

test('a further mutation during the follow-up read requires its own new observation', async () => {
  const f = fixture(), done = f.reader.poll(); await flush(); f.reader.refresh();
  f.reads[0].resolve('old'); await flush(); f.reader.refresh(); f.reader.refresh();
  f.reads[1].resolve('also old'); await flush();
  assert.equal(f.reads.length, 3); assert.deepEqual(f.values, []);
  f.reads[2].resolve('latest'); await done; assert.deepEqual(f.values, ['latest']);
});

test('workspace replacement aborts old reads and ignores late results even if its identity returns', async () => {
  const f = fixture(), old = f.reader.poll(); await flush();
  f.scope('workspace-b'); const newer = f.reader.poll(); await flush();
  assert.equal(f.reads[0].signal.aborted, true);
  f.scope('workspace-a'); const latest = f.reader.poll(); await flush();
  f.reads[0].resolve('obsolete a'); f.reads[1].reject(Error('obsolete b'));
  await Promise.all([old, newer]); assert.deepEqual(f.values, []); assert.deepEqual(f.errors, []);
  f.reads[2].resolve('current a'); await latest; assert.deepEqual(f.values, ['current a']);
});

test('cleanup cancels queued refreshes and permits a clean remount', async () => {
  const f = fixture(), old = f.reader.poll(); await flush(); f.reader.refresh(); f.reader.cancel();
  assert.equal(f.reads[0].signal.aborted, true);
  const next = f.reader.poll(); await flush(); f.reads[0].resolve('unmounted'); await old;
  assert.equal(f.reads.length, 2); assert.deepEqual(f.values, []);
  f.reads[1].resolve('remounted'); await next; assert.deepEqual(f.values, ['remounted']);
});

test('failed reads release the slot and obsolete failures do not override a requested refresh', async () => {
  const f = fixture(), fail = f.reader.poll(); await flush(); f.reads[0].reject(Error('offline')); await fail;
  assert.equal(f.errors.length, 1);
  const retry = f.reader.refresh(); await flush(); f.reader.refresh(); f.reads[1].reject(Error('obsolete')); await flush();
  assert.equal(f.errors.length, 1); f.reads[2].resolve('reconnected'); await retry;
  assert.deepEqual(f.values, ['reconnected']);
});

test('a slow outputs reader does not block state updates', async () => {
  const state = fixture(), outputs = fixture(), outputRead = outputs.reader.poll();
  for (let i = 0; i < 3; i++) {
    const next = state.reader.poll(); await flush(); state.reads[i].resolve(`state ${i}`); await next;
    assert.equal(outputs.reader.poll(), outputRead);
  }
  assert.equal(outputs.reads.length, 1); assert.equal(state.values.length, 3);
  outputs.reads[0].resolve('files'); await outputRead;
});
