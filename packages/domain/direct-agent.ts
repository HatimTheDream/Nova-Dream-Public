import { z } from 'zod';
import { agentSchema, profileSchema, type AgentDesign, type PersonalProfile } from './workspace-records.js';
import { agentMayUse, agentModules, type AgentAccess } from './agent-capabilities.js';
import { canonical, type Entity } from './contracts.js';
import type { AssistantOperation, Conversation, ConversationMessage } from './assistant.js';
import { attachmentSchema } from './attachments.js';

const revision = /* @__PURE__ */ (() => (z.number().int().positive()))();
const uuid = /* @__PURE__ */ (() => (z.string().uuid()))();
const textId = /* @__PURE__ */ (() => (z.string().min(1).max(200)))();
export const directAgentRecipientSchema = /* @__PURE__ */ (() => (z.object({ agentId: z.string().regex(/^agent:[a-zA-Z0-9:_-]+$/).max(100), agentRevision: revision }).strict()))();
export const directAgentBindingSchema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), recipient: directAgentRecipientSchema, design: agentSchema,
  createdBy: z.object({ requestId: uuid, deviceId: textId, epoch: uuid }).strict(),
}).strict().refine(value => !value.design.archived, 'The original recipient must be an active saved agent.')))();
export type DirectAgentBinding = z.infer<typeof directAgentBindingSchema>;
export const directAgentNativeKey = (conversationId: string) => `agent:edition3-direct:e3:${conversationId}`;

const readAccessSchema = /* @__PURE__ */ (() => (z.partialRecord(z.enum(agentModules), z.literal('read'))))();
const turnSourcesSchema = /* @__PURE__ */ (() => (z.object({
  projectId: z.string().min(1).max(100).nullable(), projectRevision: z.number().int().nonnegative(),
  draftId: z.string().min(1).max(200), draftRevision: revision, attachments: z.array(attachmentSchema).max(10),
  projectAttachments: z.array(attachmentSchema).max(100),
}).strict().refine(value => value.projectId === null
  ? value.projectRevision === 0 && value.projectAttachments.length === 0
  : value.projectRevision > 0, 'Captured Project identity and revision must agree.')))();
export const directAgentTurnSchema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), recipient: directAgentRecipientSchema,
  conversationId: uuid, conversationRevision: revision, operationId: uuid, requestId: uuid,
  deviceId: textId, epoch: uuid,
  agent: z.object({ id: z.string(), revision, value: agentSchema }).strict(),
  profile: z.object({ id: z.literal('profile:owner'), revision, value: profileSchema }).strict().nullable(),
  native: z.object({ key: textId, id: uuid, generation: textId }).strict(),
  account: z.object({ profileId: textId, model: textId, identityKey: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  sources: turnSourcesSchema,
  readAccess: readAccessSchema, capturedAt: z.string().datetime(),
}).strict()))();
export type DirectAgentTurn = z.infer<typeof directAgentTurnSchema>;
export const directAgentAuthorSchema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), role: z.enum(['user', 'assistant']),
  conversationId: uuid, operationId: uuid, requestId: uuid, epoch: uuid,
  recordId: textId.nullable(), revision: revision.nullable(),
  name: z.string().min(1).max(240), appearance: profileSchema.shape.appearance,
}).strict()))();
export type DirectAgentAuthor = z.infer<typeof directAgentAuthorSchema>;

/** This is a read ceiling, never an execution permission or a native policy. */
export function directAgentReadAccess(original: AgentAccess, captured: AgentAccess, current: AgentAccess): AgentAccess {
  return Object.fromEntries(agentModules.filter(key => key !== 'computer' && key !== 'browser'
    && original[key] && captured[key] && current[key]).map(key => [key, 'read']));
}

export function captureDirectAgentBinding(recipient: z.infer<typeof directAgentRecipientSchema>, agent: Entity<AgentDesign> | undefined, createdBy: DirectAgentBinding['createdBy']): DirectAgentBinding {
  if (!agent || agent.id !== recipient.agentId || agent.revision !== recipient.agentRevision || agent.value.archived) throw Error('The exact saved agent changed or is unavailable.');
  return directAgentBindingSchema.parse({ format: 1, recipient, design: structuredClone(agent.value), createdBy });
}

/** Called only by a future qualified dedicated dispatcher with its actual
 * original operation, native session and selected account. It enables no route. */
export function captureDirectAgentTurn(conversation: Conversation, original: {
  id: string; requestId: string; deviceId: string; epoch: string;
  account: DirectAgentTurn['account']; sources: DirectAgentTurn['sources']; capturedAt: string;
}, agent: Entity<AgentDesign> | undefined, profile: Entity<PersonalProfile> | undefined): DirectAgentTurn {
  const binding = directAgentBindingSchema.parse(conversation.directAgent);
  if (conversation.space !== 'chat' || conversation.permissionMode !== 'read-only' || conversation.workspace
    || conversation.archived || conversation.deleted || conversation.pendingSettings || conversation.pendingResume || conversation.state !== 'ready'
    || !conversation.nativeId || conversation.nativeKey !== directAgentNativeKey(conversation.id) || !conversation.connectionGeneration
    || original.account.profileId !== conversation.accountSelection?.profileId || original.account.model !== conversation.model
    || original.sources.projectId !== conversation.projectId
    || !agent || agent.id !== binding.recipient.agentId || agent.value.archived || agent.revision < binding.recipient.agentRevision)
    throw Error('The direct-agent recipient or original session is unavailable.');
  return directAgentTurnSchema.parse({
    format: 1, recipient: binding.recipient, conversationId: conversation.id, conversationRevision: conversation.revision,
    operationId: original.id, requestId: original.requestId, deviceId: original.deviceId, epoch: original.epoch,
    agent: { id: agent.id, revision: agent.revision, value: structuredClone(agent.value) },
    profile: profile ? { id: profile.id, revision: profile.revision, value: structuredClone(profile.value) } : null,
    native: { key: conversation.nativeKey, id: conversation.nativeId, generation: conversation.connectionGeneration },
    account: original.account, sources: original.sources, readAccess: directAgentReadAccess(binding.design.access ?? {}, agent.value.access ?? {}, agent.value.access ?? {}),
    capturedAt: original.capturedAt,
  });
}

/** Historical captures remain tied to their original epoch, even in a held
 * restored copy. Live access separately requires the current workspace epoch. */
export function assertDirectAgentOperation(conversation: Conversation, operation: AssistantOperation): DirectAgentTurn {
  const binding = directAgentBindingSchema.parse(conversation.directAgent), capture = directAgentTurnSchema.parse(operation.context.directAgent);
  if (canonical(capture.recipient) !== canonical(binding.recipient) || capture.agent.id !== binding.recipient.agentId
    || capture.agent.value.archived || capture.agent.revision < binding.recipient.agentRevision
    || capture.epoch !== operation.epoch
    || capture.operationId !== operation.id || capture.requestId !== operation.requestId || capture.deviceId !== operation.deviceId
    || capture.conversationId !== conversation.id || capture.conversationId !== operation.conversationId
    || capture.conversationRevision !== operation.conversationRevision || capture.conversationRevision > conversation.revision
    // Once the conversation moves, its old turn keeps its captured Project.
    // At the captured revision, a different Project is never valid authority.
    || capture.conversationRevision === conversation.revision && capture.sources.projectId !== conversation.projectId
    || capture.native.key !== directAgentNativeKey(conversation.id) || capture.native.key !== operation.nativeKey
    || capture.native.id !== operation.nativeId || capture.native.generation !== operation.connectionGeneration
    || capture.account.profileId !== operation.accountSelection?.profileId || capture.account.model !== operation.model
    || capture.sources.projectId !== (operation.context.project?.id ?? null) || capture.sources.projectRevision !== (operation.context.project?.revision ?? 0)
    || capture.sources.draftId !== operation.context.draftId || capture.sources.draftRevision !== operation.context.draftRevision
    || canonical(capture.sources.attachments) !== canonical(operation.context.attachments)
    || canonical(capture.sources.projectAttachments) !== canonical(operation.context.project?.attachments ?? [])
    || canonical(capture.readAccess) !== canonical(directAgentReadAccess(binding.design.access ?? {}, capture.agent.value.access ?? {}, capture.agent.value.access ?? {}))
    || operation.context.memory || operation.context.planning || operation.context.computerControlGuidance
    || operation.context.teamHandoffs || operation.context.teamReview || operation.context.approvedPlan || operation.context.planReview
    || operation.context.workMode && operation.context.workMode !== 'chat') throw Error('The direct-agent turn does not match its original authority.');
  return capture;
}

/** Exact active origin is checked before AND after a read by a future adapter.
 * No caller can turn this result into permission to write or invoke a provider. */
export function directAgentMayRead(conversation: Conversation, operation: AssistantOperation, current: Entity<AgentDesign> | undefined,
  origin: { epoch: string; operationId: string; requestId: string; nativeKey: string; nativeId: string; generation: string; runId: string; accountId: string },
  name: string, input: Record<string, unknown>, write: boolean): boolean {
  try {
    const capture = assertDirectAgentOperation(conversation, operation);
    if (write || !current || current.id !== capture.agent.id || current.revision < capture.agent.revision || current.value.archived
      || conversation.archived || conversation.deleted || conversation.pendingSettings || conversation.pendingResume || conversation.state !== 'ready'
      || conversation.permissionMode !== 'read-only' || conversation.nativeKey !== capture.native.key || conversation.nativeId !== capture.native.id
      || conversation.connectionGeneration !== capture.native.generation || operation.cancelRequested || operation.steerTarget
      || conversation.projectId !== capture.sources.projectId
      || conversation.accountSelection?.profileId !== capture.account.profileId || conversation.model !== capture.account.model
      || !['dispatching', 'accepted', 'running'].includes(operation.state)
      || origin.epoch !== capture.epoch || origin.operationId !== operation.id || origin.requestId !== operation.requestId
      || origin.nativeKey !== operation.nativeKey || origin.nativeId !== operation.nativeId || origin.generation !== operation.connectionGeneration
      || !operation.nativeRunId || origin.runId !== operation.nativeRunId || origin.accountId !== capture.account.profileId) return false;
    const access = directAgentReadAccess(conversation.directAgent!.design.access ?? {}, capture.readAccess, current.value.access ?? {});
    // Deliberately no generic catalog, account listing, tools, computer/browser,
    // delegation, native actions or writes. Sources require exact captured files.
    if (name === 'sources.list' || name === 'sources.read') return false;
    if (!['records.list', 'records.read', 'calendar.read', 'inbox.read', 'profile.read'].includes(name)) return false;
    if (name.startsWith('records.') && input.kind === 'project'
      && (name !== 'records.read' || !capture.sources.projectId || input.id !== capture.sources.projectId)) return false;
    return agentMayUse(access, access, name, input, false);
  } catch { return false; }
}

export function directAgentMessageAuthor(conversation: Conversation, operation: AssistantOperation, role: 'user' | 'assistant'): DirectAgentAuthor | undefined {
  if (!conversation.directAgent && !operation.context.directAgent) return;
  const capture = assertDirectAgentOperation(conversation, operation);
  if (role === 'assistant' && !operation.nativeRunId) return;
  const record = role === 'assistant' ? capture.agent : capture.profile;
  return directAgentAuthorSchema.parse({
    format: 1, role, conversationId: conversation.id, operationId: operation.id, requestId: operation.requestId, epoch: operation.epoch,
    recordId: record?.id ?? null, revision: record?.revision ?? null, name: record?.value.name ?? 'You', appearance: record?.value.appearance ?? null,
  });
}

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export function hasDirectAgentAuthority(value: unknown): boolean {
  const row = object(value);
  return Object.hasOwn(row, 'directAgent') || Object.hasOwn(object(row.context), 'directAgent') || Object.hasOwn(object(row.message), 'author');
}
export function assertDirectAgentConversation(value: unknown) {
  const conversation = object(value);
  if (!Object.hasOwn(conversation, 'directAgent')) return;
  const binding = directAgentBindingSchema.parse(conversation.directAgent);
  if (!uuid.safeParse(conversation.id).success || conversation.space !== 'chat' || conversation.permissionMode !== 'read-only'
    || conversation.workspace || conversation.refineSource || conversation.forkSource
    || !revision.safeParse(conversation.revision).success
    || conversation.nativeKey !== directAgentNativeKey(conversation.id)
    || (conversation.nativeId === null ? conversation.connectionGeneration !== '' : !uuid.safeParse(conversation.nativeId).success || !textId.safeParse(conversation.connectionGeneration).success)
    || binding.createdBy.epoch.length === 0) throw Error('Invalid saved direct-agent conversation.');
}

/** Central persistence boundary: a generic save cannot strip, retarget or
 * rewrite captured authority. Explicit deletion retains its existing lifecycle. */
export function assertDirectAgentWrite(id: string, previous: unknown, value: unknown, read: (id: string) => unknown) {
  const before = object(previous), next = object(value);
  if (id.startsWith('assistant:conversation:')) {
    assertDirectAgentConversation(value);
    if (next.directAgent && id !== `assistant:conversation:${next.id}`) throw Error('The saved recipient key does not match its conversation.');
    if (Object.hasOwn(before, 'directAgent') && canonical(before.directAgent) !== canonical(next.directAgent)
      || !Object.hasOwn(before, 'directAgent') && Object.keys(before).length && Object.hasOwn(next, 'directAgent')) throw Error('A conversation recipient cannot be replaced.');
  }
  if (id.startsWith('assistant:operation:') || id.startsWith('assistant:queue:')) {
    const conversation = object(read(`assistant:conversation:${next.conversationId}`));
    if (conversation.directAgent || object(next.context).directAgent || object(before.context).directAgent) {
      if (id.startsWith('assistant:queue:')) throw Error('Direct-agent queued dispatch is not qualified.');
      if (id !== `assistant:operation:${next.id}`) throw Error('The captured turn key does not match its operation.');
      assertDirectAgentOperation(conversation as Conversation, next as AssistantOperation);
      if (Object.keys(before).length && (canonical(before.context) !== canonical(next.context) || before.input !== next.input)) throw Error('A captured direct-agent turn cannot be rewritten.');
    }
  }
  const message = object(next.message), priorMessage = object(before.message);
  if (id.startsWith('assistant:transcript:') && (message.author || priorMessage.author)) {
    const author = directAgentAuthorSchema.parse(message.author);
    const conversation = read(`assistant:conversation:${author.conversationId}`) as Conversation;
    const operation = read(`assistant:operation:${author.operationId}`) as AssistantOperation;
    if (!conversation || !operation || message.operationId !== operation.id || message.role !== author.role
      || id !== `assistant:transcript:${author.conversationId}:message:${next.key}`
      || message.source?.nativeId !== operation.nativeId || message.source?.nativeKey !== operation.nativeKey
      || message.source?.connectionGeneration !== operation.connectionGeneration
      || (message.runId !== undefined || author.role === 'assistant') && message.runId !== operation.nativeRunId
      || canonical(author) !== canonical(directAgentMessageAuthor(conversation, operation, author.role))
      || priorMessage.author && canonical(priorMessage.author) !== canonical(author)) throw Error('A saved message author does not match its original turn.');
  }
}

/** Rendering consumes the saved, server-validated identity, not current Profile
 * or agent records. This parser gives malformed imported display data no label. */
export function capturedMessageAuthor(message: ConversationMessage): DirectAgentAuthor | undefined {
  const author = directAgentAuthorSchema.safeParse(message.author);
  return author.success && author.data.role === message.role && author.data.operationId === message.operationId
    && (message.role !== 'assistant' || !!message.runId) ? author.data : undefined;
}

/** Schema 55 readers ignore these fields, so their presence in an older
 * archive is corruption, not a compatible additive extension. */
export function verifyDirectAgentRecords(schema: number, records: { id: string; value: unknown }[]) {
  const byId = new Map(records.map(record => [record.id, record.value]));
  for (const { id, value } of records) {
    if (hasDirectAgentAuthority(value) && schema < 56) throw Error('Direct-agent authority requires workspace schema 56.');
    assertDirectAgentWrite(id, undefined, value, key => byId.get(key));
  }
}
