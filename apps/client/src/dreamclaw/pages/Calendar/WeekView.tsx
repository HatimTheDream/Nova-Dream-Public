// ═══════════════════════════════════════════════════════════
// WeekView — 7-day timeline with real event durations
// Current time indicator updates every 60 seconds
// ═══════════════════════════════════════════════════════════

import { useMemo, useRef, useEffect, useState } from 'react';
import clsx from 'clsx';
import { useCalendarStore } from '@dreamclaw/stores/calendarStore';
import { EventCard } from './EventCard';
import {
  getWeekDates, eventsForDate, toDateStr, isSameDay,
  getTimelineHours, getDayName, getEventDuration, filterCalendarEvents,
} from './calendarUtils';
import type { CalendarEvent } from './calendarTypes';
import { originalTimelineRows } from '@dreamclaw/calendar-timeline';

interface WeekViewProps {
  onDateClick: (date: Date) => void;
  onEventClick: (event: CalendarEvent) => void;
}

const HOUR_HEIGHT = 56; // px per hour

export function WeekView({ onDateClick, onEventClick }: WeekViewProps) {
  const { selectedDate, events, operationalEvents, settings, filter } = useCalendarStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  const weekDates = useMemo(() => getWeekDates(selectedDate, settings.weekStartDay), [selectedDate, settings.weekStartDay]);
  const hours = getTimelineHours(settings);

  // Live clock — updates every minute
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);
  const nowHour = now.getHours() + now.getMinutes() / 60;

  // Scroll to current hour on mount
  useEffect(() => {
    if (scrollRef.current) {
      const scrollTo = Math.max(0, (nowHour - settings.timelineStart - 0.5) * HOUR_HEIGHT);
      scrollRef.current.scrollTop = scrollTo;
    }
  }, []);

  // Filter events
  const filteredEvents = useMemo(() =>
    filterCalendarEvents([...events, ...operationalEvents], filter),
    [events, operationalEvents, filter],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Day headers */}
      <div className="grid shrink-0 border-b border-aegis-border bg-aegis-surface-solid"
        style={{ gridTemplateColumns: '60px repeat(7, 1fr)' }}>
        <div /> {/* Time gutter */}
        {weekDates.map((date, i) => {
          const isToday = isSameDay(date, now);
          const isSelected = isSameDay(date, selectedDate);
          return (
            <button key={i} type="button" onClick={() => onDateClick(date)}
              data-calendar-day
              aria-label={date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', calendar: 'gregory' })}
              aria-current={isToday ? 'date' : undefined}
              aria-pressed={isSelected}
              className="dc-calendar-date dc-calendar-week-date">
              <span className="text-[11px] font-semibold text-aegis-text-dim uppercase">
                {getDayName(date.getDay(), 'en-US')}
              </span>
              <span className="dc-calendar-date-number">
                {date.getDate()}
              </span>
            </button>
          );
        })}
      </div>

      {filteredEvents.some(event => event.allDay || !event.startTime) && <div className="grid shrink-0 border-b border-aegis-border bg-aegis-surface-solid" style={{ gridTemplateColumns: '60px repeat(7, 1fr)' }}>
        <span className="p-2 text-[10px] text-aegis-text-dim">All day</span>
        {weekDates.map(date => <div key={toDateStr(date)} className="min-w-0 space-y-1 p-1">
          {eventsForDate(filteredEvents, toDateStr(date)).filter(event => event.allDay || !event.startTime).map(event => <EventCard key={event.id} event={event} variant="compact" onClick={() => onEventClick(event)}/>)}
        </div>)}
      </div>}

      {/* Timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="grid relative" style={{
          gridTemplateColumns: '60px repeat(7, 1fr)',
          height: hours.length * HOUR_HEIGHT,
        }}>
          {/* Hour labels + grid lines */}
          {hours.map((h) => {
            const top = (h - settings.timelineStart) * HOUR_HEIGHT;
            return (
              <div key={h} className="contents">
                <div className="absolute w-[60px] text-[11px] font-mono text-aegis-text-dim text-center -translate-y-1/2"
                  style={{ top, left: 0 }}>
                  {String(h).padStart(2, '0')}:00
                </div>
                <div className="absolute border-t border-aegis-border" style={{ top, left: 60, right: 0 }} />
              </div>
            );
          })}

          {/* Day columns with events */}
          {weekDates.map((date, colIdx) => {
            const dateStr = toDateStr(date);
            const dayEvents = eventsForDate(filteredEvents, dateStr);
            const isToday = isSameDay(date, now);

            return (
              <div key={colIdx}
                className={clsx(
                  'relative border-aegis-border',
                  'border-s',
                  isToday && 'bg-[rgb(var(--aegis-overlay)/0.015)]',
                )}
                style={{ gridColumn: colIdx + 2 }}>
                {/* Events */}
                {originalTimelineRows(dayEvents, dateStr, settings.timelineStart, settings.timelineEnd, HOUR_HEIGHT).map(({ event: ev, top, height, column, columns }) => {

                  return (
                    <div key={ev.id} className="absolute" style={{ top, height, insetInlineStart: `calc(${column / columns * 100}% + 2px)`, width: `calc(${100 / columns}% - 4px)` }}>
                      <EventCard event={ev} variant="medium" showReminder onClick={() => onEventClick(ev)} />
                    </div>
                  );
                })}

                {/* Current time indicator */}
                {isToday && nowHour >= settings.timelineStart && nowHour <= settings.timelineEnd && (
                  <div className="absolute inset-x-0 z-10 pointer-events-none"
                    style={{ top: (nowHour - settings.timelineStart) * HOUR_HEIGHT }}>
                    <div className="h-[2px] bg-aegis-danger relative">
                      <div className="absolute -top-[4px] w-[10px] h-[10px] rounded-full bg-aegis-danger"
                        style={{ insetInlineStart: -1 }} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
