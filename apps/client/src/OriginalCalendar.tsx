import { LoadingRing } from './ModuleLoading';
import { CalendarTaskEditor } from './CalendarTaskEditor';
import { calendarCompletionKey, calendarCompletionTarget } from '../../../packages/domain/calendar-completion';
import type { CalendarTaskRow } from './task-calendar-rows';
import type { CalendarState as SharedCalendarState } from '../../../packages/domain/calendar';
import type { CalendarEvent as OriginalEvent } from './dreamclaw/pages/Calendar/calendarTypes';
import { keepInboxTarget } from './inbox-target';
import {calendarTargetKey,readCalendarTarget} from './calendar-target';
import type {LocalCalendarDetail} from '../../../packages/domain/calendar';
import { useEffect, useRef, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { dayInZone } from '../../../packages/domain/tasks';
import { calendarWindowIdentity, preparedCalendarWindow } from './calendar-window';
import { readLocal, request, saveLocal } from './api';
import CalendarPage from './dreamclaw/pages/Calendar';
import { CalendarStoreProvider, createCalendarStore } from './dreamclaw/stores/calendarStore';
import { createCalendarHost } from './dreamclaw/calendar-host';
import { calendarI18n, calendarI18nReady } from './dreamclaw/calendar-i18n';
import type { CalendarFilter, CalendarSettings } from './dreamclaw/pages/Calendar/calendarTypes';
import { useStore } from 'zustand';
import { CalendarEditScope, ProviderCalendarEditScope } from './CalendarEditScope';
import type { CalendarHost } from './dreamclaw/stores/calendarStore';
import './dreamclaw/styles.css';
import { CalendarAccountSetup } from './AccountSetup';

type Props = { snapshot: Snapshot; online: boolean; editTask: (task: Entity<Task>) => void; openSettings: () => void; openInbox: () => void; openContent: (id: string) => void; editRoutine: (id: string) => void };
type View = { day: string; view: CalendarSettings['defaultView']; filter?: CalendarFilter };
export default function OriginalCalendar(props: Props) {
  const [identity, setIdentity] = useState(preparedCalendarWindow);
  useEffect(() => { let live = true; void Promise.all([calendarWindowIdentity(), calendarI18nReady]).then(([identity]) => { if (live) setIdentity(identity); }); return () => { live = false; }; }, []);
  return identity ? <ConnectedCalendar key={`${props.snapshot.deviceId}:${identity.id}:${props.snapshot.epoch}:${props.snapshot.layout.value.timezone}`} {...props} windowId={identity.id} previousWindowId={identity.previous}/> : <main className="page-scroll"><LoadingRing label="Opening your calendar…"/></main>;
}
function ConnectedCalendar({ snapshot, windowId, previousWindowId, editTask, openSettings, openInbox, openContent, editRoutine }: Props & { windowId: string; previousWindowId?: string }) {
  const [eventTask, setEventTask] = useState<{ row: CalendarTaskRow; state: SharedCalendarState; original: OriginalEvent } | null>(null);
  const live = useRef({ snapshot, editTask, openSettings, openInbox, openContent, editRoutine });
  live.current = { snapshot, editTask, openSettings, openInbox, openContent, editRoutine };
  const [store] = useState(() => {
    const key = `e3:original-calendar-view:${snapshot.deviceId}:${windowId}`;
    const kept = readLocal<View>(key) ?? readLocal<View>(`e3:calendar:${snapshot.deviceId}:${windowId}`);
    const day = kept?.day ?? dayInZone(snapshot.layout.value.timezone);
    const host = createCalendarHost({ openSubtasks: (row, state, original) => setEventTask({ row, state, original }), snapshot, windowId, previousWindowId, changed: async () => { await store.getState().loadMonth(undefined, { background: true }); },
      navigate(route) { if (route.startsWith('/inbox?')) { const params=new URLSearchParams(route.split('?')[1]); keepInboxTarget(snapshot.deviceId,windowId,{epoch:live.current.snapshot.epoch,eventId:params.get('event')!,source:{provider:params.get('provider') as 'google'|'microsoft',accountId:params.get('account')!,threadId:params.get('thread')!}}); live.current.openInbox(); } else if (route.startsWith('/content?')) { const id = new URLSearchParams(route.split('?')[1]).get('item'); if (id) live.current.openContent(id); } else if (route.startsWith('/settings')) live.current.openSettings(); else if (route.startsWith('/tasks?')) { const params = new URLSearchParams(route.split('?')[1]); const routine = params.get('routine'); if (routine) { live.current.editRoutine(routine); return; } const id = params.get('task'); const task = live.current.snapshot.tasks.find(task => task.id === id); if (task) live.current.editTask(task); } },
      keepView(date, view, filter) {
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        if (!saveLocal(key, { day, view, filter })) store.setState({ error: 'Browser storage is full. Keep this calendar open to preserve its view.' });
      },
    });
    return createCalendarStore(host, { date: new Date(day + 'T12:00:00'), view: kept?.view ?? 'month', filter: kept?.filter, timezone: snapshot.layout.value.timezone });
  });
  const [targetError,setTargetError]=useState('');
  const [targetAttempt,setTargetAttempt]=useState(0);
  useEffect(() => { const reopen = () => setTargetAttempt(value => value + 1); window.addEventListener('e3:calendar-target', reopen); return () => window.removeEventListener('e3:calendar-target', reopen); }, []);
  useEffect(()=>{
    const target=readCalendarTarget(snapshot.deviceId,windowId);if(!target)return;
    let active=true;const controller=new AbortController();
    void (async () => {
      if (target.provider) {
        const p = target.provider;
        if (p.epoch !== snapshot.epoch) throw Error('Reopen the event from this workspace.');
        const date = new Date(p.date + 'T12:00:00');
        await store.getState().host.openLinkedEvent!(p, controller.signal);
        if (!active) return;
        store.getState().setSelectedDate(date);
      } else {
        const detail = await request<LocalCalendarDetail>(`calendar/local/${encodeURIComponent(target.eventId)}${target.originalDate ? '?originalDate='+encodeURIComponent(target.originalDate) : ''}`, undefined, controller.signal);
        if (!active) return;
        if (detail.epoch !== snapshot.epoch || detail.event.id !== target.eventId) throw Error('Reconnect before opening this exact Calendar event.');
        store.getState().host.editor.getState().openSaved(detail);
        store.getState().setSelectedDate(new Date((detail.occurrence?.value.start.date ?? detail.event.value.start.date)+'T12:00:00'));
      }
      if(readCalendarTarget(snapshot.deviceId,windowId)?.nonce===target.nonce&&!saveLocal(calendarTargetKey(snapshot.deviceId,windowId),null))throw Error('Your event is open. Free browser storage to keep this navigation change.');
      setTargetError('');
    })().catch(error=>{if(active)setTargetError(error instanceof Error?error.message:'This Calendar event could not be opened. Retry its saved identity.');});
    return()=>{active=false;controller.abort();};
  },[snapshot.deviceId,snapshot.epoch,windowId,store,targetAttempt]);
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden && !store.getState().loading) void store.getState().loadMonth(undefined, { background: true }); }, 4000); return () => { clearInterval(timer); void store.getState().cancelMonthLoad(); }; }, [store]);
  return <I18nextProvider i18n={calendarI18n}><CalendarStoreProvider store={store}><div className="dreamclaw-module calendar-module"><CalendarAccountSetup openSettings={openSettings}/>{targetError&&<div className="calendar-target-error" role="alert"><span>{targetError}</span><button onClick={()=>setTargetAttempt(value=>value+1)}>Retry opening event</button></div>}<CalendarPage/></div>{eventTask && <CalendarTaskEditor key={eventTask.row.key} row={eventTask.row} record={snapshot.calendarCompletions?.find(record => record.key === calendarCompletionKey(calendarCompletionTarget(eventTask.row.event)))} snapshot={snapshot} range={eventTask.state.range} generation={eventTask.state.sources.find(source => source.id === eventTask.row.event.sourceId)?.generation} close={() => setEventTask(null)} saved={() => { setEventTask(null); void store.getState().loadMonth(undefined, { background: true }); }} openCalendar={() => { const original = eventTask.original; setEventTask(null); store.getState().host.editor.getState().begin(original); }}/>}<ScopeChoice host={store.getState().host} epoch={snapshot.epoch}/></CalendarStoreProvider></I18nextProvider>;
}
function ScopeChoice({ host, epoch }: { host: CalendarHost; epoch: string }) {
  const editor = useStore(host.editor);
  if (editor.providerScope) return <ProviderCalendarEditScope event={editor.providerScope} close={editor.close} choose={scope => void editor.openProvider(editor.providerScope!, scope)}/>;
  return editor.scopeEvent ? <CalendarEditScope event={editor.scopeEvent} epoch={epoch} close={editor.close} choose={editor.choose}/> : null;
}
