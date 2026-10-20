import test from 'node:test';
import assert from 'node:assert/strict';
import { blankRecord, type Contact, type Content } from '../packages/domain/workspace-records';
import { checkKeptCopy, copyRecordDraft, currentRecordDraftTitle, discoverRecordDrafts, recordJournalKey, type RecoveryScope, type RecoveryStorage } from '../apps/client/src/record-draft-recovery';

const epoch = '00000000-0000-4000-8000-000000000001', requestId = '00000000-0000-4000-8000-000000000002';
class Memory implements RecoveryStorage {
  data = new Map<string, string>(); reads: string[] = []; writes: string[] = []; fail = false;
  get length() { return this.data.size; }
  key(n: number) { return [...this.data.keys()][n] ?? null; }
  getItem(key: string) { this.reads.push(key); return this.data.get(key) ?? null; }
  setItem(key: string, raw: string) { if (this.fail) throw Error('Storage refused'); this.writes.push(key); this.data.set(key, raw); }
}
function setup(kind: 'contact' | 'content' = 'contact', revision = 0) {
  const storage = new Memory(), id = `${kind}:original`, scope: RecoveryScope = { kind, deviceId: 'device', windowId: 'current', epoch, records: [] };
  const value = { ...blankRecord(kind, 'UTC'), ...(kind === 'contact' ? { name: 'Original person', notes: 'Keep every note.' } : { title: 'Original article', body: 'First paragraph.\n\nSecond paragraph.' }) } as Contact | Content;
  const sourceKey = recordJournalKey({ ...scope, windowId: 'older' }, id), targetKey = recordJournalKey(scope, id);
  const kept = { value, revision, epoch, dirty: true };
  storage.data.set(sourceKey, JSON.stringify(kept));
  const select = () => discoverRecordDrafts(storage, scope).entries.find(e => e.key === sourceKey)!;
  return { storage, scope, value, sourceKey, targetKey, kept, id, select };
}
test('discovery reads only intended same-device record journals and preserves incomplete writing', () => {
  const f = setup();
  f.storage.data.set(f.sourceKey, JSON.stringify({ ...f.kept, value: { ...f.value, name: '', email: 'unfinished@', notes: 'まだ書いています' } }));
  for (const key of ['credentials:secret', 'e3:journal:other:contact:original:older', 'e3:journal:device:layout:older', 'e3:journal:device:draft:original:older']) f.storage.data.set(key, 'private-unrelated');
  const result = discoverRecordDrafts(f.storage, f.scope);
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].title, 'Untitled contact'); assert.equal(result.entries[0].preview, 'まだ書いています'); assert.equal(result.entries[0].problem, undefined);
  assert.deepEqual(f.storage.reads, [f.sourceKey]); assert.equal(f.storage.writes.length, 0);
});
test('explicit copy preserves exact source bytes, original unsaved ID and every field', () => {
  const f = setup('content'); const selected = f.select(), before = f.storage.data.get(f.sourceKey);
  const copied = copyRecordDraft(f.storage, selected, f.scope);
  assert.equal(copied.id, f.id); assert.equal(f.storage.data.get(f.targetKey), before); assert.equal(f.storage.data.get(f.sourceKey), before);
  assert.equal(currentRecordDraftTitle(f.storage, f.scope, f.id), 'Original article'); checkKeptCopy(f.storage, copied, f.scope);
});
test('original pending request is copied unchanged even when its lost acknowledgement already advanced the host', () => {
  const f = setup('contact', 3);
  const pending = { kind: 'contact', entityId: f.id, requestId, epoch, expectedRevision: 3, payload: f.value };
  f.storage.data.set(f.sourceKey, JSON.stringify({ ...f.kept, pending }));
  f.scope.records = [{ id: f.id, value: f.value, revision: 4, updatedAt: '2026-10-20T00:00:00Z', deviceId: 'device' }];
  const copied = copyRecordDraft(f.storage, f.select(), f.scope);
  assert.deepEqual(JSON.parse(copied.raw).pending, pending); assert.equal(JSON.parse(copied.raw).revision, 3); assert.equal(f.storage.writes.length, 1);
});
test('a changed source or wrong scope cannot be copied from an old preview', () => {
  const f = setup(), selected = f.select();
  f.storage.data.set(f.sourceKey, JSON.stringify({ ...f.kept, value: { ...f.value, notes: 'Later other-window writing' } }));
  assert.throws(() => copyRecordDraft(f.storage, selected, f.scope), /source writing changed/);
  assert.throws(() => copyRecordDraft(f.storage, f.select(), { ...f.scope, deviceId: 'foreign' }), /unavailable/);
  assert.equal(f.storage.writes.length, 0);
});
test('dirty, pending, conflict and malformed destination branches remain authoritative', () => {
  const f = setup(), selected = f.select();
  const pending = { kind: 'contact', entityId: f.id, requestId, epoch, expectedRevision: 0, payload: f.value };
  for (const raw of [JSON.stringify(f.kept), JSON.stringify({ ...f.kept, pending }), JSON.stringify({ ...f.kept, dirty: false, conflict: { code: 'local_editor', message: 'Keep this branch' } }), '{unfinished']) {
    f.storage.data.set(f.targetKey, raw);
    assert.throws(() => copyRecordDraft(f.storage, selected, f.scope), /already has writing/); assert.equal(f.storage.data.get(f.targetKey), raw);
  }
  assert.equal(f.storage.writes.length, 0);
});
test('storage refusal changes neither source nor destination', () => {
  const f = setup(), selected = f.select(); const before = [...f.storage.data]; f.storage.fail = true;
  assert.throws(() => copyRecordDraft(f.storage, selected, f.scope), /Storage refused/); assert.deepEqual([...f.storage.data], before);
});
test('copied-but-unopened branch can reopen without another write and refuses later destination edits', () => {
  const f = setup(); const copied = copyRecordDraft(f.storage, f.select(), f.scope);
  f.storage.data.set(f.sourceKey, JSON.stringify({ ...f.kept, value: { ...f.value, notes: 'Source continues independently' } }));
  checkKeptCopy(f.storage, copied, f.scope); assert.equal(f.storage.writes.length, 1);
  const current = discoverRecordDrafts(f.storage, f.scope).entries.find(e => e.key === f.targetKey)!;
  assert.deepEqual(copyRecordDraft(f.storage, current, f.scope), copied); assert.equal(f.storage.writes.length, 1);
  f.storage.data.set(f.targetKey, JSON.stringify({ ...f.kept, value: { ...f.value, notes: 'Current branch continues' } }));
  assert.throws(() => checkKeptCopy(f.storage, copied, f.scope), /kept writing changed/);
});
test('old epoch, removed, merged and changed saved records stay visible but blocked', () => {
  const f = setup('contact', 2);
  assert.match(f.select().problem!, /unavailable/);
  f.scope.records = [{ id: f.id, revision: 3, value: f.value, updatedAt: '', deviceId: 'device' }];
  assert.match(f.select().problem!, /saved record changed/);
  f.scope.records = [{ ...f.scope.records[0], revision: 2, value: { ...f.value, mergedInto: 'contact:survivor' } as Contact }];
  assert.match(f.select().problem!, /combined/);
  f.storage.data.set(f.sourceKey, JSON.stringify({ ...f.kept, epoch: 'old-epoch' }));
  assert.match(f.select().problem!, /earlier workspace/); assert.equal(f.storage.writes.length, 0);
});
test('malformed retained data and mismatched pending identities are visible without effects', () => {
  const f = setup(); const pending = { kind: 'contact', entityId: f.id, requestId, epoch, expectedRevision: 0, payload: f.value };
  for (const raw of ['{broken', JSON.stringify({ ...f.kept, value: { ...f.value, notes: ['wrong type'] } }), ...[{ entityId: 'contact:other' }, { epoch: '00000000-0000-4000-8000-000000000003' }, { expectedRevision: 1 }, { kind: 'content' }].map(patch => JSON.stringify({ ...f.kept, pending: { ...pending, ...patch } }))]) {
    f.storage.data.set(f.sourceKey, raw); const item = f.select(); assert.match(item.problem!, /malformed|unsupported/);
    assert.throws(() => copyRecordDraft(f.storage, item, f.scope), /malformed|unsupported/); assert.equal(f.storage.data.get(f.sourceKey), raw);
  }
  assert.equal(f.storage.writes.length, 0);
});
test('scan limits are explicit and do not read credential or later unsupported keys', () => {
  const f = setup(); f.storage.data.clear();
  for (let i = 0; i < 4100; i++) f.storage.data.set(`credential:${i}`, 'never read');
  f.storage.data.set(f.sourceKey, JSON.stringify(f.kept));
  const list = discoverRecordDrafts(f.storage, f.scope); assert.match(list.notice, /part/); assert.equal(list.entries.length, 0); assert.equal(f.storage.reads.length, 0); assert.equal(f.storage.writes.length, 0);
});
