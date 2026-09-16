import type { Task } from './contracts.js';

/** Parent completion and its embedded subtasks are one revisioned save. */
export function syncTaskSubtasks(next: Task, previous?: Task): Task {
  if (!next.checklist?.length) return next;
  const changed = JSON.stringify(next.checklist) !== JSON.stringify(previous?.checklist);
  const statusChanged = next.status !== previous?.status;
  if (statusChanged && (next.status === 'done' || !changed || !previous)) {
    if (next.status === 'done') return { ...next, checklist: next.checklist.map(item => ({ ...item, done: true })) };
    if (previous?.status === 'done') return { ...next, checklist: next.checklist.map(item => ({ ...item, done: false })) };
  }
  if (changed) {
    if (next.checklist.every(item => item.done)) return { ...next, status: 'done' };
    if (next.status === 'done') return { ...next, status: 'open' };
  }
  return next;
}
