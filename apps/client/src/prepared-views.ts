import type { Snapshot } from '../../../packages/domain/contracts';
import { addDays, type CalendarRange } from '../../../packages/domain/calendar';
import { dayInZone } from '../../../packages/domain/tasks';
import { calendarWindowIdentity } from './calendar-window';
import { readLocal, request } from './api';

let owner = '';
const values = new Map<string, unknown>();
const identity = (snapshot: Pick<Snapshot, 'epoch' | 'deviceId'>) => `${snapshot.epoch}:${snapshot.deviceId}`;
export function readPreparedView<T>(snapshot: Pick<Snapshot, 'epoch' | 'deviceId'>, path: string): T | undefined {
  return owner === identity(snapshot) ? values.get(path) as T | undefined : undefined;
}
export function keepPreparedView(snapshot: Pick<Snapshot, 'epoch' | 'deviceId'>, path: string, value: unknown) {
  if (owner !== identity(snapshot)) { owner = identity(snapshot); values.clear(); }
  values.set(path, value);
  if (values.size > 64) values.delete(values.keys().next().value!);
}
export function calendarViewRange(day: string, timezone: string): CalendarRange {
  const first = day.slice(0, 8) + '01';
  const from = addDays(first, -new Date(first + 'T12:00:00Z').getUTCDay());
  return { from, to: addDays(from, 42), timezone };
}
export const calendarReadPath = (range: CalendarRange) => `calendar/state?${new URLSearchParams(range)}`;
export async function prepareInitialViews(snapshot: Snapshot) {
  const window = await calendarWindowIdentity();
  const saved = readLocal<{day?:string}>(`e3:original-calendar-view:${snapshot.deviceId}:${window.id}`) ?? readLocal<{day?:string}>(`e3:calendar:${snapshot.deviceId}:${window.id}`);
  const range = calendarViewRange(saved?.day ?? dayInZone(snapshot.layout.value.timezone), snapshot.layout.value.timezone);
  await Promise.all(['profile/progress', 'agents/hub?archived=false', calendarReadPath(range)].map(async path => {
    const value = await request<{epoch?:string;deviceId?:string}>(path);
    if (value.epoch && value.epoch !== snapshot.epoch || value.deviceId && value.deviceId !== snapshot.deviceId) throw Error('The workspace changed while preparing its views.');
    keepPreparedView(snapshot, path, value);
  }));
}
