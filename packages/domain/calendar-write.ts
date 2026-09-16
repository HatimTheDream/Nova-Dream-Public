import { z } from 'zod';
import { localEventInputSchema, type CalendarEvent, type CalendarSourceRef, type LocalEventInput } from './calendar.js';

const identity = z.string().min(1).max(2000);
export const providerCalendarTargetSchema = z.object({
  sourceId: identity, generation: z.uuid(), eventId: identity,
  scope: z.enum(['event', 'occurrence', 'series']),
  seriesId: identity.optional(), originalStart: z.string().min(1).max(100).optional(),
}).strict();
export type ProviderCalendarTarget = z.infer<typeof providerCalendarTargetSchema>;
export const providerCalendarOpenSchema = z.object({ epoch: z.uuid(), target: providerCalendarTargetSchema }).strict();
export const providerCalendarPrepareSchema = z.object({
  requestId: z.uuid(), epoch: z.uuid(), writerId: z.uuid(), sourceId: identity, generation: z.uuid(),
  action: z.enum(['create', 'update', 'delete']), target: providerCalendarTargetSchema.optional(),
  expectedVersion: identity.optional(), value: localEventInputSchema.optional(),
  replaceDescription: z.boolean().default(false), replaceRecurrence: z.boolean().default(false),
  replaceReminder: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.action !== 'create' && (!value.target || !value.expectedVersion)) context.addIssue({ code: 'custom', message: 'Open the exact event and choose its scope before changing it.' });
  if (value.action === 'create' && value.target) context.addIssue({ code: 'custom', message: 'A new event cannot replace an existing event.' });
  if (value.action !== 'delete' && !value.value) context.addIssue({ code: 'custom', message: 'Keep the complete event fields before saving.' });
  if (value.action === 'delete' && value.value) context.addIssue({ code: 'custom', message: 'Review deletion separately from an event edit.' });
  if (value.target && (value.target.sourceId !== value.sourceId || value.target.generation !== value.generation)) context.addIssue({ code: 'custom', message: 'The event belongs to another source connection.' });
});
export type ProviderCalendarPrepare = z.infer<typeof providerCalendarPrepareSchema>;
export const providerCalendarOperationSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), operationId: z.uuid() }).strict();
export const providerCalendarConfirmSchema = providerCalendarOperationSchema.extend({
  expectedRevision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['confirm', 'cancel']), acknowledgeNotifications: z.boolean().default(false),
});
export type ProviderCalendarEditable = {
  epoch: string; source: CalendarSourceRef; target: ProviderCalendarTarget;
  event: CalendarEvent; value: LocalEventInput; version: string;
  attendees: number; onlineMeeting: boolean; formattedDescription: boolean;
  repeating: boolean; recurrenceEditable: boolean; warnings: string[];
};
export type ProviderCalendarReview = {
  id: string; epoch: string; writerId: string; source: CalendarSourceRef;
  action: ProviderCalendarPrepare['action']; target?: ProviderCalendarTarget;
  revision: number; digest?: string; createdAt: string; updatedAt: string; expiresAt: string;
  state: 'preparing' | 'review' | 'applying' | 'confirmed' | 'observed' | 'conflict' | 'unknown' | 'failed' | 'cancelled';
  value?: LocalEventInput; before?: LocalEventInput; event?: CalendarEvent;
  attendees: number; warnings: string[]; changes: string[]; detail?: string;
};
