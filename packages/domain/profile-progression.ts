import { z } from 'zod';
import type { Entity, Task } from './contracts.js';
import { dayInZone, localDate, nextDay, type TaskEvent } from './tasks.js';

export const importedProgressSchema = z.object({
  source: z.literal('Nova Dream'), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  profileId: z.string().min(1).max(1000), name: z.string().min(1).max(120),
  xp: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), asOf: z.string().datetime(),
  events: z.array(z.object({ id: z.string().min(1).max(1000), profileId: z.string().min(1).max(1000), sourceType: z.enum(['task', 'quest', 'achievement', 'adjustment']), sourceId: z.string().min(1).max(1000), amount: z.number().int(), reason: z.string().min(1).max(1000), createdAt: z.string().datetime() }).strict()).max(100000),
}).strict();
export type ImportedProgress = z.infer<typeof importedProgressSchema>;

export const questDraftSchema = z.object({
  id: z.uuid(), title: z.string().trim().min(1).max(160), description: z.string().max(4000),
  projectId: z.string().min(1).max(100).nullable(), due: localDate.or(z.literal('')),
  steps: z.array(z.object({ id: z.uuid(), taskId: z.string().min(1).max(150).nullable(), title: z.string().trim().max(300) }).strict()).min(1).max(30)
}).strict().superRefine((q, ctx) => {
  if (new Set(q.steps.map(s => s.id)).size !== q.steps.length) ctx.addIssue({ code: 'custom', message: 'Each step needs its own identity.', path: ['steps'] });
  const linked = q.steps.filter(s => s.taskId).map(s => s.taskId);
  if (new Set(linked).size !== linked.length) ctx.addIssue({ code: 'custom', message: 'Link each Task only once in a quest.', path: ['steps'] });
  q.steps.forEach((s, i) => { if (!s.taskId && !s.title) ctx.addIssue({ code: 'custom', message: 'Name this new Task.', path: ['steps', i, 'title'] }); });
});
const admission = { requestId: z.uuid(), epoch: z.uuid(), expectedRevision: z.number().int().min(0) };
export const questCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...admission, action: z.literal('save'), quest: questDraftSchema }).strict(),
  z.object({ ...admission, action: z.literal('archive'), id: z.uuid(), archived: z.boolean() }).strict()
]);
export type QuestDraft = z.infer<typeof questDraftSchema>;
export type QuestCommand = z.infer<typeof questCommandSchema>;
export type PersonalQuest = Omit<QuestDraft, 'steps'> & { steps: { id: string; taskId: string }[]; revision: number; archived: boolean; createdAt: string; updatedAt: string };
export type QuestStepProgress = { id: string; taskId: string; title: string; status: Task['status'] | 'missing'; trashed: boolean; done: boolean };
export type PersonalQuestProgress = PersonalQuest & { progress: number; complete: boolean; stepProgress: QuestStepProgress[] };
export type PeriodQuest = { id: string; title: string; description: string; cadence: 'daily' | 'weekly'; start: string; end: string; target: number; progress: number; unit: string; complete: boolean; taskIds: string[] };
export type Milestone = { id: string; title: string; description: string; target: number; progress: number; earned: boolean };
export type ProgressHistoryEntry = TaskEvent & { title: string; trashed: boolean };
export type ProgressHistoryPage = { entries: ProgressHistoryEntry[]; next: string | null; total: number };
export type ProfileProgress = {
  epoch: string; timezone: string; today: string; earnedXp: number; imported?: Pick<ImportedProgress, 'source' | 'name' | 'xp' | 'asOf'> & { eventCount: number };
  level: number; currentLevelXp: number; nextLevelXp: number; progressPct: number;
  completedTasks: number; activeDays: number; quests: PeriodQuest[]; personalQuests: PersonalQuestProgress[];
  milestones: Milestone[]; days: { day: string; count: number }[]; history: ProgressHistoryPage;
};

// Reused from Dream Claw e0769bd9f8fd: src/services/workshop/progression.ts.
export function levelForXp(xp: number): number {
  const safeXp = Math.max(0, Math.floor(xp));
  return safeXp < 3500 ? Math.max(1, Math.floor(Math.sqrt(safeXp / 140)) + 1) : 6 + Math.floor((safeXp - 3500) / 1260);
}
export function xpRequiredForLevel(level: number): number {
  const safeLevel = Math.max(1, Math.floor(level));
  return safeLevel <= 6 ? (safeLevel - 1) ** 2 * 140 : 3500 + (safeLevel - 6) * 1260;
}
export function progressForXp(xp: number) {
  const level = levelForXp(xp), currentLevelXp = xpRequiredForLevel(level), nextLevelXp = xpRequiredForLevel(level + 1);
  return { level, currentLevelXp, nextLevelXp, progressPct: Math.max(0, Math.min(100, Math.round((xp - currentLevelXp) / (nextLevelXp - currentLevelXp) * 100))) };
}
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export function questPeriod(cadence: 'daily' | 'weekly', timezone: string, now: number) {
  const today = dayInZone(timezone, now);
  const start = cadence === 'daily' ? today : shift(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  return { start, end: cadence === 'daily' ? nextDay(start) : shift(start, 7) };
}
export function progressHistory(tasks: Entity<Task>[], events: TaskEvent[], before?: string): ProgressHistoryPage {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const sorted = events.filter(e => e.xpDelta !== 0).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id, undefined, { numeric: true }));
  const start = before ? sorted.findIndex(e => e.id === before) + 1 : 0;
  const page = sorted.slice(start, start + 50);
  return { entries: page.map(e => ({ ...e, title: taskMap.get(e.taskId)?.value.title ?? 'Task unavailable', trashed: !!taskMap.get(e.taskId)?.value.trashed })), next: start + page.length < sorted.length ? page.at(-1)!.id : null, total: sorted.length };
}
export function buildProfileProgress(tasks: Entity<Task>[], events: TaskEvent[], saved: PersonalQuest[], timezone: string, now: number, epoch: string, imported?: ImportedProgress): ProfileProgress {
  // The server passes the full canonical ledger, never the 500-event snapshot window.
  const ledger = [...new Map(events.map(e => [e.id, e])).values()];
  const balances = new Map<string, number>(), first = new Map<string, string>();
  for (const e of ledger) {
    balances.set(e.taskId, (balances.get(e.taskId) ?? 0) + e.xpDelta);
    if (e.xpDelta > 0 && (!first.has(e.taskId) || e.at < first.get(e.taskId)!)) first.set(e.taskId, e.at);
  }
  const credited = [...balances].filter(([, xp]) => xp > 0).map(([id]) => ({ id, day: dayInZone(timezone, Date.parse(first.get(id)!)) }));
  const earnedXp = ledger.reduce((n, e) => n + e.xpDelta, imported?.xp ?? 0), today = dayInZone(timezone, now);
  const activeDays = new Set(credited.map(t => t.day)).size;
  const definitions = [
    { id: 'daily-first-win', title: 'Open with intent', description: 'Finish one Task today.', cadence: 'daily', target: 1, unit: 'Tasks' },
    { id: 'daily-two-wins', title: 'Build progress', description: 'Bring two Tasks to a finish today.', cadence: 'daily', target: 2, unit: 'Tasks' },
    { id: 'weekly-five-wins', title: 'Five decisive closes', description: 'Finish five Tasks this week.', cadence: 'weekly', target: 5, unit: 'Tasks' },
    { id: 'weekly-active-days', title: 'A rhythm of your own', description: 'Finish work on three different days this week.', cadence: 'weekly', target: 3, unit: 'days' }
  ] as const;
  const quests: PeriodQuest[] = definitions.map(d => {
    const period = questPeriod(d.cadence, timezone, now), outcomes = credited.filter(t => t.day >= period.start && t.day < period.end && t.day <= today);
    const progress = d.unit === 'days' ? new Set(outcomes.map(t => t.day)).size : outcomes.length;
    return { ...d, ...period, id: `${d.id}:${period.start}`, progress, complete: progress >= d.target, taskIds: outcomes.map(t => t.id) };
  });
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const personalQuests = saved.map(q => {
    const stepProgress = q.steps.map(s => { const task = taskMap.get(s.taskId); return { ...s, title: task?.value.title ?? 'Task unavailable', status: task?.value.status ?? 'missing' as const, trashed: !!task?.value.trashed, done: task?.value.status === 'done' }; });
    const progress = stepProgress.filter(s => s.done).length;
    return { ...q, stepProgress, progress, complete: q.steps.length > 0 && progress === q.steps.length };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const milestones: Milestone[] = [
    { id: 'first-finish', title: 'First finish', description: 'Complete your first Task.', target: 1, progress: credited.length },
    { id: 'reliable-finisher', title: 'Reliable finisher', description: 'Complete five Tasks.', target: 5, progress: credited.length },
    { id: 'steady-practice', title: 'Steady practice', description: 'Complete work on ten different days.', target: 10, progress: activeDays },
    { id: 'pathfinder', title: 'Pathfinder', description: 'Finish all the steps of a personal quest.', target: 1, progress: personalQuests.filter(q => q.complete).length },
    { id: 'fifty-finishes', title: 'Fifty finishes', description: 'Complete fifty Tasks.', target: 50, progress: credited.length }
  ].map(m => ({ ...m, earned: m.progress >= m.target }));
  const days = Array.from({ length: 7 }, (_, i) => { const day = shift(today, i - 6); return { day, count: credited.filter(t => t.day === day).length }; });
  return { epoch, timezone, today, earnedXp, ...(imported ? { imported: { source: imported.source, name: imported.name, xp: imported.xp, asOf: imported.asOf, eventCount: imported.events.length } } : {}), ...progressForXp(earnedXp), completedTasks: credited.length, activeDays, quests, personalQuests, milestones, days, history: progressHistory(tasks, ledger) };
}
