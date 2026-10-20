import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { reminderItems, reminderAttempts, reminderRoute, reminderTitle, type WorkspaceReminder } from './reminder-items';
import type { ModuleId, Snapshot } from '../../../packages/domain/contracts';
import { reminderLabels } from '../../../packages/domain/reminders';
import { readLocal, request, saveLocal } from './api';
import type { useReminders } from './useReminders';
import { Dialog, Empty } from './ui';
import { retainedWindowId } from './useWorkspace';
import { pendingReminderActions, readReminderAction, readReminderView, ReminderActionController, reminderActionKey, reminderGroup, reminderIdentity, reminderPage, reminderSourceNotice, reminderTabs, reminderViewKey, snoozeMinutes, type ReminderReturn, type ReminderScope, type ReminderView } from './reminder-workspace';
import './reminders.css';

const labels = { due: 'Due', snoozed: 'Snoozed', history: 'History', scheduled: 'Scheduled' };
export function Reminders({ snapshot, notifications, close, openReminder, refresh, originRoute, actions }: {
  snapshot: Snapshot; notifications: ReturnType<typeof useReminders>; close(): void; refresh(): Promise<void>;
  originRoute: ModuleId | 'settings'; openReminder(item: WorkspaceReminder, origin?: ReminderReturn): Promise<boolean>;
  actions: Map<string, ReminderActionController>;
}) {
  const scope = { deviceId: snapshot.deviceId, epoch: snapshot.epoch, windowId: retainedWindowId }, key = reminderViewKey(scope);
  const [view, setView] = useState(() => readReminderView(readLocal(key), scope)), kept = useRef(view), body = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(''), [, render] = useState(0);
  const current = useRef(scope); current.current = scope;
  const changed = () => render(n => n + 1);
  const keep = (next: ReminderView) => {
    kept.current = next; setView(next);
    const ok = saveLocal(key, next); setError(ok ? '' : 'Free browser storage before leaving. Your current view and writing remain open.'); return ok;
  };
  const capture = () => ({ ...kept.current, positions: { ...kept.current.positions, [kept.current.tab]: { page: kept.current.positions[kept.current.tab]?.page ?? 0, scroll: body.current?.scrollTop ?? 0 } } });
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = view.positions[view.tab]?.scroll ?? 0; }, [view.tab, view.positions[view.tab]?.page]);
  const finish = () => { if (keep({ ...capture(), open: false, original: undefined })) close(); };
  const openOriginal = async (item: WorkspaceReminder) => {
    const notice = reminderSourceNotice(snapshot, item); if (notice) { setError(notice); return; }
    const original: ReminderReturn = { ...scope, token: crypto.randomUUID(), reminderId: item.id, kind: 'eventId' in item ? 'calendar' : 'tasks', id: 'eventId' in item ? item.eventId : item.taskId, ...('eventId' in item ? { originalDate: item.originalDate } : {}), from: originRoute };
    if (!keep({ ...capture(), open: false, original })) return;
    try { await openReminder(item, original); } catch (reason) { setError(reason instanceof Error ? reason.message : 'The original could not be opened. Your reminder view is kept.'); }
  };
  const all = reminderItems(snapshot);
  let keys: string[] = []; try { keys = Object.keys(localStorage); } catch { /* Writes still fail closed when storage is unavailable. */ }
  const pending = pendingReminderActions({ read: readLocal }, keys, scope, all), pendingIds = new Set(pending.map(r => r.id));
  const page = reminderPage(all, view.tab, view.positions[view.tab]?.page ?? 0), scheduled = reminderPage(all, 'scheduled', view.positions.scheduled?.page ?? 0);
  const duration = (id: string, text: string) => keep({ ...capture(), durations: { ...kept.current.durations, [id]: text } });
  const row = (item: WorkspaceReminder) => {
    const id = reminderIdentity(item);
    let controller = actions.get(id);
    if (!controller) { controller = new ReminderActionController(scope, item.id, { read: readLocal, write: saveLocal }, () => current.current, (route, command) => request(route, command), refresh); actions.set(id, controller); }
    controller.observe(changed);
    return <ReminderRow key={id} controller={controller} reminder={item} snapshot={snapshot} scope={scope} refresh={refresh} openOriginal={openOriginal} duration={view.durations[id] ?? ''} keepDuration={text => duration(id, text)}/>;
  };
  const pagination = (group: keyof typeof labels, data: typeof page) => data.pages > 1 && <div className="reminders-pagination" aria-label={`${labels[group]} pages`}><button disabled={!data.page} onClick={() => keep({ ...capture(), positions: { ...capture().positions, [group]: { page: data.page - 1, scroll: 0 } } })}>Previous</button><span>{data.page * 20 + 1}–{Math.min((data.page + 1) * 20, data.total)} of {data.total}</span><button disabled={data.page + 1 >= data.pages} onClick={() => keep({ ...capture(), positions: { ...capture().positions, [group]: { page: data.page + 1, scroll: 0 } } })}>Next</button></div>;
  return <Dialog title="Reminders" close={finish}><div className="reminders-workspace">
    <p className="metadata">Reminders stay here when the app is closed. Device notifications also need permission, the app running and OS availability.</p>
    <details className="reminders-device"><summary>{notifications.enabled ? 'Device notifications enabled' : 'In-app reminders enabled'}</summary><p>A displayed notification does not mean you read it.</p><button onClick={() => notifications.enabled ? notifications.disable() : void notifications.enable()}>{notifications.enabled ? 'Turn off notifications' : 'Enable device notifications'}</button></details>
    {snapshot.calendarReminders?.catchingUp && <p className="notice" role="status">Catching up on Calendar reminders. Earlier alerts will appear as their dates are checked.</p>}
    {notifications.notice && <p className="notice" role="status">{notifications.notice}</p>}{error && <p className="field-error" role="alert">{error}</p>}
    <div className="reminders-tabs" role="tablist" aria-label="Reminder views">{reminderTabs.map((tab, index) => <button key={tab} id={`reminders-tab-${tab}`} role="tab" aria-selected={view.tab === tab} aria-controls="reminders-panel" tabIndex={view.tab === tab ? 0 : -1} onClick={() => keep({ ...capture(), tab })} onKeyDown={event => { const next = event.key === 'ArrowRight' ? reminderTabs[(index + 1) % 3] : event.key === 'ArrowLeft' ? reminderTabs[(index + 2) % 3] : event.key === 'Home' ? 'due' : event.key === 'End' ? 'history' : undefined; if (next) { event.preventDefault(); keep({ ...capture(), tab: next }); document.getElementById(`reminders-tab-${next}`)?.focus(); } }}>{labels[tab]} <span>{all.filter(r => reminderGroup(r) === tab).length}</span></button>)}</div>
    <div ref={body} className="reminders-body" id="reminders-panel" role="tabpanel" aria-labelledby={`reminders-tab-${view.tab}`} onScroll={() => { const next = capture(); kept.current = next; if (!saveLocal(key, next)) setError('Free browser storage before leaving. Your reminder view remains open.'); }}>
      {pending.length > 0 && <section className="reminders-pending" aria-label="Unconfirmed changes"><h3>Unconfirmed changes · {pending.length}</h3><p className="metadata">Check the original response before making a different change.</p>{pending.map(p => p.known || p.journal?.original ? row(p.known ?? p.journal!.original!) : <p key={p.key} className="notice">A kept reminder action has no available original source. Its record remains on this device and has not been sent again.</p>)}</section>}
      {page.total ? page.items.filter(item => !pendingIds.has(item.id)).map(row) : <Empty title={view.tab === 'due' ? 'Nothing due.' : view.tab === 'snoozed' ? 'Nothing snoozed.' : 'No closed reminders.'}>Your reminders and their confirmed states appear here.</Empty>}
      {pagination(view.tab, page)}
      {view.tab === 'snoozed' && <section className="reminders-scheduled"><h3>Scheduled · {scheduled.total}</h3><p className="metadata">Upcoming reminders that have not been snoozed.</p>{scheduled.items.filter(item => !pendingIds.has(item.id)).map(row)}{pagination('scheduled', scheduled)}</section>}
    </div>
  </div></Dialog>;
}

function ReminderRow({ reminder, snapshot, scope, refresh, controller, openOriginal, duration, keepDuration }: {
  reminder: WorkspaceReminder; snapshot: Snapshot; scope: ReminderScope; refresh(): Promise<void>; controller: ReminderActionController;
  openOriginal(item: WorkspaceReminder): Promise<void>; duration: string; keepDuration(text: string): void;
}) {
  const element = useRef<HTMLElement>(null), marking = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [seenResult, setSeenResult] = useState<WorkspaceReminder>(), [seenBusy, setSeenBusy] = useState(false);
  const journal = readReminderAction(readLocal(reminderActionKey(scope, reminder.id)), reminder.id, reminder);
  const confirmed = controller.confirmed ?? journal?.confirmed;
  const r = [reminder, confirmed, seenResult].filter((r): r is WorkspaceReminder => !!r).sort((a, b) => b.revision - a.revision)[0];
  const pending = journal && !journal.confirmed && !journal.refusal, closed = ['dismissed', 'cancelled'].includes(r.state), minutes = snoozeMinutes(duration);
  const notice = reminderSourceNotice(snapshot, r);
  useEffect(() => {
    if (r.seenAt || pending || controller.busy || !['ready', 'missed', 'unavailable'].includes(r.state)) return;
    let intersects = false;
    const mark = () => {
      const bounds = element.current?.getBoundingClientRect();
      if (!intersects || !bounds || bounds.top >= innerHeight || bounds.bottom <= 0 || document.visibilityState !== 'visible' || marking.current || controller.busy) return;
      marking.current = true; setSeenBusy(true);
      void request<WorkspaceReminder>(`${reminderRoute(r)}/reminders/action`, { requestId: crypto.randomUUID(), epoch: snapshot.epoch, reminderId: r.id, expectedRevision: r.revision, action: 'seen' })
        .then(result => { if (mounted.current) setSeenResult(result); return refresh(); }).catch(() => {}).finally(() => { marking.current = false; if (mounted.current) setSeenBusy(false); });
    };
    const observer = new IntersectionObserver(entries => { intersects = entries.some(entry => entry.isIntersecting); if (intersects) mark(); }, { threshold: 0.3 });
    if (element.current) observer.observe(element.current); document.addEventListener('visibilitychange', mark);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', mark); };
  }, [r.id, r.revision, r.seenAt, r.state, pending, controller, snapshot.epoch, refresh]);
  const busy = controller.busy || seenBusy;
  return <article ref={element} className="reminder-item"><div className="reminder-heading"><strong>{reminderTitle(snapshot, r)}</strong><button disabled={!!notice || busy} onClick={() => void openOriginal(r)}>Open Original</button></div>
    <p className="metadata">{r.dueAt === null ? `${r.spec.date} · ${r.spec.time}` : new Date(r.dueAt).toLocaleString(undefined, { timeZone: r.spec.timezone })} · {r.spec.timezone.replaceAll('_', ' ')}</p>
    <p>{reminderGroup(r) === 'snoozed' ? 'Snoozed · confirmed wake time above' : reminderLabels[r.state]}{r.seenAt ? ' · Shown in app' : ''}</p>
    {notice && <p className="metadata">{notice}</p>}{r.reason && <p className="notice warning">{r.reason}</p>}
    {r.notification && <p className="metadata">Notification: {r.notification.state === 'shown' ? 'Display confirmed by this device' : r.notification.state === 'claimed' ? 'Checking display' : r.notification.state === 'unknown' ? 'Display unconfirmed · no automatic resend' : 'Unavailable · kept here'}</p>}
    {reminderAttempts(snapshot).some(a => a.reminderId === r.id && a.attemptId !== r.notification?.attemptId) && <details><summary>Previous notification attempts</summary>{reminderAttempts(snapshot).filter(a => a.reminderId === r.id && a.attemptId !== r.notification?.attemptId).map(a => <p className="metadata" key={a.attemptId}>{new Date(a.at).toLocaleString()} · {a.state === 'shown' ? 'Display confirmed' : a.state === 'unknown' ? 'Display unconfirmed' : a.state}</p>)}</details>}
    {(controller.error || journal?.refusal) && <p className="field-error" role="alert">{controller.error || journal?.refusal?.message}</p>}
    {pending ? <><button disabled={busy || journal.command.epoch !== scope.epoch} onClick={() => void controller.run(r)}>Check Original Response</button>{journal.command.epoch !== scope.epoch && <p className="metadata">This kept change belongs to an earlier workspace and will not be sent.</p>}</> : !closed && <div className="reminder-actions"><div className="button-row">{[10, 60].map(value => <button key={value} disabled={busy} onClick={() => void controller.run(r, 'snooze', value)}>Snooze {value} min</button>)}<button disabled={busy} onClick={() => void controller.run(r, 'dismiss')}>Dismiss</button></div><div className="reminder-custom"><label>Custom minutes<input inputMode="numeric" value={duration} maxLength={20} aria-label={`Snooze minutes for ${reminderTitle(snapshot, r)}`} onChange={event => keepDuration(event.target.value)}/></label><button disabled={busy || minutes === undefined} onClick={() => void controller.run(r, 'snooze', minutes)}>Snooze</button><small>Whole minutes, 1–1440. Dismiss closes only this reminder.</small></div></div>}
    {confirmed && !pending && <p className="metadata" role="status">Saved on the host.{controller.error && <button disabled={busy} onClick={() => void controller.run()}>Refresh Saved Response</button>}</p>}
  </article>;
}
