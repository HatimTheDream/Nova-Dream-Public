import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { ContactCrm, cadenceReminder } from '../apps/service/contact-crm.js';
import { blankRecord, type Contact } from '../packages/domain/workspace-records.js';
import type { Entity } from '../packages/domain/contracts.js';
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'e3-crm-')); let store = new Store(directory), now = Date.parse('2026-09-12T16:00:00Z');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const save = (id: string, patch: Partial<Contact> = {}) => { const current = store.readEntity('contact', id); return store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'contact', entityId: id, expectedRevision: current?.revision ?? 0, payload: { ...blankRecord('contact', 'America/Los_Angeles'), name: 'Mina', ...current?.value, ...patch } }) as Entity<Contact>; };
  return { get store() { return store; }, get crm() { return new ContactCrm(store, () => now); }, save, time: (date: string) => now = Date.parse(date), restart() { store.close(); store = new Store(directory); } };
}
test('organization pages project all memberships and rename atomically with replay, conflict and history preservation', t => {
  const f = fixture(t); f.save('contact:a', { organization: 'Northstar', otherOrganizations: ['Harbor'], notes: 'Keep this private' }); f.save('contact:b', { organization: 'Other', otherOrganizations: ['northstar'] });
  const org = f.crm.organizations().find(o => o.value.name.toLowerCase() === 'northstar')!; assert.deepEqual([...org.memberIds].sort(), ['contact:a', 'contact:b']);
  const cmd = { requestId: randomUUID(), epoch: f.store.epoch, id: org.id, expectedRevision: 0, value: { ...org.value, name: 'Northstar Studio', website: 'https://example.test', notes: 'Shared briefing' } };
  const saved = f.crm.saveOrganization('owner', cmd); assert.equal(saved.revision, 1); assert.equal(f.store.readEntity('contact', 'contact:a')?.value.organization, 'Northstar Studio'); assert.deepEqual(f.store.readEntity('contact', 'contact:b')?.value.otherOrganizations, ['Northstar Studio']);
  assert.equal(f.store.readEntityVersion('contact', 'contact:a', 1)?.value.organization, 'Northstar'); assert.equal(f.store.readEntity('contact', 'contact:a')?.value.notes, 'Keep this private');
  f.restart(); assert.deepEqual(f.crm.saveOrganization('owner', cmd), saved); assert.equal(f.store.readEntity('contact', 'contact:a')?.revision, 2);
  assert.throws(() => f.crm.saveOrganization('owner', { ...cmd, requestId: randomUUID() }), /changed/);
  assert.throws(() => f.crm.saveOrganization('owner', { ...cmd, requestId: randomUUID(), expectedRevision: 1, value: { ...cmd.value, name: 'Harbor' } }), /already exists/);
  assert.equal(f.store.readEntity('contact', 'contact:a')?.revision, 2);
});
test('activity chronology, correction, archive and replay survive restart and contact combination', t => {
  const f = fixture(t), a = f.save('contact:a'), b = f.save('contact:b');
  const cmd = { requestId: randomUUID(), epoch: f.store.epoch, id: 'activity:' + randomUUID(), contactId: b.id, expectedRevision: 0, value: { kind: 'call', at: '2026-09-11T16:00:00Z', text: 'Discussed workshop', archived: false } };
  const activity = f.crm.saveActivity('owner', cmd); f.restart(); assert.deepEqual(f.crm.saveActivity('owner', cmd), activity);
  f.store.mergeContacts('owner', { requestId: randomUUID(), epoch: f.store.epoch, keep: { id: a.id, revision: 1 }, other: { id: b.id, revision: 1 }, fields: {}, notes: 'both' });
  assert.equal(f.crm.read('owner', { epoch: f.store.epoch, contactId: a.id }).activities[0].id, activity.id);
  const corrected = f.crm.saveActivity('owner', { ...cmd, requestId: randomUUID(), expectedRevision: 1, value: { ...cmd.value, text: 'Corrected meeting note', archived: true } }); assert.equal(corrected.contactId, b.id);
  assert.equal(f.crm.read('owner', { epoch: f.store.epoch, contactId: a.id }).activities[0].value.archived, true);
  assert.throws(() => f.crm.saveActivity('owner', { ...cmd, requestId: randomUUID(), expectedRevision: 2, value: { ...cmd.value, at: '2027-01-01T00:00:00Z' } }), /past interaction/);
});
test('keep-in-touch uses one shared Task, reschedules after interaction, retains completed work, and stops on disable', t => {
  const f = fixture(t), person = f.save('contact:a', { keepInTouch: { days: 30, time: '09:00', timezone: 'America/Los_Angeles' } }); f.crm.tick();
  let state = f.crm.read('owner', { epoch: f.store.epoch, contactId: person.id }).cadence!;
  const first = state.taskId!; assert.equal(state.nextDate, '2026-10-12'); assert.equal(f.store.readEntity('task', first)?.value.reminder?.time, '09:00');
  f.restart(); f.crm.tick(); assert.equal(f.store.listEntities('task').length, 1); assert.equal(f.store.readEntity('task', first)?.revision, 1);
  f.time('2026-09-20T16:00:00Z'); const note = { requestId: randomUUID(), epoch: f.store.epoch, id: 'activity:' + randomUUID(), contactId: person.id, expectedRevision: 0, value: { kind: 'note', text: 'Internal thought', at: '2026-09-20T15:00:00Z', archived: false } };
  f.crm.saveActivity('owner', note); assert.equal(f.crm.read('owner', { epoch: f.store.epoch, contactId: person.id }).cadence?.nextDate, '2026-10-12');
  f.crm.saveActivity('owner', { ...note, requestId: randomUUID(), id: 'activity:' + randomUUID(), value: { ...note.value, kind: 'meeting' } });
  state = f.crm.read('owner', { epoch: f.store.epoch, contactId: person.id }).cadence!; assert.equal(state.nextDate, '2026-10-20'); assert.equal(state.taskId, first);
  const task = f.store.readEntity('task', first)!; f.store.internalAtomic(() => f.store.reviseCrmTask('owner', first, { ...task.value, status: 'done' })); f.crm.tick();
  assert.equal(f.store.listEntities('task').length, 2); assert.equal(f.store.readEntity('task', first)?.value.status, 'done');
  state = f.crm.read('owner', { epoch: f.store.epoch, contactId: person.id }).cadence!; const next = state.taskId!; assert.notEqual(next, first); f.crm.tick(); assert.equal(f.store.listEntities('task').length, 2);
  f.save(person.id, { keepInTouch: null }); f.crm.tick(); assert.equal(f.store.readEntity('task', next)?.value.reminder, undefined); assert.equal(f.store.readEntity('task', first)?.value.status, 'done');
});
test('relationship inverses resolve combined people and old forms preserve the new CRM fields', t => {
  const f = fixture(t); f.save('contact:a'); f.save('contact:b'); f.save('contact:c');
  const a = f.save('contact:a', { pipelineStage: 'active', keepInTouch: { days: 14, time: '08:00', timezone: 'UTC' }, relationships: [{ kind: 'introduced_by', contactId: 'contact:b' }, { kind: 'reports_to', contactId: 'contact:c' }] });
  assert.equal(f.crm.read('owner', { epoch: f.store.epoch, contactId: 'contact:b' }).relationships[0].label, 'Introduced'); assert.equal(f.crm.read('owner', { epoch: f.store.epoch, contactId: 'contact:c' }).relationships[0].label, 'Manages');
  const { pipelineStage, keepInTouch, relationships, ...legacy } = a.value;
  f.store.mutate('owner', { requestId: randomUUID(), epoch: f.store.epoch, kind: 'contact', entityId: a.id, expectedRevision: a.revision, payload: { ...legacy, name: 'Mina renamed' } });
  assert.equal(f.store.readEntity('contact', a.id)?.value.pipelineStage, 'active'); assert.deepEqual(f.store.readEntity('contact', a.id)?.value.relationships, relationships);
  assert.throws(() => f.save('contact:a', { relationships: [{ kind: 'works_with', contactId: 'contact:a' }] }), /relationship/);
  assert.throws(() => f.save('contact:a', { relationships: [{ kind: 'works_with', contactId: 'contact:missing' }] }), /relationship/);
});

test('keep-in-touch handles daylight-saving gaps and repeated times deterministically', () => {
  assert.equal(cadenceReminder('2027-03-14', '02:30', 'America/Los_Angeles').time, '03:00');
  assert.equal(cadenceReminder('2026-11-01', '01:30', 'America/Los_Angeles').overlap, 'earlier');
});
