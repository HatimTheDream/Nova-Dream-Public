import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { canonical } from '../packages/domain/contracts.js';
import { changeGroup, groupCommandSchema, groupReceipt, groupIntent, groupKey, groupMemberKey, groupEventKey,
  verifyGroupRecords, groupEventLimit, type GroupBundle, type GroupCommand, type GroupMember } from '../packages/domain/assistant-groups.js';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function fixture() {
  const groupId = randomUUID(), epoch = randomUUID(), deviceId = randomUUID();
  const bundle: GroupBundle = { group: null, members: [], events: [] };
  function command(patch: object): GroupCommand {
    return groupCommandSchema.parse({ requestId: randomUUID(), epoch, groupId, expectedRevision: bundle.group?.revision ?? 0, ...patch });
  }
  function capture(input: GroupCommand) {
    const eventId = randomUUID(), at = '2026-10-20T13:00:00.000Z';
    const removed = input.action === 'undo-removal' ? bundle.events.find(event => event.id === input.removalEventId)?.removedMembershipIds[0] : undefined;
    const old = bundle.members.find(member => member.id === removed);
    const selected = input.action === 'create' || input.action === 'add-members' ? input.members
      : input.action === 'undo-removal' && old ? [{ agentId: old.agentId, agentRevision: input.agentRevision }] : [];
    const addedMembers: GroupMember[] = selected.map(selected => ({ format: 1, id: randomUUID(), groupId, ...selected,
      name: 'Shared Name', appearance: null, joinedBy: { requestId: input.requestId, epoch, deviceId },
      joinedAt: at, joinEventId: eventId, joinedRevision: (bundle.group?.revision ?? 0) + 1,
      history: { kind: 'none-before-membership', joinEventId: eventId }, restoresMembershipId: removed ?? null }));
    return { eventId, at, deviceId, actor: { profileId: 'profile:owner' as const, revision: 0, name: 'You' }, addedMembers };
  }
  function apply(patch: object) {
    const input = command(patch), event = changeGroup(bundle, input, capture(input));
    bundle.group = event.after; bundle.members.push(...event.addedMembers); bundle.events.push(event); return event;
  }
  function evidence() {
    assert(bundle.group);
    return { rows: [{ id: groupKey(groupId), revision: bundle.group.revision, value: structuredClone(bundle.group) },
      ...bundle.members.map(member => ({ id: groupMemberKey(groupId, member.id), revision: 1, value: structuredClone(member) })),
      ...bundle.events.map(event => ({ id: groupEventKey(groupId, event.sequence), revision: 1, value: structuredClone(event) }))],
    receipts: bundle.events.map(event => ({ requestId: event.command.requestId, deviceId, digest: digest(groupIntent(event.command)), value: groupReceipt(event) })) };
  }
  const create = (agents: string[] = []) => apply({ action: 'create', title: 'Original Group', projectId: null,
    members: agents.map(agentId => ({ agentId, agentRevision: 1 })), defaultAgentId: agents[0] ?? null });
  return { groupId, epoch, deviceId, bundle, command, capture, apply, evidence, create };
}

test('zero-member Groups persist, keep one identity and receive no implied history or grant', () => {
  const f = fixture(), empty = f.create();
  assert.equal(empty.after.defaultMemberId, null); assert.deepEqual(empty.after.activeMembershipIds, []);
  const added = f.apply({ action: 'add-members', members: [{ agentId: 'agent:one', agentRevision: 1 }], defaultAgentId: 'agent:one' });
  const member = added.addedMembers[0], removed = f.apply({ action: 'remove-member', membershipId: member.id, replacementMembershipId: null });
  assert.equal(removed.after.id, empty.after.id); assert.deepEqual(removed.after.activeMembershipIds, []);
  assert.equal(removed.after.defaultMemberId, null); assert.deepEqual(f.bundle.members[0], member);
  assert.deepEqual(member.history, { kind: 'none-before-membership', joinEventId: added.id });
  const data = f.evidence(); assert.equal(verifyGroupRecords(57, data.rows, data.receipts, digest).get(f.groupId)!.events.length, 3);
});
test('duplicate IDs refuse while duplicate names retain distinct exact memberships', () => {
  const f = fixture();
  assert.throws(() => f.command({ action: 'create', title: 'Group', projectId: null,
    members: [{ agentId: 'agent:a', agentRevision: 1 }, { agentId: 'agent:a', agentRevision: 1 }], defaultAgentId: 'agent:a' }));
  const made = f.create(['agent:a', 'agent:b']); assert.equal(new Set(made.addedMembers.map(member => member.name)).size, 1);
  assert.equal(new Set(made.addedMembers.map(member => member.id)).size, 2);
  assert.throws(() => f.apply({ action: 'add-members', members: [{ agentId: 'agent:a', agentRevision: 1 }], defaultAgentId: null }), /already a member/);
});
test('new nonempty Groups and default removals require an explicit valid responder', () => {
  const f = fixture();
  assert.throws(() => f.apply({ action: 'create', title: 'Group', projectId: null, members: [{ agentId: 'agent:a', agentRevision: 1 }], defaultAgentId: null }), /explicitly/);
  const made = f.create(['agent:a', 'agent:b']), [a, b] = made.addedMembers;
  assert.throws(() => f.apply({ action: 'remove-member', membershipId: a.id, replacementMembershipId: null }), /remaining default/);
  assert.throws(() => f.apply({ action: 'remove-member', membershipId: b.id, replacementMembershipId: a.id }), /does not change/);
  assert.throws(() => f.apply({ action: 'choose-default', membershipId: randomUUID() }), /active member/);
});
test('Undo preserves a newer explicit default choice even if it returned to the same value', () => {
  const f = fixture(), made = f.create(['agent:a', 'agent:b', 'agent:c']), [a, b, c] = made.addedMembers;
  const removed = f.apply({ action: 'remove-member', membershipId: a.id, replacementMembershipId: b.id });
  f.apply({ action: 'choose-default', membershipId: c.id }); f.apply({ action: 'choose-default', membershipId: b.id });
  const undone = f.apply({ action: 'undo-removal', removalEventId: removed.id, agentRevision: 2, defaultAgentId: null });
  assert.equal(undone.after.defaultMemberId, b.id); assert.equal(undone.restoredDefault, false);
  assert.notEqual(undone.addedMembers[0].id, a.id); assert.equal(undone.addedMembers[0].restoresMembershipId, a.id);
  assert.equal(f.bundle.members[0].agentRevision, 1); assert.equal(undone.addedMembers[0].agentRevision, 2);
  assert.throws(() => f.apply({ action: 'undo-removal', removalEventId: removed.id, agentRevision: 2, defaultAgentId: null }), /already undone/);
});
test('Undo restores the old default only while its replacement choice is still current', () => {
  const f = fixture(), [a, b] = f.create(['agent:a', 'agent:b']).addedMembers;
  const removed = f.apply({ action: 'remove-member', membershipId: a.id, replacementMembershipId: b.id });
  f.apply({ action: 'rename', title: 'Renamed Without Choosing A Responder' });
  const undone = f.apply({ action: 'undo-removal', removalEventId: removed.id, agentRevision: 1, defaultAgentId: null });
  assert.equal(undone.after.defaultMemberId, undone.addedMembers[0].id); assert(undone.restoredDefault);
});
test('Undo into an empty Group is explicit and re-adding the same agent cannot duplicate it', () => {
  const f = fixture(), [a] = f.create(['agent:a']).addedMembers;
  const removed = f.apply({ action: 'remove-member', membershipId: a.id, replacementMembershipId: null });
  assert.throws(() => f.apply({ action: 'undo-removal', removalEventId: removed.id, agentRevision: 1, defaultAgentId: null }), /explicitly|default before/);
  f.apply({ action: 'add-members', members: [{ agentId: 'agent:a', agentRevision: 1 }], defaultAgentId: 'agent:a' });
  assert.throws(() => f.apply({ action: 'undo-removal', removalEventId: removed.id, agentRevision: 1, defaultAgentId: null }), /cannot be restored/);
});
test('archived and trashed Groups retain history and require restoration before metadata edits', () => {
  const f = fixture(); f.create(); f.apply({ action: 'set-archived', archived: true });
  assert.throws(() => f.apply({ action: 'rename', title: 'Cannot Replace' }), /Restore/);
  f.apply({ action: 'set-trashed', trashed: true }); f.apply({ action: 'set-trashed', trashed: false });
  assert(f.bundle.group!.archived); f.apply({ action: 'set-archived', archived: false });
  assert.throws(() => f.apply({ action: 'set-archived', archived: false }), /already changed/);
  const data = f.evidence(); verifyGroupRecords(57, data.rows, data.receipts, digest);
});
test('unsupported grants, caller captures, stale revisions and cross-group memberships refuse', () => {
  const f = fixture(); f.create();
  const base = { action: 'add-members', members: [{ agentId: 'agent:a', agentRevision: 1 }], defaultAgentId: 'agent:a' };
  for (const patch of [{ shareEarlierHistory: true }, { permissions: 'all' }, { nativeId: randomUUID() }, { members: [{ agentId: 'agent:a', agentRevision: 0 }] }])
    assert.throws(() => f.command({ ...base, ...patch }));
  const input = f.command(base), capture = f.capture(input);
  assert.throws(() => changeGroup(f.bundle, { ...input, expectedRevision: 0 }, capture), /Group changed/);
  assert.throws(() => changeGroup(f.bundle, input, { ...capture, addedMembers: [{ ...capture.addedMembers[0], groupId: randomUUID() }] }), /original command/);
  assert.throws(() => changeGroup(f.bundle, input, { ...capture, addedMembers: [{ ...capture.addedMembers[0], joinedBy: { ...capture.addedMembers[0].joinedBy, epoch: randomUUID() } }] }), /original command/);
});
test('captured names use the existing owner and agent limit without rewriting their saved name', () => {
  const f = fixture(), input = f.command({ action: 'create', title: 'Group', projectId: null, members: [{ agentId: 'agent:a', agentRevision: 1 }], defaultAgentId: 'agent:a' });
  const capture = f.capture(input); capture.actor.name = 'x'.repeat(240); capture.addedMembers[0].name = 'y'.repeat(240);
  assert.equal(changeGroup(f.bundle, input, capture).addedMembers[0].name.length, 240);
  assert.throws(() => changeGroup(f.bundle, input, { ...capture, actor: { ...capture.actor, name: 'x'.repeat(241) } }));
});
test('complete replay rejects missing, detached, changed or rewritten authority and receipts', () => {
  const f = fixture(); f.create(['agent:a']); f.apply({ action: 'rename', title: 'New Title' });
  const good = f.evidence(); verifyGroupRecords(57, good.rows, good.receipts, digest);
  const mutations: ((data: ReturnType<typeof f.evidence>) => void)[] = [
    data => { data.rows.pop(); }, data => { data.rows[0].revision++; },
    data => { data.rows.find(row => row.id.includes(':member:'))!.revision++; },
    data => { data.rows.find(row => row.id.includes(':event:'))!.revision++; },
    data => { (data.rows[0].value as any).defaultMemberId = randomUUID(); },
    data => { (data.rows.find(row => row.id.includes(':member:'))!.value as any).name = 'Rewritten'; },
    data => { data.rows[0].id += '-wrong'; }, data => { (data.rows[0].value as any).format = 2; },
    data => { data.receipts.pop(); }, data => { data.receipts[0].deviceId = randomUUID(); },
    data => { data.receipts[0].digest = '0'.repeat(64); }, data => { data.receipts[0].value.group.title = 'Changed'; },
    data => { data.receipts.push(data.receipts[0]); }, data => { data.rows.push(data.rows[0]); },
  ];
  for (const mutate of mutations) { const data = structuredClone(good); mutate(data); assert.throws(() => verifyGroupRecords(57, data.rows, data.receipts, digest)); }
  assert.throws(() => verifyGroupRecords(56, good.rows, good.receipts, digest), /schema 57/);
});
test('history cap refuses a new mutation without pruning any original record', () => {
  const f = fixture(); f.create();
  f.bundle.group = { ...f.bundle.group!, revision: groupEventLimit };
  assert.throws(() => f.apply({ action: 'rename', title: 'Beyond The Limit' }), /history-limit|history limit/);
  assert.equal(f.bundle.events.length, 1); assert.equal(f.bundle.group.revision, groupEventLimit);
});
test('orphaned marked Group receipts refuse even when the entire Group namespace was removed', () => {
  const f = fixture(); f.create(); const data = f.evidence();
  assert.throws(() => verifyGroupRecords(57, [], data.receipts, digest), /receipt has no complete/);
  assert.throws(() => verifyGroupRecords(56, [], data.receipts, digest), /schema 57/);
  const unrelated = [{ requestId: randomUUID(), deviceId: f.deviceId, digest: 'a'.repeat(64),
    value: { kind: 'ordinary-record', group: { title: 'User writing may mention a group' } } }];
  assert.equal(verifyGroupRecords(57, [], unrelated, digest).size, 0);
  assert.equal(verifyGroupRecords(57, data.rows, [...data.receipts, ...unrelated], digest).size, 1);
  assert.throws(() => verifyGroupRecords(57, data.rows, [...data.receipts,
    { ...data.receipts[0], requestId: randomUUID() }], digest), /receipt has no complete/);
});
