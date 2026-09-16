import { useEffect, useReducer, useRef } from 'react';
import type { Command, Snapshot, Task } from '../../../packages/domain/contracts';
import { commit, readLocal, saveLocal } from './api';
import { createTaskActions, type TaskChange, type TaskJournal } from './task-actions';
import { calendarWindowIdentity } from './calendar-window';

export function useTaskActions(snapshot: Snapshot, refresh: () => Promise<void>) {
  const [, render] = useReducer(value => value + 1, 0), current = useRef({ refresh, epoch: snapshot.epoch }); current.current = { refresh, epoch: snapshot.epoch };
  const owner = useRef<ReturnType<typeof createTaskActions> | undefined>(undefined);
  const opening = useRef<TaskJournal>({ queue: [], undo: [], label: '', error: '', notice: '' });
  useEffect(() => {
    let active = true;
    void calendarWindowIdentity().then(({ id, previous }) => {
      if (!active) return;
      const legacyKey = `e3:task-actions:${snapshot.deviceId}`, key = `${legacyKey}:window:${id}`;
      const initial = readLocal<TaskJournal>(key) ?? (previous ? readLocal<TaskJournal>(`${legacyKey}:window:${previous}`) : undefined) ?? readLocal<TaskJournal>(legacyKey + ':v2');
      const engine = createTaskActions({ epoch: snapshot.epoch, initial, legacy: readLocal<Command[]>(legacyKey),
        persist: value => saveLocal(key, value), commit: command => commit<Task>(command), changed: () => { if (active) render(); },
        refresh: () => current.current.refresh(), epochNow: () => current.current.epoch });
      if (!saveLocal(key, engine.state)) { opening.current = { ...opening.current, error: 'Free browser storage and reopen Tasks before changing saved tasks.' }; render(); return; }
      localStorage.removeItem(legacyKey); localStorage.removeItem(legacyKey + ':v2');
      owner.current = engine; render(); void engine.retry();
    }).catch(() => { opening.current = { ...opening.current, error: 'Task recovery could not open. Reload this window to retry.' }; if (active) render(); });
    return () => { active = false; };
  }, [snapshot.deviceId]);
  return { get state() { return owner.current?.state ?? opening.current; }, get busy() { return !owner.current || owner.current.busy; },
    run: (changes: TaskChange[], label: string) => owner.current?.run(changes, label) ?? Promise.resolve(false),
    retry: () => owner.current?.retry() ?? Promise.resolve(false), undo: () => owner.current?.undo() ?? Promise.resolve(false), dismiss: () => owner.current?.dismiss(),
  };
}
