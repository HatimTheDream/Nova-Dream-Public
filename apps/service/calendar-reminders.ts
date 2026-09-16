import { randomUUID } from 'node:crypto';
import { addDays, type LocalCalendarEvent, type LocalCalendarOccurrence, type CalendarException } from '../../packages/domain/calendar.js';
import { expandLocalCalendar, localOccurrence } from '../../packages/domain/calendar-repeat.js';
import { calendarAlarm, calendarAlarmFingerprint, type CalendarReminder, type CalendarReminderState, type CalendarNotificationAttempt } from '../../packages/domain/calendar-reminders.js';
import { reminderActionSchema, reminderDeliverySchema, reminderWindowMs } from '../../packages/domain/reminders.js';
import { dayInZone } from '../../packages/domain/tasks.js';
import { Fault, Store } from './store.js';

type Scan = { revision: number; exceptionsRevision: number; nextDate: string; catchingUp: boolean };
const prefix = 'calendar-reminders:';
const closed = (item: CalendarReminder) => ['dismissed', 'cancelled'].includes(item.state);
const identity = (item: { eventId: string; originalDate?: string }) => `${item.eventId}:${item.originalDate ?? 'single'}`;
/** Adapts original Calendar alarms to the private host; it never creates Tasks or Gateway jobs. */
export class CalendarReminders {
  private nextScan = 0;
  constructor(private store: Store, private now: () => number) {}
  private items() { return this.store.internalList<CalendarReminder>(prefix + 'item:'); }
  private put(item: CalendarReminder) {
    const clean = JSON.parse(JSON.stringify(item)) as CalendarReminder;
    if (clean.notification) this.store.internalWrite(prefix + 'attempt:' + clean.notification.attemptId, { ...clean.notification, reminderId: clean.id, eventId: clean.eventId, originalDate: clean.originalDate, dueAt: clean.dueAt, snoozes: clean.snoozes } satisfies CalendarNotificationAttempt);
    return this.store.internalWrite(prefix + 'item:' + clean.id, clean);
  }
  private syncOccurrence(event: LocalCalendarOccurrence | undefined, previous?: CalendarReminder) {
    const alarm = event?.value.state !== 'cancelled' && event ? calendarAlarm(event.value) : undefined;
    if (!alarm || !event) {
      if (previous && !closed(previous)) this.put({ ...previous, state: 'cancelled', revision: previous.revision + 1 });
      return;
    }
    const sourceFingerprint = calendarAlarmFingerprint(event, alarm);
    const priorId = previous?.id ?? this.store.internalRead<string>(prefix + 'index:' + identity(event));
    const old = previous ?? (priorId ? this.store.internalRead<CalendarReminder>(prefix + 'item:' + priorId) : undefined);
    if (old && old.sourceFingerprint === sourceFingerprint && old.state !== 'cancelled') {
      // Title/notes changes must not rearm a dismissed alert, erase a snooze or repeat a notification.
      if (old.title !== event.value.title || old.eventRevision !== event.revision || old.overrideRevision !== event.overrideRevision) this.put({ ...old, title: event.value.title, eventRevision: event.revision, overrideRevision: event.overrideRevision, revision: old.revision + 1 });
      return;
    }
    if (old && !closed(old)) this.put({ ...old, state: 'cancelled', revision: old.revision + 1 });
    const item: CalendarReminder = { id: randomUUID(), revision: 1, eventId: event.eventId, originalDate: event.originalDate, eventRevision: event.revision, overrideRevision: event.overrideRevision, title: event.value.title, spec: alarm.spec, dueAt: alarm.dueAt, sourceDueAt: alarm.dueAt, sourceFingerprint, state: alarm.dueAt === null ? 'unavailable' : 'scheduled', snoozes: 0, ...(alarm.reason ? { reason: alarm.reason } : {}) };
    this.put(item); this.store.internalWrite(prefix + 'index:' + identity(event), item.id);
  }
  /** Called within the event's admission transaction, or this scheduler's transaction. */
  synchronize(master: LocalCalendarEvent) {
    const exceptions = this.store.internalList<CalendarException>(`calendar:exception:${master.id}:`);
    const scanKey = prefix + 'scan:' + master.id, previous = this.store.internalRead<Scan>(scanKey);
    const changed = !previous || previous.revision !== master.revision || previous.exceptionsRevision !== (master.exceptionsRevision ?? 0);
    if (changed) for (const old of this.items().filter(item => item.eventId === master.id)) {
      // Historical attempts stay attached to their original alarm, not the latest event index.
      if (this.store.internalRead(prefix + 'index:' + identity(old)) === old.id) this.syncOccurrence(localOccurrence(master, exceptions, old.originalDate), old);
    }
    const today = dayInZone(master.value.timezone, this.now()), horizon = addDays(today, 30);
    const initial = addDays(today, -1);
    const from = changed ? previous && previous.nextDate < initial ? previous.nextDate : initial : previous!.nextDate;
    // Each tick advances at most 31 civil days. Downtime resumes from the persisted cursor.
    const to = [addDays(from, 31), horizon].sort()[0];
    if (!master.isSeries && !master.value.repeat) this.syncOccurrence(localOccurrence(master, exceptions));
    else if (from < to) {
      const expansion = expandLocalCalendar(master, exceptions, { from, to, timezone: master.value.timezone });
      for (const occurrence of expansion.occurrences) this.syncOccurrence(occurrence);
      if (expansion.limited) throw new Fault(503, 'calendar_reminder_limit', 'Calendar reminders need a narrower scheduling window. Existing alerts are kept.');
    }
    this.store.internalWrite(scanKey, { revision: master.revision, exceptionsRevision: master.exceptionsRevision ?? 0, nextDate: from < to ? to : from, catchingUp: to < horizon } satisfies Scan);
  }
  private sweep() {
    const now = this.now();
    for (const original of this.items()) {
      let item = original;
      if (item.state === 'scheduled' && item.dueAt !== null && item.dueAt <= now) item = { ...item, state: 'ready' };
      if (item.state === 'ready' && item.dueAt !== null && now - item.dueAt > reminderWindowMs && !item.seenAt && item.notification?.state !== 'shown') item = { ...item, state: 'missed' };
      if (item.notification?.state === 'claimed' && now - item.notification.at > 20000) item = { ...item, notification: { ...item.notification, state: 'unknown' } };
      if (item !== original) this.put({ ...item, revision: original.revision + 1 });
    }
    for (const attempt of this.store.internalList<CalendarNotificationAttempt>(prefix + 'attempt:')) if (attempt.state === 'claimed' && now - attempt.at > 20000) this.store.internalWrite(prefix + 'attempt:' + attempt.attemptId, { ...attempt, state: 'unknown' });
  }
  tick() {
    this.store.internalAtomic(() => {
      if (this.now() >= this.nextScan) {
        for (const master of this.store.internalList<LocalCalendarEvent>('calendar:local:')) this.synchronize(master);
        this.nextScan = this.now() + 15000;
      }
      this.sweep();
    });
  }
  state(): CalendarReminderState {
    this.tick();
    return { items: this.items(), attempts: this.store.internalList<CalendarNotificationAttempt>(prefix + 'attempt:'), catchingUp: this.store.internalList<Scan>(prefix + 'scan:').some(scan => scan.catchingUp) };
  }
  act(device: string, raw: unknown): CalendarReminder {
    const cmd = reminderActionSchema.parse(raw);
    return this.store.admit(device, cmd, { type: 'calendar-reminder-action', ...cmd }, () => {
      this.sweep(); const item = this.store.internalRead<CalendarReminder>(prefix + 'item:' + cmd.reminderId);
      if (!item || item.revision !== cmd.expectedRevision) throw new Fault(409, 'reminder_changed', 'This Calendar reminder changed. Review its current state.', item);
      if (closed(item)) throw new Fault(409, 'reminder_closed', 'This Calendar reminder is already closed.');
      if (cmd.action === 'seen' && !['ready', 'missed', 'unavailable'].includes(item.state)) throw new Fault(409, 'reminder_not_due', 'This Calendar reminder is not ready to display.');
      if (cmd.action === 'seen' && item.seenAt) return item;
      return this.put({ ...item, revision: item.revision + 1, ...(cmd.action === 'seen' ? { seenAt: this.now() } : cmd.action === 'dismiss' ? { state: 'dismissed' as const } : { state: 'scheduled' as const, dueAt: this.now() + cmd.minutes! * 60000, seenAt: undefined, reason: undefined, notification: undefined, snoozes: item.snoozes + 1 }) });
    }).value;
  }
  deliver(device: string, raw: unknown): CalendarReminder {
    const cmd = reminderDeliverySchema.parse(raw);
    return this.store.admit(device, cmd, { type: 'calendar-reminder-delivery', ...cmd }, () => {
      this.sweep(); const item = this.store.internalRead<CalendarReminder>(prefix + 'item:' + cmd.reminderId);
      if (!item) throw new Fault(404, 'reminder_missing', 'This Calendar reminder is no longer available.');
      if (cmd.action === 'claim') {
        if (item.state !== 'ready' || item.notification) throw new Fault(409, 'reminder_claimed', 'A notification attempt already exists, or this reminder needs in-app review.');
        return this.put({ ...item, revision: item.revision + 1, notification: { attemptId: randomUUID(), deviceId: device, clientId: cmd.clientId, at: this.now(), state: 'claimed' } });
      }
      const attempt = this.store.internalRead<CalendarNotificationAttempt>(prefix + 'attempt:' + cmd.attemptId);
      if (!attempt || attempt.reminderId !== item.id || attempt.clientId !== cmd.clientId || attempt.deviceId !== device) throw new Fault(409, 'reminder_attempt_changed', 'This notification belongs to a different attempt.');
      const state = attempt.state === 'shown' ? 'shown' : cmd.action;
      this.store.internalWrite(prefix + 'attempt:' + attempt.attemptId, { ...attempt, state });
      if (item.notification?.attemptId !== attempt.attemptId) return item;
      return this.put({ ...item, revision: item.revision + 1, notification: { ...item.notification, state } });
    }).value;
  }
}
