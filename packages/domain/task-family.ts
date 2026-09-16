import type { Entity, Task } from './contracts.js';

/** Roots resolve before their children. Unresolved nodes have a missing,
 * trashed or cyclic parent, or descend from one of those nodes. */
export function invalidTaskParents(tasks: Pick<Entity<Task>, 'id' | 'value'>[]): Set<string> {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map<string, string[]>(), ready: string[] = [];
  for (const task of tasks) {
    const parent = task.value.parentTaskId;
    if (!parent) ready.push(task.id);
    else {
      const list = children.get(parent) ?? []; list.push(task.id); children.set(parent, list);
    }
  }
  const valid = new Set<string>();
  for (let n = 0; n < ready.length; n++) {
    const id = ready[n]; valid.add(id);
    for (const child of children.get(id) ?? []) if (byId.get(child)!.value.trashed || !byId.get(id)!.value.trashed) ready.push(child);
  }
  return new Set(tasks.filter(task => !valid.has(task.id)).map(task => task.id));
}

export function taskDescendants(tasks: Pick<Entity<Task>, 'id' | 'value'>[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const task of tasks) if (task.value.parentTaskId) { const list = children.get(task.value.parentTaskId) ?? []; list.push(task.id); children.set(task.value.parentTaskId, list); }
  const found = new Set<string>([id]), pending = [id];
  for (let n = 0; n < pending.length; n++) for (const child of children.get(pending[n]) ?? []) if (!found.has(child)) { found.add(child); pending.push(child); }
  found.delete(id); return found;
}
