import {readLocal,saveLocal} from './api';
import { matchingReminderReturn, type ReminderReturn, type ReminderScope, type ReminderView } from './reminder-workspace';
import type { LocalCalendarDetail } from '../../../packages/domain/calendar';
export type CalendarTarget={nonce:string;eventId:string;originalDate?:string;provider?:ProviderCalendarNavigation;reminderReturn?:ReminderReturn};
export const calendarTargetKey=(deviceId:string,windowId:string)=>`e3:calendar-target:${deviceId}:${windowId}`;
export function keepCalendarTarget(deviceId:string,windowId:string,eventId:string,originalDate?:string,reminderReturn?:ReminderReturn){const target={nonce:crypto.randomUUID(),eventId,...(originalDate?{originalDate}:{}),...(reminderReturn?{reminderReturn}:{})};if(!saveLocal(calendarTargetKey(deviceId,windowId),target))throw new Error('Free browser storage before opening this event. Your saved follow-up remains in Calendar.');if(typeof window !== 'undefined')window.dispatchEvent(new Event('e3:calendar-target'));return target;}
export function readCalendarTarget(deviceId:string,windowId:string){return readLocal<CalendarTarget>(calendarTargetKey(deviceId,windowId));}
/** Resolve the exact original only while this caller still owns its navigation. */
export async function resolveLocalCalendarTarget(target: CalendarTarget, scope: ReminderScope, current: () => boolean,
  read: () => Promise<LocalCalendarDetail>, view: () => ReminderView): Promise<LocalCalendarDetail | undefined> {
  const detail = await read();
  if (!current()) return undefined;
  if (detail.epoch !== scope.epoch || detail.event.id !== target.eventId) throw Error('Reconnect before opening this exact Calendar event.');
  if (target.originalDate && detail.occurrence?.originalDate !== target.originalDate) throw Error('The original occurrence is unavailable. Its reminder is kept; no different date was opened.');
  if (target.reminderReturn && (!matchingReminderReturn(target.reminderReturn, scope, view())
    || target.reminderReturn.kind !== 'calendar' || target.reminderReturn.id !== detail.event.id || target.reminderReturn.originalDate !== target.originalDate)) throw Error('Reopen this exact event from its retained reminder.');
  return detail;
}
export type ProviderCalendarNavigation = { epoch: string; sourceId: string; generation: string; eventId: string; date: string; range: import('../../../packages/domain/calendar').CalendarRange };
export function keepProviderCalendarTarget(deviceId: string, windowId: string, provider: ProviderCalendarNavigation) {
  const target = { nonce: crypto.randomUUID(), eventId: provider.eventId, provider };
  if (!saveLocal(calendarTargetKey(deviceId, windowId), target)) throw Error('Free browser storage before opening this event.');
  window.dispatchEvent(new Event('e3:calendar-target')); return target;
}
