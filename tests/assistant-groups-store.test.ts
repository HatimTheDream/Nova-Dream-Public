import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Store } from '../apps/service/store.js';
import { AssistantGroups, groupReadQuery } from '../apps/service/assistant-groups.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import { changeGroup, groupCommandSchema, groupKey, groupPrefix, type GroupBundle } from '../packages/domain/assistant-groups.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';
import { DatabaseSync } from 'node:sqlite';

function fixture() {
  const parent = resolve('.tmp-qa/assistant-groups-store'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'case-')); let store = new Store(directory), open = true;
  const device = store.session().deviceId, groupId = randomUUID();
  const groups = () => new AssistantGroups(store, () => new Date('2026-10-20T13:00:00.000Z'));
  const capture = () => { const { id: _id, createdAt: _at, ...value } = store.captureBackup('groups-fixture', { status: 'not-configured', notes: [] }); return value; };
  const input = (patch: object = {}) => groupCommandSchema.parse({ requestId: randomUUID(), epoch: store.epoch, groupId,
    expectedRevision: 0, action: 'create', title: 'A Retained Group', projectId: null, members: [], defaultAgentId: null, ...patch });
  function agent(id = 'agent:one', name = 'Aster') {
    const current = store.readEntity('agent', id);
    return store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'agent', entityId: id,
      expectedRevision: current?.revision ?? 0, payload: { ...(current?.value ?? blankRecord('agent', 'UTC')), name, position: 'Research Partner' } });
  }
  return { get store() { return store; }, directory, device, groupId, groups, capture, input, agent,
    restart() { store.close(); open = false; store = new Store(directory); open = true; },
    close(passed: boolean) { if (open) store.close(); assert(resolve(directory).startsWith(parent + sep)); if (passed) rmSync(directory, { recursive: true }); else console.error('Preserved failed Group fixture:', directory); } };
}
function check(name: string, run: (f: ReturnType<typeof fixture>) => void) {
  test(name, () => { const f = fixture(); let passed = false; try { run(f); passed = true; } finally { f.close(passed); } });
}
check('missing and empty Group reads are pure and exact phone policy adds no neighboring authority', f => {
  const before = f.capture();
  assert.deepEqual(f.groups().read(f.device, { view: 'groups' }), { epoch: f.store.epoch, view: 'groups', groups: [], next: null });
  assert.throws(() => f.groups().read(f.device, { view: 'group', groupId: f.groupId }), { code: 'group_missing' });
  assert.deepEqual(f.capture(), before);
  for (const method of ['GET', 'POST']) assert(phoneRouteAllowed('/api/assistant/groups', method));
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal(phoneRouteAllowed('/api/assistant/groups', method), false);
  for (const suffix of ['/', '/dispatch', '-grant', '?view=group']) assert.equal(phoneRouteAllowed('/api/assistant/groups' + suffix, 'POST'), false);
  assert.throws(() => groupReadQuery(new URLSearchParams('view=groups&view=group')));
  assert.throws(() => groupReadQuery(new URLSearchParams('view=groups&permission=full')));
});
check('one original command admits atomically and replay never changes a later Group or original capture', f => {
  const a = f.agent(), before = f.capture();
  const input = f.input({ members: [{ agentId: a.id, agentRevision: a.revision }], defaultAgentId: a.id });
  const made = f.groups().save(f.device, input); assert.equal(made.group.revision, 1);
  const renamed = f.groups().save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, groupId: f.groupId,
    expectedRevision: 1, action: 'rename', title: 'New Group Title' });
  f.agent(a.id, 'Changed Agent'); const saved = f.capture(); f.restart();
  assert.deepEqual(f.groups().save(f.device, input), made);
  assert.deepEqual(f.groups().read(f.device, { view: 'request', groupId: f.groupId, requestId: input.requestId }),
    { epoch: f.store.epoch, view: 'request', receipt: made });
  assert.equal(f.store.readAssistantGroup(f.groupId).group!.title, renamed.group.title);
  assert.equal(f.store.readAssistantGroup(f.groupId).members[0].name, 'Aster');
  assert.throws(() => f.groups().save(randomUUID(), input), { code: 'request_reused' });
  assert.throws(() => f.groups().save(f.device, { ...input, title: 'Different Original' }), { code: 'request_reused' });
  assert.throws(() => f.groups().read(randomUUID(), { view: 'request', groupId: f.groupId, requestId: input.requestId }), { code: 'group_request_missing' });
  assert.deepEqual(f.capture(), saved);
  for (const key of ['files', 'references'] as const) assert.deepEqual(saved[key], before[key]);
  assert(saved.services.filter(row => row.id.startsWith(groupPrefix)).every(row => row.id.includes(':group:') ? row.revision === 2 : row.revision === 1));
});
check('current agents, exact revisions, original epoch and strict command shape refuse without a receipt', f => {
  const a = f.agent(); f.agent(a.id, 'New Revision');
  const stale = f.input({ members: [{ agentId: a.id, agentRevision: a.revision }], defaultAgentId: a.id });
  const before = f.capture();
  for (const input of [stale, { ...stale, members: [{ agentId: 'agent:missing', agentRevision: 1 }], defaultAgentId: 'agent:missing' },
    { ...f.input(), epoch: randomUUID() }, { ...f.input(), shareEarlierHistory: true }, { ...f.input(), grant: 'edit' }])
    assert.throws(() => f.groups().save(f.device, input));
  assert.deepEqual(f.capture(), before);
  const current = f.store.readEntity('agent', a.id)!;
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'agent', entityId: a.id,
    expectedRevision: current.revision, payload: { ...current.value, archived: true } });
  const archived = f.capture();
  assert.throws(() => f.groups().save(f.device, f.input({ members: [{ agentId: a.id, agentRevision: 3 }], defaultAgentId: a.id })), /unavailable/);
  assert.deepEqual(f.capture(), archived);
});
check('current Project deletion prevents changes but preserves Archive, Trash and restoration', f => {
  const project = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'project',
    entityId: 'project:group-context', expectedRevision: 0, payload: { name: 'Context', purpose: 'Saved context' } });
  f.groups().save(f.device, f.input({ projectId: project.id }));
  f.store.organizeProject(f.device, { requestId: randomUUID(), epoch: f.store.epoch, projectId: project.id,
    projectRevision: project.revision, expectedRevision: 0, action: 'delete' });
  const before = f.capture();
  assert.throws(() => f.groups().save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, groupId: f.groupId,
    expectedRevision: 1, action: 'rename', title: 'Unavailable' }), { code: 'group_project_unavailable' });
  assert.deepEqual(f.capture(), before);
  const archived = f.groups().save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, groupId: f.groupId,
    expectedRevision: 1, action: 'set-archived', archived: true });
  assert.equal(archived.group.projectId, project.id);
  assert.equal(f.groups().save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, groupId: f.groupId,
    expectedRevision: 2, action: 'set-archived', archived: false }).group.archived, false);
});
check('Store protects immutable records and rejects forged owner captures even through its lower-level admission', f => {
  const command = f.input(), before = f.capture();
  const capture = (bundle: GroupBundle) => changeGroup(bundle, command, { eventId: randomUUID(),
    at: '2026-10-20T13:00:00.000Z', deviceId: f.device, actor: { profileId: 'profile:owner', revision: 9, name: 'Pretend Owner' }, addedMembers: [] });
  assert.throws(() => f.store.admitAssistantGroup(f.device, command, capture), { code: 'group_owner_changed' });
  assert.deepEqual(f.capture(), before);
  f.groups().save(f.device, command); const saved = f.capture();
  for (const row of saved.services.filter(row => row.id.startsWith(groupPrefix))) {
    assert.throws(() => f.store.internalWrite(row.id, row.value), { code: 'group_original_required' });
    assert.throws(() => f.store.internalDelete(row.id), { code: 'group_history_kept' });
    assert.throws(() => f.store.internalBatch([{ id: row.id, value: row.value }]), { code: 'group_original_required' });
  }
  assert.deepEqual(f.capture(), saved);
});
check('a late local write failure rolls back the complete original command including receipts', f => {
  const input = f.input(), before = f.capture(), original = f.store.internalWrite;
  let written = 0;
  f.store.internalWrite = function<T>(id: string, value: T): T {
    original.call(this, id, value);
    if (id.startsWith(groupPrefix) && ++written === 2) throw new Error('Synthetic late write failure');
    return value;
  };
  try { assert.throws(() => f.groups().save(f.device, input), /Synthetic late write/); }
  finally { f.store.internalWrite = original; }
  assert.equal(written, 2); assert.deepEqual(f.capture(), before);
  assert.throws(() => f.groups().read(f.device, { view: 'request', groupId: f.groupId, requestId: input.requestId }), { code: 'group_missing' });
  assert.equal(f.groups().save(f.device, input).group.revision, 1, 'an explicit original after a known rolled-back refusal admits once');
});
check('maintenance and held or activated-paused recovery refuse effects while exact reads remain pure', f => {
  const made = f.groups().save(f.device, f.input());
  const command = { requestId: randomUUID(), epoch: f.store.epoch, groupId: f.groupId, expectedRevision: 1, action: 'rename', title: 'Paused' };
  f.store.setUpdateMaintenanceHeld(true); let before = f.capture();
  assert.throws(() => f.groups().save(f.device, command), { code: 'update_maintenance' });
  f.groups().read(f.device, { view: 'group', groupId: f.groupId }); assert.deepEqual(f.capture(), before);
  f.store.setUpdateMaintenanceHeld(false);
  for (const held of [true, false]) {
    f.store.internalWrite('recovery:state', { held, effectsPaused: true }); before = f.capture();
    assert.throws(() => f.groups().save(f.device, command), { code: 'recovery_held' });
    assert.deepEqual(f.groups().read(f.device, { view: 'request', groupId: f.groupId, requestId: made.requestId }).receipt, made);
    assert.deepEqual(f.capture(), before);
  }
});
check('full keyset pages and revision-bound history retain every exact original beyond 100 rows', f => {
  for (let i = 0; i < 104; i++) f.groups().save(f.device, f.input({ groupId: randomUUID(), title: 'Group ' + i }));
  const before = f.capture(), page = f.groups().read(f.device, { view: 'groups' }); assert.equal(page.groups!.length, 100); assert(page.next);
  const last = f.groups().read(f.device, { view: 'groups', after: page.next }); assert.equal(last.groups!.length, 4); assert.equal(last.next, null);
  assert.equal(new Set([...page.groups!, ...last.groups!].map(group => group.id)).size, 104);
  assert.deepEqual(f.capture(), before);
  f.groups().save(f.device, f.input());
  for (let revision = 1; revision < 103; revision++) f.groups().save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, groupId: f.groupId,
    expectedRevision: revision, action: 'rename', title: 'Revision ' + revision });
  const history = f.groups().read(f.device, { view: 'history', groupId: f.groupId, revision: 103 });
  assert.equal(history.events!.length, 100); assert.equal(history.next, 100);
  const tail = f.groups().read(f.device, { view: 'history', groupId: f.groupId, revision: 103, after: history.next });
  assert.equal(tail.events!.length, 3); assert.equal(tail.next, null);
  f.groups().save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, groupId: f.groupId, expectedRevision: 103, action: 'rename', title: 'A New Revision' });
  assert.throws(() => f.groups().read(f.device, { view: 'history', groupId: f.groupId, revision: 103, after: 100 }), { code: 'group_history_changed' });
});
check('complete backup verifier rejects changed Group storage revisions, receipts and foreign captures', f => {
  const a = f.agent(), made = f.groups().save(f.device, f.input({ members: [{ agentId: a.id, agentRevision: a.revision }], defaultAgentId: a.id }));
  const saved = f.store.captureBackup('fixture', { status: 'not-configured', notes: [] });
  const changes = [
    (value: typeof saved) => { value.services.find(row => row.id === groupKey(f.groupId))!.revision++; },
    (value: typeof saved) => { value.services.find(row => row.id.includes(':member:'))!.revision++; },
    (value: typeof saved) => { value.receipts = value.receipts.filter(row => row.requestId !== made.requestId); },
    (value: typeof saved) => { (value.services.find(row => row.id.includes(':member:'))!.value as any).groupId = randomUUID(); },
    (value: typeof saved) => { value.services = value.services.filter(row => !row.id.startsWith(groupPrefix)); },
  ];
  for (const change of changes) { const candidate = structuredClone(saved); change(candidate); assert.throws(() => Store.verifyBackup(candidate), { code: 'backup_groups' }); }
  assert.deepEqual(f.capture().services, saved.services);
});
check('orphaned persisted receipts cannot replay a phantom Group or pass actual Store reopen', f => {
  const input = f.input(); f.groups().save(f.device, input);
  // Deliberate corruption of this disposable synthetic fixture, bypassing the protected app writer.
  const database = new DatabaseSync(join(f.directory, 'workspace.sqlite'));
  database.prepare("DELETE FROM service_records WHERE substr(id,1,?)=?").run(groupPrefix.length, groupPrefix);
  const rows = () => database.prepare('SELECT request_id,digest,device_id,payload FROM receipts ORDER BY request_id').all();
  const originalReceipts = rows();
  assert.throws(() => f.groups().save(f.device, input), { code: 'group_original_unavailable' });
  assert.deepEqual(rows(), originalReceipts, 'refusal neither changes nor re-admits the original receipt');
  database.close();
  assert.throws(() => f.restart(), /receipt has no complete/);
});
