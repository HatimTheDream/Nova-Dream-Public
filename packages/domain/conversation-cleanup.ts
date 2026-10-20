import { z } from 'zod';
import { assistantSpace } from './assistant-space.js';
import type { Conversation } from './assistant.js';

export const conversationCleanupLimit = 500;
export const conversationCleanupActionSchema = z.enum(['archive', 'trash', 'restore']);
export const conversationCleanupScopeSchema = z.object({
  space: z.enum(['chat', 'work', 'all']),
  folder: z.enum(['active', 'archived', 'deleted', 'kept']),
  projectId: z.string().max(100).nullable().optional(),
  query: z.string().trim().max(300).default(''),
}).strict();
export type ConversationCleanupAction = z.infer<typeof conversationCleanupActionSchema>;
export type ConversationCleanupScope = z.infer<typeof conversationCleanupScopeSchema>;
const target = z.object({ id: z.uuid(), revision: z.number().int().positive() }).strict();
export const prepareConversationCleanupSchema = z.object({
  requestId: z.uuid(), epoch: z.uuid(), action: conversationCleanupActionSchema,
  scope: conversationCleanupScopeSchema,
  targets: z.array(target).min(1).max(conversationCleanupLimit)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Select each conversation once.').optional(),
}).strict();
export const decideConversationCleanupSchema = z.object({
  requestId: z.uuid(), epoch: z.uuid(), batchId: z.uuid(), expectedRevision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['apply', 'cancel', 'check']),
}).strict();
export type PrepareConversationCleanup = z.infer<typeof prepareConversationCleanupSchema>;
export type DecideConversationCleanup = z.infer<typeof decideConversationCleanupSchema>;
export type ConversationCleanupTarget = {
  id: string; revision: number; title: string; space: 'chat' | 'work'; projectId: string | null;
  archived: boolean; deleted: boolean;
};
export type ConversationCleanupOutcome = {
  id: string; state: 'pending' | 'applied' | 'blocked' | 'unconfirmed'; code?: string;
  revision?: number; nativeRestorePending?: boolean;
};
export type ConversationCleanupRemainder = {
  observedAt: string; verified: boolean; capturedRemaining: string[]; matchingCount?: number;
  newMatchingCount?: number; error?: string;
};
export type ConversationCleanupBatch = {
  format: 1; id: string; epoch: string; revision: number; digest: string;
  action: ConversationCleanupAction; scope: ConversationCleanupScope; mode: 'selected' | 'matching';
  createdAt: string; updatedAt: string;
  state: 'review' | 'applying' | 'complete' | 'partial' | 'unconfirmed' | 'cancelled';
  targets: ConversationCleanupTarget[]; outcomes: ConversationCleanupOutcome[];
  counts: { pending: number; applied: number; blocked: number; unconfirmed: number };
  remainder: ConversationCleanupRemainder; running: boolean;
};
export type ConversationCleanupSummary = Pick<ConversationCleanupBatch, 'id' | 'epoch' | 'revision' | 'action' | 'scope' | 'mode' | 'createdAt' | 'updatedAt' | 'state' | 'counts' | 'running'> & { count: number };

// Permanent removal has a separate, explicit review/decision contract. The
// reversible client must never interpret it as another visibility edit.
export const preparePermanentConversationCleanupSchema = prepareConversationCleanupSchema.extend({
  action: z.literal('remove'),
  scope: conversationCleanupScopeSchema.extend({ folder: z.literal('deleted') }),
});
export const decidePermanentConversationCleanupSchema = decideConversationCleanupSchema.extend({
  decision: z.enum(['start', 'continue_remaining', 'cancel']),
});
export type PreparePermanentConversationCleanup = z.infer<typeof preparePermanentConversationCleanupSchema>;
export type DecidePermanentConversationCleanup = z.infer<typeof decidePermanentConversationCleanupSchema>;
export type PermanentConversationCleanupOutcome = {
  id: string; state: 'pending' | 'applied' | 'blocked' | 'unconfirmed'; code?: string;
  chunkId?: string; removalId?: string;
};
export type PermanentConversationCleanupChunk = {
  id: string; decision: 'start' | 'continue_remaining'; startedAt: string; settledAt?: string;
  state: 'running' | 'closed' | 'unconfirmed'; itemIds: string[]; stopReason?: string;
};
export type PermanentConversationCleanupBatch = {
  format: 2; id: string; epoch: string; revision: number; digest: string; action: 'remove';
  scope: ConversationCleanupScope & { folder: 'deleted' }; mode: 'selected' | 'matching';
  createdAt: string; updatedAt: string;
  state: 'review' | 'applying' | 'complete' | 'partial' | 'unconfirmed' | 'cancelled';
  targets: ConversationCleanupTarget[]; outcomes: PermanentConversationCleanupOutcome[];
  chunks: PermanentConversationCleanupChunk[];
  counts: { pending: number; applied: number; blocked: number; unconfirmed: number };
  remainder: ConversationCleanupRemainder; running: boolean;
};
export type PermanentConversationCleanupSummary = Omit<PermanentConversationCleanupBatch, 'targets' | 'outcomes' | 'remainder' | 'digest' | 'chunks'> & { count: number };

/** Metadata scope only. Message-search pages do not establish batch coverage. */
export function conversationMatchesScope(chat: Conversation, scope: {
  space: 'chat' | 'work' | 'all'; folder: ConversationCleanupScope['folder'] | 'all';
  projectId?: string | null; query?: string;
}): boolean {
  const folder = scope.folder === 'all' || (scope.folder === 'kept' ? !chat.deleted
    : scope.folder === 'deleted' ? !!chat.deleted : !chat.deleted && chat.archived === (scope.folder === 'archived'));
  return folder && (scope.space === 'all' || assistantSpace(chat) === scope.space)
    && (scope.projectId === undefined || scope.projectId === chat.projectId)
    && (!scope.query || chat.title.toLowerCase().includes(scope.query.trim().toLowerCase()));
}
export function conversationNeedsCleanup(chat: Conversation, action: ConversationCleanupAction): boolean {
  return action === 'archive' ? !chat.deleted && !chat.archived : action === 'trash' ? !chat.deleted : !!chat.deleted || chat.archived;
}

export const cleanupReason = (code?: string): string => ({
  conversation_changed: 'The conversation changed after review.', conversation_missing: 'The original conversation is unavailable.',
  pending_conversation: 'Creation, settings or restore is awaiting confirmation.', pending_run: 'An original reply still needs to finish or be checked.',
  pending_removal: 'An original removal needs checking.', pending_voice: 'Voice or dictation still has unsaved work.',
  pending_decision: 'A question or approval needs a decision.', pending_output: 'An output is still being saved.',
  pending_queue: 'A queued message is still waiting.', pending_plan: 'A plan is scheduled to start.',
  not_applied: 'This item was not applied. Review it in a new batch.', time_limit: 'The batch reached its time limit before this item.',
  service_closed: 'The service stopped before this item.', unconfirmed: 'The original result is not yet confirmed.',
  update_maintenance: 'An update is in progress.', recovery_connections_paused: 'This recovered workspace keeps effects paused.',
}[code ?? ''] ?? (code ? 'The original change was blocked (' + code + ').' : ''));
