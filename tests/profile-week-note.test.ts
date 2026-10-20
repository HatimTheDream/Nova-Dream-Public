import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { Store } from '../apps/service/store.js';
import { ProfileWeekNotes, weekNoteKey, weekNotePrefix } from '../apps/service/profile-week-note.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';
import { weekNoteCommandSchema, weekNoteStateSchema, weekNotesPageSchema } from '../packages/domain/profile-week-note.js';

const identity = { start: '2026-10-19', timezone: 'America/Los_Angeles' };
function fixture() {
  const parent = resolve('.tmp-qa/profile-week-note-service'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'case-')); let store = new Store(root);
  const capture = () => { const { id: _id, createdAt: _at, ...value } = store.captureBackup('note-fixture', { status: 'not-configured', notes: [] }); return value; };
  return { get store() { return store; }, get notes() { return new ProfileWeekNotes(store, () => new Date('2026-10-20T09:00:00.000Z')); }, capture,
    save(text = 'Keep this exact writing.\nSecond line.', expectedRevision = 0, week = identity) { return { requestId: randomUUID(), epoch: store.epoch, identity: week, expectedRevision, action: 'save' as const, text }; },
    restart() { store.close(); store = new Store(root); },
    close(passed: boolean) { store.close(); assert(resolve(root).startsWith(parent + sep)); if (passed) rmSync(root, { recursive: true }); else console.error('Preserved failed note fixture:', root); },
  };
}
function check(name: string, body: (f: ReturnType<typeof fixture>) => void) {
  test(name, () => { const f = fixture(); let passed = false; try { body(f); passed = true; } finally { f.close(passed); } });
}

check('missing note and empty complete index are pure reads', f => {
  const before = f.capture(); assert.deepEqual(f.notes.state(identity), { epoch: f.store.epoch, identity, note: null });
  const page = weekNotesPageSchema.parse(f.notes.index({})); assert.equal(page.total, 0); assert.deepEqual(page.rows, []); assert.equal(page.next, null); assert.deepEqual(f.capture(), before);
});
check('original save replays exactly after restart; device, text and revision conflicts retain both versions', f => {
  const input = f.save(), before = f.capture(), result = f.notes.save('device-one', input);
  assert.equal(result.note.revision, 1); assert.equal(result.note.text, input.text); assert.deepEqual(f.notes.save('device-one', input), result);
  const saved = f.capture(); f.restart(); assert.deepEqual(f.notes.save('device-one', input), result); assert.deepEqual(f.capture(), saved);
  assert.throws(() => f.notes.save('device-two', input), /different work/);
  assert.throws(() => f.notes.save('device-one', { ...input, text: 'Different input' }), /different work/);
  assert.throws(() => f.notes.save('device-two', f.save('Keep the other device writing')), /another window or device/);
  assert.deepEqual(f.capture(), saved);
  for (const key of ['entities', 'history', 'files', 'references', 'epoch', 'cursor'] as const) assert.deepEqual(saved[key], before[key]);
  assert.deepEqual(saved.services.filter(row => row.id !== weekNoteKey(identity)), before.services); assert.equal(saved.receipts.length, before.receipts.length + 1);
  assert.equal(f.notes.save('device-two', f.save('Reviewed explicit edit', 1)).note.revision, 2);
});
check('trash is reversible and preserves exact writing; stale or repeated new actions cannot rewrite state', f => {
  const saved = f.notes.save('one', f.save()).note;
  const trash = { requestId: randomUUID(), epoch: f.store.epoch, identity, expectedRevision: 1, action: 'trash' };
  const result = f.notes.save('one', trash); assert.equal(result.note.trashed, true); assert.equal(result.note.text, saved.text);
  assert.deepEqual(f.notes.save('one', trash), result); const before = f.capture();
  assert.throws(() => f.notes.save('one', f.save('No silent resurrection', 2)), /Restore/);
  assert.throws(() => f.notes.save('one', { ...trash, requestId: randomUUID(), expectedRevision: 2 }), /state changed/);
  assert.deepEqual(f.capture(), before);
  const restored = f.notes.save('two', { ...trash, requestId: randomUUID(), expectedRevision: 2, action: 'restore' });
  assert.equal(restored.note.revision, 3); assert.equal(restored.note.trashed, false); assert.equal(restored.note.text, saved.text);
  assert.equal(f.notes.index({}).rows[0].trashed, false);
});
check('week and exact timezone remain independent and all saved timezone identities stay discoverable', f => {
  const second = { ...identity, timezone: 'UTC' }, earlier = { ...identity, start: '2026-10-12' };
  for (const [i, week] of [identity, second, earlier].entries()) f.notes.save('one', f.save('Exact week ' + i, 0, week));
  assert.equal(f.notes.state(identity).note!.text, 'Exact week 0'); assert.equal(f.notes.state(second).note!.text, 'Exact week 1');
  assert.equal(f.notes.state(earlier).note!.text, 'Exact week 2'); assert.equal(f.notes.index({}).total, 3);
  assert(!weekNoteStateSchema.safeParse({ ...f.notes.state(identity), identity: second }).success);
});
check('complete paged note index refuses stale continuation and never exposes note bodies', f => {
  for (let i = 0; i < 54; i++) {
    const start = new Date(Date.parse('2025-01-06T12:00:00Z') + i * 7 * 86400000).toISOString().slice(0, 10);
    f.notes.save('one', f.save('Private body ' + i, 0, { ...identity, start }));
  }
  const before = f.capture(), first = f.notes.index({}); assert.equal(first.rows.length, 50); assert.equal(first.total, 54); assert(first.next);
  const last = f.notes.index({ before: first.next!, version: first.version }); assert.equal(last.rows.length, 4); assert.equal(last.next, null);
  assert(!JSON.stringify(first).includes('Private body')); assert.deepEqual(f.capture(), before);
  f.notes.save('two', f.save('Changed note', 1, first.rows[0].identity)); const changed = f.capture();
  assert.throws(() => f.notes.index({ before: first.next!, version: first.version }), /notes changed/); assert.deepEqual(f.capture(), changed);
  assert.throws(() => f.notes.index({ before: first.next! }));
});
check('malformed or misplaced metadata stays unchanged and cannot be overwritten as missing', f => {
  const good = { format: 1, identity, revision: 1, text: 'Preserve original', trashed: false, updatedAt: '2026-10-20T09:00:00.000Z' };
  for (const raw of [null, { ...good, format: 2 }, { ...good, revision: 0 }, { ...good, identity: { ...identity, timezone: 'UTC' } }, { ...good, unexpected: true }]) {
    f.store.internalWrite(weekNoteKey(identity), raw); const before = f.capture();
    assert.throws(() => f.notes.state(identity)); assert.throws(() => f.notes.save('one', f.save())); assert.throws(() => f.notes.index({})); assert.deepEqual(f.capture(), before);
  }
  f.store.internalWrite(weekNoteKey(identity), good); f.store.internalWrite(weekNotePrefix + 'misplaced-original', good); const before = f.capture();
  assert.throws(() => f.notes.index({}), /cannot be verified/); assert.deepEqual(f.capture(), before);
});
check('validation and foreign epoch refuse every effect before admission', f => {
  const input = f.save(), before = f.capture();
  for (const raw of [{ ...input, text: '' }, { ...input, text: '  \n' }, { ...input, text: 'x'.repeat(20001) }, { ...input, epoch: randomUUID() },
    { ...input, identity: { ...identity, start: '2026-10-20' } }, { ...input, identity: { ...identity, timezone: 'not-a-zone' } },
    { ...input, publish: true }, { ...input, action: 'delete' }, { ...input, action: 'trash' }]) assert.throws(() => f.notes.save('one', raw));
  assert.deepEqual(f.capture(), before); assert(weekNoteCommandSchema.safeParse(input).success);
});
check('maintenance and held recovery prevent writes; readable notes stay pure and activated recovery preserves effects pause', f => {
  const command = f.save(); f.store.setUpdateMaintenanceHeld(true); let before = f.capture();
  assert.throws(() => f.notes.save('one', command)); f.notes.state(identity); assert.deepEqual(f.capture(), before);
  f.store.setUpdateMaintenanceHeld(false); f.store.internalWrite('recovery:state', { held: true, effectsPaused: true }); before = f.capture();
  assert.throws(() => f.notes.save('one', command), /recovered workspace/); assert.deepEqual(f.capture(), before);
  f.store.internalWrite('recovery:state', { held: false, effectsPaused: true }); assert.equal(f.notes.save('one', command).note.revision, 1); assert(f.store.recoveryEffectsPaused);
});
check('notes remain outside workspace entity snapshots and earned progress but remain in complete recovery', f => {
  const marker = 'PRIVATE_WEEKLY_NOTE_' + randomUUID(), before = f.store.profileProgress(); f.notes.save('one', f.save(marker));
  assert(!JSON.stringify(f.store.snapshot('one')).includes(marker)); assert.deepEqual(f.store.profileProgress(), before);
  assert(JSON.stringify(f.capture().services).includes(marker)); assert.equal(f.store.listEntities('profile').some(row => JSON.stringify(row).includes(marker)), false);
});
test('phone accepts only the three authenticated note routes and no destructive or wildcard endpoint', () => {
  assert(phoneRouteAllowed('/api/profile/week/note', 'GET')); assert(phoneRouteAllowed('/api/profile/week/note', 'POST')); assert(phoneRouteAllowed('/api/profile/week/notes', 'GET'));
  for (const path of ['/api/profile/week/note/', '/api/profile/week/note/delete', '/api/profile/week/notes', '/api/profile/week/notes/all']) assert(!phoneRouteAllowed(path, 'POST'));
  assert(!phoneRouteAllowed('/api/profile/week/note', 'DELETE'));
});
