import { z } from 'zod';
import { accountIdSchema } from './accounts.js';

const id = z.string().min(1).max(2000);
export const mailFolderSchema = z.enum(['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems']);
export const mailReadSelector = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gmail.threads'), query: z.string().max(5000), max: z.number().int().min(1).max(100).default(25) }).strict(),
  z.object({ kind: z.literal('gmail.thread'), threadId: id }).strict(),
  z.object({ kind: z.literal('gmail.labels') }).strict(),
  z.object({ kind: z.literal('gmail.stats') }).strict(),
  z.object({ kind: z.literal('gmail.aliases') }).strict(),
  z.object({ kind: z.literal('gmail.attachment'), messageId: id, attachmentId: id }).strict(),
  z.object({ kind: z.literal('microsoft.threads'), folder: mailFolderSchema.default('inbox'), max: z.number().int().min(1).max(100).default(25), unreadOnly: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('microsoft.conversation'), conversationId: id, messageId: id.optional() }).strict(),
  z.object({ kind: z.literal('microsoft.stats'), folder: mailFolderSchema.default('inbox') }).strict(),
  z.object({ kind: z.literal('microsoft.categories') }).strict(),
  z.object({ kind: z.literal('microsoft.attachments'), messageId: id }).strict(),
  z.object({ kind: z.literal('microsoft.attachment'), messageId: id, attachmentId: id }).strict(),
]);
export type MailReadSelector = z.infer<typeof mailReadSelector>;
export const mailReadSchema = z.object({ epoch: z.string().uuid(), accountId: accountIdSchema, generation: z.string().uuid(), selector: mailReadSelector, cursor: z.string().uuid().optional() }).strict();
export type MailReadRequest = z.infer<typeof mailReadSchema>;
export type MailReadResult = { accountId: string; generation: string; kind: MailReadSelector['kind']; value: unknown; readAt: string; coverage: 'complete' | 'page' | 'partial'; nextCursor?: string; message?: string };
export const MAX_MAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
