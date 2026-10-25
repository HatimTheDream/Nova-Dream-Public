import { z } from 'zod';
import { canonical, taskSchema, projectSchema, layoutSchema } from './contracts.js';
import { routineSchema } from './tasks.js';
import { agentSchema, recordSchemas } from './workspace-records.js';
import { agentModules, agentMayUse } from './agent-capabilities.js';
import { groupMemberSchema, type GroupBundle, type GroupMember } from './assistant-groups.js';

const uuid = /* @__PURE__ */ (() => (z.string().uuid()))(), integer = /* @__PURE__ */ (() => (z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)))();
const revision = integer.min(1), sha = /* @__PURE__ */ (() => (z.string().regex(/^[a-f0-9]{64}$/)))();
const identity = /* @__PURE__ */ (() => (z.string().min(1).max(2000)))();
export const groupPreparationPrefix = 'assistant:group-preparation:';
export const groupPreparationLimit = 1000;
export const groupContextLimit = 256 * 1024;
export const groupPreparedRoundLimit = 1024 * 1024;
export const groupPreparationBytes = 64 * 1024 * 1024;
const sourceKind = /* @__PURE__ */ (() => (z.enum(['layout', 'task', 'project', 'routine', 'contact', 'content', 'profile'])))();
const sourceSchemas = { layout: layoutSchema, task: taskSchema, project: projectSchema, routine: routineSchema,
  contact: recordSchemas.contact, content: recordSchemas.content, profile: recordSchemas.profile };
export const groupSourceRefSchema = /* @__PURE__ */ (() => (z.object({ kind: sourceKind, id: identity, revision, sha256: sha }).strict()))();
export const groupHistoryRefSchema = /* @__PURE__ */ (() => (z.object({ roundId: uuid, sha256: sha }).strict()))();
export const groupResponseRefSchema = /* @__PURE__ */ (() => (z.object({ roundId: uuid, attemptId: uuid,
  terminalSequence: revision.max(64), terminalSha256: sha }).strict()))();
export const groupResponseCaptureSchema = /* @__PURE__ */ (() => (groupResponseRefSchema.extend({ sourceRoundSha256: sha,
  nativeTurnId: z.string().min(1).max(512), text: z.string().max(262144),
  author: z.object({ agentId: z.string().regex(/^agent:/).max(2000), agentRevision: revision,
    membershipId: uuid, name: z.string().max(200), position: z.string().max(200) }).strict(),
}).strict()))();
export type GroupResponseRef = z.infer<typeof groupResponseRefSchema>;
export type GroupResponseCapture = z.infer<typeof groupResponseCaptureSchema>;
const selectedMember = /* @__PURE__ */ (() => (z.object({ membershipId: uuid, agentRevision: revision }).strict()))();
export const groupDraftScopeSchema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), epoch: uuid, deviceId: uuid, windowId: uuid, groupId: uuid,
  groupRevision: revision, membershipRevision: revision, defaultRevision: revision,
  mode: z.enum(['default', 'selected', 'everyone']), recipients: z.array(selectedMember).min(1).max(32),
  project: z.object({ id: z.string().regex(/^project:/).max(2000), revision }).strict().nullable(),
}).strict()))();
const draftId = /* @__PURE__ */ (() => (z.string().regex(/^draft:group:[a-f0-9]{64}$/)))();
const groupDraftV1Schema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), id: draftId, revision, scope: groupDraftScopeSchema, text: z.string().max(20000),
  sources: z.array(groupSourceRefSchema).max(32), history: z.array(groupHistoryRefSchema).max(64),
  preparedRoundId: uuid.nullable(),
}).strict()))();
export const groupDraftSchema = /* @__PURE__ */ (() => (z.discriminatedUnion('format', [groupDraftV1Schema,
  groupDraftV1Schema.extend({ format: z.literal(2), responses: z.array(groupResponseRefSchema).max(32) }).strict(),
])))();
const rawDraft = /* @__PURE__ */ (() => (z.string().max(groupContextLimit)))();
const envelope = { requestId: uuid, epoch: uuid, groupId: uuid };
export const groupPreparationCommandSchema = /* @__PURE__ */ (() => (z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('save-draft'), scope: groupDraftScopeSchema,
    expectedRaw: rawDraft.nullable(), text: z.string().max(20000),
    sources: z.array(groupSourceRefSchema).max(32), history: z.array(groupHistoryRefSchema).max(64) }).strict(),
  z.object({ ...envelope, action: z.literal('save-draft-v2'), scope: groupDraftScopeSchema,
    expectedRaw: rawDraft.nullable(), text: z.string().max(20000), sources: z.array(groupSourceRefSchema).max(32),
    history: z.array(groupHistoryRefSchema).max(64), responses: z.array(groupResponseRefSchema).max(32) }).strict(),
  z.object({ ...envelope, action: z.literal('grant-history-v2'), expectedGroupRevision: revision,
    expectedSequence: integer.max(groupPreparationLimit), membershipId: uuid,
    throughSequence: revision.max(groupPreparationLimit), history: z.array(groupHistoryRefSchema).max(64),
    responses: z.array(groupResponseRefSchema).max(32) }).strict(),
  z.object({ ...envelope, action: z.literal('prepare'), draftId, expectedRaw: rawDraft,
    expectedSequence: integer.max(groupPreparationLimit) }).strict(),
  z.object({ ...envelope, action: z.literal('grant-history'), expectedGroupRevision: revision,
    expectedSequence: integer.max(groupPreparationLimit), membershipId: uuid,
    throughSequence: revision.max(groupPreparationLimit), history: z.array(groupHistoryRefSchema).min(1).max(64) }).strict(),
])))();
const agentCaptureSchema = /* @__PURE__ */ (() => (z.object({ id: z.string().regex(/^agent:/).max(2000), revision, value: agentSchema }).strict()))();
const ownerCaptureSchema = /* @__PURE__ */ (() => (z.object({ id: z.literal('profile:owner'), revision, value: recordSchemas.profile }).strict()))();
const sourceCaptureSchema = /* @__PURE__ */ (() => (groupSourceRefSchema.extend({ value: z.unknown() }).strict()))();
const preparedGroupRoundV1Schema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), id: uuid, groupId: uuid, sequence: revision.max(groupPreparationLimit),
  state: z.literal('prepared'), mode: z.literal('provided-context-only'), requestId: uuid, epoch: uuid,
  deviceId: uuid, at: z.string().datetime(), scope: groupDraftScopeSchema, draftId, draftRevision: revision,
  draftSha256: sha, text: z.string().min(1).max(20000), owner: ownerCaptureSchema.nullable(),
  recipients: z.array(z.object({ membership: groupMemberSchema, joined: agentCaptureSchema,
    captured: agentCaptureSchema, readModules: z.array(z.enum(agentModules)).max(agentModules.length),
    attempt: z.object({ id: uuid, state: z.literal('prepared') }).strict() }).strict()).min(1).max(32),
  context: z.object({ sources: z.array(sourceCaptureSchema).max(256),
    history: z.array(groupHistoryRefSchema).max(256), sha256: sha }).strict(),
}).strict()))();
export const preparedGroupRoundSchema = /* @__PURE__ */ (() => (z.discriminatedUnion('format', [preparedGroupRoundV1Schema,
  preparedGroupRoundV1Schema.extend({ format: z.literal(2), context: preparedGroupRoundV1Schema.shape.context.extend({
    responses: z.array(groupResponseCaptureSchema).max(256),
  }).strict() }).strict(),
])))();
const groupHistoryGrantV1Schema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), id: uuid, groupId: uuid, sequence: revision.max(groupPreparationLimit),
  groupRevision: revision, membershipId: uuid, throughSequence: revision.max(groupPreparationLimit),
  history: z.array(groupHistoryRefSchema).min(1).max(256), requestId: uuid, epoch: uuid, deviceId: uuid,
}).strict()))();
export const groupHistoryGrantSchema = /* @__PURE__ */ (() => (z.discriminatedUnion('format', [groupHistoryGrantV1Schema,
  groupHistoryGrantV1Schema.extend({ format: z.literal(2), responses: z.array(groupResponseRefSchema).max(256) }).strict(),
])))();
export const groupPreparationEventSchema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), id: uuid, groupId: uuid, sequence: revision.max(groupPreparationLimit),
  deviceId: uuid, at: z.string().datetime(), command: groupPreparationCommandSchema,
  draftRaw: rawDraft.nullable(), round: preparedGroupRoundSchema.nullable(), grant: groupHistoryGrantSchema.nullable(),
}).strict()))();
export const groupPreparationReceiptSchema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), kind: z.literal('assistant-group-preparation-receipt'),
  requestId: uuid, epoch: uuid, groupId: uuid, action: z.enum(['save-draft', 'save-draft-v2', 'prepare', 'grant-history', 'grant-history-v2']),
  eventId: uuid, sequence: revision, draftRaw: rawDraft.nullable(), roundId: uuid.nullable(), grantId: uuid.nullable(),
}).strict()))();
export type GroupDraftScope = z.infer<typeof groupDraftScopeSchema>;
export type GroupDraft = z.infer<typeof groupDraftSchema>;
export type GroupSourceRef = z.infer<typeof groupSourceRefSchema>;
export type GroupHistoryRef = z.infer<typeof groupHistoryRefSchema>;
export type GroupPreparationCommand = z.infer<typeof groupPreparationCommandSchema>;
/** Proof returned only after a synchronous preparation rejection and a complete
 * atomic absence check. It never represents a native operation or GET absence. */
export const groupPreparationRejectionSchema = /* @__PURE__ */ (() => (z.object({
  kind: z.literal('assistant-group-preparation-rejection'),
  command: groupPreparationCommandSchema,
}).strict()))();
export type PreparedGroupRound = z.infer<typeof preparedGroupRoundSchema>;
export type GroupHistoryGrant = z.infer<typeof groupHistoryGrantSchema>;
export type GroupPreparationEvent = z.infer<typeof groupPreparationEventSchema>;
export type GroupPreparationReceipt = z.infer<typeof groupPreparationReceiptSchema>;
export type GroupPreparationBundle = {
  events: GroupPreparationEvent[]; drafts: Map<string, string>; rounds: Map<string, PreparedGroupRound>;
  grants: GroupHistoryGrant[];
};
export type GroupPreparationAuthority = {
  group: GroupBundle;
  /** Exact saved entity revision. Never substitute a newer value for a missing historical revision. */
  saved(kind: string, id: string, revision: number): unknown | undefined;
  digest(value: unknown): string;
  /** Only the joined verifier/Store may resolve a complete original child. */
  response?(groupId: string, ref: GroupResponseRef): GroupResponseCapture | undefined;
};
export function emptyGroupPreparation(): GroupPreparationBundle {
  return { events: [], drafts: new Map(), rounds: new Map(), grants: [] };
}
function need(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function same(a: unknown, b: unknown) { return canonical(a) === canonical(b); }
function unique(values: string[], message: string) { need(new Set(values).size === values.length, message); }
export function preparationGroupPrefix(groupId: string) { return groupPreparationPrefix + uuid.parse(groupId) + ':'; }
export function preparationEventKey(groupId: string, sequence: number) {
  return preparationGroupPrefix(groupId) + 'event:' + revision.parse(sequence).toString().padStart(8, '0');
}
export function preparationRoundKey(groupId: string, id: string) { return preparationGroupPrefix(groupId) + 'round:' + uuid.parse(id); }
export function preparationGrantKey(groupId: string, id: string) { return preparationGroupPrefix(groupId) + 'grant:' + uuid.parse(id); }
export function preparationDraftKey(groupId: string, id: string) { return preparationGroupPrefix(groupId) + draftId.parse(id); }
export function groupDraftId(scope: GroupDraftScope, digest: GroupPreparationAuthority['digest']) {
  return 'draft:group:' + digest(groupDraftScopeSchema.parse(scope));
}
export function parseGroupDraft(raw: string): GroupDraft {
  need(new TextEncoder().encode(raw).byteLength <= groupContextLimit, 'This exact draft exceeds its supported byte bound.');
  const value = groupDraftSchema.parse(JSON.parse(rawDraft.parse(raw)));
  need(canonical(value) === raw, 'This original draft representation is unreadable. Its exact saved writing is kept.');
  return value;
}
export const groupPreparationIntent = (command: GroupPreparationCommand) => ({ type: 'assistant.group-preparation', ...command });
export function hasGroupPreparationReceipt(raw: unknown) {
  return !!raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'assistant-group-preparation-receipt';
}
export function groupPreparationReceipt(event: GroupPreparationEvent): GroupPreparationReceipt {
  return groupPreparationReceiptSchema.parse({ format: 1, kind: 'assistant-group-preparation-receipt',
    requestId: event.command.requestId, epoch: event.command.epoch, groupId: event.groupId, action: event.command.action,
    eventId: event.id, sequence: event.sequence, draftRaw: event.draftRaw, roundId: event.round?.id ?? null, grantId: event.grant?.id ?? null });
}
function groupAt(authority: GroupPreparationAuthority, groupId: string, at: number) {
  const event = authority.group.events[at - 1];
  need(event && event.sequence === at && event.groupId === groupId, 'The exact saved Group revision is unavailable.');
  return event.after;
}
export function validateGroupDraftScope(scope: GroupDraftScope, authority: GroupPreparationAuthority) {
  groupDraftScopeSchema.parse(scope);
  const group = groupAt(authority, scope.groupId, scope.groupRevision);
  need(!group.archived && !group.trashed && group.activeMembershipIds.length > 0, 'Restore this Group and choose its recipients first.');
  need(scope.membershipRevision === group.membershipRevision && scope.defaultRevision === group.defaultRevision
    && (scope.project?.id ?? null) === group.projectId, 'The exact Group scope changed.');
  const ids = scope.recipients.map(row => row.membershipId);
  unique(ids, 'An original recipient is duplicated.');
  need(ids.every(id => group.activeMembershipIds.includes(id)), 'An original recipient was not a member of this Group revision.');
  if (scope.mode === 'default') need(ids.length === 1 && ids[0] === group.defaultMemberId, 'Review the exact default responder.');
  if (scope.mode === 'everyone') need(same(ids, group.activeMembershipIds), 'Review the complete original recipient order.');
  if (scope.project) need(authority.saved('project', scope.project.id, scope.project.revision), 'The exact saved Project revision is unavailable.');
  for (const selected of scope.recipients) {
    const member = authority.group.members.find(member => member.id === selected.membershipId);
    need(member && authority.saved('agent', member.agentId, member.agentRevision)
      && authority.saved('agent', member.agentId, selected.agentRevision), 'An original agent design revision is unavailable.');
  }
  return group;
}
function sourceKey(source: GroupSourceRef) { return `${source.kind}:${source.id}:${source.revision}:${source.sha256}`; }
function validateSource(source: GroupSourceRef, authority: GroupPreparationAuthority) {
  const saved = authority.saved(source.kind, source.id, source.revision);
  need(saved !== undefined && authority.digest(saved) === source.sha256, 'An exact saved context source is unavailable or changed.');
  return sourceSchemas[source.kind].parse(saved);
}
/** Iterative, bounded closure. Sequence strictly decreases; no timestamps or implicit summaries. */
export function groupHistoryClosure(refs: GroupHistoryRef[], bundle: GroupPreparationBundle,
  beforeSequence: number, digest: GroupPreparationAuthority['digest']): PreparedGroupRound[] {
  const queue = [...refs], byId = new Map<string, PreparedGroupRound>();
  let traversed = 0;
  while (queue.length) {
    need(++traversed <= 4096, 'The selected history dependency graph exceeds its supported bound.');
    const ref = groupHistoryRefSchema.parse(queue.pop()), round = bundle.rounds.get(ref.roundId);
    need(round && round.sequence < beforeSequence && digest(round) === ref.sha256, 'An exact earlier Group input is unavailable.');
    if (byId.has(round.id)) continue;
    byId.set(round.id, round); need(byId.size <= 256, 'Choose at most 256 original Group history dependencies.');
    for (const child of round.context.history) {
      const original = bundle.rounds.get(child.roundId);
      need(original && original.sequence < round.sequence, 'A Group history dependency is cyclic or out of order.');
      queue.push(child);
    }
  }
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}
export function responseReference(value: GroupResponseRef): GroupResponseRef {
  return { roundId: value.roundId, attemptId: value.attemptId,
    terminalSequence: value.terminalSequence, terminalSha256: value.terminalSha256 };
}
/** Replies inherit the full input disclosure. A later completion clock cannot
 * turn pre-membership material into newly readable history. */
export function groupDisclosureClosure(history: GroupHistoryRef[], responses: GroupResponseRef[],
  bundle: GroupPreparationBundle, beforeSequence: number, authority: GroupPreparationAuthority) {
  type Edge = { before: number; history: GroupHistoryRef } | { before: number; response: GroupResponseRef };
  const queue: Edge[] = [...history.map(history => ({ before: beforeSequence, history })),
    ...responses.map(response => ({ before: beforeSequence, response }))];
  const rounds = new Map<string, PreparedGroupRound>(), replies = new Map<string, GroupResponseCapture>();
  let edges = 0;
  while (queue.length) {
    need(++edges <= 4096, 'The selected disclosure graph exceeds its supported bound.');
    const edge = queue.pop()!;
    if ('history' in edge) {
      const ref = groupHistoryRefSchema.parse(edge.history), round = bundle.rounds.get(ref.roundId);
      need(round && round.sequence < edge.before && authority.digest(round) === ref.sha256,
        'An exact earlier Group input is unavailable or out of order.');
      if (rounds.has(round.id)) continue;
      rounds.set(round.id, round); need(rounds.size <= 256, 'Choose at most 256 original input dependencies.');
      for (const history of round.context.history) queue.push({ before: round.sequence, history });
      if (round.format === 2) for (const response of round.context.responses) {
        const actual = authority.response?.(round.groupId, responseReference(response));
        need(actual && same(actual, response), 'An inherited completed reply changed or is unavailable.');
        queue.push({ before: round.sequence, response: responseReference(response) });
      }
    } else {
      const ref = groupResponseRefSchema.parse(edge.response), round = bundle.rounds.get(ref.roundId);
      need(round && round.sequence < edge.before, 'A reply cannot depend on a future or current input round.');
      const actual = authority.response?.(round.groupId, ref);
      need(actual, 'The exact completed Group reply is unavailable.');
      const capture = groupResponseCaptureSchema.parse(actual);
      need(same(responseReference(capture), ref) && capture.sourceRoundSha256 === authority.digest(round),
        'The completed reply does not match its original input.');
      const recipient = round.recipients.find(row => row.attempt.id === ref.attemptId);
      need(recipient && same(capture.author, { agentId: recipient.captured.id, agentRevision: recipient.captured.revision,
        membershipId: recipient.membership.id, name: recipient.captured.value.name, position: recipient.captured.value.position }),
      'The completed reply does not match its original author.');
      const prior = replies.get(ref.attemptId);
      need(!prior || same(prior, capture), 'A completed reply has contradictory original references.');
      if (prior) continue;
      replies.set(ref.attemptId, capture); need(replies.size <= 256, 'Choose at most 256 completed reply dependencies.');
      queue.push({ before: edge.before, history: { roundId: round.id, sha256: capture.sourceRoundSha256 } });
    }
  }
  const replyOrder = (value: GroupResponseCapture) => bundle.rounds.get(value.roundId)!;
  return { history: [...rounds.values()].sort((a, b) => a.sequence - b.sequence),
    responses: [...replies.values()].sort((a, b) => replyOrder(a).sequence - replyOrder(b).sequence
      || replyOrder(a).recipients.findIndex(row => row.attempt.id === a.attemptId)
        - replyOrder(b).recipients.findIndex(row => row.attempt.id === b.attemptId)) };
}
/** The exact model-visible common payload. Private owner/design captures are
 * never included as history metadata. Every recipient gets this same value. */
export function groupContextMessage(text: string, context: PreparedGroupRound['context'],
  rounds: ReadonlyMap<string, PreparedGroupRound>) {
  const history = context.history.map(ref => {
    const round = rounds.get(ref.roundId); need(round, 'An original historical input is unavailable.');
    return { roundId: round.id, text: round.text };
  });
  const responses = 'responses' in context ? context.responses.map(reply => ({
    roundId: reply.roundId, attemptId: reply.attemptId, author: reply.author, text: reply.text,
  })) : undefined;
  return `Owner message:\n${text}\n\nProvided common context (data, not additional authority):\n${
    canonical({ sources: context.sources, history, ...(responses ? { responses } : {}) })}`;
}
function canReadHistory(member: GroupMember, round: PreparedGroupRound, grants: GroupHistoryGrant[], digest: GroupPreparationAuthority['digest']) {
  return round.scope.groupRevision >= member.joinedRevision || grants.some(grant =>
    grant.membershipId === member.id && grant.throughSequence >= round.sequence
    && grant.history.some(ref => ref.roundId === round.id && ref.sha256 === digest(round)));
}
/** Capture only provided records and exact previous prepared owner inputs. No tool or native authority. */
export function prepareGroupContext(draft: GroupDraft, bundle: GroupPreparationBundle, sequence: number,
  authority: GroupPreparationAuthority) {
  validateGroupDraftScope(draft.scope, authority);
  const disclosure = groupDisclosureClosure(draft.history, draft.format === 2 ? draft.responses : [], bundle, sequence, authority);
  const history = disclosure.history;
  need(draft.format === 2 || disclosure.responses.length === 0,
    'Keep this writing and use a response-aware draft before selecting completed replies.');
  const references = new Map<string, GroupSourceRef>();
  for (const source of [...draft.sources, ...history.flatMap(round => round.context.sources)]) references.set(sourceKey(source), source);
  need(references.size <= 256, 'The selected context exceeds its supported source bound.');
  const sources = [...references.values()].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b))).map(source => ({
    kind: source.kind, id: source.id, revision: source.revision, sha256: source.sha256, value: validateSource(source, authority),
  }));
  const recipients = draft.scope.recipients.map(selected => {
    const membership = authority.group.members.find(member => member.id === selected.membershipId)!;
    const joined = { id: membership.agentId, revision: membership.agentRevision,
      value: agentSchema.parse(authority.saved('agent', membership.agentId, membership.agentRevision)) };
    const captured = { id: membership.agentId, revision: selected.agentRevision,
      value: agentSchema.parse(authority.saved('agent', membership.agentId, selected.agentRevision)) };
    need(membership.name === joined.value.name && same(membership.appearance, joined.value.appearance),
      'The original membership display does not match its exact joined agent design.');
    need(!joined.value.archived && !captured.value.archived, 'An original selected agent is unavailable.');
    need(history.every(round => canReadHistory(membership, round, bundle.grants, authority.digest)),
      'Earlier Group history has not been explicitly shared with every original recipient.');
    need(disclosure.responses.every(reply => {
      const original = bundle.rounds.get(reply.roundId)!;
      return original.scope.groupRevision >= membership.joinedRevision || bundle.grants.some(grant =>
        grant.format === 2 && grant.membershipId === membership.id && grant.throughSequence >= original.sequence
        && grant.responses.some(ref => same(ref, responseReference(reply))));
    }), 'Earlier completed replies have not been explicitly shared with every original recipient.');
    need(sources.every(source => agentMayUse(joined.value.access ?? {}, captured.value.access ?? {},
      'records.read', { kind: source.kind }, false)), 'The provided context is not readable by every original recipient.');
    const readModules = agentModules.filter(module => !['computer', 'browser'].includes(module)
      && joined.value.access?.[module] && captured.value.access?.[module]);
    return { membership, joined, captured, readModules };
  });
  const context = { sources, history: history.map(round => ({ roundId: round.id, sha256: authority.digest(round) })),
    ...(draft.format === 2 ? { responses: disclosure.responses } : {}) };
  need(new TextEncoder().encode(canonical({ text: draft.text, context,
    originalInputs: history.map(round => ({ id: round.id, text: round.text })) })).byteLength <= groupContextLimit,
    'The provided context is too large. Its original selection is kept.');
  const captured = { ...context, sha256: authority.digest(context) };
  if (draft.format === 2) need(new TextEncoder().encode(groupContextMessage(draft.text, captured, bundle.rounds)).byteLength <= 250000,
    'The selected common input exceeds the native message byte bound. Its writing is kept.');
  return { recipients, context: captured };
}
export type GroupPreparationCapture = { eventId: string; at: string; deviceId: string; roundId?: string;
  attemptIds?: string[]; grantId?: string; owner?: z.infer<typeof ownerCaptureSchema> | null };
export function changeGroupPreparation(bundle: GroupPreparationBundle, raw: GroupPreparationCommand,
  capture: GroupPreparationCapture, authority: GroupPreparationAuthority): GroupPreparationEvent {
  const command = groupPreparationCommandSchema.parse(raw), sequence = bundle.events.length + 1;
  need(sequence <= groupPreparationLimit, 'This Group has reached its 1,000 retained preparation changes. Its writing and history are kept.');
  need(command.groupId === authority.group.group?.id, 'The original Group is unavailable.');
  let draftRaw: string | null = null, round: PreparedGroupRound | null = null, grant: GroupHistoryGrant | null = null;
  if (command.action === 'save-draft' || command.action === 'save-draft-v2') {
    need(command.scope.epoch === command.epoch && command.scope.deviceId === capture.deviceId
      && command.scope.groupId === command.groupId, 'The original draft belongs to another workspace or device.');
    validateGroupDraftScope(command.scope, authority);
    const id = groupDraftId(command.scope, authority.digest), priorRaw = bundle.drafts.get(id) ?? null;
    need(priorRaw === command.expectedRaw, 'The exact original draft changed. Keep this writing and review its saved version.');
    const prior = priorRaw === null ? null : parseGroupDraft(priorRaw);
    unique(command.sources.map(sourceKey), 'A context source is duplicated.');
    unique(command.history.map(ref => ref.roundId), 'A history source is duplicated.');
    need(command.action === 'save-draft-v2' || prior?.format !== 2, 'A response-aware draft cannot be downgraded by an older save.');
    if (command.action === 'save-draft-v2') unique(command.responses.map(ref => ref.attemptId), 'A completed reply is duplicated.');
    need(!prior || !same([prior.format, prior.text, prior.sources, prior.history, prior.format === 2 ? prior.responses : null],
      [command.action === 'save-draft-v2' ? 2 : 1, command.text, command.sources, command.history,
        command.action === 'save-draft-v2' ? command.responses : null]),
      'This exact draft is already saved. Observe the original save instead.');
    draftRaw = canonical(groupDraftSchema.parse({ format: command.action === 'save-draft-v2' ? 2 : 1,
      id, revision: (prior?.revision ?? 0) + 1, scope: command.scope, text: command.text,
      sources: command.sources, history: command.history, preparedRoundId: null,
      ...(command.action === 'save-draft-v2' ? { responses: command.responses } : {}) }));
  } else if (command.action === 'prepare') {
    need(command.expectedSequence === bundle.events.length, 'The Group preparation history changed. Review it before preparing.');
    need(bundle.drafts.get(command.draftId) === command.expectedRaw, 'The exact original writing changed before preparation.');
    const draft = parseGroupDraft(command.expectedRaw);
    need(draft.id === command.draftId && draft.scope.deviceId === capture.deviceId && draft.scope.epoch === command.epoch
      && draft.scope.groupId === command.groupId && draft.id === groupDraftId(draft.scope, authority.digest),
    'The original draft scope does not match this preparation.');
    need(!draft.preparedRoundId && draft.text.trim(), 'This draft is empty or already has its original prepared round.');
    const context = prepareGroupContext(draft, bundle, sequence, authority);
    need(capture.roundId && capture.attemptIds?.length === context.recipients.length, 'Original preparation identities are missing.');
    unique(capture.attemptIds, 'An original child attempt is duplicated.');
    const owner = ownerCaptureSchema.nullable().parse(capture.owner);
    need(owner === null || same(owner.value, authority.saved('profile', owner.id, owner.revision)),
      'The exact saved owner Profile is unavailable.');
    round = preparedGroupRoundSchema.parse({ format: draft.format, id: capture.roundId, groupId: command.groupId, sequence,
      state: 'prepared', mode: 'provided-context-only', requestId: command.requestId, epoch: command.epoch,
      deviceId: capture.deviceId, at: capture.at, scope: draft.scope, draftId: draft.id, draftRevision: draft.revision,
      draftSha256: authority.digest(draft), text: draft.text, owner,
      recipients: context.recipients.map((recipient, index) => ({ ...recipient, attempt: { id: capture.attemptIds![index], state: 'prepared' } })),
      context: context.context });
    need(new TextEncoder().encode(canonical(round)).byteLength <= groupPreparedRoundLimit,
      'The selected agent designs and provided context exceed the supported prepared input size.');
    draftRaw = canonical({ ...draft, revision: draft.revision + 1, preparedRoundId: round.id });
  } else {
    need(command.expectedSequence === bundle.events.length && command.throughSequence <= bundle.events.length,
      'The original history selection changed.');
    const group = groupAt(authority, command.groupId, command.expectedGroupRevision);
    need(!group.archived && !group.trashed && group.activeMembershipIds.includes(command.membershipId),
      'Choose the exact active membership before sharing earlier history.');
    const disclosure = command.action === 'grant-history-v2'
      ? groupDisclosureClosure(command.history, command.responses, bundle, command.throughSequence + 1, authority)
      : { history: groupHistoryClosure(command.history, bundle, command.throughSequence + 1, authority.digest), responses: [] };
    const history = disclosure.history;
    need(history.length > 0 && capture.grantId, 'Select exact saved Group inputs to share.');
    grant = groupHistoryGrantSchema.parse({ format: command.action === 'grant-history-v2' ? 2 : 1, id: capture.grantId, groupId: command.groupId, sequence,
      groupRevision: command.expectedGroupRevision, membershipId: command.membershipId,
      throughSequence: command.throughSequence, history: history.map(round => ({ roundId: round.id, sha256: authority.digest(round) })),
      ...(command.action === 'grant-history-v2' ? { responses: disclosure.responses.map(responseReference) } : {}),
      requestId: command.requestId, epoch: command.epoch, deviceId: capture.deviceId });
  }
  if (draftRaw !== null) parseGroupDraft(draftRaw);
  return groupPreparationEventSchema.parse({ format: 1, id: capture.eventId, groupId: command.groupId,
    sequence, deviceId: capture.deviceId, at: capture.at, command, draftRaw, round, grant });
}
export function appendGroupPreparation(bundle: GroupPreparationBundle, event: GroupPreparationEvent) {
  bundle.events.push(event);
  if (event.draftRaw !== null) { const draft = parseGroupDraft(event.draftRaw); bundle.drafts.set(draft.id, event.draftRaw); }
  if (event.round) bundle.rounds.set(event.round.id, event.round);
  if (event.grant) bundle.grants.push(event.grant);
}
export function groupPreparationEntries(event: GroupPreparationEvent) {
  const entries: { id: string; revision: number; value: unknown }[] = [
    { id: preparationEventKey(event.groupId, event.sequence), revision: 1, value: event },
  ];
  if (event.draftRaw !== null) {
    const draft = parseGroupDraft(event.draftRaw);
    entries.push({ id: preparationDraftKey(event.groupId, draft.id), revision: draft.revision, value: { format: 1, id: draft.id, raw: event.draftRaw } });
  }
  if (event.round) entries.push({ id: preparationRoundKey(event.groupId, event.round.id), revision: 1, value: event.round });
  if (event.grant) entries.push({ id: preparationGrantKey(event.groupId, event.grant.id), revision: 1, value: event.grant });
  return entries;
}
type Row = { id: string; revision: number; value: unknown };
type Receipt = { requestId: string; deviceId: string; digest: string; value: unknown };
/** Complete retained graph. A marked receipt without its entire event graph always refuses. */
export function verifyGroupPreparations(schema: number, records: Row[], receipts: Receipt[],
  groups: Map<string, GroupBundle>, saved: GroupPreparationAuthority['saved'], digest: GroupPreparationAuthority['digest'],
  joined: { response?: GroupPreparationAuthority['response']; round?(round: PreparedGroupRound): void } = {}) {
  const rows = records.filter(row => row.id.startsWith(groupPreparationPrefix));
  const originals = receipts.filter(receipt => hasGroupPreparationReceipt(receipt.value));
  const bundles = new Map<string, GroupPreparationBundle>();
  if (!rows.length && !originals.length) return bundles;
  need(schema >= 58, 'Group preparation requires workspace schema 58.');
  const expected = new Map<string, Row>(), requests = new Set<string>(), identities = new Set<string>();
  const byReceipt = new Map(originals.map(row => [row.requestId, row]));
  need(byReceipt.size === originals.length, 'An original Group preparation receipt is duplicated.');
  const events = rows.filter(row => row.id.includes(':event:')).map(row => groupPreparationEventSchema.parse(row.value))
    .sort((a, b) => a.groupId.localeCompare(b.groupId) || a.sequence - b.sequence);
  const bytes = new Map<string, number>();
  for (const event of events) {
    const group = groups.get(event.groupId);
    need(group?.group, 'A prepared input has no complete original Group.');
    let bundle = bundles.get(event.groupId);
    if (!bundle) { bundle = emptyGroupPreparation(); bundles.set(event.groupId, bundle); }
    need(event.sequence === bundle.events.length + 1 && !requests.has(event.command.requestId),
      'The original Group preparation sequence is incomplete or duplicated.');
    const newIds = [event.id, ...(event.round ? [event.round.id, ...event.round.recipients.map(row => row.attempt.id)] : []),
      ...(event.grant ? [event.grant.id] : [])];
    unique(newIds, 'A Group preparation identity is duplicated.');
    need(newIds.every(id => !identities.has(id)), 'A retained Group preparation identity was reused.');
    newIds.forEach(id => identities.add(id)); requests.add(event.command.requestId);
    need(schema >= 59 || event.command.action !== 'save-draft-v2' && event.command.action !== 'grant-history-v2'
      && event.round?.format !== 2 && event.grant?.format !== 2
      && (event.draftRaw === null || parseGroupDraft(event.draftRaw).format === 1),
    'Completed reply preparation requires workspace schema 59.');
    const authority = { group, saved, digest, response: joined.response }, replay = changeGroupPreparation(bundle, event.command,
      { eventId: event.id, at: event.at, deviceId: event.deviceId, roundId: event.round?.id,
        attemptIds: event.round?.recipients.map(row => row.attempt.id), grantId: event.grant?.id, owner: event.round?.owner }, authority);
    need(same(replay, event), 'The prepared Group input differs from its exact original command or saved design.');
    const receipt = byReceipt.get(event.command.requestId);
    need(receipt && receipt.deviceId === event.deviceId && receipt.digest === digest(groupPreparationIntent(event.command))
      && same(receipt.value, groupPreparationReceipt(event)), 'An original Group preparation receipt is missing or changed.');
    for (const row of groupPreparationEntries(event)) expected.set(row.id, row);
    const size = (bytes.get(event.groupId) ?? 0) + new TextEncoder().encode(canonical(event)).byteLength;
    need(size <= groupPreparationBytes, 'This original Group preparation history exceeds its supported byte bound.');
    bytes.set(event.groupId, size); appendGroupPreparation(bundle, event);
    if (event.round) joined.round?.(event.round);
  }
  need(expected.size === rows.length && new Set(rows.map(row => row.id)).size === rows.length
    && rows.every(row => same(expected.get(row.id), row)), 'The complete saved Group preparation graph does not match its events.');
  need(originals.every(receipt => requests.has(receipt.requestId)), 'An original Group preparation receipt has no retained event.');
  return bundles;
}
