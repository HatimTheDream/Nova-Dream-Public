import { readPreparedView } from './prepared-views';
import { LoadingRing } from './ModuleLoading';
import { useEffect, useRef, useState } from 'react';
import type { HubAgent, HubMember, HubState } from '../../../packages/domain/agent-hub';
import { deskAvailable, roomTemplates, roomFurniture, furnitureChoices, type FurnitureKind, type HubLayout, type HubRoom, type RoomTemplate } from '../../../packages/domain/hub-layout';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { ApiError, readLocal, request, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { SquareLynx } from './nova/square-lynx/SquareLynx';
import { AssignmentReview } from './AssignmentReview';
import { ComposerMenu } from './ComposerMenu';
import { Dialog } from './ui';
import { Plus, Search, MoreHorizontal, X } from './icons';
import './agent-hub.css';
import './agents-workspace.css';
import { agentDraftScope, agentLocalSlot, registerAgentDraftNavigation } from './agent-workspace-navigation';
import { HubMeetingPanel } from './HubMeetingPanel';
import type { HubMeetingState } from '../../../packages/domain/hub-meetings';
import { Headquarters } from './nova/hub/Headquarters';
import { useHubMeetingControls } from './nova/hub/useHubMeetingControls';
import type { AgentActivityPreference, AgentActivityEvent } from '../../../packages/domain/agent-activity';

type Actions = { openChat?: (agentId: string, revision: number) => void; openWork?: (conversationId: string) => void; assignWork: (agentId: string) => void; openAgent: (id?: string) => void; openPlan: (id: string, attemptId?: string) => void; openRoutine: (id: string) => void; openContent: (id: string) => void; editTask: (task: Entity<Task>) => void };
type Props = Actions & { snapshot: Snapshot; presentation: 'team' | 'hub'; setPresentation: (view: 'team' | 'hub') => void; manage: (view: 'assignment' | 'routines' | 'skills') => void; unfinished: string[]; openSettings?: () => void };
type LayoutAction = { type: 'furnish-room'; roomId: string; slot: string; furniture: FurnitureKind } | { type: 'add-room'; template: Exclude<RoomTemplate, 'commons'>; name: string } | { type: 'rename-room'; roomId: string; name: string } | { type: 'place-agent'; agentId: string; roomId: string; desk: number };
type LayoutCommand = { requestId: string; epoch: string; expectedRevision: number; action: LayoutAction };
type TeamView = { query: string; archived: boolean; searchOpen: boolean };
type RoomForm = { id?: string; name: string; template: Exclude<RoomTemplate, 'commons'> };
type DiscussionView = { open: boolean; id?: string };
const browserStorage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
const teamViewValue = (value: unknown): value is TeamView => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['query', 'archived', 'searchOpen'].includes(key)) && typeof (value as TeamView).query === 'string' && typeof (value as TeamView).archived === 'boolean' && typeof (value as TeamView).searchOpen === 'boolean';
const roomFormValue = (value: unknown): value is RoomForm | null => value === null || !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['id', 'name', 'template'].includes(key)) && ((value as RoomForm).id === undefined || typeof (value as RoomForm).id === 'string') && typeof (value as RoomForm).name === 'string' && ['private', 'studio', 'meeting', 'boardroom'].includes((value as RoomForm).template);
const discussionValue = (value: unknown): value is DiscussionView => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['open', 'id'].includes(key)) && typeof (value as DiscussionView).open === 'boolean' && ((value as DiscussionView).id === undefined || typeof (value as DiscussionView).id === 'string');
const statusLabel = (member: HubMember) => ({ working: 'Working', 'waiting-owner': 'Needs review', 'waiting-provider': 'Waiting for worker', failed: 'Failed', idle: 'Ready', offline: 'Offline' })[member.status];
export default function AgentHub({ snapshot, presentation, setPresentation, manage, unfinished, openSettings, ...actions }: Props) {
  const chat = (id: string) => { const saved = snapshot.records?.agent.find(row => row.id === id); if (saved && !saved.value.archived) actions.openChat?.(saved.id, saved.revision); };
  const key = `e3:hub:${snapshot.epoch}:${snapshot.deviceId}:${retainedWindowId}`;
  const navigationScope = agentDraftScope(snapshot.epoch, snapshot.deviceId, retainedWindowId);
  const [kept] = useState(() => ({
    selected: agentLocalSlot(browserStorage, key + ':selected', (value: unknown): value is string | null => value === null || typeof value === 'string', null),
    view: agentLocalSlot(browserStorage, key + ':view', teamViewValue, { query: '', archived: false, searchOpen: false }),
    room: agentLocalSlot(browserStorage, key + ':room-form', roomFormValue, null),
    discussion: agentLocalSlot(browserStorage, key + ':discussion', discussionValue, { open: false }),
    profile: agentLocalSlot(browserStorage, key + ':profile-open', (value: unknown): value is boolean => typeof value === 'boolean', false),
  }));
  const unreadable = Object.values(kept).map(item => item.error).find(Boolean) ?? '';
  const [storageError, setStorageError] = useState(unreadable);
  const [state, setState] = useState<HubState | undefined>(() => readPreparedView(snapshot, 'agents/hub?archived=false')), [error, setError] = useState(''), [readError, setReadError] = useState(''), [selected, setSelected] = useState<string | undefined>(() => kept.selected.initial ?? undefined);
  const [query, setQuery] = useState(kept.view.initial.query), [archived, setArchived] = useState(kept.view.initial.archived), [revision, reload] = useState(0), [detail, setDetail] = useState<string>();
  const [searchOpen, setSearchOpen] = useState(kept.view.initial.searchOpen);
  const searchTrigger = useRef<HTMLButtonElement>(null), searchField = useRef<HTMLInputElement>(null);
  const closeSearch = () => { setSearchOpen(false); searchTrigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (searchOpen) searchField.current?.focus(); }, [searchOpen]);
  const [meetings,setMeetings]=useState<HubMeetingState>(),[meetingError,setMeetingError]=useState(''),[meetingOpen,setMeetingOpen]=useState(kept.discussion.initial.open),[meetingTick,bumpMeeting]=useState(0);
  const [meetingId,setMeetingId]=useState<string | undefined>(kept.discussion.initial.id),[profileOpen,setProfileOpen]=useState(kept.profile.initial),[roomsOpen,setRoomsOpen]=useState(false);
  const [activityBusy,setActivityBusy]=useState(false),[activityError,setActivityError]=useState(''),[activityPending,setActivityPending]=useState<Record<string,unknown>|null>(()=>readLocal(key+':activity-pending')??null);
  const activityFlight=useRef(false),meetingControls=useHubMeetingControls(snapshot.epoch,key+':meeting-draft',()=>bumpMeeting(v=>v+1));
  const [roomForm, setRoomForm] = useState<RoomForm | undefined>(() => kept.room.initial ?? undefined);
  const [roomOpen, setRoomOpen] = useState(!!kept.room.initial), [roomNotice, setRoomNotice] = useState('');
  const [pending, setPending] = useState<LayoutCommand | undefined>(() => readLocal(key + ':pending')), [busy, setBusy] = useState(false);
  const confirmedLayout = useRef<{ command: LayoutCommand; layout: HubLayout } | undefined>(undefined);
  const mounted = useRef(true), flight = useRef(false), opener = useRef<HTMLElement | null>(null), closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ archived: String(archived), ...(selected ? { agentId: selected } : {}) });
        const next = await request<HubState>(`agents/hub?${params}`, undefined, controller.signal);
        if (!controller.signal.aborted) { setState(next); setReadError(''); }
      } catch (reason) { if (!controller.signal.aborted) { if (reason instanceof ApiError && reason.code === 'hub_agent') setSelected(undefined); else setReadError(reason instanceof Error ? reason.message : 'Your team could not load.'); } }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 4000); }
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [archived, selected, revision, snapshot.cursor]);
  useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const value=await request<HubMeetingState>('agents/meetings',undefined,controller.signal);if(!controller.signal.aborted){setMeetings(value);setMeetingError('');}}catch{if(!controller.signal.aborted)setMeetingError('Discussion status is reconnecting. The last saved gathering is shown.');}finally{if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),1800);}};void poll();return()=>{controller.abort();clearTimeout(timer);};},[meetingTick,snapshot.epoch]);
  useEffect(() => { if (selected) closeButton.current?.focus(); }, [selected]);
  const retained = useRef({ selected, roomForm, query, archived, searchOpen, meetingOpen, meetingId, profileOpen });
  retained.current = { selected, roomForm, query, archived, searchOpen, meetingOpen, meetingId, profileOpen };
  const retain = () => {
    if (!mounted.current) return false;
    const current = retained.current;
    const results = [kept.selected.keep(current.selected ?? null), kept.room.keep(current.roomForm ?? null), kept.view.keep({ query: current.query, archived: current.archived, searchOpen: current.searchOpen }), kept.discussion.keep({ open: current.meetingOpen, id: current.meetingId }), kept.profile.keep(current.profileOpen)];
    const saved = results.every(Boolean);
    setStorageError(saved ? unreadable : 'Your current Team writing and view are kept in this window. Retry keeping them before leaving.');
    return saved;
  };
  useEffect(() => { retain(); }, [selected, roomForm, query, archived, searchOpen, meetingOpen, meetingId, profileOpen, key]);
  useEffect(() => registerAgentDraftNavigation(navigationScope, retain), [key]);
  const changeRoom = (next: RoomForm | undefined) => { retained.current.roomForm = next; setRoomForm(next); };
  const closeRoom = () => { if (!busy && retain()) setRoomOpen(false); };
  const openRoom = (next: RoomForm) => {
    if (!mounted.current || busy || pending) return false;
    if (kept.room.error) { setStorageError('The original room writing could not be read. Its bytes are kept; reopen this view before starting another room.'); return false; }
    if (retained.current.roomForm) {
      if (!retain()) return false;
      setRoomNotice(retained.current.roomForm.id !== next.id ? 'Your kept room writing is open. Save it or explicitly discard it before editing a different room.' : 'Your kept room writing is open.');
    } else { changeRoom(next); setRoomNotice(''); }
    setRoomOpen(true); return true;
  };
  const discardRoom = () => {
    if (!mounted.current || busy || pending) return;
    if (!kept.room.keep(null)) { setStorageError('Your kept room writing could not be cleared. It remains open.'); return; }
    changeRoom(undefined); setRoomOpen(false); setRoomNotice('');
  };
  const finishRoom = (command: LayoutCommand) => {
    const draft = retained.current.roomForm, action = command.action;
    const same = draft && (action.type === 'add-room' ? !draft.id && draft.name === action.name && draft.template === action.template
      : action.type === 'rename-room' && draft.id === action.roomId && draft.name === action.name);
    if (!same) return true;
    if (!kept.room.keep(null)) { setStorageError('The room was saved, but its kept writing could not be cleared. The proposal and original save remain available.'); return false; }
    changeRoom(undefined); setRoomOpen(false); setRoomNotice(''); return true;
  };
  useEffect(()=>{if(presentation==='hub'&&state&&!selected&&state.roster.length)setSelected(state.roster[0].id);},[presentation,!!state,selected]);
  const openDiscussion=(id?:string)=>{setMeetingId(id);setMeetingOpen(true);};
  const closeDiscussion=()=>{setMeetingOpen(false);};
  const selectDiscussion=(id?:string)=>{setMeetingId(id);};
  const changeActivity=async(input:Record<string,unknown>&{agentId:string;type:string}):Promise<boolean>=>{
    if(activityFlight.current||!state?.activity)return false;
    const command=activityPending??{...input,requestId:crypto.randomUUID(),epoch:snapshot.epoch,expectedRevision:input.expectedRevision??state.activity.preferences.find(p=>p.agentId===input.agentId)?.revision??0};
    if(!saveLocal(key+':activity-pending',command)){setActivityError('Browser storage is unavailable. Your preferences are kept.');return false;}
    activityFlight.current=true;setActivityBusy(true);setActivityPending(command);setActivityError('');
    try{const result=await request<{preference:AgentActivityPreference;event?:AgentActivityEvent}>('agents/activity',command);saveLocal(key+':activity-pending',null);setActivityPending(null);setState(s=>s?.activity?{...s,activity:{...s.activity,preferences:[...s.activity.preferences.filter(p=>p.agentId!==result.preference.agentId),result.preference],events:result.event?[...s.activity.events,result.event].slice(-80):s.activity.events}}:s);reload(v=>v+1);return true;}
    catch(reason){setActivityError(reason instanceof Error?reason.message:'The preference change is unconfirmed.');if(reason instanceof ApiError&&reason.status!==undefined&&reason.status<500){saveLocal(key+':activity-pending',null);setActivityPending(null);reload(v=>v+1);}return false;}
    finally{activityFlight.current=false;setActivityBusy(false);}
  };
  const close = () => { setSelected(undefined); opener.current?.focus({ preventScroll: true }); };
  const pick = (member: HubMember, element: HTMLElement) => { opener.current = element; setSelected(member.id); };
  const settleConfirmedLayout = () => {
    const confirmed = confirmedLayout.current;
    if (!mounted.current || !confirmed) return false;
    if (confirmed.command.action.type !== 'furnish-room' && !finishRoom(confirmed.command)) return false;
    if (!saveLocal(key + ':pending', null)) { setStorageError('The room change is confirmed, but its original save marker could not be cleared. Retry keeping the confirmed change.'); return false; }
    confirmedLayout.current = undefined; setPending(undefined); setStorageError(unreadable); return true;
  };
  const changeLayout = async (action?: LayoutAction) => {
    if (flight.current || !state || !mounted.current) return;
    if (confirmedLayout.current) { settleConfirmedLayout(); return; }
    const command = pending ?? (action ? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, expectedRevision: state.layout.revision, action } : undefined);
    if (!command) return;
    if (!saveLocal(key + ':pending', command)) { setError('Free browser storage before changing the hub. Your saved layout is kept.'); return; }
    setPending(command); setBusy(true); flight.current = true; setError('');
    try {
      const layout = await request<HubLayout>('agents/hub/layout', command);
      if (mounted.current) { confirmedLayout.current = { command, layout }; setState(s => s && ({ ...s, layout })); settleConfirmedLayout(); reload(r => r + 1); }
    } catch (reason) {
      if (mounted.current) {
        setError(reason instanceof Error ? reason.message : 'The room change is unconfirmed. Reconcile this same change.');
        if (reason instanceof ApiError && ['hub_changed', 'room_missing', 'agent_unavailable', 'desk_occupied', 'hub_full', 'furniture_slot', 'validation', 'epoch_changed'].includes(reason.code)) { if (saveLocal(key + ':pending', null)) setPending(undefined); else setStorageError('The original change was refused, but its saved marker could not be cleared. Reconcile only this original change after storage is available.'); reload(r => r + 1); }
      }
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  };
  const openTask = async (id: string) => { try { const next = await request<Snapshot>('snapshot'), task = next.tasks.find(t => t.id === id); if (mounted.current) { if (task) actions.editTask(task); else setError('The original Task is unavailable. Its link is kept.'); } } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'The Task could not load.'); } };
  const member = state?.roster.find(a => a.id === selected), current = state?.agents.find(a => a.id === selected);
  const editedRoom = roomForm?.id ? state?.layout.rooms.find(room => room.id === roomForm.id) : undefined;
  const readiness = state && !state.runtimeReady && !readError ? <div className="hub-readiness" role="status"><span>{state.runtimeReason || 'Connect the Assistant on this host to run assignments.'}</span>{openSettings && <button onClick={openSettings}>Assistant Settings</button>}</div> : null;
  const filtered = state?.roster.filter(a => `${a.name} ${a.position}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())) ?? [];
  return <section className="agent-hub" aria-label="Agents">
    <header className="hub-toolbar"><div className="hub-heading"><h1 className="sr-only">Team</h1>{state && <span className="metadata">{state.total} {archived ? 'Archived' : 'Team'} {state.total === 1 ? 'Member' : 'Members'}</span>}</div><div className="hub-header-actions"><div className="hub-switch" aria-label="Team presentation"><button aria-pressed={presentation === 'team'} onClick={() => setPresentation('team')}>Team</button><button aria-pressed={presentation === 'hub'} onClick={() => setPresentation('hub')}>Headquarters</button></div><button ref={searchTrigger} className="compact-utility" aria-label="Search Team" aria-expanded={searchOpen} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}><Search size={16}/></button><button className="primary compact-utility" onClick={() => actions.openAgent()}><Plus size={18}/>Create Agent</button><ComposerMenu label="Team Options" icon={<MoreHorizontal size={20}/>} align="right" placement="below">{dismiss => <><button onClick={() => { dismiss(); setArchived(a => !a); setSelected(undefined); setPresentation('team'); }}>{archived ? 'Show Current Team' : 'Archived Agents'}</button><button onClick={() => { dismiss(); manage('assignment'); }}>All Assignments</button><button onClick={() => { dismiss(); manage('routines'); }}>Manage Routines</button><button onClick={() => { dismiss(); manage('skills'); }}>Skill Library</button>{unfinished.map((id, i) => <button key={id} onClick={() => { dismiss(); actions.openAgent(id); }}>Resume unfinished agent {i + 1}</button>)}</>}</ComposerMenu></div></header>
    <div className="hub-searchbar">{searchOpen ? <label className="search-input"><Search size={16}/><input ref={searchField} aria-label="Find An Agent" placeholder="Find an agent…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); } }}/><button type="button" className="compact-utility" aria-label="Close Team Search" onClick={closeSearch}><X size={16}/></button></label> : query && <span className="hub-query-summary"><button className="compact-utility" onClick={() => setSearchOpen(true)}>Search: {query}</button><button className="compact-utility" aria-label="Clear Team Search" onClick={() => { setQuery(''); searchTrigger.current?.focus({ preventScroll: true }); }}><X size={16}/></button></span>}{archived && <span className="metadata">Archived Agents</span>}{presentation === 'hub' && <><button onClick={()=>openDiscussion()}>Boardroom{meetingError?' · Reconnecting':meetings?.current?.state==='running'?' · Discussing':''}</button><span className="metadata hub-room-count">{state?.layout.rooms.length ?? 0} rooms</span><button disabled={busy || !!pending} onClick={() => openRoom({ name: 'Private office', template: 'private' })}><Plus size={16}/>Add Room</button></>}</div>
    {storageError && <div className="notice" role="alert"><span>{storageError}</span><button onClick={retain}>Retry Keeping Writing</button></div>}
    {(error || readError) && <p className="field-error" role="alert">{error || readError}</p>}{pending && <div className="notice"><span>{confirmedLayout.current ? 'The room change is confirmed. Its original save marker is kept until browser storage succeeds.' : 'A room change needs confirmation.'}</span><button disabled={busy} onClick={() => void changeLayout()}>{busy ? 'Checking…' : confirmedLayout.current ? 'Keep Confirmed Change' : 'Reconcile Change'}</button></div>}
    {activityPending&&<div className="notice"><span>An agent preference or interaction needs confirmation.</span><button disabled={activityBusy} onClick={()=>void changeActivity({agentId:String(activityPending.agentId),type:String(activityPending.type)})}>{activityBusy?'Checking…':'Check Original Change'}</button></div>}
    {!member && readiness}
    {!state && !error && <LoadingRing label="Opening your saved team…"/>}
    {presentation === 'team' ? <div className="hub-team-list"><div className="hub-team-columns metadata"><span>Agent</span><span>Current Work</span><span>Status</span></div>{filtered.map(agent => <button className="hub-team-row" key={agent.id} aria-pressed={selected === agent.id} onClick={e => pick(agent, e.currentTarget)}><span className="hub-person"><SquareLynx appearance={agent.appearance} size="icon" accessibility={{ mode: 'decorative' }}/><span><strong>{agent.name}</strong><small>{agent.position}</small></span></span><span className="hub-current-work">{agent.status === 'idle' ? 'Available for an assignment' : agent.status === 'offline' ? 'No assignment running' : agent.reason}</span><span className="hub-state" data-state={readError ? 'stale' : agent.status}>{readError ? 'Unavailable' : statusLabel(agent)}</span></button>)}{state && !filtered.length && <p className="hub-list-empty metadata">{query ? 'No matching agents.' : archived ? 'No archived agents.' : 'Create your first agent to get started.'}</p>}</div> : state && <><Headquarters key={navigationScope} navigationScope={navigationScope} draftKey={key} state={state} meetings={meetings} meetingError={meetingError} selected={selected} current={current} stale={!!readError||!!meetingError} disabled={busy||!!pending} pick={pick} editRoom={room=>openRoom({id:room.id,name:room.name,template:room.template==='commons'?'meeting':room.template})} manageRooms={()=>setRoomsOpen(true)} openDiscussion={openDiscussion} openProfile={()=>setProfileOpen(true)} openPlan={actions.openPlan} openTeam={actions.openWork} assignWork={actions.assignWork} activityCommand={changeActivity} activityBusy={activityBusy||!!activityPending} activityError={activityError} meetingControls={meetingControls} ownerAppearance={snapshot.records?.profile.find(p=>p.id==='profile:owner')?.value.appearance}/>{query&&<div className="hq-search-matches" aria-label="Matching Agents">{filtered.map(a=><button key={a.id} onClick={e=>pick(a,e.currentTarget)}>{a.name}<small>{a.position}</small></button>)}{!filtered.length&&<p>No matching agents.</p>}</div>}</>}
    {member && presentation === 'team' && <aside className="hub-inspector card" aria-label={`${member.name} profile`} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}><button ref={closeButton} className="icon-button hub-close" aria-label="Close agent profile" onClick={close}><X size={20}/></button><SquareLynx appearance={member.appearance} size="roster" accessibility={{ mode: 'decorative' }}/><h2>{member.name}</h2><p>{member.position}</p><span className="hub-state" data-state={readError ? 'stale' : member.status}>{readError ? 'Unavailable' : statusLabel(member)}</span><p className="metadata">{snapshot.records?.agent.find(a => a.id === member.id)?.value.purpose}</p><div className="button-row"><button onClick={() => actions.openAgent(member.id)}>Edit Agent</button>{actions.openChat && <button id={`direct-chat-team-${member.id}`} disabled={member.archived} onClick={() => chat(member.id)}>Chat</button>}<button className="primary" disabled={member.archived} onClick={() => actions.assignWork(member.id)}>Assign Work</button></div>{readiness}{current ? <AgentWork current={current} actions={actions} inspect={setDetail} openTask={openTask} manage={manage}/> : <LoadingRing label="Opening saved work…"/>}{state && !member.archived && <details><summary>Workspace</summary><p className="metadata">Choose an unoccupied private office. Each agent has their own room.</p><select aria-label={`Workspace for ${member.name}`} disabled={busy || !!pending} value={JSON.stringify(state.layout.placements[member.id])} onChange={e => { const placement = JSON.parse(e.target.value); void changeLayout({ type: 'place-agent', agentId: member.id, ...placement }); }}>{state.layout.rooms.flatMap(r => roomTemplates[r.template].desks.map((_, desk) => ({ roomId: r.id, desk, name: r.name }))).filter(p => deskAvailable(state.layout, p, member.id)).map(p => <option key={`${p.roomId}/${p.desk}`} value={JSON.stringify({ roomId: p.roomId, desk: p.desk })}>{p.name} · Desk {p.desk + 1}</option>)}</select></details>}</aside>}
    {roomForm && roomOpen && <Dialog title={roomForm.id ? 'Room Settings' : 'Add Room'} close={closeRoom}><form onSubmit={e => { e.preventDefault(); if (roomForm.id && !editedRoom) { setError('The original room is unavailable. Your kept writing is preserved.'); return; } void changeLayout(roomForm.id ? { type: 'rename-room', roomId: roomForm.id, name: roomForm.name } : { type: 'add-room', template: roomForm.template, name: roomForm.name }); }}>{roomNotice && <p role="status" className="notice">{roomNotice}</p>}<label>Name<input required maxLength={80} value={roomForm.name} onChange={e => changeRoom({ ...roomForm, name: e.target.value })}/></label>{!roomForm.id && <label>Room Type<select value={roomForm.template} onChange={e => changeRoom({ ...roomForm, template: e.target.value as typeof roomForm.template })}><option value="private">Private office · 1 agent</option><option value="studio">Shared studio · additional space</option><option value="meeting">Small meeting room</option><option value="boardroom">Boardroom · long table and 12 chairs</option></select></label>}{roomForm.id && !editedRoom && <p className="notice" role="status">The original room is unavailable. Your kept writing is preserved.</p>}{editedRoom && <div className="hub-room-furnishings">{roomFurniture(editedRoom).map(item => <label key={item.id}>{item.name}<select value={item.kind} disabled={busy || !!pending} onChange={e => void changeLayout({ type: 'furnish-room', roomId: roomForm.id!, slot: item.id, furniture: e.target.value as FurnitureKind })}>{item.choices.map(kind => <option key={kind} value={kind}>{furnitureChoices[kind]}</option>)}</select></label>)}</div>}{error && <p role="alert" className="field-error">{error}</p>}<div className="button-row"><button type="button" disabled={busy} onClick={closeRoom}>Close</button><button type="button" disabled={busy || !!pending} onClick={discardRoom}>Discard Kept Writing</button><button className="primary" disabled={busy || !!pending || !roomForm.name.trim() || !!roomForm.id && !editedRoom}>{busy ? 'Saving…' : roomForm.id ? 'Save Name' : 'Add Room'}</button></div></form></Dialog>}
    {roomsOpen&&state&&<Dialog title="Manage Rooms" close={()=>setRoomsOpen(false)}><div className="hq-room-manager">{state.layout.rooms.map(room=><button key={room.id} onClick={()=>{if(openRoom({id:room.id,name:room.name,template:room.template==='commons'?'meeting':room.template}))setRoomsOpen(false);}}><span>{room.name}</span><small>Room Settings & Furniture</small></button>)}<button className="primary" disabled={busy||!!pending} onClick={()=>{if(openRoom({name:'Private Office',template:'private'}))setRoomsOpen(false);}}>Add Room</button></div></Dialog>}
    {profileOpen&&member&&<Dialog title={member.name} close={()=>setProfileOpen(false)}><SquareLynx appearance={member.appearance} size="roster" accessibility={{mode:'decorative'}}/><p>{member.position}</p><p>{snapshot.records?.agent.find(a=>a.id===member.id)?.value.purpose}</p><div className="button-row"><button onClick={()=>actions.openAgent(member.id)}>Edit Agent</button>{actions.openChat && <button id={`direct-chat-hub-${member.id}`} disabled={member.archived} onClick={() => chat(member.id)}>Chat</button>}<button className="primary" disabled={member.archived} onClick={()=>actions.assignWork(member.id)}>Assign Work</button></div>{readiness}{current?<AgentWork current={current} actions={actions} inspect={setDetail} openTask={openTask} manage={manage}/>:<LoadingRing label="Opening saved work…"/>}{!member.archived&&<label>Office<select value={JSON.stringify(state?.layout.placements[member.id])} disabled={busy||!!pending} onChange={e=>{const placement=JSON.parse(e.target.value);void changeLayout({type:'place-agent',agentId:member.id,...placement});}}>{state?.layout.rooms.flatMap(room=>roomTemplates[room.template].desks.map((_,desk)=>({roomId:room.id,desk,name:room.name}))).filter(p=>deskAvailable(state.layout,p,member.id)).map(p=><option key={p.roomId+'/'+p.desk} value={JSON.stringify({roomId:p.roomId,desk:p.desk})}>{p.name} · Desk {p.desk+1}</option>)}</select></label>}</Dialog>}
    {meetingOpen&&state&&<HubMeetingPanel key={navigationScope} navigationScope={navigationScope} unavailable={meetingError} state={meetings} roster={state.roster.filter(a=>!a.archived)} layout={state.layout} epoch={snapshot.epoch} draftKey={key+':meeting-draft'} refresh={()=>bumpMeeting(v=>v+1)} controls={meetingControls} initialMeetingId={meetingId} onSelection={selectDiscussion} close={closeDiscussion}/>}
    {detail && <AssignmentReview id={detail} close={() => setDetail(undefined)}/>}
  </section>;
}
export function AgentWork({ current, actions, inspect, openTask, manage }: { current: HubAgent; actions: Actions; inspect: (id: string) => void; openTask: (id: string) => Promise<void>; manage: Props['manage'] }) {
  return <><section className="hub-current-card"><h3>Current Work</h3><p>{current.status === 'offline' ? 'No assignment running.' : current.reason}</p>{current.team?.conversationId&&actions.openWork&&<button onClick={()=>actions.openWork!(current.team!.conversationId!)}>Open Team Conversation</button>}{current.reviews.map(review => <button className="hub-work-link" key={review.attemptId} onClick={() => actions.openPlan(review.assignmentId, review.attemptId)}>Review Changes · {review.title}<small>{review.count} to review</small></button>)}{current.active && <button onClick={() => actions.openPlan(current.active!.assignmentId, current.active!.id)}>Open Assignment</button>}{!current.active && current.latest && <><strong>{current.latest.title}</strong><p className="metadata">{current.latest.message}</p><button onClick={() => actions.openPlan(current.latest!.assignmentId, current.latest!.id)}>Open Result & History</button></>}</section>{!!current.plans.length && <details><summary>Assignments · {current.plans.length}</summary>{current.plans.map(p => <button className="hub-work-link" key={p.id} onClick={() => actions.openPlan(p.id)}>{p.title}</button>)}</details>}<details><summary>Routines{current.routines.length ? ` · ${current.routines.length}` : ''}</summary>{current.routines.map(r => <button className="hub-work-link" key={r.id} onClick={() => actions.openRoutine(r.id)}>{r.name}<small>{r.attention ? 'Needs review' : r.nextAt ? new Date(r.nextAt).toLocaleString() : 'Paused'}</small></button>)}<button onClick={() => manage('routines')}>Manage Routines</button></details>{(!!current.tasks.length || !!current.content.length) && <details><summary>Linked Work</summary>{current.tasks.map(t => <button className="hub-work-link" key={t.id} onClick={() => void openTask(t.id)}>{t.title}<small>{t.status}</small></button>)}{current.content.map(c => <button className="hub-work-link" key={c.id} onClick={() => actions.openContent(c.id)}>{c.title}<small>{c.stage}</small></button>)}</details>}<details><summary>Skills & Capabilities</summary><button onClick={() => actions.openAgent(current.id)}>Edit Workspace Capabilities</button><button onClick={() => manage('skills')}>Open Skill Library & Reviews</button></details>{current.latest && <details><summary>Activity Details</summary><p className="metadata">{current.returned} returned attempts · {current.appliedChanges} applied workspace changes · {current.unresolved} attempts need checking</p><button onClick={() => inspect(current.latest!.id)}>Review Saved Inputs</button></details>}</>;
}
