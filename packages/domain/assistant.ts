import { assistantSpaceSchema, type AssistantSpace } from './assistant-space.js';
import type { WorkMode } from './work-mode.js';
import { z } from 'zod';
import type { Attachment } from './contracts.js';

export const permissionModeSchema = z.enum(['read-only', 'guarded', 'workspace', 'full']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const assistantRequestSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid() });
const refineSourceSchema = z.object({ outputId: z.string().uuid(), version: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const connectionSchema = assistantRequestSchema.extend({
  url: z.string().url().max(2048),
  token: z.string().max(8192).optional(),
}).strict();
export const createConversationSchema = assistantRequestSchema.extend({
  space: assistantSpaceSchema.optional(),
  autoTitle: z.boolean().optional(),
  title: z.string().trim().min(1).max(150), projectId: z.string().max(100).nullable(),
  model: z.string().max(150).optional(), thinking: z.string().max(30).optional(),
  fastMode: z.union([z.boolean(), z.literal('auto')]).optional(),
  permissionMode: permissionModeSchema.optional(),
  refineSource: refineSourceSchema.optional(),
}).strict();
export const submitSchema = assistantRequestSchema.extend({
  conversationId: z.string().uuid(), conversationRevision: z.number().int().positive(),
  draftId: z.string().max(200), draftRevision: z.number().int().positive(), projectRevision: z.number().int().nonnegative(),
}).strict();
export const enqueueSchema = submitSchema.extend({ automatic: z.boolean().optional() }).strict();
export const steerSchema = submitSchema.extend({ targetOperationId: z.string().uuid() }).strict();
export const conversationEditSchema = assistantRequestSchema.extend({
  conversationId: z.string().uuid(), expectedRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(150).optional(), archived: z.boolean().optional(),
  deleted: z.boolean().optional(), pinned: z.boolean().optional(), unread: z.boolean().optional(), projectId: z.string().max(100).nullable().optional(),
  model: z.string().max(150).nullable().optional(), thinking: z.string().max(30).nullable().optional(),
  fastMode: z.union([z.boolean(), z.literal('auto')]).nullable().optional(),
  permissionMode: permissionModeSchema.optional(),
}).strict();
export const recoverSettingsSchema = assistantRequestSchema.extend({ conversationId: z.string().uuid(), expectedRevision: z.number().int().positive(), pendingRequestId: z.string().uuid(), action: z.enum(['retry', 'use-current']) }).strict();
export const conversationAccountSchema = assistantRequestSchema.extend({ conversationId: z.string().uuid(), expectedRevision: z.number().int().positive(), profileId: z.string().min(1).max(200).nullable() }).strict();
export const resumeConversationSchema = assistantRequestSchema.extend({ conversationId: z.string().uuid(), expectedRevision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/), allowPartial: z.boolean().optional() }).strict();
export const recoverContinuationSchema = assistantRequestSchema.extend({ conversationId: z.string().uuid(), pendingRequestId: z.string().uuid() }).strict();
export const saveOutputSchema = assistantRequestSchema.extend({
  conversationId: z.string().uuid(), nativeId: z.string().uuid(), messageId: z.string().max(1000),
  messageHash: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(150),
}).strict();
export const forkConversationSchema = saveOutputSchema.omit({ name: true }).extend({ expectedRevision: z.number().int().positive(), purpose: z.enum(['branch', 'edit', 'retry']), text: z.string().max(100000).optional() }).strict();
export const artifactSourceSchema = saveOutputSchema.omit({ requestId: true, name: true }).extend({ artifactId: z.string().min(1).max(2000) }).strict();
export const saveArtifactSchema = saveOutputSchema.extend({ artifactId: z.string().min(1).max(2000) }).strict();
export const queueActionSchema = assistantRequestSchema.extend({ queueId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();
export const queueStateSchema = queueActionSchema.extend({ state: z.enum(['paused', 'removed']) }).strict();
export const queueEditSchema = queueActionSchema.extend({ input: z.string().max(100000) }).strict();
export const queueOrderSchema = assistantRequestSchema.extend({ conversationId: z.string().uuid(), items: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict()).max(50) }).strict();
export type AssistantConnection = {
  state: 'unconfigured' | 'connecting' | 'ready' | 'disconnected' | 'pairing' | 'error';
  url?: string; generation?: string; message: string; protocol?: number; methods: string[];
  pairingRequestId?: string; grantedScopes: string[]; modelAuthReady: boolean;
};
export type Conversation = {
  preferredAccountId?: string | null;
  accountSelection?: { profileId: string; label?: string; reason?: 'preferred' | 'backup'; selectedAt: string };
  pendingResume?: { requestId: string };
  resumeContext?: { transcript: Attachment; files: Attachment[]; digest: string; sourceNativeId: string; complete: boolean };
  space?: AssistantSpace;
  workspace?: { folder: string; environment: 'local' | 'worktree'; path?: string; branch?: string };
  id: string; revision: number; title: string; autoTitle?: boolean; autoTitleSeeded?: boolean; projectId: string | null; archived: boolean;
  deleted?: boolean; pinned?: boolean; unread?: boolean; permissionMode?: PermissionMode;
  model: string | null; thinking: string | null; createdAt: string; updatedAt: string;
  fastMode?: boolean | 'auto' | null;
  connectionGeneration: string; nativeKey: string; nativeId: string | null;
  state: 'creating' | 'ready' | 'unknown' | 'failed'; error?: string;
  settingsResult?: { requestId: string; state: 'completed' | 'rejected' | 'kept-current'; message?: string };
  pendingSettings?: { permissionMode?: PermissionMode; requestId: string; title?: string; archived?: boolean; deleted?: boolean; pinned?: boolean; unread?: boolean; projectId?: string | null; model?: string | null; thinking?: string | null; fastMode?: boolean | 'auto' | null };
  refineSource?: z.infer<typeof refineSourceSchema>;
  forkSource?: { conversationId: string; nativeId: string; messageId: string; messageHash: string; purpose: 'branch' | 'edit' | 'retry'; requestId: string; resolved?: boolean };
};
export type ConversationChanges = Partial<Pick<Conversation, 'title' | 'archived' | 'deleted' | 'pinned' | 'unread' | 'projectId' | 'model' | 'thinking' | 'fastMode' | 'permissionMode'>>;
export type ContextManifest = {
  /** Captured only for new Chat Research requests. Historical and Work research stay direct. */
  researchWorkflow?: 'chat-research-v1';
  planReview?: import('./assistant-plan.js').PlanReference & { previousProposal?: import('./assistant-plan.js').PlanProposal };
  approvedPlan?: import('./assistant-plan.js').PlanReference & { digest: string; proposal: import('./assistant-plan.js').PlanProposal };
  resumeDigest?: string;
  space?: AssistantSpace;
  memory?: import('./memory.js').MemorySnapshot;
  workMode?: WorkMode; messageVersion?: 2; brandVersion?: 1; planning?: true; goalReporting?: true;
  computerControlGuidance?: string;
  teamHandoffs?: { teamId: string; ids: string[] };
  teamReview?: import('./team-review.js').TeamReviewScope;
  project: { id: string; revision: number; name: string; purpose: string; instructions?: string; workspace?: { folder: string; environment: 'local' | 'worktree'; path?: string; branch?: string }; attachments?: Attachment[] } | null;
  attachments: Attachment[]; refineSource?: { outputId: string; version: number; sha256: string }; draftId: string; draftRevision: number; digest: string;
};
export type AssistantOperation = {
  effortDemand?: import('./auto-effort.js').EffortDemand;
  autoEffort?: import('./auto-effort.js').AutoEffortDecision;
  accountSelection?: Conversation['accountSelection'];
  plan?: import('./run-plan.js').RunStep[]; planSequence?: number;
  id: string; requestId: string; deviceId: string; epoch: string; conversationId: string;
  conversationRevision: number; connectionGeneration: string; nativeKey: string; nativeId: string;
  nativeRunId: string | null; state: 'prepared' | 'dispatching' | 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  input: string; context: ContextManifest; model: string | null; thinking: string | null;
  fastMode?: boolean | 'auto' | null;
  createdAt: string; updatedAt: string; settledAt?: string; text: string; lastSequence: number; error?: string;
  tools?: import('./tool-activity.js').ToolActivity[];
  /** Response-only hint for the current transient tool image; never a saved run update. */
  observationId?: string;
  cancelRequested?: boolean;
  steerTarget?: string;
  effectiveModel?: string; nativeTurnId?: string;
};
export type QueuedMessage = {
  effortDemand?: import('./auto-effort.js').EffortDemand;
  id: string; revision: number; deviceId: string; epoch: string;
  conversationId: string; nativeId: string; connectionGeneration: string;
  input: string; context: ContextManifest; model: string | null; thinking: string | null;
  fastMode?: boolean | 'auto' | null; position?: number;
  automatic?: boolean; autoRequestId?: string; autoError?: string;
  state: 'paused' | 'submitted' | 'removed'; operationId?: string; createdAt: string; updatedAt: string;
};
export type MessageAttachment = { artifactId?: string; name: string; mimeType?: string; type?: string; size?: number; localFile?: Attachment; availability?: 'local' | 'native-reference' | 'unavailable' };
export type ConversationMessage = {
  id: string; sequence?: number; role: 'user' | 'assistant' | 'system' | 'tool'; text: string;
  createdAt?: string; runId?: string; attachments: MessageAttachment[];
  textHash: string;
  toolInfo?: ReturnType<typeof import('./tool-activity.js').historyToolInfo>;
  authoredText?: string;
  /** Nova identity survives provider/runtime changes; native IDs remain compatible with old links. */
  novaId?: string; aliases?: string[]; operationId?: string;
  source?: { bindingId: string; nativeId: string; nativeKey: string; connectionGeneration: string; nativeMessageId?: string; kind: 'native' | 'operation' | 'voice' | 'legacy'; observedAt: string };
  delivery?: AssistantOperation['state'];
};
export type AssistantOutput = {
  id: string; version: number; parentOutputId?: string; conversationId: string; projectId: string | null; createdAt: string;
  nativeId: string; messageId: string; messageHash: string; runId?: string; text: string;
  name: string; uploadRequestId: string; file?: Attachment; state: 'prepared' | 'ready';
  artifactId?: string; artifactReference?: MessageAttachment; mimeType?: string; contentSha256?: string;
};
export type ConversationHistory = {
  conversationId: string; nativeId: string; messages: ConversationMessage[]; hasMore: boolean;
  retained?: { capturedAt?: string; complete: boolean };
  transcript?: { revision: number; savedMessages: number; complete: boolean; conflicts: number; unavailableAttachments: number; synchronizedAt?: string; bindingUnavailable?: boolean; bindings: { id: string; nativeId: string; complete: boolean; nextOffset?: number; status: 'partial' | 'capturing' | 'complete' | 'conflict'; observedAt: string }[] };
  offset?: number; totalMessages?: number; hasNewer?: boolean; nextOffset?: number; activeRunIds: string[] | null; inFlightRun?: { runId: string; text: string };
  routingContract?: string; leafEntryId?: string | null;
  nativeSettings?: { permissionModePending?: boolean; title?: string; archived?: boolean; pinned?: boolean; unread?: boolean; model?: string; thinking?: string; fastMode?: boolean | 'auto' | null; permissionMode?: 'read-only' | 'guarded' | 'workspace' | 'full' | null; lifecycleRevision?: number };
};
export type AssistantState = { plans?: import('./assistant-plan.js').AssistantPlan[]; removals?: import('./conversation-removal.js').ConversationRemoval[]; memory?: import('./memory.js').MemoryState; questions?: import('./questions.js').QuestionState; approvals?: import('./approvals.js').ApprovalState; connection: AssistantConnection; conversations: Conversation[]; operations: AssistantOperation[]; pins?: import('./message-pins.js').MessagePin[]; historyVersions?: Record<string, number>; queue?: QueuedMessage[] };
export type AssistantModel = { id: string; name: string; provider: string; reasoning?: string[]; available: boolean; isDefault?: boolean };
