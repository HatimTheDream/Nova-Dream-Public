import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfilePages, type ProfileReadPage } from '../apps/client/src/profile-week-client.js';
import { emptyProfileView, readProfileViewSlot } from '../apps/client/src/profile-view.js';
import { writeProfileSlot } from '../apps/client/src/profile-kept-state.js';

type Row = { id: string; text: string };
const rows = (n: number, prefix = 'event') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}:${n - i}`, text: `Original ${i}` }));
const page = (all: Row[], before?: string, revision = 1, epoch = 'epoch'): ProfileReadPage<Row> => {
  const start = before ? all.findIndex(row => row.id === before) + 1 : 0, entries = all.slice(start, start + 50);
  return { epoch, revision, head: all[0]?.id ?? null, entries, next: start + entries.length < all.length ? entries.at(-1)!.id : null, total: all.length };
};
function deferred<T>() { let resolve!: (value: T) => void, reject!: (problem: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('initial history reads one page, appends exact older pages and retains them after another page fails', async () => {
  const all = rows(130), calls: (string | undefined)[] = []; let fail = false;
  const history = new ProfilePages<Row>('epoch', async before => { calls.push(before); if (fail) throw Error('Read unavailable'); return page(all, before); });
  assert(await history.refresh()); assert.equal(calls.length, 1); assert.equal(history.rows.length, 50);
  assert(await history.more()); const kept = structuredClone(history.rows), cursor = history.next; fail = true;
  assert(!await history.more()); assert.deepEqual(history.rows, kept); assert.equal(history.next, cursor); assert.equal(history.total, 130);
  fail = false; assert(await history.more()); assert.equal(history.rows.length, 130); assert.equal(history.next, null);
});

test('new head refresh keeps all loaded rows until a complete consistent replacement range has arrived', async () => {
  let all = rows(130), revision = 1; const pending = deferred<ProfileReadPage<Row>>(); let hold = false;
  const history = new ProfilePages<Row>('epoch', async before => hold && before ? pending.promise : page(all, before, revision));
  await history.refresh(); await history.more(); const kept = structuredClone(history.rows);
  all = [...rows(3, 'new'), ...all]; revision = 2; hold = true; history.noteHead(all[0].id, all.length);
  assert(history.stale); const refreshing = history.refresh(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(history.rows, kept); assert.equal(history.refreshedRows, 50);
  hold = false; pending.resolve(page(all, all[49].id, 2)); assert(await refreshing);
  assert.equal(history.rows.length, 133); assert.equal(history.rows[0].id, all[0].id);
  assert(kept.every(old => history.rows.some(row => row.id === old.id))); assert(!history.stale);
});

test('failed refresh keeps all confirmed history and can continue its exact staged cursor', async () => {
  let all = rows(130), revision = 1, fail = false;
  const history = new ProfilePages<Row>('epoch', async before => { if (before && fail) throw Error('Offline'); return page(all, before, revision); });
  await history.refresh(); await history.more(); const kept = structuredClone(history.rows);
  all = [...rows(2, 'new'), ...all]; revision = 2; fail = true;
  assert(!await history.refresh()); assert.deepEqual(history.rows, kept); assert(history.refreshing);
  fail = false; assert(await history.refresh(undefined, true)); assert.equal(history.rows.length, 132);
});

test('a different ledger revision, duplicate page or foreign epoch never replaces the original cache', async () => {
  for (const problem of ['revision', 'duplicate', 'epoch'] as const) {
    const all = rows(120); let next = false;
    const history = new ProfilePages<Row>('epoch', async before => !next ? page(all, before) : problem === 'duplicate' ? page(all) : page(all, before, problem === 'revision' ? 2 : 1, problem === 'epoch' ? 'foreign' : 'epoch'));
    await history.refresh(); const kept = structuredClone(history.rows), cursor = history.next; next = true;
    assert(!await history.more(), problem); assert.deepEqual(history.rows, kept); assert.equal(history.next, cursor); assert(history.error);
  }
});

test('changed authority halfway through a refresh discards only staged rows and preserves the old complete range', async () => {
  let all = rows(120), revision = 1, midway = false;
  const history = new ProfilePages<Row>('epoch', async before => page(all, before, midway && before ? revision + 1 : revision));
  await history.refresh(); await history.more(); const kept = structuredClone(history.rows);
  all = [...rows(5, 'new'), ...all]; revision++; midway = true;
  assert(!await history.refresh()); assert.deepEqual(history.rows, kept); assert(!history.refreshing); assert(history.stale);
});

test('retired owner ignores a late response and never publishes another cache notification', async () => {
  const pending = deferred<ProfileReadPage<Row>>(); let updates = 0;
  const history = new ProfilePages<Row>('epoch', () => pending.promise, () => updates++);
  const loading = history.refresh(); history.retire(); const before = updates;
  pending.resolve(page(rows(50))); assert(!await loading); assert.equal(history.rows.length, 0); assert.equal(updates, before);
});

test('terminal and continuation counts must match the entire page chain before any confirmed rows change', async () => {
  for (const malformed of ['early-end', 'extra-rows', 'false-more'] as const) {
    const all = rows(75); let broken = false;
    const history = new ProfilePages<Row>('epoch', async before => {
      const result = page(all, before);
      if (broken && before) {
        if (malformed === 'early-end') result.entries = result.entries.slice(0, 20);
        if (malformed === 'extra-rows') result.entries.push(...rows(2, 'extra'));
        if (malformed === 'false-more') result.next = result.entries.at(-1)!.id;
      }
      return result;
    });
    await history.refresh(); const confirmed = structuredClone(history.rows), cursor = history.next; broken = true;
    assert(!await history.more(), malformed); assert.deepEqual(history.rows, confirmed); assert.equal(history.next, cursor);
    assert(!await history.refresh(75), malformed); assert.deepEqual(history.rows, confirmed); assert.equal(history.next, cursor);
  }
  const initial = new ProfilePages<Row>('epoch', async () => ({ ...page(rows(75)), next: null }));
  assert(!await initial.refresh()); assert(!initial.loaded); assert.equal(initial.rows.length, 0);
});

test('large retained depth uses bounded batches and truthful staged progress instead of claiming unread pages', async () => {
  const all = rows(1100); let calls = 0;
  const history = new ProfilePages<Row>('epoch', async before => { calls++; return page(all, before); });
  assert(!await history.refresh(1000)); assert.equal(calls, 8); assert.equal(history.rows.length, 0); assert.equal(history.refreshedRows, 400);
  assert(!await history.refresh(undefined, true)); assert.equal(calls, 16);
  assert(await history.refresh(undefined, true)); assert.equal(calls, 20); assert.equal(history.rows.length, 1000); assert.equal(history.total, 1100);
});

test('legacy history view converts in memory without overwriting raw source, then keeps the exact week and return', () => {
  const legacy = { format: 1, tab: 'history', focusedId: null, cadence: 'weekly', questFilter: 'completed', reviewId: null };
  const storage = new Map([['view', JSON.stringify(legacy)]]), io = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
  const original = storage.get('view'), slot = readProfileViewSlot(io, 'view');
  assert.equal(slot.value.tab, 'week'); assert.equal(slot.value.weekSection, 'history'); assert.equal(slot.value.questFilter, 'completed');
  assert.equal(storage.get('view'), original);
  const value = { ...slot.value, week: { start: '2026-10-05', timezone: 'Asia/Tokyo' }, day: '2026-10-06', historyCount: 100, historyScroll: 321 };
  writeProfileSlot(io, slot, value); assert.deepEqual(readProfileViewSlot(io, 'view').value, value);
});

test('malformed, foreign-format and mismatched day view remains readable but cannot be rewritten', () => {
  for (const value of ['{broken', JSON.stringify({ ...emptyProfileView, format: 5 }), JSON.stringify({ ...emptyProfileView, week: { start: '2026-10-05', timezone: 'UTC' }, day: '2026-10-20' })]) {
    const storage = { getItem: () => value, setItem: () => { throw Error('Must not write'); } }, slot = readProfileViewSlot(storage, 'view');
    assert(slot.invalid); assert.equal(slot.original, value); assert.throws(() => writeProfileSlot(storage, slot, emptyProfileView), /cannot be verified/);
  }
});
