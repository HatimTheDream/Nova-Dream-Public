import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { canonical } from '../packages/domain/contracts.js';
import { changeGroup, groupCommandSchema, groupEventLimit, groupIntent, groupReceipt, groupKey, groupMemberKey, groupEventKey,
  verifyGroupRecords, type AssistantGroup, type GroupMember, type GroupEvent } from '../packages/domain/assistant-groups.js';

test('the complete 10,000-event history verifies every original membership and refuses a further mutation', { timeout: 60000 }, t => {
  const groupId = randomUUID(), epoch = randomUUID(), deviceId = randomUUID(), at = '2026-10-20T13:00:00.000Z';
  let group: AssistantGroup | null = null;
  const members: GroupMember[] = [], events: GroupEvent[] = [], byId = new Map<string, GroupMember>();
  const started = performance.now();
  for (let sequence = 1; sequence <= groupEventLimit; sequence++) {
    const eventId = randomUUID(), requestId = randomUUID();
    const active: string[] = group?.activeMembershipIds ?? [];
    const addition = sequence === 1 ? Array.from({ length: 32 }, (_, i) => ({ agentId: 'agent:first-' + i, agentRevision: 1 }))
      : sequence % 2 ? [{ agentId: 'agent:later-' + sequence, agentRevision: 1 }] : [];
    const command = groupCommandSchema.parse({ requestId, epoch, groupId, expectedRevision: sequence - 1,
      ...(sequence === 1 ? { action: 'create', title: 'Retained History Limit', projectId: null, members: addition, defaultAgentId: addition[0].agentId }
        : sequence % 2 ? { action: 'add-members', members: addition, defaultAgentId: null }
          : { action: 'remove-member', membershipId: active.at(-1), replacementMembershipId: null }) });
    const addedMembers: GroupMember[] = addition.map(selected => ({ format: 1, id: randomUUID(), groupId, ...selected,
      name: 'Original Captured Agent', appearance: null, joinedBy: { requestId, epoch, deviceId }, joinedAt: at,
      joinEventId: eventId, joinedRevision: sequence, history: { kind: 'none-before-membership', joinEventId: eventId }, restoresMembershipId: null }));
    // These actions need current members only. The assertion below independently replays the complete retained history.
    const event = changeGroup({ group, members: active.map(id => byId.get(id)!), events: [] }, command,
      { eventId, at, deviceId, actor: { profileId: 'profile:owner', revision: 0, name: 'You' }, addedMembers });
    group = event.after; events.push(event); members.push(...addedMembers);
    for (const member of addedMembers) byId.set(member.id, member);
  }
  assert(group);
  const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
  const rows = [{ id: groupKey(groupId), revision: group.revision, value: group },
    ...members.map(member => ({ id: groupMemberKey(groupId, member.id), revision: 1, value: member })),
    ...events.map(event => ({ id: groupEventKey(groupId, event.sequence), revision: 1, value: event }))];
  const receipts = events.map(event => ({ requestId: event.command.requestId, deviceId, digest: digest(groupIntent(event.command)), value: groupReceipt(event) }));
  const preparedMs = performance.now() - started, verifyStarted = performance.now();
  const verified = verifyGroupRecords(57, rows, receipts, digest).get(groupId)!;
  const verifyMs = performance.now() - verifyStarted;
  assert.equal(verified.events.length, groupEventLimit); assert.equal(verified.members.length, 5031);
  assert.equal(verified.group!.activeMembershipIds.length, 31);
  assert.throws(() => changeGroup(verified, groupCommandSchema.parse({ requestId: randomUUID(), epoch, groupId,
    expectedRevision: groupEventLimit, action: 'rename', title: 'No Pruning To Continue' }),
  { eventId: randomUUID(), at, deviceId, actor: { profileId: 'profile:owner', revision: 0, name: 'You' }, addedMembers: [] }), /history limit/);
  receipts.at(-1)!.digest = '0'.repeat(64);
  assert.throws(() => verifyGroupRecords(57, rows, receipts, digest), /receipt does not match/);
  t.diagnostic(JSON.stringify({ eventCount: events.length, retainedMembers: members.length, activeMembers: group.activeMembershipIds.length,
    serializedEvidenceBytes: Buffer.byteLength(JSON.stringify({ rows, receipts })), preparedMs, fullVerifyMs: verifyMs,
    measurementScope: 'synthetic in-memory full replay; not host, native, startup or arbitrary maximum-size appearance performance' }));
});
