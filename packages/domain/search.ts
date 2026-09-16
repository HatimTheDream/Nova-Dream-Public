import { assistantSpace, assistantSpaceSchema, type AssistantSpace } from './assistant-space.js';
import { z } from 'zod';
import type { Conversation } from './assistant.js';

export const conversationSearchSchema = z.object({ space: assistantSpaceSchema.optional(), epoch: z.string().uuid(), query: z.string().trim().min(1).max(4096), scope: z.enum(['active', 'archived', 'all']), projectId: z.string().max(100).nullable().optional() }).strict();
export const browseConversationSchema = z.object({ epoch: z.string().uuid(), conversationId: z.string().uuid(), nativeId: z.string().uuid(), messageId: z.string().min(1).max(1000).optional(), messageHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), role: z.enum(['user', 'assistant']).optional(), offset: z.number().int().nonnegative().optional() }).strict().refine(v => !(v.messageId && v.offset !== undefined), 'A message anchor cannot be combined with a numeric offset.').refine(v => !v.messageHash || !!v.messageId, 'An exact version needs its message anchor.');
export type BrowseTarget = z.infer<typeof browseConversationSchema>;
export type ConversationSearchHit = { conversationId: string; nativeId: string; messageId: string; role: 'user' | 'assistant'; timestamp: number; snippet: string };
export type ConversationSearchResult = { query: string; results: ConversationSearchHit[]; searchedConversations: number; excludedConversations: number; indexing: boolean | null; limited: boolean; changedDuringSearch: boolean };
export function inSearchScope(conversation: Conversation, input: { space?: AssistantSpace; scope: 'active' | 'archived' | 'all'; projectId?: string | null }) { return !conversation.deleted && (input.space === undefined || assistantSpace(conversation) === input.space) && (input.scope === 'all' || conversation.archived === (input.scope === 'archived')) && (input.projectId === undefined || conversation.projectId === input.projectId); }
