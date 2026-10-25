import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type Entity, type Command } from '../packages/domain/contracts';
import { blankRecord, type Content } from '../packages/domain/workspace-records';
import { ContentRecoveryJournal, contentCopyText } from '../apps/client/src/content-recovery';
import { contentRetentionLabel } from '../apps/client/src/ContentRecoveryPanel';

function fixture() {
  const scope = { epoch: randomUUID(), deviceId: randomUUID(), windowId: randomUUID(), id: 'content:recovery' };
  const before: Entity<Content> = { id: scope.id, revision: 3, deviceId: scope.deviceId, updatedAt: '2026-10-20T00:00:00.000Z',
    value: { ...blankRecord('content', 'UTC') as Content, title: 'Original Title', body: 'Original complete writing.', brief: 'Original brief.' } };
  const rows = new Map<string, string>(); let failWrite = false, failReadback = false, unreadable = false;
  const storage = { getItem: (key: string) => { if (unreadable) { unreadable = false; throw Error('Readback unavailable'); } return rows.get(key) ?? null; },
    setItem: (key: string, raw: string) => { if (failWrite) throw Error('Browser storage full'); rows.set(key, raw); if (failReadback) { failReadback = false; unreadable = true; } } };
  const journal = new ContentRecoveryJournal(storage, scope);
  const command = (revision: number, value: Content): Command => ({ requestId: randomUUID(), epoch: scope.epoch,
    kind: 'content', entityId: scope.id, expectedRevision: revision, payload: value });
  const result = (c: Command): Entity<Content> => ({ ...before, revision: c.expectedRevision + 1,
    updatedAt: '2026-10-20T01:00:00.000Z', value: c.payload as Content });
  const original = (value = before.value) => JSON.stringify({ value, revision: before.revision, epoch: scope.epoch, dirty: true });
  return { scope, before, rows, storage, journal, command, result, original,
    full: (value: boolean) => { failWrite = value; }, readbackFailure: () => { failReadback = true; } };
}
test('Remove From Draft preserves the original file identity and exact local Undo across reload',()=>{
 const f=fixture(),a={id:randomUUID(),name:'first.md',size:4,sha256:'a'.repeat(64)},b={...a,id:randomUUID(),name:'second.md',sha256:'b'.repeat(64)},c={...a,id:randomUUID(),name:'later.md',sha256:'c'.repeat(64)};
 const value={...f.before.value,assets:[a,b]},removed=f.journal.detachFile(value,a);assert.deepEqual(removed,[b]);
 const reload=new ContentRecoveryJournal(f.storage,f.scope),current={...value,assets:[b,c],body:'New writing stays'};
 assert.deepEqual(reload.fileUndoFor(current)?.file,a);assert.deepEqual(reload.undoFile(current),[a,b,c]);
 assert.equal(reload.fileUndoFor({...current,assets:[{...a,sha256:'d'.repeat(64)},b,c]}),undefined);
});
test('file detach refuses protected source, changed identity and failed recovery retention',()=>{
 const f=fixture(),file={id:randomUUID(),name:'source.md',size:4,sha256:'a'.repeat(64)};
 const value={...f.before.value,assets:[file]};
 assert.equal(f.journal.detachFile({...value,source:{fileId:file.id} as Content['source']},file),undefined);
 assert.equal(f.journal.detachFile(value,{...file,sha256:'b'.repeat(64)}),undefined);
 f.full(true);assert.equal(f.journal.detachFile(value,file),undefined);assert.deepEqual(value.assets,[file]);
 f.full(false);assert.deepEqual(f.journal.detachFile(value,file),[]);
});

test('Content comparisons keep readable full writing, incomplete titles and both immutable original versions', () => {
  const f = fixture(), mine = { ...f.before.value, title: '', body: 'Complete '.repeat(10000) };
  const saved = { ...f.before, revision: 4, value: { ...f.before.value, body: 'Latest saved body' } };
  assert(f.journal.keepComparison(f.original(mine), saved));
  const copy = f.journal.value.copies[0];
  assert.equal(JSON.parse(copy.original).value.body, mine.body);
  assert.deepEqual(copy.saved, saved);
  const reload = new ContentRecoveryJournal(f.storage, f.scope);
  assert.equal(reload.invalid, false); assert.deepEqual(reload.value.copies, [copy]);
  assert(f.journal.keepComparison(f.original(mine), saved)); assert.equal(f.journal.value.copies.length, 1);
});

test('Content recovery write/readback failures do not discard original writing and retry only exact attempted bytes', () => {
  const f = fixture(); f.full(true);
  assert.equal(f.journal.keepComparison(f.original(), f.before), false);
  assert.equal(f.rows.size, 0); assert.equal(f.journal.value.copies.length, 1);
  f.full(false); f.readbackFailure(); assert.equal(f.journal.retain(), false);
  assert(f.journal.retain());
  const kept = f.rows.get(f.journal.key)!;
  f.rows.set(f.journal.key, kept.replace('Original Title', 'Different Window'));
  assert.equal(f.journal.retain(), false); assert.match(f.rows.get(f.journal.key)!, /Different Window/);
});

test('Content recovery refuses another record/epoch, oversized input and unsupported stored formats without overwriting', () => {
  const f = fixture();
  assert.equal(f.journal.keepComparison(f.original(), { ...f.before, id: 'content:other' }), false);
  assert.equal(f.journal.keepComparison(f.original().replace(f.scope.epoch, randomUUID()), f.before), false);
  assert.equal(f.journal.keepComparison('x'.repeat(512001), f.before), false);
  assert.equal(f.rows.size, 0);
  f.rows.set(f.journal.key, '{"format":999,"original":"keep"}');
  const reload = new ContentRecoveryJournal(f.storage, f.scope); assert(reload.invalid); assert.equal(reload.retain(), false);
  assert.equal(f.rows.get(f.journal.key), '{"format":999,"original":"keep"}');
});

test('Content comparison retention is bounded and never evicts an earlier original', () => {
  const f = fixture();
  for (let i = 0; i < 16; i++) assert(f.journal.keepComparison(f.original({ ...f.before.value, body: 'Version ' + i }), f.before));
  const original = f.rows.get(f.journal.key);
  assert.equal(f.journal.keepComparison(f.original({ ...f.before.value, body: 'One more' }), f.before), false);
  assert.equal(f.rows.get(f.journal.key), original); assert.equal(f.journal.value.copies.length, 16);
});

test('Archive Undo requires the exact confirmed revision and survives a reload', () => {
  const f = fixture(); assert(f.journal.beginArchive(f.before, f.before.value));
  const c = f.command(3, { ...f.before.value, archived: true }), archived = f.result(c);
  assert.equal(f.journal.undoFor(archived), undefined, 'A prepared archive is not a confirmation');
  assert(f.journal.acknowledge(c, archived));
  const reload = new ContentRecoveryJournal(f.storage, f.scope); assert.equal(reload.invalid, false);
  assert(reload.undoFor(archived));
  assert.equal(reload.undoFor({ ...archived, revision: archived.revision + 1 }), undefined);
  assert.equal(reload.undoFor({ ...archived, value: { ...archived.value, title: 'Later Title' } }), undefined);
  const inverse = reload.beginUndo(archived); assert.deepEqual(inverse, f.before.value);
  const undo = f.command(4, inverse!); assert(reload.acknowledge(undo, f.result(undo)));
  assert.equal(reload.undoFor(archived), undefined); assert.equal(reload.value.archives[0].undo!.command.requestId, undo.requestId);
});

test('Wrong archive acknowledgements never authorize Undo and ordinary Content saves remain unrelated', () => {
  const f = fixture(); assert(f.journal.beginArchive(f.before, f.before.value));
  const c = f.command(3, { ...f.before.value, archived: true }), result = f.result(c);
  for (const bad of [{ ...result, id: 'content:foreign' }, { ...result, revision: 8 },
    { ...result, deviceId: randomUUID() }, { ...result, value: { ...result.value, body: 'Wrong content' } }])
    assert.equal(f.journal.acknowledge(c, bad), false);
  assert.equal(f.journal.undoFor(result), undefined);
  const ordinary = f.command(3, { ...f.before.value, body: 'Normal edit' });
  assert.equal(f.journal.acknowledge(ordinary, f.result(ordinary)), false);
  assert(f.journal.acknowledge(c, result));
  assert.equal(f.journal.acknowledge({ ...c, requestId: randomUUID() }, result), false);
});

test('Archive and Undo intent must be retained before their matching payload becomes eligible', () => {
  const f = fixture(); f.full(true);
  assert.equal(f.journal.beginArchive(f.before, f.before.value), false);
  assert.equal(f.journal.canContinueArchive({ ...f.before.value, archived: true }, 3), false);
  f.full(false); assert(f.journal.retain());
  assert(f.journal.canContinueArchive({ ...f.before.value, archived: true }, 3));
  const c = f.command(3, { ...f.before.value, archived: true }), archived = f.result(c);
  f.journal.acknowledge(c, archived); f.full(true);
  assert.equal(f.journal.beginUndo(archived), undefined); assert.equal(f.journal.undoFor(archived), undefined);
  f.full(false); assert(f.journal.retain()); assert.deepEqual(f.journal.beginUndo(archived), f.before.value);
});

test('Forged stored Undo without original archive confirmation remains untouched and unusable', () => {
  const f = fixture(); f.journal.beginArchive(f.before, f.before.value);
  const c = f.command(4, f.before.value);
  const record = JSON.parse(f.rows.get(f.journal.key)!);
  record.archives[0].undoRequested = true; record.archives[0].undo = { command: c, result: f.result(c) };
  const raw = JSON.stringify(record); f.rows.set(f.journal.key, raw);
  const reload = new ContentRecoveryJournal(f.storage, f.scope);
  assert(reload.invalid); assert.equal(reload.retain(), false); assert.equal(f.rows.get(f.journal.key), raw);
});

test('Content copy-out retains complete title, body and brief without preview truncation', () => {
  const f = fixture(), value = { ...f.before.value, body: 'A'.repeat(100000) };
  const copied = contentCopyText(value);
  assert(copied.startsWith(value.title + '\n\n')); assert(copied.includes(value.body)); assert(copied.endsWith(value.brief));
});

test('Content retention labels keep unknown saves and window-only storage distinct from saved versions', () => {
  const state = { saving: false, dirty: false, storageError: false, revision: 3 };
  assert.equal(contentRetentionLabel(state), 'Saved Version 3');
  assert.equal(contentRetentionLabel({ ...state, dirty: true }), 'Changes Kept On This Device');
  assert.equal(contentRetentionLabel({ ...state, pending: {} }), 'Save Unconfirmed');
  assert.equal(contentRetentionLabel({ ...state, saving: true, pending: {} }), 'Saving');
  assert.equal(contentRetentionLabel({ ...state, storageError: true, pending: {} }), 'Kept In This Window');
});
