// Tests for the Calendar routines toggle.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FILTER, ALL_SOURCES, SOURCE_META, type CalendarEvent, type CalendarFilter } from '../apps/client/src/dreamclaw/pages/Calendar/calendarTypes.js';
import { filterCalendarEvents } from '../apps/client/src/dreamclaw/pages/Calendar/calendarUtils.js';

function makeEvent(source: CalendarEvent['source'], title: string): CalendarEvent {
  return {
    id: `${source}:${title}`, title, date: '2026-09-26', endDate: '2026-09-26', allDay: true,
    category: 'work', source, status: 'scheduled', createdAt: '', updatedAt: '',
    reminderMinutes: 0, reminderStatus: 'none', deliveryChannel: 'last',
  };
}

describe('calendar routines toggle', () => {
  it('includes a routines source', () => {
    assert.ok(ALL_SOURCES.includes('routines'));
    assert.equal(SOURCE_META.routines.label, 'Routines');
  });
  it('hides routines by default', () => {
    assert.ok(!DEFAULT_FILTER.sources.includes('routines'));
  });
  it('filters out routine events when routines are hidden', () => {
    const events = [makeEvent('routines', 'Trash day'), makeEvent('task', 'Write report'), makeEvent('local', 'Team meeting')];
    const filtered = filterCalendarEvents(events, DEFAULT_FILTER);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(e => e.source !== 'routines'));
  });
  it('shows routine events when routines are enabled', () => {
    const events = [makeEvent('routines', 'Trash day'), makeEvent('task', 'Write report')];
    const filter: CalendarFilter = { ...DEFAULT_FILTER, sources: [...DEFAULT_FILTER.sources, 'routines'] };
    const filtered = filterCalendarEvents(events, filter);
    assert.equal(filtered.length, 2);
  });
});
