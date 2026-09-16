import { z } from 'zod';
import { accountIdSchema } from './accounts.js';
import type { MailIndexSnapshot } from './dreamclaw/mail-index.js';

const identity = z.object({ epoch: z.string().uuid(), accountId: accountIdSchema, generation: z.string().uuid() });
export const mailIndexReadSchema = identity.extend({ revision: z.string().max(120).optional() }).strict();
export const mailIndexCommandSchema = z.discriminatedUnion('action', [
  identity.extend({ requestId: z.string().uuid(), action: z.literal('sync'), mode: z.enum(['resume', 'refresh', 'rebuild']), expectedRunId: z.string().uuid().optional() }).strict(),
  identity.extend({ requestId: z.string().uuid(), action: z.literal('pause'), expectedRunId: z.string().uuid() }).strict(),
]);
export type MailIndexRead = z.infer<typeof mailIndexReadSchema>;
export type MailIndexCommand = z.infer<typeof mailIndexCommandSchema>;
export type MailIndexResult = { accountId: string; generation: string; revision: string; runId?: string; snapshot?: MailIndexSnapshot; unchanged?: true };
