import type { CalendarEvent } from '../../pages/Calendar/calendarTypes';

export const CALENDAR_MONTH_CACHE_LIMIT = 4;
export const CALENDAR_MONTH_CACHE_TTL_MS = 10 * 60 * 1000;
export const CALENDAR_MONTH_EVENT_LIMIT = 2_000;
export const CALENDAR_MONTH_PAYLOAD_LIMIT_BYTES = 2 * 1024 * 1024;

export interface CalendarMonthRange {
  monthKey: string;
  startDate: string;
  endDateExclusive: string;
  from: string;
  to: string;
  timeZone: string;
}

export interface CalendarMonthCacheEntry {
  monthKey: string;
  range: CalendarMonthRange;
  events: CalendarEvent[];
  fetchedAt: string;
  sourceState: 'fresh' | 'partial' | 'offline-cache';
  sources?: Array<{ provider: 'google' | 'microsoft'; account: string; status: 'ready' | 'error'; eventCount: number }>;
}

export interface CalendarMonthResponseIdentity {
  requestId: string;
  generation: number;
  monthKey: string;
  startDate: string;
  endDateExclusive: string;
}

export function matchesCalendarMonthResponse(
  active: { requestId: string; generation: number; monthKey: string } | null,
  range: CalendarMonthRange,
  response: CalendarMonthResponseIdentity,
): boolean {
  return Boolean(
    active
    && active.requestId === response.requestId
    && active.generation === response.generation
    && active.monthKey === response.monthKey
    && response.monthKey === range.monthKey
    && response.startDate === range.startDate
    && response.endDateExclusive === range.endDateExclusive,
  );
}

export function createGregorianMonthRange(
  anchor: Date,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
): CalendarMonthRange {
  if (Number.isNaN(anchor.getTime())) throw new Error('Calendar month requires a valid date.');
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const start = new Date(year, month, 1, 0, 0, 0, 0);
  const end = new Date(year, month + 1, 1, 0, 0, 0, 0);
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  return {
    monthKey,
    startDate: `${monthKey}-01`,
    endDateExclusive: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-01`,
    from: start.toISOString(),
    to: end.toISOString(),
    timeZone,
  };
}

export function shiftGregorianMonth(anchor: Date, delta: number): Date {
  const date = new Date(anchor);
  const intendedDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + delta);
  date.setDate(Math.min(intendedDay, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  return date;
}

export function previousGregorianDate(date: string): string {
  const value = new Date(`${date}T12:00:00`);
  if (Number.isNaN(value.getTime())) return date;
  value.setDate(value.getDate() - 1);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function calendarEventOverlapsRange(event: Pick<CalendarEvent, 'date' | 'endDate' | 'status'>, range: CalendarMonthRange): boolean {
  if (event.status === 'cancelled') return false;
  const endDate = event.endDate || event.date;
  return event.date < range.endDateExclusive && endDate >= range.startDate;
}

export function eventsWithinMonth(events: CalendarEvent[], range: CalendarMonthRange): CalendarEvent[] {
  return events.filter((event) => calendarEventOverlapsRange(event, range));
}

export function calendarPayloadBytes(events: unknown[]): number {
  return new TextEncoder().encode(JSON.stringify(events)).byteLength;
}

export function assertBoundedCalendarPayload(events: unknown[]): void {
  if (events.length > CALENDAR_MONTH_EVENT_LIMIT) throw new Error('Calendar month returned too many events.');
  if (calendarPayloadBytes(events) > CALENDAR_MONTH_PAYLOAD_LIMIT_BYTES) throw new Error('Calendar month response exceeded the safety limit.');
}

export class CalendarMonthLruCache<T extends { monthKey: string }> {
  readonly #limit: number;
  readonly #entries = new Map<string, T>();

  constructor(limit = CALENDAR_MONTH_CACHE_LIMIT, initialEntries: T[] = []) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Calendar cache requires a positive limit.');
    this.#limit = limit;
    initialEntries.slice(-limit).forEach((entry) => this.set(entry));
  }

  get(monthKey: string): T | undefined {
    const entry = this.#entries.get(monthKey);
    if (!entry) return undefined;
    this.#entries.delete(monthKey);
    this.#entries.set(monthKey, entry);
    return entry;
  }

  peek(monthKey: string): T | undefined {
    return this.#entries.get(monthKey);
  }

  set(entry: T): void {
    this.#entries.delete(entry.monthKey);
    this.#entries.set(entry.monthKey, entry);
    while (this.#entries.size > this.#limit) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.#entries.delete(oldestKey);
    }
  }

  delete(monthKey: string): void {
    this.#entries.delete(monthKey);
  }

  values(): T[] {
    return Array.from(this.#entries.values());
  }

  get size(): number {
    return this.#entries.size;
  }
}

export function isFreshCalendarCache(entry: CalendarMonthCacheEntry, now = Date.now()): boolean {
  const fetchedAt = Date.parse(entry.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt <= CALENDAR_MONTH_CACHE_TTL_MS;
}
