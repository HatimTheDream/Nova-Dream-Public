import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { changeGroup, type GroupBundle } from '../packages/domain/assistant-groups';
import { GroupReader } from '../apps/client/src/assistant-group-reader';
import { readGroupView, keepGroupView } from '../apps/client/src/assistant-group-view';

function fixture() {
  const epoch = randomUUID(), deviceId = randomUUID(), groupId = randomUUID();
  const bundle: GroupBundle = { group: null, members: [], events: [] };
  for (let index = 0; index < 3; index++) {
    const common = { epoch, groupId, requestId: randomUUID(), expectedRevision: index };
    const event = changeGroup(bundle, index === 0 ? { ...common, expectedRevision: 0, action: 'create', title: 'Planning',
      projectId: null, members: [], defaultAgentId: null, shareEarlierHistory: false } : { ...common, action: 'rename', title: `Planning ${index}` },
    { eventId: randomUUID(), at: '2026-10-20T12:00:00.000Z', deviceId, addedMembers: [],
      actor: { profileId: 'profile:owner', revision: 0, name: 'You' } });
    bundle.group = event.after; bundle.events.push(event);
  }
  let current = true;
  const reader = new GroupReader(epoch, groupId, () => current);
  const detail = { epoch, view: 'group', group: bundle.group, members: [], historicalMembershipCount: 0 };
  const page = (after: number, length: number) => ({ epoch, view: 'history', groupId, revision: 3,
    events: bundle.events.slice(after, after + length), total: 3, next: after + length < 3 ? after + length : null });
  return { epoch, deviceId, groupId, reader, detail, page, retire: () => { current = false; } };
}

test('current Group reader preserves previous detail through wrong scope and late original responses', async () => {
  const f = fixture();
  assert.equal(await f.reader.load(async () => f.detail), true);
  const original = structuredClone(f.reader.detail);
  assert.equal(await f.reader.load(async () => ({ ...f.detail, epoch: randomUUID() })), false);
  assert.deepEqual(f.reader.detail, original);
  let complete!: (value: unknown) => void;
  const pending = f.reader.load(() => new Promise(resolve => { complete = resolve; }));
  f.retire(); complete({ ...f.detail, group: { ...f.detail.group, title: 'Late Reply' } });
  assert.equal(await pending, false); assert.deepEqual(f.reader.detail, original);
});

test('history keeps complete original pages and refuses gaps or replaced revisions without clearing them', async () => {
  const f = fixture(), urls: string[] = [];
  await f.reader.load(async () => f.detail);
  assert.equal(await f.reader.history(async url => { urls.push(url); return f.page(0, 2); }), true);
  const original = structuredClone(f.reader.events);
  assert.equal(await f.reader.history(async () => f.page(1, 1), true), false);
  assert.deepEqual(f.reader.events, original);
  assert.equal(await f.reader.history(async () => ({ ...f.page(2, 1), revision: 4, total: 4 }), true), false);
  assert.deepEqual(f.reader.events, original);
  assert.equal(await f.reader.history(async url => { urls.push(url); return f.page(2, 1); }, true), true);
  assert.equal(f.reader.events.length, 3); assert.equal(f.reader.next, null);
  assert.ok(urls[0].endsWith('revision=3&after=0')); assert.ok(urls[1].endsWith('revision=3&after=2'));
});

test('invalidated original read cannot replace a newer explicit read or clear its loading state', async () => {
  const f = fixture(); let old!: (value: unknown) => void, fresh!: (value: unknown) => void;
  const first = f.reader.load(() => new Promise(resolve => { old = resolve; }));
  f.reader.invalidate();
  const second = f.reader.load(() => new Promise(resolve => { fresh = resolve; }));
  old(f.detail); assert.equal(await first, false); assert.equal(f.reader.busy, true);
  fresh(f.detail); assert.equal(await second, true); assert.equal(f.reader.busy, false);
});

test('kept Group navigation isolates original drafts and refuses a competing view or failed readback', () => {
  const scope = { epoch: randomUUID(), deviceId: randomUUID(), windowId: randomUUID(), originDraftId: 'draft:original' };
  const data = new Map<string, string>(); let drop = false;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, raw: string) => { if (!drop) data.set(key, raw); } };
  const owner = readGroupView(scope, storage), target = { kind: 'create' as const, groupId: randomUUID() };
  drop = true; assert.throws(() => keepGroupView(owner, target, storage), /could not be kept/);
  assert.equal(readGroupView(scope, storage).view.target, null);
  drop = false; const saved = keepGroupView(owner, target, storage);
  assert.deepEqual(readGroupView(scope, storage).view.target, target);
  assert.equal(readGroupView({ ...scope, originDraftId: 'draft:other' }, storage).view.target, null);
  assert.throws(() => keepGroupView(owner, null, storage), /changed elsewhere/);
  assert.deepEqual(readGroupView(scope, storage).view.target, target);
  keepGroupView(saved, null, storage); assert.equal(readGroupView(scope, storage).view.target, null);
});
