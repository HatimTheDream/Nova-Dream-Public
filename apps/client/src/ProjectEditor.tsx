import { projectIsDeleted } from '../../../packages/domain/project-organization';
import { ProjectOrganizationDialog } from './ProjectOrganizationDialog';
import { LoadingRing } from './ModuleLoading';
import { assistantSpace, type AssistantSpace } from '../../../packages/domain/assistant-space';
import { Suspense, useMemo, useRef, useState } from 'react';
import { lazy } from './preload-lazy';
import type { Attachment, Command, Entity, Project, Snapshot } from '../../../packages/domain/contracts';
import { readLocal, saveLocal } from './api';
import { retainedWindowId, useRetained } from './useWorkspace';
import { useAttachments } from './useAttachments';
import { Dialog, Empty } from './ui';
import { File, Folder, Paperclip, X } from './icons';

const GitHubRepositoryPicker = lazy(() => import('./GitHubRepositoryPicker').then(m => ({ default:m.GitHubRepositoryPicker })));

type Form = Project & { attachments: Attachment[] };
const form = (value?: Project): Form => ({ name: '', purpose: '', ...value, attachments: value?.attachments ?? [] });
export function ProjectEditor({ snapshot, projectId, space = 'chat', close, saved, refresh }: { snapshot: Snapshot; projectId?: string; space?: AssistantSpace; close: () => void; saved: () => void; refresh: () => Promise<void> }) {
  const [organizing, setOrganizing] = useState(false);
  const newKey = `e3:new-project:${snapshot.deviceId}:${retainedWindowId}:${space}`, legacyKey = `e3:project-editor:${snapshot.deviceId}`;
  const [id] = useState(() => {
    if (projectId) return projectId;
    const kept = readLocal<string>(newKey); if (typeof kept === 'string' && kept.startsWith('project:')) return kept;
    const legacy = space === 'chat' ? readLocal<{ value: Project; command?: Command }>(legacyKey) : undefined, next = legacy?.command?.entityId ?? `project:${crypto.randomUUID()}`;
    saveLocal(newKey, next);
    if (legacy) saveLocal(`e3:journal:${snapshot.deviceId}:${next}:${retainedWindowId}`, { value: form(legacy.value), revision: legacy.command?.expectedRevision ?? 0, epoch: legacy.command?.epoch ?? snapshot.epoch, dirty: true, pending: legacy.command });
    return next;
  });
  const entity = snapshot.projects.find(project => project.id === id), initial = useMemo(() => form({ name: '', purpose: '', space, ...(space === 'work' ? { workspace: { folder: '', environment: 'local' } } : {}) }), [id, space]);
  const current = useMemo(() => entity ? { ...entity, value: form(entity.value) } : undefined, [entity]);
  const editor = useRetained<Form>('project', id, initial, current, snapshot, refresh, { autoSave: false });
  const uploads = useAttachments(snapshot, editor.value, editor.change, `project-sources:${id}:${retainedWindowId}`, 'Project');
  const input = useRef<HTMLInputElement>(null), [error, setError] = useState(''), [repositoryPicker,setRepositoryPicker] = useState(space === 'work' && !projectId);
  const saving = useRef(false), blocked = editor.saving || !!editor.pending || !!editor.conflict;
  const save = async () => {
    if (saving.current || uploads.pending.length || editor.conflict) return;
    if (!editor.pending && !editor.change(value => value)) { setError('Free browser storage before saving this Project.'); return; }
    saving.current = true; setError('');
    try { const result = await editor.flush(); if (result) { if (!projectId) { localStorage.removeItem(newKey); localStorage.removeItem(legacyKey); } saved(); } }
    finally { saving.current = false; }
  };
  const desktop = (window as Window & { novaDesktop?: { chooseWorkingFolder: () => Promise<string | null> } }).novaDesktop;
  const isWork = assistantSpace(editor.value) === 'work';
  const host = editor.conflict?.current as Entity<Form> | undefined;
  if (organizing && entity) return <ProjectOrganizationDialog snapshot={snapshot} project={entity} refresh={refresh} close={() => setOrganizing(false)}/>;
  return <Dialog title={projectId ? 'Project settings' : space === 'work' ? 'Create a Work Project' : 'Create a Chat Project'} close={close}>
    {projectId && !entity ? <Empty title="This Project is unavailable">Your kept changes remain on this device.</Empty> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={blocked}><label>Project name<input autoFocus required maxLength={100} value={editor.value.name} onChange={event => editor.change(value => ({ ...value, name: event.target.value }))}/></label>
      {isWork ? <><div className="work-source-options"><button type="button" aria-pressed={repositoryPicker} onClick={()=>setRepositoryPicker(true)}>GitHub repository</button><button type="button" aria-pressed={!repositoryPicker} onClick={()=>setRepositoryPicker(false)}>Host folder</button></div>{repositoryPicker ? <Suspense fallback={<LoadingRing label="Opening repositories…"/>}><GitHubRepositoryPicker epoch={snapshot.epoch} deviceId={snapshot.deviceId} projectId={id} onSelect={checkout=>{const kept=editor.change(value=>({...value,name:value.name.trim()?value.name:checkout.repository.fullName.split("/")[1],workspace:{folder:checkout.folder,environment:"local"}}));if(kept)setRepositoryPicker(false);return kept;}}/></Suspense> : <div className="project-folder-field">
        <label htmlFor={`${id}:source-folder`}>Source folder</label>
        <div className="project-folder-input"><input id={`${id}:source-folder`} required value={editor.value.workspace?.folder ?? ''} onChange={event => editor.change(value => ({ ...value, workspace: { environment: value.workspace?.environment ?? 'local', folder: event.target.value } }))} placeholder="Path to your project folder"/>{desktop && <button type="button" className="icon-button" aria-label="Choose source folder" title="Choose source folder" onClick={() => { void desktop.chooseWorkingFolder().then(folder => { if (folder) editor.change(value => ({ ...value, workspace: { folder, environment: value.workspace?.environment ?? 'local' } })); }).catch(() => setError('The folder chooser could not open. Enter its path above.')); }}><Folder size={20}/></button>}</div>
      <p className="metadata work-host-location">This folder belongs to the computer or server running Nova.</p></div>}</> : <>
      <label>Purpose & context<textarea rows={3} maxLength={10000} value={editor.value.purpose} onChange={event => editor.change(value => ({ ...value, purpose: event.target.value }))} placeholder="What are you working toward?"/></label>
      <label>Project instructions<textarea rows={2} maxLength={10000} value={editor.value.instructions ?? ''} onChange={event => editor.change(value => ({ ...value, instructions: event.target.value }))} placeholder="How should Nova use these sources and respond in this Project?"/></label>
      <div className="section-heading project-source-heading"><h3>Source files</h3><button type="button" disabled={editor.value.attachments.length + uploads.pending.length >= 10} onClick={() => input.current?.click()}><Paperclip size={17}/>Add attachments</button></div>
      <input ref={input} hidden type="file" multiple aria-label="Project attachments" onChange={event => { void uploads.add(event.target.files); event.target.value = ''; }}/>
      <p className="metadata">Included with future text messages in this Project. Removing a file keeps earlier messages and their captured sources intact.</p>
      <div className="project-source-files">{editor.value.attachments.map(file => <div className="source-link" key={file.id}><a href={`/api/attachments/${file.id}`}><File size={17}/>{file.name}</a><button className="icon-button" type="button" aria-label={`Remove ${file.name} from Project`} onClick={() => editor.change(value => ({ ...value, attachments: value.attachments.filter(item => item.id !== file.id) }))}><X size={17}/></button></div>)}</div>
      </>}
      {uploads.pending.map(file => <div className="upload" key={file.id}><span>{file.name}</span><span className="metadata">{uploads.errors[file.id] || 'Uploading…'}</span>{uploads.errors[file.id] && <button type="button" onClick={() => void uploads.retry(file)}>Retry upload</button>}<button type="button" onClick={() => void uploads.remove(file.id)}>Remove</button></div>)}
      {uploads.notice && <p role="status" className="field-error">{uploads.notice}</p>}</fieldset>
      {editor.conflict && <section className="notice warning" role="alert"><div><strong>Review Project changes</strong><p>{editor.conflict.message}</p>{host && <details><summary>Current saved Project</summary><h3>{host.value.name}</h3><p className="preserve-lines">{host.value.purpose}</p>{host.value.attachments?.map(file => <p key={file.id}>{file.name}</p>)}</details>}<div className="button-row"><button type="button" onClick={editor.editProposal}>Continue with my changes</button><button type="button" onClick={editor.discard}>Use saved version</button></div></div></section>}
      {(editor.storageError || editor.networkError || error) && <p role="alert" className="field-error">{error || editor.status}</p>}
      <div className="dialog-footer">{entity && <button type="button" className="text-button" disabled={blocked || uploads.pending.length > 0} onClick={() => setOrganizing(true)}>{projectIsDeleted(snapshot, entity.id) ? 'Restore project' : 'Move project to Deleted'}</button>}<button type="button" onClick={close}>Keep for later</button><button className="primary" disabled={editor.saving || !!editor.conflict || uploads.pending.length > 0 || !editor.value.name.trim() || isWork && !editor.value.workspace?.folder.trim()}>{editor.saving ? 'Saving…' : editor.pending ? 'Reconcile save' : projectId ? 'Save Project' : 'Create Project'}</button></div>
    </form>}
  </Dialog>;
}
