import { useEffect, useRef, useState } from 'react';
import type { AppIconChoice, Snapshot } from '../../../packages/domain/contracts';
import { appIconAssets } from './app-icon';
import { reminderItems, reminderTitle, reminderRoute, type WorkspaceReminder } from './reminder-items';
import { ApiError, readLocal, request, saveLocal } from './api';
export function useReminders(snapshot: Snapshot, online: boolean, refresh: () => Promise<void>, openReminder: (item: WorkspaceReminder) => void, appIcon: AppIconChoice = 'red') {
  const key = `e3:notifications:${snapshot.deviceId}`;
  const [enabled, setEnabled] = useState(() => readLocal<boolean>(key) === true), [notice, setNotice] = useState('');
  const [clientId] = useState(() => crypto.randomUUID());
  const current = useRef({ snapshot, online, enabled, openReminder, appIcon }); current.current = { snapshot, online, enabled, openReminder, appIcon };
  const supported = typeof Notification !== 'undefined' && isSecureContext;
  const enable = async () => {
    if (!supported) { setNotice('Device notifications are unavailable here. Due reminders remain in this app.'); return; }
    try { const permission = await Notification.requestPermission(); if (permission === 'granted') { if (!saveLocal(key, true)) throw Error('Free browser storage before enabling notifications.'); setEnabled(true); setNotice('Notifications are enabled while this app is open. Phone background delivery still needs supported device setup.'); } else setNotice('Notifications are blocked on this device. Due reminders remain available in the app.'); }
    catch (e) { setNotice(e instanceof Error ? e.message : 'Notifications could not be enabled.'); }
  };
  const disable = () => { const kept = saveLocal(key, false); setEnabled(false); setNotice(kept ? 'Device notifications are off. Due reminders remain in this app.' : 'Notifications are off in this window. Free browser storage to keep this setting after reload.'); };
  useEffect(() => {
    let alive = true, busy = false; const attempted = new Set<string>();
    const reportPrefix = `e3:reminder-report:${snapshot.deviceId}:`;
    const report = async (reminder: WorkspaceReminder, action: 'shown' | 'unavailable') => {
      const attempt = reminder.notification!;
      const cmd = { requestId: crypto.randomUUID(), epoch: snapshot.epoch, reminderId: reminder.id, clientId, attemptId: attempt.attemptId, action };
      const name = reportPrefix + cmd.requestId;
      const kept = saveLocal(name, { ...cmd, reminderRoute: reminderRoute(reminder) });
      try { await request(`${reminderRoute(reminder)}/reminders/delivery`, cmd); if (kept) localStorage.removeItem(name); await refresh(); }
      catch { if (alive) setNotice('A notification outcome is awaiting host confirmation. It will not be shown again automatically.'); }
    };
    const drain = async () => {
      if (busy || !alive || !current.current.online) return; busy = true;
      try {
        // Replay only observed outcome receipts, never notification dispatch.
        for (const name of Object.keys(localStorage).filter(name => name.startsWith(reportPrefix))) {
          const stored = readLocal<{ reminderRoute?: string; [key: string]: unknown }>(name); if (!stored) continue;
          const { reminderRoute: route, ...cmd } = stored;
          if (route && !['tasks', 'calendar'].includes(route)) continue;
          try { await request(`${route ?? 'tasks'}/reminders/delivery`, cmd); localStorage.removeItem(name); }
          catch (e) { if (e instanceof ApiError && ['epoch_changed', 'reminder_attempt_changed', 'reminder_not_due'].includes(e.code)) localStorage.removeItem(name); else break; }
        }
        const state = current.current;
        if (!state.enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const reminder = reminderItems(state.snapshot).find(r => r.state === 'ready' && !r.notification && !attempted.has(`${r.id}:${r.snoozes}`));
        if (!reminder) return; attempted.add(`${reminder.id}:${reminder.snoozes}`);
        const claim = await request<WorkspaceReminder>(`${reminderRoute(reminder)}/reminders/delivery`, { requestId: crypto.randomUUID(), epoch: state.snapshot.epoch, reminderId: reminder.id, clientId, action: 'claim' });
        const latest = await request<Snapshot>('snapshot');
        const live = reminderItems(latest).find(r => r.id === reminder.id);
        const taskClosed = 'taskId' in reminder && !latest.tasks.some(task => task.id === reminder.taskId && !['done', 'skipped'].includes(task.value.status));
        if (!live || !claim.notification || !alive || !current.current.enabled || latest.epoch !== state.snapshot.epoch || current.current.snapshot.epoch !== state.snapshot.epoch || live?.notification?.attemptId !== claim.notification?.attemptId || live.state !== 'ready' || taskClosed) return;
        let notification: Notification;
        try { notification = new Notification(`Nova Dream · ${'eventId' in reminder ? 'Calendar' : 'task'} reminder`, { body: reminderTitle(latest, live), tag: claim.notification!.attemptId, icon: appIconAssets(current.current.appIcon).launcher }); }
        catch { await report(claim, 'unavailable'); return; }
        notification.onshow = () => { void report(claim, 'shown'); };
        notification.onerror = () => { void report(claim, 'unavailable'); };
        notification.onclick = () => { window.focus(); current.current.openReminder(live); notification.close(); };
      } catch { /* A missing claim response is not permission to dispatch again. */ }
      finally { busy = false; }
    };
    const timer = setInterval(() => { void drain(); }, 2000); void drain();
    return () => { alive = false; clearInterval(timer); };
  }, [snapshot.deviceId, snapshot.epoch, clientId, refresh]);
  return { enabled, supported, notice, enable, disable };
}
