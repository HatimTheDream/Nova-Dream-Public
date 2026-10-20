import { SavedDraftArticle } from './SavedDraftArticle';
import { captureLayoutReset, undoLayoutReset, type LayoutResetUndo } from './layout-reset';
import { assistantSpace, spaceDraftId } from '../../../packages/domain/assistant-space';
import { useTaskActions } from './useTaskActions';
import { keepInboxTarget } from './inbox-target';
import type { MailContactSource } from '../../../packages/domain/mail-contact';
import { SearchWorkspace, useGlobalSearch } from './SearchWorkspace';
import { matchesSearchReturn, searchReturn, sameSearchTarget, type SearchTarget, type SearchReturn, type SearchQueryRequest, type SearchOrigin } from './search-workspace';
import { admitRecordTarget, recordIndexKey, readRecordIndex } from './record-target-navigation';
import { mayLeaveRecordDrafts } from './record-draft-navigation';
import { mayLeaveAgentDrafts } from './agent-workspace-navigation';
import { readNavigationLocal } from './navigation-storage';
import { admitInboxSearch, type InboxSearchRequest } from './search-query-navigation';
import { admitLibraryTarget, libraryView, libraryViewKey, defaultLibraryView, type LibraryTarget } from './home-library-navigation';
import { reminderItems, type WorkspaceReminder } from './reminder-items';
import { matchingReminderReturn, preparedReminderReturnMatches, readReminderView, reminderSourceNotice, reminderViewKey, retainReminderReturn, type PreparedReminderReturn, type ReminderActionController, type ReminderReturn } from './reminder-workspace';
import { keepCalendarTarget } from './calendar-target';
import { calendarWindowIdentity } from './calendar-window';
import { Suspense, useEffect, useRef, useState } from 'react';
import { lazy, preloadModules } from './preload-lazy';
import { prepareInitialViews } from './prepared-views';
import { inboxLoadingPercent } from './inbox-startup-progress';
import { Bell, Bot, CalendarDays, Check, CheckSquare2, ChevronDown, CircleHelp, CloudOff, ContentIcon, FileText, Home as HomeIcon, Inbox, Menu, MessageSquare, MoreHorizontal, Moon, Plus, Search, Settings, Sun, Users, UserRound, X, type Icon as AppIcon } from './icons';
import { defaultLayout, emptyDraft, moduleIds, type Command, type Entity, type Layout, type ModuleId, type Snapshot, type Task } from '../../../packages/domain/contracts';
import { ApiError, commit, readLocal, saveLocal } from './api';
import { retainedWindowId, useRetained, useWorkspace } from './useWorkspace';
import { useReorder } from './useReorder';
import { NavigationOptions } from './NavigationOptions';
import { BottomNavigation } from './BottomNavigation';
import { NavigationLabels } from './NavigationLabels';
import { mayLeaveAssistantDraft } from './assistant-draft-navigation';
import { mayLeaveHomeDraft } from './home-draft-navigation';
import { mayLeaveSettingsDraft } from './settings-draft-navigation';
import { GeneralSettings, type GeneralSettingsSaveContext } from './GeneralSettings';
import type { SharedGeneralSettings } from './general-settings-state';
import { applyHomeHandoff, homeHandoffProject, prepareWorkHandoff, type HandoffDraftJournal } from './home-assistant-handoff';
import type { HomeAssistantHandoff, HomeReference } from '../../../packages/domain/home-library';
import type { HomeFeedTarget } from '../../../packages/domain/home-feed';
import { homeFeedOpenSchema, type HomeFeedOpenRequest, type HomeDestinationLink } from '../../../packages/domain/home-feed';
import { HomeDestination } from './HomeDestination';
import { dismissFrontendNoticeFromKeyboard, refreshFrontend } from './frontend-update';
const Home = lazy(() => import('./Home').then(module => ({ default: module.Home })));
const ProjectEditor = lazy(() => import('./ProjectEditor').then(module => ({ default: module.ProjectEditor })));
const Assistant = lazy(() => import('./Assistant').then(module => ({ default: module.Assistant })));
import type { SettingsTab, SettingsDraftSummary } from './SettingsPage';
const SettingsPage = lazy(() => import('./SettingsPage').then(module => ({ default: module.SettingsPage })));
const PhonePairingScreen = lazy(() => import('./Phone').then(module => ({ default: module.PhonePairingScreen })));
import { VoiceController } from './voice-controller';
import { VoicePanel } from './VoicePanel';
import { useAssistant } from './useAssistant';
const Tasks = lazy(() => import('./Tasks').then(module => ({ default: module.Tasks })));
import { Reminders } from './Reminders';
import { useReminders } from './useReminders';
import { TaskWorkspace, useTaskWorkspace } from './TaskWorkspace';
import { resumableNewTask } from './task-editor-navigation';
import { Conflict, Dialog, Empty } from './ui';
import { RenderingFallback } from './RenderingFallback';
import { StartupScreen } from './StartupScreen';
import { NovaAppMark, useAppIcon } from './AppIcon';
import { readCachedAppIcon, startupAppIcon, type StartupIconJournal } from './app-icon';

import { ModuleLoading } from './ModuleLoading';

declare const __E3_VERSION__: string;
const Calendar = lazy(() => import('./OriginalCalendar'));
const MailInbox = lazy(() => import('./OriginalInbox'));
const Contacts = lazy(() => import('./Contacts'));
const RecordsPage = lazy(() => import('./RecordsPage'));
import type { RecordTarget } from './RecordsPage';
import { DirectAgentChooser } from './DirectAgentChat';
import { DirectChatNavigation, directChatStorage, mayLeaveDirectChat, type DirectChatTarget } from './direct-agent-chat';
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

function FrontendUpdate({ onLater }: { onLater: () => void }) {
  return <div className="connection-banner app-update" role="status" onKeyDown={event => dismissFrontendNoticeFromKeyboard(event, onLater)}><span><strong>An update is ready.</strong> Refresh when you are ready. Keep any unsaved writing first; saved work and retained drafts remain available.</span><button onClick={onLater} aria-keyshortcuts="Escape">Later</button><button onClick={() => refreshFrontend()}>Refresh</button></div>;
}

export function App() {
  const workspace = useWorkspace();
  const [startupComplete, setStartupComplete] = useState(false);
  const [handoff, setHandoff] = useState<'loading' | 'finishing' | 'leaving'>('loading');
  const [preparation, setPreparation] = useState<number>();
  const [startupError, setStartupError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setStartupComplete(false); setHandoff('loading'); setStartupError('');
    if (!workspace.snapshot || workspace.access?.requiresPairing) { setPreparation(undefined); return; }
    let active = true, first = 0, second = 0;
    const snapshot = workspace.snapshot;
    const restricted = !workspace.online || workspace.access?.recoveryLocal || workspace.access?.recovery;
    const parts = { modules: 0, inbox: 0, views: 0, art: 0 };
    const report = () => { if (active) setPreparation(Math.min(99, Math.floor(10 + parts.modules * 15 + parts.inbox * 60 + parts.views * 10 + parts.art * 5))); };
    report();
    if (restricted) { setPreparation(100); setHandoff('finishing'); return; }
    void (async () => {
      await preloadModules((done, total) => { parts.modules = total ? done / total : 1; report(); });
      parts.modules = 1; report();
      await Promise.all([
        restricted ? Promise.resolve() : import('./OriginalInbox').then(module => module.prepareInboxStartup(snapshot, progress => { parts.inbox = inboxLoadingPercent(progress) / 100; report(); })),
        restricted ? Promise.resolve() : prepareInitialViews(snapshot).then(() => { parts.views = 1; report(); }),
      ]);
      if (!active) return;
      setPreparation(100);
      first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { if (active) setHandoff('finishing'); }); });
    })().catch(() => { if (active) setStartupError('A few things could not get ready. Reload the app to try again. Your saved work and kept writing remain available.'); });
    return () => { active = false; cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [workspace.snapshot?.epoch, workspace.snapshot?.deviceId, workspace.access?.requiresPairing, attempt]);
  // The handoff runs in sequence so the finish is unmissable: the bar eases
  // to 100 and holds long enough to register, then the startup screen
  // crossfades over the mounted workspace instead of vanishing mid-frame.
  // With reduced motion there is no sweep or fade, but the completed bar
  // still holds briefly before the instant swap.
  useEffect(() => {
    if (handoff === 'loading' || startupComplete) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (handoff === 'finishing') {
      const timer = setTimeout(() => {
        if (reduceMotion) setStartupComplete(true);
        else setHandoff('leaving');
      }, reduceMotion ? 500 : 950);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => setStartupComplete(true), 420);
    return () => clearTimeout(timer);
  }, [handoff, startupComplete]);
  if (workspace.access?.requiresPairing) return <Suspense fallback={<ModuleLoading module="Phone pairing"/>}><PhonePairingScreen paired={workspace.reconnect}/></Suspense>;
  if (!workspace.snapshot && workspace.updateRequired) return <main className="startup"><AppUpdate initial/></main>;
  if (!workspace.snapshot || !startupComplete) {
    // Browsers retain failed native imports for this document; a new preparation
    // attempt alone cannot recover a restored module download.
    const screen = <StartupScreen appIcon={startupAppIcon(workspace.snapshot, workspace.snapshot ? readLocal<StartupIconJournal>(`e3:journal:${workspace.snapshot.deviceId}:layout:${retainedWindowId}`) : undefined, readCachedAppIcon())} timingKey={workspace.snapshot ? `nova:startup-timings:v2:${__E3_VERSION__}:${workspace.snapshot.epoch}:${workspace.snapshot.deviceId}` : undefined} rememberTiming={workspace.online && !workspace.access?.recovery && !workspace.access?.recoveryLocal} complete={preparation === 100} preparation={preparation} phase={workspace.startupPhase} download={workspace.download} error={startupError || workspace.error} reconnectLabel={startupError ? 'Reload app' : 'Reconnect'} reconnect={() => { if (startupError) location.reload(); else if (workspace.snapshot) setAttempt(value => value + 1); else void workspace.reconnect(); }} leaving={handoff === 'leaving'}/>;
    if (handoff === 'leaving' && workspace.snapshot) {
      return <div className="startup-handoff">
        <Workspace key={`${workspace.snapshot.epoch}:${workspace.snapshot.deviceId}`} {...workspace} snapshot={workspace.snapshot}/>
        {screen}
      </div>;
    }
    return screen;
  }
  return <Workspace key={`${workspace.snapshot.epoch}:${workspace.snapshot.deviceId}`} {...workspace} snapshot={workspace.snapshot}/>;
}
export function Workspace({ snapshot, online, error, refresh, reconnect, access, updateRequired, frontendUpdate, dismissFrontendUpdate }: ReturnType<typeof useWorkspace> & { snapshot: Snapshot }) {
  const taskWorkspace = useTaskWorkspace(snapshot);
  const search = useGlobalSearch(snapshot);
  const [route, setRoute] = useState<Route>(() => taskWorkspace.state?.active ? taskWorkspace.state.origin.route : search.view?.open ? search.view.origin.route : 'home');
  const assistant = useAssistant(snapshot, route === 'assistant');
  const directScope = { epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId: retainedWindowId };
  const [directNavigation] = useState(() => new DirectChatNavigation(directChatStorage, `e3:direct-chat-view:${snapshot.epoch}:${snapshot.deviceId}:${retainedWindowId}`, directScope));
  const [directTarget, setDirectTarget] = useState<DirectChatTarget | undefined>(() => directNavigation.value);
  const [directError, setDirectError] = useState(directNavigation.error);
  const directCurrent = useRef({ snapshot, route, selectedId: assistant.selectedId, space: assistant.space }); directCurrent.current = { snapshot, route, selectedId: assistant.selectedId, space: assistant.space };
  const directFocus = useRef<HTMLElement | null>(null);
  const [voice] = useState(() => new VoiceController(snapshot.deviceId));
  useEffect(() => { const release = () => voice.dispose(); window.addEventListener('pagehide', release); return () => { window.removeEventListener('pagehide', release); release(); }; }, [voice]);
  const [connectionOrigin, setConnectionOrigin] = useState<ModuleId | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('index');
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraftSummary>();
  const [recordTarget, setRecordTarget] = useState<RecordTarget | null>(null);
  const openEmail = async (source: MailContactSource) => { const identity = await calendarWindowIdentity(); keepInboxTarget(snapshot.deviceId, identity.id, { epoch: snapshot.epoch, source: { provider: source.provider, accountId: source.accountId, threadId: source.threadId }, messageId: source.messageId }); open('inbox'); };
  const [sourceRequest, setSourceRequest] = useState<{ target: BrowseTarget; nonce: string } | null>(null);
  const homeDestinationKey = `e3:home-destination:${snapshot.epoch}:${snapshot.deviceId}:${retainedWindowId}`;
  const [homeDestination, setHomeDestination] = useState<HomeFeedOpenRequest | undefined>(() => {
    const kept = homeFeedOpenSchema.safeParse(readLocal(homeDestinationKey)); return kept.success ? kept.data : undefined;
  });
  const [homeNavigationError, setHomeNavigationError] = useState('');
  const [navMenu, setNavMenu] = useState<ModuleId | null>(null);
  const navMenuTrigger = useRef<HTMLElement | null>(null);
  const navigationKey = `e3:navigation-visible:${snapshot.deviceId}`;
  const [navigationVisible, setNavigationVisible] = useState(() => readLocal<boolean>(navigationKey) ?? !matchMedia('(max-width: 650px)').matches);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const closeNavigation = () => { setNavigationVisible(false); saveLocal(navigationKey, false); setNavMenu(null); navigationToggle.current?.focus(); };
  const toggleNavigation = () => { setNavigationVisible(!navigationVisible); saveLocal(navigationKey, !navigationVisible); setNavMenu(null); navigationToggle.current?.focus(); };
  const [searchQuery, setSearchQuery] = useState<{ destination: 'assistant' | 'inbox'; request: SearchQueryRequest | InboxSearchRequest }>();
  const [searchPreview, setSearchPreview] = useState<{ id: string; nonce: string; epoch: string; revision: number; standalone?: boolean }>();
  const [libraryTarget, setLibraryTarget] = useState<LibraryTarget>();
  const [searchMountedRoutes, setSearchMountedRoutes] = useState<Route[]>([]);
  const searchTrigger = useRef<HTMLButtonElement>(null), searchOriginFocus = useRef<HTMLElement | null>(null);
  const searchActions = useRef<{ open(target: SearchTarget, token: string): void; close(token: string): void; query(destination: 'assistant' | 'inbox', token: string, captured?: string): void; back(reference: SearchReturn): boolean } | undefined>(undefined);
  const searchRouteGeneration = useRef(0);
  useEffect(() => () => { searchActions.current = undefined; }, []);
  const [reminderError, setReminderError] = useState('');
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [reminderActions] = useState(() => new Map<string, ReminderActionController>());
  const reminderNavigation = useRef(0), reminderRetry = useRef<(() => void) | undefined>(undefined), preparedReminderReturn = useRef<PreparedReminderReturn | undefined>(undefined);
  useEffect(() => () => { reminderNavigation.current++; }, []);
  const [showProject, setShowProject] = useState<string>();
  const [previewRequest, setPreviewRequest] = useState<{ id: string; nonce: string } | null>(null);
  const [routineTarget, setRoutineTarget] = useState<{ id: string; nonce: string } | null>(null);
  const taskActions = useTaskActions(snapshot, refresh);
  const [undoLayout, setUndoLayout] = useState<LayoutResetUndo | null>(null);
  const layout = useRetained('layout', 'layout', defaultLayout, snapshot.layout, snapshot, refresh);
  const draft = useRetained('draft', `draft:${snapshot.deviceId}`, emptyDraft, snapshot.drafts.find(d => d.id === `draft:${snapshot.deviceId}`), snapshot, refresh);
  const currentLayout = layout.value;
  const appIcon = useAppIcon(currentLayout.appIcon ?? snapshot.layout.value.appIcon);
  const nav = useReorder(currentLayout.nav, order => layout.change(value => ({ ...value, nav: order })), 'navigation', { motion: true, touchHold: true });
  const dock = useReorder(currentLayout.nav, order => layout.change(value => ({ ...value, nav: order })), 'bottom-navigation', { motion: true, touchHold: true, hold: true, axis: 'horizontal' });
  useEffect(() => { if (nav.dragging) setNavMenu(null); }, [nav.dragging]);
  const canOpen = (next: Route, retry: () => void) => { const allowed = next === route || (mayLeaveAssistantDraft() && mayLeaveDirectChat() && mayLeaveRecordDrafts() && mayLeaveAgentDrafts() && mayLeaveHomeDraft() && (route !== 'settings' || mayLeaveSettingsDraft(retry))); if (!allowed && search.shown) search.setShown(false); return allowed; };
  const applyRoute = (next: Route) => { searchRouteGeneration.current++; search.setShown(false); reminderNavigation.current++; preparedReminderReturn.current = undefined; reminderRetry.current = undefined; setRoute(next); setNavMenu(null); if (next !== 'settings') setConnectionOrigin(null); };
  const open = (next: Route): boolean => { if (search.navigation.view?.open && !mayLeaveRecordDrafts()) { search.setNotice('Keep the current writing before navigating.'); search.setShown(false); return false; } if (!canOpen(next, () => open(next))) return false; applyRoute(next); return true; };
  const openSettings = (tab: SettingsTab = 'index', origin: ModuleId | null = null): boolean => { if (!canOpen('settings', () => openSettings(tab, origin))) return false; applyRoute('settings'); setSettingsTab(tab); setConnectionOrigin(origin); return true; };
  const exactDirect = (token: string) => directCurrent.current.route === 'assistant' && directNavigation.exact(token)
    && directCurrent.current.snapshot.epoch === directScope.epoch && directCurrent.current.snapshot.deviceId === directScope.deviceId
    && (!directNavigation.value?.conversationId || directCurrent.current.selectedId === directNavigation.value.conversationId);
  const retainDirect = () => mayLeaveAssistantDraft() && mayLeaveDirectChat() && mayLeaveRecordDrafts() && mayLeaveAgentDrafts() && mayLeaveHomeDraft();
  const openAgentChat = (agentId: string, revision: number, origin: 'agents' | 'assistant' = 'agents') => {
    if (directCurrent.current.route !== origin) return false;
    const agent = directCurrent.current.snapshot.records?.agent.find(row => row.id === agentId && row.revision === revision && !row.value.archived);
    if (!agent || !canOpen('assistant', () => openAgentChat(agentId, revision, origin))) return false;
    const target: DirectChatTarget = { format: 1, scope: directScope, recipient: { agentId, agentRevision: revision }, token: crypto.randomUUID(), origin,
      previousSelection: { space: directCurrent.current.space, id: directCurrent.current.selectedId } };
    if (!directNavigation.set(target, retainDirect)) { setDirectError(directNavigation.error); return false; }
    directFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDirectError(''); setDirectTarget(target); applyRoute('assistant'); return true;
  };
  const openDirect = (id: string, token: string) => {
    const target = directNavigation.value, conversation = assistant.conversations.find(row => row.id === id);
    if (!target || !exactDirect(token) || conversation?.directAgent?.recipient.agentId !== target.recipient.agentId) return false;
    const view = directNavigation.prepare({ ...target, conversationId: id }, retainDirect, token);
    if (!view || !assistant.selectDirect(id, view)) { setDirectError(directNavigation.error || 'The previous chat selection and writing are kept. Restore browser storage and try opening the saved chat again.'); return false; }
    setDirectTarget(directNavigation.value); setDirectError(''); return true;
  };
  const closeDirect = (token: string) => {
    const target = directNavigation.value;
    if (!target || !exactDirect(token) || !canOpen(target.origin, () => closeDirect(token))) return false;
    if (target.origin === 'assistant') {
      const view = directNavigation.prepare(undefined, retainDirect, token);
      if (!view || !assistant.selectRetained(target.previousSelection.id, target.previousSelection.space, view)) {
        setDirectError(directNavigation.error || 'The original Assistant conversation is unavailable or its selection cannot be kept. This direct chat remains open.'); return false;
      }
    } else if (!directNavigation.set(undefined, retainDirect, token)) { setDirectError(directNavigation.error); return false; }
    setDirectTarget(undefined); setDirectError(''); applyRoute(target.origin);
    requestAnimationFrame(() => { const original = directFocus.current; if (original?.isConnected) original.focus(); else if (target.origin === 'agents') (document.getElementById(`direct-chat-hub-${target.recipient.agentId}`) ?? document.getElementById(`direct-chat-team-${target.recipient.agentId}`))?.focus(); });
    return true;
  };
  const openContent = (id: string) => { setRecordTarget({ kind: 'content', id, nonce: crypto.randomUUID() }); open('content'); };
  const openContentSource = (source: ContentOutputSource) => { setSourceRequest({ target: { epoch: snapshot.epoch, conversationId: source.conversationId, nativeId: source.nativeId, messageId: source.messageId, messageHash: source.messageHash, role: 'assistant' }, nonce: crypto.randomUUID() }); open('assistant'); };
  const keepHomeDestination = (input?: HomeFeedOpenRequest) => {
    if (!saveLocal(homeDestinationKey, input ?? null)) { setHomeNavigationError('Browser storage is full. Free storage before replacing this saved source reference.'); return false; }
    setHomeNavigationError(''); setHomeDestination(input); return true;
  };
  const openHomeResource = (reference: HomeReference) => { keepHomeDestination({ epoch: snapshot.epoch, reference }); };
  const openHomeFeedTarget = (target: HomeFeedTarget) => { keepHomeDestination({ epoch: snapshot.epoch, target }); };
  const openHomeDestinationLink = (link: HomeDestinationLink) => {
    if (!mayLeaveAssistantDraft()) return;
    if (link.kind === 'project') setShowProject(link.id);
    else if (link.kind === 'task') {
      const item = snapshot.tasks.find(task => task.id === link.id);
      if (!item) { setHomeNavigationError('This Task is unavailable. Its source reference is kept.'); return; }
      if (!open('tasks')) return; editTask(item);
    } else if (link.kind === 'conversation') {
      if (!assistant.select(link.id) || !open('assistant')) return; setSourceRequest(null); setPreviewRequest(null);
    } else if (link.kind === 'content') {
      if (!open('content')) return; setRecordTarget({ kind: 'content', id: link.id, nonce: crypto.randomUUID() });
    } else if (link.kind === 'assignment') {
      if (!open('agents')) return; setRecordTarget({ kind: 'assignment', id: link.id, attemptId: link.attemptId, nonce: crypto.randomUUID() });
    } else {
      const indexKey = `e3:agent-routines:${snapshot.deviceId}:${snapshot.epoch}:${retainedWindowId}`;
      const viewKey = `e3:agent-view:${snapshot.deviceId}:${retainedWindowId}`;
      if (!saveLocal(indexKey, { ...(readLocal<Record<string, unknown>>(indexKey) ?? { drafts: [] }), selected: link.id }) || !saveLocal(viewKey, { view: 'routines' })) { setHomeNavigationError('Free browser storage before opening this routine. Its occurrence reference is kept.'); return; }
      if (!open('agents')) return;
    }
    keepHomeDestination(undefined);
  };
  const acceptHomeHandoff = async (incoming: HomeAssistantHandoff) => {
    if (route !== 'home' || !mayLeaveHomeDraft() || !mayLeaveAssistantDraft()) throw new Error('Keep the current Assistant writing before opening this source.');
    const value = homeHandoffProject(incoming, snapshot);
    const handoff = { id: value.handoffId ?? value.sourceCaptureId ?? crypto.randomUUID(), epoch: snapshot.epoch, deviceId: snapshot.deviceId, value };
    if (value.space === 'chat') {
      if (draft.conflict || draft.epoch !== snapshot.epoch) throw new Error('Review the kept Chat draft in Assistant before adding this source.');
      if (!draft.change(current => applyHomeHandoff(current, handoff))) throw new Error('Browser storage is full. Keep this window open and retry; the original source and your writing are kept.');
    } else {
      const id = spaceDraftId(snapshot.deviceId, 'work'), key = `e3:journal:${snapshot.deviceId}:${id}:${retainedWindowId}`;
      const next = prepareWorkHandoff(readLocal<HandoffDraftJournal>(key), snapshot.drafts.find(item => item.id === id), snapshot.draftRemovals?.find(item => item.draftId === id)?.revision ?? 0, handoff);
      if (!saveLocal(key, next)) throw new Error('Browser storage is full. This source has not replaced your Work draft. Free storage and retry.');
    }
    if (!assistant.select(null, value.space) || !open('assistant')) throw new Error('The source context is kept in your Assistant draft. Open Assistant to continue.');
    setPreviewRequest(null); setSourceRequest(null);
  };
  const saveGeneralSettings = async (patch: Partial<SharedGeneralSettings>, expected: GeneralSettingsSaveContext) => {
    if (layout.pending) { await layout.flush(); return false; }
    if (expected.epoch !== snapshot.epoch || layout.epoch !== expected.epoch || layout.conflict || expected.revision !== snapshot.layout.revision || layout.revision !== expected.revision) return false;
    for (const field of Object.keys(patch) as (keyof SharedGeneralSettings)[]) {
      if (snapshot.layout.value[field] !== expected.values[field] || currentLayout[field] !== expected.values[field]) return false;
    }
    if (!layout.change(current => ({ ...current, ...patch }))) return false;
    const result = await layout.flush();
    return !!result && Object.entries(patch).every(([field, value]) => result.value[field as keyof Layout] === value);
  };
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = currentLayout.theme === 'system' ? media.matches ? 'dark' : 'light' : currentLayout.theme; }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [currentLayout.theme]);
  const editTask = (next: Entity<Task>) => mayLeaveHomeDraft() && taskWorkspace.open(next, { route, label: route === 'settings' ? 'Settings' : modules[route].label });
  const reminderScope = { epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId: retainedWindowId };
  const currentReminderView = () => readReminderView(readLocal(reminderViewKey(reminderScope)), reminderScope);
  const prepareReminderReturn = (origin: ReminderReturn, retry: () => void) => {
    preparedReminderReturn.current = undefined; reminderRetry.current = retry;
    if (!canOpen(origin.from, retry)) return false;
    try { preparedReminderReturn.current = retainReminderReturn(origin, reminderScope, reminderNavigation.current, { read: readLocal, write: saveLocal }); return true; }
    catch (error) { setReminderError(error instanceof Error ? error.message : 'Keep this editor open until the return view can be saved.'); return false; }
  };
  const returnToReminders = (origin: ReminderReturn): boolean => {
    if (!preparedReminderReturnMatches(preparedReminderReturn.current, origin, reminderScope, reminderNavigation.current)) { setReminderError('The return changed. Use the original editor’s Back To Reminders action again.'); return false; }
    reminderRetry.current = undefined; setReminderError(''); applyRoute(origin.from); setRemindersOpen(true); return true;
  };
  const openReminder = async (item: WorkspaceReminder, origin?: ReminderReturn): Promise<boolean> => {
    preparedReminderReturn.current = undefined; reminderRetry.current = undefined;
    const token = ++reminderNavigation.current, next = 'eventId' in item ? 'calendar' : 'tasks';
    try {
      const notice = reminderSourceNotice(snapshot, item); if (notice) throw Error(notice);
      if (origin && !matchingReminderReturn(origin, reminderScope, currentReminderView())) throw Error('Keep the Reminders view before opening its original.');
      if (!canOpen(next, () => { void openReminder(item, origin); })) return false;
      if ('eventId' in item) {
        const { id } = await calendarWindowIdentity();
        if (token !== reminderNavigation.current || origin && !matchingReminderReturn(origin, reminderScope, currentReminderView())) return false;
        keepCalendarTarget(snapshot.deviceId, id, item.eventId, item.originalDate, origin);
      } else {
        const task = snapshot.tasks.find(task => task.id === item.taskId);
        if (!task || !taskWorkspace.open(task, origin ? { route: origin.from, label: 'Reminders', reminders: true, reminderReturn: origin } : { route, label: route === 'settings' ? 'Settings' : modules[route].label })) return false;
      }
      applyRoute(next); setReminderError(''); setRemindersOpen(false); return true;
    } catch (error) { setReminderError(error instanceof Error ? error.message : 'This original could not be opened. The reminder is kept.'); return false; }
  };
  const calendarReminderReturn = currentReminderView().original;
  const notifications = useReminders(snapshot, online && !access?.recovery && !access?.recoveryLocal, refresh, openReminder, appIcon);
  const reminderCount = reminderItems(snapshot).filter(r => ['ready', 'missed', 'unavailable'].includes(r.state)).length;
  const newTask = (defaults?: Partial<Task>) => {
    const frame = taskWorkspace.controller.frame, retained = frame && taskWorkspace.controller.resolve(frame.taskId);
    const legacy = readLocal<Entity<Task>>(`e3:active-task:${snapshot.deviceId}`) ?? readLocal<Entity<Task>>(`e3:kept-task:${snapshot.deviceId}`);
    const kept = resumableNewTask(retained, snapshot, { read: readLocal }) ?? resumableNewTask(legacy, snapshot, { read: readLocal });
    editTask(!defaults && kept ? kept : { id: `task:${crypto.randomUUID()}`, revision: 0, deviceId: snapshot.deviceId, updatedAt: new Date().toISOString(), value: { title: '', notes: '', status: 'open', planned: '', due: '', timezone: snapshot.layout.value.timezone, ...defaults } });
  };
  const changeTaskStatus = (item: Entity<Task>, status: Task['status']) => { void taskActions.run([{ task: item, value: { ...item.value, status } }], status === 'done' ? 'Task completed' : 'Task updated'); };
  const complete = (item: Entity<Task>) => changeTaskStatus(item, ['done', 'skipped'].includes(item.value.status) ? 'open' : 'done');
  const searchScope = search.navigation.scope;
  const searchVisible = search.shown && !taskWorkspace.state?.active;
  const renderRoute = (page: Route) => route === page && !searchVisible || !!search.view?.open && searchMountedRoutes.includes(page);
  const coverWithSearch = () => { if (!searchVisible) setSearchMountedRoutes(current => [...new Set([...current, route])]); search.setShown(true); };
  const exactSearch = (token: string) => !!searchActions.current && search.navigation.view?.open && search.navigation.view.token === token;
  const retainSearchOwners = () => {
    if (mayLeaveAssistantDraft() && mayLeaveDirectChat() && mayLeaveRecordDrafts() && mayLeaveAgentDrafts() && mayLeaveHomeDraft()) return true;
    search.setNotice('Your current writing could not be kept yet. Finish any upload or free browser storage before leaving.'); search.setShown(false); return false;
  };
  const beginSearch = () => {
    if (!retainSearchOwners()) return;
    const origin: SearchOrigin = { route, label: route === 'settings' ? 'Settings' : modules[route].label, ...(route === 'settings' ? { settingsTab } : {}) };
    const kind = route === 'contacts' ? 'contact' : route === 'content' ? 'content' : route === 'agents' ? (readLocal<{ view: string }>(`e3:agent-view:${snapshot.deviceId}:${retainedWindowId}`)?.view === 'assignment' ? 'assignment' : 'agent') : undefined;
    if (kind) {
      const raw = readNavigationLocal(recordIndexKey(snapshot.deviceId, kind, retainedWindowId)), index = readRecordIndex(raw);
      if (raw !== undefined && !index) { search.setNotice('The original selection could not be read. Keep this window open; its data is preserved.'); return; }
      origin.record = { kind, selected: index?.selected ?? null, editing: index?.editing };
    }
    if (route === 'home') {
      const raw = readNavigationLocal(libraryViewKey(searchScope)), view = raw === undefined ? defaultLibraryView() : libraryView(raw);
      if (!view) { search.setNotice('The original Library view could not be read. Its data is preserved.'); return; }
      origin.library = view;
    }
    searchOriginFocus.current = document.activeElement as HTMLElement | null;
    if (search.begin(origin)) { searchRouteGeneration.current++; if (!searchVisible) setSearchMountedRoutes(current => [...new Set([...current, route])]); }
  };
  const sourceCurrent = (target: SearchTarget) => search.rows.find(row => sameSearchTarget(row.target, target));
  const selectedSearchTarget = (target: SearchTarget) => !!search.navigation.view?.selected && sameSearchTarget(search.navigation.view.selected, target);
  const searchRoute = (target: SearchTarget): Route => target.kind === 'task' ? 'tasks' : ['draft', 'local-draft'].includes(target.kind) ? 'assistant'
    : target.kind === 'contact' ? 'contacts' : target.kind === 'content' ? 'content' : target.kind === 'profile' ? 'profile'
    : ['agent', 'assignment'].includes(target.kind) ? 'agents' : ['collection', 'note', 'link'].includes(target.kind) ? 'home' : route;
  const openSearchTarget = (target: SearchTarget, token: string) => {
    if (!exactSearch(token) || !selectedSearchTarget(target) || !sourceCurrent(target) || !search.retain() || !retainSearchOwners()) return;
    const next = searchRoute(target), retry = () => searchActions.current?.open(target, token);
    if (!canOpen(next, retry)) { search.setShown(false); return; }
    if (!exactSearch(token) || !selectedSearchTarget(target) || !sourceCurrent(target)) { search.setNotice('This source changed while you were navigating. Review it in Search.'); return; }
    if (target.kind === 'task') {
      const task = snapshot.tasks.find(item => item.id === target.id && item.revision === target.revision);
      if (!task || !taskWorkspace.open(task, { route: search.navigation.view!.origin.route, label: 'Search', searchReturn: searchReturn(search.navigation.view!) })) { search.setNotice('The Task could not open. Your Search and original editor are kept.'); return; }
    } else if (['contact', 'content', 'agent', 'assignment', 'profile'].includes(target.kind)) {
      const request: RecordTarget = { kind: target.kind as RecordTarget['kind'], id: target.id, nonce: crypto.randomUUID(), admitted: { ...searchScope, revision: target.revision } };
      const problem = admitRecordTarget(snapshot, retainedWindowId, request, { read: readNavigationLocal, write: saveLocal });
      if (problem) { search.setNotice(problem); return; } setRecordTarget(request);
    } else if (['collection', 'note', 'link'].includes(target.kind)) {
      if (!search.library || search.libraryStatus !== 'ready') { search.setNotice('Refresh Library before opening this exact source.'); return; }
      const request: LibraryTarget = { ...searchScope, nonce: crypto.randomUUID(), target };
      const problem = admitLibraryTarget(searchScope, search.library, request, { read: readNavigationLocal, write: saveLocal });
      if (problem) { search.setNotice(problem); return; } setLibraryTarget(request);
    } else if (target.kind === 'project') setShowProject(target.id);
    else if (target.kind === 'draft') setSearchPreview({ id: target.id, revision: target.revision, nonce: crypto.randomUUID(), epoch: snapshot.epoch, standalone: !searchMountedRoutes.includes('assistant') });
    else if (target.kind === 'local-draft' && route !== 'assistant' && !searchMountedRoutes.includes('assistant')) { search.setNotice('That current Assistant editor is no longer open. Its original journal remains kept.'); return; }
    applyRoute(next); search.setNotice('');
  };
  const prepareSearchReturn = (reference: SearchReturn, retry: () => void) => {
    if (!matchesSearchReturn(search.navigation.view, reference, searchScope) || !retainSearchOwners()) return false;
    const origin = search.navigation.view!.origin.route;
    if (!canOpen(origin, retry)) { search.setShown(false); return false; }
    const kept = search.navigation.prepareReturn(reference); search.changed(); return kept;
  };
  const returnSearch = (reference: SearchReturn) => {
    if (!prepareSearchReturn(reference, () => searchActions.current?.back(reference))) return false;
    coverWithSearch(); search.setNotice(''); return true;
  };
  const closeSearch = (token: string) => {
    if (!exactSearch(token) || !retainSearchOwners()) return;
    const origin = search.navigation.view!.origin;
    if (!canOpen(origin.route, () => searchActions.current?.close(token))) { search.setShown(false); return; }
    if (!exactSearch(token)) return;
    let preparedRecord: RecordTarget | undefined, preparedLibrary: LibraryTarget | undefined;
    if (origin.record) {
      const request: RecordTarget = { kind: origin.record.kind, id: origin.record.selected ?? '', nonce: crypto.randomUUID(), admitted: { ...searchScope, revision: 0, restore: origin.record } };
      const problem = admitRecordTarget(snapshot, retainedWindowId, request, { read: readNavigationLocal, write: saveLocal });
      if (problem) { search.setNotice(problem); return; } preparedRecord = request;
    }
    if (origin.library) {
      const request: LibraryTarget = { ...searchScope, nonce: crypto.randomUUID(), restore: origin.library };
      const problem = admitLibraryTarget(searchScope, search.library ?? { epoch: snapshot.epoch, items: [], collections: [] } as NonNullable<typeof search.library>, request, { read: readNavigationLocal, write: saveLocal });
      if (problem) { search.setNotice(problem); return; } preparedLibrary = request;
    }
    if (!search.close()) return;
    if (preparedRecord) setRecordTarget(preparedRecord);
    setLibraryTarget(preparedLibrary);
    setSearchMountedRoutes([]); applyRoute(origin.route); if (origin.settingsTab) setSettingsTab(origin.settingsTab as SettingsTab);
    requestAnimationFrame(() => (searchOriginFocus.current?.isConnected && searchOriginFocus.current.getClientRects().length ? searchOriginFocus.current : searchTrigger.current)?.focus());
  };
  const queryFromSearch = async (destination: 'assistant' | 'inbox', token: string, captured = search.navigation.view?.query) => {
    if (captured !== search.navigation.view?.query) return;
    if (!exactSearch(token) || !search.retain() || !retainSearchOwners()) return;
    const retry = () => searchActions.current?.query(destination, token, captured);
    if (!canOpen(destination, retry)) { search.setShown(false); return; }
    const generation = searchRouteGeneration.current;
    const identity = destination === 'inbox' ? await calendarWindowIdentity() : undefined;
    if (!exactSearch(token) || generation !== searchRouteGeneration.current || captured !== search.navigation.view?.query || !retainSearchOwners() || !canOpen(destination, retry)) return;
    const query: SearchQueryRequest | InboxSearchRequest = { ...searchReturn(search.navigation.view!), nonce: crypto.randomUUID(), query: captured!, ...(identity ? { inboxWindowId: identity.id } : {}) };
    if (!saveLocal(`e3:search-query:${snapshot.epoch}:${snapshot.deviceId}:${retainedWindowId}:${destination}`, query)) { search.setNotice('The query could not be kept. Your current account and writing remain open.'); return; }
    if (identity) { const problem = admitInboxSearch(searchScope, query as InboxSearchRequest, { read: readNavigationLocal, write: saveLocal }); if (problem) { search.setNotice(problem); return; } }
    setSearchQuery({ destination, request: query }); if (destination === 'assistant') setSearchPreview(undefined); applyRoute(destination);
  };
  searchActions.current = { open: openSearchTarget, close: closeSearch, query: queryFromSearch, back: returnSearch };
  const latestBeginSearch = useRef(beginSearch); latestBeginSearch.current = beginSearch;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k'
        || document.querySelector('dialog[open], [role="menu"]') || (event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault(); latestBeginSearch.current();
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const savedSearchDraft = searchPreview?.epoch === snapshot.epoch ? snapshot.drafts.find(item => item.id === searchPreview.id && item.revision === searchPreview.revision && !snapshot.draftRemovals?.some(row => row.draftId === item.id && row.revision >= item.revision)) : undefined;
  const title = searchVisible ? 'Search' : route === 'settings' ? 'Settings' : modules[route].label;
  return <div className={`app-shell${taskWorkspace.state?.active ? ' task-details-open' : ''}`}><header className="topbar"><div className="topbar-leading"><button className="brand" aria-label="Nova Dream Home" onClick={() => open('home')}><NovaAppMark choice={appIcon}/></button><button ref={navigationToggle} className="icon-button navigation-toggle" aria-label={navigationVisible ? "Hide main navigation" : "Show main navigation"} title={navigationVisible ? "Hide main navigation" : "Show main navigation"} aria-expanded={navigationVisible} aria-controls="main-navigation" onClick={toggleNavigation}><Menu size={20}/></button><div className="breadcrumb"><strong>{title}</strong></div></div><div className="topbar-actions"><button className="icon-button reminder-bell" aria-label={`Reminders${reminderCount ? ` · ${reminderCount} waiting` : ''}`} title="Reminders" onClick={() => setRemindersOpen(true)}><Bell size={20}/>{reminderCount > 0 && <span className="reminder-dot"/>}</button><button ref={searchTrigger} className={`icon-button${searchVisible ? ' active' : ''}`} aria-label="Search saved work" aria-pressed={searchVisible} title="Search saved work (Ctrl or Command K)" onClick={beginSearch}><Search size={20}/></button><button className="icon-button" aria-label="Toggle color theme" title="Toggle color theme" onClick={() => layout.change(value => ({ ...value, theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }))}>{document.documentElement.dataset.theme === 'dark' ? <Sun size={20}/> : <Moon size={20}/>}</button></div></header>
    <NavigationLabels placement="right" suspended={Boolean(nav.dragging)}><nav id="main-navigation" className="primary-rail" onKeyDown={event => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && !navMenu) { event.preventDefault(); closeNavigation(); }
    }} data-reorder-host aria-label="Main navigation" hidden={!navigationVisible}><div className="rail-modules" ref={nav.containerRef} data-reorder-scroll>{nav.order.map(id => { const item = modules[id]; const Icon = item.icon; return <div key={id} className="nav-item-wrap" data-reorder-group="navigation" data-reorder-item={id}><button className={`nav-item ${item.color} ${!searchVisible && route === id ? 'active' : ''} ${nav.dragging === id ? 'dragging' : ''}`} aria-label={item.label} aria-description="Hold or drag to move. Alt and Up or Down also changes position." aria-current={!searchVisible && route === id ? 'page' : undefined} data-navigation-label={item.label} {...nav.bind(id)} onClick={() => { if (!nav.suppressClick.current) open(id); }} onContextMenu={event => { event.preventDefault(); if (!nav.dragging && !nav.suppressClick.current) { navMenuTrigger.current = event.currentTarget; setNavMenu(id); } }} onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); nav.move(id, nav.order.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1)); } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); navMenuTrigger.current = event.currentTarget; setNavMenu(id); } }}><span className="nav-icon"><Icon size="var(--app-module-glyph-size)"/></span></button></div>; })}</div><div className="rail-footer"><button className={`nav-item neutral ${!searchVisible && route === 'settings' ? 'active' : ''}`} aria-label="Settings" aria-description={snapshot.softwareUpdate ? "Software update available" : undefined} data-navigation-label={snapshot.softwareUpdate ? "Settings Â· update available" : "Settings"} aria-current={!searchVisible && route === 'settings' ? 'page' : undefined} onClick={() => openSettings()}><span className="nav-icon"><Settings size="var(--app-module-glyph-size)"/>{snapshot.softwareUpdate && <span className="settings-update-dot" aria-hidden="true"/>}</span></button></div>{navMenu && <NavigationOptions key={navMenu} label={modules[navMenu].label} index={nav.order.indexOf(navMenu)} count={nav.order.length} move={index => nav.move(navMenu, index)} close={() => setNavMenu(null)} trigger={navMenuTrigger.current}/>}</nav></NavigationLabels>
    <div className="workspace" data-route={searchVisible ? 'search' : route}>
      {!searchVisible && search.view?.open && !taskWorkspace.state?.active && <div className="global-search-return"><span>Search is kept</span><button onClick={() => returnSearch(searchReturn(search.view!))}>Back To Search</button></div>}
      {!searchVisible && (search.notice || search.error) && <div className="notice warning" role="alert">{search.notice || search.error}</div>}
      {access?.recoveryLocal && <div className="notice" role="status">Recovered workspace Â· Local editing is enabled. Accounts, Assistant and routines remain paused until their recovery is verified.</div>}{access?.recovery && <div className="notice" role="status">Recovered workspace Â· Review only. Changes, notifications and connected services are paused. Your original workspace is separate.</div>}{updateRequired ? <AppUpdate/> : frontendUpdate && <FrontendUpdate onLater={dismissFrontendUpdate}/>}{!online && !updateRequired && <div className="connection-banner" role="status"><CloudOff size={18}/><span>{error}</span><button onClick={() => void reconnect()}>Reconnect</button></div>}
      {layout.conflict && <Conflict name="Layout" message={layout.conflict.message} current={layout.conflict.current ? JSON.stringify(layout.conflict.current.value, null, 2) : undefined} reapply={layout.reapply} discard={layout.discard}/>}
      {layout.dirty && !layout.conflict && <div className="layout-status" role="status">{layout.status}<button className="text-button" onClick={() => void layout.flush()}>Retry</button></div>}
      {(taskActions.state.error || taskActions.state.notice || taskActions.state.queue.length > 0) && <div className="connection-banner task-feedback" role={taskActions.state.error ? 'alert' : 'status'}><span>{taskActions.state.error || (taskActions.busy ? 'Saving task changes...' : taskActions.state.queue.length ? 'Task changes are waiting for confirmation.' : taskActions.state.notice)}</span>{taskActions.state.queue.length > 0 && !taskActions.busy && <button onClick={() => void taskActions.retry()}>Retry task changes</button>}{!taskActions.state.queue.length && taskActions.state.undo.length > 0 && <button disabled={taskActions.busy} onClick={() => void taskActions.undo()}>Undo</button>}<button className="icon-button" disabled={taskActions.busy} aria-label="Dismiss task notice" onClick={taskActions.dismiss}><X size={16}/></button></div>}
      {renderRoute('home') && <div className="global-search-origin" hidden={searchVisible || route !== 'home'}><RenderingFallback fallback={<main className="page-scroll"><Empty title="Home could not load" action={<button onClick={() => location.reload()}>Reload Home</button>}>Your kept writing and original saves remain on this device.</Empty></main>}><Suspense fallback={<ModuleLoading module="Home"/>}><Home taskActions={taskActions} libraryTarget={libraryTarget} clearLibraryTarget={() => setLibraryTarget(undefined)} onAssistantHandoff={acceptHomeHandoff} openResource={openHomeResource} openFeedTarget={openHomeFeedTarget} snapshot={snapshot} layout={currentLayout} saveLayout={layout.change} open={route => { if (!mayLeaveAssistantDraft()) return; if (route === 'assistant') { setPreviewRequest(null); assistant.select(null, 'chat'); } open(route); }} openSettings={tab => openSettings(tab, 'home')} operations={assistant.operations} conversations={assistant.conversations} activityRead={assistant.statusRead} openConversation={conversation => { if (!mayLeaveAssistantDraft()) return; setPreviewRequest(null); assistant.select(conversation.id, assistantSpace(conversation)); open('assistant'); }} openDraft={id => { const item = snapshot.drafts.find(draft => draft.id === id); if (!item || !mayLeaveAssistantDraft()) return; assistant.select(item.deviceId === snapshot.deviceId ? item.value.conversationId ?? null : null, assistantSpace(item.value)); if (open('assistant')) setPreviewRequest({ id: item.id, nonce: crypto.randomUUID() }); }} newTask={newTask} editTask={editTask} complete={complete} draft={draft.value} dirty={draft.dirty} draftStatus={draft.status}/></Suspense></RenderingFallback></div>}
      {directError && <div className="notice" role="alert">{directError}<button onClick={() => setDirectError('')}>Dismiss</button></div>}
      {route === 'assistant' && directTarget && !directTarget.conversationId && <DirectAgentChooser key={directTarget.token} target={directTarget} snapshot={snapshot} controller={assistant} current={() => exactDirect(directTarget.token)} open={conversation => openDirect(conversation.id, directTarget.token)} close={() => { closeDirect(directTarget.token); }}/>}
      {renderRoute('assistant') && <div className="global-search-origin" hidden={searchVisible || route !== 'assistant'}><Suspense fallback={<ModuleLoading module="Assistant"/>}>{searchPreview?.standalone ? <main className="page-scroll search-saved-draft" aria-label="Saved Assistant Draft">{savedSearchDraft ? <SavedDraftArticle draft={savedSearchDraft}/> : <Empty title="This saved draft changed or is unavailable.">Its exact Search reference is kept.</Empty>}<p className="metadata">This is the host-saved original. Opening the Assistant workspace keeps its current conversation and draft separately.</p><button onClick={() => { if (retainSearchOwners()) setSearchPreview(undefined); }}>Open Assistant Workspace</button></main> : <Assistant openAgentChat={(id, revision) => openAgentChat(id, revision, 'assistant')} directBack={directTarget?.conversationId === assistant.selectedId ? () => closeDirect(directTarget.token) : undefined} onSearchDraft={search.publishDraft} searchPreview={searchPreview} searchRequest={searchQuery?.destination === 'assistant' ? searchQuery.request : undefined} onOpenApp={destination => destination.module === 'settings' ? openSettings(destination.settingsTab ?? 'index') : open(destination.module)} appIcon={appIcon} contentActions={{ snapshot, refresh, openContent }} sourceRequest={sourceRequest} controller={assistant} voice={voice} key={previewRequest?.nonce ?? "working"} initialPreview={previewRequest && ![spaceDraftId(snapshot.deviceId, 'chat'), spaceDraftId(snapshot.deviceId, 'work')].includes(previewRequest.id) ? snapshot.drafts.find(item => item.id === previewRequest.id) : undefined} snapshot={snapshot} legacyJournal={draft} refreshWorkspace={refresh} openSettings={() => openSettings('assistant', 'assistant')} newProject={() => setShowProject('new')} editProject={id => setShowProject(id)}/>}</Suspense></div>}
      {renderRoute('calendar') && <div className="global-search-origin" hidden={searchVisible || route !== 'calendar'}><RenderingFallback fallback={<main className="page-scroll"><Empty title="Calendar could not load" action={<button onClick={() => location.reload()}>Reload Calendar</button>}>Your saved events and kept writing remain available on this device.</Empty></main>}><Suspense fallback={<ModuleLoading module="Calendar"/>}><Calendar reminderReturn={calendarReminderReturn?.kind === 'calendar' ? calendarReminderReturn : undefined} canReturnToReminders={prepareReminderReturn} returnToReminders={returnToReminders} refresh={refresh} editRoutine={id => { setRoutineTarget({ id, nonce: crypto.randomUUID() }); open('tasks'); }} snapshot={snapshot} online={online} editTask={editTask} openSettings={() => openSettings('accounts', 'calendar')} openInbox={() => open('inbox')} openContent={openContent}/></Suspense></RenderingFallback></div>}
      {renderRoute('inbox') && <div className="global-search-origin" hidden={searchVisible || route !== 'inbox'}><RenderingFallback fallback={<main className="page-scroll"><Empty title="Inbox could not load" action={<button onClick={() => location.reload()}>Reload Inbox</button>}>Your kept writing remains on this device.</Empty></main>}><Suspense fallback={<ModuleLoading module="Inbox" percent={0}/>}><MailInbox searchRequest={searchQuery?.destination === 'inbox' ? searchQuery.request as InboxSearchRequest : undefined} prepare={online && !access?.recoveryLocal && !access?.recovery} refresh={refresh} openContact={id => { setRecordTarget({ kind: 'contact', id, nonce: crypto.randomUUID() }); open('contacts'); }} snapshot={snapshot} openSettings={() => openSettings('accounts', 'inbox')} openCalendar={() => open('calendar')}/></Suspense></RenderingFallback></div>}
      {renderRoute('tasks') && <div className="global-search-origin" hidden={searchVisible || route !== 'tasks'}><Suspense fallback={<ModuleLoading module="Tasks"/>}><Tasks openCalendar={() => open('calendar')} routineTarget={routineTarget} clearRoutineTarget={() => setRoutineTarget(null)} snapshot={snapshot} newTask={newTask} editTask={editTask} changeStatus={changeTaskStatus} actions={taskActions} refresh={refresh}/></Suspense></div>}
      {renderRoute('settings') && <div className="global-search-origin" hidden={searchVisible || route !== 'settings'}><Suspense fallback={<ModuleLoading module="Settings"/>}><SettingsPage key={`${snapshot.epoch}:${snapshot.deviceId}`} appIcon={appIcon} selected={settingsTab} select={setSettingsTab} draft={settingsDraft} snapshot={snapshot} online={online} access={access} openAssistant={() => open('assistant')} returnTo={connectionOrigin ? { label: modules[connectionOrigin].label, open: () => { open(connectionOrigin); } } : undefined} general={<>{layout.pending && <div className="notice warning" role="status"><span>The original layout save is awaiting confirmation.</span><button disabled={layout.saving} onClick={() => void layout.flush()}>Reconcile Save</button></div>}<GeneralSettings reveal={() => setSettingsTab('general')} onDraftState={setSettingsDraft} currentLayout={currentLayout} appIcon={appIcon} snapshot={snapshot} online={online} pending={layout.saving || !!layout.pending} status={layout.status} error={layout.conflict?.message} saveShared={saveGeneralSettings} resetNavigation={() => { setUndoLayout(captureLayoutReset(currentLayout, 'navigation')); layout.change(value => ({ ...value, nav: [...moduleIds] })); }} hasUndoReset={!!undoLayout} undoReset={() => { if (!undoLayout) return; layout.change(value => undoLayoutReset(value, undoLayout)); setUndoLayout(null); }}/></>}/></Suspense></div>}
      {(['contacts', 'content', 'agents', 'profile'] as const).map(page => renderRoute(page) && <div key={page} className="global-search-origin" hidden={searchVisible || route !== page}><RenderingFallback fallback={<main className="page-scroll"><Empty title="This module could not load" action={<button onClick={() => location.reload()}>Reload workspace</button>}>Your saved records and kept writing remain available.</Empty></main>}><Suspense fallback={<ModuleLoading module={modules[page].label}/>}>{page === 'contacts' ? <Contacts openSettings={() => openSettings('accounts', 'contacts')} key={`${snapshot.epoch}:${snapshot.deviceId}`} snapshot={snapshot} refresh={refresh} editTask={editTask} target={recordTarget} openEmail={openEmail} openCalendar={() => open('calendar')}/> : <RecordsPage openAgentChat={(id, revision) => openAgentChat(id, revision)} openAssistantSettings={() => openSettings('assistant', page)} openWork={id=>{assistant.select(id,'work');open('assistant');}} openEmail={openEmail} outputs={assistant.outputs} openContent={openContent} openSource={openContentSource} page={page} snapshot={snapshot} refresh={refresh} editTask={editTask} target={recordTarget}/>}</Suspense></RenderingFallback></div>)}
      {!searchVisible && route !== 'assistant' && <VoicePanel appIcon={appIcon} floating controller={voice} openConversation={id => { assistant.select(id); open('assistant'); }}/> }
      {searchVisible && <SearchWorkspace search={search} snapshot={snapshot} open={target => openSearchTarget(target, search.view!.token)} close={() => closeSearch(search.view!.token)} queryIn={destination => queryFromSearch(destination, search.view!.token)}/>}
    </div><BottomNavigation reorder={dock} items={currentLayout.nav.map(id => ({ id, label: modules[id].label, icon: modules[id].icon }))} route={searchVisible ? null : route} open={next => next === 'settings' ? openSettings() : open(next)} updateAvailable={!!snapshot.softwareUpdate} returnToWideNavigation={() => { const selected = document.querySelector<HTMLButtonElement>('#main-navigation:not([hidden]) button[aria-current="page"]'); (selected ?? navigationToggle.current)?.focus(); }}/><span className="sr-only" role="status">{nav.announcement}</span><span className="sr-only" role="status">{dock.announcement}</span>
    {homeNavigationError && !homeDestination && <Dialog title="Open Saved Source" close={() => setHomeNavigationError('')}><p role="alert">{homeNavigationError}</p></Dialog>}
    {homeDestination && <HomeDestination input={homeDestination} navigationError={homeNavigationError} discuss={acceptHomeHandoff} close={() => { keepHomeDestination(undefined); }} open={openHomeDestinationLink}/>}
    {reminderError && <Dialog title="Reminder Original" close={() => { reminderRetry.current = undefined; setReminderError(''); }}><p role="alert">{reminderError}</p>{reminderRetry.current && <button onClick={() => reminderRetry.current?.()}>Back To Reminders</button>}</Dialog>}
    {remindersOpen && <Reminders snapshot={snapshot} notifications={notifications} refresh={refresh} close={() => setRemindersOpen(false)} openReminder={openReminder} originRoute={route} actions={reminderActions}/>}
    <TaskWorkspace workspace={taskWorkspace} snapshot={snapshot} refresh={refresh}
      canClose={(origin, retry) => origin.searchReturn ? prepareSearchReturn(origin.searchReturn, retry) : !origin.reminderReturn || prepareReminderReturn(origin.reminderReturn, retry)}
      closed={origin => { if (origin.searchReturn) { if (matchesSearchReturn(search.navigation.view, origin.searchReturn, searchScope)) coverWithSearch(); } else if (origin.reminderReturn) returnToReminders(origin.reminderReturn); else if (open(origin.route) && origin.reminders) setRemindersOpen(true); }}
      openOrigin={(origin: RecordOrigin) => { setRecordTarget({ kind: origin.kind, id: origin.id, nonce: crypto.randomUUID() }); open(origin.kind === 'contact' ? 'contacts' : origin.kind === 'content' ? 'content' : 'agents'); }}/>

    {showProject && <Suspense fallback={null}><ProjectEditor key={showProject} space={assistant.space} snapshot={snapshot} projectId={showProject === 'new' ? undefined : showProject} refresh={refresh} close={() => setShowProject(undefined)} saved={() => setShowProject(undefined)}/></Suspense>}

  </div>;
}
