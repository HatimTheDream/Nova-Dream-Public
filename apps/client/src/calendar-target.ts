import {readLocal,saveLocal} from './api';
export type CalendarTarget={nonce:string;eventId:string;originalDate?:string;provider?:ProviderCalendarNavigation};
export const calendarTargetKey=(deviceId:string,windowId:string)=>`e3:calendar-target:${deviceId}:${windowId}`;
export function keepCalendarTarget(deviceId:string,windowId:string,eventId:string,originalDate?:string){const target={nonce:crypto.randomUUID(),eventId,...(originalDate?{originalDate}:{})};if(!saveLocal(calendarTargetKey(deviceId,windowId),target))throw new Error('Free browser storage before opening this event. Your saved follow-up remains in Calendar.');if(typeof window !== 'undefined')window.dispatchEvent(new Event('e3:calendar-target'));return target;}
export function readCalendarTarget(deviceId:string,windowId:string){return readLocal<CalendarTarget>(calendarTargetKey(deviceId,windowId));}
export type ProviderCalendarNavigation = { epoch: string; sourceId: string; generation: string; eventId: string; date: string; range: import('../../../packages/domain/calendar').CalendarRange };
export function keepProviderCalendarTarget(deviceId: string, windowId: string, provider: ProviderCalendarNavigation) {
  const target = { nonce: crypto.randomUUID(), eventId: provider.eventId, provider };
  if (!saveLocal(calendarTargetKey(deviceId, windowId), target)) throw Error('Free browser storage before opening this event.');
  window.dispatchEvent(new Event('e3:calendar-target')); return target;
}
