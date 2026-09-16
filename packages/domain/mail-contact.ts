import { z } from 'zod';

export const mailSourceSchema = z.object({ provider: z.enum(['google', 'microsoft']), accountId: z.string().min(1).max(100), threadId: z.string().min(1).max(2048) }).strict();
export const mailContactSourceSchema = mailSourceSchema.extend({ messageId: z.string().min(1).max(2048), sender: z.email().max(254), subject: z.string().max(500) });
export type MailContactSource = z.infer<typeof mailContactSourceSchema>;
export const mailContactPrepareSchema = z.object({ epoch: z.uuid(), source: mailSourceSchema, generation: z.uuid(), messageId: z.string().min(1).max(2048) }).strict();
export type MailContactPrepare = z.infer<typeof mailContactPrepareSchema>;
export const mailContactLinkSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), reviewId: z.uuid(), target: z.union([z.object({ kind: z.literal('new'), name: z.string().trim().min(1).max(240) }).strict(), z.object({ kind: z.literal('existing'), id: z.string().min(1).max(100), revision: z.number().int().positive() }).strict()]) }).strict();
export type MailContactLink = z.infer<typeof mailContactLinkSchema>;
export type MailContactReview = { id: string; device: string; epoch: string; generation: string; source: MailContactSource; name: string; createdAt: number };
export type MailContactMatch = { id: string; revision: number; name: string; email: string; organization: string; archived: boolean };
export type MailContactProposal = { review: MailContactReview; matches: MailContactMatch[] };
/** Deliberately do not remove dots, plus tags or fold provider aliases. */
export const contactEmailKey = (email: string) => email.trim().toLowerCase();
export const mailContactSourceKey = (source: MailContactSource) => JSON.stringify([source.provider, source.accountId, source.threadId, source.messageId]);
