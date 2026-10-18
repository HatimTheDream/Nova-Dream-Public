import type { Command, Entity, Task } from '../../../packages/domain/contracts';

export type TaskEditorDraft = { value: Task; revision: number; epoch: string; pending?: Command };

/** Adopt our acknowledged write without reverting newer writing or another save. */
export function adoptTaskConfirmation(current: TaskEditorDraft, captured: Entity<Task>, confirmed: Entity<Task>, epoch: string): TaskEditorDraft {
  if (current.epoch !== epoch || captured.id !== confirmed.id || current.pending
    || current.revision !== captured.revision || confirmed.revision <= current.revision) return current;
  const value = { ...confirmed.value };
  for (const key of new Set([...Object.keys(captured.value), ...Object.keys(current.value)])) {
    const field = key as keyof Task;
    if (JSON.stringify(current.value[field]) !== JSON.stringify(captured.value[field])) {
      if (Object.hasOwn(current.value, field)) Object.assign(value, { [field]: current.value[field] });
      else delete value[field];
    }
  }
  return { ...current, value, revision: confirmed.revision };
}
