import { z } from 'zod';
import type { Command, Entity } from './contracts.js';
import type { CalendarDisplayEvent, CalendarRange } from './calendar.js';
import { addDays } from './calendar.js';
import { dayInZone, localDate } from './tasks.js';
import { reminderInstant } from './reminders.js';
import { contentSchema, type Content } from './workspace-records.js';

export const contentPlanningPatchSchema = z.object({ stage: z.enum(['ideas', 'drafting', 'review', 'ready']).optional(), plannedDate: z.union([z.literal(''), localDate]).optional() }).strict().refine(p => Object.keys(p).length > 0, 'Choose a planning change.');
export type ContentPlanningPatch = z.infer<typeof contentPlanningPatchSchema>;
export function contentDay(value: Content) { return value.stage === 'published' ? value.publication?.date ?? '' : value.plannedDate; }
export function contentPlanningCommand(record: Entity<Content>, raw: ContentPlanningPatch, epoch: string, requestId: string): Command {
  const patch = contentPlanningPatchSchema.parse(raw);
  if (record.value.archived) throw new Error('Restore this archived record before moving it.');
  if (patch.plannedDate !== undefined && record.value.stage === 'published') throw new Error('Open the manual publication record to change its recorded date.');
  return { kind: 'content', entityId: record.id, expectedRevision: record.revision, epoch, requestId, payload: contentSchema.parse({ ...record.value, ...patch, ...(patch.plannedDate === '' ? { plannedTime: '', plannedOverlap: undefined } : {}) }) };
}
/** A projection of the canonical Content record; never a copied Calendar event. */
export function contentCalendarEvents(records: Entity<Content>[], range: CalendarRange): CalendarDisplayEvent[] {
  return records.flatMap(record => {
    const value = record.value, date = contentDay(value);
    if (value.archived || !date) return [];
    let interval: CalendarDisplayEvent['interval'] = { kind: 'date', start: date, end: addDays(date, 1) };
    if (value.stage !== 'published' && value.plannedTime && value.plannedTimezone) {
      const resolution = reminderInstant({ date, time: value.plannedTime, timezone: value.plannedTimezone, overlap: value.plannedOverlap });
      if (resolution.instant === null) return [];
      const end = resolution.instant + (value.plannedMinutes ?? 30) * 60000;
      if (dayInZone(range.timezone, end - 1) < range.from || dayInZone(range.timezone, resolution.instant) >= range.to) return [];
      interval = { kind: 'instant', start: new Date(resolution.instant).toISOString(), end: new Date(end).toISOString(), timezone: value.plannedTimezone };
    } else if (date < range.from || date >= range.to) return [];
    const label = value.stage === 'published' ? 'Published · manual record' : 'Planned content';
    return [{ id: record.id, contentId: record.id, sourceId: 'content', title: value.title, notes: [`${label} · ${value.stage} · ${value.platform}`, value.brief, value.stage === 'published' ? value.publication?.note : ''].filter(Boolean).join('\n\n').slice(0, 10000), location: '', status: 'confirmed' as const, interval }];
  });
}
