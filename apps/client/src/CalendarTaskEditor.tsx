import { useRef, useState } from 'react';
import type { Snapshot, Task } from '../../../packages/domain/contracts';
import { calendarCompletionTarget, type CalendarCompletion, type CalendarCompletionCommand } from '../../../packages/domain/calendar-completion';
import type { CalendarRange } from '../../../packages/domain/calendar';
import { syncTaskSubtasks } from '../../../packages/domain/task-subtasks';
import type { CalendarTaskRow } from './task-calendar-rows';
import { SubtaskFields } from './SubtaskFields';
import { ApiError, readLocal, request, saveLocal } from './api';
import { Dialog } from './ui';
import { CalendarDays, Save } from './icons';
type Draft = { value: Task; revision: number; pending?: CalendarCompletionCommand; epoch: string };
export function CalendarTaskEditor({ row, snapshot, record, range, generation, close, saved, openCalendar }: { row: CalendarTaskRow; snapshot: Snapshot; record?: CalendarCompletion; range: CalendarRange; generation?: string; close(): void; saved(): void; openCalendar(): void }) {
  const key = `e3:event-task:${snapshot.epoch}:${snapshot.deviceId}:${row.key}`;
  const [draft, setDraft] = useState<Draft>(() => readLocal<Draft>(key) ?? { revision: record?.revision ?? 0, epoch: snapshot.epoch, value: { title: row.event.title, notes: row.event.notes ?? '', planned: row.date, due: '', status: record?.done ? 'done' : 'open', checklist: record?.checklist ?? [] } });
  const ref = useRef(draft); ref.current = draft;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState<CalendarCompletion | null>(null);
  const persist = (next: Draft) => { ref.current = next; setDraft(next); if (!saveLocal(key, next)) setError('Browser storage is full. Keep this window open until your save is confirmed.'); };
  const save = async () => {
    if (busy || conflict) return;
    const command = ref.current.pending ?? { requestId: crypto.randomUUID(), epoch: ref.current.epoch, target: calendarCompletionTarget(row.event), generation, range, expectedRevision: ref.current.revision, done: ref.current.value.status === 'done', checklist: ref.current.value.checklist };
    if (!saveLocal(key, { ...ref.current, pending: command })) { setError('Free browser storage before saving this checklist.'); return; }
    persist({ ...ref.current, pending: command }); setBusy(true); setError('');
    try { await request('tasks/calendar-completion', command); localStorage.removeItem(key); saved(); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your checklist save is not confirmed.');
      if (reason instanceof ApiError && reason.code === 'calendar_completion_changed') setConflict(reason.current as unknown as CalendarCompletion);
      else if (reason instanceof ApiError && reason.status && reason.status < 500 && ![408, 429].includes(reason.status)) persist({ ...ref.current, pending: undefined });
    } finally { setBusy(false); }
  };
  return <Dialog title="Event subtasks" close={close}><form className="task-editor" onSubmit={e => { e.preventDefault(); void save(); }}>
    <h3>{row.event.title}</h3><p className="metadata">{row.date}{row.event.seriesId || row.group !== 'One-offs' ? ' · This occurrence' : ''}</p>
    <button type="button" onClick={openCalendar}><CalendarDays size={16}/>Open in Calendar</button>
    <fieldset disabled={busy || !!draft.pending}><SubtaskFields owner={`calendar:${row.key}`} value={draft.value} change={patch => persist({ ...ref.current, value: syncTaskSubtasks({ ...ref.current.value, ...patch }, ref.current.value) })} snapshot={snapshot}/></fieldset>
    {error && <div className="notice warning" role="alert"><p>{error}</p>{conflict && <button type="button" onClick={() => { persist({ ...ref.current, revision: conflict.revision, epoch: snapshot.epoch, pending: undefined }); setConflict(null); setError('Your checklist is kept for review. Save explicitly to replace the newer checklist.'); }}>Review my kept checklist</button>}</div>}
    <div className="dialog-footer"><span className="metadata">Checklist stays in Nova Dream</span><button type="button" className="quiet" onClick={close}>Keep for later</button><button type="submit" className="primary" disabled={busy || !!conflict}><Save size={17}/>{busy ? 'Saving…' : draft.pending ? 'Reconcile save' : 'Save checklist'}</button></div>
  </form></Dialog>;
}
