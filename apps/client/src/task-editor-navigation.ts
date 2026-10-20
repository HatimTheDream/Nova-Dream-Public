import type { Command, Entity, ModuleId, Snapshot, Task } from '../../../packages/domain/contracts';
import { adoptTaskConfirmation, type TaskEditorDraft } from './task-editor-confirmation';
import type { ReminderReturn } from './reminder-workspace';

export type TaskSection = 'details' | 'dates' | 'history';
export type TaskOrigin = { route: ModuleId | 'settings'; label: string; reminders?: boolean; reminderReturn?: ReminderReturn };
export type TaskFrame = { taskId: string; section: TaskSection; scroll: number; sectionScroll?: Partial<Record<TaskSection, number>> };
export type TaskNavigation = {
  format: 1; epoch: string; deviceId: string; windowId: string; active: boolean;
  origin: TaskOrigin; frames: TaskFrame[]; children: Record<string, string>; token: string;
};
type Scope = Pick<TaskNavigation, 'epoch' | 'deviceId' | 'windowId'>;
export type TaskEditorStorage = { read(key: string): unknown; write(key: string, value: unknown): boolean };
export const taskDraftKey = (deviceId: string, taskId: string) => `e3:task-editor:${deviceId}:${taskId}`;
export const taskNavigationKey = (scope: Scope) => `e3:task-navigation:${scope.deviceId}:${scope.epoch}:${scope.windowId}`;
const sections = ['details', 'dates', 'history'];
const routes = ['home', 'assistant', 'tasks', 'calendar', 'inbox', 'contacts', 'agents', 'content', 'profile', 'settings'];
const taskId = (value: unknown): value is string => typeof value === 'string' && value.startsWith('task:') && value.length <= 100;

/** Legacy pointers are hints; only a matching unsaved journal can resume them. */
export function resumableNewTask(task: Entity<Task> | undefined, snapshot: Snapshot, storage: Pick<TaskEditorStorage, 'read'>): Entity<Task> | undefined {
  if (!task || task.revision !== 0 || !taskId(task.id) || task.deviceId !== snapshot.deviceId || [...snapshot.tasks, ...(snapshot.trashedTasks ?? [])].some(item => item.id === task.id)) return undefined;
  const journal = storage.read(taskDraftKey(snapshot.deviceId, task.id)) as TaskEditorDraft | undefined;
  if (!journal || journal.epoch !== snapshot.epoch || journal.revision !== 0 || !journal.value
    || journal.pending && (journal.pending.kind !== 'task' || journal.pending.entityId !== task.id || journal.pending.epoch !== snapshot.epoch || journal.pending.expectedRevision !== 0)) return undefined;
  return { ...task, value: journal.value };
}

export function readTaskNavigation(value: unknown, scope: Scope): TaskNavigation | undefined {
  const item = value as TaskNavigation | undefined;
  if (!item || item.format !== 1 || item.epoch !== scope.epoch || item.deviceId !== scope.deviceId || item.windowId !== scope.windowId
    || typeof item.active !== 'boolean' || typeof item.token !== 'string' || !item.token || !routes.includes(item.origin?.route)
    || typeof item.origin.label !== 'string' || item.origin.label.length > 100 || !Array.isArray(item.frames) || !item.frames.length || item.frames.length > 64
    || item.frames.some(frame => !taskId(frame?.taskId) || !sections.includes(frame.section) || !Number.isFinite(frame.scroll) || frame.scroll < 0
      || frame.sectionScroll && (typeof frame.sectionScroll !== 'object' || Object.entries(frame.sectionScroll).some(([section, scroll]) => !sections.includes(section) || !Number.isFinite(scroll) || scroll! < 0)))
    || !item.children || Array.isArray(item.children) || typeof item.children !== 'object'
    || Object.entries(item.children).some(([parent, child]) => !taskId(parent) || !taskId(child))) return undefined;
  return item;
}

/** Navigation contains identities only. Editable values stay in the original task journal. */
export class TaskNavigationController {
  state: TaskNavigation | undefined;
  error = '';
  private newChildren = new Map<string, Entity<Task>>();
  constructor(readonly scope: Scope, private storage: TaskEditorStorage, private snapshot: () => Snapshot, private nonce: () => string = () => crypto.randomUUID()) {
    this.state = readTaskNavigation(storage.read(taskNavigationKey(scope)), scope);
  }
  get frame() { return this.state?.frames.at(-1); }
  get selected() { return this.state?.active && this.frame ? this.resolve(this.frame.taskId) : undefined; }
  resolve(id: string): Entity<Task> | undefined {
    const snapshot = this.snapshot();
    if (snapshot.epoch !== this.scope.epoch || snapshot.deviceId !== this.scope.deviceId) return undefined;
    const saved = [...snapshot.tasks, ...(snapshot.trashedTasks ?? [])].find(task => task.id === id);
    if (saved) return saved;
    const draft = this.storage.read(taskDraftKey(this.scope.deviceId, id)) as TaskEditorDraft | undefined;
    // A missing saved task must never be resurrected from an old local value.
    if (!draft || draft.epoch !== this.scope.epoch || draft.revision !== 0 || !draft.value || !taskId(id)) return undefined;
    return { id, revision: 0, deviceId: this.scope.deviceId, updatedAt: '', value: draft.value };
  }
  private keep(next: TaskNavigation) {
    if (this.snapshot().epoch !== this.scope.epoch || this.snapshot().deviceId !== this.scope.deviceId) { this.error = 'The workspace changed. Your task drafts are kept in the original workspace.'; return false; }
    if (!this.storage.write(taskNavigationKey(this.scope), next)) { this.error = 'Free browser storage before leaving. Your task and return path are still open.'; return false; }
    this.state = next; this.error = ''; return true;
  }
  private keepNew(task: Entity<Task>) {
    if (task.revision !== 0) return true;
    const key = taskDraftKey(this.scope.deviceId, task.id), existing = this.storage.read(key) as TaskEditorDraft | undefined;
    if (existing) {
      if (existing.epoch === this.scope.epoch && existing.revision === 0) return true;
      this.error = 'This task has a retained save or belongs to an earlier workspace. Its original draft is kept.'; return false;
    }
    if (this.storage.write(key, { value: task.value, revision: 0, epoch: this.scope.epoch })) return true;
    this.error = 'Free browser storage before opening this new task. Nothing was created on the host.'; return false;
  }
  open(task: Entity<Task>, origin: TaskOrigin) {
    if (!this.keepNew(task)) return false;
    return this.keep({ ...this.scope, format: 1, active: true, origin, frames: [{ taskId: task.id, section: 'details', scroll: 0 }], children: this.state?.children ?? {}, token: this.nonce() });
  }
  go(task: Entity<Task>) {
    if (!this.state?.active || !this.keepNew(task)) return false;
    if (this.frame?.taskId === task.id) return true;
    const index = this.state.frames.findIndex(frame => frame.taskId === task.id);
    const frames = index >= 0 ? this.state.frames.slice(0, index + 1) : [...this.state.frames, { taskId: task.id, section: 'details' as const, scroll: 0 }];
    if (frames.length > 64) { this.error = 'Return to an earlier task before opening another level. Your drafts are kept.'; return false; }
    return this.keep({ ...this.state, frames, token: this.nonce() });
  }
  child(defaults: Partial<Task>) {
    const parent = this.selected;
    if (!parent || !parent.revision || defaults.parentTaskId !== parent.id || !this.state) return false;
    const remembered = this.state.children[parent.id] ?? this.newChildren.get(parent.id)?.id;
    const kept = remembered ? this.resolve(remembered) : undefined;
    const task = kept?.revision === 0 ? kept : { id: `task:${this.nonce()}`, revision: 0, deviceId: this.scope.deviceId, updatedAt: '', value: { title: '', notes: '', status: 'open' as const, planned: '', due: '', ...defaults } };
    if (!this.keepNew(task)) return false;
    this.newChildren.set(parent.id, task);
    // The existing draft is retained before its navigation reference becomes active.
    if (!this.keep({ ...this.state, children: { ...this.state.children, [parent.id]: task.id } })) return false;
    const opened = this.go(task);
    if (opened && task.value.parentTaskId !== parent.id) this.error = 'This kept draft now has a different parent or no parent. Its relationship is unchanged; Back returns to the task where you opened it.';
    return opened;
  }
  view(section: TaskSection, scroll: number) {
    if (!this.state?.active || !this.frame) return false;
    return this.keep({ ...this.state, frames: [...this.state.frames.slice(0, -1), { ...this.frame, section, scroll: Math.max(0, scroll), sectionScroll: { ...this.frame.sectionScroll, [section]: Math.max(0, scroll) } }] });
  }
  back() {
    if (!this.state?.active || this.state.frames.length < 2) return false;
    const previous = this.state.frames.at(-2)!;
    if (!this.resolve(previous.taskId)) { this.error = 'The previous task is unavailable. This task and both drafts are kept.'; return false; }
    return this.keep({ ...this.state, frames: this.state.frames.slice(0, -1), token: this.nonce() });
  }
  close() { return !!this.state && this.keep({ ...this.state, active: false, token: this.nonce() }); }
  dismissError() { this.error = ''; return true; }
  acknowledged(task: Entity<Task>, token: string, clean: boolean) {
    for (const [parent, child] of this.newChildren) if (child.id === task.id) this.newChildren.delete(parent);
    if (!clean || !this.state?.active || this.state.token !== token || this.frame?.taskId !== task.id) return false;
    return this.state.frames.length > 1 ? this.back() : this.close();
  }
}

/** An old acknowledgment cannot remove newer writing, even for the same task. */
export function confirmedTaskDraft(stored: TaskEditorDraft | undefined, command: Command, confirmed: Entity<Task>): { draft: TaskEditorDraft; clean: boolean } | undefined {
  if (!stored?.pending || JSON.stringify(stored.pending) !== JSON.stringify(command) || command.kind !== 'task'
    || command.entityId !== confirmed.id || stored.epoch !== command.epoch || stored.revision !== command.expectedRevision || confirmed.revision <= command.expectedRevision) return undefined;
  const draft = adoptTaskConfirmation({ ...stored, pending: undefined }, { ...confirmed, revision: command.expectedRevision, value: command.payload as Task }, confirmed, command.epoch);
  return { draft: { ...draft, confirmation: { requestId: command.requestId, task: confirmed } }, clean: JSON.stringify(draft.value) === JSON.stringify(confirmed.value) };
}

/** Reopened editors may observe our original response through the retained journal. */
export function reopenedTaskConfirmation(current: TaskEditorDraft, retained: TaskEditorDraft | undefined) {
  const command = current.pending, confirmed = retained?.confirmation?.task;
  if (!command || !confirmed || retained?.confirmation?.requestId !== command.requestId || retained.pending || retained.epoch !== current.epoch || retained.revision !== confirmed.revision) return undefined;
  const next = confirmedTaskDraft(current, command, confirmed);
  return next && { ...next, confirmed };
}
