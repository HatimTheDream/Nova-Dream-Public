import { z } from 'zod';
import type { Snapshot } from '../../../packages/domain/contracts';
import { reminderActionSchema, reminderSchema } from '../../../packages/domain/reminders';
import { reminderRoute, type WorkspaceReminder } from './reminder-items';

export type ReminderScope = { epoch: string; deviceId: string; windowId: string };
const routeSchema = z.enum(['home', 'assistant', 'tasks', 'calendar', 'inbox', 'contacts', 'agents', 'content', 'profile', 'settings']);
export const reminderTabs = ['due', 'snoozed', 'history'] as const;
export type ReminderTab = typeof reminderTabs[number];
const scopeFields = { epoch: z.string(), deviceId: z.string(), windowId: z.string() };
const originalSchema = z.object({ ...scopeFields, token: z.string().uuid(), reminderId: z.string().uuid(), kind: z.enum(['tasks', 'calendar']), id: z.string(), originalDate: z.string().optional(), from: routeSchema });
export type ReminderReturn = z.infer<typeof originalSchema>;
const positionSchema = z.object({ page: z.number().int().nonnegative(), scroll: z.number().finite().nonnegative() });
const viewSchema = z.object({ ...scopeFields, format: z.literal(1), open: z.boolean(), tab: z.enum(reminderTabs), positions: z.record(z.string(), positionSchema), durations: z.record(z.string(), z.string().max(20)), original: originalSchema.optional() });
export type ReminderView = z.infer<typeof viewSchema>;
export const reminderViewKey = (s: ReminderScope) => `e3:reminders-view:${s.deviceId}:${s.epoch}:${s.windowId}`;
export const reminderActionPrefix = (s: ReminderScope) => `e3:reminder-action:${s.deviceId}:${s.windowId}:`;
export const reminderActionKey = (s: ReminderScope, id: string) => reminderActionPrefix(s) + id;
export const sameReminderScope = (a: ReminderScope, b: ReminderScope) => a.epoch === b.epoch && a.deviceId === b.deviceId && a.windowId === b.windowId;
export function readReminderView(value: unknown, scope: ReminderScope): ReminderView {
  const parsed = viewSchema.safeParse(value);
  return parsed.success && sameReminderScope(parsed.data, scope) ? parsed.data : { ...scope, format: 1, open: false, tab: 'due', positions: {}, durations: {} };
}
export function matchingReminderReturn(value: unknown, scope: ReminderScope, view: ReminderView): value is ReminderReturn {
  const parsed = originalSchema.safeParse(value);
  return parsed.success && sameReminderScope(parsed.data, scope) && JSON.stringify(parsed.data) === JSON.stringify(view.original);
}
export type PreparedReminderReturn = { view: ReminderView; navigation: number };
/** Persist the final view before the caller closes its editor. Keep its token if close refuses. */
export function retainReminderReturn(origin: ReminderReturn, scope: ReminderScope, navigation: number, storage: Storage): PreparedReminderReturn {
  const key = reminderViewKey(scope), view = readReminderView(storage.read(key), scope);
  if (!matchingReminderReturn(origin, scope, view)) throw Error('The original Reminders return is unavailable in this workspace. Its saved view is kept.');
  const finalView = { ...view, open: true };
  if (!storage.write(key, finalView)) throw Error('Free browser storage before returning. Your current editor and reminder view are kept.');
  return { view: finalView, navigation };
}
export function preparedReminderReturnMatches(prepared: PreparedReminderReturn | undefined, origin: ReminderReturn, scope: ReminderScope, navigation: number): boolean {
  return !!prepared && prepared.navigation === navigation && matchingReminderReturn(origin, scope, prepared.view);
}
export const reminderIdentity = (r: WorkspaceReminder) => `${reminderRoute(r)}:${r.id}`;
export function reminderGroup(r: WorkspaceReminder): ReminderTab | 'scheduled' {
  if (r.state === 'dismissed' || r.state === 'cancelled') return 'history';
  if (r.state === 'scheduled') return r.snoozes > 0 ? 'snoozed' : 'scheduled';
  return 'due';
}
export function reminderPage(items: WorkspaceReminder[], group: ReminderTab | 'scheduled', requested: number, size = 20) {
  const sorted = items.filter(r => reminderGroup(r) === group).sort((a, b) => (group === 'history' ? -1 : 1) * ((a.dueAt ?? 0) - (b.dueAt ?? 0)) || reminderIdentity(a).localeCompare(reminderIdentity(b)));
  const pages = Math.max(1, Math.ceil(sorted.length / size)), page = Math.min(Math.max(0, requested), pages - 1);
  return { items: sorted.slice(page * size, (page + 1) * size), total: sorted.length, page, pages };
}
export function snoozeMinutes(text: string): number | undefined {
  if (!/^\d{1,4}$/.test(text.trim())) return undefined;
  const minutes = Number(text); return minutes >= 1 && minutes <= 1440 ? minutes : undefined;
}

export type ReminderCommand = z.infer<typeof reminderActionSchema>;
export type ReminderActionJournal = { format: 1; route?: 'tasks' | 'calendar'; command: ReminderCommand; original?: WorkspaceReminder; captured?: true; confirmed?: WorkspaceReminder; refusal?: { code: string; message: string } };
type Storage = { read(key: string): unknown; write(key: string, value: unknown): boolean };
const recordSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), spec: reminderSchema, dueAt: z.number().finite().nullable(), state: z.enum(['scheduled', 'ready', 'missed', 'unavailable', 'dismissed', 'cancelled']), snoozes: z.number().int().nonnegative() }).passthrough();
function validRecord(value: unknown): value is WorkspaceReminder {
  const parsed = recordSchema.safeParse(value); if (!parsed.success) return false;
  const r = value as WorkspaceReminder;
  return 'eventId' in r ? typeof r.eventId === 'string' && (r.originalDate === undefined || typeof r.originalDate === 'string') && typeof r.title === 'string' : typeof r.taskId === 'string';
}
export function readReminderAction(value: unknown, id: string, known?: WorkspaceReminder): ReminderActionJournal | undefined {
  if (!value) return undefined;
  const record = value as ReminderActionJournal;
  const command = reminderActionSchema.safeParse(record.format === 1 ? record.command : value);
  if (!command.success || command.data.reminderId !== id || command.data.action === 'seen') return undefined;
  const route = record.format === 1 ? record.route : known && reminderRoute(known);
  if (route !== undefined && route !== 'tasks' && route !== 'calendar' || known && route && route !== reminderRoute(known)) return undefined;
  if (record.format === 1 && (record.original && (!validRecord(record.original) || record.original.id !== id || reminderRoute(record.original) !== route)
    || record.confirmed && (!validRecord(record.confirmed) || record.confirmed.id !== id || reminderRoute(record.confirmed) !== route)
    || record.captured !== undefined && (record.captured !== true || record.original?.revision !== command.data.expectedRevision)
    || record.confirmed && record.refusal
    || record.refusal && (typeof record.refusal.code !== 'string' || typeof record.refusal.message !== 'string'))) return undefined;
  const result: ReminderActionJournal = record.format === 1 ? { ...record, command: command.data } : { format: 1, route, command: command.data, original: known };
  if (result.confirmed && !confirmsReminderAction(result, result.confirmed)) return undefined;
  return result;
}
export function pendingReminderActions(storage: Pick<Storage, 'read'>, keys: string[], scope: ReminderScope, items: WorkspaceReminder[]) {
  return keys.filter(key => key.startsWith(reminderActionPrefix(scope))).map(key => {
    const id = key.slice(reminderActionPrefix(scope).length), known = items.find(r => r.id === id), raw = storage.read(key);
    return { key, id, known, raw, journal: readReminderAction(raw, id, known) };
  }).filter(row => row.raw && (!row.journal || !row.journal.confirmed && !row.journal.refusal));
}
function sameOriginal(a: WorkspaceReminder, b: WorkspaceReminder) {
  return reminderRoute(a) === reminderRoute(b) && ('eventId' in a && 'eventId' in b ? a.eventId === b.eventId && a.originalDate === b.originalDate : 'taskId' in a && 'taskId' in b && a.taskId === b.taskId);
}
export function confirmsReminderAction(original: ReminderActionJournal, confirmed: unknown): confirmed is WorkspaceReminder {
  return validRecord(confirmed) && !!original.original && confirmed.id === original.command.reminderId && sameOriginal(original.original, confirmed)
    && confirmed.revision === original.command.expectedRevision + 1 && (original.command.action === 'dismiss' ? confirmed.state === 'dismissed'
      : original.command.action === 'snooze' && confirmed.state === 'scheduled' && confirmed.dueAt !== null && (!original.captured || confirmed.snoozes === original.original.snoozes + 1));
}

/** One original command owns its response. A refresh failure never makes known success unsent. */
export class ReminderActionController {
  busy = false;
  error = '';
  private response?: { command: ReminderCommand; item: WorkspaceReminder };
  constructor(readonly scope: ReminderScope, readonly id: string, private storage: Storage,
    private currentScope: () => ReminderScope, private send: (route: string, command: ReminderCommand) => Promise<WorkspaceReminder>,
    private refresh: () => Promise<void>, private changed: () => void = () => {}) {}
  observe(changed: () => void) { this.changed = changed; }
  get confirmed() {
    const journal = readReminderAction(this.storage.read(reminderActionKey(this.scope, this.id)), this.id);
    return journal && this.response && JSON.stringify(journal.command) === JSON.stringify(this.response.command) ? this.response.item : undefined;
  }
  async run(item?: WorkspaceReminder, action?: 'dismiss' | 'snooze', minutes?: number) {
    if (this.busy) return false;
    this.busy = true; this.error = ''; this.changed();
    const key = reminderActionKey(this.scope, this.id);
    try {
      if (!sameReminderScope(this.scope, this.currentScope())) throw Error('The workspace changed. The original reminder action is kept.');
      if (item && item.id !== this.id) throw Error('This action belongs to a different reminder.');
      const raw = this.storage.read(key); let journal = readReminderAction(raw, this.id, item);
      if (raw && !journal) throw Error('The kept action cannot be checked safely. Its original record is preserved.');
      if (journal && journal.command.epoch !== this.scope.epoch) throw Error('This action belongs to an earlier workspace. It is kept and will not be sent.');
      if (this.confirmed && journal && !journal.confirmed && !journal.refusal) {
        const next = { ...journal, confirmed: this.confirmed };
        if (!this.storage.write(key, next)) throw Error('Saved on the host. Keep this window open until browser storage can retain the response.');
        journal = next;
      }
      if (journal?.confirmed && !action) { this.response = { command: journal.command, item: journal.confirmed }; await this.refresh(); return true; }
      if (journal?.refusal && !action) throw Error(journal.refusal.message);
      if (!journal || journal.confirmed || journal.refusal) {
        if (!item || !action) throw Error('The original reminder is unavailable. Its kept action has not been replaced.');
        if (journal?.confirmed && item.revision < journal.confirmed.revision) throw Error('Refresh the reminder before making another change. The previous change is saved.');
        const command = reminderActionSchema.parse({ requestId: crypto.randomUUID(), epoch: this.scope.epoch, reminderId: item.id, expectedRevision: item.revision, action, ...(action === 'snooze' ? { minutes } : {}) });
        journal = { format: 1, route: reminderRoute(item), command, original: item, captured: true }; this.response = undefined;
      }
      if (!journal.route || !journal.original) throw Error('The original source is unavailable. This legacy action is kept for review.');
      if (!this.storage.write(key, journal)) throw Error('Free browser storage before changing this reminder.');
      const original = journal;
      let confirmed: WorkspaceReminder;
      try { confirmed = await this.send(`${original.route}/reminders/action`, original.command); }
      catch (error) {
        const failure = error as { code?: string; message?: string };
        if (['reminder_changed', 'reminder_closed', 'reminder_not_due', 'epoch_changed'].includes(failure.code ?? '') && this.samePending(key, original)) {
          this.storage.write(key, { ...original, refusal: { code: failure.code!, message: failure.message ?? 'Review the current reminder before changing it.' } });
        }
        throw error;
      }
      if (!confirmsReminderAction(original, confirmed)) throw Error('The reply did not confirm this exact reminder action. Check the original response.');
      this.response = { command: original.command, item: confirmed };
      if (this.samePending(key, original) && !this.storage.write(key, { ...original, confirmed })) throw Error('Saved on the host. Keep this window open until browser storage can retain the response.');
      await this.refresh(); return true;
    } catch (error) { this.error = error instanceof Error ? error.message : 'This change is unconfirmed. Check its original response.'; return false; }
    finally { this.busy = false; this.changed(); }
  }
  private samePending(key: string, original: ReminderActionJournal) {
    const current = readReminderAction(this.storage.read(key), this.id);
    return current && !current.confirmed && !current.refusal && JSON.stringify(current.command) === JSON.stringify(original.command);
  }
}

export function reminderSourceNotice(snapshot: Snapshot, r: WorkspaceReminder): string | undefined {
  if ('eventId' in r) return undefined; // Calendar identity is checked by its exact detail endpoint.
  if (snapshot.trashedTasks?.some(task => task.id === r.taskId)) return 'The original task is in Trash. Its reminder history is kept.';
  if (!snapshot.tasks.some(task => task.id === r.taskId)) return 'The original task is unavailable. This reminder is kept.';
}
