import { z } from 'zod';
import type { Entity, Task } from './contracts.js';
import type { PersonalQuestProgress } from './profile-progression.js';
import { taskBlockers } from './task-presentation.js';

const questIds = z.array(z.uuid()).max(2).refine(ids => new Set(ids).size === ids.length, 'Choose each quest only once.');
export const studioCurationSchema = z.object({ format: z.literal(1), revision: z.number().int().min(0), questIds }).strict();
export const studioCommandSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), expectedRevision: z.number().int().min(0), questIds }).strict();
export const studioReceiptSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), curation: studioCurationSchema }).strict();
export const studioStateSchema = z.object({ epoch: z.uuid(), curation: studioCurationSchema, availableQuestIds: questIds,
  unavailable: z.array(z.object({ id: z.uuid(), reason: z.enum(['missing', 'archived']) }).strict()).max(2)
}).strict().superRefine((state, ctx) => {
  const resolved = [...state.availableQuestIds, ...state.unavailable.map(row => row.id)];
  if (resolved.length !== state.curation.questIds.length || new Set(resolved).size !== resolved.length || resolved.some(id => !state.curation.questIds.includes(id))) ctx.addIssue({ code: 'custom', message: 'Studio selection does not match its saved curation.' });
});
export type StudioCuration = z.infer<typeof studioCurationSchema>;
export type StudioCommand = z.infer<typeof studioCommandSchema>;
export type StudioReceipt = z.infer<typeof studioReceiptSchema>;
export type StudioState = z.infer<typeof studioStateSchema>;

/** Original Tasks remain authoritative. A blocked or missing remainder is never a finish. */
export function studioNextWork(quest: PersonalQuestProgress, tasks: Entity<Task>[]): { kind: 'task'; task: Entity<Task> } | { kind: 'review' | 'revisit' } {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const steps = quest.steps.map(step => byId.get(step.taskId));
  const next = steps.find(task => task && !task.value.trashed && ['open', 'active'].includes(task.value.status) && taskBlockers(task.value, tasks).length === 0);
  if (next) return { kind: 'task', task: next };
  return { kind: steps.length > 0 && steps.every(task => task && !task.value.trashed && task.value.status === 'done') ? 'revisit' : 'review' };
}

export function studioFocus(quests: PersonalQuestProgress[], curation: StudioState, focusedId: string | null) {
  const featured = curation.availableQuestIds.flatMap(id => { const quest = quests.find(row => row.id === id && !row.archived); return quest ? [quest] : []; });
  return { featured, focused: featured.find(quest => quest.id === focusedId) ?? featured[0] ?? null };
}
