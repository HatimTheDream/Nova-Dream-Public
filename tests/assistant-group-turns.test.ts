import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { canonical } from '../packages/domain/contracts.js';
import { blankRecord, agentSchema } from '../packages/domain/workspace-records.js';
import { changeGroup, groupCommandSchema, type GroupBundle, type GroupMember } from '../packages/domain/assistant-groups.js';
import { appendGroupPreparation, changeGroupPreparation, emptyGroupPreparation, groupDraftId, groupDraftScopeSchema,
  groupPreparationCommandSchema, groupPreparationEntries, groupPreparationIntent, groupPreparationReceipt,
  parseGroupDraft, verifyGroupPreparations, groupHistoryClosure, type GroupDraft, type GroupDraftScope,
  type GroupHistoryRef, type GroupSourceRef, type GroupPreparationCommand } from '../packages/domain/assistant-group-turns.js';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function fixture() {
  const groupId = randomUUID(), epoch = randomUUID(), deviceId = randomUUID(), windowId = randomUUID();
  const group: GroupBundle = { group: null, members: [], events: [] }, preparation = emptyGroupPreparation();
  const values = new Map<string, unknown>(), versions = new Map<string, number>();
  const key = (kind: string, id: string, revision: number) => `${kind}|${id}|${revision}`;
  const authority = { group, digest, saved: (kind: string, id: string, revision: number) => values.get(key(kind, id, revision)) };
  function agent(id: string, access: object = { content: 'read' }) {
    const revision = (versions.get(id) ?? 0) + 1; versions.set(id, revision);
    const value = agentSchema.parse({ ...blankRecord('agent', 'UTC'), name: 'Shared Name', position: 'Research Partner', access });
    values.set(key('agent', id, revision), value); return { agentId: id, agentRevision: revision };
  }
  function metadata(patch: object) {
    const command = groupCommandSchema.parse({ requestId: randomUUID(), epoch, groupId,
      expectedRevision: group.group?.revision ?? 0, ...patch });
    const eventId = randomUUID(), at = '2026-10-20T14:00:00.000Z';
    const selected = command.action === 'create' || command.action === 'add-members' ? command.members : [];
    const addedMembers: GroupMember[] = selected.map(row => ({ format: 1, id: randomUUID(), groupId, ...row,
      name: 'Shared Name', appearance: null, joinedBy: { requestId: command.requestId, epoch, deviceId }, joinedAt: at,
      joinEventId: eventId, joinedRevision: (group.group?.revision ?? 0) + 1,
      history: { kind: 'none-before-membership', joinEventId: eventId }, restoresMembershipId: null }));
    const event = changeGroup(group, command, { eventId, at, deviceId, addedMembers,
      actor: { profileId: 'profile:owner', revision: 0, name: 'You' } });
    group.group = event.after; group.events.push(event); group.members.push(...addedMembers); return event;
  }
  const a = agent('agent:a');
  metadata({ action: 'create', title: 'Exact Group', projectId: null, members: [a], defaultAgentId: a.agentId });
  function scope(mode: GroupDraftScope['mode'] = 'everyone') {
    const current = group.group!;
    const ids = mode === 'default' ? [current.defaultMemberId!] : current.activeMembershipIds;
    return groupDraftScopeSchema.parse({ format: 1, epoch, deviceId, windowId, groupId,
      groupRevision: current.revision, membershipRevision: current.membershipRevision,
      defaultRevision: current.defaultRevision, mode,
      recipients: ids.map(membershipId => ({ membershipId, agentRevision: versions.get(group.members.find(row => row.id === membershipId)!.agentId) })),
      project: null });
  }
  function command(patch: object): GroupPreparationCommand {
    return groupPreparationCommandSchema.parse({ requestId: randomUUID(), epoch, groupId, ...patch });
  }
  function apply(input: GroupPreparationCommand) {
    const event = changeGroupPreparation(preparation, input, { eventId: randomUUID(), at: '2026-10-20T14:00:00.000Z',
      deviceId, roundId: randomUUID(), grantId: randomUUID(),
      attemptIds: input.action === 'prepare' ? parseGroupDraft(input.expectedRaw).scope.recipients.map(() => randomUUID()) : [],
      owner: null }, authority);
    appendGroupPreparation(preparation, event); return event;
  }
  function save(text: string, selected = scope(), sources: GroupSourceRef[] = [], history: GroupHistoryRef[] = []) {
    const id = groupDraftId(selected, digest);
    const event = apply(command({ action: 'save-draft', scope: selected, expectedRaw: preparation.drafts.get(id) ?? null, text, sources, history }));
    return parseGroupDraft(event.draftRaw!);
  }
  function prepare(draft: GroupDraft) {
    return apply(command({ action: 'prepare', draftId: draft.id, expectedRaw: preparation.drafts.get(draft.id)!,
      expectedSequence: preparation.events.length })).round!;
  }
  function source(id = 'content:source'): GroupSourceRef {
    const value = { ...blankRecord('content', 'UTC'), title: 'Original Saved Source', body: 'Exact source text' };
    values.set(key('content', id, 1), value);
    return { kind: 'content', id, revision: 1, sha256: digest(value) };
  }
  function evidence() {
    const rows = new Map<string, ReturnType<typeof groupPreparationEntries>[number]>();
    for (const event of preparation.events) for (const row of groupPreparationEntries(event)) rows.set(row.id, structuredClone(row));
    return { rows: [...rows.values()], receipts: preparation.events.map(event => ({ requestId: event.command.requestId,
      deviceId, digest: digest(groupPreparationIntent(event.command)), value: groupPreparationReceipt(event) })) };
  }
  function verify(data = evidence()) {
    return verifyGroupPreparations(58, data.rows, data.receipts, new Map([[groupId, group]]), authority.saved, digest);
  }
  return { groupId, epoch, deviceId, group, preparation, values, authority, metadata, agent, scope, command, apply,
    save, prepare, source, evidence, verify, key };
}

test('exact raw draft CAS preserves writing and prepared round owns original membership and independent child IDs', () => {
  const f = fixture(), source = f.source(), first = f.save('Keep original writing', f.scope(), [source]);
  const raw = f.preparation.drafts.get(first.id)!;
  assert.throws(() => f.apply(f.command({ action: 'save-draft', scope: first.scope,
    expectedRaw: JSON.stringify(first, null, 2), text: 'Stale writing', sources: [], history: [] })), /original draft changed/);
  assert.equal(f.preparation.drafts.get(first.id), raw);
  const round = f.prepare(first), prepared = parseGroupDraft(f.preparation.drafts.get(first.id)!);
  assert.equal(prepared.text, first.text); assert.equal(prepared.preparedRoundId, round.id);
  assert.equal(round.state, 'prepared'); assert.equal(round.mode, 'provided-context-only');
  assert.equal(round.recipients[0].membership.id, f.group.members[0].id);
  assert.notEqual(round.recipients[0].attempt.id, round.id);
  assert.equal('nativeId' in round, false);
  assert.throws(() => f.prepare(prepared), /already has/);
  assert.equal(f.verify().get(f.groupId)!.rounds.size, 1);
});
test('scope hash includes window, device, exact default, Project and original recipient order', () => {
  const f = fixture(), original = f.scope(), id = groupDraftId(original, digest);
  for (const changed of [{ ...original, windowId: randomUUID() }, { ...original, deviceId: randomUUID() },
    { ...original, defaultRevision: original.defaultRevision + 1 }, { ...original, project: { id: 'project:a', revision: 1 } }])
    assert.notEqual(groupDraftId(changed, digest), id);
  assert.throws(() => f.save('Wrong device', { ...original, deviceId: randomUUID() }), /another workspace or device/);
  assert.throws(() => f.save('Wrong roster', { ...original, recipients: [...original.recipients, ...original.recipients] }), /duplicated/);
  assert.throws(() => f.command({ action: 'prepare', draftId: id, expectedRaw: '{}', expectedSequence: 0, send: true }));
});
test('missing original joined design never substitutes a newer agent revision', () => {
  const f = fixture(); f.agent('agent:a', { content: 'read' });
  const scope = f.scope(); f.values.delete(f.key('agent', 'agent:a', 1));
  assert.throws(() => f.save('Keep missing-design work', scope), /original agent design revision/);
});
test('joined and captured access intersect for every selected recipient, without computer or browser grants', () => {
  const f = fixture(), source = f.source(), b = f.agent('agent:b', {});
  f.metadata({ action: 'add-members', members: [b], defaultAgentId: null });
  const draft = f.save('Two recipients', f.scope(), [source]);
  assert.throws(() => f.prepare(draft), /not readable by every/);
  f.agent('agent:b', { content: 'edit', computer: 'edit', browser: 'edit' });
  assert.throws(() => f.prepare(f.save('Still no joined grant', f.scope(), [source])), /not readable by every/);
  const one = f.scope('default'), round = f.prepare(f.save('Only the reviewed default', one, [source]));
  assert.deepEqual(round.recipients[0].readModules, ['content']); f.verify();
});
test('history off rejects an indirect pre-join dependency even when the selected derived round is after joining', () => {
  const f = fixture(), old = f.prepare(f.save('Before joining'));
  const b = f.agent('agent:b'); f.metadata({ action: 'add-members', members: [b], defaultAgentId: null });
  const later = f.prepare(f.save('Later input quotes earlier work', f.scope('default'), [],
    [{ roundId: old.id, sha256: digest(old) }]));
  assert(later.scope.groupRevision > old.scope.groupRevision);
  const draft = f.save('Ask everyone about the later input', f.scope(), [], [{ roundId: later.id, sha256: digest(later) }]);
  assert.throws(() => f.prepare(draft), /not been explicitly shared/);
  const member = f.group.members.find(row => row.agentId === 'agent:b')!;
  const grant = f.apply(f.command({ action: 'grant-history', expectedGroupRevision: f.group.group!.revision,
    expectedSequence: f.preparation.events.length, membershipId: member.id, throughSequence: later.sequence,
    history: [{ roundId: later.id, sha256: digest(later) }] })).grant!;
  assert.deepEqual(grant.history.map(row => row.roundId), [old.id, later.id]);
  const round = f.prepare(draft); assert.equal(round.recipients.length, 2); f.verify();
});
test('wall-clock equality and rewinding do not widen a membership boundary or future grant', () => {
  const f = fixture(), old = f.prepare(f.save('Old input'));
  const b = f.agent('agent:b'); f.metadata({ action: 'add-members', members: [b], defaultAgentId: null });
  assert.equal(f.group.members[1].joinedAt, old.at);
  assert.throws(() => f.prepare(f.save('Same clock is not permission', f.scope(), [], [{ roundId: old.id, sha256: digest(old) }])),
    /not been explicitly shared/);
  assert.throws(() => f.apply(f.command({ action: 'grant-history', expectedGroupRevision: f.group.group!.revision,
    expectedSequence: f.preparation.events.length, throughSequence: f.preparation.events.length + 1,
    membershipId: f.group.members[1].id, history: [{ roundId: old.id, sha256: digest(old) }] })), /selection changed/);
});
test('malformed, changed and cyclic history dependencies refuse instead of silently truncating context', () => {
  const f = fixture(), old = f.prepare(f.save('Original'));
  assert.throws(() => groupHistoryClosure([{ roundId: old.id, sha256: '0'.repeat(64) }], f.preparation, 100, digest), /unavailable/);
  const corrupt = structuredClone(old); corrupt.context.history.push({ roundId: old.id, sha256: digest(old) });
  f.preparation.rounds.set(old.id, corrupt);
  assert.throws(() => groupHistoryClosure([{ roundId: old.id, sha256: digest(corrupt) }], f.preparation, 100, digest), /cyclic or out of order/);
});
test('complete verifier refuses orphaned marked receipts, changed original text, missing projections and old schemas', () => {
  const f = fixture(); f.prepare(f.save('Retained exact text', f.scope(), [f.source()]));
  const data = f.evidence(); f.verify(data);
  assert.throws(() => f.verify({ rows: [], receipts: data.receipts }), /no retained event/);
  assert.throws(() => f.verify({ rows: data.rows.slice(1), receipts: data.receipts }));
  assert.throws(() => f.verify({ rows: data.rows, receipts: data.receipts.slice(1) }), /receipt is missing/);
  assert.throws(() => verifyGroupPreparations(57, data.rows, data.receipts, new Map([[f.groupId, f.group]]), f.authority.saved, digest), /schema 58/);
  const changed = structuredClone(data), roundRow = changed.rows.find(row => row.id.includes(':round:'))!;
  (roundRow.value as { text: string }).text = 'Replaced';
  assert.throws(() => f.verify(changed), /does not match/);
  const extra = structuredClone(data); extra.rows.push({ id: `assistant:group-preparation:${f.groupId}:native:invented`, revision: 1, value: {} });
  assert.throws(() => f.verify(extra), /does not match/);
});
test('later writing remains distinct from the immutable prepared round and original receipt', () => {
  const f = fixture(), first = f.save('First input'), round = f.prepare(first);
  const oldReceipt = groupPreparationReceipt(f.preparation.events[1]);
  const next = f.save('New unfinished paragraph', first.scope);
  assert.equal(next.preparedRoundId, null); assert.equal(f.preparation.rounds.get(round.id)!.text, 'First input');
  assert.equal(parseGroupDraft(oldReceipt.draftRaw!).text, 'First input');
  assert.equal(parseGroupDraft(f.preparation.drafts.get(first.id)!).text, 'New unfinished paragraph'); f.verify();
});
test('a captured membership cannot relabel the exact historical joined design', () => {
  const f = fixture(), draft = f.save('Exact authorship');
  f.group.members[0].name = 'A different author';
  assert.throws(() => f.prepare(draft), /does not match its exact joined agent design/);
});
test('the context byte bound includes earlier input bodies, not only their short references', () => {
  const f = fixture(), history: GroupHistoryRef[] = [];
  for (let index = 0; index < 14; index++) {
    const round = f.prepare(f.save(index.toString().padStart(2, '0') + 'x'.repeat(19998)));
    history.push({ roundId: round.id, sha256: digest(round) });
  }
  const draft = f.save('Keep the full reviewed selection', f.scope(), [], history);
  assert.throws(() => f.prepare(draft), /provided context is too large/);
  assert.deepEqual(parseGroupDraft(f.preparation.drafts.get(draft.id)!).history, history);
});
test('large agent captures are refused before producing an oversized prepared round', () => {
  const f = fixture(), members = [];
  for (let index = 1; index < 32; index++) members.push(f.agent(`agent:${index}`));
  f.metadata({ action: 'add-members', members, defaultAgentId: null });
  for (const member of f.group.members) {
    const key = f.key('agent', member.agentId, 1), value = f.values.get(key) as object;
    f.values.set(key, { ...value, instructions: 'x'.repeat(20000) });
  }
  const draft = f.save('The whole recipient set remains selected');
  assert.throws(() => f.prepare(draft), /exceed the supported prepared input size/);
  assert.equal(parseGroupDraft(f.preparation.drafts.get(draft.id)!).scope.recipients.length, 32);
});
