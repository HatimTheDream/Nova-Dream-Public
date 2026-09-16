import { z } from 'zod';
import type { MailContactPrepare, MailContactSource } from './mail-contact.js';

export const contactDirectoryReadSchema = z.object({ epoch: z.uuid(), query: z.string().max(240).default(''), offset: z.number().int().min(0).max(100000).default(0), contactId: z.string().max(100).optional() }).strict();
export type InboxSender = { name: string; email: string; lastAt: string; conversations: number; contactId?: string; input: MailContactPrepare };
export type ContactCorrespondence = { source: MailContactSource; date: string };
export type ContactDirectoryResult = { senders: InboxSender[]; total: number; next: number | null; correspondence: ContactCorrespondence[]; calendar?: { eventId: string; originalDate?: string; title: string; date: string }[]; accounts: number; partial: boolean; unavailable: number };
