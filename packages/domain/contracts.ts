import { assistantSpaceSchema } from './assistant-space.js';
import { workModeSchema } from './work-mode.js';
import { z } from 'zod';
import { reminderSchema } from './reminders.js';
import { clockTime, timezone, type Routine, type TaskState } from './tasks.js';
import { recordKinds, recordOriginSchema, type RecordValues } from './workspace-records.js';
import { attachmentSchema } from './attachments.js';
export { attachmentSchema } from './attachments.js';

export const moduleIds = ['home', 'assistant', 'tasks', 'calendar', 'inbox', 'contacts', 'agents', 'content', 'profile'] as const;
export type ModuleId = typeof moduleIds[number];
export const widgetIds = ['welcome', 'next', 'draft', 'attention', 'setup'] as const;
export type WidgetId = typeof widgetIds[number];
export const sizes = ['compact', 'square', 'wide', 'large'] as const;
const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9:_-]+$/);
const unique = <T>(items: T[]) => new Set(items).size === items.length;
export const layoutSchema = z.object({
  nav: z.array(z.enum(moduleIds)).length(moduleIds.length).refine(unique),
  widgets: z.array(z.object({ id: z.enum(widgetIds), size: z.enum(sizes), hidden: z.boolean() })).length(widgetIds.length).refine(v => unique(v.map(w => w.id))),
  theme: z.enum(['light', 'dark', 'system']),
  timezone: z.string().max(80).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }),
  showCompleted: z.boolean(),
});
export type Layout = z.infer<typeof layoutSchema>;
export const defaultLayout: Layout = {
  nav: [...moduleIds], theme: 'light', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  showCompleted: false,
  widgets: [{ id: 'welcome', size: 'wide', hidden: false }, { id: 'next', size: 'wide', hidden: false }, { id: 'draft', size: 'square', hidden: false }, { id: 'attention', size: 'square', hidden: false }, { id: 'setup', size: 'wide', hidden: false }],
};
const date = z.string().refine(value => value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value));
export const taskSchema = z.object({ title: z.string().trim().min(1).max(300), notes: z.string().max(10000), status: z.enum(['open', 'active', 'waiting', 'blocked', 'done', 'skipped']), planned: date, due: date,
  trashed: z.boolean().optional(),
  parentTaskId: id.nullable().optional(),
  reminder: reminderSchema.nullable().optional(),
  plannedTime: clockTime.optional(), dueTime: clockTime.optional(), timezone: timezone.optional(),
  bucket: z.enum(['capture', 'anytime']).optional(), projectId: id.nullable().optional(), origin: recordOriginSchema.optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(), estimateMinutes: z.number().int().min(0).max(1440).optional(),
  waitReason: z.string().max(1000).optional(),
  checklist: z.array(z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(300), done: z.boolean() }).strict()).max(500).refine(v => unique(v.map(i => i.id))).optional(),
  dependencies: z.array(id).max(20).refine(unique).optional(),
  sources: z.array(z.object({ label: z.string().trim().min(1).max(100), url: z.string().url().max(2000).refine(v => ['https:', 'http:'].includes(new URL(v).protocol)) }).strict()).max(10).optional() }).strict();
export const draftSchema = z.object({ space: assistantSpaceSchema.optional(), workMode: workModeSchema.optional(), title: z.string().max(150), text: z.string().max(100000), projectId: id.nullable(), conversationId: z.string().uuid().nullable().optional(), attachments: z.array(attachmentSchema).max(10), refineSource: z.object({ outputId: z.string().uuid(), version: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict();
export const projectWorkspaceSchema = z.object({ folder: z.string().trim().max(4000).refine(value => !/[\x00-\x1f]/.test(value)), environment: z.enum(['local', 'worktree']) }).strict();
export const projectSchema = z.object({ space: assistantSpaceSchema.optional(), instructions: z.string().max(10000).optional(), workspace: projectWorkspaceSchema.optional(), name: z.string().trim().min(1).max(100), purpose: z.string().max(10000), attachments: z.array(attachmentSchema).max(10).refine(files => unique(files.map(file => file.id))).optional() }).strict();
export type Task = z.infer<typeof taskSchema>;
export type Draft = z.infer<typeof draftSchema>;
export const draftOrganizationCommandSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), draftId: id, draftRevision: z.number().int().positive(), expectedRevision: z.number().int().min(0), action: z.enum(['pin', 'unpin', 'archive', 'delete', 'restore']) }).strict();
export const removeDraftSchema = draftOrganizationCommandSchema.omit({ action: true }).strict();
export type DraftRemoval = { draftId: string; revision: number };
export type DraftOrganization = { draftId: string; draftRevision: number; revision: number; pinned: boolean; folder: 'active' | 'archive' | 'deleted' };
export type Project = z.infer<typeof projectSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type Entity<T> = { id: string; revision: number; updatedAt: string; deviceId: string; value: T };
export type Kind = 'layout' | 'task' | 'draft' | 'project' | 'routine' | keyof RecordValues;
export type Values = { layout: Layout; task: Task; draft: Draft; project: Project; routine: Routine } & RecordValues;
export const commandSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), entityId: id, expectedRevision: z.number().int().min(0), kind: z.enum(['layout', 'task', 'draft', 'project', 'routine', ...recordKinds]), payload: z.unknown() }).strict();
export type Command = z.infer<typeof commandSchema>;
export type Snapshot = { calendarCompletions?: import('./calendar-completion.js').CalendarCompletion[]; records?: { [K in keyof RecordValues]: Entity<RecordValues[K]>[] }; calendarReminders?: import('./calendar-reminders.js').CalendarReminderState; epoch: string; cursor: number; deviceId: string; layout: Entity<Layout>; tasks: Entity<Task>[]; trashedTasks?: Entity<Task>[]; routines?: Entity<Routine>[]; taskState?: TaskState; drafts: Entity<Draft>[]; draftOrganization?: DraftOrganization[]; draftRemovals?: DraftRemoval[]; projects: Entity<Project>[]; capabilities: { assistant: boolean; voice: boolean; reason: string } };
export const emptyDraft: Draft = { title: 'New conversation', text: '', projectId: null, attachments: [] };
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];
  const next = [...items]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
