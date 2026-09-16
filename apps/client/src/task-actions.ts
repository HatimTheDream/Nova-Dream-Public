import type { Command, Entity, Task } from '../../../packages/domain/contracts';

export type TaskChange = { task: Entity<Task>; value: Task };
type Entry = { command: Command; before?: Entity<Task> };
type Reversal = { before: Entity<Task>; after: Entity<Task> };
export type TaskJournal = { epoch?: string; queue: Entry[]; undo: Reversal[]; label: string; error: string; notice: string; rejected?: string[] };
type Options = { epoch: string; epochNow?: () => string; initial?: TaskJournal; legacy?: Command[]; persist(value: TaskJournal): boolean; commit(command: Command): Promise<Entity<Task>>; changed(): void; refresh(): Promise<void> };

/** Existing revisioned commands, with one durable journal for batch progress and undo. */
export function createTaskActions(options: Options) {
  let state: TaskJournal = options.initial ?? { queue: (options.legacy ?? []).map(command => ({ command })), undo: [], label: 'Save tasks', error: '', notice: '' };
  let busy = false;
  const update = (next: TaskJournal) => {
    if (!options.persist(next)) { state = { ...state, error: 'Browser storage is full. Keep this window open and retry after freeing space.' }; options.changed(); return false; }
    state = next; options.changed(); return true;
  };
  async function retry() {
    if (busy || !state.queue.length) return false;
    if (!update({ ...state, error: '' })) return false;
    busy = true; options.changed(); let failed = false;
    try {
      while (state.queue.length) {
        const entry = state.queue[0];
        try {
          const after = await options.commit(entry.command);
          if (!update({ ...state, queue: state.queue.slice(1), undo: entry.before ? [...state.undo, { before: entry.before, after }] : state.undo })) return false;
        } catch (reason) {
          const error = reason as { status?: number; code?: string; message?: string };
          const definitive = !!error.status && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
          const detail = `${entry.before?.value.title ?? 'Task'}: ${error.message ?? 'Save not confirmed.'}`;
          failed = true;
          if (!definitive) { update({ ...state, error: `${detail} Retry checks the original request before continuing.` }); break; }
          // A rejected task does not prevent independent selected tasks from saving.
          const rejected = [...(state.rejected ?? []), detail];
          if (!update({ ...state, queue: state.queue.slice(1), rejected, error: rejected.join('\n') })) return false;
        }
      }
      if (!state.queue.length) { failed ||= !!state.rejected?.length; update({ ...state, error: state.rejected?.join('\n') ?? state.error, notice: failed ? `${state.undo.length} changes saved. Review the remaining tasks.` : state.label }); }
      try { await options.refresh(); } catch { update({ ...state, error: 'Saved changes could not be refreshed. Reconnect to see the latest tasks.' }); }
      return !failed && !state.queue.length;
    } finally { busy = false; options.changed(); }
  }
  async function run(changes: TaskChange[], label: string) {
    if (busy || state.queue.length || !changes.length) return false;
    if (changes.length > 500 || new Set(changes.map(c => c.task.id)).size !== changes.length) return false;
    const queue = changes.map(({ task, value }) => ({ before: task.revision ? task : undefined, command: { requestId: crypto.randomUUID(), epoch: options.epochNow?.() ?? options.epoch, kind: 'task' as const, entityId: task.id, expectedRevision: task.revision, payload: value } }));
    if (!update({ epoch: options.epochNow?.() ?? options.epoch, queue, undo: [], label, error: '', notice: '' })) return false;
    return retry();
  }
  return { get state() { return state; }, get busy() { return busy; }, run, retry,
    undo() { if (state.epoch !== (options.epochNow?.() ?? options.epoch)) { update({ ...state, undo: [], error: 'The workspace changed. Review its current tasks before making another change.' }); return Promise.resolve(false); } return run([...state.undo].reverse().map(item => ({ task: item.after, value: item.before.value })), 'Changes undone'); },
    dismiss() { if (!busy) update({ ...state, error: '', notice: '', rejected: [], undo: [] }); },
  };
}
