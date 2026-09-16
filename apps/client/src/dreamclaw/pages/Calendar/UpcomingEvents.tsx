// ═══════════════════════════════════════════════════════════
// UpcomingEvents — Sidebar list with Hijri/Chinese dates
// ═══════════════════════════════════════════════════════════

import { useMemo } from 'react';
import { MapPin, Repeat } from '@dreamclaw/components/icons';
import { useCalendarStore } from '@dreamclaw/stores/calendarStore';
import { ReminderBadge } from './ReminderBadge';
import { toDateStr, getEventColor, filterCalendarEvents } from './calendarUtils';

interface UpcomingEventsProps {
  onEventClick: (event: any) => void;
  maxItems?: number;
}

export function UpcomingEvents({ onEventClick, maxItems = 8 }: UpcomingEventsProps) {
  const events = useCalendarStore((s) => s.events);
  const operationalEvents = useCalendarStore((s) => s.operationalEvents);
  const filter = useCalendarStore((s) => s.filter);
  const todayStr = toDateStr(new Date());

  const upcoming = useMemo(() =>
    filterCalendarEvents([...events, ...operationalEvents], filter)
      .filter((e) => e.date >= todayStr && e.status !== 'cancelled')
      .sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')))
      .slice(0, maxItems),
    [events, operationalEvents, filter, todayStr, maxItems],
  );

  if (upcoming.length === 0) {
    return (
      <p className="text-[13px] text-aegis-text-dim text-center py-4">
        Nothing else is scheduled this month.
      </p>
    );
  }

  return (
    <div className="space-y-2 overflow-y-auto">
      {upcoming.map((ev) => {
        const d = new Date(ev.date + 'T00:00:00');
        const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', calendar: 'gregory' });
        const color = getEventColor(ev);

        return (
          <div
            key={ev.id}
            onClick={() => onEventClick(ev)}
            className="p-2.5 rounded-xl bg-aegis-card border border-aegis-border hover:border-aegis-primary/30 hover:bg-aegis-primary-surface transition-all cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold font-mono" style={{ color }}>
                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                {ev.startTime || 'All day'} · {dateStr}
              </div>
              <div className="flex items-center gap-0.5">
                {ev.recurrence && <Repeat size={9} style={{ color }} />}
                <ReminderBadge status={ev.reminderStatus} size="sm" />
              </div>
            </div>
            <div className="text-[13px] font-medium text-aegis-text mt-0.5">
              {ev.title || 'Untitled event'}
            </div>
            {ev.location && (
              <div className="flex items-center gap-0.5 text-[11px] text-aegis-text-dim mt-0.5">
                <MapPin size={10} className="shrink-0" /> {ev.location}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
