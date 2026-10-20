import { z } from 'zod';
import { buildProfileDay, buildProfileWeek, profileWeekIdentitySchema, profileWeekStartSchema, profileTimezoneSchema, shiftProfileDay } from '../../packages/domain/profile-week.js';
import { questPeriod } from '../../packages/domain/profile-progression.js';
import { localDate, type TaskEvent } from '../../packages/domain/tasks.js';
import { Fault, Store } from './store.js';

const weekQuery = z.object({ start: profileWeekStartSchema.optional(), timezone: profileTimezoneSchema.optional() }).strict()
  .refine(value => !!value.start === !!value.timezone, 'Keep the week and its timezone together.');
const dayQuery = profileWeekIdentitySchema.extend({ day: localDate, before: z.string().min(1).max(200).optional() }).strict()
  .refine(value => value.day >= value.start && value.day < shiftProfileDay(value.start, 7), 'Choose a day in this week.');
const historyQuery = z.object({ before: z.string().min(1).max(200).optional() }).strict();

/** Complete ledger reads only. No scheduler, snapshot materialization or metadata writes. */
export class ProfileWeek {
  constructor(private store: Store, private now: () => number = Date.now) {}
  state(raw: unknown) {
    const input = weekQuery.parse(raw);
    return this.store.internalAtomic(() => {
      const timezone = this.store.readEntity('layout', 'layout')!.value.timezone;
      const now = this.now();
      const identity = input.start && input.timezone ? { start: input.start, timezone: input.timezone } : { start: questPeriod('weekly', timezone, now).start, timezone };
      return buildProfileWeek(this.store.listEntities('task'), this.store.internalList<TaskEvent>('tasks:event:'), identity, timezone, now, this.store.epoch);
    });
  }
  day(raw: unknown) {
    const input = dayQuery.parse(raw);
    return this.store.internalAtomic(() => {
      const result = buildProfileDay(this.store.listEntities('task'), this.store.internalList<TaskEvent>('tasks:event:'), { start: input.start, timezone: input.timezone }, input.day, this.store.epoch, input.before, this.store.entityCursor);
      if (!result) throw new Fault(409, 'week_activity_changed', 'Reload this day before loading earlier activity. Your current rows are kept.');
      return result;
    });
  }
  history(raw: unknown) {
    const input = historyQuery.parse(raw);
    return this.store.internalAtomic(() => {
      const first = this.store.profileHistory();
      return { epoch: this.store.epoch, revision: this.store.entityCursor, head: first.entries[0]?.id ?? null, page: input.before ? this.store.profileHistory(input.before) : first };
    });
  }
}

export function profileReadQuery(params: URLSearchParams) {
  const entries = [...params.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Fault(400, 'profile_query', 'Use one value for each Profile view setting.');
  return Object.fromEntries(entries);
}
