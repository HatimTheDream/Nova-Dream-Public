import type { AssistantOperation, Conversation } from '../../../packages/domain/assistant';
import type { Attachment, Draft, Snapshot } from '../../../packages/domain/contracts';
import type { MemoryState } from '../../../packages/domain/memory';
import { sourceFileRows } from './source-file-rows';
import { assistantAttachmentIssue } from '../../../packages/domain/assistant-attachments';
import './conversation-context.css';

export function ConversationSources({ memory, operations, conversation, snapshot, draft, editProject, operationId, openFile }: { operationId?: string; openFile?: (file: Attachment) => void; memory?: MemoryState; operations: AssistantOperation[]; conversation?: Conversation; snapshot: Snapshot; draft: Draft; editProject: (id: string) => void }) {
  const next = operationId === undefined;
  const captured = next ? undefined : operations.find(operation => operation.id === operationId);
  const projectId = conversation?.projectId ?? draft.projectId, current = snapshot.projects.find(project => project.id === projectId);
  const project = next ? current && { ...current.value, revision: current.revision } : captured?.context.project;
  const files = next ? [...new Map([...(current?.value.attachments ?? []), ...draft.attachments].map(file => [file.id, file])).values()] : captured?.context.attachments ?? [];
  const projectFiles = next ? files.filter(file => current?.value.attachments?.some(source => source.id === file.id)) : [];
  const draftFiles = next ? files.filter(file => !projectFiles.some(source => source.id === file.id)) : [];
  const issues = next ? files.filter(file => assistantAttachmentIssue(file)).length : 0;
  const memories = next ? memory?.entries.filter(entry => entry.projectId === null || entry.projectId === projectId) : captured?.context.memory?.entries;
  const inherited = captured?.steerTarget ? operations.find(operation => operation.id === captured.steerTarget)?.context.attachments ?? [] : [];
  return <div className="conversation-sources">
    {!next && !captured ? <p className="metadata" role="status">This reply’s captured sources are unavailable.</p> : <>
      {project ? <><h3>{project.name}</h3>{project.purpose && <p className="preserve-lines">{project.purpose}</p>}{project.instructions && <><h3>Instructions</h3><p className="preserve-lines">{project.instructions}</p></>}{project.workspace && <><h3>Working folder</h3><p className="metadata">{'path' in project.workspace ? String(project.workspace.path ?? project.workspace.folder) : project.workspace.folder}</p><p className="metadata">{project.workspace.environment === 'worktree' ? 'Separate Git worktree per task' : 'Local folder'}</p></>}{next ? <><p className="metadata">Current Project Version {current!.revision}</p><button onClick={() => editProject(current!.id)}>Project Settings</button></> : <p className="metadata">Project version {project.revision}, captured when this {captured?.steerTarget ? 'direction' : 'reply'} was prepared. Status: {captured?.state}. Later Project changes do not alter this record.</p>}</> : next && projectId ? <p className="field-error" role="alert">This Project is unavailable. Choose another Project before sending.</p> : <p className="metadata">No Project context.</p>}
      {!!memories?.length && <details><summary>{memories.length} saved {memories.length === 1 ? 'memory' : 'memories'}</summary>{memories.map(entry => <p className="preserve-lines" key={entry.id}>{entry.text}</p>)}<p className="metadata">{next ? 'Manage saved memories from the conversation menu.' : 'The exact memories captured with this input.'}</p></details>}
      {next ? <>
        <h3>Files For The Next Message</h3><p className="metadata">{files.length} Of 10 Files{issues ? ` · ${issues} Need Attention` : ''}</p>
        {!!projectFiles.length && <section aria-label="Project Sources"><h4>Project Sources</h4><p className="metadata">Shared with this Project. A file also attached to the draft is included once.</p>{sourceFileRows(projectFiles, openFile, true)}</section>}
        {!!draftFiles.length && <section aria-label="Draft Attachments"><h4>Draft Attachments</h4><p className="metadata">Included with this message only.</p>{sourceFileRows(draftFiles, openFile, true)}</section>}
      </> : <><h3>{captured?.steerTarget ? 'Files added with this direction' : 'Captured Files'}</h3>{sourceFileRows(files, openFile)}</>}
      {!files.length && <p className="metadata">{next ? 'Add attachments through Plus or Project settings.' : 'No files attached to this message.'}</p>}
      {next && files.length > 10 && <p className="field-error" role="alert">{files.length} files selected. Each message supports up to 10 files including Project sources. Remove a draft attachment or update Project settings.</p>}
      {!!inherited.length && <><h3>Original reply’s files</h3><p className="metadata">The running reply already has these sources; steering does not attach them again.</p>{sourceFileRows(inherited, openFile)}</>}
      {next && !!current?.value.attachments?.length && <p className="metadata">Voice can use Project sources, including PDFs, images and larger text files through the managed Assistant’s file tools. Voice call details show availability and any format or size limits.</p>}
    </>}
  </div>;
}
