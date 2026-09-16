import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareWorkspaceStartup, startupProgress, type StartupPhase } from '../apps/client/src/startup-progress';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }

test('startup waits for module and preparation completion; elapsed time alone does not advance it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const module = deferred<() => Promise<void>>(), inbox = deferred<void>(), seen: StartupPhase[] = [];
  const stop = prepareWorkspaceStartup(() => module.promise, phase => seen.push(phase));
  t.mock.timers.tick(2000); await settle(); assert.deepEqual([...seen], []);
  module.resolve(() => inbox.promise); await settle(); assert.deepEqual([...seen], ['inbox']);
  t.mock.timers.tick(2000); await settle(); assert.deepEqual([...seen], ['inbox']);
  inbox.resolve(); await settle(); assert.deepEqual(seen.map(phase => startupProgress[phase].percent), [80, 100]);
  t.mock.timers.tick(8000); await settle(); assert.deepEqual([...seen], ['inbox', 'ready']); stop();
});

test('the existing opening limit releases Home while late preparation cannot move progress backward', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const module = deferred<() => Promise<void>>(), inbox = deferred<void>(), seen: string[] = [];
  let prepared = 0;
  const stop = prepareWorkspaceStartup(() => module.promise, phase => seen.push(phase));
  t.mock.timers.tick(7999); await settle(); assert.deepEqual([...seen], []);
  t.mock.timers.tick(1); await settle(); assert.deepEqual([...seen], ['ready']);
  module.resolve(() => { prepared++; return inbox.promise; }); await settle(); assert.equal(prepared, 1);
  inbox.resolve(); await settle(); assert.deepEqual([...seen], ['ready']); stop();
});

test('an optional module or mail preparation failure cannot strand the loading screen', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const failsDuringImport of [true, false]) {
    const seen: string[] = [];
    const stop = prepareWorkspaceStartup(async () => {
      if (failsDuringImport) throw Error('Module unavailable');
      return async () => { throw Error('Mail unavailable'); };
    }, phase => seen.push(phase));
    await settle(); assert.deepEqual([...seen], failsDuringImport ? ['ready'] : ['inbox', 'ready']);
    t.mock.timers.tick(8000); await settle(); assert.equal(seen.filter(phase => phase === 'ready').length, 1); stop();
  }
});

test('disposing a workspace prevents stale preparation and progress updates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const module = deferred<() => Promise<void>>(), seen: string[] = [];
  let prepared = false;
  const stop = prepareWorkspaceStartup(() => module.promise, phase => seen.push(phase));
  await settle(); stop();
  module.resolve(async () => { prepared = true; }); await settle(); t.mock.timers.tick(8000);
  assert.equal(prepared, false); assert.deepEqual([...seen], []);
  const inbox = deferred<void>();
  const stopLater = prepareWorkspaceStartup(async () => () => inbox.promise, phase => seen.push(phase));
  await settle(); assert.deepEqual([...seen], ['inbox']); stopLater(); inbox.resolve();
  await settle(); t.mock.timers.tick(8000); assert.deepEqual([...seen], ['inbox']);
});
