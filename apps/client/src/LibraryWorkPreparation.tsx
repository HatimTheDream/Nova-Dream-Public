import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { Assignment } from '../../../packages/domain/workspace-records';
import type { AssignmentAttempt, AssignmentState } from '../../../packages/domain/assignments';
import { homeReferenceKey } from '../../../packages/domain/home-library-view';
import { activeProjects } from '../../../packages/domain/project-organization';
import { MAX_WORK_SOURCES } from '../../../packages/domain/work-source-limits';
import { agentDraftScope, registerAgentDraftNavigation } from './agent-workspace-navigation';
import { ApiError, commit, request } from './api';
import { retainedWindowId } from './useWorkspace';
import { copyLibraryWorkDraft, keepLibraryWorkStart, libraryAssignmentId, readLibraryWorkDraft, updateLibraryWorkDraft,
  type LibraryWorkDraft, type LibraryWorkOrigin, type LibraryWorkStart } from './library-work-draft';
import { resumeLibraryWork } from './library-work-launch';
import { useWorkSourceChecks, WorkSourceChooser, WorkSourceInspection, WorkSourceList } from './LibraryWorkSources';
import './library-work-preparation.css';
export type { LibraryWorkOrigin, LibraryWorkStart };

type Props = {
  snapshot: Snapshot; draftId: string; initial?: LibraryWorkStart;
  onReturnToLibrary: (origin: LibraryWorkOrigin) => void;
  onOpenWork: (assignmentId: string, attemptId?: string) => void;
  onOpenWorkList: () => void;
};
const explain = (error: unknown) => error instanceof Error ? error.message : 'This change could not be confirmed.';

export function PrepareAssignment(props: Props) {
  return <OpenDraft key={[props.snapshot.epoch,props.snapshot.deviceId,props.draftId].join('/')} {...props}/>;
}
function OpenDraft(props: Props) {
  const [opened] = useState(() => {
    try {
      const existing = readLibraryWorkDraft(props.snapshot, props.draftId);
      if (existing) return {draft: existing};
      if (props.initial && keepLibraryWorkStart(props.snapshot, props.draftId, props.initial))
        return {draft: readLibraryWorkDraft(props.snapshot, props.draftId)};
      return {error: 'This preparation is unavailable on this device. Open its kept draft in Work.'};
    } catch (error) { return {error: explain(error)}; }
  });
  if (!opened.draft) return <section className="library-work-prepare"><h2>Prepare Assignment</h2><p role="alert">{opened.error}</p>
    <button onClick={props.onOpenWorkList}>Work List</button></section>;
  return <DraftEditor {...props} opened={opened.draft}/>;
}

type Panel = {kind: 'inspect'; key: string} | {kind: 'choose'; replaceKey?: string};
function DraftEditor({snapshot, opened, onReturnToLibrary, onOpenWork, onOpenWorkList}: Props & {opened: LibraryWorkDraft}) {
  const [draft, setDraft] = useState(opened), [panel, setPanel] = useState<Panel>(), [error, setError] = useState(''),
    [keepError, setKeepError] = useState(''), [busy, setBusy] = useState(false), [reopenConfirm, setReopenConfirm] = useState(false);
  const kept = useRef(opened), working = useRef(opened), flight = useRef(false), alive = useRef(true);
  const opener = useRef<HTMLButtonElement | null>(null), panelBack = useRef<HTMLButtonElement>(null), sourcesHeading = useRef<HTMLDivElement>(null);
  const projects = activeProjects(snapshot), agents = snapshot.records?.agent.filter(a => !a.value.archived) ?? [];
  const agent = agents.find(item => item.id === draft.agentId), project = projects.find(item => item.id === draft.projectId);
  const checks = useWorkSourceChecks(snapshot.epoch, snapshot.cursor, draft.agentId, agent?.revision, draft.sources);
  const locked = busy || !!draft.pending || !!draft.attemptId;
  const keep = (next: LibraryWorkDraft) => {
    if (!alive.current) throw Error('Open the kept preparation to continue the original request.');
    const saved = updateLibraryWorkDraft(snapshot, kept.current, next);
    kept.current = saved; working.current = saved; setDraft(saved); setKeepError(''); return saved;
  };
  const patch = (delta: Partial<LibraryWorkDraft>) => {
    if (flight.current || working.current.pending || working.current.attemptId) return;
    const next = {...working.current, ...delta};
    try { keep(next); setError(''); } catch (reason) {
      working.current = next; setDraft(next); setKeepError(explain(reason));
    }
  };
  const retain = () => {
    if (working.current === kept.current) return true;
    try { keep(working.current); return true; } catch (reason) { setKeepError(explain(reason)); return false; }
  };
  const navigation = useRef(retain); navigation.current = retain;
  useEffect(() => {
    alive.current = true;
    const unsubscribe = registerAgentDraftNavigation(agentDraftScope(snapshot.epoch, snapshot.deviceId, retainedWindowId), () => navigation.current());
    const onStorage = (event: StorageEvent) => {
      const key = 'e3:library-work:' + snapshot.deviceId + ':' + snapshot.epoch + ':' + opened.id;
      if ((event.key !== key && event.key !== null) || flight.current) return;
      try {
        const fresh = readLibraryWorkDraft(snapshot, opened.id);
        if (!fresh || working.current !== kept.current) throw Error('The kept version changed in another window. Your open writing is preserved.');
        kept.current = fresh; working.current = fresh; setDraft(fresh); setKeepError(''); setReopenConfirm(false);
      } catch (reason) { setKeepError(explain(reason)); }
    };
    window.addEventListener('storage', onStorage);
    return () => { alive.current = false; unsubscribe(); window.removeEventListener('storage', onStorage); };
  }, [snapshot.epoch,snapshot.deviceId,opened.id]);
  useEffect(() => { if (panel) panelBack.current?.focus({preventScroll:true}); }, [panel?.kind]);
  const closePanel = () => { setPanel(undefined); requestAnimationFrame(() => {
    if (opener.current?.isConnected) opener.current.focus({preventScroll:true}); else sourcesHeading.current?.focus({preventScroll:true});
  }); };
  const choosePanel = (next: Panel, trigger: HTMLButtonElement) => { opener.current = trigger; setPanel(next); };
  const openExisting = (saved: LibraryWorkDraft) => onOpenWork(libraryAssignmentId(saved.id), saved.attemptId);
  const canStart = !draft.planConflict && !!draft.title.trim() && !!draft.brief.trim() && !!agent && !!project && draft.sources.length > 0
    && draft.sources.length <= MAX_WORK_SOURCES && checks.rows?.length === draft.sources.length && checks.rows.every(s => s.ready);
  const launch = async () => {
    if (flight.current || !retain()) return;
    if (draft.attemptId) { openExisting(draft); return; }
    if (!draft.pending && !canStart) return;
    flight.current = true; setBusy(true); setError('');
    try {
      if (!navigator.locks) throw Error('This browser cannot coordinate starts across windows. Open this preparation in a supported browser.');
      await navigator.locks.request('e3:work-start:' + snapshot.epoch + ':' + draft.id, {ifAvailable: true}, async lock => {
        if (!lock) throw Error('Another window is starting this assignment. Check the original work when it finishes.');
        let current = working.current;
        if (JSON.stringify(readLibraryWorkDraft(snapshot,current.id)) !== JSON.stringify(kept.current))
          throw Error('The kept preparation changed. Reopen it before continuing.');
        if (!current.pending) {
          if (!agent || !canStart) throw Error('Check the selected sources and lead agent before starting.');
          current = keep({...current, pending: {stage:'save-plan', planRequestId: crypto.randomUUID(), startRequestId: crypto.randomUUID(),
            agentRevision: agent.revision, projectRevision: project?.revision ?? null}});
        }
        const result = await resumeLibraryWork(current, snapshot.epoch, {
          keep, commit: command => commit<Assignment>(command), start: command => request<AssignmentAttempt>('assignments/start',command),
          read: (id, before) => request<AssignmentState>('assignments/state?assignmentId=' + encodeURIComponent(id) + (before ? '&before=' + encodeURIComponent(before) : '')),
        });
        if (alive.current) openExisting(result);
      });
    } catch (reason) {
      if (alive.current) {
        if (reason instanceof ApiError && (reason.code.startsWith('assignment_source_') || [
          'assignment_sources_large','assignment_sources_unavailable','assignment_input_large','agent_changed','project_changed','assignment_unavailable','assignment_quota','connected_scope','agent_team_busy','validation',
          'source_changed','missing_agent','missing_project','record_quota','revision_conflict','assignment_changed','connected_plan_changed','connected_plan_submitted',
        ].includes(reason.code))) {
          const conflict = ['revision_conflict','assignment_changed','connected_plan_changed','connected_plan_submitted'].includes(reason.code);
          try { keep({...working.current, pending: undefined, ...(conflict ? {planConflict:true} : {})}); }
          catch (storageError) { setKeepError(explain(storageError)); }
          checks.refresh();
        }
        setError(explain(reason));
      }
    } finally { flight.current = false; if (alive.current) setBusy(false); }
  };
  const keepCopy = () => {
    try {
      copyLibraryWorkDraft(snapshot, working.current, 'library-work:' + crypto.randomUUID());
      working.current = kept.current; onOpenWorkList();
    } catch (reason) { setKeepError(explain(reason)); }
  };
  const reopen = () => {
    try {
      const fresh = readLibraryWorkDraft(snapshot,draft.id);
      if (!fresh) throw Error('The kept version is unavailable.');
      working.current = fresh; kept.current = fresh; setDraft(fresh); setKeepError(''); setReopenConfirm(false); setError('');
    } catch (reason) { setKeepError(explain(reason)); }
  };
  const activeIndex = panel?.kind === 'inspect' ? draft.sources.findIndex(s => homeReferenceKey(s.reference) === panel.key) : -1;
  const selection = draft.sources[activeIndex];
  return <div className="library-work-prepare" onKeyDown={e => { if (panel && e.key === 'Escape' && !e.defaultPrevented) {e.preventDefault(); closePanel();} }}>
    {keepError && <div role="alert" className="notice warning">{keepError}<div className="button-row">
      {!locked && <button onClick={keepCopy}>Keep Separate Draft</button>}
      <button onClick={() => working.current === kept.current || reopenConfirm ? reopen() : setReopenConfirm(true)}>{reopenConfirm ? 'Discard Open Changes And Reopen' : 'Reopen Kept Version'}</button>
    </div></div>}
    {panel ? <section className="work-source-panel"><button className="quiet" ref={panelBack} onClick={closePanel}>Back To Preparation</button>
      {panel.kind === 'choose' && !locked ? <WorkSourceChooser epoch={snapshot.epoch} selections={draft.sources} replaceKey={panel.replaceKey}
        change={sources => patch({sources})} done={closePanel}/> : selection ? <WorkSourceInspection selection={selection} check={checks.rows?.[activeIndex]} locked={locked}
        change={row => patch({sources: draft.sources.map((s,i) => i === activeIndex ? row : s)})}
        remove={() => { patch({sources: draft.sources.filter((_,i) => i !== activeIndex)}); closePanel(); }}
        replace={() => setPanel({kind:'choose', replaceKey:homeReferenceKey(selection.reference)})}/> : <p>This source is no longer selected.</p>}
      {checks.error && <p role="alert">{checks.error} <button onClick={checks.refresh}>Retry Source Check</button></p>}
    </section> : <>
      <button className="quiet work-back" onClick={() => { if (retain()) onReturnToLibrary(draft.origin); }}>Back To Library</button>
      <header className="work-section-heading"><h2>Prepare Assignment</h2><button className="compact-action" onClick={() => {if (retain()) onOpenWorkList();}}>Work List</button></header>
      <div className="work-prepare-settings"><label>Project<select value={draft.projectId ?? ''} disabled={locked} onChange={e => patch({projectId:e.target.value || null})}>
        <option value="">Choose A Project</option>{draft.projectId && !project && <option value={draft.projectId}>Unavailable Project</option>}
        {projects.map(p => <option value={p.id} key={p.id}>{p.value.name}</option>)}</select></label>
        <label>Lead Agent<select value={draft.agentId ?? ''} disabled={locked} onChange={e => patch({agentId:e.target.value || null})}>
          <option value="">Choose An Agent</option>{draft.agentId && !agent && <option value={draft.agentId}>Unavailable Agent</option>}
          {agents.map(a => <option value={a.id} key={a.id}>{a.value.name}</option>)}</select></label>
        <span className="metadata">Output · Reviewed Content Draft</span></div>
      <div className="work-prepare-columns"><section className="work-prepare-paper">
        <label>Assignment Title<input value={draft.title} disabled={locked} maxLength={240} onChange={e => patch({title:e.target.value})}/></label>
        <label>What Should The Agent Deliver?<textarea value={draft.brief} disabled={locked} maxLength={20000} onChange={e => patch({brief:e.target.value})}/></label>
        <p className="metadata">The lead agent prepares a draft using your brief and the selected inputs. You choose a reviewer after the result arrives. Sending, publishing and editing workspace records require separate actions.</p>
      </section><div tabIndex={-1} ref={sourcesHeading}><WorkSourceList sources={draft.sources} checks={checks.rows} locked={locked}
        inspect={(key,button) => choosePanel({kind:'inspect',key},button)} choose={button => choosePanel({kind:'choose'},button)}
        remove={key => patch({sources:draft.sources.filter(s => homeReferenceKey(s.reference) !== key)})}/></div></div>
      {draft.sources.length > MAX_WORK_SOURCES && <p className="notice" role="status">All {draft.sources.length} selections are kept. Choose up to {MAX_WORK_SOURCES} for this assignment.</p>}
      {checks.error && <p role="alert" className="notice">{checks.error} <button onClick={checks.refresh}>Retry Source Check</button></p>}
      {!!draft.sources.length && draft.sources.length <= MAX_WORK_SOURCES && !checks.error && !checks.rows && <p role="status">Checking source versions and access…</p>}
      {error && <p role="alert" className="notice warning">{error}</p>}
      {draft.planConflict && <div className="notice" role="status"><p>The saved assignment changed. Your brief and source choices are kept here.</p>
        <div className="button-row"><button onClick={() => {if (retain()) onOpenWork(libraryAssignmentId(draft.id));}}>Open Saved Assignment</button>
          <button onClick={keepCopy}>Keep Separate Draft</button></div></div>}
      {draft.pending && <p role="status">Your original request is kept. Continue to check its saved work.</p>}
      <footer className="work-prepare-footer"><small role="status">{keepError ? 'Open Changes Need Saving' : 'Draft Kept On This Device'}</small>
        <div className="button-row"><button disabled={busy} onClick={() => { if (retain()) onReturnToLibrary(draft.origin); }}>Keep Draft</button>
          <button className="primary" disabled={busy || !!keepError || (!draft.pending && !draft.attemptId && !canStart)} onClick={() => void launch()}>
            {busy ? 'Checking Work…' : draft.attemptId ? 'Open Existing Work' : draft.pending ? 'Continue Original Request' : 'Start Work'}</button></div></footer>
    </>}
  </div>;
}
