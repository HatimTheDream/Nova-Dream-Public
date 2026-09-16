import { useEffect, useMemo, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { CalendarRepeat, CalendarState } from '../../../packages/domain/calendar';
import type { ProviderCalendarEditable } from '../../../packages/domain/calendar-write';
import { addDays } from '../../../packages/domain/calendar';
import { createCalendarSync } from './calendar-sync';
import { calendarSeriesKey, calendarTaskRows } from './task-calendar-rows';
import { request } from './api';
export function useTaskCalendar(snapshot: Snapshot, from: string, enabled: boolean) {
  const timezone = snapshot.layout.value.timezone, { epoch, deviceId } = snapshot;
  const sync = useMemo(() => createCalendarSync(epoch, deviceId), [epoch, deviceId]);
  const [result, setResult] = useState<{ key: string; state: CalendarState; repeats: Map<string, Pick<CalendarRepeat, 'cadence' | 'interval'> | undefined> }>();
  const [error, setError] = useState('');
  const key = JSON.stringify([epoch, deviceId, from, timezone]);
  useEffect(() => {
    if (!enabled) return;
    let live = true, running = false;
    const controller = new AbortController(), range = { from, to: addDays(from, 60), timezone };
    const repeats = new Map<string, Pick<CalendarRepeat, 'cadence' | 'interval'> | undefined>();
    const attempted = new Map<string, number>();
    const load = async () => {
      if (running || document.hidden) return; running = true;
      try {
        const state = await sync.load(range, false, controller.signal);
        if (!live) return;
        setResult({ key, state, repeats: new Map(repeats) }); setError('');
        const pending = state.events.flatMap(event => {
          const source = state.sources.find(s => s.id === event.sourceId && s.selected);
          if (!source || !event.seriesId) return [];
          const k = calendarSeriesKey(source.id, source.generation, event.seriesId);
          if (Date.now() - (attempted.get(k) ?? 0) < 60_000) return [];
          attempted.set(k, Date.now());
          return [{ k, target: { sourceId: source.id, generation: source.generation, eventId: event.seriesId, seriesId: event.seriesId, scope: 'series' as const } }];
        }).slice(0, 40);
        let index = 0;
        await Promise.all([0, 1].map(async () => {
          while (live && index < pending.length) {
            const item = pending[index++];
            try {
              const opened = await request<ProviderCalendarEditable>('calendar/write/open', { epoch, target: item.target }, controller.signal);
              if (opened.epoch === epoch && opened.source.id === item.target.sourceId && opened.source.generation === item.target.generation && opened.target.eventId === item.target.eventId) repeats.set(item.k, opened.value.repeat);
            } catch { /* The event stays available under Custom when its rule cannot be read. */ }
          }
        }));
        if (live) setResult({ key, state, repeats: new Map(repeats) });
      } catch (reason) { if (live) setError(reason instanceof Error ? reason.message : 'Calendar is unavailable. Saved tasks remain ready.'); }
      finally { running = false; }
    };
    void load(); const timer = setInterval(() => void load(), 15_000); const visible = () => { if (!document.hidden) void load(); }; document.addEventListener('visibilitychange', visible);
    return () => { live = false; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [key, epoch, from, timezone, sync, enabled]);
  const current = result?.key === key ? result : undefined;
  return { state: current?.state, rows: current ? calendarTaskRows(current.state, current.repeats) : [], error };
}
