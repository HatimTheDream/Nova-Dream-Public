import { z } from 'zod';
import { localDate, clockTime, timezone } from './tasks.js';
import type { AssignmentAttempt } from './assignments.js';

export const agentScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), date: localDate, time: clockTime.refine(Boolean), overlap: z.enum(['earlier', 'later']).optional() }).strict(),
  z.object({ kind: z.literal('every'), minutes: z.number().int().min(1).max(525600), anchor: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().trim().min(1).max(200) }).strict(),
]);
export const agentRoutineSchema = z.object({
  name: z.string().trim().min(1).max(240), assignmentId: z.string().min(1).max(100),
  assignmentRevision: z.number().int().positive(), projectRevision: z.number().int().positive().nullable(),
  schedule: agentScheduleSchema, timezone, missed: z.enum(['skip', 'latest', 'review']),
  enabled: z.boolean(), archived: z.boolean(),
}).strict().refine(v => !v.archived || !v.enabled, 'Pause a routine before archiving it.');
export const agentRoutineSaveSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), id: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), value: agentRoutineSchema }).strict();
export type AgentSchedule = z.infer<typeof agentScheduleSchema>;
export type AgentRoutineValue = z.infer<typeof agentRoutineSchema>;
export type AgentRoutineSave = z.infer<typeof agentRoutineSaveSchema>;
export type AgentRoutine = { id: string; revision: number; epoch: string; deviceId: string; updatedAt: number; value: AgentRoutineValue; agentId: string; nextAt: number | null; attention: string | null };
export type RoutineOccurrence = { id: string; routineId: string; routineRevision: number; scheduledAt: number; recordedAt: number; state: 'started' | 'skipped' | 'review'; message: string; attemptId?: string; throughAt?: number };
export type RoutineAttempt = Pick<AssignmentAttempt, 'id' | 'assignmentId' | 'state' | 'message' | 'routine'> & { result?: Pick<NonNullable<AssignmentAttempt['result']>, 'file'> };
export type AgentRoutineState = { routines: AgentRoutine[]; history: (RoutineOccurrence & { attempt?: RoutineAttempt })[]; nextCursor: string | null };
export type AssignmentRoutineOrigin = { routineId: string; routineRevision: number; scheduledAt: number; occurrenceId: string };
