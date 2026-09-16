import { useEffect, useReducer, useRef } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { calendarCompletionKey, type CalendarCompletionCommand, type CalendarCompletion } from '../../../packages/domain/calendar-completion';
import { calendarWindowIdentity } from './calendar-window';
import { readLocal, request, saveLocal } from './api';
import { createCalendarCompletionActions, type CompletionJournal } from './calendar-completion-actions';
export function useCalendarCompletion(snapshot: Snapshot, refresh: () => Promise<void>) {
  const [, render] = useReducer(n => n + 1, 0), latest = useRef(refresh); latest.current = refresh;
  const owner = useRef<ReturnType<typeof createCalendarCompletionActions> | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void calendarWindowIdentity().then(({ id, previous }) => {
      if (!active) return;
      const prefix = `e3:calendar-completion:${snapshot.epoch}:${snapshot.deviceId}:`, key = prefix + id;
      const initial = readLocal<CompletionJournal>(key) ?? (previous ? readLocal<CompletionJournal>(prefix + previous) : undefined);
      const engine = createCalendarCompletionActions({ initial, persist: value => saveLocal(key, value), send: command => request('tasks/calendar-completion', command), refresh: () => latest.current(), changed: () => { if (active) render(); } });
      owner.current = engine; render(); void engine.retry();
    });
    return () => { active = false; owner.current = undefined; };
  }, [snapshot.epoch, snapshot.deviceId]);
  const state = owner.current?.state, records = new Map((snapshot.calendarCompletions ?? []).map(record => [record.key, record]));
  if (state?.confirmed && (records.get(state.confirmed.key)?.revision ?? 0) < state.confirmed.revision) records.set(state.confirmed.key, state.confirmed);
  const value = (target: CalendarCompletionCommand['target']) => {
    const key = calendarCompletionKey(target), saved = records.get(key), pending = state?.pending;
    return { saved, done: pending && calendarCompletionKey(pending.target) === key ? pending.done : saved?.done ?? false };
  };
  return { records: [...records.values()] as CalendarCompletion[], value, busy: !owner.current || owner.current.busy || !!state?.pending, pending: state?.pending, error: state?.error,
    run: (command: CalendarCompletionCommand) => owner.current?.run(command) ?? Promise.resolve(false), retry: () => owner.current?.retry() };
}
