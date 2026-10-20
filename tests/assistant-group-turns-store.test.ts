import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, Fault } from '../apps/service/store.js';
import { AssistantGroups } from '../apps/service/assistant-groups.js';
import { AssistantGroupPreparations, groupPreparationQuery } from '../apps/service/assistant-group-turns.js';
import { canonical } from '../packages/domain/contracts.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import { groupDraftId, groupDraftScopeSchema, groupPreparationPrefix, groupPreparationCommandSchema,
  parseGroupDraft, type GroupDraft, type GroupDraftScope, type GroupSourceRef } from '../packages/domain/assistant-group-turns.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function fixture() {
  const parent = resolve('.tmp-qa/assistant-group-turns'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'case-')); let store = new Store(directory), open = true;
  const device = store.session().deviceId, groupId = randomUUID(), windowId = randomUUID();
  const groups = () => new AssistantGroups(store), turns = () => new AssistantGroupPreparations(store);
  function agent(id = 'agent:original', access: object = { content: 'read' }) {
    const current = store.readEntity('agent', id);
    return store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'agent', entityId: id,
      expectedRevision: current?.revision ?? 0,
      payload: { ...(current?.value ?? blankRecord('agent', 'UTC')), name: 'Original Agent', position: 'Research Partner', access } });
  }
  const a = agent();
  groups().save(device, { requestId: randomUUID(), epoch: store.epoch, groupId, expectedRevision: 0, action: 'create',
    title: 'Retained Preparation', projectId: null, members: [{ agentId: a.id, agentRevision: a.revision }], defaultAgentId: a.id });
  function scope(): GroupDraftScope {
    const bundle = store.readAssistantGroup(groupId), group = bundle.group!;
    return groupDraftScopeSchema.parse({ format: 1, epoch: store.epoch, deviceId: device, windowId, groupId,
      groupRevision: group.revision, membershipRevision: group.membershipRevision, defaultRevision: group.defaultRevision,
      mode: 'everyone', project: null, recipients: group.activeMembershipIds.map(membershipId => ({
        membershipId, agentRevision: store.readEntity('agent', bundle.members.find(member => member.id === membershipId)!.agentId)!.revision })) });
  }
  function input(patch: object) {
    return groupPreparationCommandSchema.parse({ requestId: randomUUID(), epoch: store.epoch, groupId, ...patch });
  }
  function save(text: string, selected = scope(), sources: GroupSourceRef[] = []) {
    const id = groupDraftId(selected, digest), expectedRaw = store.readGroupPreparation(groupId).preparation.drafts.get(id) ?? null;
    const command = input({ action: 'save-draft', scope: selected, expectedRaw, text, sources, history: [] });
    const receipt = turns().save(device, command);
    return { command, receipt, draft: parseGroupDraft(receipt.draftRaw!) };
  }
  function prepare(draft: GroupDraft) {
    const original = store.readGroupPreparation(groupId).preparation;
    const command = input({ action: 'prepare', draftId: draft.id, expectedRaw: original.drafts.get(draft.id)!,
      expectedSequence: original.events.length });
    const receipt = turns().save(device, command), round = store.readGroupPreparation(groupId).preparation.rounds.get(receipt.roundId!)!;
    return { command, receipt, round };
  }
  function content(): GroupSourceRef {
    const entity = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'content', entityId: 'content:original',
      expectedRevision: 0, payload: { ...blankRecord('content', 'UTC'), title: 'Original Text', body: 'Keep this exact saved source.' } });
    return { kind: 'content', id: entity.id, revision: entity.revision, sha256: digest(entity.value) };
  }
  function capture() {
    const { id: _id, createdAt: _at, ...value } = store.captureBackup('group-preparation-fixture', { status: 'not-configured', notes: [] });
    return value;
  }
  return { get store() { return store; }, directory, groupId, device, groups, turns, agent, scope, input, save, prepare, content, capture,
    closeStore() { if (open) { store.close(); open = false; } },
    reopen() { store = new Store(directory); open = true; },
    close(passed: boolean) { if (open) store.close(); assert(resolve(directory).startsWith(parent + sep));
      if (passed) rmSync(directory, { recursive: true }); else console.error('Preserved Group preparation fixture:', directory); } };
}
function check(name: string, run: (f: ReturnType<typeof fixture>) => void) {
  test(name, () => { const f = fixture(); let passed = false; try { run(f); passed = true; } finally { f.close(passed); } });
}

check('original draft and round receipts survive a Store reopen and replay without touching newer writing', f => {
  const first = f.save('Original writing', f.scope(), [f.content()]), prepared = f.prepare(first.draft);
  const next = f.save('New unfinished writing', first.draft.scope), after = f.capture();
  f.closeStore(); f.reopen();
  assert.deepEqual(f.turns().save(f.device, prepared.command), prepared.receipt);
  assert.deepEqual(f.turns().save(f.device, first.command), first.receipt);
  assert.equal(parseGroupDraft(f.store.readGroupPreparation(f.groupId).preparation.drafts.get(first.draft.id)!).text, next.draft.text);
  assert.deepEqual(f.capture(), after);
  const read = f.turns().read(f.device, { view: 'round', groupId: f.groupId, roundId: prepared.round.id }) as any;
  assert.equal(read.availability.execution, 'unavailable'); assert.equal(read.round.mode, 'provided-context-only');
  assert.equal(read.round.recipients[0].joined.revision, 1);
});
check('known reply identity, exact body, original device, epoch and raw CAS are all required', f => {
  const saved = f.save('Keep exact writing'), before = f.capture();
  assert.throws(() => f.turns().save(randomUUID(), saved.command), { code: 'request_reused' });
  assert.throws(() => f.turns().save(f.device, { ...saved.command, text: 'Different original command' }), { code: 'request_reused' });
  assert.throws(() => f.turns().save(f.device, { ...saved.command, requestId: randomUUID(), epoch: randomUUID() }), { code: 'epoch_changed' });
  assert.throws(() => f.turns().save(f.device, { ...saved.command, requestId: randomUUID(),
    expectedRaw: JSON.stringify(saved.draft, null, 2), text: 'Not exact raw' }), /original draft changed/);
  assert.throws(() => f.turns().read(randomUUID(), { view: 'draft', groupId: f.groupId, draftId: saved.draft.id }), { code: 'group_draft_missing' });
  assert.throws(() => f.turns().read(randomUUID(), { view: 'request', groupId: f.groupId, requestId: saved.command.requestId }), { code: 'group_preparation_request_missing' });
  assert.deepEqual(f.capture(), before);
});
check('changed roster or default blocks preparing but the old scoped unfinished draft can still be kept', f => {
  const saved = f.save('Original scoped draft'), member = f.store.readAssistantGroup(f.groupId).members[0];
  f.groups().save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, groupId: f.groupId, expectedRevision: 1,
    action: 'choose-default', membershipId: member.id });
  const before = f.capture();
  assert.throws(() => f.prepare(saved.draft), { code: 'group_scope_changed' }); assert.deepEqual(f.capture(), before);
  const kept = f.save('Typing after scope changed is preserved', saved.draft.scope);
  assert.equal(kept.draft.scope.groupRevision, 1); assert.equal(kept.draft.preparedRoundId, null);
  const reviewed = f.save('Explicit new scope', f.scope()); assert.notEqual(reviewed.draft.id, saved.draft.id);
});
check('every captured recipient is checked at admission, and later revocation never rewrites the prepared original', f => {
  const b = f.agent('agent:second');
  f.groups().save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, groupId: f.groupId, expectedRevision: 1,
    action: 'add-members', members: [{ agentId: b.id, agentRevision: b.revision }], defaultAgentId: null });
  const source = f.content(), saved = f.save('Common readable context', f.scope(), [source]);
  const prepared = f.prepare(saved.draft); f.agent('agent:second', {});
  const before = f.capture();
  const read = f.turns().read(f.device, { view: 'round', groupId: f.groupId, roundId: prepared.round.id }) as any;
  assert.equal(read.availability.current, false); assert.equal(read.availability.reason, 'group_recipient_changed');
  assert.deepEqual(read.round, prepared.round); assert.deepEqual(f.capture(), before);
  const newWriting = f.save('Review after revocation', f.scope(), [source]);
  const retained = f.capture();
  assert.throws(() => f.prepare(newWriting.draft), /not readable by every/);
  assert.deepEqual(f.capture(), retained);
});
check('an old source revision remains saved but cannot be silently provided after the current source changes', f => {
  const source = f.content(), saved = f.save('Original source selection', f.scope(), [source]);
  const current = f.store.readEntity('content', source.id)!;
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'content', entityId: source.id,
    expectedRevision: current.revision, payload: { ...current.value, body: 'A new saved version' } });
  const before = f.capture();
  assert.throws(() => f.prepare(saved.draft), { code: 'group_source_changed' }); assert.deepEqual(f.capture(), before);
  assert.equal(f.store.readEntityVersion('content', source.id, 1)!.value.body, 'Keep this exact saved source.');
});
check('current Project deletion, recovery and update holds block preparation without changing original writing', f => {
  const project = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project', entityId: 'project:group',
    expectedRevision: 0, payload: { name: 'Original Project', purpose: 'Preserved purpose' } });
  const other = randomUUID();
  const agent = f.store.readEntity('agent', 'agent:original')!;
  f.groups().save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, groupId: other, expectedRevision: 0,
    action: 'create', title: 'Project Group', projectId: project.id, members: [{ agentId: agent.id, agentRevision: agent.revision }], defaultAgentId: agent.id });
  const current = f.store.readAssistantGroup(other).group!;
  const scope = groupDraftScopeSchema.parse({ ...f.scope(), groupId: other, project: { id: project.id, revision: project.revision },
    recipients: [{ membershipId: current.defaultMemberId, agentRevision: agent.revision }] });
  const saved = f.turns().save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, groupId: other, action: 'save-draft',
    scope, expectedRaw: null, text: 'Keep Project writing', sources: [], history: [] });
  f.store.internalWrite(`assistant:project-organization:${project.id}`, { projectId: project.id, revision: 1, deleted: true });
  const before = f.capture();
  assert.throws(() => f.turns().save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, groupId: other,
    action: 'prepare', draftId: parseGroupDraft(saved.draftRaw!).id, expectedRaw: saved.draftRaw, expectedSequence: 1 }), { code: 'group_project_changed' });
  assert.deepEqual(f.capture(), before);
  f.store.setUpdateMaintenanceHeld(true);
  assert.throws(() => f.save('Update-held writing'), { code: 'update_maintenance' });
  f.store.setUpdateMaintenanceHeld(false);
  assert.deepEqual(f.capture(), before);
  f.store.internalWrite('recovery:state', { held: true }); const held = f.capture();
  assert.throws(() => f.save('Held writing'), { code: 'recovery_held' }); assert.deepEqual(f.capture(), held);
});
check('a failure after the first low-level write rolls back the whole prepared round, draft and receipt', f => {
  const saved = f.save('One atomic original'), before = f.capture(), original = f.store.internalWrite.bind(f.store);
  f.store.internalWrite = ((id: string, value: unknown) => {
    if (id.startsWith(groupPreparationPrefix) && id.includes(':round:')) throw new Fault(409, 'injected_failure', 'Synthetic post-event refusal');
    return original(id, value);
  }) as typeof f.store.internalWrite;
  assert.throws(() => f.prepare(saved.draft), { code: 'injected_failure' });
  f.store.internalWrite = original; assert.deepEqual(f.capture(), before);
  assert.equal(f.store.readGroupPreparation(f.groupId).preparation.rounds.size, 0);
});
check('low-level preparation writes and deletion are refused, while strict read routes perform no admission', f => {
  const saved = f.save('Retained'), before = f.capture();
  assert.throws(() => f.store.internalWrite(`${groupPreparationPrefix}${f.groupId}:invented`, {}), { code: 'group_preparation_original_required' });
  assert.throws(() => f.store.internalDelete(`${groupPreparationPrefix}${f.groupId}:anything`), { code: 'group_preparation_kept' });
  const summary = f.turns().read(f.device, { view: 'summary', groupId: f.groupId }) as any;
  assert.equal(summary.drafts, 1); assert.equal(summary.rounds, 0);
  assert.equal(JSON.stringify(f.store.snapshot(f.device)).includes(saved.draft.id), false);
  assert.throws(() => groupPreparationQuery(new URLSearchParams(`groupId=${f.groupId}&groupId=${f.groupId}`)));
  assert.throws(() => groupPreparationQuery(new URLSearchParams(`groupId=${f.groupId}&send=true`)));
  for (const method of ['GET', 'POST']) assert(phoneRouteAllowed('/api/assistant/group-preparations', method));
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal(phoneRouteAllowed('/api/assistant/group-preparations', method), false);
  assert.equal(phoneRouteAllowed('/api/assistant/group-preparations/send', 'POST'), false);
  assert.deepEqual(f.capture(), before);
});
check('all preparation rows removed still leave a marked receipt that refuses backup and pre-write startup', f => {
  f.prepare(f.save('Original graph').draft);
  const before = f.store.captureBackup('before', { status: 'not-configured', notes: [] });
  const corrupt = structuredClone(before); corrupt.services = corrupt.services.filter(row => !row.id.startsWith(groupPreparationPrefix));
  assert.throws(() => Store.verifyBackup(corrupt), { code: 'backup_groups' });
  f.closeStore();
  const db = new DatabaseSync(join(f.directory, 'workspace.sqlite'));
  db.prepare('DELETE FROM service_records WHERE substr(id,1,?)=?').run(groupPreparationPrefix.length, groupPreparationPrefix); db.close();
  const bytes = readFileSync(join(f.directory, 'workspace.sqlite'));
  assert.throws(() => f.reopen(), /no retained event/);
  assert.deepEqual(readFileSync(join(f.directory, 'workspace.sqlite')), bytes);
});
check('current owner Profile is exact retained evidence and a later Profile edit does not replace it', f => {
  const originalProfile = { name: 'Owner', position: 'Writer', about: 'Private biography', appearance: null };
  const profile = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'profile',
    entityId: 'profile:owner', expectedRevision: 0, payload: originalProfile });
  const prepared = f.prepare(f.save('Owner provided text').draft);
  assert.equal(prepared.round.owner!.revision, profile.revision);
  assert.equal(prepared.round.context.sources.length, 0);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'profile', entityId: profile.id,
    expectedRevision: profile.revision, payload: { ...originalProfile, about: 'Later biography' } });
  f.closeStore(); f.reopen();
  assert.equal(f.store.readGroupPreparation(f.groupId).preparation.rounds.get(prepared.round.id)!.owner!.value.about, 'Private biography');
});
check('draft index is bounded, device-scoped and rejects stale page sequence without touching writing', f => {
  for (let index = 0; index < 33; index++) f.save(`Unfinished window ${index}`, { ...f.scope(), windowId: randomUUID() });
  const before = f.capture();
  const first = f.turns().read(f.device, { view: 'drafts', groupId: f.groupId, sequence: 33 }) as any;
  assert.equal(first.drafts.length, 32); assert.equal(first.total, 33); assert(first.next);
  const second = f.turns().read(f.device, { view: 'drafts', groupId: f.groupId, sequence: 33, after: first.next }) as any;
  assert.equal(second.drafts.length, 1); assert.equal(second.next, null);
  assert.equal(new Set([...first.drafts, ...second.drafts].map(row => row.id)).size, 33);
  const other = f.turns().read(randomUUID(), { view: 'drafts', groupId: f.groupId, sequence: 33 }) as any;
  assert.equal(other.drafts.length, 0);
  assert.throws(() => f.turns().read(f.device, { view: 'drafts', groupId: f.groupId, sequence: 32 }), { code: 'group_preparation_changed' });
  assert.deepEqual(f.capture(), before);
});
