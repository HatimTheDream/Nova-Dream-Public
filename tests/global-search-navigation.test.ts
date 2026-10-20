import test from 'node:test';
import { admitInboxSearch, admittedInboxSearch } from '../apps/client/src/search-query-navigation';
import assert from 'node:assert/strict';
import type { Snapshot } from '../packages/domain/contracts';
import type { HomeLibraryState } from '../packages/domain/home-library';
import { blankRecord, recordKinds } from '../packages/domain/workspace-records';
import { admitRecordTarget, admittedRecordIndex, recordIndexKey } from '../apps/client/src/record-target-navigation';
import { admitLibraryTarget, admittedLibraryView, libraryViewKey, libraryTargetPreview, defaultLibraryView } from '../apps/client/src/home-library-navigation';
import { registerRecordDraftNavigation, mayLeaveRecordDrafts } from '../apps/client/src/record-draft-navigation';
import { unreadableNavigation } from '../apps/client/src/navigation-storage';
const scope = { epoch: '00000000-0000-4000-8000-000000000001', deviceId: 'device', windowId: 'window' };
const contact = { id: 'contact:one', revision: 4, value: { ...blankRecord('contact', 'UTC'), name: 'One' }, updatedAt: '', deviceId: scope.deviceId };
const snapshot = { ...scope, records: { contact: [contact], content: [], agent: [], assignment: [], profile: [] } } as unknown as Snapshot;
function memory() {
  const values = new Map<string, unknown>(), writes: string[] = []; let fail = false;
  return { values, writes, refuse: (value: boolean) => { fail = value; }, read: (key: string) => values.get(key), write: (key: string, value: unknown) => {
    if (fail) return false; writes.push(key); values.set(key, structuredClone(value)); return true;
  } };
}
const target = () => ({ kind: 'contact' as const, id: contact.id, nonce: 'target-one', admitted: { ...scope, revision: 4 } });

test('exact record target writes one existing index and preserves draft bytes and original pending command', () => {
  const io = memory(), index = recordIndexKey(scope.deviceId, 'contact', scope.windowId);
  const journal = `e3:journal:${scope.deviceId}:${contact.id}:${scope.windowId}`, pending = { requestId: '00000000-0000-4000-8000-000000000002', epoch: scope.epoch, expectedRevision: 4, kind: 'contact', entityId: contact.id, payload: { ...contact.value, notes: 'Newer writing' } };
  io.values.set(index, { selected: 'contact:prior', drafts: ['contact:unsaved'], editing: true });
  io.values.set(journal, { value: { ...contact.value, notes: 'Still newer writing' }, revision: 4, epoch: scope.epoch, dirty: true, pending }); const raw = structuredClone(io.values.get(journal));
  assert.equal(admitRecordTarget(snapshot, scope.windowId, target(), io), undefined);
  assert.deepEqual(io.writes, [index]); assert.deepEqual(io.values.get(journal), raw);
  assert.deepEqual(admittedRecordIndex(snapshot, scope.windowId, target(), io), { selected: contact.id, drafts: ['contact:unsaved'], editing: true, seenTarget: 'target-one', attempt: undefined });
  assert.equal(admittedRecordIndex(snapshot, 'other-window', target(), io), undefined);
});
test('record admission reuses the original journal shape for every record kind and preserves incomplete writing', () => {
  for (const kind of recordKinds) {
    const io = memory(), id = kind === 'profile' ? 'profile:owner' : `${kind}:one`, value = blankRecord(kind, 'UTC');
    const data = { ...snapshot, records: { ...snapshot.records, [kind]: [{ ...contact, id, value }] } } as Snapshot;
    const journalKey = `e3:journal:${scope.deviceId}:${id}:${scope.windowId}`;
    const journal = { value, revision: 4, epoch: scope.epoch, dirty: true };
    io.values.set(journalKey, journal);
    assert.equal(admitRecordTarget(data, scope.windowId, { ...target(), kind, id }, io), undefined);
    assert.equal(io.values.get(journalKey), journal);
    assert.equal(io.writes.length, kind === 'profile' ? 0 : 1);
  }
});
test('unreadable, malformed and wrong-command target journals refuse before any index write', () => {
  const io = memory(), key = `e3:journal:${scope.deviceId}:${contact.id}:${scope.windowId}`;
  const valid = { value: contact.value, revision: 4, epoch: scope.epoch, dirty: true };
  const command = { requestId: '00000000-0000-4000-8000-000000000002', epoch: scope.epoch, expectedRevision: 4, kind: 'contact', entityId: contact.id, payload: contact.value };
  for (const journal of [unreadableNavigation, null, [], {}, { ...valid, dirty: 'yes' }, { ...valid, value: {} },
    { ...valid, epoch: 'another-epoch' }, { ...valid, pending: { ...command, entityId: 'contact:other' } },
    { ...valid, pending: { ...command, expectedRevision: 3 } }, { ...valid, pending: { ...command, epoch: '00000000-0000-4000-8000-000000000003' } },
    { ...valid, conflict: { code: 3, message: 'Original conflict' } }]) {
    io.values.set(key, journal);
    assert.match(admitRecordTarget(snapshot, scope.windowId, target(), io)!, /preserved/);
    assert.equal(io.values.get(key), journal); assert.deepEqual(io.writes, []);
  }
  const restore = { ...target(), admitted: { ...scope, revision: 0, restore: { kind: 'contact' as const, selected: 'contact:old-draft', editing: true } } };
  io.values.set(key, valid); io.values.set(`e3:journal:${scope.deviceId}:contact:old-draft:${scope.windowId}`, unreadableNavigation);
  assert.match(admitRecordTarget(snapshot, scope.windowId, restore, io)!, /preserved/);
  assert.deepEqual(io.writes, []);
});
test('target storage refusal and changed identity never replace the previous pointer', () => {
  const io = memory(), key = recordIndexKey(scope.deviceId, 'contact', scope.windowId), prior = { selected: 'contact:prior', drafts: ['contact:unsaved'] };
  io.values.set(key, prior); io.refuse(true);
  assert.match(admitRecordTarget(snapshot, scope.windowId, target(), io)!, /storage/);
  assert.deepEqual(io.values.get(key), prior); assert.deepEqual(io.writes, []);
  io.refuse(false);
  assert.match(admitRecordTarget(snapshot, scope.windowId, { ...target(), admitted: { ...scope, revision: 3 } }, io)!, /changed/);
  assert.match(admitRecordTarget(snapshot, 'other-window', target(), io)!, /another workspace/);
  assert.deepEqual(io.writes, []);
});
test('original selection restoration preserves intervening new draft ids instead of replacing a whole old index', () => {
  const io = memory(), key = recordIndexKey(scope.deviceId, 'contact', scope.windowId);
  io.values.set(key, { selected: contact.id, drafts: ['contact:original', 'contact:created-later'], editing: false });
  const restore = { ...target(), nonce: 'return-original', admitted: { ...scope, revision: 0, restore: { kind: 'contact' as const, selected: 'contact:original', editing: true } } };
  assert.equal(admitRecordTarget(snapshot, scope.windowId, restore, io), undefined);
  assert.deepEqual(admittedRecordIndex(snapshot, scope.windowId, restore, io)?.drafts, ['contact:original', 'contact:created-later']);
  assert.equal(admittedRecordIndex(snapshot, scope.windowId, restore, io)?.selected, 'contact:original');
});
test('Library admission and exact saved preview preserve writer bytes without capture or external link reads', () => {
  const io = memory(), key = libraryViewKey(scope), writer = 'e3:home-library-writer:device:epoch:window:item';
  const writing = { id: 'note:kept', value: { title: 'New writing', body: 'Untouched' }, pending: { requestId: 'original' } };
  io.values.set(key, { ...defaultLibraryView(), query: 'Old library query' }); io.values.set(writer, writing);
  const state = { epoch: scope.epoch, collections: [{ id: 'collection:one', revision: 2, archived: true }], items: [{ id: 'link:one', kind: 'link', revision: 3, title: 'Exact link', body: 'Saved notes', url: 'https://example.test/unfetched', archived: true, updatedAt: '' }] } as HomeLibraryState;
  const request = { ...scope, nonce: 'library-target', target: { kind: 'link' as const, id: 'link:one', revision: 3 } };
  assert.equal(admitLibraryTarget(scope, state, request, io), undefined);
  assert.equal(admittedLibraryView(scope, request, io)?.query, 'Old library query');
  assert.deepEqual(io.values.get(writer), writing); assert.deepEqual(io.writes, [key]);
  assert.equal(libraryTargetPreview(state, request)?.text, 'Saved notes');
  assert.equal(libraryTargetPreview(state, { ...request, target: { ...request.target, revision: 4 } }), undefined);
  io.refuse(true); const before = structuredClone(io.values.get(key));
  assert.match(admitLibraryTarget(scope, state, { ...request, nonce: 'replacement' }, io)!, /storage/);
  assert.deepEqual(io.values.get(key), before);
});
test('mounted record owners retain in memory through failure and late old cleanup cannot remove the current owner', () => {
  let first = false, second = false, count = 0;
  const releaseFirst = registerRecordDraftNavigation(() => { count++; return first; });
  const releaseSecond = registerRecordDraftNavigation(() => second);
  try {
    assert.equal(mayLeaveRecordDrafts(), false); first = true; assert.equal(mayLeaveRecordDrafts(), false);
    releaseFirst(); releaseFirst(); assert.equal(mayLeaveRecordDrafts(), false);
    second = true; assert.equal(mayLeaveRecordDrafts(), true); assert.equal(count, 2);
  } finally { releaseFirst(); releaseSecond(); }
  assert.equal(mayLeaveRecordDrafts(), true);
});
test('Inbox query admission preserves the exact account/folder and refuses storage or window drift before opening', () => {
 const scope = { epoch: 'current', deviceId: 'device', windowId: 'search-window' };
 const key = 'e3:original-inbox:device:inbox-window:view';
 const original = { accountId: 'selected-account', folderId: 'current-folder', search: 'old query', selectedThreadId: 'thread:original' };
 const values = new Map<string, unknown>([[key, original]]); let fail = true;
 const storage = { read: (key: string) => values.get(key), write: (key: string, value: unknown) => { if (fail) return false; values.set(key, value); return true; } };
 const request = { ...scope, token: 'search', nonce: 'query-one', query: 'new query', inboxWindowId: 'inbox-window' };
 assert.match(admitInboxSearch(scope, request, storage)!, /could not be kept/); assert.equal(values.get(key), original);
 fail = false; assert.equal(admitInboxSearch(scope, request, storage), undefined);
 assert.deepEqual(values.get(key), { ...original, search: 'new query', searchNonce: 'query-one' });
 assert.equal(admittedInboxSearch(scope, 'inbox-window', request, storage), true);
 assert.equal(admittedInboxSearch(scope, 'another-window', request, storage), false);
 assert.equal(admittedInboxSearch(scope, 'inbox-window', { ...request, nonce: 'superseded' }, storage), false);
 assert.match(admitInboxSearch(scope, { ...request, epoch: 'other' }, storage)!, /another window/);
 values.set(key, 'unreadable original'); assert.match(admitInboxSearch(scope, request, storage)!, /preserved/);
});
