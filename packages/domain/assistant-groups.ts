import { z } from 'zod';
import { canonical } from './contracts.js';
import { profileSchema } from './workspace-records.js';

export const groupPrefix = 'assistant:groups:';
export const groupLimit = 32;
export const groupEventLimit = 10000;
const uuid = z.string().uuid(), revision = z.number().int().min(0).max(groupEventLimit);
const agentId = z.string().regex(/^agent:[a-zA-Z0-9:_-]+$/).max(100);
const actor = z.object({ profileId: z.literal('profile:owner'), revision: z.number().int().nonnegative(),
  name: profileSchema.shape.name, appearance: profileSchema.shape.appearance.optional() }).strict();
const provenance = z.object({ requestId: uuid, epoch: uuid, deviceId: uuid }).strict();
const selectedAgent = z.object({ agentId, agentRevision: z.number().int().positive() }).strict();
const selectedAgents = z.array(selectedAgent).max(groupLimit).refine(rows => new Set(rows.map(row => row.agentId)).size === rows.length, 'Choose each agent once.');
const envelope = { requestId: uuid, epoch: uuid, groupId: uuid, expectedRevision: revision };
export const groupCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('create'), expectedRevision: z.literal(0),
    title: z.string().trim().min(1).max(150), projectId: z.string().min(1).max(100).nullable(),
    members: selectedAgents, defaultAgentId: agentId.nullable(), shareEarlierHistory: z.literal(false).default(false) }).strict(),
  z.object({ ...envelope, action: z.literal('rename'), title: z.string().trim().min(1).max(150) }).strict(),
  z.object({ ...envelope, action: z.literal('add-members'), members: selectedAgents.refine(rows => rows.length > 0),
    defaultAgentId: agentId.nullable(), shareEarlierHistory: z.literal(false).default(false) }).strict(),
  z.object({ ...envelope, action: z.literal('remove-member'), membershipId: uuid, replacementMembershipId: uuid.nullable() }).strict(),
  z.object({ ...envelope, action: z.literal('choose-default'), membershipId: uuid }).strict(),
  z.object({ ...envelope, action: z.literal('undo-removal'), removalEventId: uuid, agentRevision: z.number().int().positive(),
    defaultAgentId: agentId.nullable(), shareEarlierHistory: z.literal(false).default(false) }).strict(),
  z.object({ ...envelope, action: z.literal('set-archived'), archived: z.boolean() }).strict(),
  z.object({ ...envelope, action: z.literal('set-trashed'), trashed: z.boolean() }).strict(),
]);
export type GroupCommand = z.infer<typeof groupCommandSchema>;
export const assistantGroupSchema = z.object({
  format: z.literal(1), id: uuid, revision: revision.refine(value => value > 0), membershipRevision: revision.refine(value => value > 0),
  title: z.string().trim().min(1).max(150), projectId: z.string().min(1).max(100).nullable(),
  owner: z.literal('profile:owner'), createdBy: provenance, createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  activeMembershipIds: z.array(uuid).max(groupLimit).refine(ids => new Set(ids).size === ids.length),
  defaultMemberId: uuid.nullable(), defaultRevision: revision,
  archived: z.boolean(), trashed: z.boolean(), lastEventId: uuid,
}).strict().superRefine((value, context) => {
  if (value.activeMembershipIds.length ? !value.defaultMemberId || !value.activeMembershipIds.includes(value.defaultMemberId) : value.defaultMemberId !== null)
    context.addIssue({ code: 'custom', message: 'Choose an active default responder, or keep an empty Group without one.' });
  if (value.membershipRevision > value.revision || value.defaultRevision > value.revision)
    context.addIssue({ code: 'custom', message: 'The Group revisions do not match its history.' });
});
export type AssistantGroup = z.infer<typeof assistantGroupSchema>;
export const groupMemberSchema = z.object({
  format: z.literal(1), id: uuid, groupId: uuid, agentId, agentRevision: z.number().int().positive(),
  name: profileSchema.shape.name, appearance: profileSchema.shape.appearance,
  joinedBy: provenance, joinedAt: z.string().datetime(), joinEventId: uuid, joinedRevision: revision.refine(value => value > 0),
  history: z.object({ kind: z.literal('none-before-membership'), joinEventId: uuid }).strict(),
  restoresMembershipId: uuid.nullable(),
}).strict();
export type GroupMember = z.infer<typeof groupMemberSchema>;
export const groupEventSchema = z.object({
  format: z.literal(1), id: uuid, groupId: uuid, sequence: revision.refine(value => value > 0),
  command: groupCommandSchema, deviceId: uuid, at: z.string().datetime(), actor,
  before: assistantGroupSchema.nullable(), after: assistantGroupSchema,
  addedMembers: z.array(groupMemberSchema).max(groupLimit), removedMembershipIds: z.array(uuid).max(1),
  restoredDefault: z.boolean(),
}).strict();
export type GroupEvent = z.infer<typeof groupEventSchema>;
export type GroupBundle = { group: AssistantGroup | null; members: GroupMember[]; events: GroupEvent[] };
export type GroupCapture = { eventId: string; at: string; deviceId: string; actor: z.infer<typeof actor>; addedMembers: GroupMember[] };
export const groupKey = (id: string) => `${groupPrefix}group:${id}`;
export const groupMemberPrefix = (id: string) => `${groupPrefix}member:${id}:`;
export const groupMemberKey = (groupId: string, id: string) => groupMemberPrefix(groupId) + id;
export const groupEventPrefix = (id: string) => `${groupPrefix}event:${id}:`;
export const groupEventKey = (groupId: string, sequence: number) => groupEventPrefix(groupId) + String(sequence).padStart(5, '0');
export const groupIntent = (command: GroupCommand) => ({ type: 'assistant.group', ...command });
const need: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function groupReceipt(event: GroupEvent) {
  return { format: 1 as const, kind: 'assistant-group-receipt' as const,
    requestId: event.command.requestId, epoch: event.command.epoch, action: event.command.action,
    group: event.after, eventId: event.id, addedMembershipIds: event.addedMembers.map(member => member.id),
    restoredDefault: event.restoredDefault };
}
export type GroupReceipt = ReturnType<typeof groupReceipt>;
export const hasGroupReceipt = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'assistant-group-receipt';
type TransitionIndex = { members: ReadonlyMap<string, GroupMember>; events: ReadonlyMap<string, GroupEvent>; undone: ReadonlySet<string> };

/** Pure metadata transition. This cannot create a native session, reply, grant or assignment. */
export function changeGroup(bundle: GroupBundle, raw: GroupCommand, capture: GroupCapture): GroupEvent {
  return transitionGroup(bundle, raw, capture, { members: new Map(bundle.members.map(member => [member.id, member])),
    events: new Map(bundle.events.map(event => [event.id, event])),
    undone: new Set(bundle.events.flatMap(event => event.command.action === 'undo-removal' ? [event.command.removalEventId] : [])) });
}
function transitionGroup(bundle: GroupBundle, raw: GroupCommand, capture: GroupCapture, index: TransitionIndex): GroupEvent {
  const command = groupCommandSchema.parse(raw), before = bundle.group, sequence = (before?.revision ?? 0) + 1;
  need((before?.revision ?? 0) === command.expectedRevision, 'This Group changed. Review the current members before continuing.');
  need(sequence <= groupEventLimit, 'This Group has reached its retained history limit of 10,000 saved changes. Its history is kept.');
  need(command.action === 'create' ? before === null : before !== null, 'The original Group is unavailable or already exists.');
  need(!before || before.id === command.groupId, 'The Group identity changed.');
  const visibility = command.action === 'set-archived' || command.action === 'set-trashed';
  need(!before || visibility || !before.archived && !before.trashed, 'Restore this Group before changing its members.');
  const added = capture.addedMembers.map(member => groupMemberSchema.parse(member));
  const addedById = new Map(added.map(member => [member.id, member]));
  const memberById = (id: string) => addedById.get(id) ?? index.members.get(id);
  need(new Set(added.map(member => member.id)).size === added.length, 'A membership identity is duplicated.');
  for (const member of added) {
    need(!index.members.has(member.id) && member.groupId === command.groupId && member.joinEventId === capture.eventId
      && member.history.joinEventId === capture.eventId && member.joinedRevision === sequence && member.joinedAt === capture.at
      && same(member.joinedBy, { requestId: command.requestId, epoch: command.epoch, deviceId: capture.deviceId }),
    'A new membership does not match this original command.');
  }
  let active = [...(before?.activeMembershipIds ?? [])], defaultMemberId = before?.defaultMemberId ?? null;
  let defaultRevision = before?.defaultRevision ?? 0, membershipRevision = before?.membershipRevision ?? 0;
  let title = before?.title ?? '', projectId = before?.projectId ?? null;
  let archived = before?.archived ?? false, trashed = before?.trashed ?? false, restoredDefault = false;
  const removedMembershipIds: string[] = [];
  const activeAgents = () => active.map(id => { const member = memberById(id); need(member, 'An original membership is missing.'); return member.agentId; });
  const setDefault = (id: string | null) => { defaultMemberId = id; defaultRevision = sequence; };
  if (command.action === 'create' || command.action === 'add-members') {
    need(same(added.map(member => ({ agentId: member.agentId, agentRevision: member.agentRevision })), command.members)
      && added.every(member => member.restoresMembershipId === null), 'The selected agents changed before admission.');
    const oldAgents = activeAgents();
    need(added.every(member => !oldAgents.includes(member.agentId)), 'This agent is already a member.');
    const wasEmpty = active.length === 0;
    active.push(...added.map(member => member.id)); membershipRevision++;
    if (wasEmpty) {
      const chosen = added.find(member => member.agentId === command.defaultAgentId);
      need(active.length ? chosen : command.defaultAgentId === null, 'Choose the default responder explicitly.');
      setDefault(chosen?.id ?? null);
    } else need(command.defaultAgentId === null, 'Use Choose Default to change an existing responder.');
    if (command.action === 'create') { title = command.title; projectId = command.projectId; }
  } else if (command.action === 'undo-removal') {
    const removal = index.events.get(command.removalEventId);
    need(removal?.command.action === 'remove-member' && removal.groupId === command.groupId
      && !index.undone.has(removal.id),
    'This original removal is unavailable or was already undone.');
    const old = memberById(removal.command.membershipId), member = added[0];
    need(old && added.length === 1 && member.agentId === old.agentId && member.agentRevision === command.agentRevision
      && member.restoresMembershipId === old.id && !activeAgents().includes(member.agentId), 'The removed agent cannot be restored into this membership.');
    if (active.length === 0) {
      need(command.defaultAgentId === member.agentId, 'Choose the restored agent as default before reopening this empty Group.');
      setDefault(member.id);
    } else {
      need(command.defaultAgentId === null, 'Undo keeps a newer default choice.');
      if (removal.before?.defaultMemberId === old.id && defaultRevision === removal.after.defaultRevision) {
        setDefault(member.id); restoredDefault = true;
      }
    }
    active.push(member.id); membershipRevision++;
  } else {
    need(added.length === 0, 'This command cannot introduce a membership.');
    if (command.action === 'remove-member') {
      need(active.includes(command.membershipId), 'This original membership has already left.');
      active = active.filter(id => id !== command.membershipId); removedMembershipIds.push(command.membershipId); membershipRevision++;
      if (defaultMemberId === command.membershipId) {
        need(active.length ? command.replacementMembershipId && active.includes(command.replacementMembershipId) : command.replacementMembershipId === null,
          'Choose a remaining default responder before removing this member.');
        setDefault(command.replacementMembershipId);
      } else need(command.replacementMembershipId === null, 'Removing this member does not change the default responder.');
    } else if (command.action === 'choose-default') {
      need(active.includes(command.membershipId), 'Choose an active member.'); setDefault(command.membershipId);
    } else if (command.action === 'rename') title = command.title;
    else if (command.action === 'set-archived') {
      need(archived !== command.archived, 'The archive state already changed.'); archived = command.archived;
    } else { need(trashed !== command.trashed, 'The Trash state already changed.'); trashed = command.trashed; }
  }
  need(active.length <= groupLimit && new Set(activeAgents()).size === active.length, 'Choose at most 32 distinct active agents.');
  const after = assistantGroupSchema.parse({ format: 1, id: command.groupId, revision: sequence, membershipRevision, title, projectId,
    owner: 'profile:owner', createdBy: before?.createdBy ?? { requestId: command.requestId, epoch: command.epoch, deviceId: capture.deviceId },
    createdAt: before?.createdAt ?? capture.at, updatedAt: capture.at, activeMembershipIds: active, defaultMemberId, defaultRevision,
    archived, trashed, lastEventId: capture.eventId });
  return groupEventSchema.parse({ format: 1, id: capture.eventId, groupId: command.groupId, sequence, command, deviceId: capture.deviceId,
    at: capture.at, actor: capture.actor, before, after, addedMembers: added, removedMembershipIds, restoredDefault });
}

type RecordRow = { id: string; revision: number; value: unknown };
type ReceiptRow = { requestId: string; deviceId: string; digest: string; value: unknown };
/** Complete authority cross-check. No unsupported format, detached history, or missing receipt is ignored. */
export function verifyGroupRecords(schema: number, records: RecordRow[], receipts: ReceiptRow[], digest: (value: unknown) => string): Map<string, GroupBundle> {
  const rows = records.filter(row => row.id.startsWith(groupPrefix)), groups = new Map<string, GroupBundle>();
  const originals = receipts.filter(receipt => hasGroupReceipt(receipt.value));
  if (!rows.length && !originals.length) return groups;
  need(schema >= 57, 'Group authority requires workspace schema 57.');
  const byKey = new Map<string, unknown>(), byReceipt = new Map(receipts.map(row => [row.requestId, row]));
  need(byReceipt.size === receipts.length, 'An original receipt identity is duplicated.');
  const get = (id: string) => { let bundle = groups.get(id); if (!bundle) { bundle = { group: null, members: [], events: [] }; groups.set(id, bundle); } return bundle; };
  for (const row of rows) {
    need(!byKey.has(row.id), 'A Group record is duplicated.'); byKey.set(row.id, row.value);
    if (row.id.startsWith(groupPrefix + 'group:')) {
      const value = assistantGroupSchema.parse(row.value); need(row.id === groupKey(value.id) && row.revision === value.revision, 'The Group record identity or storage revision changed.'); get(value.id).group = value;
    } else if (row.id.startsWith(groupPrefix + 'member:')) {
      const value = groupMemberSchema.parse(row.value); need(row.id === groupMemberKey(value.groupId, value.id) && row.revision === 1, 'The immutable membership identity or storage revision changed.'); get(value.groupId).members.push(value);
    } else if (row.id.startsWith(groupPrefix + 'event:')) {
      const value = groupEventSchema.parse(row.value); need(row.id === groupEventKey(value.groupId, value.sequence) && row.revision === 1, 'The immutable Group event identity or storage revision changed.'); get(value.groupId).events.push(value);
    } else throw new Error('This Group record format is unsupported. Its saved history is unchanged.');
  }
  const requestIds = new Set<string>(), eventIds = new Set<string>();
  for (const [id, bundle] of groups) {
    need(bundle.group && bundle.events.length === bundle.group.revision, 'The complete Group history is unavailable.');
    bundle.events.sort((a, b) => a.sequence - b.sequence);
    const replay: GroupBundle = { group: null, members: [], events: [] };
    const index = { members: new Map<string, GroupMember>(), events: new Map<string, GroupEvent>(), undone: new Set<string>() };
    for (const event of bundle.events) {
      need(event.groupId === id && event.command.groupId === id && event.sequence === replay.events.length + 1
        && !requestIds.has(event.command.requestId) && !eventIds.has(event.id), 'The original Group command identity is duplicated or out of order.');
      requestIds.add(event.command.requestId); eventIds.add(event.id);
      const expected = transitionGroup(replay, event.command, { eventId: event.id, at: event.at, actor: event.actor,
        deviceId: event.deviceId, addedMembers: event.addedMembers }, index);
      need(same(expected, event), 'The saved Group transition differs from its original command.');
      const receipt = byReceipt.get(event.command.requestId);
      need(receipt && receipt.deviceId === event.deviceId && receipt.digest === digest(groupIntent(event.command))
        && same(receipt.value, groupReceipt(event)), 'The original Group receipt does not match its event.');
      replay.group = event.after; replay.members.push(...event.addedMembers); replay.events.push(event);
      for (const member of event.addedMembers) index.members.set(member.id, member);
      index.events.set(event.id, event);
      if (event.command.action === 'undo-removal') index.undone.add(event.command.removalEventId);
    }
    need(same(replay.group, bundle.group), 'The Group projection differs from its retained history.');
    const expectedMembers = new Map(replay.members.map(member => [member.id, member]));
    need(expectedMembers.size === bundle.members.length && bundle.members.every(member => same(expectedMembers.get(member.id), member)),
      'The Group membership records differ from their original joins.');
  }
  need(originals.every(receipt => requestIds.has(receipt.requestId)), 'An original Group receipt has no complete retained Group event.');
  return groups;
}
