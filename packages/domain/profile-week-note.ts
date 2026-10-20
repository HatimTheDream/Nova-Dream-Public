import { z } from 'zod';
import { profileWeekIdentitySchema, sameProfileWeek } from './profile-week.js';

export const weekNoteTextSchema = z.string().max(20000).refine(value => value.trim().length > 0, 'Write a note before saving.');
export const weekNoteSchema = z.object({
  format: z.literal(1), identity: profileWeekIdentitySchema, revision: z.number().int().positive(),
  text: weekNoteTextSchema, trashed: z.boolean(), updatedAt: z.iso.datetime(),
}).strict();
const commandBase = z.object({
  requestId: z.uuid(), epoch: z.uuid(), identity: profileWeekIdentitySchema, expectedRevision: z.number().int().nonnegative(),
});
export const weekNoteCommandSchema = z.discriminatedUnion('action', [
  commandBase.extend({ action: z.literal('save'), text: weekNoteTextSchema }).strict(),
  commandBase.extend({ action: z.literal('trash') }).strict(),
  commandBase.extend({ action: z.literal('restore') }).strict(),
]);
export const weekNoteStateSchema = z.object({ epoch: z.uuid(), identity: profileWeekIdentitySchema, note: weekNoteSchema.nullable() }).strict()
  .refine(value => !value.note || sameProfileWeek(value.identity, value.note.identity), 'The note belongs to another week.');
export const weekNoteReceiptSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), action: z.enum(['save', 'trash', 'restore']), note: weekNoteSchema }).strict();
export const weekNoteSummarySchema = weekNoteSchema.omit({ format: true, text: true });
export const weekNotesQuerySchema = z.object({ before: z.string().min(1).max(512).optional(), version: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
  .refine(value => !!value.before === !!value.version, 'Keep the note list position and version together.');
export const weekNotesPageSchema = z.object({
  epoch: z.uuid(), version: z.string().regex(/^[a-f0-9]{64}$/), rows: z.array(weekNoteSummarySchema).max(50),
  next: z.string().min(1).max(512).nullable(), total: z.number().int().nonnegative(),
}).strict();
export type WeekNote = z.infer<typeof weekNoteSchema>;
export type WeekNoteCommand = z.infer<typeof weekNoteCommandSchema>;
export type WeekNoteState = z.infer<typeof weekNoteStateSchema>;
export type WeekNoteReceipt = z.infer<typeof weekNoteReceiptSchema>;
export type WeekNotesPage = z.infer<typeof weekNotesPageSchema>;

export const weekNoteIdentityKey = (identity: z.infer<typeof profileWeekIdentitySchema>) =>
  `${identity.start}:${encodeURIComponent(identity.timezone)}`;
