import { calendarTaskRows, type CalendarTaskRow } from '../task-calendar-rows';
import type { CalendarState as HostState, LocalCalendarOccurrence, CalendarRange } from '../../../../packages/domain/calendar';
import type { Snapshot } from '../../../../packages/domain/contracts';
import type { ProviderCalendarTarget } from '../../../../packages/domain/calendar-write';
import { addDays } from '../../../../packages/domain/calendar';
import { request } from '../api';
import { projectCalendarEvent } from './calendar-projection';
import { createCalendarEditor, eventForDraft, formForDraft } from './calendar-editor';
import type { CalendarEvent } from './pages/Calendar/calendarTypes';
import type { CalendarHost, CalendarRead, CalendarWrite } from './stores/calendarStore';
import { calendarScheduleLabel } from './services/calendar/seriesDeletion';
import { createCalendarSync } from '../calendar-sync';

type Options = { openSubtasks?: (row: CalendarTaskRow, state: HostState, original: CalendarEvent) => void; snapshot: Snapshot; windowId: string; previousWindowId?: string; navigate: (route: string) => void; keepView: CalendarHost['keepView']; changed(): Promise<void> };
export function createCalendarHost({ snapshot, windowId, previousWindowId, navigate, keepView, changed, openSubtasks }: Options): CalendarHost {
  let latest: HostState | undefined;
  const sync = createCalendarSync(snapshot.epoch, snapshot.deviceId);
  const captured = new Map<string, LocalCalendarOccurrence>();
  const providerTargets = new Map<string, ProviderCalendarTarget>();
  const viewRange = (day: string): CalendarRange => {
    const first = day.slice(0, 8) + '01', weekday = new Date(first + 'T12:00:00Z').getUTCDay(), from = addDays(first, -weekday);
    return { from, to: addDays(from, 42), timezone: snapshot.layout.value.timezone };
  };
  const project = (event: HostState['events'][number], state: HostState) => {
    const result = projectCalendarEvent(event, state);
    if (result.writeToken) {
      const local = state.localEvents.find(local => local.id === event.id);
      if (local) captured.set(result.writeToken, local);
      else {
        const source = state.sources.find(item => item.id === event.sourceId);
        if (source) providerTargets.set(result.writeToken, { sourceId: source.id, generation: source.generation, eventId: event.id,
          scope: event.seriesId ? 'occurrence' : 'event', seriesId: event.seriesId, originalStart: event.originalStart });
      }
    }
    return result;
  };
  const findOriginal = (event: CalendarEvent) => {
    const value = event.writeToken ? captured.get(event.writeToken) : undefined;
    if (!value) throw new Error('Reopen this exact event before editing.');
    return value;
  };
  const editor = createCalendarEditor({ epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId, previousWindowId, timezone: snapshot.layout.value.timezone, findLocal: findOriginal, changed,
    findProvider(event) {
      const target = event.writeToken ? providerTargets.get(event.writeToken) : undefined;
      if (!target) throw new Error('Refresh Calendar and reopen this exact provider event.');
      return target;
    },
    findSource(id) {
      const source = latest?.sources.find(item => item.id === id);
      if (!source || source.state === 'unavailable') throw new Error('Refresh the original Calendar connection. Your event writing is kept.');
      return source;
    },
    async providerChanged(source) {
      if (latest) await request('calendar/refresh', { requestId: crypto.randomUUID(), epoch: snapshot.epoch, range: latest.range, sourceIds: [source.id] });
      await changed();
    },
  });
  return {
    navigate, keepView, editor,
    ...(openSubtasks ? { openSubtasks(original: CalendarEvent) {
      if (original.source === 'task' && original.sourceRoute) { navigate(original.sourceRoute); return; }
      if (!latest) throw Error('Wait for Calendar to finish opening.');
      const draft = editor.getState().draft, rows = calendarTaskRows(latest, new Map());
      const target = draft?.id === original.id ? draft.subtaskTarget ?? draft.provider?.editable?.target : undefined;
      const row = rows.find(row => row.key === original.id) ?? rows.find(row => {
        if (target) return row.event.sourceId === target.sourceId && row.event.id === target.eventId && (row.event.originalStart ?? '') === (target.originalStart ?? '');
        if (original.source !== 'local' || !draft || draft.id !== original.id) return false;
        return row.localId === draft.id && (row.originalDate ?? '') === (draft.originalDate ?? draft.detail?.occurrence?.originalDate ?? '');
      });
      if (!row) throw Error('Refresh Calendar and reopen the exact date to see its subtasks. Your event draft is kept.');
      openSubtasks(row, latest, project(row.event, latest));
    } } : {}),
    async openLinkedEvent(target, signal) {
      if (target.epoch !== snapshot.epoch) throw Error('Reopen the event from this workspace.');
      const state = await sync.load(target.range, false, signal);
      if (signal.aborted) return;
      const source = state.sources.find(s => s.id === target.sourceId && s.generation === target.generation && s.selected);
      const event = state.events.find(e => e.sourceId === target.sourceId && e.id === target.eventId);
      if (!source || !event) throw Error('This event moved or its connection changed. Reopen it from the current task list.');
      latest = state;
      editor.getState().begin(project(event, state));
    },
    async read(month, force, signal) {
      const range = viewRange(month.startDate);
      const state = await sync.load(range, force, signal);
      latest = state;
      const events = state.events.map(event => project(event, state));
      const sources = state.sources.filter(source => source.selected);
      const partial = state.eventsLimited || sources.some(source => ['stale', 'unavailable'].includes(source.state));
      const providers = new Set(sources.map(source => source.provider));
      return {
        calendars: state.sources, accountMessages: state.accountMessages,
        syncing: state.jobs.some(job => job.state === 'running'),
        events: events.filter(event => !['task', 'content'].includes(event.source)), operationalEvents: events.filter(event => ['task', 'content'].includes(event.source)),
        queryState: partial ? 'partial' : 'ready',
        error: state.eventsLimited ? 'This calendar reached its event limit. Select fewer sources to see more.' : partial ? 'Some connected calendars need a refresh. Saved events remain visible.' : null,
        syncMode: providers.size > 1 ? 'connected' : providers.has('google') ? 'google' : providers.has('microsoft') ? 'microsoft' : 'local-only',
        lastSyncedAt: sources.map(source => source.cache?.checkedAt).filter((date): date is string => Boolean(date)).sort()[0] ?? null,
        sourceStates: sources.map(source => ({ provider: source.provider, account: source.accountLabel, status: source.state === 'ready' ? 'ready' : 'error', eventCount: state.events.filter(event => event.sourceId === source.id).length })),
      } satisfies CalendarRead;
    },
    async selectCalendar(id, selected) {
      if (!latest) throw Error('Wait for Calendar to finish opening.');
      await sync.select(latest, id, selected); await changed();
    },
    async save(data) {
      const state = editor.getState();
      if (!state.draft) throw new Error('Open an event draft before saving.');
      const current = formForDraft(state.draft);
      await state.save({ ...current, title: data.title ?? current.title, date: data.date ?? current.date,
        startTime: data.startTime ?? '', endTime: data.endTime ?? '', allDay: data.allDay ?? current.allDay,
        notes: data.notes ?? '', location: data.location ?? '', category: data.category ?? current.category,
        reminder: data.reminderMinutes ?? current.reminder, allDayReminder: data.allDayReminder === undefined ? current.allDayReminder : data.allDayReminder, deliveryChannel: data.deliveryChannel ?? current.deliveryChannel,
        recurrence: data.recurrence?.freq ?? '' });
    },
    async remove(original, scope, seriesIds) {
      if (editor.getState().draft?.provider) {
        const provider = editor.getState().draft!.provider!, target = provider.editable?.target;
        if (scope === 'schedule' || scope === 'series' && target?.scope !== 'series') {
          const selected = scope === 'series' ? target?.seriesId ? [target.seriesId] : [] : seriesIds ?? [];
          const capturedSeries = new Set([...providerTargets.values()].filter(item => item.sourceId === provider.source.id).map(item => item.seriesId));
          if (target?.seriesId) capturedSeries.add(target.seriesId);
          if (!selected.length || selected.length > 31 || new Set(selected).size !== selected.length || selected.some(id => !capturedSeries.has(id))) throw new Error('Choose the exact recurring patterns shown by this Calendar.');
          await editor.getState().prepareGroup(selected, calendarScheduleLabel(provider.editable?.value.title ?? original.title)); return;
        }
        await editor.getState().saveProvider('delete'); return;
      }
      if (original.source !== 'local' || scope !== 'event') throw new Error('Connected-calendar deletion is not available yet. No dates were removed.');
      await editor.getState().save(undefined, true);
    },
    editingValues(event) { const draft = editor.getState().draft; return draft ? eventForDraft(draft) : event; },
    async listDestinations() {
      return { success: true, destinations: [
        { id: 'local', provider: 'local', calendarName: 'Nova Dream only', isDefault: true, canWrite: true },
        ...(latest?.sources ?? []).map(source => ({ id: source.id, provider: source.provider, accountId: source.accountId, accountEmail: source.accountLabel, calendarId: source.calendarId, calendarName: source.name, isDefault: source.primary,
          canWrite: source.state !== 'unavailable' && source.providerCanWrite && Boolean(source.accountCanWrite),
          needsPermission: source.providerCanWrite && !source.accountCanWrite,
          unavailableReason: source.state === 'unavailable' ? 'Reconnect this account' : !source.providerCanWrite ? 'Read-only calendar' : undefined })),
      ] };
    },
    async deliveryChannels() { throw new Error('Calendar delivery channels are still being integrated.'); },
  };
}
