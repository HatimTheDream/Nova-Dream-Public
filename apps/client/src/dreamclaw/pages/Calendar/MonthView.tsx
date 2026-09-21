import { useMemo, useRef } from 'react';
import clsx from 'clsx';
import { useCalendarStore } from '@dreamclaw/stores/calendarStore';
import { daysInMonth, eventsForDate, filterCalendarEvents, firstDayOffset, getDayName, getWeekOrder, toDateStr } from './calendarUtils';
import { getEventColor } from './calendarUtils';
import type { CalendarEvent } from './calendarTypes';

interface MonthViewProps {
  onDateClick: (date: Date) => void;
  onEventClick: (event: CalendarEvent) => void;
}

interface MonthCell {
  date: Date;
  dateStr: string;
  day: number;
  isOtherMonth: boolean;
  isToday: boolean;
}

function buildGregorianCells(year: number, month: number, weekStart: number): MonthCell[] {
  const offset = firstDayOffset(year, month, weekStart);
  const start = new Date(year, month, 1 - offset);
  const today = toDateStr(new Date());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const dateStr = toDateStr(date);
    return { date, dateStr, day: date.getDate(), isOtherMonth: date.getMonth() !== month, isToday: dateStr === today };
  });
}

export function MonthView({ onDateClick, onEventClick }: MonthViewProps) {
  const { selectedDate, events, operationalEvents, settings, filter } = useCalendarStore();
  const gridRef = useRef<HTMLDivElement>(null);
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  const selected = toDateStr(selectedDate);
  const cells = useMemo(() => buildGregorianCells(year, month, settings.weekStartDay), [year, month, settings.weekStartDay]);
  const weekdayHeaders = useMemo(
    () => getWeekOrder(settings.weekStartDay).map((day) => getDayName(day, 'en-US', 'short')),
    [settings.weekStartDay],
  );
  const filteredEvents = useMemo(
    () => filterCalendarEvents([...events, ...operationalEvents], filter),
    [events, operationalEvents, filter],
  );

  const moveFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -7 : event.key === 'ArrowDown' ? 7 : 0;
    if (!delta) return;
    event.preventDefault();
    const nextIndex = Math.max(0, Math.min(cells.length - 1, index + delta));
    const buttons = gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-calendar-day]');
    buttons?.[nextIndex]?.focus();
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-label={`${new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', calendar: 'gregory' }).format(selectedDate)} calendar`} dir="ltr">
      <div className="grid shrink-0 grid-cols-7 border-b border-aegis-border bg-aegis-surface-solid" role="row">
        {weekdayHeaders.map((name) => <div key={name} role="columnheader" className="py-2 text-center text-[10px] font-bold uppercase tracking-[0.08em] text-aegis-text-dim sm:text-[11px]">{name}</div>)}
      </div>
      <div ref={gridRef} role="grid" className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 gap-px overflow-hidden bg-aegis-border">
        {cells.map((cell, index) => {
          const dayEvents = eventsForDate(filteredEvents, cell.dateStr);
          const isSelected = cell.dateStr === selected;
          const label = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', calendar: 'gregory' }).format(cell.date);
          return (
            <div key={cell.dateStr} role="gridcell" aria-selected={isSelected} className={clsx(
              'relative flex min-h-0 min-w-0 flex-col bg-aegis-bg p-1 sm:p-1.5',
              cell.isOtherMonth && 'bg-aegis-surface-solid/60',
              isSelected && 'ring-1 ring-inset ring-aegis-primary/50',
              cell.isToday && 'bg-aegis-primary-surface',
            )}>
              <button
                type="button"
                data-calendar-day
                tabIndex={isSelected || (!cells.some((item) => item.dateStr === selected) && index === 0) ? 0 : -1}
                aria-label={`${label}, ${dayEvents.length} ${dayEvents.length === 1 ? 'event' : 'events'}`}
                aria-current={cell.isToday ? 'date' : undefined}
                onClick={() => onDateClick(cell.date)}
                onKeyDown={(event) => moveFocus(event, index)}
                className={clsx(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-lg text-[11px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aegis-primary sm:h-7 sm:w-7 sm:text-[12px]',
                  cell.isToday ? 'bg-aegis-primary text-aegis-btn-primary-text' : isSelected ? 'bg-aegis-primary-surface text-aegis-primary' : cell.isOtherMonth ? 'text-aegis-text-dim opacity-55' : 'text-aegis-text-muted hover:bg-aegis-elevated',
                )}
              >
                {cell.day}
              </button>
              <div className="mt-1 min-h-0 space-y-0.5 overflow-hidden">
                {dayEvents.slice(0, 3).map((calendarEvent) => (
                  <button key={calendarEvent.id} type="button" onClick={() => onEventClick(calendarEvent)} title={`${calendarEvent.startTime || 'All day'} · ${calendarEvent.title}`}
                    className="preserve-case block w-full truncate rounded-md px-1 py-0.5 text-start text-[9px] font-medium text-aegis-text transition-[filter] hover:brightness-125 sm:text-[10px]"
                    style={{ background: `color-mix(in srgb, ${getEventColor(calendarEvent)} 16%, transparent)`, borderInlineStart: `2px solid ${getEventColor(calendarEvent)}` }}>
                    <span className="hidden lg:inline">{calendarEvent.startTime ? `${calendarEvent.startTime} ` : ''}</span>{calendarEvent.title}
                  </button>
                ))}
                {dayEvents.length > 3 && <span className="block px-1 text-[9px] font-semibold text-aegis-text-dim">+{dayEvents.length - 3} more</span>}
              </div>
            </div>
          );
        })}
      </div>
      {filteredEvents.length === 0 && <p className="sr-only" role="status">No events are scheduled for this month.</p>}
    </section>
  );
}
