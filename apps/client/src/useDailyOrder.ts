import { inTaskDestination } from '../../../packages/domain/task-presentation';
import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { sortTasks, type DailyOrderCommand } from '../../../packages/domain/tasks';
import { ApiError, readLocal, request, saveLocal } from './api';
type Kept = { command: DailyOrderCommand; conflict?: boolean; reviewed?: boolean };
export function useDailyOrder(snapshot: Snapshot, date: string, refresh: () => Promise<void>) {
  const [windowId] = useState(() => sessionStorage.getItem('e3:tab') ?? crypto.randomUUID());
  const timezone = snapshot.layout.value.timezone, key = `e3:daily-order:${snapshot.deviceId}:${windowId}:${date}:${timezone}`;
  const [state, setState] = useState<{ key: string; kept?: Kept }>(() => ({ key, kept: readLocal<Kept>(key) }));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const currentKey = useRef(key); currentKey.current = key;
  useEffect(() => { setState({ key, kept: readLocal<Kept>(key) }); setError(''); setBusy(false); }, [key]);
  const kept = state.key === key ? state.kept : undefined, host = snapshot.taskState?.orders?.find(o => o.date === date && o.timezone === timezone);
  const tasks = snapshot.tasks.filter(t => inTaskDestination(t, 'Today', date, timezone));
  const ids = sortTasks(tasks, kept?.command.taskIds ?? host?.taskIds).map(t => t.id);
  const persist = (value: Kept) => { if (!saveLocal(key, value)) { setError('Free browser storage before changing the order.'); return false; } setState({ key, kept: value }); return true; };
  const run = async (order?: string[]) => {
    if (busy || kept?.conflict) return;
    const value = kept ?? { command: { requestId: crypto.randomUUID(), epoch: snapshot.epoch, date, timezone, expectedRevision: host?.revision ?? 0, taskIds: order ?? ids } };
    if (!persist(value)) return; setBusy(true); setError('');
    try { await request('tasks/order', value.command); localStorage.removeItem(key); if (currentKey.current === key) setState({ key }); await refresh(); }
    catch (reason) { if (currentKey.current === key) { setError(reason instanceof Error ? reason.message : 'Order save is unconfirmed.'); if (reason instanceof ApiError && ['order_changed', 'order_membership', 'epoch_changed', 'validation'].includes(reason.code)) { persist({ ...value, conflict: true }); await refresh(); } } }
    finally { if (currentKey.current === key) setBusy(false); }
  };
  const review = () => { if (busy) return; persist({ command: { requestId: crypto.randomUUID(), epoch: snapshot.epoch, date, timezone, expectedRevision: host?.revision ?? 0, taskIds: ids }, reviewed: true }); setError('Your kept order is ready for review. Save it explicitly to replace the host order.'); };
  const discard = () => { localStorage.removeItem(key); setState({ key }); setError(''); };
  return { ids, host, busy, kept, error, run, review, discard };
}
