import { taskSchema, type Task } from './contracts.js';
import { z } from 'zod';
import { calendarRangeSchema, type CalendarDisplayEvent, type CalendarRange } from './calendar.js';

export const calendarCompletionTargetSchema = z.object({ sourceId: z.string().min(1).max(256), eventId: z.string().min(1).max(2000), originalStart: z.string().max(100).optional() }).strict();
export const calendarCompletionCommandSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), target: calendarCompletionTargetSchema, generation: z.string().max(100).optional(), range: calendarRangeSchema, expectedRevision: z.number().int().nonnegative(), done: z.boolean(), checklist: taskSchema.shape.checklist }).strict();
export type CalendarCompletionCommand = z.infer<typeof calendarCompletionCommandSchema>;
export type CalendarCompletion = {
  checklist?: Task['checklist']; key: string; target: CalendarCompletionCommand['target']; revision: number; done: boolean; updatedAt: string;
  event: Pick<CalendarDisplayEvent, 'id' | 'sourceId' | 'title' | 'interval' | 'seriesId' | 'originalStart'>;
  range: CalendarRange; generation?: string; localId?: string; originalDate?: string; projectId?: string | null;
};
// Source + exact occurrence remains stable through a connection refresh. A new write still fences generation.
export const calendarCompletionKey = (target: CalendarCompletionCommand['target']) => JSON.stringify([target.sourceId, target.eventId, target.originalStart ?? '']);
export const calendarCompletionTarget = (event: CalendarDisplayEvent) => ({ sourceId: event.sourceId, eventId: event.id, ...(event.originalStart ? { originalStart: event.originalStart } : {}) });
