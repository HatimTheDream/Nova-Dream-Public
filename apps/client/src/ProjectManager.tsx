import { useEffect, useRef, useState } from 'react';
import type { Attachment, Snapshot } from '../../../packages/domain/contracts';
import type { Conversation } from '../../../packages/domain/assistant';
import { assistantSpace } from '../../../packages/domain/assistant-space';
import { projectIsDeleted } from '../../../packages/domain/project-organization';
import { ProjectEditor } from './ProjectEditor';
import { ProjectOrganizationDialog } from './ProjectOrganizationDialog';
import { mayLeaveRecordDrafts } from './record-draft-navigation';
import { retainedWindowId } from './useWorkspace';
import { keepProjectManager, readProjectManager, requestProjectManager, type ProjectManagerOwner, type ProjectManagerRequest, type ProjectManagerSelection } from './project-manager-view';
import { ArrowLeft, Folder, Plus } from './icons';
import { Empty } from './ui';
import './project-manager.css';
import { sourceFileRows } from './source-file-rows';

type Props = {
  snapshot: Snapshot; conversations: Conversation[]; draftId: string; conversationId: string | null;
  space: 'chat' | 'work'; request?: ProjectManagerRequest; openFile?: (file: Attachment, projectId: string) => void; refresh: () => Promise<void>; close: () => void;
};
export function ProjectManager({ snapshot, conversations, draftId, conversationId, space, request, openFile, refresh, close }: Props) {
  const scope = { epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId: retainedWindowId, draftId, conversationId, space };
  const signature = JSON.stringify(scope);
  const read = (applyRequest = true) => {
    try {
      const original = readProjectManager(scope);
      return { owner: applyRequest && request ? requestProjectManager(original, request) : original, error: '', signature };
    } catch (error) { return { owner: undefined, error: error instanceof Error ? error.message : 'The Projects view could not be read.', signature }; }
  };
  const [state, setState] = useState(read);
  const current = useRef(state); current.current = state;
  const mounted = useRef(true);
  const editorSpaces = useRef(new Map<string, 'chat' | 'work'>());
  const [error, setError] = useState('');
  const [organizing, setOrganizing] = useState<string>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const owns = (original: ProjectManagerOwner) => mounted.current && current.current.signature === signature && current.current.owner === original;
  const move = (selected: ProjectManagerSelection, filter = state.owner?.view.filter ?? 'all', savedOwner?: ProjectManagerOwner) => {
    const original = savedOwner ?? current.current.owner;
    if (!original || !owns(original) || !savedOwner && !mayLeaveRecordDrafts()) return false;
    try {
      const next = { ...state, owner: keepProjectManager(original, { selected, filter }), error: '' };
      current.current = next; setState(next); setError(''); return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'The Projects view could not be kept.'); return false; }
  };
  useEffect(() => {
    const original = current.current.owner;
    if (!request || !original || original.view.requestId === request.requestId || !owns(original)) return;
    if (!mayLeaveRecordDrafts()) { setError('Keep the current Project writing before opening another view.'); return; }
    try {
      const next = { ...current.current, owner: requestProjectManager(original, request) };
      current.current = next; setState(next); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'The requested Projects view could not be kept.'); }
  }, [request?.requestId, signature]);
  const leave = () => { if (mayLeaveRecordDrafts()) close(); };
  if (state.signature !== signature) return <Empty title="The Original Projects View Is Kept">Return to the original conversation to reopen it.</Empty>;
  if (!state.owner) return <div className="project-manager"><p role="alert">{state.error}</p><div className="button-row"><button onClick={close}>Back To Conversation</button><button onClick={() => setState(read())}>Try Opening Again</button></div></div>;
  const owner = state.owner, { filter, selected } = owner.view;
  const project = selected.kind === 'project' ? snapshot.projects.find(p => p.id === selected.id) : undefined;
  const deleted = !!project && projectIsDeleted(snapshot, project.id);
  if (project && (selected.kind !== 'project' || selected.tab !== 'settings' || !editorSpaces.current.has(project.id))) editorSpaces.current.set(project.id, assistantSpace(project.value));
  const list = snapshot.projects.filter(p => filter === 'deleted' ? projectIsDeleted(snapshot, p.id) : !projectIsDeleted(snapshot, p.id) && (filter === 'all' || assistantSpace(p.value) === filter));
  const heading = selected.kind === 'create' ? `New ${selected.space === 'chat' ? 'Chat' : 'Work'} Project` : project?.value.name ?? 'Projects';
  const backToList = () => move({ kind: 'list' });
  const saved = (id?: string) => {
    if (id && owns(owner)) move({ kind: 'project', id, tab: 'overview' }, filter, owner);
  };
  return <div className="project-manager">
    <div className="project-manager-toolbar"><button className="text-button" onClick={leave}><ArrowLeft size={17}/>Back To Conversation</button>{selected.kind !== 'list' && <button onClick={backToList}>All Projects</button>}</div>
    <div className="section-heading"><h3>{heading}{selected.kind === 'list' && <span className="metadata"> · {list.length}</span>}</h3>{selected.kind === 'list' && <button className="primary" onClick={() => move({ kind: 'create', space, stage: 'details' })}><Plus size={17}/>New Project</button>}</div>
    {error && <div role="alert" className="field-error"><p>{error}</p><button onClick={() => { if (!mayLeaveRecordDrafts()) return; const next = read(false); current.current = next; setState(next); setError(''); }}>Reopen Kept View</button></div>}
    {selected.kind === 'list' ? <>
      <div className="project-manager-tabs" role="group" aria-label="Filter Projects">{(['all', 'chat', 'work', 'deleted'] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => move({ kind: 'list' }, value)}>{({ all: 'All', chat: 'Chat', work: 'Work', deleted: 'Deleted' })[value]}</button>)}</div>
      {!list.length ? <Empty title={filter === 'deleted' ? 'No Deleted Projects' : 'No Projects Here'}>Projects keep related conversations and their shared context together.</Empty> : <div className="project-manager-list">{list.map(p => <button className="project-manager-card" key={p.id} onClick={() => move({ kind: 'project', id: p.id, tab: 'overview' })}><Folder size={20}/><span><strong>{p.value.name}</strong><small>{assistantSpace(p.value) === 'work' ? 'Work' : 'Chat'} · {conversations.filter(c => c.projectId === p.id).length} Conversations</small>{p.value.purpose && <span>{p.value.purpose}</span>}</span></button>)}</div>}
    </> : selected.kind === 'create' ? <>
      <div className="project-manager-tabs" role="group" aria-label="Project Kind">{(['chat', 'work'] as const).map(value => <button key={value} aria-pressed={selected.space === value} onClick={() => move({ kind: 'create', space: value, stage: 'details' })}>{value === 'chat' ? 'Chat' : 'Work'}</button>)}</div>
      <ProjectEditor key={`${signature}:new:${selected.space}`} embedded stage={selected.stage} setStage={stage => move({ ...selected, stage })} snapshot={snapshot} space={selected.space} close={() => move({ kind: 'list' }, filter, owner)} saved={saved} refresh={refresh}/>
    </> : <>
      {deleted && <p className="notice">This Project Is In Deleted. Restore It To Make Changes.</p>}
      {project && <div className="project-manager-tabs" role="group" aria-label="Project Sections">{(['overview', 'sources', 'settings'] as const).map(tab => <button key={tab} disabled={deleted && tab === 'settings' && selected.tab !== 'settings'} aria-pressed={selected.tab === tab} onClick={() => move({ ...selected, tab })}>{tab === 'sources' ? assistantSpace(project.value) === 'work' ? 'Workspace' : 'Sources' : tab === 'overview' ? 'Overview' : 'Settings'}</button>)}</div>}
      {selected.tab === 'settings' ? <ProjectEditor key={`${signature}:${selected.id}`} embedded snapshot={snapshot} projectId={selected.id} space={editorSpaces.current.get(selected.id) ?? space} close={() => move({ ...selected, tab: 'overview' }, filter, owner)} saved={saved} refresh={refresh}/> : !project ? <Empty title="This Project Is Unavailable">Its saved reference and kept writing remain unchanged.</Empty> : selected.tab === 'sources' ? <section className="project-manager-details">
        {assistantSpace(project.value) === 'work' ? <><h4>Host Workspace</h4><p className="preserve-lines">{project.value.workspace?.folder || 'No Host Folder Saved'}</p><p className="metadata">This path belongs to Nova’s host. Opening this view does not prepare a checkout or start work.</p></> : <><h4>Saved Project Sources</h4><p className="metadata">These files apply to future messages. Earlier replies keep their captured versions.</p>{project.value.attachments?.length ? sourceFileRows(project.value.attachments, openFile ? file => openFile(file, project.id) : undefined, true) : <p>No Shared Files Yet</p>}</>}
        {!deleted && <button onClick={() => move({ ...selected, tab: 'settings' })}>Manage {assistantSpace(project.value) === 'work' ? 'Workspace' : 'Sources'}</button>}
      </section> : <section className="project-manager-details"><p className="metadata">{assistantSpace(project.value) === 'work' ? 'Work' : 'Chat'} Project · Saved Revision {project.revision}</p>{project.value.purpose && <p className="preserve-lines">{project.value.purpose}</p>}{project.value.instructions && <><h4>Shared Instructions</h4><p className="preserve-lines">{project.value.instructions}</p></>}<p>{conversations.filter(c => c.projectId === project.id).length} Conversations</p><div className="button-row">{!deleted && <button onClick={() => move({ ...selected, tab: 'settings' })}>Edit Project</button>}<button onClick={() => { if (mayLeaveRecordDrafts()) setOrganizing(project.id); }}>{deleted ? 'Restore Project' : 'Move To Deleted'}</button></div></section>}
    </>}
    {organizing && snapshot.projects.some(p => p.id === organizing) && <ProjectOrganizationDialog snapshot={snapshot} project={snapshot.projects.find(p => p.id === organizing)!} refresh={refresh} close={() => setOrganizing(undefined)}/>}
  </div>;
}
