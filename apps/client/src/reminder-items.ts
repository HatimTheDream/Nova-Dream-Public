import type { Snapshot } from '../../../packages/domain/contracts';
import type { Reminder } from '../../../packages/domain/reminders';
import type { CalendarReminder } from '../../../packages/domain/calendar-reminders';
export type WorkspaceReminder = Reminder | CalendarReminder;
export const reminderItems = (snapshot: Snapshot): WorkspaceReminder[] => [...(snapshot.taskState?.reminders ?? []), ...(snapshot.calendarReminders?.items ?? [])];
export const reminderAttempts = (snapshot: Snapshot) => [...(snapshot.taskState?.reminderAttempts ?? []), ...(snapshot.calendarReminders?.attempts ?? [])];
export const reminderRoute = (item: WorkspaceReminder) => 'eventId' in item ? 'calendar' : 'tasks';
export const reminderTitle = (snapshot: Snapshot, item: WorkspaceReminder) => 'eventId' in item ? item.title : snapshot.tasks.find(task => task.id === item.taskId)?.value.title ?? 'Saved task';
