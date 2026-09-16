import type { CalendarRange, CalendarState } from '../../../packages/domain/calendar';
import { request } from './api';

/** Coordinate existing source/selection/cache APIs without making event writes. */
export function createCalendarSync(epoch: string, deviceId: string, api: typeof request = request, now = Date.now) {
  const attempted = new Map<string, number>();
  const read = async (range: CalendarRange, signal?: AbortSignal) => {
    const state = await api<CalendarState>(`calendar/state?${new URLSearchParams(range)}`, undefined, signal);
    if (state.epoch !== epoch || state.deviceId !== deviceId) throw Error('Reconnect this workspace before using its calendar.');
    return state;
  };
  const command = async (path: string, body: object, signal?: AbortSignal) => {
    try { await api(path, { requestId: crypto.randomUUID(), epoch, ...body }, signal); return true; }
    catch (error) {
      if (['calendar_busy', 'calendar_selection_changed'].includes((error as { code?: string }).code ?? '')) return false;
      throw error;
    }
  };
  const due = (key: string) => now() - (attempted.get(key) ?? -Infinity) >= 60000;
  const remember = (key: string) => { attempted.set(key, now()); if (attempted.size > 128) attempted.delete(attempted.keys().next().value!); };
  return {
    async load(range: CalendarRange, force: boolean, signal?: AbortSignal) {
      let state = await read(range, signal);
      const runningSources = () => state.jobs.some(job => job.kind === 'sources' && job.state === 'running');
      const missing = state.accountMessages.some(account => !state.sources.some(source => source.accountId === account.accountId));
      if (!runningSources() && (force || missing && due('sources'))) {
        if (await command('calendar/sources', {}, signal)) remember('sources');
        state = await read(range, signal);
      }
      // Revision zero means no calendar visibility choice has ever been saved.
      // Never turn calendars back on after the owner deliberately hides them.
      if (!state.selection.revision && !runningSources()) {
        const sourceIds = state.sources.filter(source => source.primary && source.state !== 'unavailable').map(source => source.id);
        if (sourceIds.length) {
          await command('calendar/selection', { expectedRevision: 0, sourceIds, showLocal: state.selection.showLocal, showTasks: state.selection.showTasks }, signal);
          state = await read(range, signal);
        }
      }
      const key = (id: string, generation: string) => JSON.stringify([id, generation, range]);
      const refresh = state.sources.filter(source => source.selected && source.state !== 'unavailable' && source.state !== 'refreshing' && (force || source.state === 'stale' && due(key(source.id, source.generation))));
      if (refresh.length) {
        if (await command('calendar/refresh', { range, sourceIds: refresh.map(source => source.id) }, signal)) refresh.forEach(source => remember(key(source.id, source.generation)));
        state = await read(range, signal);
      }
      return state;
    },
    async select(state: CalendarState, id: string, selected: boolean) {
      const source = state.sources.find(source => source.id === id);
      if (!source || selected && source.state === 'unavailable') throw Error('Refresh this calendar connection before showing it.');
      await api('calendar/selection', { requestId: crypto.randomUUID(), epoch, expectedRevision: state.selection.revision,
        sourceIds: selected ? [...new Set([...state.selection.sourceIds, id])] : state.selection.sourceIds.filter(sourceId => sourceId !== id),
        showLocal: state.selection.showLocal, showTasks: state.selection.showTasks });
    },
  };
}
