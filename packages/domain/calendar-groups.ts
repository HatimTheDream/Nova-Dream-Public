import { z } from 'zod';
import type { CalendarSourceRef } from './calendar.js';
import { providerCalendarOperationSchema, type ProviderCalendarReview } from './calendar-write.js';

export const calendarGroupPrepareSchema = z.object({
  requestId: z.uuid(), epoch: z.uuid(), writerId: z.uuid(), sourceId: z.string().min(1).max(2000), generation: z.uuid(),
  seriesIds: z.array(z.string().min(1).max(2000)).min(1).max(31), label: z.string().max(300).default('Selected schedule'),
}).strict().refine(value => new Set(value.seriesIds).size === value.seriesIds.length, 'Select each recurring pattern only once.');
export type CalendarGroupPrepare = z.infer<typeof calendarGroupPrepareSchema>;
export const calendarGroupActionSchema = providerCalendarOperationSchema.extend({
  expectedRevision: z.number().int().positive(), action: z.enum(['confirm', 'cancel', 'review']),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(), acknowledgeNotifications: z.boolean().default(false),
}).strict();
export type CalendarGroupAction = z.infer<typeof calendarGroupActionSchema>;
export type CalendarGroupReview = {
  id: string; epoch: string; writerId: string; source: CalendarSourceRef; label: string;
  revision: number; round: number; createdAt: string; updatedAt: string;
  state: 'preparing' | 'review' | 'applying' | 'partial' | 'confirmed' | 'cancelled'; closed: boolean;
  digest?: string; detail: string;
  items: { seriesId: string; operation?: ProviderCalendarReview; error?: string }[];
};
export const calendarGroupRemoved = (item: CalendarGroupReview['items'][number]) => ['confirmed', 'observed'].includes(item.operation?.state ?? '');
export const calendarGroupUncertain = (item: CalendarGroupReview['items'][number]) => ['applying', 'unknown'].includes(item.operation?.state ?? '');
