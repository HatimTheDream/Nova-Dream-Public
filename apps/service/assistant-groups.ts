import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assistantGroupSchema, groupCommandSchema, groupPrefix, groupKey, changeGroup, groupReceipt,
  type GroupBundle, type GroupMember } from '../../packages/domain/assistant-groups.js';
import { Fault, Store } from './store.js';

const uuid = z.string().uuid();
const querySchema = z.discriminatedUnion('view', [
  z.object({ view: z.literal('groups'), after: uuid.optional() }).strict(),
  z.object({ view: z.literal('group'), groupId: uuid }).strict(),
  z.object({ view: z.literal('history'), groupId: uuid, revision: z.coerce.number().int().positive().max(10000),
    after: z.coerce.number().int().nonnegative().max(10000).default(0) }).strict(),
  z.object({ view: z.literal('request'), groupId: uuid, requestId: uuid }).strict(),
]);
export function groupReadQuery(params: URLSearchParams) {
  const raw: Record<string, string> = { view: 'groups' };
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (seen.has(key)) throw new Fault(400, 'group_query', 'Use each Group query field once.');
    seen.add(key); raw[key] = value;
  }
  return querySchema.parse(raw);
}

/** Owner workspace metadata only. No Gateway, agent dispatch or assignment dependency. */
export class AssistantGroups {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}
  private bundle(id: string): GroupBundle {
    try { return this.store.readAssistantGroup(id); }
    catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(409, 'group_unreadable', 'This saved Group cannot be verified. Its original membership and history are kept unchanged.');
    }
  }
  read(device: string, raw: unknown) {
    const input = querySchema.parse(raw);
    return this.store.internalAtomic(() => {
      if (input.view === 'groups') {
        if (input.after && this.store.internalRead(groupKey(input.after)) === undefined)
          throw new Fault(409, 'group_list_changed', 'Refresh the Group list before continuing.');
        const rows = this.store.internalPage<unknown>(groupPrefix + 'group:', input.after ? groupKey(input.after) : '', 101);
        const page = rows.slice(0, 100).map(row => {
          const group = assistantGroupSchema.safeParse(row.value);
          if (!group.success || row.id !== groupKey(group.data.id))
            throw new Fault(409, 'group_unreadable', 'A saved Group needs review. The original list is kept.');
          return group.data;
        });
        return { epoch: this.store.epoch, view: input.view, groups: page, next: rows.length > 100 ? page.at(-1)!.id : null };
      }
      const bundle = this.bundle(input.groupId), group = bundle.group;
      if (!group) throw new Fault(404, 'group_missing', 'This Group is unavailable.');
      if (input.view === 'request') {
        const event = bundle.events.find(event => event.command.requestId === input.requestId && event.deviceId === device);
        if (!event) throw new Fault(404, 'group_request_missing', 'This device has no admitted original request with that identity.');
        return { epoch: this.store.epoch, view: input.view, receipt: groupReceipt(event) };
      }
      if (input.view === 'group') {
        const byId = new Map(bundle.members.map(member => [member.id, member]));
        return { epoch: this.store.epoch, view: input.view, group,
          members: group.activeMembershipIds.map(id => byId.get(id)!), historicalMembershipCount: bundle.members.length };
      }
      if (input.revision !== group.revision || input.after > group.revision)
        throw new Fault(409, 'group_history_changed', 'The Group changed. Refresh its history before continuing.');
      const events = []; let bytes = 0;
      for (const event of bundle.events.slice(input.after, input.after + 100)) {
        const size = Buffer.byteLength(JSON.stringify(event));
        if (size > 1024 * 1024) throw new Fault(409, 'group_history_bound', 'This original history entry exceeds the supported read bound.');
        if (events.length && bytes + size > 1024 * 1024) break;
        events.push(event); bytes += size;
      }
      const last = events.at(-1)?.sequence ?? input.after;
      return { epoch: this.store.epoch, view: input.view, groupId: group.id, revision: group.revision,
        events, total: group.revision, next: last < group.revision ? last : null };
    });
  }
  save(device: string, raw: unknown) {
    const command = groupCommandSchema.parse(raw);
    try {
      return this.store.admitAssistantGroup(device, command, bundle => {
        // This exact code is a fresh-request rejection before any write. Existing
        // original receipts bypass prepare and must still reconcile unchanged.
        if ((bundle.group?.revision ?? 0) !== command.expectedRevision)
          throw new Fault(409, 'group_revision_changed', 'This Group changed. Review its saved members before making a new change.');
        const visibility = command.action === 'set-archived' || command.action === 'set-trashed';
        const projectId = command.action === 'create' ? command.projectId : bundle.group?.projectId;
        if (!visibility && projectId && (!this.store.readEntity('project', projectId) || this.store.projectIsDeleted(projectId)))
          throw new Fault(409, 'group_project_unavailable', 'Restore the original Project before changing this Group.');
        const selected = command.action === 'create' || command.action === 'add-members' ? command.members
          : command.action === 'undo-removal' ? (() => {
            const removal = bundle.events.find(event => event.id === command.removalEventId);
            const id = removal?.command.action === 'remove-member' ? removal.command.membershipId : undefined;
            const member = bundle.members.find(member => member.id === id);
            if (!member) throw new Fault(409, 'group_removal_missing', 'The original removed membership is unavailable.');
            return [{ agentId: member.agentId, agentRevision: command.agentRevision }];
          })() : [];
        const eventId = randomUUID(), at = this.now().toISOString(), profile = this.store.readEntity('profile', 'profile:owner');
        const originalMember = command.action === 'undo-removal'
          ? bundle.events.find(event => event.id === command.removalEventId)?.removedMembershipIds[0] ?? null : null;
        const addedMembers: GroupMember[] = selected.map(selected => {
          const agent = this.store.readEntity('agent', selected.agentId);
          if (!agent || agent.value.archived || agent.revision !== selected.agentRevision)
            throw new Fault(409, 'group_agent_changed', 'A selected agent changed or is unavailable. Review the current agent before adding it.');
          return { format: 1, id: randomUUID(), groupId: command.groupId, agentId: agent.id, agentRevision: agent.revision,
            name: agent.value.name, appearance: structuredClone(agent.value.appearance),
            joinedBy: { requestId: command.requestId, epoch: command.epoch, deviceId: device }, joinedAt: at,
            joinEventId: eventId, joinedRevision: (bundle.group?.revision ?? 0) + 1,
            history: { kind: 'none-before-membership', joinEventId: eventId }, restoresMembershipId: originalMember };
        });
        return changeGroup(bundle, command, { eventId, at, deviceId: device, addedMembers,
          actor: { profileId: 'profile:owner', revision: profile?.revision ?? 0, name: profile?.value.name ?? 'You',
            ...(profile ? { appearance: structuredClone(profile.value.appearance) } : {}) } });
      });
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(409, 'group_changed', error instanceof Error ? error.message : 'The original Group could not be changed safely.');
    }
  }
}
