import { LoadingRing } from './ModuleLoading';
import type { MailContactSource } from '../../../packages/domain/mail-contact';
import type { AssistantOutput } from '../../../packages/domain/assistant';
import { ContentOutputLibrary } from './ContentOutputs';
import { Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { lazy } from './preload-lazy';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { blankRecord, contentStages, recordTitle, type Content, type Assignment, type RecordKind, type RecordValue, type ContentOutputSource } from '../../../packages/domain/workspace-records';
import { readLocal, saveLocal } from './api';
import { Plus, Search, X, Filter, Help, ViewBoard, ViewList, CalendarDays } from './icons';
import { Empty, Dialog } from './ui';
import { ComposerMenu } from './ComposerMenu';
import { RecordEditor } from './RecordEditor';
import { SquareLynx } from './nova/square-lynx/SquareLynx';
import { retainedWindowId } from './useWorkspace';
import { RecordDraftRecovery } from './RecordDraftRecovery';
import { currentRecordDraftTitle, readRecordJournal } from './record-draft-recovery';
import { admittedRecordIndex, readRecordIndex, type AdmittedRecordTarget } from './record-target-navigation';
import './records.css';
import { readNavigationLocal } from './navigation-storage';
import { mayLeaveRecordDrafts } from './record-draft-navigation';
import { agentDraftScope, agentLocalSlot, keepAgentSelection, mayLeaveAgentDrafts, nextAgentSelection, readAgentSelection, registerAgentDraftNavigation, type AgentSelectionRead, type AgentView, type AgentDestination } from './agent-workspace-navigation';
import { AgentWorkControls, AgentsWorkspaceNavigation } from './AgentsWorkspaceControls';
import { AgentRoutines } from './AgentRoutines';
import { ContentPlanning } from './ContentPlanning';
import { dayInZone } from '../../../packages/domain/tasks';
const ContentEditor = lazy(() => import('./ContentEditor'));
const ContentLibrary = lazy(() => import('./ContentLibrary').then(m=>({default:m.ContentLibrary})));
const ProfilePage = lazy(() => import('./ProfilePage'));
const AgentHub = lazy(() => import('./AgentHub'));
const AgentSkills = lazy(() => import('./AgentSkills'));

type Page = 'contacts' | 'content' | 'agents' | 'profile';
export type RecordTarget = { kind: RecordKind; id: string; nonce: string; attemptId?: string; admitted?: AdmittedRecordTarget };
const headings: Record<Page, { title: string; eyebrow: string; detail: string; kind: RecordKind }> = {
  contacts: { title: 'People, kept close.', eyebrow: 'Contacts', detail: 'Keep the context. Follow through on what matters.', kind: 'contact' },
  content: { title: 'Room for your next idea.', eyebrow: 'Content', detail: 'Shape a brief, keep your drafts, and move the work forward.', kind: 'content' },
  agents: { title: 'Build your team.', eyebrow: 'Agents', detail: 'Give every agent a clear identity, purpose, and set of limits.', kind: 'agent' },
  profile: { title: 'Make it yours.', eyebrow: 'Profile', detail: 'Your identity and the progress you have earned.', kind: 'profile' },
};
type SourceActions = { openAssistantSettings?: () => void; openWork?: (conversationId: string) => void; openEmail?: (source: MailContactSource) => Promise<void>; outputs: AssistantOutput[]; openContent: (id: string) => void; openSource: (source: ContentOutputSource) => void };
type LocalIndex = { selected: string | null; drafts: string[]; seenTarget?: string; attempt?: { id: string; epoch: string } };
type RecordPreferences = { query: string; archived: boolean; project: string; stage: string; view: 'list' | 'board' | 'calendar'; showFilters: boolean; collection: string; tag: string };
const assignmentPreferencesValue = (value: unknown): value is Partial<RecordPreferences> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value).every(([key, item]) => ['query', 'project', 'stage', 'collection', 'tag'].includes(key) ? typeof item === 'string' : ['archived', 'showFilters'].includes(key) ? typeof item === 'boolean' : key === 'view' && ['list', 'board', 'calendar'].includes(item));

export default function RecordsPage({ page, snapshot, refresh, editTask, target, outputs, openContent, openSource, openEmail, openWork, openAssistantSettings }: SourceActions & { page: Page; snapshot: Snapshot; refresh: () => Promise<void>; editTask: (task: Entity<Task>) => void; target?: RecordTarget | null }) {
  const scrollRef = useRef<HTMLElement>(null);
  const scrollKey = `e3:record-scroll:${snapshot.deviceId}:${page}:${retainedWindowId}`;
  useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = readLocal<number>(scrollKey) ?? 0; }, [scrollKey]);
  const agentViewKey = `e3:agent-view:${snapshot.deviceId}:${retainedWindowId}`;
  const scope = agentDraftScope(snapshot.epoch, snapshot.deviceId, retainedWindowId);
  const alive = useRef(true), currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const storage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
  const [viewRead, setViewRead] = useState<AgentSelectionRead>(() => readAgentSelection(storage, agentViewKey));
  const viewRef = useRef(viewRead); viewRef.current = viewRead;
  const agentSelection = viewRead.ok ? viewRead.value : { view: 'agent' as const };
  const [navigationError, setNavigationError] = useState('');
  const agentIndexKey = `e3:record-index:${snapshot.deviceId}:agent:${retainedWindowId}`;
  const [agentIndex, setAgentIndex] = useState<LocalIndex>(() => readRecordIndex(readNavigationLocal(agentIndexKey)) ?? { drafts: [], selected: null });
  const [dismissedTarget, setDismissedTarget] = useState<string>();
  const pendingNavigation = useRef<(() => boolean) | undefined>(undefined);
  const [hasPendingNavigation, setHasPendingNavigation] = useState(false);
  useEffect(() => registerAgentDraftNavigation(scope, () => !pendingNavigation.current), [scope]);
  const admittedView = target?.admitted && ['agent', 'assignment'].includes(target.kind) && admittedRecordIndex(snapshot, retainedWindowId, target, { read: readLocal });
  const agentView = admittedView && target!.nonce !== dismissedTarget && !target!.admitted!.restore ? target!.kind as 'agent' | 'assignment' : agentSelection.view;
  const canNavigate = () => alive.current && currentScope.current === scope && mayLeaveRecordDrafts() && mayLeaveAgentDrafts(scope);
  const readIndex = (kind: 'agent' | 'assignment' | 'routines', selected?: string) => {
    const key = kind === 'routines' ? `e3:agent-routines:${snapshot.deviceId}:${snapshot.epoch}:${retainedWindowId}` : `e3:record-index:${snapshot.deviceId}:${kind}:${retainedWindowId}`;
    try {
      const raw = localStorage.getItem(key), value = raw === null ? { selected: null, drafts: [] } : readRecordIndex(JSON.parse(raw));
      if (!value || value.seenTarget !== undefined && typeof value.seenTarget !== 'string' || value.attempt !== undefined && (!value.attempt || typeof value.attempt.id !== 'string' || typeof value.attempt.epoch !== 'string')) throw Error('Invalid kept selection');
      const id = selected ?? value.selected;
      if (kind !== 'routines' && id) {
        const journal = localStorage.getItem(`e3:journal:${snapshot.deviceId}:${id}:${retainedWindowId}`);
        if (journal !== null) { const parsed = readRecordJournal(journal, kind, id); if (!parsed || parsed.epoch !== snapshot.epoch) throw Error('Invalid kept writing'); }
      }
      return { key, raw, value };
    } catch { setNavigationError('The kept selection or writing could not be read. Its original browser data is preserved.'); return; }
  };
  const setAgentView = (destination: AgentView | AgentDestination, seenTarget?: string) => {
    if (!canNavigate() || pendingNavigation.current) { setNavigationError('Keep the current writing before changing Agents views.'); return false; }
    const original = viewRef.current; if (!original.ok) { setNavigationError(original.error); return false; }
    const next = nextAgentSelection(original.value, destination);
    if (seenTarget !== undefined) next.target = seenTarget;
    if ((next.view === 'agent' || next.view === 'assignment' || next.view === 'routines') && !readIndex(next.view)) return false;
    const saved = keepAgentSelection(storage, agentViewKey, original, next, canNavigate);
    if (!saved.ok) { setNavigationError(saved.error); return false; }
    viewRef.current = saved; setViewRead(saved); setDismissedTarget(target?.nonce); setNavigationError(''); return true;
  };
  const navigateIndex = (destination: 'agent' | 'hub' | 'assignment' | 'routines', kept: NonNullable<ReturnType<typeof readIndex>>, next: LocalIndex, journal?: { key: string; value: unknown }, seenTarget?: string) => {
    if (pendingNavigation.current) { setNavigationError('Retry opening the original kept writing before starting another selection.'); return false; }
    if (!canNavigate()) { setNavigationError('Keep the current writing before opening another item.'); return false; }
    const view = viewRef.current;
    if (!view.ok) { setNavigationError(view.error); return false; }
    try { if (localStorage.getItem(agentViewKey) !== view.raw) throw Error('Changed view'); }
    catch { setNavigationError('The original Agents view could not be confirmed. Its selection and writing are preserved.'); return false; }
    const steps = [...(journal ? [{ key: journal.key, before: null as string | null, after: JSON.stringify(journal.value), written: false }] : []), { key: kept.key, before: kept.raw, after: JSON.stringify(next), written: false }];
    const run = () => {
      // The retry owns these exact identities only. It never creates another ID,
      // changes a journal payload or invokes a command.
      if (!alive.current || currentScope.current !== scope || !mayLeaveRecordDrafts()) return false;
      const held = pendingNavigation.current; pendingNavigation.current = undefined;
      const ownersKept = mayLeaveAgentDrafts(scope); pendingNavigation.current = held;
      if (!ownersKept) { setNavigationError('Keep the current writing before opening the retained selection.'); return false; }
      try {
        for (const step of steps) {
          const raw = localStorage.getItem(step.key);
          if (raw !== (step.written ? step.after : step.before)) throw Error('The retained selection changed.');
          if (!step.written) { localStorage.setItem(step.key, step.after); step.written = true; }
        }
      } catch { setNavigationError('The original writing and selection are kept. Retry opening that same item when browser storage is available.'); return false; }
      pendingNavigation.current = undefined;
      const changed = setAgentView(destination, seenTarget);
      if (!changed) { pendingNavigation.current = run; return false; }
      if (destination === 'agent' || destination === 'hub') setAgentIndex(next);
      setHasPendingNavigation(false); return true;
    };
    pendingNavigation.current = run; setHasPendingNavigation(true); return run();
  };
  const keepAgentIndex = (next: LocalIndex) => {
    if (!canNavigate()) { setNavigationError('Keep the current Agent writing before closing or changing it.'); return false; }
    const kept = readIndex('agent', next.selected ?? undefined); if (!kept) return false;
    return navigateIndex(agentView === 'hub' ? 'hub' : 'agent', kept, next);
  };
  const openDesign = (id?: string) => {
    if (pendingNavigation.current) { setNavigationError('Retry opening the original kept item first.'); return; }
    const kept = readIndex('agent', id); if (!kept) return;
    const selected = id ?? `agent:${crypto.randomUUID()}`;
    navigateIndex(agentView === 'hub' ? 'hub' : 'agent', kept, { ...kept.value, selected, drafts: id ? kept.value.drafts : [...kept.value.drafts, selected] });
  };
  const closeDesign = () => keepAgentIndex({ ...agentIndex, selected: null });
  const openRecord = (kind: 'agent' | 'assignment', id: string, attemptId?: string, seenTarget?: string) => {
    const kept = readIndex(kind, id); if (!kept) return false;
    return navigateIndex(kind, kept, { ...kept.value, selected: id, attempt: attemptId ? { id: attemptId, epoch: snapshot.epoch } : undefined, seenTarget: target?.nonce }, undefined, seenTarget);
  };
  const openPlan = (id: string, attemptId?: string) => openRecord('assignment', id, attemptId);
  const assignWork = (agentId: string) => {
    if (pendingNavigation.current) { setNavigationError('Retry opening the original kept item first.'); return; }
    const agent = snapshot.records?.agent.find(record => record.id === agentId && !record.value.archived); if (!agent) { setNavigationError('Choose a current agent before assigning work.'); return; }
    const kept = readIndex('assignment'); if (!kept || !canNavigate()) return;
    const id = `assignment:${crypto.randomUUID()}`;
    const value = { ...blankRecord('assignment', snapshot.layout.value.timezone), agentId, agentRevision: agent.revision, title: `Assignment for ${agent.value.name}` };
    navigateIndex('assignment', kept, { ...kept.value, selected: id, drafts: [...kept.value.drafts, id], attempt: undefined, seenTarget: target?.nonce }, { key: `e3:journal:${snapshot.deviceId}:${id}:${retainedWindowId}`, value: { value, revision: 0, epoch: snapshot.epoch, dirty: true } });
  };
  const openRoutine = (id: string) => { const kept = readIndex('routines'); if (kept) navigateIndex('routines', kept, { ...kept.value, selected: id }); };
  const continueFromAgent = (next: () => void) => { if (!canNavigate()) { setNavigationError('Keep the current Agents writing before opening its linked work.'); return; } next(); };
  const agentTask = (task: Entity<Task>) => continueFromAgent(() => editTask(task));
  const agentContent = (id: string) => continueFromAgent(() => openContent(id));
  const agentSource = (source: ContentOutputSource) => continueFromAgent(() => openSource(source));
  useEffect(() => {
    if (page !== 'agents' || !target || !['agent', 'assignment'].includes(target.kind)) return;
    if (target.admitted) {
      const kept = admittedRecordIndex(snapshot, retainedWindowId, target, { read: readLocal });
      if (kept && target.kind === 'agent') setAgentIndex(kept);
      return;
    }
    if (target.nonce === agentSelection.target) return;
    openRecord(target.kind as 'agent' | 'assignment', target.id, target.attemptId, target.nonce);
  }, [target?.nonce, page]);
  const heading = headings[page]; const kind = page === 'agents' ? agentView : heading.kind;
  return <main ref={scrollRef} onScroll={event => saveLocal(scrollKey, event.currentTarget.scrollTop)} className={`page-scroll records-page records-page-${page}${page === 'agents' && ['agent', 'hub'].includes(kind) ? ' records-hub' : ''}`}>
    {page !== 'agents' && page !== 'content' && <div className="page-intro"><h1>{heading.eyebrow}</h1><ComposerMenu label={`About ${heading.eyebrow}`} icon={<Help size={20}/>} placement="below" align="right">{() => <p>{heading.detail}</p>}</ComposerMenu></div>}
    {page === 'agents' && <><AgentsWorkspaceNavigation view={agentView} choose={setAgentView}/>{!viewRead.ok && <p className="field-error" role="alert">{viewRead.error}</p>}{kind === 'routines' || kind === 'skills' ? <h1 className="sr-only">{kind === 'routines' ? 'Routines' : 'Skills'}</h1> : null}</>}
    {navigationError && <p role="alert" className="field-error">{navigationError}</p>}{hasPendingNavigation && <button className="compact-action" onClick={() => pendingNavigation.current?.()}>Retry Opening Kept Writing</button>}
    {kind === 'skills' ? <Suspense fallback={<LoadingRing label="Opening skills…"/>}><AgentSkills key={scope} snapshot={snapshot}/></Suspense> : page === 'agents' && (kind === 'hub' || kind === 'agent') ? <Suspense fallback={<LoadingRing label="Opening your team…"/>}><AgentHub openSettings={openAssistantSettings ? () => continueFromAgent(openAssistantSettings) : undefined} key={scope} snapshot={snapshot} openWork={openWork ? id => continueFromAgent(() => openWork(id)) : undefined} presentation={kind === 'hub' ? 'hub' : 'team'} setPresentation={view => setAgentView(view === 'hub' ? 'hub' : 'agent')} openAgent={openDesign} assignWork={assignWork} openPlan={openPlan} openRoutine={openRoutine} openContent={agentContent} editTask={agentTask} manage={setAgentView} unfinished={agentIndex.drafts.filter(id => !snapshot.records?.agent.some(a => a.id === id))}/></Suspense> : kind === 'routines' ? <AgentRoutines key={scope} snapshot={snapshot} openPlan={openPlan}/> : kind === 'profile' ? <Suspense fallback={<LoadingRing label="Opening Profile…"/>}><ProfilePage key={`${snapshot.deviceId}:${snapshot.epoch}`} snapshot={snapshot} refresh={refresh} editTask={editTask}/></Suspense> : <RecordCollection key={page === 'agents' ? `${scope}:${kind}` : `${snapshot.deviceId}:${snapshot.epoch}:${kind}`} kind={kind as RecordKind} snapshot={snapshot} refresh={refresh} editTask={page === 'agents' ? agentTask : editTask} target={target} outputs={outputs} openContent={page === 'agents' ? agentContent : openContent} openSource={page === 'agents' ? agentSource : openSource} openEmail={openEmail} openAssistantSettings={openAssistantSettings}/>}
    {page === 'agents' && agentIndex.selected && <Dialog title={snapshot.records?.agent.some(a => a.id === agentIndex.selected) ? 'Agent settings' : 'Create agent'} close={closeDesign}><RecordEditor kind="agent" id={agentIndex.selected} key={`${scope}:${agentIndex.selected}`} entity={snapshot.records?.agent.find(a => a.id === agentIndex.selected)} snapshot={snapshot} refresh={refresh} editTask={agentTask} onSaved={closeDesign} removeDraft={() => keepAgentIndex({ selected: null, drafts: agentIndex.drafts.filter(id => id !== agentIndex.selected) })}/></Dialog>}
  </main>;
}
function RecordCollection({ kind, snapshot, refresh, editTask, target, outputs, openContent, openSource, openEmail, openWork, openAssistantSettings }: SourceActions & { kind: RecordKind; snapshot: Snapshot; refresh: () => Promise<void>; editTask: (task: Entity<Task>) => void; target?: RecordTarget | null }) {
  const key = `e3:record-index:${snapshot.deviceId}:${kind}:${retainedWindowId}`;
  const [originalAssignmentIndex] = useState(() => kind === 'assignment' ? readNavigationLocal(key) : undefined);
  const assignmentIndexReadable = kind !== 'assignment' || originalAssignmentIndex === undefined || !!readRecordIndex(originalAssignmentIndex);
  const [index, setIndex] = useState<LocalIndex>(() => kind === 'assignment' ? readRecordIndex(originalAssignmentIndex) ?? { selected: null, drafts: [] } : readLocal(key) ?? { selected: null, drafts: [] });
  const [library, setLibrary] = useState(false), [catalog, setCatalog] = useState<'templates' | 'brands' | null>(null), [creating, setCreating] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false), searchId = useId();
  const searchTrigger = useRef<HTMLButtonElement>(null), searchField = useRef<HTMLInputElement>(null);
  const closeSearch = () => { setSearchOpen(false); searchTrigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (searchOpen) searchField.current?.focus(); }, [searchOpen]);
  const [error, setError] = useState(''), [viewRetentionError, setViewRetentionError] = useState('');
  const defaultPreferences: RecordPreferences = { collection: '', tag: '', query: '', archived: false, project: '', stage: '', showFilters: false, view: kind === 'content' && window.innerWidth > 700 ? 'board' : 'list' };
  const [assignmentPreferences] = useState(() => kind === 'assignment' ? agentLocalSlot({ getItem: value => localStorage.getItem(value), setItem: (name, value) => localStorage.setItem(name, value) }, key + ':view', assignmentPreferencesValue, defaultPreferences) : undefined);
  const [preferences, setPreferences] = useState<RecordPreferences>(() => ({ ...defaultPreferences, ...(assignmentPreferences?.initial ?? readLocal(key + ':view') ?? {}) }));
  const { query, archived, project, stage, view, showFilters } = preferences;
  // A disclosure can update more than one preference before React renders again.
  // Keep the latest merged value without putting persistence inside a state updater.
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const keepAssignmentPreferences = () => { const saved = !assignmentPreferences || assignmentPreferences.keep(preferencesRef.current); setViewRetentionError(saved ? '' : 'Your assignment search and filters are kept in this window. Retry keeping them before leaving.'); return saved; };
  useEffect(() => assignmentPreferences ? registerAgentDraftNavigation(agentDraftScope(snapshot.epoch, snapshot.deviceId, retainedWindowId), keepAssignmentPreferences) : undefined, [key]);
  const prefer = (patch: Partial<typeof preferences>) => { const next = { ...preferencesRef.current, ...patch }; preferencesRef.current = next; setPreferences(next); if (assignmentPreferences) keepAssignmentPreferences(); else if (!saveLocal(key + ':view', next)) setError('This view is kept in the current window only. Browser storage is full.'); };
  const setQuery = (query: string) => prefer({ query }), setArchived = (archived: boolean) => prefer({ archived }), setProject = (project: string) => prefer({ project }), setStage = (stage: string) => prefer({ stage });
  const [publicationRequest, setPublicationRequest] = useState<{ id: string; nonce: string }>();
  const [needsFocus, setNeedsFocus] = useState(false), editorArea = useRef<HTMLDivElement>(null), listArea = useRef<HTMLElement>(null), opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { if (needsFocus && editorArea.current) { editorArea.current.focus(); editorArea.current.scrollIntoView({ block: 'start' }); setNeedsFocus(false); } }, [needsFocus, index.selected]);
  const records = (snapshot.records?.[kind] ?? []) as Entity<RecordValue>[];
  const [recovering, setRecovering] = useState(false);
  const recoveryScope = { kind: 'content' as const, deviceId: snapshot.deviceId, windowId: retainedWindowId, epoch: snapshot.epoch, records: snapshot.records?.content ?? [] };
  const openRecovered = (id: string) => {
    if (index.selected || kind !== 'content') return false;
    const next = { ...index, selected: id, attempt: undefined, drafts: records.some(item => item.id === id) ? index.drafts : [...new Set([...index.drafts, id])] };
    if (!saveLocal(key, next)) return false;
    opener.current = null; setPublicationRequest(undefined); setIndex(next); setNeedsFocus(true); return true;
  };
  const keep = (next: LocalIndex) => { if (kind === 'assignment' && (!assignmentIndexReadable || !mayLeaveRecordDrafts())) { setError('Keep the current assignment writing before changing the selection. Unreadable original data is preserved.'); return false; } if (!saveLocal(key, next)) { setError('Free browser storage before navigating. Your current selection and writing are kept.'); return false; } setIndex(next); return true; };
  const openRecord = (id: string, element?: HTMLElement, publication = false) => { if (kind === 'assignment') { if (!keep({ ...index, selected: id, attempt: undefined })) return; opener.current = element ?? null; setNeedsFocus(true); return; } opener.current = element ?? null; setPublicationRequest(publication ? { id, nonce: crypto.randomUUID() } : undefined); keep({ ...index, selected: id, attempt: undefined }); setNeedsFocus(true); };
  const closeRecord = () => { const id = index.selected; if (kind === 'assignment') { if (!keep({ ...index, selected: null, attempt: undefined })) return; } else keep({ ...index, selected: null, attempt: undefined }); setPublicationRequest(undefined); const card = Array.from(listArea.current?.querySelectorAll<HTMLElement>('[data-content-id]') ?? []).find(node => node.dataset.contentId === id)?.querySelector<HTMLButtonElement>('button'); requestAnimationFrame(()=>(opener.current?.isConnected ? opener.current : card ?? listArea.current)?.focus()); };
  useEffect(() => {
    if (target?.kind !== kind || target.nonce === index.seenTarget) return;
    if (target.admitted) {
      const kept = admittedRecordIndex(snapshot, retainedWindowId, target, { read: readLocal });
      if (!kept) { setError('The exact source selection could not be confirmed. Return to Search.'); return; }
      setIndex(kept);
    } else if (!keep({ ...index, selected: target.id, seenTarget: target.nonce, attempt: kind === 'assignment' && target.attemptId ? { id: target.attemptId, epoch: snapshot.epoch } : undefined })) return;
    opener.current = null; setPublicationRequest(undefined); setNeedsFocus(true);
  }, [target?.nonce, kind]);
  const create = (seed?: Partial<Content>) => {
    if (kind === 'assignment' && (!assignmentIndexReadable || !mayLeaveRecordDrafts())) { setError('Keep the current assignment writing before starting another brief. Original kept data is preserved.'); return; }
    const id = `${kind}:${crypto.randomUUID()}`, next = { selected: id, drafts: [...index.drafts, id] };
    if (kind === 'content') {
      const zone = snapshot.layout.value.timezone, value = { ...blankRecord('content', zone), projectId: project || null, stage: contentStages.includes(stage as Content['stage']) ? stage : 'ideas', ...seed, ...((seed?.stage ?? stage) === 'published' ? { publication: { kind: 'manual', date: dayInZone(zone), note: '' } } : {}) };
      if (!saveLocal(`e3:journal:${snapshot.deviceId}:${id}:${retainedWindowId}`, { value, revision: 0, epoch: snapshot.epoch, dirty: true })) { setError('Free browser storage before opening this Content draft.'); return; }
    }
    if (!saveLocal(key, next)) { setError('Free browser storage before starting another record. Your current writing is kept.'); return; }
    if (kind === 'content' && archived) prefer({ archived: false });
    opener.current = null; setPublicationRequest(undefined); setIndex(next); setNeedsFocus(true);
  };
  const selected = records.find(r => r.id === index.selected);
  const activeDrafts = index.drafts.filter(id => !records.some(r => r.id === id));
  const filtered = records.filter(r => ('archived' in r.value && r.value.archived) === archived && (!project || 'projectId' in r.value && r.value.projectId === project) && (!stage || 'stage' in r.value && r.value.stage === stage) && (kind!=='content'||(!preferences.collection||(r.value as Content).collection===preferences.collection)&&(!preferences.tag||(r.value as Content).tags?.includes(preferences.tag))) && JSON.stringify(r.value).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selectedMissing = index.selected && !selected && !activeDrafts.includes(index.selected);
  const activeFilters = [archived, project, stage, preferences.collection, preferences.tag].filter(Boolean).length;
  const scopeTitle = stage ? stage[0].toUpperCase() + stage.slice(1) : archived ? 'Archived Content' : 'All Content';
  const filterSummary = [archived && 'Archived', project && (snapshot.projects.find(p => p.id === project)?.value.name ?? 'Project unavailable'), stage && scopeTitle, preferences.collection, preferences.tag && `#${preferences.tag}`].filter(Boolean).join(' · ');
  const viewIcon = (option: typeof view) => option === 'board' ? <ViewBoard size={16}/> : option === 'calendar' ? <CalendarDays size={16}/> : <ViewList size={16}/>;
  const viewLabel = (option: typeof view) => option[0].toUpperCase() + option.slice(1);
  return <>{kind === 'content' ? index.selected ? <h1 className="sr-only">Content Editor</h1> : <div className="content-workspace-controls">
    <header className="content-workspace-heading"><div className="content-workspace-title"><h1>{scopeTitle}</h1><span className="metadata">{filtered.length} saved{activeDrafts.length > 0 ? ` · ${activeDrafts.length} device drafts` : ''}</span></div>
      <div className="compact-actions content-workspace-actions">
        <ComposerMenu label={`Filter Content${activeFilters ? `: ${activeFilters} Active` : ''}`} text={activeFilters ? `Filter · ${activeFilters}` : 'Filter'} icon={<Filter size={16}/>} placement="below" align="right" className="content-controls-menu">
          {close => <div className="content-filter-panel"><h2 className="sr-only">Filter Content</h2>
            <label>Stage<select value={stage} onChange={e => setStage(e.target.value)}><option value="">All Stages</option>{contentStages.map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select></label>
            <label>Show<select value={archived ? 'archived' : 'active'} onChange={e => setArchived(e.target.value === 'archived')}><option value="active">Active Content</option><option value="archived">Archived Content</option></select></label>
            <label>Project<select value={project} onChange={e => setProject(e.target.value)}><option value="">All Projects</option>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.value.name}</option>)}</select></label>
            <label>Collection<select value={preferences.collection} onChange={e => prefer({ collection: e.target.value })}><option value="">All Collections</option>{[...new Set((snapshot.records?.content ?? []).map(c => c.value.collection).filter(Boolean))].sort().map(c => <option key={c}>{c}</option>)}</select></label>
            <label>Tag<select value={preferences.tag} onChange={e => prefer({ tag: e.target.value })}><option value="">All Tags</option>{[...new Set((snapshot.records?.content ?? []).flatMap(c => c.value.tags ?? []))].sort().map(t => <option key={t}>{t}</option>)}</select></label>
            <div className="compact-actions"><button className="compact-action" disabled={!activeFilters} onClick={() => prefer({ archived: false, project: '', stage: '', collection: '', tag: '' })}>Reset Filters</button><button className="compact-action primary" onClick={close}>Done</button></div>
          </div>}
        </ComposerMenu>
        <button ref={searchTrigger} className="compact-action compact-utility compact-icon" aria-label="Search Content" title="Search Content" aria-expanded={searchOpen} aria-controls={searchOpen ? searchId : undefined} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}><Search size={16}/></button>
        <button className="compact-action compact-utility compact-icon primary" aria-label="New Content" title="New Content" aria-haspopup="dialog" onClick={() => setCreating(true)}><Plus size={18}/></button>
      </div>
    </header>
    <div className="content-workspace-navigation"><nav className="content-local-navigation" aria-label="Content Library"><span aria-current="page">Workspace</span><button className="compact-action compact-utility" aria-haspopup="dialog" onClick={() => setRecovering(true)}>Recover Writing</button><button className="compact-action compact-utility" aria-haspopup="dialog" onClick={() => setCatalog('templates')}>Templates</button><button className="compact-action compact-utility" aria-haspopup="dialog" onClick={() => setCatalog('brands')}>Brands</button></nav>
      <nav className="content-desktop-views compact-actions" aria-label="Content Views">{(['board', 'list', 'calendar'] as const).map(option => <button className="compact-action compact-utility" key={option} aria-pressed={view === option} onClick={() => prefer({ view: option })}>{viewIcon(option)}{viewLabel(option)}</button>)}</nav>
      <div className="content-phone-view"><ComposerMenu label={`Content View: ${viewLabel(view)}`} text={viewLabel(view)} icon={viewIcon(view)} placement="below" align="right" kind="menu" className="content-controls-menu">{close => <div className="compact-choice-menu">{(['board', 'list', 'calendar'] as const).map(option => <button className="compact-action" key={option} role="menuitemradio" aria-checked={view === option} onClick={() => { prefer({ view: option }); close(); }}>{viewIcon(option)}{viewLabel(option)}</button>)}</div>}</ComposerMenu></div>
    </div>
    {filterSummary && <p className="metadata content-active-filters">{filterSummary}</p>}
    {searchOpen ? <div className="content-search-disclosure" id={searchId} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(); } }}><label className="search-input"><Search size={16}/><input ref={searchField} type="search" aria-label="Search Content Records" placeholder="Search Content…" value={query} onChange={e => setQuery(e.target.value)}/></label><button className="compact-action compact-utility compact-icon" aria-label="Close Content Search" title="Close Content Search" onClick={closeSearch}><X size={16}/></button></div> : query && <div className="content-active-search"><button className="compact-action compact-utility" onClick={() => setSearchOpen(true)}>Search: <span className="preserve-case">{query}</span></button><button className="compact-action compact-utility" aria-label="Clear Content Search" onClick={() => { setQuery(''); closeSearch(); }}>Clear</button></div>}
  </div> : kind === 'assignment' ? <AgentWorkControls savedCount={filtered.length} draftCount={activeDrafts.length} query={query} changeQuery={setQuery} assign={() => create()} filterCount={[archived, project].filter(Boolean).length} filterSummary={[archived && 'Archived Briefs', project && (snapshot.projects.find(p => p.id === project)?.value.name ?? 'Project unavailable')].filter(Boolean).join(' · ')} filters={close => <div className="agents-assignment-filters"><label>Show<select value={archived ? 'archived' : 'active'} onChange={event => setArchived(event.target.value === 'archived')}><option value="active">Active Briefs</option><option value="archived">Archived Briefs</option></select></label><label>Project<select value={project} onChange={event => setProject(event.target.value)}><option value="">All Projects</option>{snapshot.projects.map(item => <option value={item.id} key={item.id}>{item.value.name}</option>)}</select></label><div className="compact-actions"><button className="compact-action" disabled={!archived && !project} onClick={() => prefer({ archived: false, project: '' })}>Reset Filters</button><button className="compact-action primary" onClick={close}>Done</button></div></div>}/> : <>
    <div className="record-toolbar"><label className="search-input"><Search size={18}/><input aria-label={`Search ${kind} records`} placeholder="Search records…" value={query} onChange={e => setQuery(e.target.value)}/></label><button className="primary" onClick={() => create()}><Plus size={18}/>New {kind === 'agent' ? 'Agent' : kind === 'profile' ? 'Profile' : 'Contact'}</button><button className="record-filter-toggle icon-button" aria-label={`Filters${[archived, project, stage].filter(Boolean).length ? ` · ${[archived, project, stage].filter(Boolean).length} active` : ''}`} title="Filters" aria-expanded={showFilters} aria-controls={`${kind}-record-filters`} onClick={() => prefer({ showFilters: !showFilters })}><Filter size={18}/>{!![archived, project, stage].filter(Boolean).length && <span className="filter-dot"/>}</button></div>
    <div id={`${kind}-record-filters`} className="record-filters" hidden={!showFilters}><label>Show<select value={archived ? 'archived' : 'active'} onChange={e => setArchived(e.target.value === 'archived')}><option value="active">Active records</option><option value="archived">Archived records</option></select></label>{['contact', 'assignment'].includes(kind) && <label>Project filter<select value={project} onChange={e => setProject(e.target.value)}><option value="">All Projects</option>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.value.name}</option>)}</select></label>}<span className="metadata">{filtered.length} saved · {activeDrafts.length} device drafts</span></div>
    {!showFilters && <p className="metadata content-filter-summary">{filtered.length} saved · {activeDrafts.length} device drafts{archived ? ' · Archived' : ''}{project ? ` · ${snapshot.projects.find(p => p.id === project)?.value.name ?? 'Project unavailable'}` : ''}{stage ? ` · ${stage}` : ''}{preferences.collection?` · ${preferences.collection}`:''}{preferences.tag?` · #${preferences.tag}`:''}</p>}
    </>}{viewRetentionError && <div className="notice" role="alert"><span>{viewRetentionError}</span><button className="compact-action" onClick={keepAssignmentPreferences}>Retry Keeping View</button></div>}{assignmentPreferences?.error && <p className="field-error" role="alert">{assignmentPreferences.error}</p>}{!assignmentIndexReadable && <p className="field-error" role="alert">The kept assignment selection could not be read. Its original browser data is preserved.</p>}{error && <p className="field-error" role="alert">{error}</p>}
    {recovering && kind === 'content' && <RecordDraftRecovery scope={recoveryScope} canOpen={!index.selected} open={openRecovered} close={() => setRecovering(false)}/>}
    {creating && <Dialog title="Start Something New" size="choice" close={() => setCreating(false)}><div className="compact-actions content-start-options"><button className="compact-action primary" onClick={() => { setCreating(false); create(); }}>Blank Draft</button><button className="compact-action" onClick={() => { setCreating(false); setCatalog('templates'); }}>Start With A Template</button><button className="compact-action" onClick={() => { setCreating(false); setLibrary(true); }}>Use Saved Agent Result</button></div></Dialog>}
    {catalog&&<Suspense fallback={<LoadingRing label="Opening library…"/>}><ContentLibrary snapshot={snapshot} initialSection={catalog} close={()=>setCatalog(null)} useTemplate={item=>{setCatalog(null);create({title:item.name,brief:item.brief,body:item.body,format:item.format??'markdown',assets:item.assets??[],platform:item.platform,collection:item.collection,tags:item.tags,brandId:item.brandId,stage:'ideas'});}}/></Suspense>}
    {library && <ContentOutputLibrary outputs={outputs} snapshot={snapshot} refresh={refresh} close={() => setLibrary(false)} openContent={id => { setLibrary(false); openContent(id); }}/>}
    <div className={`record-workspace${index.selected ? ' has-selection' : ''}${kind === 'content' && view !== 'list' ? ' content-planning-workspace' : ''}`}><section ref={listArea} tabIndex={-1} className="record-list" aria-label="Records">
      <div className={kind === 'content' && view !== 'list' ? 'content-draft-tray' : 'record-draft-tray'}>{activeDrafts.map((id, i) => <button className="card record-list-item" key={id} aria-pressed={index.selected === id} onClick={e => openRecord(id, e.currentTarget)}><span><strong>{kind === 'content' ? currentRecordDraftTitle(localStorage, recoveryScope, id) ?? `Unfinished content ${i + 1}` : `Unfinished ${kind} ${i + 1}`}</strong><small>Kept on this device · resume writing</small></span></button>)}</div>
      {kind === 'content' && <ContentPlanning key={snapshot.epoch} snapshot={snapshot} records={filtered as Entity<Content>[]} refresh={refresh} selected={index.selected} open={openRecord} create={create} publication={id => openRecord(id, undefined, true)} view={view}/>}
      {(kind !== 'content' || view === 'list') && filtered.map(record => <button key={record.id} className="card record-list-item" aria-pressed={index.selected === record.id} onClick={e => openRecord(record.id, e.currentTarget)}>{'appearance' in record.value && <SquareLynx appearance={record.value.appearance} size="roster" accessibility={{ mode: 'decorative' }}/>}<span><strong>{recordTitle(record.value)}</strong><small>{'position' in record.value ? [record.value.position, 'organization' in record.value && record.value.organization].filter(Boolean).join(' · ') || 'Add the context that matters' : 'stage' in record.value ? `${record.value.stage} · ${record.value.platform}` : 'state' in record.value ? `${record.value.state} · ${snapshot.records?.agent.find(a => a.id === (record.value as Assignment).agentId)?.value.name ?? 'Agent unavailable'}` : ''}</small><small className="metadata">Saved {new Date(record.updatedAt).toLocaleDateString()}</small></span></button>)}
      {!filtered.length && !activeDrafts.length && (kind !== 'content' || view === 'list') && <div className="card record-empty"><Empty action={!archived && !query && !project && !stage && !(kind==='content'&&(preferences.collection||preferences.tag)) ? <button onClick={() => create()}><Plus size={18}/>Create {kind === 'assignment' ? 'a plan' : `a ${kind}`}</button> : undefined} title={query || project || stage || (kind==='content'&&(preferences.collection||preferences.tag)) ? 'No records match these filters.' : archived ? 'Nothing archived.' : `Your first ${kind === 'assignment' ? 'plan' : kind} starts here.`}>{archived ? 'Archived work keeps its history and connections.' : 'Create a record to keep useful context and return to it later.'}</Empty></div>}
    </section>
    {index.selected && <div ref={editorArea} tabIndex={-1}>{selectedMissing ? <section className="card"><Empty title="This record is unavailable." action={<button onClick={closeRecord}>Close record</button>}>Reconnect to the host or reopen its source. No replacement has been created.</Empty></section> : kind==='content'?<Suspense fallback={<LoadingRing label="Opening Content…"/>}><ContentEditor openAssistantSettings={openAssistantSettings} key={index.selected} id={index.selected} entity={selected as Entity<Content>|undefined} snapshot={snapshot} refresh={refresh} editTask={editTask} close={closeRecord} removeDraft={()=>keep({selected:null,drafts:index.drafts.filter(id=>id!==index.selected)})} openSource={openSource} requestPublication={publicationRequest?.id===index.selected?publicationRequest.nonce:undefined}/></Suspense> : <RecordEditor targetAttempt={kind === 'assignment' ? index.attempt : undefined} clearTargetAttempt={() => keep({ ...index, attempt: undefined })} requestPublication={publicationRequest?.id === index.selected ? publicationRequest.nonce : undefined} openContent={openContent} openSource={openSource} openEmail={openEmail} key={index.selected} kind={kind} id={index.selected} entity={selected} snapshot={snapshot} refresh={refresh} editTask={editTask} close={closeRecord} removeDraft={() => keep({ selected: null, drafts: index.drafts.filter(id => id !== index.selected) })}/>}</div>}
    </div>
  </>;
}
