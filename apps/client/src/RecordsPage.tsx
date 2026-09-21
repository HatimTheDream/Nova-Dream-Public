import { LoadingRing } from './ModuleLoading';
import type { MailContactSource } from '../../../packages/domain/mail-contact';
import type { AssistantOutput } from '../../../packages/domain/assistant';
import { ContentOutputLibrary } from './ContentOutputs';
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { lazy } from './preload-lazy';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { blankRecord, contentStages, recordTitle, type Content, type Assignment, type RecordKind, type RecordValue, type ContentOutputSource } from '../../../packages/domain/workspace-records';
import { readLocal, saveLocal } from './api';
import { Plus, Search, MoreHorizontal, Filter, Help, ViewBoard, ViewList, CalendarDays } from './icons';
import { Empty, Dialog } from './ui';
import { ComposerMenu } from './ComposerMenu';
import { RecordEditor } from './RecordEditor';
import { Portrait } from './nova/lynx-portrait/Portrait';
import { retainedWindowId } from './useWorkspace';
import './records.css';
import { AgentRoutines } from './AgentRoutines';
import { ContentPlanning, type ContentSeed } from './ContentPlanning';
import { dayInZone } from '../../../packages/domain/tasks';
const ContentEditor = lazy(() => import('./ContentEditor'));
const ContentLibrary = lazy(() => import('./ContentLibrary').then(m=>({default:m.ContentLibrary})));
const ProfilePage = lazy(() => import('./ProfilePage'));
const AgentHub = lazy(() => import('./AgentHub'));
const AgentSkills = lazy(() => import('./AgentSkills'));

type Page = 'contacts' | 'content' | 'agents' | 'profile';
export type RecordTarget = { kind: RecordKind; id: string; nonce: string };
const headings: Record<Page, { title: string; eyebrow: string; detail: string; kind: RecordKind }> = {
  contacts: { title: 'People, kept close.', eyebrow: 'Contacts', detail: 'Keep the context. Follow through on what matters.', kind: 'contact' },
  content: { title: 'Room for your next idea.', eyebrow: 'Content', detail: 'Shape a brief, keep your drafts, and move the work forward.', kind: 'content' },
  agents: { title: 'Build your team.', eyebrow: 'Agents', detail: 'Give every agent a clear identity, purpose, and set of limits.', kind: 'agent' },
  profile: { title: 'Make it yours.', eyebrow: 'Profile', detail: 'Your identity and the progress you have earned.', kind: 'profile' },
};
type SourceActions = { openAssistantSettings?: () => void; openWork?: (conversationId: string) => void; openEmail?: (source: MailContactSource) => Promise<void>; outputs: AssistantOutput[]; openContent: (id: string) => void; openSource: (source: ContentOutputSource) => void };
type LocalIndex = { selected: string | null; drafts: string[]; seenTarget?: string };
export default function RecordsPage({ page, snapshot, refresh, editTask, target, outputs, openContent, openSource, openEmail, openWork, openAssistantSettings }: SourceActions & { page: Page; snapshot: Snapshot; refresh: () => Promise<void>; editTask: (task: Entity<Task>) => void; target?: RecordTarget | null }) {
  const scrollRef = useRef<HTMLElement>(null);
  const scrollKey = `e3:record-scroll:${snapshot.deviceId}:${page}:${retainedWindowId}`;
  useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = readLocal<number>(scrollKey) ?? 0; }, [scrollKey]);
  const agentViewKey = `e3:agent-view:${snapshot.deviceId}:${retainedWindowId}`;
  const [agentSelection, setAgentSelection] = useState<{ view: 'agent' | 'assignment' | 'routines' | 'skills' | 'hub'; target?: string }>(() => readLocal(agentViewKey) ?? { view: 'agent' });
  const [navigationError, setNavigationError] = useState('');
  const agentIndexKey = `e3:record-index:${snapshot.deviceId}:agent:${retainedWindowId}`;
  const [agentIndex, setAgentIndex] = useState<LocalIndex>(() => readLocal(agentIndexKey) ?? { drafts: [], selected: null });
  const keepAgentIndex = (next: LocalIndex) => { if (!saveLocal(agentIndexKey, next)) { setNavigationError('Free browser storage before opening another agent. Your current writing is kept.'); return; } setAgentIndex(next); };
  const openDesign = (id?: string) => { const selected = id ?? `agent:${crypto.randomUUID()}`; keepAgentIndex({ ...agentIndex, selected, drafts: id ? agentIndex.drafts : [...agentIndex.drafts, selected] }); };
  const closeDesign = () => keepAgentIndex({ ...agentIndex, selected: null });
  const agentView = agentSelection.view;
  const setAgentView = (view: 'agent' | 'assignment' | 'routines' | 'skills' | 'hub') => { const next = { ...agentSelection, view }; setAgentSelection(next); saveLocal(agentViewKey, next); };
  const openRecord = (kind: 'agent' | 'assignment', id?: string) => {
    const key = `e3:record-index:${snapshot.deviceId}:${kind}:${retainedWindowId}`, current = readLocal<LocalIndex>(key) ?? { drafts: [], selected: null }, selected = id ?? `${kind}:${crypto.randomUUID()}`;
    if (!saveLocal(key, { ...current, drafts: id ? current.drafts : [...current.drafts, selected], selected, seenTarget: target?.nonce })) { setNavigationError('Free browser storage before navigating. Your current writing remains open.'); return; }
    setNavigationError(''); setAgentView(kind);
  };
  const openPlan = (id: string) => openRecord('assignment', id);
  const assignWork = (agentId: string) => {
    const agent = snapshot.records?.agent.find(record => record.id === agentId && !record.value.archived); if (!agent) { setNavigationError('Choose a current agent before assigning work.'); return; }
    const id = `assignment:${crypto.randomUUID()}`, key = `e3:record-index:${snapshot.deviceId}:assignment:${retainedWindowId}`, index = readLocal<LocalIndex>(key) ?? { drafts: [], selected: null };
    const value = { ...blankRecord('assignment', snapshot.layout.value.timezone), agentId, agentRevision: agent.revision, title: `Assignment for ${agent.value.name}` };
    if (!saveLocal(`e3:journal:${snapshot.deviceId}:${id}:${retainedWindowId}`, { value, revision: 0, epoch: snapshot.epoch, dirty: true }) || !saveLocal(key, { ...index, selected: id, drafts: [...index.drafts, id] })) { setNavigationError('Free browser storage before creating an assignment. The original agent is kept.'); return; }
    setNavigationError(''); setAgentView('assignment');
  };
  const openRoutine = (id: string) => { const key = `e3:agent-routines:${snapshot.deviceId}:${snapshot.epoch}:${retainedWindowId}`; if (!saveLocal(key, { ...(readLocal(key) ?? { drafts: [] }), selected: id })) { setNavigationError('Free browser storage before opening this routine.'); return; } setNavigationError(''); setAgentView('routines'); };
  useEffect(() => { if (page === 'agents' && target && target.nonce !== agentSelection.target && ['agent', 'assignment'].includes(target.kind)) { if (target.kind === 'agent') openDesign(target.id); const next = { view: target.kind as 'agent' | 'assignment', target: target.nonce }; setAgentSelection(next); saveLocal(agentViewKey, next); } }, [target?.nonce, page]);
  const heading = headings[page]; const kind = page === 'agents' ? agentView : heading.kind;
  return <main ref={scrollRef} onScroll={event => saveLocal(scrollKey, event.currentTarget.scrollTop)} className={`page-scroll records-page records-page-${page}${page === 'agents' && ['agent', 'hub'].includes(kind) ? ' records-hub' : ''}`}>
    {page !== 'agents' && <div className="page-intro"><h1>{heading.eyebrow}</h1><ComposerMenu label={`About ${heading.eyebrow}`} icon={<Help size={20}/>} placement="below" align="right">{() => <p>{heading.detail}</p>}</ComposerMenu></div>}
    {page === 'agents' && !['agent', 'hub'].includes(kind) && <div className="page-intro"><h1>{kind === 'assignment' ? 'Assignments' : kind === 'routines' ? 'Routines' : 'Skills'}</h1><button onClick={() => setAgentView('agent')}>← Team</button></div>}
    {navigationError && <p role="alert" className="field-error">{navigationError}</p>}
    {kind === 'skills' ? <Suspense fallback={<LoadingRing label="Opening skills…"/>}><AgentSkills key={`${snapshot.epoch}:${snapshot.deviceId}`} snapshot={snapshot}/></Suspense> : page === 'agents' && (kind === 'hub' || kind === 'agent') ? <Suspense fallback={<LoadingRing label="Opening your team…"/>}><AgentHub openSettings={openAssistantSettings} key={`${snapshot.epoch}:${snapshot.deviceId}`} snapshot={snapshot} openWork={openWork} presentation={kind === 'hub' ? 'hub' : 'team'} setPresentation={view => setAgentView(view === 'hub' ? 'hub' : 'agent')} openAgent={openDesign} assignWork={assignWork} openPlan={openPlan} openRoutine={openRoutine} openContent={openContent} editTask={editTask} manage={setAgentView} unfinished={agentIndex.drafts.filter(id => !snapshot.records?.agent.some(a => a.id === id))}/></Suspense> : kind === 'routines' ? <AgentRoutines key={`${snapshot.epoch}:${snapshot.deviceId}`} snapshot={snapshot} openPlan={openPlan}/> : kind === 'profile' ? <Suspense fallback={<LoadingRing label="Opening Profile…"/>}><ProfilePage key={`${snapshot.deviceId}:${snapshot.epoch}`} snapshot={snapshot} refresh={refresh} editTask={editTask}/></Suspense> : <RecordCollection key={`${snapshot.deviceId}:${snapshot.epoch}:${kind}`} kind={kind as RecordKind} snapshot={snapshot} refresh={refresh} editTask={editTask} target={target} outputs={outputs} openContent={openContent} openSource={openSource} openEmail={openEmail} openAssistantSettings={openAssistantSettings}/>}
    {page === 'agents' && agentIndex.selected && <Dialog title={snapshot.records?.agent.some(a => a.id === agentIndex.selected) ? 'Agent settings' : 'Create agent'} close={closeDesign}><RecordEditor kind="agent" id={agentIndex.selected} key={agentIndex.selected} entity={snapshot.records?.agent.find(a => a.id === agentIndex.selected)} snapshot={snapshot} refresh={refresh} editTask={editTask} onSaved={closeDesign} removeDraft={() => keepAgentIndex({ selected: null, drafts: agentIndex.drafts.filter(id => id !== agentIndex.selected) })}/></Dialog>}
  </main>;
}
function RecordCollection({ kind, snapshot, refresh, editTask, target, outputs, openContent, openSource, openEmail, openWork, openAssistantSettings }: SourceActions & { kind: RecordKind; snapshot: Snapshot; refresh: () => Promise<void>; editTask: (task: Entity<Task>) => void; target?: RecordTarget | null }) {
  const key = `e3:record-index:${snapshot.deviceId}:${kind}:${retainedWindowId}`;
  const [index, setIndex] = useState<LocalIndex>(() => readLocal(key) ?? { selected: null, drafts: [] });
  const [library, setLibrary] = useState(false), [catalog, setCatalog] = useState(false);
  const [error, setError] = useState('');
  const [preferences, setPreferences] = useState<{ query: string; archived: boolean; project: string; stage: string; view: 'list' | 'board' | 'calendar'; showFilters: boolean; collection:string; tag:string }>(() => ({ collection:'',tag:'',query: '', archived: false, project: '', stage: '', showFilters: false, view: kind === 'content' && window.innerWidth > 700 ? 'board' : 'list', ...(readLocal(key + ':view') ?? {}) }));
  const { query, archived, project, stage, view, showFilters } = preferences;
  const prefer = (patch: Partial<typeof preferences>) => { const next = { ...preferences, ...patch }; setPreferences(next); if (!saveLocal(key + ':view', next)) setError('This view is kept in the current window only. Browser storage is full.'); };
  const setQuery = (query: string) => prefer({ query }), setArchived = (archived: boolean) => prefer({ archived }), setProject = (project: string) => prefer({ project }), setStage = (stage: string) => prefer({ stage });
  const [publicationRequest, setPublicationRequest] = useState<{ id: string; nonce: string }>();
  const [needsFocus, setNeedsFocus] = useState(false), editorArea = useRef<HTMLDivElement>(null), listArea = useRef<HTMLElement>(null), opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { if (needsFocus && editorArea.current) { editorArea.current.focus(); editorArea.current.scrollIntoView({ block: 'start' }); setNeedsFocus(false); } }, [needsFocus, index.selected]);
  const records = (snapshot.records?.[kind] ?? []) as Entity<RecordValue>[];
  const keep = (next: LocalIndex) => { setIndex(next); if (!saveLocal(key, next)) setError('This selection is kept in this window only. Browser storage is full.'); };
  const openRecord = (id: string, element?: HTMLElement, publication = false) => { opener.current = element ?? null; setPublicationRequest(publication ? { id, nonce: crypto.randomUUID() } : undefined); keep({ ...index, selected: id }); setNeedsFocus(true); };
  const closeRecord = () => { const id = index.selected; keep({ ...index, selected: null }); setPublicationRequest(undefined); const card = Array.from(listArea.current?.querySelectorAll<HTMLElement>('[data-content-id]') ?? []).find(node => node.dataset.contentId === id)?.querySelector<HTMLButtonElement>('button'); requestAnimationFrame(()=>(opener.current?.isConnected ? opener.current : card ?? listArea.current)?.focus()); };
  useEffect(() => { if (target?.kind === kind && target.nonce !== index.seenTarget) { opener.current = null; setPublicationRequest(undefined); keep({ ...index, selected: target.id, seenTarget: target.nonce }); setNeedsFocus(true); } }, [target?.nonce, kind]);
  const create = (seed?: Partial<Content>) => {
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
  return <>{!(kind === 'content' && index.selected) && <>{kind === 'content' && <nav className="record-tabs" aria-label="Content views">{(['board', 'calendar', 'list'] as const).map(option => <button key={option} aria-pressed={view === option} onClick={() => prefer({ view: option })}>{option === 'board' ? <ViewBoard size={17}/> : option === 'calendar' ? <CalendarDays size={17}/> : <ViewList size={17}/>}<span>{option[0].toUpperCase() + option.slice(1)}</span></button>)}</nav>}<div className="record-toolbar"><label className="search-input"><Search size={18}/><input aria-label={`Search ${kind} records`} placeholder="Search records…" value={query} onChange={e => setQuery(e.target.value)}/></label><button className="primary" onClick={() => create()}><Plus size={18}/>New {kind === 'assignment' ? 'plan' : kind}</button><button className="record-filter-toggle icon-button" aria-label={`Filters${[archived, project, stage, kind==='content'&&preferences.collection, kind==='content'&&preferences.tag].filter(Boolean).length ? ` · ${[archived, project, stage, kind==='content'&&preferences.collection, kind==='content'&&preferences.tag].filter(Boolean).length} active` : ''}`} title="Filters" aria-expanded={showFilters} aria-controls={`${kind}-record-filters`} onClick={() => prefer({ showFilters: !showFilters })}><Filter size={18}/>{!![archived, project, stage, kind==='content'&&preferences.collection, kind==='content'&&preferences.tag].filter(Boolean).length && <span className="filter-dot"/>}</button>{kind === 'content' && <ComposerMenu label="Content actions" icon={<MoreHorizontal size={20}/>} placement="below" align="right">{close => <><button onClick={() => { close(); setCatalog(true); }}>Templates & brand guidance</button><button onClick={() => { close(); setLibrary(true); }}>From Assistant output</button><p>Move cards between stages or onto a date. Open a card to edit its draft. Published items require a manual publication record.</p></>}</ComposerMenu>}</div>
    <div id={`${kind}-record-filters`} className="record-filters" hidden={!showFilters}><label>Show<select value={archived ? 'archived' : 'active'} onChange={e => setArchived(e.target.value === 'archived')}><option value="active">Active records</option><option value="archived">Archived records</option></select></label>{['contact', 'content', 'assignment'].includes(kind) && <label>Project filter<select value={project} onChange={e => setProject(e.target.value)}><option value="">All Projects</option>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.value.name}</option>)}</select></label>}{kind === 'content' && <label>Stage filter<select value={stage} onChange={e => setStage(e.target.value)}><option value="">All stages</option>{contentStages.map(s => <option key={s}>{s}</option>)}</select></label>}{kind==='content'&&<><label>Collection<select value={preferences.collection} onChange={e=>prefer({collection:e.target.value})}><option value="">All collections</option>{[...new Set((snapshot.records?.content??[]).map(c=>c.value.collection).filter(Boolean))].sort().map(c=><option key={c}>{c}</option>)}</select></label><label>Tag<select value={preferences.tag} onChange={e=>prefer({tag:e.target.value})}><option value="">All tags</option>{[...new Set((snapshot.records?.content??[]).flatMap(c=>c.value.tags??[]))].sort().map(t=><option key={t}>{t}</option>)}</select></label></>}<span className="metadata">{filtered.length} saved · {activeDrafts.length} device drafts</span></div>
    {!showFilters && <p className="metadata content-filter-summary">{filtered.length} saved · {activeDrafts.length} device drafts{archived ? ' · Archived' : ''}{project ? ` · ${snapshot.projects.find(p => p.id === project)?.value.name ?? 'Project unavailable'}` : ''}{stage ? ` · ${stage}` : ''}{preferences.collection?` · ${preferences.collection}`:''}{preferences.tag?` · #${preferences.tag}`:''}</p>}
    </>}{error && <p className="field-error" role="alert">{error}</p>}
    {catalog&&<Suspense fallback={<LoadingRing label="Opening library…"/>}><ContentLibrary snapshot={snapshot} close={()=>setCatalog(false)} useTemplate={item=>{setCatalog(false);create({title:item.name,brief:item.brief,body:item.body,format:item.format??'markdown',assets:item.assets??[],platform:item.platform,collection:item.collection,tags:item.tags,brandId:item.brandId,stage:'ideas'});}}/></Suspense>}
    {library && <ContentOutputLibrary outputs={outputs} snapshot={snapshot} refresh={refresh} close={() => setLibrary(false)} openContent={id => { setLibrary(false); openContent(id); }}/>}
    <div className={`record-workspace${index.selected ? ' has-selection' : ''}${kind === 'content' && view !== 'list' ? ' content-planning-workspace' : ''}`}><section ref={listArea} tabIndex={-1} className="record-list" aria-label="Records">
      <div className={kind === 'content' && view !== 'list' ? 'content-draft-tray' : 'record-draft-tray'}>{activeDrafts.map((id, i) => <button className="card record-list-item" key={id} aria-pressed={index.selected === id} onClick={e => openRecord(id, e.currentTarget)}><span><strong>Unfinished {kind} {i + 1}</strong><small>Kept on this device · resume writing</small></span></button>)}</div>
      {kind === 'content' && <ContentPlanning key={snapshot.epoch} snapshot={snapshot} records={filtered as Entity<Content>[]} refresh={refresh} selected={index.selected} open={openRecord} create={create} publication={id => openRecord(id, undefined, true)} view={view}/>}
      {(kind !== 'content' || view === 'list') && filtered.map(record => <button key={record.id} className="card record-list-item" aria-pressed={index.selected === record.id} onClick={e => openRecord(record.id, e.currentTarget)}>{'appearance' in record.value && <Portrait recipe={record.value.appearance} size="roster" accessibility={{ mode: 'decorative' }}/>}<span><strong>{recordTitle(record.value)}</strong><small>{'position' in record.value ? [record.value.position, 'organization' in record.value && record.value.organization].filter(Boolean).join(' · ') || 'Add the context that matters' : 'stage' in record.value ? `${record.value.stage} · ${record.value.platform}` : 'state' in record.value ? `${record.value.state} · ${snapshot.records?.agent.find(a => a.id === (record.value as Assignment).agentId)?.value.name ?? 'Agent unavailable'}` : ''}</small><small className="metadata">Saved {new Date(record.updatedAt).toLocaleDateString()}</small></span></button>)}
      {!filtered.length && !activeDrafts.length && (kind !== 'content' || view === 'list') && <div className="card record-empty"><Empty action={!archived && !query && !project && !stage && !(kind==='content'&&(preferences.collection||preferences.tag)) ? <button onClick={() => create()}><Plus size={18}/>Create {kind === 'assignment' ? 'a plan' : `a ${kind}`}</button> : undefined} title={query || project || stage || (kind==='content'&&(preferences.collection||preferences.tag)) ? 'No records match these filters.' : archived ? 'Nothing archived.' : `Your first ${kind === 'assignment' ? 'plan' : kind} starts here.`}>{archived ? 'Archived work keeps its history and connections.' : 'Create a record to keep useful context and return to it later.'}</Empty></div>}
    </section>
    {index.selected && <div ref={editorArea} tabIndex={-1}>{selectedMissing ? <section className="card"><Empty title="This record is unavailable." action={<button onClick={closeRecord}>Close record</button>}>Reconnect to the host or reopen its source. No replacement has been created.</Empty></section> : kind==='content'?<Suspense fallback={<LoadingRing label="Opening Content…"/>}><ContentEditor openAssistantSettings={openAssistantSettings} key={index.selected} id={index.selected} entity={selected as Entity<Content>|undefined} snapshot={snapshot} refresh={refresh} editTask={editTask} close={closeRecord} removeDraft={()=>keep({selected:null,drafts:index.drafts.filter(id=>id!==index.selected)})} openSource={openSource} requestPublication={publicationRequest?.id===index.selected?publicationRequest.nonce:undefined}/></Suspense> : <RecordEditor requestPublication={publicationRequest?.id === index.selected ? publicationRequest.nonce : undefined} openContent={openContent} openSource={openSource} openEmail={openEmail} key={index.selected} kind={kind} id={index.selected} entity={selected} snapshot={snapshot} refresh={refresh} editTask={editTask} close={closeRecord} removeDraft={() => keep({ selected: null, drafts: index.drafts.filter(id => id !== index.selected) })}/>}</div>}
    </div>
  </>;
}
