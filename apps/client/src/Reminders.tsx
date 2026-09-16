import { useEffect, useRef, useState } from 'react';
import { reminderItems, reminderAttempts, reminderRoute, reminderTitle, type WorkspaceReminder } from './reminder-items';
import type { Snapshot } from '../../../packages/domain/contracts';
import { reminderLabels } from '../../../packages/domain/reminders';
import { ApiError, readLocal, request, saveLocal } from './api';
import type { useReminders } from './useReminders';
import { Dialog, Empty } from './ui';
export function Reminders({ snapshot, notifications, close, openReminder, refresh }: { snapshot: Snapshot; notifications: ReturnType<typeof useReminders>; close: () => void; openReminder: (item: WorkspaceReminder) => void; refresh: () => Promise<void> }) {
  const all = reminderItems(snapshot), active = all.filter(r => !['dismissed', 'cancelled'].includes(r.state) || readLocal(`e3:reminder-action:${snapshot.deviceId}:${sessionStorage.getItem('e3:tab')}:${r.id}`)).sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  return <Dialog title="Reminders" close={close}><p className="metadata">The host keeps due alerts even when this window is closed. Device notifications depend on permission, this app staying open and OS availability. A shown notification does not mean you have read it.</p><div className="reminder-permission"><span>{notifications.enabled ? 'Device notifications enabled' : 'In-app reminders enabled'}</span><button onClick={() => notifications.enabled ? notifications.disable() : void notifications.enable()}>{notifications.enabled ? 'Turn off notifications' : 'Enable device notifications'}</button></div>{snapshot.calendarReminders?.catchingUp && <p className="notice" role="status">Catching up on Calendar reminders since the host was last running. Earlier alerts will appear as their dates are checked.</p>}{notifications.notice && <p className="notice" role="status">{notifications.notice}</p>}<div className="reminder-list">{active.length ? active.map(item => <ReminderRow key={item.id} reminder={item} snapshot={snapshot} openReminder={openReminder} refresh={refresh}/>) : <Empty title="Nothing waiting here.">Add a reminder to a task or Calendar event.</Empty>}</div>{all.some(r => ['dismissed', 'cancelled'].includes(r.state)) && <details><summary>Closed reminders</summary>{all.filter(r => ['dismissed', 'cancelled'].includes(r.state)).slice(-50).reverse().map(r => <p key={r.id} className="metadata">{reminderTitle(snapshot, r)} · {reminderLabels[r.state]}</p>)}</details>}</Dialog>;
}
function ReminderRow({ reminder: r, snapshot, openReminder, refresh }: { reminder: WorkspaceReminder; snapshot: Snapshot; openReminder: (item: WorkspaceReminder) => void; refresh: () => Promise<void> }) {
  const row = useRef<HTMLElement | null>(null), seen = useRef(false);
  const key = `e3:reminder-action:${snapshot.deviceId}:${sessionStorage.getItem('e3:tab')}:${r.id}`;
  const [pending, setPending] = useState<object | undefined>(() => readLocal<object>(key)), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { seen.current = false; }, [r.snoozes]);
  useEffect(() => {
    let intersects = false;
    if (r.seenAt || seen.current || !['ready', 'missed', 'unavailable'].includes(r.state)) return;
    const mark = () => {
      const rect = row.current?.getBoundingClientRect();
      if (!intersects || !rect || rect.top >= innerHeight || rect.bottom <= 0 || document.visibilityState !== 'visible' || seen.current) return;
      seen.current = true;
      void request(`${reminderRoute(r)}/reminders/action`, { requestId: crypto.randomUUID(), epoch: snapshot.epoch, reminderId: r.id, expectedRevision: r.revision, action: 'seen' }).then(refresh).catch(() => { seen.current = false; });
    };
    const observer = new IntersectionObserver(entries => { intersects = entries.some(e => e.isIntersecting); if (intersects) mark(); }, { threshold: 0.3 }); if (row.current) observer.observe(row.current);
    document.addEventListener('visibilitychange', mark);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', mark); };
  }, [r.revision, r.seenAt, r.state, r.id, snapshot.epoch, refresh]);
  const act = async (action: 'dismiss' | 'snooze') => {
    if (busy) return;
    const cmd = pending ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, reminderId: r.id, expectedRevision: r.revision, action, ...(action === 'snooze' ? { minutes: 10 } : {}) };
    if (!saveLocal(key, cmd)) { setError('Free browser storage before changing this reminder.'); return; }
    setPending(cmd); setBusy(true); setError('');
    try { await request(`${reminderRoute(r)}/reminders/action`, cmd); localStorage.removeItem(key); setPending(undefined); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'This change is not confirmed.'); if (e instanceof ApiError && ['reminder_changed', 'reminder_closed', 'epoch_changed'].includes(e.code)) { localStorage.removeItem(key); setPending(undefined); await refresh(); } }
    finally { setBusy(false); }
  };
  return <article className="reminder-item" ref={row}><button className="reminder-task" onClick={() => openReminder(r)}>{reminderTitle(snapshot, r)}</button><p className="metadata">{r.dueAt === null ? `${r.spec.date} · ${r.spec.time}` : new Date(r.dueAt).toLocaleString(undefined, { timeZone: r.spec.timezone })} · {r.spec.timezone.replaceAll('_', ' ')}</p><p>{reminderLabels[r.state]}{r.seenAt ? ' · Shown in app' : ''}</p>{r.reason && <p className="notice warning">{r.reason}</p>}{r.notification && <p className="metadata">Notification: {r.notification.state === 'shown' ? 'Display confirmed by this device' : r.notification.state === 'claimed' ? 'Checking display' : r.notification.state === 'unknown' ? 'Display unconfirmed · no automatic resend' : 'Unavailable · kept here'}</p>}{(reminderAttempts(snapshot)?.filter(a => a.reminderId === r.id && a.attemptId !== r.notification?.attemptId).length ?? 0) > 0 && <details><summary>Previous notification attempts</summary>{reminderAttempts(snapshot)?.filter(a => a.reminderId === r.id && a.attemptId !== r.notification?.attemptId).map(a => <p className="metadata" key={a.attemptId}>{new Date(a.at).toLocaleString()} · {a.state === 'shown' ? 'Display confirmed' : a.state === 'unknown' ? 'Display unconfirmed' : a.state}</p>)}</details>}{error && <p className="field-error" role="alert">{error}</p>}<div className="button-row">{pending ? <button disabled={busy} onClick={() => void act('dismiss')}>Reconcile original change</button> : <><button disabled={busy} onClick={() => void act('snooze')}>Snooze 10 minutes</button><button disabled={busy} onClick={() => void act('dismiss')}>Dismiss</button></>}</div></article>;
}
