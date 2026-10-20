import { projectIsDeleted } from '../../../packages/domain/project-organization';
import { ProjectOrganizationDialog } from './ProjectOrganizationDialog';
import { LoadingRing } from './ModuleLoading';
import { assistantSpace, type AssistantSpace } from '../../../packages/domain/assistant-space';
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProjectSetupStage } from './project-manager-view';
import { lazy } from './preload-lazy';
import type { Attachment, Entity, Project, Snapshot } from '../../../packages/domain/contracts';
import { retainedWindowId, useRetained } from './useWorkspace';
import { finishProjectDraftIdentity, readProjectDraftIdentity, retainProjectDraftIdentity, retainProjectDraftLocation, type ProjectDraftIdentity } from './project-editor-draft';
import { registerRecordDraftNavigation } from './record-draft-navigation';
import { useAttachments } from './useAttachments';
import { Dialog, Empty } from './ui';
import { File, Folder, Paperclip, X } from './icons';

const GitHubRepositoryPicker = lazy(() => import('./GitHubRepositoryPicker').then(m => ({ default:m.GitHubRepositoryPicker })));

type Form = Project & { attachments: Attachment[] };
const form = (value?: Project): Form => ({ name: '', purpose: '', ...value, attachments: value?.attachments ?? [] });
type Props = { snapshot: Snapshot; projectId?: string; space?: AssistantSpace; close: () => void | boolean; saved: (id?: string) => void; refresh: () => Promise<void>; embedded?: boolean; stage?: ProjectSetupStage; setStage?: (stage: ProjectSetupStage) => void };
function ProjectEditorFrame({ embedded, title, close, children }: { embedded?: boolean; title: string; close: () => void; children: ReactNode }) {
  return embedded ? <section className="project-editor-embedded" aria-label={title}>{children}</section> : <Dialog title={title} close={close}>{children}</Dialog>;
}
export function ProjectEditor(props: Props) {
  const scope = `${props.snapshot.epoch}:${props.snapshot.deviceId}:${props.projectId ?? 'new'}:${props.space ?? 'chat'}`;
  const prepare = (identity?: ProjectDraftIdentity) => {
    try {
      identity ??= readProjectDraftIdentity({ ...props.snapshot, windowId: retainedWindowId, space: props.space ?? 'chat', projectId: props.projectId });
      retainProjectDraftIdentity(identity);
      return { identity, error: '', scope };
    } catch (error) { return { identity, error: error instanceof Error ? error.message : 'This browser could not read the kept Project draft.', scope }; }
  };
  const [prepared, setPrepared] = useState(() => prepare());
  if (prepared.scope !== scope) return <ProjectEditorFrame embedded={props.embedded} title="Project Draft" close={props.close}><Empty title="This Project belongs to an earlier workspace">Its original writing is kept. Close this view and reopen the Project.</Empty></ProjectEditorFrame>;
  if (prepared.error || !prepared.identity) return <ProjectEditorFrame embedded={props.embedded} title="Project Draft" close={props.close}><p role="alert">{prepared.error}</p><p>Existing writing is unchanged. Free browser storage or restore access, then try opening the same draft again.</p><div className="dialog-footer"><button type="button" onClick={props.close}>Close</button><button type="button" onClick={() => setPrepared(prepare(prepared.identity))}>Try opening again</button></div></ProjectEditorFrame>;
  return <RetainedProjectEditor {...props} identity={prepared.identity}/>;
}
export function RetainedProjectEditor({ snapshot, projectId, space = 'chat', close, saved, refresh, identity, embedded, stage = 'details', setStage }: Props & { identity: ProjectDraftIdentity }) {
  const [organizing, setOrganizing] = useState(false);
  const id = identity.id;
  const entity = snapshot.projects.find(project => project.id === id), initial = useMemo(() => form({ name: '', purpose: '', space, ...(space === 'work' ? { workspace: { folder: '', environment: 'local' } } : {}) }), [id, space]);
  const current = useMemo(() => entity ? { ...entity, value: form(entity.value) } : undefined, [entity]);
  const editor = useRetained<Form>('project', id, initial, current, snapshot, refresh, { autoSave: false, initialJournal: identity.initialJournal });
  const uploads = useAttachments(snapshot, editor.value, editor.change, `project-sources:${id}:${retainedWindowId}`, 'Project');
  const currentEditor = useRef(editor); currentEditor.current = editor;
  const chooser = useRef(0);
  const input = useRef<HTMLInputElement>(null), [error, setError] = useState(''), [repositoryPicker,setRepositoryPicker] = useState(space === 'work' && !projectId);
  const unavailable = !!projectId && (!entity || projectIsDeleted(snapshot, id));
  const availability = useRef(unavailable); availability.current = unavailable;
  const saving = useRef(false), blocked = unavailable || editor.saving || !!editor.pending || !!editor.conflict;
  const scope = `${snapshot.deviceId}:${snapshot.epoch}:${id}`;
  const owner = useRef({ scope, mounted: true, generation: 0 });
  if (owner.current.scope !== scope) { owner.current.scope = scope; owner.current.generation++; }
  useEffect(() => { owner.current.mounted = true; owner.current.generation++; return () => { owner.current.mounted = false; owner.current.generation++; }; }, [scope]);
  const retain = () => {
    if (!owner.current.mounted || owner.current.scope !== scope) return false;
    try {
      if (uploads.staging) throw Error('Wait for the selected files to be kept before leaving this Project.');
      retainProjectDraftLocation(identity);
      if ((editor.dirty || editor.pending || editor.storageError) && !editor.retainNow()) throw Error('Free browser storage before leaving this Project. Your writing remains in this window.');
      setError(''); return true;
    } catch (error) { setError(error instanceof Error ? error.message : 'This Project could not be kept yet.'); return false; }
  };
  const guard = useRef(retain); guard.current = retain;
  useEffect(() => {
    const unregister = registerRecordDraftNavigation(() => guard.current());
    const beforeUnload = (event: BeforeUnloadEvent) => { if (!guard.current()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { unregister(); window.removeEventListener('beforeunload', beforeUnload); };
  }, [scope]);
  const leave = () => { if (retain() && close() !== false) { owner.current.mounted = false; owner.current.generation++; } };
  const save = async () => {
    if (availability.current || saving.current || uploads.staging || uploads.pending.length || editor.conflict || !retain()) return;
    const generation = owner.current.generation;
    const owns = () => owner.current.mounted && owner.current.scope === scope && owner.current.generation === generation;
    saving.current = true; setError('');
    try {
      // A prior host save may be acknowledged while refreshing or removing the
      // local pointer failed. Finish it locally instead of creating a new POST.
      const acknowledged = editor.revision > 0 && !editor.dirty && !editor.pending;
      if (acknowledged) await refresh();
      const result = acknowledged ? true : await editor.flush();
      if (result && owns()) {
        if (!editor.retainNow()) { setError('The Project is saved on the host. Free browser storage, then finish keeping it here.'); return; }
        if (editor.hasUnsentChanges()) { setError('The original save is confirmed. Your newer edits are kept; save them when ready.'); return; }
        finishProjectDraftIdentity(identity);
        saved(id);
      }
    } catch (error) { if (owns()) setError(error instanceof Error ? error.message : 'The Project is kept. Try finishing its save again.'); }
    finally { saving.current = false; }
  };
  const desktop = (window as Window & { novaDesktop?: { chooseWorkingFolder: () => Promise<string | null> } }).novaDesktop;
  const isWork = assistantSpace(editor.value) === 'work';
  const staged = !!embedded && !projectId && !isWork && !editor.value.attachments.length && !uploads.pending.length && !editor.pending && !editor.conflict;
  const details = !staged || stage === 'details', instructions = !staged || stage === 'instructions';
  const advance = (next: ProjectSetupStage) => { if (retain()) setStage?.(next); };
  const chooseFolder = async () => {
    if (!desktop) return;
    const ticket = ++chooser.current, generation = owner.current.generation, previous = currentEditor.current.value.workspace?.folder ?? '';
    const owns = () => owner.current.mounted && owner.current.scope === scope && owner.current.generation === generation && chooser.current === ticket;
    try {
      const folder = await desktop.chooseWorkingFolder();
      if (!owns() || availability.current || !folder) return;
      if ((currentEditor.current.value.workspace?.folder ?? '') !== previous || currentEditor.current.pending || currentEditor.current.saving || currentEditor.current.conflict) { setError('Your newer Project changes are kept. Open the folder chooser again when ready.'); return; }
      currentEditor.current.change(value => ({ ...value, workspace: { folder, environment: value.workspace?.environment ?? 'local' } }));
    } catch { if (owns()) setError('The folder chooser could not open. Enter its path above.'); }
  };
  const host = editor.conflict?.current as Entity<Form> | undefined;
  if (organizing && entity) return <ProjectOrganizationDialog snapshot={snapshot} project={entity} refresh={refresh} close={() => setOrganizing(false)}/>;
  return <ProjectEditorFrame embedded={embedded} title={projectId ? 'Project Settings' : space === 'work' ? 'Create A Work Project' : 'Create A Chat Project'} close={leave}>
    {unavailable && <p role="status">{entity ? 'This Project Is In Deleted.' : 'This Project Is Unavailable.'} Your Kept Writing Is Shown Below. Restore The Project Before Saving Changes.</p>}
    <form onSubmit={event => { event.preventDefault(); if (staged && stage !== 'review') advance(stage === 'details' ? 'instructions' : 'review'); else void save(); }}>
      {staged && <div className="project-setup-steps" role="group" aria-label="Project Setup Steps">{(['details', 'instructions', 'review'] as const).map(step => <button type="button" key={step} aria-pressed={stage === step} disabled={step !== 'details' && !editor.value.name.trim()} onClick={() => advance(step)}>{step === 'details' ? 'Details' : step === 'instructions' ? 'Instructions' : 'Review'}</button>)}</div>}
      <fieldset disabled={blocked}>{details && <label>Project name<input autoFocus required maxLength={100} value={editor.value.name} onChange={event => editor.change(value => ({ ...value, name: event.target.value }))}/></label>}
      {isWork ? <><div className="work-source-options"><button type="button" aria-pressed={repositoryPicker} onClick={()=>setRepositoryPicker(true)}>GitHub repository</button><button type="button" aria-pressed={!repositoryPicker} onClick={()=>setRepositoryPicker(false)}>Host folder</button></div>{repositoryPicker ? <Suspense fallback={<LoadingRing label="Opening repositories…"/>}><GitHubRepositoryPicker epoch={snapshot.epoch} deviceId={snapshot.deviceId} projectId={id} onSelect={checkout=>{if(!owner.current.mounted || owner.current.scope!==scope || availability.current)return false;const kept=editor.change(value=>({...value,name:value.name.trim()?value.name:checkout.repository.fullName.split("/")[1],workspace:{folder:checkout.folder,environment:"local"}}));if(kept)setRepositoryPicker(false);return kept;}}/></Suspense> : <div className="project-folder-field">
        <label htmlFor={`${id}:source-folder`}>Source folder</label>
        <div className="project-folder-input"><input id={`${id}:source-folder`} required value={editor.value.workspace?.folder ?? ''} onChange={event => editor.change(value => ({ ...value, workspace: { environment: value.workspace?.environment ?? 'local', folder: event.target.value } }))} placeholder="Path to your project folder"/>{desktop && <button type="button" className="icon-button" aria-label="Choose source folder" title="Choose source folder" onClick={() => void chooseFolder()}><Folder size={20}/></button>}</div>
      <p className="metadata work-host-location">This folder belongs to the computer or server running Nova.</p></div>}</> : <>
      {details && <label>Purpose & context<textarea rows={3} maxLength={10000} value={editor.value.purpose} onChange={event => editor.change(value => ({ ...value, purpose: event.target.value }))} placeholder="What are you working toward?"/></label>}
      {instructions && <label>Project instructions<textarea rows={2} maxLength={10000} value={editor.value.instructions ?? ''} onChange={event => editor.change(value => ({ ...value, instructions: event.target.value }))} placeholder="How should Nova use these sources and respond in this Project?"/></label>}
      {staged && stage === 'review' && <div className="project-setup-review"><h4>{editor.value.name}</h4><p className="preserve-lines">{editor.value.purpose || 'No Purpose Added'}</p><p className="preserve-lines">{editor.value.instructions || 'No Shared Instructions Added'}</p><p className="metadata">Create This Project, Then Add Shared Files. Your Current Conversation Stays Where It Is.</p></div>}
      {!staged && <><div className="section-heading project-source-heading"><h3>Source files</h3><button type="button" disabled={editor.value.attachments.length + uploads.pending.length >= 10} onClick={() => input.current?.click()}><Paperclip size={17}/>Add attachments</button></div>
      <input ref={input} hidden type="file" multiple aria-label="Project attachments" onChange={event => { void uploads.add(event.target.files); event.target.value = ''; }}/>
      <p className="metadata">Included with future text messages in this Project. Removing a file keeps earlier messages and their captured sources intact.</p>
      <div className="project-source-files">{editor.value.attachments.map(file => <div className="source-link" key={file.id}><a href={`/api/attachments/${file.id}`}><File size={17}/>{file.name}</a><button className="icon-button" type="button" aria-label={`Remove ${file.name} from Project`} onClick={() => editor.change(value => ({ ...value, attachments: value.attachments.filter(item => item.id !== file.id) }))}><X size={17}/></button></div>)}</div>
      </>}
      </>}
      {uploads.pending.map(file => <div className="upload" key={file.id}><span>{file.name}</span><span className="metadata">{uploads.errors[file.id] || 'Uploading…'}</span>{uploads.errors[file.id] && <button type="button" onClick={() => void uploads.retry(file)}>Retry upload</button>}<button type="button" onClick={() => void uploads.remove(file.id)}>Remove</button></div>)}
      {uploads.notice && <p role="status" className="field-error">{uploads.notice}</p>}</fieldset>
      {editor.conflict && <section className="notice warning" role="alert"><div><strong>Review Project changes</strong><p>{editor.conflict.message}</p>{host && <details><summary>Current saved Project</summary><h3>{host.value.name}</h3><p className="preserve-lines">{host.value.purpose}</p>{host.value.attachments?.map(file => <p key={file.id}>{file.name}</p>)}</details>}<div className="button-row"><button type="button" disabled={unavailable} onClick={editor.editProposal}>Continue with my changes</button><button type="button" disabled={unavailable} onClick={editor.discard}>Use saved version</button></div></div></section>}
      {(editor.storageError || editor.networkError || error) && <p role="alert" className="field-error">{error || editor.status}</p>}
      <div className="dialog-footer">{entity && <button type="button" className="text-button" disabled={blocked || uploads.staging || uploads.pending.length > 0} onClick={() => { if (retain()) setOrganizing(true); }}>{projectIsDeleted(snapshot, entity.id) ? 'Restore project' : 'Move project to Deleted'}</button>}<button type="button" onClick={leave}>Keep for later</button><button className="primary" disabled={unavailable || editor.saving || !!editor.conflict || uploads.staging || uploads.pending.length > 0 || !editor.value.name.trim() || isWork && !editor.value.workspace?.folder.trim()}>{staged && stage !== 'review' ? 'Continue' : editor.saving ? 'Saving…' : editor.pending ? 'Reconcile save' : projectId ? 'Save Project' : 'Create Project'}</button></div>
    </form>
  </ProjectEditorFrame>;
}
