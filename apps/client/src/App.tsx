import { assistantSpace, spaceDraftId } from '../../../packages/domain/assistant-space';
import { useTaskActions } from './useTaskActions';
import { keepInboxTarget } from './inbox-target';
import type { MailContactSource } from '../../../packages/domain/mail-contact';
import { savedRecordMatches } from './saved-record-search';
import { reminderItems, type WorkspaceReminder } from './reminder-items';
import { keepCalendarTarget } from './calendar-target';
import { calendarWindowIdentity } from './calendar-window';
import { Suspense, useEffect, useRef, useState } from 'react';
import { lazy, preloadModules } from './preload-lazy';
import { prepareInitialViews } from './prepared-views';
import { inboxLoadingPercent } from './inbox-startup-progress';
import { Bell, Bot, CalendarDays, Check, CheckSquare2, ChevronDown, CircleHelp, CloudOff, ContentIcon, FileText, Home as HomeIcon, Inbox, Menu, PanelLeft, MessageSquare, MoreHorizontal, Moon, Plus, Search, Settings, Sun, Users, UserRound, X, type Icon as AppIcon } from './icons';
import { defaultLayout, emptyDraft, moduleIds, type Command, type Entity, type Layout, type ModuleId, type Snapshot, type Task } from '../../../packages/domain/contracts';
import { ApiError, commit, readLocal, saveLocal } from './api';
import { useRetained, useWorkspace } from './useWorkspace';
import { useReorder } from './useReorder';
import { Home } from './Home';
const ProjectEditor = lazy(() => import('./ProjectEditor').then(module => ({ default: module.ProjectEditor })));
const Assistant = lazy(() => import('./Assistant').then(module => ({ default: module.Assistant })));
import type { SettingsTab } from './SettingsPage';
const SettingsPage = lazy(() => import('./SettingsPage').then(module => ({ default: module.SettingsPage })));
const PhonePairingScreen = lazy(() => import('./Phone').then(module => ({ default: module.PhonePairingScreen })));
import { VoiceController } from './voice-controller';
import { VoicePanel } from './VoicePanel';
import { useAssistant } from './useAssistant';
const Tasks = lazy(() => import('./Tasks').then(module => ({ default: module.Tasks })));
import { Reminders } from './Reminders';
import { useReminders } from './useReminders';
import { TaskEditor } from './TaskEditor';
import { Conflict, Dialog, Empty } from './ui';
import { RenderingFallback } from './RenderingFallback';
import { StartupScreen } from './StartupScreen';
import { ModuleLoading } from './ModuleLoading';

declare const __E3_VERSION__: string;
declare const __E3_BUILD__: string;
const Calendar = lazy(() => import('./OriginalCalendar'));
const MailInbox = lazy(() => import('./OriginalInbox'));
const Contacts = lazy(() => import('./Contacts'));
const RecordsPage = lazy(() => import('./RecordsPage'));
import type { RecordTarget } from './RecordsPage';
import type { BrowseTarget } from '../../../packages/domain/search';
import type { RecordOrigin, ContentOutputSource } from '../../../packages/domain/workspace-records';
type Route = ModuleId | 'settings';
const modules: Record<ModuleId, { label: string; icon: AppIcon; color: string }> = {
  home: { label: 'Home', icon: HomeIcon, color: 'gold' }, assistant: { label: 'Assistant', icon: MessageSquare, color: 'violet' }, tasks: { label: 'Tasks', icon: CheckSquare2, color: 'green' }, calendar: { label: 'Calendar', icon: CalendarDays, color: 'sky' }, inbox: { label: 'Inbox', icon: Inbox, color: 'peach' }, contacts: { label: 'Contacts', icon: Users, color: 'violet' }, agents: { label: 'Agents', icon: Bot, color: 'sky' }, content: { label: 'Content', icon: ContentIcon, color: 'peach' }, profile: { label: 'Profile', icon: UserRound, color: 'green' },
};


function AppUpdate({ initial = false }: { initial?: boolean }) {
  const desktop = !!(window as Window & { novaDesktop?: unknown }).novaDesktop;
  return <div className={initial ? undefined : 'connection-banner app-update'} role="status"><span><strong>An app update is ready.</strong> {desktop ? 'Keep your writing, then close this desktop window and open Nova Dream again.' : 'Keep any unsaved writing before reloading. Saved work and retained drafts remain available.'}</span>{!desktop && <button onClick={() => location.reload()}>Reload app</button>}</div>;
}

export function App() {
  const workspace = useWorkspace();
  const [startupComplete, setStartupComplete] = useState(false);
  const [preparation, setPreparation] = useState<number>();
  const [startupError, setStartupError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setStartupComplete(false); setStartupError('');
    if (!workspace.snapshot || workspace.access?.requiresPairing) { setPreparation(undefined); return; }
    let active = true, first = 0, second = 0;
    const snapshot = workspace.snapshot;
    const restricted = !workspace.online || workspace.access?.recoveryLocal || workspace.access?.recovery;
    const parts = { modules: 0, inbox: 0, views: 0, art: 0 };
    const report = () => { if (active) setPreparation(Math.min(99, Math.floor(10 + parts.modules * 15 + parts.inbox * 60 + parts.views * 10 + parts.art * 5))); };
    report();
    if (restricted) { setPreparation(100); setStartupComplete(true); return; }
    void (async () => {
      await preloadModules((done, total) => { parts.modules = total ? done / total : 1; report(); });
      parts.modules = 1; report();
      await Promise.all([
        restricted ? Promise.resolve() : import('./OriginalInbox').then(module => module.prepareInboxStartup(snapshot, progress => { parts.inbox = inboxLoadingPercent(progress) / 100; report(); })),
        restricted ? Promise.resolve() : prepareInitialViews(snapshot).then(() => { parts.views = 1; report(); }),
        import('./nova/lynx-pixel/compositor').then(module => module.loadPixelAssets()).then(() => { parts.art = 1; report(); }),
      ]);
      if (!active) return;
      setPreparation(100);
      first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { if (active) setStartupComplete(true); }); });
    })().catch(() => { if (active) setStartupError('A few things could not get ready. Reconnect and try again.'); });
    return () => { active = false; cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [workspace.snapshot?.epoch, workspace.snapshot?.deviceId, workspace.access?.requiresPairing, attempt]);
  if (workspace.access?.requiresPairing) return <Suspense fallback={<ModuleLoading module="Phone pairing"/>}><PhonePairingScreen paired={workspace.reconnect}/></Suspense>;
  if (!workspace.snapshot && workspace.updateRequired) return <main className="startup"><AppUpdate initial/></main>;
  if (!workspace.snapshot || !startupComplete) return <StartupScreen timingKey={workspace.snapshot ? `nova:startup-timings:v1:${workspace.snapshot.epoch}:${workspace.snapshot.deviceId}` : undefined} rememberTiming={workspace.online && !workspace.access?.recovery && !workspace.access?.recoveryLocal} complete={preparation === 100} preparation={preparation} phase={workspace.startupPhase} download={workspace.download} error={startupError || workspace.error} reconnect={() => { if (workspace.snapshot) setAttempt(value => value + 1); else void workspace.reconnect(); }}/>;
  return <Workspace key={`${workspace.snapshot.epoch}:${workspace.snapshot.deviceId}`} {...workspace} snapshot={workspace.snapshot}/>;
}
function Workspace({ snapshot, online, error, refresh, reconnect, access, updateRequired }: ReturnType<typeof useWorkspace> & { snapshot: Snapshot }) {
  const assistant = useAssistant(snapshot);
  const [voice] = useState(() => new VoiceController(snapshot.deviceId));
  useEffect(() => { const release = () => voice.dispose(); window.addEventListener('pagehide', release); return () => { window.removeEventListener('pagehide', release); release(); }; }, [voice]);
  const [route, setRoute] = useState<Route>('home');
  const [connectionOrigin, setConnectionOrigin] = useState<ModuleId | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [recordTarget, setRecordTarget] = useState<RecordTarget | null>(null);
  const openEmail = async (source: MailContactSource) => { const identity = await calendarWindowIdentity(); keepInboxTarget(snapshot.deviceId, identity.id, { epoch: snapshot.epoch, source: { provider: source.provider, accountId: source.accountId, threadId: source.threadId }, messageId: source.messageId }); open('inbox'); };
  const [sourceRequest, setSourceRequest] = useState<{ target: BrowseTarget; nonce: string } | null>(null);
  const [navMenu, setNavMenu] = useState<ModuleId | null>(null);
  const navigationKey = `e3:navigation-visible:${snapshot.deviceId}`;
  const [navigationVisible, setNavigationVisible] = useState(() => readLocal<boolean>(navigationKey) !== false);
  const toggleNavigation = () => { setNavigationVisible(value => { saveLocal(navigationKey, !value); return !value; }); setNavMenu(null); };
  const [search, setSearch] = useState<string | null>(null);
  const [reminderError, setReminderError] = useState('');
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [showProject, setShowProject] = useState<string>();
  const [previewRequest, setPreviewRequest] = useState<{ id: string; nonce: string } | null>(null);
  const [routineTarget, setRoutineTarget] = useState<{ id: string; nonce: string } | null>(null);
  const [task, setTask] = useState<Entity<Task> | null>(null);
  const taskActions = useTaskActions(snapshot, refresh);
  const [undoLayout, setUndoLayout] = useState<Layout | null>(null);
  const layout = useRetained('layout', 'layout', defaultLayout, snapshot.layout, snapshot, refresh);
  const draft = useRetained('draft', `draft:${snapshot.deviceId}`, emptyDraft, snapshot.drafts.find(d => d.id === `draft:${snapshot.deviceId}`), snapshot, refresh);
  const currentLayout = layout.value;
  const nav = useReorder(currentLayout.nav, order => layout.change(value => ({ ...value, nav: order })), 'navigation');
  const open = (next: Route) => { setRoute(next); setNavMenu(null); if (next !== 'settings') setConnectionOrigin(null); };
  const openSettings = (tab: SettingsTab, origin: ModuleId) => { setSettingsTab(tab); setConnectionOrigin(origin); open('settings'); };
  const openContent = (id: string) => { setRecordTarget({ kind: 'content', id, nonce: crypto.randomUUID() }); open('content'); };
  const openContentSource = (source: ContentOutputSource) => { setSourceRequest({ target: { epoch: snapshot.epoch, conversationId: source.conversationId, nativeId: source.nativeId, messageId: source.messageId, messageHash: source.messageHash, role: 'assistant' }, nonce: crypto.randomUUID() }); open('assistant'); };
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = currentLayout.theme === 'system' ? media.matches ? 'dark' : 'light' : currentLayout.theme; }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [currentLayout.theme]);
  const editTask = (next: Entity<Task>) => { setTask(next); saveLocal(`e3:active-task:${snapshot.deviceId}`, next); };
  const openReminder = (item: WorkspaceReminder) => {
    if ('eventId' in item) void calendarWindowIdentity().then(({id}) => { keepCalendarTarget(snapshot.deviceId, id, item.eventId, item.originalDate); setRemindersOpen(false); open('calendar'); }).catch(error => setReminderError(error instanceof Error ? error.message : 'This event could not be opened.'));
    else { const task = snapshot.tasks.find(task => task.id === item.taskId); if (task) { setRemindersOpen(false); open('tasks'); editTask(task); } }
  };
  const notifications = useReminders(snapshot, online && !access?.recovery && !access?.recoveryLocal, refresh, openReminder);
  const reminderCount = reminderItems(snapshot).filter(r => ['ready', 'missed', 'unavailable'].includes(r.state)).length;
  const newTask = (defaults?: Partial<Task>) => { const kept = readLocal<Entity<Task>>(`e3:active-task:${snapshot.deviceId}`) ?? readLocal<Entity<Task>>(`e3:kept-task:${snapshot.deviceId}`); editTask(!defaults && kept?.revision === 0 ? kept : { id: `task:${crypto.randomUUID()}`, revision: 0, deviceId: snapshot.deviceId, updatedAt: new Date().toISOString(), value: { title: '', notes: '', status: 'open', planned: '', due: '', timezone: snapshot.layout.value.timezone, ...defaults } }); };
  const closeTask = (saved = false) => { if (task && !saved) saveLocal(`e3:kept-task:${snapshot.deviceId}`, task); if (saved) localStorage.removeItem(`e3:kept-task:${snapshot.deviceId}`); localStorage.removeItem(`e3:active-task:${snapshot.deviceId}`); setTask(null); };
  const changeTaskStatus = (item: Entity<Task>, status: Task['status']) => { void taskActions.run([{ task: item, value: { ...item.value, status } }], status === 'done' ? 'Task completed' : 'Task updated'); };
  const complete = (item: Entity<Task>) => changeTaskStatus(item, ['done', 'skipped'].includes(item.value.status) ? 'open' : 'done');
  const needle = search?.trim().toLowerCase() ?? "";
  const taskMatches = snapshot.tasks.filter(item => `${item.value.title} ${item.value.notes}`.toLowerCase().includes(needle));
  const draftMatches = snapshot.drafts.filter(item => `${item.value.title} ${item.value.text}`.toLowerCase().includes(needle));
  const projectMatches = snapshot.projects.filter(item => `${item.value.name} ${item.value.purpose}`.toLowerCase().includes(needle));
  const recordMatches = savedRecordMatches(snapshot, needle);
  const title = route === 'settings' ? 'Settings' : modules[route].label;
  return <div className="app-shell"><nav id="main-navigation" className="primary-rail" aria-label="Main navigation" hidden={!navigationVisible} inert={!navigationVisible}><button className="brand" aria-label="Nova Dream Home" onClick={() => open('home')}><img src="/icons/nova-dream-brand-192-v2.png" alt=""/></button><div className="rail-modules" data-reorder-scroll>{nav.order.map(id => { const item = modules[id]; const Icon = item.icon; return <div key={id} className="nav-item-wrap" data-reorder-group="navigation" data-reorder-item={id}><button className={`nav-item ${item.color} ${route === id ? 'active' : ''} ${nav.dragging === id ? 'dragging' : ''}`} aria-label={item.label} aria-current={route === id ? 'page' : undefined} title={item.label} {...nav.bind(id)} onClick={() => { if (!nav.suppressClick.current) open(id); }} onContextMenu={event => { event.preventDefault(); setNavMenu(id); }} onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); nav.move(id, nav.order.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1)); } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setNavMenu(id); } }}><span className="nav-icon"><Icon size={27}/></span></button></div>; })}</div><div className="rail-footer"><button className={`nav-item neutral ${route === 'settings' ? 'active' : ''}`} aria-label="Settings" title="Settings" aria-current={route === 'settings' ? 'page' : undefined} onClick={() => { setConnectionOrigin(null); open('settings'); }}><span className="nav-icon"><Settings size={26}/></span></button></div></nav>
    {navMenu && <div className="nav-popover popover"><div className="section-heading"><strong>{modules[navMenu].label}</strong><button className="icon-button" aria-label="Close navigation options" onClick={() => setNavMenu(null)}><X size={18}/></button></div><button disabled={nav.order.indexOf(navMenu) === 0} onClick={() => nav.move(navMenu, nav.order.indexOf(navMenu) - 1)}>Move earlier</button><button disabled={nav.order.indexOf(navMenu) === nav.order.length - 1} onClick={() => nav.move(navMenu, nav.order.indexOf(navMenu) + 1)}>Move later</button><button onClick={() => nav.move(navMenu, 0)}>Move to first</button><button onClick={() => nav.move(navMenu, nav.order.length - 1)}>Move to last</button></div>}
    <div className="workspace" data-route={route}><header className="topbar"><div className="topbar-leading"><button className="icon-button navigation-toggle" aria-label={navigationVisible ? "Hide main navigation" : "Show main navigation"} title={navigationVisible ? "Hide main navigation" : "Show main navigation"} aria-expanded={navigationVisible} aria-controls="main-navigation" onClick={toggleNavigation}>{navigationVisible ? <PanelLeft size={20}/> : <Menu size={20}/>}</button><div className="breadcrumb"><span>Nova Dream</span><span className="slash">/</span><strong>{title}</strong></div></div><div className="topbar-actions"><span className="build-tag">v{__E3_VERSION__}</span><button className="icon-button reminder-bell" aria-label={`Reminders${reminderCount ? ` · ${reminderCount} waiting` : ''}`} title="Reminders" onClick={() => setRemindersOpen(true)}><Bell size={20}/>{reminderCount > 0 && <span className="reminder-dot"/>}</button><button className="icon-button" aria-label="Search saved work" title="Search saved work" onClick={() => setSearch('')}><Search size={20}/></button><button className="icon-button" aria-label="Toggle color theme" title="Toggle color theme" onClick={() => layout.change(value => ({ ...value, theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }))}>{document.documentElement.dataset.theme === 'dark' ? <Sun size={20}/> : <Moon size={20}/>}</button></div></header>
      {access?.recoveryLocal && <div className="notice" role="status">Recovered workspace · Local editing is enabled. Accounts, Assistant and routines remain paused until their recovery is verified.</div>}{access?.recovery && <div className="notice" role="status">Recovered workspace · Review only. Changes, notifications and connected services are paused. Your original workspace is separate.</div>}{updateRequired && <AppUpdate/>}{!online && !updateRequired && <div className="connection-banner" role="status"><CloudOff size={18}/><span>{error}</span><button onClick={() => void reconnect()}>Reconnect</button></div>}
      {layout.conflict && <Conflict name="Layout" message={layout.conflict.message} current={layout.conflict.current ? JSON.stringify(layout.conflict.current.value, null, 2) : undefined} reapply={layout.reapply} discard={layout.discard}/>}
      {layout.dirty && !layout.conflict && <div className="layout-status" role="status">{layout.status}<button className="text-button" onClick={() => void layout.flush()}>Retry</button></div>}
      {(taskActions.state.error || taskActions.state.notice || taskActions.state.queue.length > 0) && <div className="connection-banner task-feedback" role={taskActions.state.error ? 'alert' : 'status'}><span>{taskActions.state.error || (taskActions.busy ? 'Saving task changes…' : taskActions.state.queue.length ? 'Task changes are waiting for confirmation.' : taskActions.state.notice)}</span>{taskActions.state.queue.length > 0 && !taskActions.busy && <button onClick={() => void taskActions.retry()}>Retry task changes</button>}{!taskActions.state.queue.length && taskActions.state.undo.length > 0 && <button disabled={taskActions.busy} onClick={() => void taskActions.undo()}>Undo</button>}<button className="icon-button" disabled={taskActions.busy} aria-label="Dismiss task notice" onClick={taskActions.dismiss}><X size={16}/></button></div>}
      {route === 'home' && <Home snapshot={snapshot} layout={currentLayout} saveLayout={layout.change} open={route => { if (route === 'assistant') assistant.select(null, 'chat'); open(route); }} openSettings={tab => openSettings(tab, 'home')} newTask={() => newTask()} editTask={editTask} complete={complete} draft={draft.value} dirty={draft.dirty} draftStatus={draft.status}/>}
      {route === 'assistant' && <Suspense fallback={<ModuleLoading module="Assistant"/>}><Assistant contentActions={{ snapshot, refresh, openContent }} sourceRequest={sourceRequest} controller={assistant} voice={voice} key={previewRequest?.nonce ?? "working"} initialPreview={previewRequest && ![spaceDraftId(snapshot.deviceId, 'chat'), spaceDraftId(snapshot.deviceId, 'work')].includes(previewRequest.id) ? snapshot.drafts.find(item => item.id === previewRequest.id) : undefined} snapshot={snapshot} legacyJournal={draft} refreshWorkspace={refresh} openSettings={() => openSettings('assistant', 'assistant')} newProject={() => setShowProject('new')} editProject={id => setShowProject(id)}/></Suspense>}
      {route === 'calendar' && <RenderingFallback fallback={<main className="page-scroll"><Empty title="Calendar could not load" action={<button onClick={() => location.reload()}>Reload Calendar</button>}>Your saved events and kept writing remain available on this device.</Empty></main>}><Suspense fallback={<ModuleLoading module="Calendar"/>}><Calendar editRoutine={id => { setRoutineTarget({ id, nonce: crypto.randomUUID() }); open('tasks'); }} snapshot={snapshot} online={online} editTask={editTask} openSettings={() => openSettings('accounts', 'calendar')} openInbox={() => open('inbox')} openContent={openContent}/></Suspense></RenderingFallback>}
      {route === 'inbox' && <RenderingFallback fallback={<main className="page-scroll"><Empty title="Inbox could not load" action={<button onClick={() => location.reload()}>Reload Inbox</button>}>Your kept writing remains on this device.</Empty></main>}><Suspense fallback={<ModuleLoading module="Inbox" percent={0}/>}><MailInbox prepare={online && !access?.recoveryLocal && !access?.recovery} refresh={refresh} openContact={id => { setRecordTarget({ kind: 'contact', id, nonce: crypto.randomUUID() }); open('contacts'); }} snapshot={snapshot} openSettings={() => openSettings('accounts', 'inbox')} openCalendar={() => open('calendar')}/></Suspense></RenderingFallback>}
      {route === 'tasks' && <Suspense fallback={<ModuleLoading module="Tasks"/>}><Tasks openCalendar={() => open('calendar')} routineTarget={routineTarget} clearRoutineTarget={() => setRoutineTarget(null)} snapshot={snapshot} newTask={newTask} editTask={editTask} changeStatus={changeTaskStatus} actions={taskActions} refresh={refresh}/></Suspense>}
      {route === 'settings' && <Suspense fallback={<ModuleLoading module="Settings"/>}><SettingsPage selected={settingsTab} select={setSettingsTab} snapshot={snapshot} online={online} access={access} openAssistant={() => open('assistant')} returnTo={connectionOrigin ? { label: modules[connectionOrigin].label, open: () => { open(connectionOrigin); setConnectionOrigin(null); } } : undefined} general={<><section className="card settings-card"><h2>Appearance</h2><div className="setting-row"><div><strong>Color theme</strong><p>Shared with your other connected clients.</p></div><select aria-label="Color theme" value={currentLayout.theme} onChange={event => layout.change(value => ({ ...value, theme: event.target.value as Layout['theme'] }))}><option value="light">Light</option><option value="dark">Dark</option><option value="system">Follow this device</option></select></div><div className="setting-row"><div><strong>Home timezone</strong><p>The date and clock on your Home board.</p></div><select aria-label="Home timezone" value={currentLayout.timezone} onChange={event => layout.change(value => ({ ...value, timezone: event.target.value }))}>{[...new Set([currentLayout.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Dubai', 'Asia/Tokyo'])].map(zone => <option key={zone}>{zone}</option>)}</select></div><details className="settings-details"><summary>Reset layout</summary><div className="setting-row"><div><strong>Home board</strong><p>Restore default widgets, sizes, and visibility. Your tasks and drafts are kept.</p></div><button onClick={() => { setUndoLayout(currentLayout); layout.change(value => ({ ...value, widgets: defaultLayout.widgets, showCompleted: false })); }}>Reset board</button></div><div className="setting-row"><div><strong>Navigation order</strong><p>Settings always stays pinned at the bottom.</p></div><button onClick={() => { setUndoLayout(currentLayout); layout.change(value => ({ ...value, nav: [...moduleIds] })); }}>Reset navigation</button></div></details>{undoLayout && <div className="notice"><span>Previous arrangement is available.</span><button onClick={() => { layout.change(undoLayout); setUndoLayout(null); }}>Undo reset</button></div>}</section><div className="settings-about"><img src="/icons/nova-dream-192-v2.png" width="40" height="40" alt=""/><div><strong>Nova Dream</strong>Version {__E3_VERSION__} · build {__E3_BUILD__}</div></div></>}/></Suspense>}
      {(['contacts', 'content', 'agents', 'profile'] as const).map(page => route === page && <RenderingFallback key={page} fallback={<main className="page-scroll"><Empty title="This module could not load" action={<button onClick={() => location.reload()}>Reload workspace</button>}>Your saved records and kept writing remain available.</Empty></main>}><Suspense fallback={<ModuleLoading module={modules[page].label}/>}>{page === 'contacts' ? <Contacts openSettings={() => openSettings('accounts', 'contacts')} key={`${snapshot.epoch}:${snapshot.deviceId}`} snapshot={snapshot} refresh={refresh} editTask={editTask} target={recordTarget} openEmail={openEmail} openCalendar={() => open('calendar')}/> : <RecordsPage openWork={id=>{assistant.select(id,'work');open('assistant');}} openEmail={openEmail} outputs={assistant.outputs} openContent={openContent} openSource={openContentSource} page={page} snapshot={snapshot} refresh={refresh} editTask={editTask} target={recordTarget}/>}</Suspense></RenderingFallback>)}
      {route !== 'assistant' && <VoicePanel floating controller={voice} openConversation={id => { assistant.select(id); open('assistant'); }}/> }
    </div><span className="sr-only" role="status">{nav.announcement}</span>
    {reminderError && <Dialog title="Open Calendar event" close={() => setReminderError('')}><p role="alert">{reminderError}</p></Dialog>}
    {remindersOpen && <Reminders snapshot={snapshot} notifications={notifications} refresh={refresh} close={() => setRemindersOpen(false)} openReminder={openReminder}/>}
    {task && <TaskEditor key={task.id} task={task} snapshot={snapshot} openTask={next => { closeTask(); editTask(next); }} newTask={defaults => { closeTask(); newTask(defaults); }} openOrigin={(origin: RecordOrigin) => { closeTask(); setRecordTarget({ kind: origin.kind, id: origin.id, nonce: crypto.randomUUID() }); open(origin.kind === 'contact' ? 'contacts' : origin.kind === 'content' ? 'content' : 'agents'); }} close={() => closeTask()} saved={() => { closeTask(true); void refresh(); }}/>}
    {showProject && <Suspense fallback={null}><ProjectEditor key={showProject} space={assistant.space} snapshot={snapshot} projectId={showProject === 'new' ? undefined : showProject} refresh={refresh} close={() => setShowProject(undefined)} saved={() => setShowProject(undefined)}/></Suspense>}
    {search !== null && <Dialog title="Search saved work" close={() => setSearch(null)}><label className="search-input"><Search size={19}/><input autoFocus aria-label="Search query" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search your saved work…"/></label><div className="search-results">{search.trim() ? <>{taskMatches.length + draftMatches.length + projectMatches.length + recordMatches.length === 0 && <Empty title="No saved work matched.">Try a few different words. Device-only changes are not included until saved on the host.</Empty>}{taskMatches.map(item => <button key={item.id} onClick={() => { setSearch(null); open('tasks'); editTask(item); }}><CheckSquare2 size={18}/><span>{item.value.title}<small>Task · {item.value.status}</small></span></button>)}{draftMatches.map(item => <div className="search-result" key={item.id}><MessageSquare size={18}/><span>{item.value.title}<small>{item.deviceId === snapshot.deviceId ? 'Your device draft' : 'Another saved device draft'}</small><p>{item.value.text.slice(0, 220)}</p></span><button onClick={() => { setSearch(null); assistant.select(item.deviceId === snapshot.deviceId ? item.value.conversationId ?? null : null, assistantSpace(item.value)); open('assistant'); setPreviewRequest({ id: item.id, nonce: crypto.randomUUID() }); }}>Open draft</button></div>)}{projectMatches.map(item => <button className="search-result" key={item.id} onClick={() => { setSearch(null); setShowProject(item.id); }}><FileText size={18}/><span>{item.value.name}<small>Project</small><p>{item.value.purpose}</p></span></button>)}{recordMatches.map(item => { const Icon = item.kind === 'contact' ? Users : item.kind === 'content' ? ContentIcon : item.kind === 'profile' ? UserRound : Bot; return <button className="search-result" key={item.id} onClick={() => { setSearch(null); setRecordTarget({ kind: item.kind, id: item.id, nonce: crypto.randomUUID() }); open(item.kind === 'contact' ? 'contacts' : item.kind === 'content' ? 'content' : item.kind === 'profile' ? 'profile' : 'agents'); }}><Icon size={18}/><span>{item.title}<small>{item.label}{item.archived ? ' · Archived' : ''}</small></span></button>; })}</> : <Empty title="Find something you kept.">Search Tasks, Projects, drafts, Contacts, Content, Agents and plans. Conversations have their own search in Assistant; mail search lives in Inbox. Device-only changes appear here once saved on the host.</Empty>}</div></Dialog>}
  </div>;
}
