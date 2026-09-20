import { z } from 'zod';
import { assistantRequestSchema } from './assistant.js';

export const chatGptAccountPluginId = 'edition3-accounts';
export const chatGptAccountRuntimeVersion = '2026.9.2';
// Runtime-owned profile names only; reject option-like input, paths and control characters.
export const chatGptProfileIdSchema = z.string().min(1).max(200).regex(/^openai:[A-Za-z0-9_.@+-]+$/);
export const chatGptAccountOrderSchema = assistantRequestSchema.extend({ profileIds: z.array(chatGptProfileIdSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length) }).strict();
export const chatGptAccountSnapshotSchema = z.object({ epoch: z.string().uuid(), refresh: z.boolean().optional(), includeUsage: z.boolean().optional() }).strict();
export const chatGptAccountUsageSchema = z.object({
  state: z.enum(['ready', 'stale', 'unavailable']), checkedAt: z.number().nonnegative().nullable(), reportedAt: z.number().nonnegative().nullable(),
  windows: z.array(z.object({ label: z.string().max(120), usedPercent: z.number().min(0).max(100).nullable(), resetAt: z.number().nonnegative().nullable() })).max(20),
  plan: z.string().max(120).nullable(), credits: z.number().nonnegative().nullable(),
});
export const chatGptRuntimeSnapshotSchema = z.object({
  epoch: z.string().uuid(), checkedAt: z.number().nonnegative(), order: z.array(chatGptProfileIdSchema).max(100),
  accounts: z.array(z.object({
    profileId: chatGptProfileIdSchema, identityKey: z.string().regex(/^[a-f0-9]{64}$/).optional(), email: z.string().email().max(254).optional(),
    health: z.enum(['ready', 'cooldown', 'reconnect', 'unknown']), cooldownUntil: z.number().nonnegative().nullable(), expiresAt: z.number().nonnegative().nullable(),
    usage: chatGptAccountUsageSchema,
  })).max(100),
});
export const emptyChatGptUsage = () => ({ state: 'unavailable' as const, checkedAt: null, reportedAt: null, windows: [], plan: null, credits: null });
