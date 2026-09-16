import { createHash, randomUUID } from 'node:crypto';
import { activitySaveSchema, crmReadSchema, organizationSaveSchema, relationshipLabels, type ContactActivity, type CrmState, type KeepInTouchState, type OrganizationRecord } from '../../packages/domain/crm.js';
import { canonical } from '../../packages/domain/contracts.js';
import { contactDestination, contactOrganizations, organizationKey } from '../../packages/domain/contacts.js';
import { addDays } from '../../packages/domain/calendar.js';
import { reminderInstant, type ReminderSpec } from '../../packages/domain/reminders.js';
import { dayInZone } from '../../packages/domain/tasks.js';
import { Fault, Store } from './store.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
export function cadenceReminder(date: string, time: string, timezone: string): ReminderSpec {
  let value: ReminderSpec = { date, time, timezone, overlap: 'earlier' };
  for (let minute = 0; minute < 180; minute++) {
    if (reminderInstant(value).instant !== null) return value;
    const next = new Date(Date.parse(value.date + 'T' + value.time + ':00Z') + 60000).toISOString();
    value = { ...value, date: next.slice(0, 10), time: next.slice(11, 16) };
  }
  throw new Fault(400, 'invalid_reminder_time', 'Choose another reminder time for this timezone.');
}
export class ContactCrm {
  constructor(private store: Store, private now: () => number = Date.now) {}
  organizations(): OrganizationRecord[] {
    const saved = this.store.internalList<OrganizationRecord>('crm:organization:');
    const groups = new Map(saved.map(item => [organizationKey(item.value.name), { ...item, memberIds: [] as string[] }]));
    for (const contact of this.store.listEntities('contact').filter(c => !c.value.archived && !c.value.mergedInto)) for (const name of contactOrganizations(contact.value)) {
      const key = organizationKey(name), group = groups.get(key) ?? { id: 'organization:' + digest(key), revision: 0, updatedAt: '', deviceId: 'workspace', value: { name, website: '', phone: '', industry: '', notes: '' }, memberIds: [] };
      group.memberIds.push(contact.id); groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => a.value.name.localeCompare(b.value.name, undefined, { sensitivity: 'base' }));
  }
  saveOrganization(device: string, raw: unknown): OrganizationRecord {
    const command = organizationSaveSchema.parse(raw);
    return this.store.admit(device, command, { type: 'crm.organization', ...command }, () => {
      if (!command.id.startsWith('organization:')) throw new Fault(400, 'invalid_target', 'Choose an organization.');
      const groups = this.organizations(), current = groups.find(g => g.id === command.id);
      if ((current?.revision ?? 0) !== command.expectedRevision) throw new Fault(409, 'organization_changed', 'This organization changed. Your edits are kept.');
      if (groups.some(g => g.id !== command.id && organizationKey(g.value.name) === organizationKey(command.value.name))) throw new Fault(409, 'organization_exists', 'An organization with this name already exists. Open its page instead.');
      if (groups.length >= 2000 && !current) throw new Fault(507, 'quota', 'The organization directory is full.');
      if (current && current.value.name !== command.value.name) for (const contact of this.store.listEntities('contact')) {
        const matches = (s: string) => organizationKey(s) === organizationKey(current.value.name);
        if (!contactOrganizations(contact.value).some(matches) || contact.value.mergedInto) continue;
        this.store.reviseContact(device, contact.id, { ...contact.value, organization: matches(contact.value.organization) ? command.value.name : contact.value.organization, otherOrganizations: contact.value.otherOrganizations?.map(s => matches(s) ? command.value.name : s) }, contact.revision);
      }
      const record: OrganizationRecord = { id: command.id, revision: command.expectedRevision + 1, updatedAt: new Date(this.now()).toISOString(), deviceId: current?.deviceId ?? device, value: command.value, memberIds: current?.memberIds ?? [] };
      this.store.internalWrite('crm:organization:' + record.id, record);
      this.store.internalWrite(`crm:organization-history:${record.id}:${record.revision}`, record);
      return record;
    }).value;
  }
  saveActivity(device: string, raw: unknown): ContactActivity {
    const command = activitySaveSchema.parse(raw);
    const result = this.store.admit(device, command, { type: 'crm.activity', ...command }, () => {
      const original = this.store.readEntity('contact', command.contactId), contact = original?.value.mergedInto ? this.store.readEntity('contact', contactDestination(original.id, this.store.listEntities('contact'))) : original, current = this.store.internalRead<ContactActivity>('crm:activity:' + command.id);
      if (!command.id.startsWith('activity:') || !contact || contact.value.archived || contact.value.mergedInto) throw new Fault(409, 'contact_changed', 'Open an active contact to log an interaction.');
      if ((current?.revision ?? 0) !== command.expectedRevision || (current && current.contactId !== command.contactId)) throw new Fault(409, 'activity_changed', 'This activity changed. Review its saved version.');
      if (Date.parse(command.value.at) > this.now() + 60000) throw new Fault(400, 'invalid_activity_date', 'Log a past interaction. Schedule future work in Tasks or Calendar.');
      if (!current && this.store.internalList('crm:activity:').length >= 10000) throw new Fault(507, 'quota', 'The activity log is full. Existing entries are kept.');
      const record: ContactActivity = { id: command.id, contactId: command.contactId, revision: command.expectedRevision + 1, deviceId: current?.deviceId ?? device, updatedAt: new Date(this.now()).toISOString(), value: command.value };
      this.store.internalWrite('crm:activity:' + record.id, record);
      this.store.internalWrite(`crm:activity-history:${record.id}:${record.revision}`, record);
      return record;
    }).value;
    this.tick(); return result;
  }
  read(_device: string, raw: unknown): CrmState {
    const input = crmReadSchema.parse(raw);
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Reopen Contacts after workspace recovery.');
    this.tick();
    const contacts = this.store.listEntities('contact'), selected = contacts.find(c => c.id === input.contactId);
    if (input.contactId && !selected) throw new Fault(404, 'contact_missing', 'This contact is unavailable.');
    const resolve = (id: string) => contactDestination(id, contacts), id = selected ? resolve(selected.id) : undefined;
    const family = new Set(contacts.filter(c => resolve(c.id) === id).map(c => c.id));
    const relationships: CrmState['relationships'] = [];
    if (id) for (const contact of contacts.filter(c => !c.value.archived)) for (const relation of contact.value.relationships ?? []) {
      const target = resolve(relation.contactId), source = resolve(contact.id);
      if (source === target) continue;
      if (source === id) relationships.push({ contactId: target, kind: relation.kind, incoming: false, label: relationshipLabels[relation.kind] });
      else if (target === id) relationships.push({ contactId: source, kind: relation.kind, incoming: true, label: relation.kind === 'introduced_by' ? 'Introduced' : relation.kind === 'reports_to' ? 'Manages' : 'Works with' });
    }
    return { organizations: this.organizations(), activities: id ? this.store.internalList<ContactActivity>('crm:activity:').filter(a => family.has(a.contactId)).sort((a, b) => b.value.at.localeCompare(a.value.at)).slice(0, 500) : [], cadence: id ? this.store.internalRead<KeepInTouchState>('crm:cadence:' + id) : undefined, relationships: [...new Map(relationships.map(r => [r.label + ':' + r.contactId, r])).values()] };
  }
  /** Keep-in-touch reminders are ordinary shared Tasks, using the existing reminder and Calendar authority. */
  tick() {
    const contacts = this.store.listEntities('contact'), activities = this.store.internalList<ContactActivity>('crm:activity:');
    this.store.internalAtomic(() => {
      for (const contact of contacts) {
        const key = 'crm:cadence:' + contact.id, state = this.store.internalRead<KeepInTouchState>(key);
        const task = state?.taskId ? this.store.readEntity('task', state.taskId) : undefined;
        if (!contact.value.keepInTouch || contact.value.archived || contact.value.mergedInto) {
          if (state) { if (task && !['done', 'skipped'].includes(task.value.status) && !task.value.trashed && task.value.reminder) this.store.reviseCrmTask('crm', task.id, { ...task.value, reminder: undefined }); this.store.internalDelete(key); }
          continue;
        }
        const family = new Set(contacts.filter(c => contactDestination(c.id, contacts) === contact.id).map(c => c.id));
        const logged = activities.filter(a => family.has(a.contactId) && !a.value.archived && a.value.kind !== 'note').map(a => a.value.at).sort().at(-1);
        const completed = task?.value.status === 'done' && task.id !== state?.completedTask ? task.updatedAt : undefined;
        const lastInteraction = [logged, completed, state?.completedAt].filter((v): v is string => !!v).sort().at(-1);
        const preference = contact.value.keepInTouch, configuredAt = state?.configuredAt ?? new Date(this.now()).toISOString();
        const signature = canonical({ preference, lastInteraction: lastInteraction ?? configuredAt, completedTask: completed ? task?.id : state?.completedTask, archived: contact.value.archived });
        if (state?.signature === signature) continue;
        const nextDate = addDays(dayInZone(preference.timezone, Date.parse(lastInteraction ?? configuredAt)), preference.days);
        const taskId = !task || ['done', 'skipped'].includes(task.value.status) || task.value.trashed ? 'task:crm:' + randomUUID() : task.id;
        this.store.reviseCrmTask('crm', taskId, { ...(task?.id === taskId ? task.value : { title: 'Keep in touch: ' + contact.value.name, notes: '', status: 'open' as const, bucket: 'anytime' as const, projectId: contact.value.projectId, origin: { kind: 'contact' as const, id: contact.id, revision: contact.revision } }), planned: nextDate, due: nextDate, reminder: cadenceReminder(nextDate, preference.time, preference.timezone) });
        this.store.internalWrite(key, { configuredAt, signature, lastInteraction, nextDate, taskId, completedTask: completed ? task?.id : state?.completedTask, completedAt: completed ?? state?.completedAt } satisfies KeepInTouchState);
      }
    });
  }
}
