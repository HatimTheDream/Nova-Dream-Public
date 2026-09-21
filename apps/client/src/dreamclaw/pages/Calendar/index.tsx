import { LoadingRing } from '../../../ModuleLoading';
import { calendarDraftKey } from '../../../calendar-edit';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Layers3,
  Plus,
  RefreshCw,
  Search,
  WifiOff,
} from '@dreamclaw/components/icons';
import clsx from 'clsx';
import { PageTransition } from '@dreamclaw/components/shared/PageTransition';
import { useCalendarEditor, useCalendarStore } from '@dreamclaw/stores/calendarStore';
import { createGregorianMonthRange } from '@dreamclaw/services/calendar/monthQuery';
import { eventsForDate, filterCalendarEvents, toDateStr } from './calendarUtils';
import { MonthView } from './MonthView';
import { WeekView } from './WeekView';
import { DayView } from './DayView';
import { EventModal } from './EventModal';
import { eventForDraft } from '@dreamclaw/calendar-editor';
import { UpcomingEvents } from './UpcomingEvents';
import { ALL_SOURCES, SOURCE_META, type CalendarEvent } from './calendarTypes';

const ENGLISH_DATE = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', calendar: 'gregory' });
const ENGLISH_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', calendar: 'gregory' });

export default function CalendarPage() {
  const { i18n } = useTranslation();
  const isRtl = i18n.dir() === 'rtl';
  const {
    events, operationalEvents, loading, error, selectedDate, view, activeRange, queryState,
    syncMode, lastSyncedAt, sourceStates, filter, host, calendars = [], syncing = false, accountMessages = [],
    setView, setSelectedDate, navigate, goToToday, loadMonth, cancelMonthLoad,
    setFilter,
  } = useCalendarStore();
  const [choosingCalendar, setChoosingCalendar] = useState(false), [calendarChoiceError, setCalendarChoiceError] = useState('');
  const chooseCalendar = async (id: string, selected: boolean) => {
    if (!host.selectCalendar || choosingCalendar) return;
    setChoosingCalendar(true); setCalendarChoiceError('');
    try { await host.selectCalendar(id, selected); }
    catch (error) { setCalendarChoiceError(error instanceof Error ? error.message : 'Calendar visibility could not be saved.'); await loadMonth(undefined, { background: true }); }
    finally { setChoosingCalendar(false); }
  };
  const editor = useCalendarEditor();
  const showModal = editor.open;
  const editingEvent = editor.source ?? (editor.draft?.revision ? eventForDraft(editor.draft) : null);
  const modalDate = selectedDate;

  const selectedRange = useMemo(() => createGregorianMonthRange(selectedDate), [selectedDate.getFullYear(), selectedDate.getMonth()]);

  useEffect(() => {
    void loadMonth(selectedDate);
    return () => { void cancelMonthLoad(); };
  }, [selectedRange.monthKey, loadMonth, cancelMonthLoad]);

  // Operational records and reminders are owned by the Nova Dream host.
  const displayEvents = useMemo(
    () => filterCalendarEvents([...events, ...operationalEvents], filter),
    [events, operationalEvents, filter],
  );
  const sourceCounts = useMemo(() => displayEvents.reduce<Record<string, number>>((counts, event) => {
    counts[event.source] = (counts[event.source] || 0) + 1;
    return counts;
  }, {}), [displayEvents]);
  const visibleSourceOptions = ALL_SOURCES.filter((source) =>
    ['local', 'google', 'microsoft', 'task', 'content', 'automation'].includes(source) || sourceCounts[source] > 0,
  );
  const selectedDayEvents = useMemo(
    () => eventsForDate(displayEvents, toDateStr(selectedDate)),
    [displayEvents, selectedDate],
  );

  const handleDateClick = useCallback((date: Date) => {
    setSelectedDate(date);
  }, [setSelectedDate]);
  const handleEventClick = useCallback((event: CalendarEvent) => editor.begin(event), [editor.begin]);
  const handleAddEvent = useCallback((date?: Date) => editor.begin(undefined, date || selectedDate), [editor.begin, selectedDate]);
  const handleCloseModal = editor.close;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (showModal || editor.scopeEvent || editor.providerScope) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [data-calendar-day]')) return;
      if (event.key === 'ArrowLeft') navigate(isRtl ? 1 : -1);
      else if (event.key === 'ArrowRight') navigate(isRtl ? -1 : 1);
      else if (event.key.toLowerCase() === 't') goToToday();
      else if (event.key.toLowerCase() === 'm') setView('month');
      else if (event.key.toLowerCase() === 'w') setView('week');
      else if (event.key.toLowerCase() === 'd') setView('day');
      else if (event.key.toLowerCase() === 'n') handleAddEvent();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showModal, editor.scopeEvent, editor.providerScope, isRtl, navigate, goToToday, setView, handleAddEvent]);

  const viewTitle = view === 'day' ? ENGLISH_DAY.format(selectedDate) : ENGLISH_DATE.format(selectedDate);
  const sourceFailures = sourceStates.filter((source) => source.status === 'error').length;

  return (
    <PageTransition className="dc-calendar-page relative h-full min-h-0 overflow-hidden" data-calendar-page>
      <div className="flex h-full min-h-0 flex-col bg-aegis-bg" lang="en" data-calendar-gregorian="true">
        <header className="dc-calendar-toolbar shrink-0 border-b border-aegis-border bg-aegis-surface-solid px-3 py-3 sm:px-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-1.5" aria-label="Calendar month navigation">
              <button type="button" onClick={() => navigate(-1)} aria-label="Previous month"
                className="grid h-9 w-9 place-items-center rounded-xl border border-aegis-border bg-aegis-elevated text-aegis-text-muted transition-colors hover:border-aegis-primary/35 hover:text-aegis-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aegis-primary">
                {isRtl ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
              </button>
              <button type="button" onClick={goToToday}
                className="h-9 rounded-xl border border-aegis-primary/25 bg-aegis-primary-surface px-3 text-[12px] font-semibold text-aegis-primary transition-colors hover:bg-aegis-primary/15">
                Today
              </button>
              <button type="button" onClick={() => navigate(1)} aria-label="Next month"
                className="grid h-9 w-9 place-items-center rounded-xl border border-aegis-border bg-aegis-elevated text-aegis-text-muted transition-colors hover:border-aegis-primary/35 hover:text-aegis-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aegis-primary">
                {isRtl ? <ChevronLeft size={17} /> : <ChevronRight size={17} />}
              </button>
            </div>

            <div className="min-w-[170px] flex-1" dir="ltr">
              <h1 className="text-[20px] font-bold leading-tight text-aegis-text sm:text-[22px]">{viewTitle}</h1>
              <p className="mt-0.5 text-[11px] text-aegis-text-dim">
                {displayEvents.length} {displayEvents.length === 1 ? 'event' : 'events'} this month
                {syncing ? ' · Syncing calendars…' : ''}
                {lastSyncedAt && syncMode !== 'local-only' ? ` · Updated ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(lastSyncedAt))}` : ''}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button type="button" onClick={() => handleAddEvent()} aria-label={editor.draft ? 'Continue event draft' : 'Add event'}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-aegis-primary px-3 text-[12px] font-semibold text-aegis-btn-primary-text shadow-sm transition-colors hover:bg-aegis-primary-hover">
                <Plus size={15} /> <span className="hidden sm:inline">{editor.draft ? "Continue event draft" : "Add event"}</span><span className="sm:hidden">{editor.draft ? 'Continue' : 'Add'}</span>
              </button>
              <button type="button" onClick={() => void loadMonth(selectedDate, { force: true })} disabled={loading || syncing}
                className="grid h-9 w-9 place-items-center rounded-xl border border-aegis-border bg-aegis-elevated text-aegis-text-muted hover:text-aegis-primary disabled:opacity-50" aria-label="Refresh this month">
                <RefreshCw size={15} className={loading || syncing ? 'animate-spin motion-reduce:animate-none' : ''} />
              </button>
              <div className="flex rounded-xl border border-aegis-border bg-aegis-elevated p-1" aria-label="Calendar view">
                {(['month', 'week', 'day'] as const).map((item) => (
                  <button key={item} type="button" onClick={() => setView(item)} aria-pressed={view === item}
                    className={clsx('rounded-lg px-3 py-1.5 text-[11px] font-semibold capitalize transition-colors', view === item ? 'bg-aegis-primary text-aegis-btn-primary-text' : 'text-aegis-text-dim hover:text-aegis-text')}>
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </header>

        {editor.keptDrafts.length>0 && <details className="dc-calendar-kept-drafts"><summary>Other event drafts · {editor.keptDrafts.length}</summary><ul>{editor.keptDrafts.map(draft=><li key={calendarDraftKey(draft)}><button disabled={editor.busy} onClick={()=>editor.resumeKept(calendarDraftKey(draft))}>Continue {draft.originalForm?.title||draft.value.title||'Untitled event'}{draft.originalDate?' · '+draft.originalDate:''}{draft.pending?' · check saved status':''}</button></li>)}</ul></details>}
        {editor.notice && <div role="status" className="border-b border-aegis-border bg-aegis-primary-surface px-4 py-2 text-[12px]">{editor.notice}</div>}
        {(error || queryState === 'partial' || queryState === 'offline-cache') && (
          <div role="status" className={clsx(
            'flex shrink-0 items-center gap-2 border-b px-4 py-2 text-[12px]',
            queryState === 'offline-cache' ? 'border-aegis-primary/20 bg-aegis-primary-surface text-aegis-text-muted' : 'border-[rgb(var(--color-amber-400)/0.25)] bg-[rgb(var(--color-amber-400)/0.08)] text-aegis-text-muted',
          )}>
            {queryState === 'offline-cache' ? <WifiOff size={14} /> : <AlertCircle size={14} />}
            <span className="flex-1">{error || `${sourceFailures} connected source${sourceFailures === 1 ? '' : 's'} could not refresh. Other calendars remain available.`}</span>
            {!loading && <button type="button" onClick={() => void loadMonth(selectedDate, { force: true })} className="font-semibold text-aegis-primary hover:underline">Retry</button>}
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto overflow-x-hidden lg:grid-cols-[minmax(0,1fr)_240px] lg:overflow-hidden">
          <main className="relative flex min-h-[500px] min-w-0 flex-col overflow-hidden lg:min-h-0">
            {loading && events.length === 0 ? (
              <div className="grid flex-1 place-items-center"><LoadingRing label="Loading Calendar"/></div>
            ) : view === 'month' ? (
              <MonthView onDateClick={handleDateClick} onEventClick={handleEventClick} />
            ) : view === 'week' ? (
              <WeekView onDateClick={handleDateClick} onEventClick={handleEventClick} />
            ) : (
              <DayView onEventClick={handleEventClick} />
            )}
            {loading && events.length > 0 && <div className="pointer-events-none absolute right-3 top-3"><LoadingRing label="Refreshing Calendar"/></div>}
          </main>

          <aside className="grid min-h-0 gap-3 border-t border-aegis-border bg-aegis-surface-solid p-3 sm:grid-cols-2 lg:block lg:overflow-y-auto lg:border-t-0 lg:p-4" style={{ borderInlineStart: '1px solid var(--aegis-border)' }}>
            <section aria-labelledby="selected-day-heading">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 id="selected-day-heading" className="text-[12px] font-bold text-aegis-text">{ENGLISH_DAY.format(selectedDate)}</h2>
                  <p className="text-[10px] text-aegis-text-dim">{selectedDayEvents.length} {selectedDayEvents.length === 1 ? 'event' : 'events'}</p>
                </div>
                <button type="button" onClick={() => handleAddEvent(selectedDate)} className="text-[11px] font-semibold text-aegis-primary hover:underline">Add</button>
              </div>
              {selectedDayEvents.length === 0 ? (
                <p className="mt-2 rounded-xl border border-aegis-border bg-aegis-elevated px-3 py-3 text-[11px] text-aegis-text-dim">Nothing scheduled for this day.</p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {selectedDayEvents.slice(0, 4).map((event) => (
                    <button key={event.id} type="button" onClick={() => handleEventClick(event)} className="preserve-case block w-full rounded-xl border border-aegis-border bg-aegis-elevated px-3 py-2 text-start hover:border-aegis-primary/35">
                      <span className="block truncate text-[11px] font-semibold text-aegis-text">{event.title}</span>
                      <span className="block text-[10px] text-aegis-text-dim">{event.startTime || 'All day'}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <details className="group rounded-xl border border-aegis-border bg-aegis-elevated lg:mt-4">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[11px] font-semibold text-aegis-text-muted">
                <Layers3 size={14} /><span className="flex-1">Sources and filters</span><ChevronDown size={13} className="text-aegis-text-dim transition-transform group-open:rotate-180" />
              </summary>
              <div className="border-t border-aegis-border bg-aegis-surface-solid p-3">
                {host.selectCalendar && <div className="mb-3 space-y-2">
                  <p className="text-[11px] font-semibold text-aegis-text">Connected calendars</p>
                  {calendars.map(calendar => <label key={calendar.id} className="flex items-start gap-2 text-[11px] text-aegis-text">
                    <input type="checkbox" className="mt-0.5" checked={calendar.selected} disabled={choosingCalendar || calendar.state === 'unavailable' && !calendar.selected}
                      aria-label={`Show ${calendar.name} (${calendar.accountLabel})`} onChange={event => void chooseCalendar(calendar.id, event.target.checked)}/>
                    <span className="min-w-0"><span className="block break-words">{calendar.name}</span><small className="block break-all text-aegis-text-dim">{calendar.accountLabel}</small>
                      {calendar.state === 'refreshing' ? <small>Syncing…</small> : calendar.message && calendar.state !== 'ready' ? <small className="block text-aegis-text-muted">{calendar.message}</small> : null}</span>
                  </label>)}
                  {accountMessages.filter(account => !calendars.some(calendar => calendar.accountId === account.accountId)).map(account => <p key={account.accountId} className="text-[11px] text-aegis-text-muted">{account.label}: {account.message}</p>)}
                  {calendars.length > 0 && !calendars.some(calendar => calendar.selected) && <p className="text-[11px] text-aegis-text-muted">Choose a calendar to show its events.</p>}
                  {calendarChoiceError && <p role="alert" className="text-[11px] text-aegis-text-muted">{calendarChoiceError}</p>}
                  <button type="button" disabled={loading || syncing || choosingCalendar} onClick={() => void loadMonth(selectedDate, { force: true })} className="text-[11px] font-semibold text-aegis-primary disabled:opacity-50">Refresh calendar list</button>
                </div>}
                <label className="flex items-center gap-2 rounded-lg border border-aegis-border bg-aegis-elevated px-2.5 py-2">
                  <Search size={13} className="text-aegis-text-dim" />
                  <span className="sr-only">Filter this month</span>
                  <input value={filter.search} onChange={(event) => setFilter({ search: event.target.value })} placeholder="Filter this month" className="min-w-0 flex-1 bg-transparent text-[11px] text-aegis-text outline-none" />
                </label>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  {visibleSourceOptions.map((source) => {
                    const active = filter.sources.includes(source);
                    const meta = SOURCE_META[source];
                    return (
                      <button key={source} type="button" aria-pressed={active} onClick={() => setFilter({ sources: active ? filter.sources.filter((item) => item !== source) : [...filter.sources, source] })}
                        className={clsx('flex items-center justify-between rounded-lg border px-2 py-1.5 text-[10px]', active ? 'border-aegis-border-hover bg-aegis-primary-surface text-aegis-text' : 'border-transparent text-aegis-text-dim opacity-60')}>
                        <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />{meta.label}</span><span>{sourceCounts[source] || 0}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </details>

            <details className="rounded-xl border border-aegis-border bg-aegis-elevated sm:col-span-2 lg:mt-3">
              <summary className="cursor-pointer list-none px-3 py-2.5 text-[11px] font-semibold text-aegis-text-muted">Later this month</summary>
              <div className="max-h-60 overflow-y-auto border-t border-aegis-border bg-aegis-surface-solid p-2"><UpcomingEvents onEventClick={handleEventClick} maxItems={6} /></div>
            </details>
          </aside>
        </div>

        {showModal && <EventModal key={editor.draft?.id ?? editingEvent?.id ?? "new"} onClose={handleCloseModal} initialDate={modalDate} editEvent={editingEvent} />}
      </div>
    </PageTransition>
  );
}
