import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { DEFAULT_FILTER, DEFAULT_SETTINGS, type CalendarEvent, type CalendarFilter, type CalendarSettings } from '../pages/Calendar/calendarTypes';
import { createGregorianMonthRange, shiftGregorianMonth, type CalendarMonthRange } from '../services/calendar/monthQuery';
import type { CalendarDeleteScope } from '../services/calendar/seriesDeletion';
import type { createCalendarEditor } from '../calendar-editor';
import type { DeliveryChannelOption } from '../pages/Calendar/deliveryChannels';
import type { CalendarSourceState } from '../../../../../packages/domain/calendar';

export type CalendarDestination = { id: string; provider: 'local' | 'google' | 'microsoft'; accountId?: string; accountEmail?: string; calendarId?: string; calendarName: string; isDefault: boolean; canWrite: boolean; needsPermission?: boolean; unavailableReason?: string };
export type CalendarWrite = Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt' | 'source' | 'reminderStatus' | 'reminderCronJobId'> & { destinationProvider?: 'local' | 'google' | 'microsoft' };
export type CalendarRead = {
  calendars?: CalendarSourceState[]; syncing?: boolean;
  accountMessages?: { accountId: string; label: string; message: string }[];
  events: CalendarEvent[]; operationalEvents: CalendarEvent[];
  queryState: 'ready' | 'partial' | 'offline-cache';
  error: string | null; syncMode: 'google' | 'microsoft' | 'connected' | 'local-only'; lastSyncedAt: string | null;
  sourceStates: { provider: 'google' | 'microsoft'; account: string; status: 'ready' | 'error'; eventCount: number }[];
};
export interface CalendarHost {
  editor: ReturnType<typeof createCalendarEditor>;
  openSubtasks?(event: CalendarEvent): void;
  openLinkedEvent?(target: import('../../calendar-target').ProviderCalendarNavigation, signal: AbortSignal): Promise<void>;
  read(range: CalendarMonthRange, force: boolean, signal: AbortSignal): Promise<CalendarRead>;
  selectCalendar?(id: string, selected: boolean): Promise<void>;
  save(data: CalendarWrite | Partial<CalendarEvent>, original?: CalendarEvent): Promise<void>;
  remove(original: CalendarEvent, scope: CalendarDeleteScope, seriesIds?: string[]): Promise<void>;
  listDestinations(): Promise<{ success: boolean; destinations: CalendarDestination[] }>;
  deliveryChannels(): Promise<DeliveryChannelOption[]>;
  editingValues(event: CalendarEvent): CalendarEvent;
  navigate(route: string): void;
  keepView(date: Date, view: CalendarSettings['defaultView'], filter: CalendarFilter): void;
}
export interface CalendarState extends CalendarRead {
  selectedDate: Date; view: CalendarSettings['defaultView']; settings: CalendarSettings; filter: CalendarFilter;
  activeRange: CalendarMonthRange; loading: boolean; host: CalendarHost;
  setView(view: CalendarSettings['defaultView']): void;
  setSelectedDate(date: Date): void;
  navigate(delta: number): void;
  goToToday(): void;
  setFilter(patch: Partial<CalendarFilter>): void;
  updateSettings(patch: Partial<CalendarSettings>): void;
  loadMonth(date?: Date, options?: { force?: boolean; background?: boolean }): Promise<void>;
  cancelMonthLoad(): Promise<void>;
  addEvent(data: CalendarWrite): Promise<void>;
  updateEvent(id: string, data: Partial<CalendarEvent>, original: CalendarEvent): Promise<void>;
  deleteEvent(id: string, scope: CalendarDeleteScope, seriesIds: string[] | undefined, original: CalendarEvent): Promise<void>;
}

// Adaptation of Dream Claw's calendar view store. Its original screens consume the
// same state/actions; all persisted event and provider authority remains on the E3 host.
export function createCalendarStore(host: CalendarHost, initial: { date: Date; view: CalendarSettings['defaultView']; filter?: CalendarFilter; timezone: string }) {
  let pending: AbortController | undefined;
  let generation = 0;
  const rangeFor = (date: Date) => createGregorianMonthRange(date, initial.timezone);
  return createStore<CalendarState>((set, get) => {
    const keep = () => host.keepView(get().selectedDate, get().view, get().filter);
    return {
      host, selectedDate: initial.date, view: initial.view, settings: { ...DEFAULT_SETTINGS },
      filter: initial.filter ?? { ...DEFAULT_FILTER, sources: [...DEFAULT_FILTER.sources], categories: [...DEFAULT_FILTER.categories] },
      activeRange: rangeFor(initial.date), events: [], operationalEvents: [], loading: false,
      queryState: 'ready', error: null, syncMode: 'local-only', sourceStates: [], lastSyncedAt: null,
      setView(view) { set({ view }); keep(); },
      setSelectedDate(selectedDate) { set({ selectedDate }); keep(); },
      navigate(delta) {
        const { selectedDate, view } = get();
        const date = view === 'month' ? shiftGregorianMonth(selectedDate, delta) : new Date(selectedDate);
        if (view !== 'month') date.setDate(date.getDate() + delta * (view === 'week' ? 7 : 1));
        get().setSelectedDate(date);
      },
      goToToday() { get().setSelectedDate(new Date()); },
      setFilter(patch) { set({ filter: { ...get().filter, ...patch } }); keep(); },
      updateSettings(patch) { set({ settings: { ...get().settings, ...patch } }); },
      async cancelMonthLoad() { generation++; pending?.abort(); pending = undefined; set({ loading: false }); },
      async loadMonth(date = get().selectedDate, options = {}) {
        pending?.abort(); const abort = new AbortController(); pending = abort;
        const ownGeneration = ++generation, activeRange = rangeFor(date);
        set({ activeRange, loading: options.background ? get().loading : true, error: null });
        try {
          const result = await host.read(activeRange, options.force ?? false, abort.signal);
          if (ownGeneration === generation && !abort.signal.aborted) set({ ...result, loading: false });
        } catch (error) {
          if (ownGeneration === generation && !abort.signal.aborted) set({ loading: false, queryState: 'offline-cache', error: error instanceof Error ? error.message : 'The calendar could not be loaded. Your saved work is kept.' });
        }
      },
      async addEvent(data) { await host.save(data); },
      async updateEvent(id, data, original) {
        if (id !== original.id) throw new Error('Reopen this exact event before saving.');
        await host.save(data, original);
      },
      async deleteEvent(id, scope, seriesIds, original) {
        if (id !== original.id) throw new Error('Reopen this exact event before deleting.');
        await host.remove(original, scope, seriesIds);
      },
    };
  });
}

const CalendarContext = createContext<StoreApi<CalendarState> | null>(null);
export function CalendarStoreProvider({ store, children }: { store: StoreApi<CalendarState>; children: ReactNode }) { return <CalendarContext.Provider value={store}>{children}</CalendarContext.Provider>; }
const identity = (state: CalendarState) => state;
export function useCalendarStore(): CalendarState;
export function useCalendarStore<T>(selector: (state: CalendarState) => T): T;
export function useCalendarStore<T>(selector?: (state: CalendarState) => T) {
  const store = useContext(CalendarContext);
  if (!store) throw new Error('Calendar host is not connected.');
  return useStore(store, selector ?? identity as (state: CalendarState) => T);
}
export const useCalendarHost = () => useCalendarStore(state => state.host);
export const useCalendarEditor = () => useStore(useCalendarHost().editor);
