import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WeekNoteDraft, confirmedWeekNote, parseWeekNoteDraftKey, readWeekNoteJournal, weekNoteDraftKey } from '../apps/client/src/profile-week-note-client';
import { discoverWeekNoteWriting, recoverWeekNoteWriting } from '../apps/client/src/profile-week-note-recovery';
import { WeekNotePages } from '../apps/client/src/profile-week-note-pages';
import { weekNoteIdentityKey, type WeekNote, type WeekNoteCommand, type WeekNoteReceipt } from '../packages/domain/profile-week-note';

const epoch = randomUUID(), deviceId = randomUUID(), windowId = randomUUID(), identity = { start: '2026-10-19', timezone: 'America/Los_Angeles' };
class Memory {
  values = new Map<string, string>(); writes = 0; failWrite = false; failRead = false; failReadback = false; nextRead = false;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { if (this.failRead || this.nextRead) { this.nextRead = false; throw Error('Storage denied'); } return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrite) throw Error('Storage full'); this.values.set(key, value); this.writes++; if (this.failReadback) { this.failReadback = false; this.nextRead = true; } }
}
const saved = (text = 'Original saved writing', revision = 1, trashed = false): WeekNote =>
  ({ format: 1, identity, revision, text, trashed, updatedAt: '2026-10-20T09:00:00.000Z' });
const receipt = (command: WeekNoteCommand, base: WeekNote | null): WeekNoteReceipt => ({
  requestId: command.requestId, epoch: command.epoch, action: command.action,
  note: { format: 1, identity: command.identity, revision: command.expectedRevision + 1,
    text: command.action === 'save' ? command.text : base!.text, trashed: command.action === 'trash', updatedAt: '2026-10-20T09:01:00.000Z' },
});
function fixture(base: WeekNote | null = null, post?: (command: WeekNoteCommand) => Promise<unknown>) {
  const storage = new Memory(), key = weekNoteDraftKey(deviceId, windowId, identity), calls: WeekNoteCommand[] = [];
  let owns = true;
  const send = async (command: WeekNoteCommand) => { calls.push(structuredClone(command)); return post ? post(command) : receipt(command, base); };
  const draft = new WeekNoteDraft(storage, key, { epoch, deviceId, windowId, identity }, { epoch, identity, note: base }, send, () => {}, () => owns);
  return { draft, storage, key, calls, retireOwner() { owns = false; }, send };
}

test('review adoption cannot move behind a confirmed version or replace equal-revision content', () => {
  const f = fixture(saved()); f.draft.change('My unfinished writing');
  const reviewed = { epoch, identity, note: saved('Old review', 2) };
  assert.equal(f.draft.observe(reviewed), true);
  assert.equal(f.draft.observe({ epoch, identity, note: saved('New confirmed note', 3) }), true);
  const original = f.storage.getItem(f.key);
  assert.equal(f.draft.acceptReviewed(reviewed, false), false);
  assert.equal(f.draft.acceptReviewed({ epoch, identity, note: saved('Different version three', 3) }, false), false);
  assert.equal(f.draft.journal.text, 'My unfinished writing'); assert.equal(f.storage.getItem(f.key), original);
  assert.equal(f.draft.currentState.note?.text, 'New confirmed note'); assert.equal(f.calls.length, 0);
  assert.equal(f.draft.acceptReviewed({ epoch, identity, note: saved('New confirmed note', 3) }, false), true);
  assert.equal(f.draft.journal.text, 'New confirmed note'); assert.equal(f.draft.journal.dirty, false);
});

test('exact save keeps writing and acknowledges only its original reply', async () => {
  const f = fixture(); f.draft.change('Keep exactly\n  this writing.');
  const result = await f.draft.send('save'); assert(result); assert.equal(result.note.text, 'Keep exactly\n  this writing.');
  assert.equal(f.calls.length, 1); assert.equal(f.draft.journal.base?.revision, 1); assert.equal(f.draft.journal.dirty, false);
  assert.equal(f.draft.journal.pending, undefined); assert(f.draft.kept); await f.draft.send('save'); assert.equal(f.calls.length, 1);
});
test('failed writing stays in memory, blocks retention and sends nothing until confirmed', async () => {
  const f = fixture(); f.storage.failWrite = true;
  assert.equal(f.draft.change('Memory is the current writing'), false); assert.equal(f.draft.journal.text, 'Memory is the current writing');
  assert.equal(f.draft.retain(), false); await f.draft.send('save'); assert.equal(f.calls.length, 0);
  const original = structuredClone(f.draft.journal.pending); f.storage.failWrite = false;
  await f.draft.send('save'); assert.deepEqual(f.calls[0], original); assert.equal(f.calls.length, 1);
});
test('unknown reply and remount reconcile only the exact original command', async () => {
  const f = fixture(null, async () => { throw Error('Connection lost'); }); f.draft.change('An original request');
  await f.draft.send('save'); const original = structuredClone(f.draft.journal.pending); assert(original);
  assert.equal(f.draft.change('Cannot replace pending text'), false);
  const calls: WeekNoteCommand[] = [];
  const next = new WeekNoteDraft(f.storage, f.key, { epoch, deviceId, windowId, identity }, { epoch, identity, note: null },
    async command => { calls.push(command); return receipt(command, null); });
  await next.send('trash'); assert.deepEqual(calls, [original]); assert.equal(next.journal.text, 'An original request');
});
test('known success with failed storage readback never repeats the host request', async () => {
  const f = fixture(null, async command => { f.storage.failReadback = true; return receipt(command, null); });
  f.draft.change('Saved once'); assert.equal(await f.draft.send('save'), undefined);
  assert.equal(f.calls.length, 1); assert(f.draft.journal.pending);
  assert(await f.draft.send('save')); assert.equal(f.calls.length, 1); assert.equal(f.draft.journal.pending, undefined);
});
test('auth, maintenance and held-recovery failures are not proof of an original refusal', async () => {
  for (const code of ['unauthorized', 'update_in_progress', 'recovery_held']) {
    const f = fixture(null, async () => { throw Object.assign(Error(code), { code, status: 409 }); });
    f.draft.change('Keep the original'); await f.draft.send('save');
    assert(f.draft.journal.pending); assert.equal(f.draft.journal.rejection, undefined);
    assert.equal(f.draft.acceptReviewed({ epoch, identity, note: null }), false);
  }
});
test('known note conflict requires explicit current-version review without changing text', async () => {
  const f = fixture(saved(), async () => { throw Object.assign(Error('Another note version'), { code: 'week_note_changed', status: 409 }); });
  f.draft.change('My edits'); await f.draft.send('save'); const pending = f.draft.journal.pending;
  assert(pending); assert(f.draft.journal.rejection); await f.draft.send('save'); assert.equal(f.calls.length, 1);
  assert.equal(f.draft.acceptReviewed({ epoch: randomUUID(), identity, note: saved('Other', 2) }), false);
  assert.deepEqual(f.draft.journal.pending, pending);
  assert(f.draft.acceptReviewed({ epoch, identity, note: saved('Other', 2) }));
  assert.equal(f.draft.journal.text, 'My edits'); assert.equal(f.draft.journal.base?.revision, 2); assert.equal(f.draft.journal.pending, undefined);
});
test('Trash preserves saved text; Restore preserves kept edits until a separate Save', async () => {
  const f = fixture(saved()); const trash = await f.draft.send('trash'); assert(trash?.note.trashed);
  assert.equal(f.draft.journal.text, 'Original saved writing'); assert.equal(f.draft.change('Cannot edit in Trash'), false);
  const g = fixture(saved('Earlier writing'));
  g.draft.change('My unsaved text'); assert(g.draft.acceptReviewed({ epoch, identity, note: saved('Saved on another device', 2, true) }));
  const h = new WeekNoteDraft(g.storage, g.key, { epoch, deviceId, windowId, identity }, { epoch, identity, note: saved('Saved on another device', 2, true) },
    async command => receipt(command, saved('Saved on another device', 2, true)));
  const restored = await h.send('restore'); assert(restored); assert.equal(restored.note.text, 'Saved on another device');
  assert.equal(h.journal.text, 'My unsaved text'); assert(h.journal.dirty); assert.equal(h.journal.base?.trashed, false);
});
test('a dirty saved note cannot be trashed or silently overwritten by a newer saved version', async () => {
  const f = fixture(saved()); f.draft.change('Unsaved'); await f.draft.send('trash'); assert.equal(f.calls.length, 0);
  assert(f.draft.observe({ epoch, identity, note: saved('New host writing', 2) })); assert(f.draft.changed);
  await f.draft.send('save'); assert.equal(f.calls.length, 0); assert.equal(f.draft.journal.text, 'Unsaved');
  assert.equal(f.draft.observe({ epoch, identity, note: saved() }), false);
  assert.equal(f.draft.observe({ epoch, identity, note: saved('Corrupt same revision', 2) }), false);
});
test('late original receipt cannot replace a newer confirmed version', async () => {
  let finish!: (value: unknown) => void; const f = fixture(null, () => new Promise(resolve => { finish = resolve; }));
  f.draft.change('Original'); const pending = f.draft.send('save');
  f.draft.observe({ epoch, identity, note: saved('Later device version', 2) });
  finish(receipt(f.calls[0], null)); await pending;
  assert.equal(f.draft.currentState.note?.revision, 2); assert.equal(f.draft.journal.base?.revision, 1); assert(f.draft.changed);
});
test('retired or changed owner cannot acknowledge late responses or alter storage', async () => {
  for (const changeOwner of [false, true]) {
    let finish!: (value: unknown) => void; const f = fixture(null, () => new Promise(resolve => { finish = resolve; }));
    f.draft.change('Original'); const pending = f.draft.send('save'), raw = f.storage.getItem(f.key);
    if (changeOwner) f.retireOwner(); else f.draft.retire();
    finish(receipt(f.calls[0], null)); await pending;
    assert.equal(f.storage.getItem(f.key), raw); assert(f.draft.journal.pending);
  }
});
test('reply epoch, request, action, week, revision, text and Trash state must match exactly', () => {
  const command: WeekNoteCommand = { requestId: randomUUID(), epoch, identity, expectedRevision: 0, action: 'save', text: 'Exact' };
  const good = receipt(command, null);
  for (const bad of [{ ...good, requestId: randomUUID() }, { ...good, epoch: randomUUID() }, { ...good, action: 'restore' },
    { ...good, note: { ...good.note, identity: { ...identity, timezone: 'UTC' } } }, { ...good, note: { ...good.note, revision: 2 } },
    { ...good, note: { ...good.note, text: 'Different' } }, { ...good, note: { ...good.note, trashed: true } }]) assert.throws(() => confirmedWeekNote(command, null, bad));
});
test('raw CAS refuses concurrent writes but keeps current typing', () => {
  const f = fixture(); f.draft.change('First'); const other = JSON.stringify({ ...f.draft.journal, text: 'Other window' });
  f.storage.values.set(f.key, other); assert.equal(f.draft.change('My newest writing'), false);
  assert.equal(f.draft.journal.text, 'My newest writing'); assert.equal(f.storage.getItem(f.key), other); assert.equal(f.draft.retain(), false);
});
test('unknown and foreign-epoch journals stay readonly with original bytes intact', async () => {
  for (const original of ['{broken', JSON.stringify({ format: 2 }), JSON.stringify({ format: 1, epoch: randomUUID(), identity, base: null, text: 'Old workspace', dirty: true })]) {
    const f = fixture(); f.storage.values.set(f.key, original);
    const next = new WeekNoteDraft(f.storage, f.key, { epoch, deviceId, windowId, identity }, { epoch, identity, note: null }, f.send);
    assert(next.blocked); assert.equal(next.change('No overwrite'), false); await next.send('save');
    assert.equal(f.storage.getItem(f.key), original); assert.equal(f.calls.length, 0);
  }
});
test('recovery preserves original pending bytes and same-window opening writes nothing', async () => {
  const f = fixture(null, async () => { throw Error('Lost'); }); f.draft.change('Keep across windows'); await f.draft.send('save');
  const found = discoverWeekNoteWriting(f.storage, deviceId, epoch, windowId); assert.equal(found.entries.length, 1);
  const entry = found.entries[0], original = f.storage.getItem(f.key), writes = f.storage.writes;
  assert.equal(recoverWeekNoteWriting(f.storage, entry, deviceId, epoch, windowId).copied, false); assert.equal(f.storage.writes, writes);
  const another = randomUUID(), result = recoverWeekNoteWriting(f.storage, entry, deviceId, epoch, another);
  assert(result.copied); assert.equal(f.storage.getItem(result.key), original); assert.equal(f.storage.getItem(f.key), original);
  assert.deepEqual(readWeekNoteJournal(f.storage.getItem(result.key)!)?.pending, f.draft.journal.pending);
});
test('occupied destination, changed source, failed writing and foreign device recovery all refuse', () => {
  const f = fixture(); f.draft.change('Original');
  const entry = discoverWeekNoteWriting(f.storage, deviceId, epoch, windowId).entries[0], another = randomUUID(), target = weekNoteDraftKey(deviceId, another, identity);
  for (const value of ['Unverified original', JSON.stringify({ ...f.draft.journal, text: 'Destination' })]) {
    f.storage.values.set(target, value); assert.throws(() => recoverWeekNoteWriting(f.storage, entry, deviceId, epoch, another)); assert.equal(f.storage.getItem(target), value);
  }
  f.storage.values.delete(target); assert.throws(() => recoverWeekNoteWriting(f.storage, entry, randomUUID(), epoch, another));
  f.storage.failWrite = true; assert.throws(() => recoverWeekNoteWriting(f.storage, entry, deviceId, epoch, another)); f.storage.failWrite = false;
  f.storage.values.set(f.key, JSON.stringify({ ...f.draft.journal, text: 'New original' }));
  assert.throws(() => recoverWeekNoteWriting(f.storage, entry, deviceId, epoch, another)); assert.equal(f.storage.getItem(target), null);
});
test('discovery is bounded, same-device only and keeps malformed/foreign originals visible', () => {
  const f = fixture(); f.draft.change('Current');
  const foreign = weekNoteDraftKey(deviceId, randomUUID(), identity);
  f.storage.values.set(foreign, JSON.stringify({ ...f.draft.journal, epoch: randomUUID() }));
  const broken = weekNoteDraftKey(deviceId, randomUUID(), identity); f.storage.values.set(broken, '{broken');
  f.storage.values.set(weekNoteDraftKey(randomUUID(), randomUUID(), identity), 'Foreign device');
  f.storage.values.set('unrelated-private-storage', 'Never inspect');
  const result = discoverWeekNoteWriting(f.storage, deviceId, epoch, windowId); assert.equal(result.entries.length, 3);
  assert.equal(result.entries.filter(row => row.unavailable).length, 2); assert.equal(f.storage.getItem(broken), '{broken');
  assert.equal(parseWeekNoteDraftKey(f.key)?.identity.timezone, identity.timezone);
  assert.equal(parseWeekNoteDraftKey(f.key + ':extra'), undefined);
  f.storage.failRead = true; assert(discoverWeekNoteWriting(f.storage, deviceId, epoch, windowId).error);
});
test('saved-note pagination covers more than100 identities and refuses stale/duplicate/foreign pages', async () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({ identity: { ...identity, start: new Date(Date.parse('2024-01-01T12:00:00Z') + index * 7 * 86400000).toISOString().slice(0, 10) },
    revision: 1, trashed: false, updatedAt: '2026-10-20T09:00:00.000Z' }));
  let wrong = '', calls = 0; const version = 'a'.repeat(64);
  const pages = new WeekNotePages(epoch, async before => {
    calls++; const start = before ? rows.findIndex(row => weekNoteIdentityKey(row.identity) === before) + 1 : 0;
    const selected = rows.slice(start, start + 50);
    return { epoch: wrong === 'epoch' ? randomUUID() : epoch, version: wrong === 'version' ? 'b'.repeat(64) : version,
      rows: wrong === 'duplicate' ? rows.slice(0, 50) : selected, total: rows.length,
      next: start + selected.length < rows.length ? weekNoteIdentityKey(selected.at(-1)!.identity) : null };
  });
  assert(await pages.refresh()); assert.equal(pages.rows.length, 50); assert.equal(calls, 1);
  for (const reason of ['version', 'epoch', 'duplicate']) { wrong = reason; assert.equal(await pages.more(), false); assert.equal(pages.rows.length, 50); }
  wrong = ''; assert(await pages.more()); assert(await pages.more()); assert.equal(pages.rows.length, 120); assert.equal(pages.next, null);
});
test('single-flight and retired page responses preserve the original list', async () => {
  let finish!: (value: unknown) => void, calls = 0;
  const pages = new WeekNotePages(epoch, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = pages.refresh(); assert.equal(await pages.refresh(), false); assert.equal(calls, 1); pages.retire();
  finish({ epoch, version: 'a'.repeat(64), rows: [], total: 0, next: null }); await pending;
  assert.equal(pages.loaded, false); assert.deepEqual(pages.rows, []);
});
