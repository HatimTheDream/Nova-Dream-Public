import { z } from 'zod';
import { assistantGroupSchema, groupMemberSchema, groupEventSchema, type GroupEvent } from '../../../packages/domain/assistant-groups';

const uuid = z.string().uuid();
const groupSchema = z.object({ epoch: uuid, view: z.literal('group'), group: assistantGroupSchema,
  members: z.array(groupMemberSchema).max(32), historicalMembershipCount: z.number().int().nonnegative().max(320000) }).strict();
const historySchema = z.object({ epoch: uuid, view: z.literal('history'), groupId: uuid,
  revision: z.number().int().positive().max(10000), events: z.array(groupEventSchema).max(100),
  total: z.number().int().positive().max(10000), next: z.number().int().positive().max(10000).nullable() }).strict();
export type GroupDetail = z.infer<typeof groupSchema>;

/** A saved metadata reader. No automatic command, provider request or retry. */
export class GroupReader {
  detail?: GroupDetail;
  events: GroupEvent[] = [];
  historyRevision?: number;
  next?: number | null;
  busy = false;
  error = '';
  private serial = 0;
  constructor(readonly epoch: string, readonly groupId: string, private current: () => boolean) {}
  invalidate() { this.serial++; this.busy = false; }
  async load(get: (url: string) => Promise<unknown>) {
    if (!this.current() || this.busy) return false;
    this.busy = true; this.error = ''; const serial = ++this.serial;
    try {
      const value = groupSchema.parse(await get(`assistant/groups?view=group&groupId=${encodeURIComponent(this.groupId)}`));
      if (!this.current() || serial !== this.serial) return false;
      if (value.epoch !== this.epoch || value.group.id !== this.groupId
        || value.members.length !== value.group.activeMembershipIds.length
        || value.historicalMembershipCount < value.members.length
        || value.members.some((member, i) => member.groupId !== this.groupId || member.id !== value.group.activeMembershipIds[i])
        || new Set(value.members.map(member => member.agentId)).size !== value.members.length)
        throw Error('The saved Group membership could not be verified. Its previous view is kept.');
      this.detail = value;
      return true;
    } catch (error) { if (this.current() && serial === this.serial) this.error = error instanceof Error ? error.message : 'The saved Group is unavailable.'; return false; }
    finally { if (serial === this.serial) this.busy = false; }
  }
  async history(get: (url: string) => Promise<unknown>, more = false) {
    if (!this.current() || this.busy || !this.detail || more && !this.next) return false;
    this.busy = true; this.error = ''; const serial = ++this.serial;
    const revision = more ? this.historyRevision! : this.detail.group.revision, after = more ? this.next! : 0;
    try {
      const value = historySchema.parse(await get(`assistant/groups?view=history&groupId=${encodeURIComponent(this.groupId)}&revision=${revision}&after=${after}`));
      if (!this.current() || serial !== this.serial) return false;
      const last = value.events.at(-1)?.sequence ?? after;
      if (value.epoch !== this.epoch || value.groupId !== this.groupId || value.revision !== revision || value.total !== revision
        || !value.events.length || last > revision || value.events.some((event, i) => event.groupId !== this.groupId || event.sequence !== after + i + 1
          || event.command.groupId !== this.groupId || event.after.id !== this.groupId || event.after.revision !== event.sequence
          || event.after.lastEventId !== event.id)
        || value.next !== (last < revision ? last : null))
        throw Error('The original Group history changed. Its previous entries are kept.');
      const events = more ? [...this.events, ...value.events] : value.events;
      if (new Set(events.map(event => event.id)).size !== events.length)
        throw Error('The Group history contains a duplicate change. Its previous entries are kept.');
      this.events = events; this.historyRevision = revision; this.next = value.next;
      return true;
    } catch (error) { if (this.current() && serial === this.serial) this.error = error instanceof Error ? error.message : 'Group history is unavailable.'; return false; }
    finally { if (serial === this.serial) this.busy = false; }
  }
}
