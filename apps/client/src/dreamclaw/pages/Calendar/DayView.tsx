// ═══════════════════════════════════════════════════════════
// DayView — Single day timeline; the shared sidebar owns the agenda.
// ═══════════════════════════════════════════════════════════

import { useMemo, useRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCalendarStore } from '@dreamclaw/stores/calendarStore';
import { EventCard } from './EventCard';
import {
  eventsForDate, toDateStr, isSameDay,
  getTimelineHours, filterCalendarEvents,
} from './calendarUtils';
import type { CalendarEvent } from './calendarTypes';
import { originalTimelineRows } from '@dreamclaw/calendar-timeline';

interface DayViewProps {
  onEventClick: (event: CalendarEvent) => void;
}

const HOUR_HEIGHT = 64;

export function DayView({ onEventClick }: DayViewProps) {
  const { t } = useTranslation();
  const { selectedDate, events, operationalEvents, settings, filter } = useCalendarStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  const hours = getTimelineHours(settings);

  // Live clock
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);
  const isToday = isSameDay(selectedDate, now);
  const nowHour = now.getHours() + now.getMinutes() / 60;

  // Scroll to current hour
  useEffect(() => {
    if (scrollRef.current && isToday) {
      scrollRef.current.scrollTop = Math.max(0, (nowHour - settings.timelineStart - 0.5) * HOUR_HEIGHT);
    }
  }, [isToday]);

  const dateStr = toDateStr(selectedDate);

  // Filter events
  const dayEvents = useMemo(() => {
    const filtered = filterCalendarEvents([...events, ...operationalEvents], filter);
    return eventsForDate(filtered, dateStr);
  }, [events, operationalEvents, dateStr, filter]);

  const allDayEvents = dayEvents.filter((e) => e.allDay || !e.startTime);
  const timedEvents = dayEvents.filter((e) => !e.allDay && e.startTime);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {allDayEvents.length > 0 && <div className="dc-calendar-all-day">
        <span>{t('calendar.allDay')}</span>
        <div>{allDayEvents.map(event => <EventCard key={event.id} event={event} variant="compact" onClick={() => onEventClick(event)}/>)}</div>
      </div>}
      {/* Timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto relative">
        <div className="relative" style={{ height: hours.length * HOUR_HEIGHT }}>
          {/* Hour rows */}
          {hours.map((h) => {
            const top = (h - settings.timelineStart) * HOUR_HEIGHT;
            return (
              <div key={h} className="absolute left-0 right-0 flex border-t border-aegis-border"
                style={{ top, height: HOUR_HEIGHT }}>
                <div className="w-[70px] shrink-0 text-[12px] font-mono text-aegis-text-dim text-center pt-1">
                  {String(h).padStart(2, '0')}:00
                </div>
                <div className="flex-1 border-aegis-border" style={{ borderInlineStart: '1px solid' }} />
              </div>
            );
          })}

          {/* Timed events */}
          {originalTimelineRows(timedEvents, dateStr, settings.timelineStart, settings.timelineEnd, HOUR_HEIGHT).map(({ event: ev, top, height, column, columns }) => {

            return (
              <div key={ev.id} className="absolute" style={{
                top,
                height,
                insetInlineStart: `calc(80px + (100% - 96px) * ${column / columns})`,
                width: `calc((100% - 96px) / ${columns} - 4px)`,
              }}>
                <EventCard event={ev} variant="full" showReminder onClick={() => onEventClick(ev)} />
              </div>
            );
          })}

          {/* Current time indicator */}
          {isToday && nowHour >= settings.timelineStart && nowHour <= settings.timelineEnd && (
            <div className="absolute z-10 pointer-events-none"
              style={{
                top: (nowHour - settings.timelineStart) * HOUR_HEIGHT,
                insetInlineStart: 70,
                insetInlineEnd: 0,
              }}>
              <div className="h-[2px] bg-aegis-danger relative">
                <div className="absolute -top-[4px] w-[10px] h-[10px] rounded-full bg-aegis-danger"
                  style={{ insetInlineStart: -1 }} />
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
