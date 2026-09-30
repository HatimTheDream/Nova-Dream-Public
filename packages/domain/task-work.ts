import type { Entity, Task } from './contracts.js';
import type { Assignment, AgentDesign } from './workspace-records.js';
import type { AssignmentAttempt } from './assignments.js';

/** Seed the plan brief from what the task already says, so the dialog starts with real context. */
export function briefFromTask(task: Task): string {
  const title = task.title.trim();
  const notes = task.notes.trim();
  return notes ? `${title}\n\n${notes}` : title;
}

/** Build a new assignment plan value from a task and the chosen agent design. */
export function planValueFromTask(task: Task, agent: Entity<AgentDesign>): Assignment {
  return {
    title: `Work: ${task.title.trim()}`.slice(0, 240),
    brief: briefFromTask(task),
    expectedOutput: '',
    agentId: agent.id,
    agentRevision: agent.revision,
    projectId: null,
    due: '',
    state: 'planned',
    archived: false,
  };
}

/** The most recently created attempt for one plan, if any. */
export function latestAttemptForPlan(attempts: AssignmentAttempt[], assignmentId: string): AssignmentAttempt | undefined {
  const matching = attempts.filter(attempt => attempt.assignmentId === assignmentId);
  if (!matching.length) return undefined;
  return matching.reduce((latest, attempt) => (attempt.createdAt > latest.createdAt ? attempt : latest));
}

/** Only a returned attempt that produced a result can be accepted into the task. */
export function canAcceptAttempt(attempt: AssignmentAttempt): boolean {
  return attempt.state === 'returned' && !!attempt.result;
}

/** The task.workResult payload stored when an attempt's result is accepted. */
export function workResultPayload(attempt: AssignmentAttempt, acceptedAt: number): NonNullable<Task['workResult']> {
  if (!canAcceptAttempt(attempt)) throw new Error('This attempt cannot be accepted: it has no returned result.');
  return {
    attemptId: attempt.id,
    assignmentId: attempt.assignmentId,
    fileId: attempt.result!.file.id,
    acceptedAt,
  };
}
