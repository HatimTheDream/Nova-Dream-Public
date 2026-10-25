import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../apps/client/src/api';
import { changeGroup, groupReceipt, type GroupCommand } from '../packages/domain/assistant-groups';
import { GroupEditorJournal, emptyGroupEditor, groupEditorKey, readGroupEditorJournal } from '../apps/client/src/assistant-group-journal';
import { discoverGroupWriting, groupWritingTarget, copyGroupWriting, checkGroupWritingCopy } from '../apps/client/src/group-writing-recovery';

function fixture() {
  const scope = { epoch: randomUUID(), deviceId: randomUUID(), windowId: randomUUID() };
  const originalScope = { ...scope, windowId: randomUUID(), groupId: randomUUID() }, key = groupEditorKey(originalScope);
  const rows = new Map<string, string>(), storage = { get length() { return rows.size; }, key: (i: number) => [...rows.keys()][i] ?? null,
    getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); } };
  const owner = new GroupEditorJournal(storage, originalScope, () => true, emptyGroupEditor(), 'create');
  owner.change({ ...emptyGroupEditor(), title: 'Kept Planning Circle', members: [{ agentId: 'agent:planner', agentRevision: 2 }], defaultAgentId: 'agent:planner' });
  const command: GroupCommand = { action: 'create', groupId: originalScope.groupId, requestId: randomUUID(), epoch: scope.epoch,
    expectedRevision: 0, title: 'Original Group', projectId: null, members: [], defaultAgentId: null, shareEarlierHistory: false };
  const receipt = groupReceipt(changeGroup({ group: null, members: [], events: [] }, command, {
    eventId: randomUUID(), at: '2026-10-20T12:00:00.000Z', deviceId: scope.deviceId, addedMembers: [],
    actor: { profileId: 'profile:owner', revision: 0, name: 'You' },
  }));
  const entry = () => discoverGroupWriting(storage, scope).entries.find(item => item.key === key)!;
  const target = { kind: 'create' as const, groupId: originalScope.groupId };
  const missing = async () => { throw new ApiError('group_missing', 'Group unavailable', undefined, 404); };
  return { scope, originalScope, key, rows, storage, owner, command, receipt, entry, target, missing,
    detail: { epoch: scope.epoch, view: 'group', group: receipt.group, members: [], historicalMembershipCount: 0 } };
}
test('new Group writing recovers only after exact missing read, retaining all original fields and provenance', async () => {
  const f = fixture(), source = f.rows.get(f.key)!; let reads = 0;
  const target = await groupWritingTarget(f.entry(), f.scope, async url => { reads++; assert.match(url, new RegExp(f.target.groupId)); return f.missing(); }, () => true);
  const kept = copyGroupWriting(f.storage, f.entry(), f.scope, target);
  assert.equal(reads, 1); checkGroupWritingCopy(f.storage, kept, f.scope);
  const value = readGroupEditorJournal(kept.raw, { ...f.scope, groupId: f.target.groupId });
  assert.deepEqual(value.draft, f.owner.value.draft); assert.deepEqual(value.recoveredFrom, [f.originalScope]);
  assert.equal(f.rows.get(f.key), source); assert.equal(value.origin, 'create');
});
test('unknown dispatched original is copied unchanged and reopens with observation only', async () => {
  const f = fixture(); let sent = 0;
  await f.owner.send(f.command, async () => { sent++; throw Error('Original reply lost'); });
  f.owner.change({ ...f.owner.value.draft, title: 'Newer Writing' });
  const source = f.rows.get(f.key)!, selected = f.entry();
  const target = await groupWritingTarget(selected, f.scope, async () => f.detail, () => true);
  const kept = copyGroupWriting(f.storage, selected, f.scope, target);
  const reopened = new GroupEditorJournal(f.storage, { ...f.scope, groupId: target.groupId }, () => true);
  assert.equal(reopened.canContinueUnsent, false);
  await reopened.continueUnsent(async () => { sent++; return f.receipt; });
  await reopened.observe(async (groupId, requestId) => {
    assert.equal(groupId, f.command.groupId); assert.equal(requestId, f.command.requestId);
    return { epoch: f.scope.epoch, view: 'request', receipt: f.receipt };
  });
  assert.equal(sent, 1); assert.equal(reopened.value.draft.title, 'Newer Writing');
  assert.deepEqual(JSON.parse(kept.raw).pending, JSON.parse(source).pending);
  assert.equal(f.rows.get(f.key), source);
});
test('confirmed and known rejected originals retain their exact evidence through a copy', async () => {
  for (const rejected of [false, true]) {
    const f = fixture();
    await f.owner.send(f.command, async () => {
      if (rejected) throw new ApiError('group_agent_changed', 'Agent changed', undefined, 409);
      return f.receipt;
    });
    const selected = f.entry(), target = await groupWritingTarget(selected, f.scope, rejected ? f.missing : async () => f.detail, () => true);
    const kept = copyGroupWriting(f.storage, selected, f.scope, target);
    assert.deepEqual(JSON.parse(kept.raw).pending, f.owner.value.pending);
    assert.equal(f.rows.get(f.key), selected.raw);
  }
});
test('a missing saved Group, old legacy unknown origin, wrong epoch, generic 404 and offline read never authorize a new Group', async () => {
  for (const mode of ['saved', 'legacy', 'epoch', 'generic', 'offline'] as const) {
    const f = fixture();
    if (mode === 'saved') f.owner.value.origin = 'group';
    if (mode === 'legacy') delete f.owner.value.origin;
    f.owner.retain(); const before = [...f.rows];
    await assert.rejects(groupWritingTarget(f.entry(), f.scope, mode === 'epoch' ? async () => ({ ...f.detail, epoch: randomUUID() })
      : mode === 'generic' ? async () => { throw new ApiError('other_missing', 'Other endpoint missing', undefined, 404); }
      : mode === 'offline' ? async () => { throw Error('Offline'); } : f.missing, () => true));
    assert.deepEqual([...f.rows], before);
  }
});
test('discovery preserves malformed and earlier workspace writing, ignores unrelated and archived keys, and tolerates denied access', () => {
  const f = fixture(), old = { ...f.originalScope, epoch: randomUUID() }, oldKey = groupEditorKey(old);
  f.rows.set(oldKey, JSON.stringify({ ...f.owner.value, scope: old }));
  const malformed = groupEditorKey({ ...f.originalScope, groupId: randomUUID() }); f.rows.set(malformed, '{unfinished');
  f.rows.set(`${f.key}:confirmed:${randomUUID()}`, 'archived original'); f.rows.set('unrelated-secret', 'unrelated');
  const read = f.storage.getItem, accessed: string[] = [];
  f.storage.getItem = key => { accessed.push(key); return read(key); };
  const before = [...f.rows], list = discoverGroupWriting(f.storage, f.scope);
  assert.equal(list.entries.length, 3); assert.equal(list.entries.filter(item => item.problem).length, 2);
  assert.equal(accessed.includes('unrelated-secret'), false); assert.equal(accessed.some(key => key.includes(':confirmed:')), false);
  for (const entry of list.entries.filter(item => item.problem)) assert.throws(() => copyGroupWriting(f.storage, entry, f.scope, { kind: 'create', groupId: entry.scope.groupId }));
  const denied = { ...f.storage, get length(): number { throw Error('Denied getter'); } };
  assert.match(discoverGroupWriting(denied, f.scope).notice, /could not be read/); assert.deepEqual([...f.rows], before);
});
test('source races and occupied targets refuse without replacing existing writing', () => {
  for (const mode of ['source', 'target', 'during'] as const) {
    const f = fixture(), selected = f.entry(), targetKey = groupEditorKey({ ...f.scope, groupId: f.target.groupId });
    if (mode === 'source') f.rows.set(f.key, 'newer original');
    if (mode === 'target') f.rows.set(targetKey, 'current writing');
    if (mode === 'during') f.storage.setItem = (key, value) => { f.rows.set(key, value); f.rows.set(f.key, 'newer original'); };
    assert.throws(() => copyGroupWriting(f.storage, selected, f.scope, f.target));
    assert.equal(f.rows.get(f.key), mode === 'target' ? selected.raw : 'newer original');
    if (mode === 'target') assert.equal(f.rows.get(targetKey), 'current writing');
    if (mode === 'during') assert.deepEqual(JSON.parse(f.rows.get(targetKey)!).pending, f.owner.value.pending);
  }
});
test('current-window discovery opens without a write and failed copy readback stays recoverable', () => {
  const f = fixture(), selected = f.entry(), originalWrite = f.storage.setItem, targetKey = groupEditorKey({ ...f.scope, groupId: f.target.groupId });
  let fail = false; const read = f.storage.getItem;
  f.storage.setItem = (key, value) => { originalWrite(key, value); fail = true; };
  f.storage.getItem = key => { if (fail && key === targetKey) { fail = false; throw Error('Readback denied'); } return read(key); };
  assert.throws(() => copyGroupWriting(f.storage, selected, f.scope, f.target), /Readback denied/);
  const copy = discoverGroupWriting(f.storage, f.scope).entries.find(entry => entry.key === targetKey)!;
  assert.ok(copy); f.storage.setItem = () => { throw Error('Must not write'); };
  const kept = copyGroupWriting(f.storage, copy, f.scope, f.target); checkGroupWritingCopy(f.storage, kept, f.scope);
  f.rows.set(targetKey, 'new current writing'); assert.throws(() => checkGroupWritingCopy(f.storage, kept, f.scope));
  assert.equal(f.rows.get(f.key), selected.raw);
});
test('wrong pending identity and invalid provenance are refused by both journal reload and discovery', () => {
  for (const altered of [
    { recoveredFrom: [{ epoch: randomUUID(), deviceId: randomUUID(), windowId: randomUUID(), groupId: randomUUID() }] },
    { recoveredFrom: [] as unknown[] },
  ]) {
    const f = fixture();
    if (!altered.recoveredFrom.length) altered.recoveredFrom = [f.originalScope];
    f.rows.set(f.key, JSON.stringify({ ...f.owner.value, ...altered }));
    assert.ok(f.entry().problem); assert.equal(new GroupEditorJournal(f.storage, f.originalScope, () => true).invalid, true);
  }
  const f = fixture(); f.rows.set(f.key, JSON.stringify({ ...f.owner.value, pending: { command: { ...f.command, groupId: randomUUID() }, dispatched: true } }));
  assert.ok(f.entry().problem);
});
test('late lookup closure and bounded discovery never copy or remove state', async () => {
  const f = fixture(); let current = true;
  await assert.rejects(groupWritingTarget(f.entry(), f.scope, async () => { current = false; return f.detail; }, () => current), /view changed/);
  for (let i = 0; i < 130; i++) {
    const owner = { ...f.originalScope, groupId: randomUUID() };
    f.rows.set(groupEditorKey(owner), JSON.stringify({ ...f.owner.value, scope: owner }));
  }
  const before = [...f.rows], list = discoverGroupWriting(f.storage, f.scope);
  assert.equal(list.entries.length, 128); assert.match(list.notice, /More kept writing/); assert.deepEqual([...f.rows], before);
});

test('oversized stored Group writing is refused before UTF-8 encoding or JSON parsing', () => {
  const f = fixture(), raw = 'x'.repeat(128 * 1024 + 1), encode = TextEncoder.prototype.encode, parse = JSON.parse;
  f.rows.set(f.key, raw); let encoded = 0, parsed = 0;
  TextEncoder.prototype.encode = function () { encoded++; throw Error('Oversized value must not be encoded'); };
  JSON.parse = () => { parsed++; throw Error('Oversized value must not be parsed'); };
  try {
    assert.throws(() => readGroupEditorJournal(raw, f.originalScope), /exceeds its supported size/);
    const list = discoverGroupWriting(f.storage, f.scope);
    assert.match(list.notice, /oversized.*stopped/); assert.equal(list.entries.length, 0);
    assert.equal(encoded, 0); assert.equal(parsed, 0); assert.equal(f.rows.get(f.key), raw);
  } finally { TextEncoder.prototype.encode = encode; JSON.parse = parse; }
});
