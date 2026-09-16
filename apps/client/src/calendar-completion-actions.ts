import type { CalendarCompletion, CalendarCompletionCommand } from '../../../packages/domain/calendar-completion';
export type CompletionJournal = { pending?: CalendarCompletionCommand; confirmed?: CalendarCompletion; error?: string };
export function createCalendarCompletionActions(options: { initial?: CompletionJournal; persist(value: CompletionJournal): boolean; send(command: CalendarCompletionCommand): Promise<CalendarCompletion>; refresh(): Promise<void>; changed(): void }) {
  let state = options.initial ?? {}, busy = false;
  const update = (next: CompletionJournal) => {
    if (!options.persist(next)) { state = { ...state, error: 'Free browser storage before changing completion. Your original request is kept.' }; options.changed(); return false; }
    state = next; options.changed(); return true;
  };
  async function retry() {
    if (busy || !state.pending) return false;
    const command = state.pending; busy = true; options.changed();
    try {
      const confirmed = await options.send(command);
      if (!update({ confirmed })) return false;
      await options.refresh().catch(() => {});
      return true;
    } catch (reason) {
      const error = reason as { status?: number; message?: string };
      const rejected = !!error.status && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
      update({ ...state, ...(rejected ? { pending: undefined } : {}), error: error.message ?? 'Completion is not confirmed. Retry checks the original save.' });
      if (rejected) await options.refresh().catch(() => {});
      return false;
    } finally { busy = false; options.changed(); }
  }
  return { get state() { return state; }, get busy() { return busy; }, retry,
    run(command: CalendarCompletionCommand) { if (busy || state.pending || !update({ ...state, pending: command, error: '' })) return Promise.resolve(false); return retry(); },
  };
}
