import { useEffect, useState } from 'react';
import type { AssistantOutput, Conversation } from '../../../packages/domain/assistant';
import type { Attachment } from '../../../packages/domain/contracts';
import type { AssistantSpace } from '../../../packages/domain/assistant-space';
import type { WorkProjectDiff } from '../../../packages/domain/work-project';
import { File, Folder, List, Plus } from './icons';
import { request } from './api';
export type ConversationSource = { file: Attachment; origin: string };
export type ConversationSummaryProps = { space: AssistantSpace; conversation?: Conversation; outputs: AssistantOutput[]; sourceFiles: ConversationSource[]; openFile: (file: Attachment, output?: AssistantOutput) => void; openFiles: () => void; addFiles?: () => void; changes?: () => void; projectSettings?: () => void; projectFolder?: string };
export function ConversationSummary({ space, conversation, outputs, sourceFiles, openFile, openFiles, addFiles, changes, projectSettings, projectFolder }: ConversationSummaryProps) {
  const [view, setView] = useState<'environment' | 'outputs'>(() => space === 'work' ? 'environment' : 'outputs');
  const viewPicker = space === 'work' ? <select aria-label="Summary view" value={view} onChange={event => setView(event.target.value as 'environment' | 'outputs')}><option value="environment">Environment</option><option value="outputs">Outputs</option></select> : 'Outputs';
  const [diff, setDiff] = useState<WorkProjectDiff>(), [error, setError] = useState('');
  useEffect(() => {
    if (!conversation?.workspace) return;
    const abort = new AbortController();
    void request<WorkProjectDiff>(`assistant/work-changes/${conversation.id}`, undefined, abort.signal).then(value => { if (!abort.signal.aborted) setDiff(value); }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [conversation?.id, conversation?.nativeId]);
  const workspace = conversation?.workspace;
  return <div className="conversation-summary">
    {space === 'work' && view === 'environment' ? <section><h3>{viewPicker}</h3>
      {changes && <button onClick={changes}><List size={17}/><span>Changes</span>{diff && !diff.unavailableReason && <small className="change-count"><span>+{diff.additions}</span> −{diff.deletions}</small>}</button>}
      {(workspace || projectFolder) ? <><div className="summary-fact"><Folder size={17}/><span>{workspace?.environment === 'worktree' ? 'Worktree' : 'Source folder'}<small title={workspace?.path ?? workspace?.folder ?? projectFolder}>{workspace?.path ?? workspace?.folder ?? projectFolder}</small></span></div>{(diff?.branch || workspace?.branch) && <div className="summary-fact"><List size={17}/><span>{diff?.branch ?? workspace?.branch}</span></div>}{projectSettings && <button onClick={projectSettings}>Project settings</button>}</> : <p className="metadata">No project folder attached.</p>}
      {error && <p className="metadata" role="status">Changes couldn’t be checked. Open Review to retry.</p>}
    </section> : <section><h3>{viewPicker}</h3>{outputs.slice(-4).reverse().map(output => <button key={`${output.id}:${output.version}`} onClick={() => openFile(output.file!, output)}><File size={17}/><span title={output.name}>{output.name}</span><small>v{output.version}</small></button>)}{!outputs.length && <p className="metadata">No saved outputs yet.</p>}{outputs.length > 4 && <button onClick={openFiles}>View all outputs</button>}</section>}
    <section><h3>Sources{addFiles && <button className="icon-button" aria-label="Add source files" title="Add source files" onClick={addFiles}><Plus size={17}/></button>}</h3>{sourceFiles.slice(0, 3).map(({ file, origin }) => <button key={`${file.id}:${file.sha256}`} onClick={() => openFile(file)}><File size={17}/><span title={`${file.name} · ${origin}`}>{file.name}</span></button>)}{!sourceFiles.length && <p className="metadata">No attached files.</p>}{!!(sourceFiles.length || outputs.length) && <button onClick={openFiles}><Folder size={17}/>View all files</button>}</section>
  </div>;
}
export function ConversationFiles({ outputs, sourceFiles, openFile, addFiles }: Pick<ConversationSummaryProps, 'outputs' | 'sourceFiles' | 'openFile' | 'addFiles'>) {
  return <div className="conversation-file-list">{!!outputs.length && <section><h3>Outputs</h3>{outputs.slice().reverse().map(output => <button key={`${output.id}:${output.version}`} onClick={() => openFile(output.file!, output)}><File size={18}/><span>{output.name}<small>Version {output.version}</small></span></button>)}</section>}<section><h3>Sources{addFiles && <button className="text-button" onClick={addFiles}><Plus size={17}/>Add files</button>}</h3>{sourceFiles.map(({ file, origin }) => <button key={`${file.id}:${file.sha256}`} onClick={() => openFile(file)}><File size={18}/><span>{file.name}<small>{origin}</small></span></button>)}{!sourceFiles.length && <p className="metadata">No attached files.</p>}</section></div>;
}
