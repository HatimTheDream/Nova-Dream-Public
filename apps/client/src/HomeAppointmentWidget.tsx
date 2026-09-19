import { useEffect, useState } from 'react';
import type { CalendarDisplayEvent, CalendarState } from '../../../packages/domain/calendar';
import { addDays } from '../../../packages/domain/calendar';
import { dayStart } from '../../../packages/domain/calendar-time';
import { dayInZone } from '../../../packages/domain/tasks';
import { request } from './api';
import type { HomeWidget } from '../../../packages/domain/home-widgets';

export function upcomingAppointments(events: CalendarDisplayEvent[], timezone: string, now: number) {
  return events.filter(event => !['tasks', 'content'].includes(event.sourceId) && event.status !== 'cancelled' && !event.warning && event.taskStatus !== 'done')
    .map(event => ({ event, start: event.interval.kind === 'date' ? dayStart(event.interval.start, timezone) : Date.parse(event.interval.start), end: event.interval.kind === 'date' ? dayStart(event.interval.end, timezone) : Date.parse(event.interval.end) }))
    .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && item.end > now)
    .sort((a, b) => a.start - b.start || a.event.id.localeCompare(b.event.id));
}

export function nextAppointment(events: CalendarDisplayEvent[], timezone: string, now: number) { return upcomingAppointments(events, timezone, now)[0]; }

export function HomeAppointmentWidget({ epoch, deviceId, timezone, now, size, openCalendar }: { epoch: string; deviceId: string; timezone: string; now: number; size?: HomeWidget['size']; openCalendar: () => void }) {
  const compact = size === 'compact';
  const today = dayInZone(timezone, now), until = addDays(today, 30);
  const identity = `${epoch}:${deviceId}:${today}:${timezone}`;
  const [result, setResult] = useState<{ identity: string; state: CalendarState }>();
  const [failure, setFailure] = useState<{ identity: string; message: string }>();
  useEffect(() => {
    let active = true, busy = false;
    const controller = new AbortController();
    const load = async () => {
      if (busy) return; busy = true;
      try {
        const state = await request<CalendarState>(`calendar/state?${new URLSearchParams({ from: today, to: until, timezone })}`, undefined, controller.signal);
        if (!active) return;
        if (state.epoch !== epoch || state.deviceId !== deviceId || state.range.from !== today || state.range.to !== until || state.range.timezone !== timezone) throw Error('Calendar changed. Reopen Home to load the current schedule.');
        setResult({ identity, state }); setFailure(undefined);
      } catch { if (active) setFailure({ identity, message: 'Calendar could not be updated. Open Calendar to check your schedule.' }); }
      finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 60000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [identity]);
  const state = result?.identity === identity ? result.state : undefined;
  const error = failure?.identity === identity ? failure.message : '';
  const upcoming = state ? upcomingAppointments(state.events, timezone, now) : [];
  const next = upcoming[0];
  const incomplete = state && (state.eventsLimited || state.sources.some(source => source.selected && source.state !== 'ready') || state.selection.sourceIds.some(id => !state.sources.some(source => source.id === id)) || state.accountMessages.some(account => account.limited));
  const eventLabel = (item: typeof upcoming[number]) => item.event.interval.kind === 'date'
    ? `${item.event.interval.start === today ? 'Today' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${item.event.interval.start}T12:00:00Z`))} · All day`
    : new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(item.start);
  const date = next ? new Date(next.start) : null;
  return <div className="home-content home-appointment">
    {next ? <>
      {!compact && <div className="home-appointment-date" aria-hidden="true"><span>{new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: timezone }).format(date!)}</span><strong>{new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: timezone }).format(date!)}</strong></div>}
      <div className="home-appointment-events">{upcoming.slice(0, size === 'large' ? 3 : 1).map((item, index) => <div className="home-appointment-event" key={item.event.id}>
        <p className="home-appointment-time">{compact && (error || incomplete) ? 'Schedule needs refreshing' : eventLabel(item)}</p>
        <h3 title={item.event.title}>{item.event.title}</h3>
        {!compact && <p className="home-appointment-status">{item.start <= now ? item.event.interval.kind === 'date' ? 'Today’s event' : 'Happening now' : index === 0 ? 'Coming up' : 'Later'}{item.event.status === 'tentative' ? ' · Tentative' : ''}</p>}
        {size === 'large' && item.event.location && <p className="home-appointment-location" title={item.event.location}>{item.event.location}</p>}
      </div>)}</div>
    </> : <><h3>{state ? compact ? 'No upcoming event' : 'No upcoming event in the saved calendar' : error ? 'Calendar unavailable' : 'Loading your schedule…'}</h3>{state && !compact && <p>Looking 30 days ahead in the calendars you have selected.</p>}</>}
    {!compact && (error || incomplete) && <p className="home-save-notice">{error || 'Some calendar data needs refreshing. Open Calendar to check for changes.'}</p>}
    <div className="home-actions"><button className="home-action" onClick={openCalendar}>Open Calendar</button></div>
  </div>;
}