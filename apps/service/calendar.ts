import { syncTaskSubtasks } from '../../packages/domain/task-subtasks.js';
import { calendarCompletionCommandSchema, calendarCompletionKey, calendarCompletionTarget, type CalendarCompletion } from '../../packages/domain/calendar-completion.js';
import { taskCalendarEvents } from '../../packages/domain/task-calendar.js';
import { contentCalendarEvents } from '../../packages/domain/content-planning.js';
import { CalendarReminders } from './calendar-reminders.js';
import { mailCalendarSourceSchema, calendarFollowupSchema, followupEventValue, mailCalendarKey, type CalendarFollowupResult } from '../../packages/domain/calendar-followups.js';
import { createHash, randomUUID } from 'node:crypto';
import { calendarProviderContexts } from './calendar-provider-context.js';
import { accountRequestSchema, type CalendarSource, type ConnectedAccount } from '../../packages/domain/accounts.js';
import { addDays, calendarRangeSchema, calendarRefreshSchema, calendarSelectionSchema, localEventCommandSchema, type CalendarCache, type CalendarDisplayEvent, type CalendarJob, type CalendarRange, type CalendarSelection, type CalendarSourceRef, type CalendarSourceState, type CalendarState, type LocalCalendarEvent, type LocalCalendarOccurrence, type CalendarException } from '../../packages/domain/calendar.js';
import { expandLocalCalendar, localOccurrence, repeatProblem } from '../../packages/domain/calendar-repeat.js';
import { dayStart, localEventInterval, overlapsRange } from '../../packages/domain/calendar-time.js';
import { reminderInstant } from '../../packages/domain/reminders.js';
import { Accounts } from './accounts.js';
import { Fault, Store } from './store.js';
import { ProviderError } from './providers.js';
import { localDate } from '../../packages/domain/tasks.js';

type Catalog = { accountId: string; generation: string; sources: CalendarSourceRef[]; checkedAt: string; limited: boolean; message?: string; failed?: boolean };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const keyFor = (source: { id: string; generation: string }, range: CalendarRange) => `calendar:cache:${digest([source.id, source.generation, range.from, range.to, range.timezone])}`;
const available = (a?: ConnectedAccount) => !!a && ['connected', 'refreshing'].includes(a.state) && a.capabilities.calendarRead;
const message = (e: unknown) => e instanceof Fault || e instanceof ProviderError ? e.message : 'This calendar read was unavailable. Previously saved events are kept.';

/** Shared local calendar authority. Provider reads can never write local plans. */
export class CalendarService {
  readonly reminders: CalendarReminders;
  private closed = false;
  private expansions = new Map<string, ReturnType<typeof expandLocalCalendar>>();
  private pending = new Set<Promise<void>>();
  constructor(private store: Store, private accounts: Pick<Accounts, 'state' | 'calendarSources' | 'calendarEvents'>, private now: () => number = Date.now) {
    this.reminders = new CalendarReminders(store, now);
    for (const job of this.jobs()) if (job.state === 'running') this.writeJob({ ...job, state: 'interrupted', sources: job.sources.map(s => ['waiting', 'running'].includes(s.state) ? { ...s, state: 'failed', message: 'Refresh interrupted. Start a new refresh when ready.' } : s) });
  }
  private ensureOpen() { if (this.closed) throw new Fault(503, 'calendar_closed', 'The calendar service is restarting. Saved work is kept.'); }
  private stamp() { return new Date(this.now()).toISOString(); }
  private jobs() { return this.store.internalList<CalendarJob>('calendar:job:'); }
  private writeJob(job: CalendarJob) { return this.store.internalWrite(`calendar:job:${job.id}`, job); }
  private cache(key: string, value: CalendarCache) {
    let bytes = 0; const events = value.events.filter(event => { bytes += Buffer.byteLength(JSON.stringify(event)); return bytes <= 2 * 1024 * 1024; });
    const bounded = events.length < value.events.length ? { ...value, events, coverage: 'partial' as const, message: 'This event cache reached its size limit. Narrow the dates or select fewer calendars.' } : value;
    if (bounded !== value) { const previous = this.store.internalRead<CalendarCache>(key); bounded.lastCompleteAt = previous?.lastCompleteAt; }
    this.store.internalWrite(key, bounded);
    const caches = this.store.internalList<CalendarCache>('calendar:cache:').sort((a, b) => Number(keyFor({ id: b.sourceId, generation: b.generation }, b.range) === key) - Number(keyFor({ id: a.sourceId, generation: a.generation }, a.range) === key) || b.checkedAt.localeCompare(a.checkedAt));
    const counts = new Map<string, number>();
    caches.forEach((cache, i) => { const n = (counts.get(cache.sourceId) ?? 0) + 1; counts.set(cache.sourceId, n); if (n > 8 || i >= 128) this.store.internalDelete(keyFor({ id: cache.sourceId, generation: cache.generation }, cache.range)); });
    return bounded;
  }
  private readCache(source: { id: string; generation: string }, range: CalendarRange, caches = this.store.internalList<CalendarCache>('calendar:cache:')) {
    const cached = caches.filter(c => c.sourceId === source.id && c.generation === source.generation && c.range.timezone === range.timezone && c.range.from <= range.from && c.range.to >= range.to).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
    if (!cached) return;
    const bounds = { start: dayStart(range.from, range.timezone), end: dayStart(range.to, range.timezone) };
    return { ...cached, range, events: cached.events.filter(e => overlapsRange(e.interval, range, bounds)) };
  }
  private selection(): CalendarSelection { return this.store.internalRead<CalendarSelection>('calendar:selection') ?? { revision: 0, sourceIds: [], showLocal: true, showTasks: true }; }
  private catalogs(device: string): Catalog[] {
    const state = this.accounts.state(device);
    return state.accounts.flatMap(account => {
      if (account.state === 'disconnected') return [];
      const saved = this.store.internalRead<Catalog>(`calendar:catalog:${account.id}`);
      if (saved?.generation === account.generation) return [saved];
      const probe = state.probes.find(p => p.accountId === account.id && p.generation === account.generation && p.calendars.state === 'available');
      return probe ? [this.catalog(account, probe.calendars.items, probe.calendars.limited, probe.checkedAt)] : [];
    });
  }
  private catalog(account: ConnectedAccount, items: CalendarSource[], limited: boolean, checkedAt = this.stamp()): Catalog {
    return { accountId: account.id, generation: account.generation, checkedAt, limited, sources: items.map(s => ({ id: digest([account.id, s.id]), accountId: account.id, generation: account.generation, provider: account.provider, calendarId: s.id, name: s.name, accountLabel: account.email || account.label, primary: s.primary, providerCanWrite: s.providerCanWrite, ...(s.timezone ? { timezone: s.timezone } : {}) })) };
  }
  select(device: string, raw: unknown) {
    this.ensureOpen(); const cmd = calendarSelectionSchema.parse(raw);
    return this.store.admit(device, cmd, { type: 'calendar-selection', ...cmd }, () => {
      const current = this.selection();
      if (current.revision !== cmd.expectedRevision) throw new Fault(409, 'calendar_selection_changed', 'Another window changed the visible calendars. Review your kept selection.', current);
      const known = new Set([...this.catalogs(device).flatMap(c => c.sources.map(s => s.id)), ...current.sourceIds]);
      if (cmd.sourceIds.some(id => !known.has(id))) throw new Fault(409, 'calendar_source_changed', 'A calendar source changed. Refresh the source list.');
      return this.store.internalWrite('calendar:selection', { revision: current.revision + 1, sourceIds: cmd.sourceIds, showLocal: cmd.showLocal, showTasks: cmd.showTasks } satisfies CalendarSelection);
    }).value;
  }
  private start(device: string, cmd: { requestId: string; epoch: string }, intent: unknown, kind: CalendarJob['kind'], sources: CalendarJob['sources'], run: (source: CalendarJob['sources'][number]) => Promise<{ partial?: boolean; message?: string }>, range?: CalendarRange) {
    const receipt = this.store.admit(device, cmd, intent, () => {
      if (this.jobs().filter(j => j.state === 'running').length >= 4) throw new Fault(409, 'calendar_busy', 'Wait for a current calendar refresh to finish.');
      if (this.jobs().some(j => j.state === 'running' && j.kind === kind && (kind === 'sources' || JSON.stringify(j.range) === JSON.stringify(range)) && j.sources.some(s => sources.some(t => t.id === s.id && t.generation === s.generation)))) throw new Fault(409, 'calendar_busy', 'These calendars are already refreshing.');
      const job: CalendarJob = { id: randomUUID(), deviceId: device, kind, state: 'running', startedAt: this.stamp(), sources, ...(range ? { range } : {}) }; this.writeJob(job); return job.id;
    });
    if (receipt.fresh) {
      const job = this.execute(receipt.value, run); this.pending.add(job); void job.finally(() => this.pending.delete(job)).catch(() => {});
    }
    return this.store.internalRead<CalendarJob>(`calendar:job:${receipt.value}`)!;
  }
  private async execute(id: string, run: (source: CalendarJob['sources'][number]) => Promise<{ partial?: boolean; message?: string }>) {
    let index = 0;
    const change = (sourceId: string, patch: Partial<CalendarJob['sources'][number]>) => { if (this.closed) return; const job = this.store.internalRead<CalendarJob>(`calendar:job:${id}`)!; this.writeJob({ ...job, sources: job.sources.map(s => s.id === sourceId ? { ...s, ...patch } : s) }); };
    const original = this.store.internalRead<CalendarJob>(`calendar:job:${id}`)!;
    await Promise.all(Array.from({ length: Math.min(3, original.sources.length) }, async () => {
      while (!this.closed && index < original.sources.length) {
        const source = original.sources[index++]; change(source.id, { state: 'running' });
        try { const result = await run(source); change(source.id, { state: result.partial ? 'partial' : 'completed', ...(result.message ? { message: result.message } : {}) }); }
        catch (error) { change(source.id, { state: 'failed', message: message(error) }); }
      }
    }));
    if (!this.closed) { const job = this.store.internalRead<CalendarJob>(`calendar:job:${id}`)!; this.writeJob({ ...job, state: job.sources.every(s => s.state === 'completed') ? 'completed' : 'partial' }); }
  }
  discover(device: string, raw: unknown) {
    this.ensureOpen(); const cmd = accountRequestSchema.strict().parse(raw), accounts = this.accounts.state(device).accounts.filter(available).slice(0, 50);
    return this.start(device, cmd, { type: 'calendar-discover', ...cmd }, 'sources', accounts.map(a => ({ id: a.id, generation: a.generation, state: 'waiting' })), async source => {
      const account = accounts.find(a => a.id === source.id)!;
      try {
        const result = await this.accounts.calendarSources(account.id, source.generation); this.fence(device, account.id, source.generation);
        const catalog = this.catalog(account, result.items, result.limited);
        const previous = this.catalogs(device).find(c => c.accountId === account.id);
        // A bounded list cannot establish that older sources were deleted.
        if (result.limited && previous) catalog.sources = [...new Map([...previous.sources, ...catalog.sources].map(s => [s.id, s])).values()];
        this.store.internalWrite(`calendar:catalog:${account.id}`, catalog);
        return { partial: result.limited, ...(result.limited ? { message: 'Only part of the calendar list was read. Previously discovered sources are kept.' } : {}) };
      } catch (error) {
        if (!this.closed) { const previous = this.catalogs(device).find(c => c.accountId === account.id && c.generation === source.generation); if (previous) this.store.internalWrite(`calendar:catalog:${account.id}`, { ...previous, failed: true, message: message(error) }); }
        throw error;
      }
    });
  }
  private fence(device: string, accountId: string, generation: string) {
    this.ensureOpen(); const account = this.accounts.state(device).accounts.find(a => a.id === accountId);
    if (!available(account) || account?.generation !== generation) throw new Fault(409, 'calendar_source_changed', 'This account connection changed. Refresh its sources.');
  }
  refresh(device: string, raw: unknown) {
    this.ensureOpen(); const cmd = calendarRefreshSchema.parse(raw), refs = this.catalogs(device).flatMap(c => c.sources), selected = cmd.sourceIds.map(id => refs.find(s => s.id === id));
    // Put existence validation inside admission so retries return their original job after a disconnect.
    const sources = cmd.sourceIds.map(id => ({ id, generation: refs.find(s => s.id === id)?.generation ?? '', state: 'waiting' as const }));
    return this.start(device, cmd, { type: 'calendar-refresh', ...cmd }, 'events', sources, async source => {
      const ref = selected.find(s => s?.id === source.id); if (!ref) throw new Fault(409, 'calendar_source_changed', 'This source is unavailable. Refresh the source list.');
      const key = keyFor(ref, cmd.range), previous = this.readCache(ref, cmd.range);
      try {
        this.fence(device, ref.accountId, ref.generation);
        const bounds = { start: dayStart(cmd.range.from, cmd.range.timezone), end: dayStart(cmd.range.to, cmd.range.timezone) };
        const page = await this.accounts.calendarEvents(ref.accountId, ref.generation, ref.calendarId, new Date(bounds.start - 36 * 3600000).toISOString(), new Date(bounds.end + 36 * 3600000).toISOString());
        this.fence(device, ref.accountId, ref.generation);
        // Merge before filtering so a moved/cancelled occurrence removes its old cached position.
        const merged = page.coverage === 'complete' ? page.events : [...new Map([...(previous?.events ?? []), ...page.events].map(e => [e.id, e])).values()];
        const events = merged.filter(e => e.status !== 'cancelled' && overlapsRange(e.interval, cmd.range, bounds));
        const cache: CalendarCache = { sourceId: ref.id, generation: ref.generation, range: cmd.range, events, coverage: page.coverage, checkedAt: this.stamp(), ...(page.coverage === 'complete' ? { lastCompleteAt: this.stamp() } : previous?.lastCompleteAt ? { lastCompleteAt: previous.lastCompleteAt } : {}), ...(page.message ? { message: page.message } : {}) };
        const saved = this.cache(key, cache); return { partial: saved.coverage === 'partial', message: saved.message };
      } catch (error) {
        if (!this.closed) { const a = this.accounts.state(device).accounts.find(a => a.id === ref.accountId); if (a?.generation === ref.generation && a.state !== 'disconnected') this.cache(key, { ...(previous ?? { sourceId: ref.id, generation: ref.generation, range: cmd.range, events: [] }), coverage: 'partial', checkedAt: this.stamp(), message: message(error) } satisfies CalendarCache); }
        throw error;
      }
    }, cmd.range);
  }
  resolveSource(device: string, sourceId: string, generation: string): CalendarSourceRef {
    this.ensureOpen(); const source = this.catalogs(device).flatMap(catalog => catalog.sources).find(item => item.id === sourceId);
    if (!source || source.generation !== generation) throw new Fault(409, 'calendar_source_changed', 'Refresh the original Calendar source before editing.');
    this.fence(device, source.accountId, generation);
    const account = this.accounts.state(device).accounts.find(item => item.id === source.accountId);
    return { ...source, accountCanWrite: Boolean(account?.capabilities.calendarWrite) };
  }
  providerChanged(source: CalendarSourceRef, event: CalendarDisplayEvent | import('../../packages/domain/calendar.js').CalendarEvent | undefined, action: 'create' | 'update' | 'delete', scope?: string) {
    this.ensureOpen();
    for (const cache of this.store.internalList<CalendarCache>('calendar:cache:')) {
      if (cache.sourceId !== source.id || cache.generation !== source.generation) continue;
      const events = cache.events.filter(item => !event || item.id !== event.id && !(scope === 'series' && item.seriesId === event.id));
      if (event && action !== 'delete' && scope !== 'series' && overlapsRange(event.interval, cache.range)) events.push(event);
      this.cache(keyFor(source, cache.range), { ...cache, events, coverage: 'partial', checkedAt: this.stamp(), message: 'The provider confirmed a Calendar change. Refresh this source to check its complete schedule.' });
    }
  }
  private exceptions(eventId: string) { return this.store.internalList<CalendarException>(`calendar:exception:${eventId}:`); }
  readLocal(eventId: string, originalDate?: string) {
    if (originalDate !== undefined) localDate.parse(originalDate);
    this.ensureOpen(); const event = this.store.internalRead<LocalCalendarEvent>(`calendar:local:${eventId}`);
    if (!event) throw new Fault(404, 'calendar_event_missing', 'This local event is unavailable. Your draft is kept.');
    const all = this.exceptions(eventId), exceptions = all.filter(e => !e.retired).sort((a, b) => a.originalDate.localeCompare(b.originalDate));
    const source = this.store.internalRead<{ source: unknown }>('calendar:mail-source:' + eventId);
    const mailSource = source ? mailCalendarSourceSchema.parse(source.source) : undefined;
    return { epoch: this.store.epoch, ...(mailSource ? { mailSource } : {}), event, occurrence: localOccurrence(event, all, originalDate), exceptionCount: exceptions.length, exceptions: exceptions.slice(0, 30).map(e => ({ originalDate: e.originalDate, start: e.value.start, title: e.value.title, state: e.value.state })) };
  }
  private expand(master: LocalCalendarEvent, range: CalendarRange) {
    const key = JSON.stringify([master.id, master.revision, master.exceptionsRevision ?? 0, range.from, range.to, range.timezone]);
    let result = this.expansions.get(key);
    if (!result) { result = expandLocalCalendar(master, this.exceptions(master.id), range); this.expansions.set(key, result); if (this.expansions.size > 128) this.expansions.delete(this.expansions.keys().next().value!); }
    return result;
  }
  saveLocal(device: string, raw: unknown): LocalCalendarEvent {
    this.ensureOpen(); const cmd = localEventCommandSchema.parse(raw);
    return this.store.admit(device, cmd, { type: 'calendar-local-save', ...cmd }, () => this.writeLocal(device, cmd)).value;
  }
  private writeLocal(device: string, cmd: ReturnType<typeof localEventCommandSchema.parse>): LocalCalendarEvent {
    const event = this.writeLocalRecord(device, cmd);
    this.reminders.synchronize(this.store.internalRead<LocalCalendarEvent>(`calendar:local:${cmd.eventId}`)!);
    return event;
  }
  private writeLocalRecord(device: string, cmd: ReturnType<typeof localEventCommandSchema.parse>): LocalCalendarEvent {
      const current = this.store.internalRead<LocalCalendarEvent>(`calendar:local:${cmd.eventId}`), exceptions = current ? this.exceptions(current.id) : [];
      const selected = current && cmd.scope === 'occurrence' ? localOccurrence(current, exceptions, cmd.originalDate) : current;
      if ((current?.revision ?? 0) !== cmd.expectedRevision) throw new Fault(409, 'calendar_event_changed', 'Another window changed this event or its series. Your proposal is kept for review.', selected ?? current);
      if ((current?.isSeries || current?.value.repeat) && !['occurrence', 'series'].includes(cmd.scope ?? '')) throw new Fault(409, 'calendar_scope_required', 'Choose this occurrence or the entire series before changing a repeating event.', current);
      const timing = localEventInterval(cmd.value); if (!timing.interval) throw new Fault(400, 'calendar_time', timing.error!);
      const problem = repeatProblem(cmd.value); if (problem) throw new Fault(400, 'calendar_repeat', problem);
      if (cmd.value.projectId && !this.store.readEntity('project', cmd.value.projectId)) throw new Fault(409, 'missing_project', 'Choose an available Project.');
      if (cmd.value.taskId) { const task = this.store.readEntity('task', cmd.value.taskId); if (!task || task.value.trashed || (task.value.projectId ?? null) !== cmd.value.projectId) throw new Fault(409, 'calendar_task_changed', 'Choose an available task from this Project.'); }
      if (cmd.scope === 'occurrence') {
        if (!current || !cmd.originalDate || !selected || !('overrideRevision' in selected) || cmd.value.repeat) throw new Fault(409, 'calendar_occurrence_changed', 'This occurrence is no longer in the series. Review its current schedule.', selected ?? current);
        if (current.value.state === 'cancelled') throw new Fault(409, 'calendar_series_cancelled', 'Restore the entire series before changing an individual occurrence.', current);
        const previous = exceptions.find(e => e.originalDate === cmd.originalDate);
        if (cmd.expectedOverrideRevision !== (previous?.revision ?? 0)) throw new Fault(409, 'calendar_occurrence_changed', 'Another window changed this occurrence. Your proposal is kept.', { ...selected, overrideRevision: previous?.revision ?? 0 });
        if ((!previous || previous.retired) && exceptions.filter(e => !e.retired).length >= 1000) throw new Fault(409, 'calendar_exception_limit', 'This series has reached its limit of 1,000 adjusted dates. Existing work is kept.');
        const id = `${current.id}:${cmd.originalDate}`, next: CalendarException = { id, eventId: current.id, originalDate: cmd.originalDate, revision: (previous?.revision ?? 0) + 1, updatedAt: this.stamp(), deviceId: device, retired: false, value: cmd.value };
        if (previous) this.store.internalWrite(`calendar:exception-history:${id}:${previous.revision}`, previous);
        this.store.internalWrite(`calendar:exception:${id}`, next);
        const master = this.store.internalWrite(`calendar:local:${current.id}`, { ...current, exceptionsRevision: (current.exceptionsRevision ?? 0) + 1 });
        return localOccurrence(master, [next], cmd.originalDate)!;
      }
      if (cmd.originalDate || cmd.expectedOverrideRevision !== undefined) throw new Fault(400, 'calendar_scope_required', 'Review the scope of this event change.');
      if (cmd.value.repeat && cmd.scope !== 'series') throw new Fault(409, 'calendar_scope_required', 'Choose the entire series when saving a repeat rule.');
      if (current?.isSeries || current?.value.repeat) {
        if (cmd.expectedExceptionsRevision !== (current.exceptionsRevision ?? 0)) throw new Fault(409, 'calendar_event_changed', 'An adjusted occurrence changed. Review the series before saving.', current);
        if (!cmd.exceptions) throw new Fault(400, 'calendar_exception_policy', 'Choose whether to keep or reset adjusted occurrences.');
      }
      if (current) this.store.internalWrite(`calendar:local-history:${current.id}:${current.revision}`, current);
      if (cmd.exceptions === 'reset') for (const previous of exceptions.filter(e => !e.retired)) {
        this.store.internalWrite(`calendar:exception-history:${previous.id}:${previous.revision}`, previous);
        this.store.internalWrite(`calendar:exception:${previous.id}`, { ...previous, revision: previous.revision + 1, retired: true, updatedAt: this.stamp(), deviceId: device });
      }
      return this.store.internalWrite(`calendar:local:${cmd.eventId}`, { id: cmd.eventId, deviceId: device, revision: (current?.revision ?? 0) + 1, updatedAt: this.stamp(), value: cmd.value, ...((current?.isSeries || cmd.value.repeat) ? { isSeries: true, exceptionsRevision: (current?.exceptionsRevision ?? 0) + (cmd.exceptions === 'reset' && exceptions.some(e => !e.retired) ? 1 : 0) } : {}) });
  }
  saveFollowup(device: string, raw: unknown): CalendarFollowupResult {
    this.ensureOpen(); const cmd=calendarFollowupSchema.parse(raw);
    return this.store.admit(device,cmd,{type:'calendar-mail-followup',...cmd},()=>{
      const key='calendar:mail-followup:'+digest(mailCalendarKey(cmd.source));
      const linked=this.store.internalRead<{eventId:string}>(key);
      const current=linked?this.store.internalRead<LocalCalendarEvent>('calendar:local:'+linked.eventId):undefined;
      if(current&&!cmd.after)return {epoch:this.store.epoch,requestId:cmd.requestId,source:cmd.source,created:false,event:current};
      if(cmd.after&&(!current||current.id!==cmd.after.eventId||current.revision!==cmd.after.revision))throw new Fault(409,'calendar_followup_changed','This follow-up changed. Open its current Calendar event before planning another.',current);
      const account=this.accounts.state(device).accounts.find(a=>a.id===cmd.source.accountId);
      if(!account||account.provider!==cmd.source.provider||account.generation!==cmd.generation||!['connected','refreshing'].includes(account.state)||!account.capabilities.mailRead)throw new Fault(409,'calendar_followup_account','Refresh this mail account before planning its follow-up. Existing Calendar events are kept.');
      const value=followupEventValue(cmd),event=this.writeLocal(device,{requestId:cmd.requestId,epoch:cmd.epoch,eventId:randomUUID(),expectedRevision:0,value,scope:'event'});
      this.store.internalWrite(key,{source:cmd.source,eventId:event.id,previousEventId:current?.id});
      this.store.internalWrite('calendar:mail-source:'+event.id,{source:cmd.source});
      return {epoch:this.store.epoch,requestId:cmd.requestId,source:cmd.source,created:true,event};
    }).value;
  }
  completeTaskEvent(device: string, raw: unknown): CalendarCompletion {
    const cmd = calendarCompletionCommandSchema.parse(raw), key = calendarCompletionKey(cmd.target);
    // Resolve the existing shared projection outside the receipt transaction (snapshot has its own transaction).
    const state = this.state(device, cmd.range);
    return this.store.admit(device, cmd, { type: 'calendar-task-completion', ...cmd }, () => {
      const recordKey = 'tasks:calendar-completion:' + digest(key);
      const current = this.store.internalRead<CalendarCompletion>(recordKey);
      if ((current?.revision ?? 0) !== cmd.expectedRevision) throw new Fault(409, 'calendar_completion_changed', 'This completion changed in another window. Review the latest state.', current);
      const event = state.events.find(e => calendarCompletionKey(calendarCompletionTarget(e)) === key && !['tasks', 'content'].includes(e.sourceId) && e.status !== 'cancelled');
      const source = state.sources.find(s => s.id === cmd.target.sourceId);
      if (cmd.done || !current || cmd.checklist !== undefined) {
        if (!event || (event.sourceId !== 'local' && (!source?.selected || source.generation !== cmd.generation || source.state === 'unavailable'))) throw new Fault(409, 'calendar_source_changed', 'Refresh this calendar before completing the event.');
        if (!current && this.store.internalList('tasks:calendar-completion:').length >= 5000) throw new Fault(409, 'completion_limit', 'The calendar completion history is full. Existing entries are kept.');
      }
      if (!event && !current) throw new Fault(404, 'calendar_event_missing', 'This event is no longer available.');
      const local = state.localEvents.find(e => event?.sourceId === 'local' && e.id === event.id);
      const savedEvent = event ? { id: event.id, sourceId: event.sourceId, title: event.title.slice(0, 300), interval: event.interval, ...(event.seriesId ? { seriesId: event.seriesId } : {}), ...(event.originalStart ? { originalStart: event.originalStart } : {}) } : current!.event;
      const previous = { title: savedEvent.title, notes: '', planned: '', due: '', status: current?.done ? 'done' as const : 'open' as const, checklist: current?.checklist };
      const task = syncTaskSubtasks({ ...previous, status: cmd.done ? 'done' : 'open', checklist: cmd.checklist ?? current?.checklist }, previous);
      // This records workspace task completion only. No provider schedule, attendance or mail action is dispatched.
      return this.store.internalWrite(recordKey, { ...current, key, target: cmd.target, revision: (current?.revision ?? 0) + 1, done: task.status === 'done', ...(task.checklist ? { checklist: task.checklist } : {}), updatedAt: this.stamp(), event: savedEvent, range: cmd.range, ...(source ? { generation: source.generation } : {}), ...(local ? { localId: local.eventId, ...(local.originalDate ? { originalDate: local.originalDate } : {}), projectId: local.value.projectId } : {}) } satisfies CalendarCompletion);
    }).value;
  }
  state(device: string, raw: unknown): CalendarState {
    this.ensureOpen(); const range = calendarRangeSchema.parse(raw), selection = this.selection(), accounts = this.accounts.state(device).accounts, catalogs = this.catalogs(device), jobs = this.jobs();
    const bounds = { start: dayStart(range.from, range.timezone), end: dayStart(range.to, range.timezone) };
    const caches = this.store.internalList<CalendarCache>('calendar:cache:');
    const cachedEvents = new Map<string, CalendarCache['events']>();
    const sources: CalendarSourceState[] = catalogs.flatMap(c => c.sources.map(s => {
      const rawCache = this.readCache(s, range, caches);
      const cache = rawCache ? (({ events, ...metadata }) => { cachedEvents.set(s.id, events); return metadata; })(rawCache) : undefined;
      const active = jobs.some(j => j.kind === 'events' && j.state === 'running' && JSON.stringify(j.range) === JSON.stringify(range) && j.sources.some(t => t.id === s.id && t.generation === s.generation && ['waiting', 'running'].includes(t.state)));
      const a = accounts.find(a => a.id === s.accountId), readable = available(a);
      return { ...s, accountCanWrite: Boolean(readable && a?.capabilities.calendarWrite), selected: selection.sourceIds.includes(s.id), state: !readable ? 'unavailable' : active ? 'refreshing' : !cache || cache.coverage === 'partial' || c.failed || this.now() - Date.parse(cache.checkedAt) > 300000 ? 'stale' : 'ready', ...(cache ? { cache } : {}), ...(!readable ? { message: a?.message ?? 'Reconnect this account to refresh events.' } : c.failed ? { message: c.message } : cache?.message ? { message: cache.message } : !cache ? { message: 'Refresh to read events for these dates.' } : {}) };
    }));
    const expanded = this.store.internalList<LocalCalendarEvent>('calendar:local:').map(e => this.expand(e, range));
    const matchingLocal = expanded.flatMap(e => e.occurrences);
    let localBytes = 0; const localEvents = matchingLocal.filter((e, i) => { localBytes += Buffer.byteLength(JSON.stringify(e)); return i < 2000 && localBytes <= 2 * 1024 * 1024; });
    const providerContext = calendarProviderContexts(this.store);
    const events: CalendarDisplayEvent[] = sources.filter(s => s.selected).flatMap(s => (cachedEvents.get(s.id) ?? []).map(e => ({ ...e, sourceId: s.id, workspaceCategory: providerContext(s, e).category })));
    if (selection.showLocal) for (const e of localEvents) if (e.value.state !== 'cancelled') events.push({ id: e.id, sourceId: 'local', title: e.value.title, notes: e.value.notes, location: e.value.location, status: e.value.state, interval: localEventInterval(e.value).interval ?? { kind: 'date', start: e.value.start.date, end: addDays(e.value.start.date, 1) }, ...(e.series ? { seriesId: e.eventId, originalStart: e.originalDate } : {}), ...(e.problem ? { warning: e.excluded ? 'This start time is skipped by the repeat rule. Edit this date to add a valid exception.' : e.problem } : {}) });
    const workspace = this.store.snapshot(device);
    events.push(...contentCalendarEvents(workspace.records?.content ?? [], range));
    if (selection.showTasks) events.push(...taskCalendarEvents(workspace, range, this.now()));
    const completions = new Map((workspace.calendarCompletions ?? []).map(item => [item.key, item]));
    for (const event of events) { const completion = completions.get(calendarCompletionKey(calendarCompletionTarget(event))); if (completion) event.taskStatus = completion.done ? 'done' : 'open'; }
    let outputBytes = 0; const ordered = events.sort((a, b) => Number(b.sourceId === 'local' || b.sourceId === 'tasks' || b.sourceId === 'content') - Number(a.sourceId === 'local' || a.sourceId === 'tasks' || a.sourceId === 'content') || a.interval.start.localeCompare(b.interval.start));
    const shown = ordered.filter((event, i) => { outputBytes += Buffer.byteLength(JSON.stringify(event)); return i < 2000 && outputBytes < 2 * 1024 * 1024; });
    return { epoch: this.store.epoch, deviceId: device, reminders: this.reminders.state(), eventsLimited: expanded.some(e => e.limited) || shown.length < events.length || localEvents.length < matchingLocal.length, range, selection, sources, localEvents, events: shown.sort((a, b) => a.interval.start.localeCompare(b.interval.start) || a.id.localeCompare(b.id)), jobs: jobs.filter(j => j.deviceId === device || j.state === 'running').sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20), accountMessages: accounts.filter(a => a.state !== 'disconnected').map(a => { const c = catalogs.find(c => c.accountId === a.id); return { accountId: a.id, label: a.email || a.label, limited: c?.limited ?? false, message: !available(a) ? a.message ?? 'Calendar permission or sign-in is needed.' : c?.failed ? c.message! : c?.limited ? 'Partial source list. Previously discovered calendars are kept.' : c ? `Sources checked ${c.checkedAt}` : 'Refresh sources to find this account’s calendars.' }; }) };
  }
  async close() {
    if (!this.closed) { this.closed = true; for (const job of this.jobs()) if (job.state === 'running') this.writeJob({ ...job, state: 'interrupted', sources: job.sources.map(s => ['waiting', 'running'].includes(s.state) ? { ...s, state: 'failed', message: 'Refresh interrupted. Saved work is kept.' } : s) }); }
    await Promise.allSettled([...this.pending]);
  }
}
