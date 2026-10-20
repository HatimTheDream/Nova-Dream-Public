import type { Attachment } from '../../../packages/domain/contracts';
import { assistantAttachmentIssue } from '../../../packages/domain/assistant-attachments';
import { File } from './icons';

export function sourceFileSize(size: number) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
/** Read-only rows. Preview always receives the captured object, never a lookup by name. */
export function sourceFileRows(files: readonly Attachment[], openFile?: (file: Attachment) => void, nextMessage = false) {
  return files.map(file => {
    const issue = nextMessage ? assistantAttachmentIssue(file) : undefined;
    return <div className="workspace-source-item" key={`${file.id}:${file.sha256}`}>
      <div className="workspace-source-row"><a className="source-link" href={`/api/attachments/${encodeURIComponent(file.id)}`}><File size={16}/><span>{file.name}<small>{sourceFileSize(file.size)} · {nextMessage ? issue ? 'Needs Attention Before Sending' : 'Supported File Format' : 'Saved File Version'}</small></span></a>{openFile && <button onClick={() => openFile(file)} aria-label={`Preview ${file.name}`}>Preview</button>}</div>
      {issue && <p className="field-error">{issue}</p>}
    </div>;
  });
}
