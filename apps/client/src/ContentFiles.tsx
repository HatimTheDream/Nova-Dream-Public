import { useEffect, useRef } from 'react';
import type { Attachment, Snapshot } from '../../../packages/domain/contracts';
import type { Content, RecordValue } from '../../../packages/domain/workspace-records';
import { useAttachments } from './useAttachments';
import { retainedWindowId } from './useWorkspace';
import { File, Paperclip, X } from './icons';

export function ContentFiles({ id, value, snapshot, change, pendingChanged }: { id: string; value: Content; snapshot: Snapshot; change(update: (value: RecordValue) => RecordValue): boolean; pendingChanged(value: boolean): void }) {
  const input = useRef<HTMLInputElement>(null);
  const uploads = useAttachments(snapshot, { attachments: value.assets ?? [] }, update => change(previous => ({ ...previous, assets: update({ attachments: (previous as Content).assets ?? [] }).attachments })), `content-sources:${id}:${retainedWindowId}`, 'Content draft');
  useEffect(() => { pendingChanged(uploads.staging || uploads.pending.length > 0); }, [uploads.staging, uploads.pending.length, pendingChanged]);
  return <section><div className="section-heading"><h3>Source files</h3><button type="button" disabled={(value.assets?.length ?? 0) + uploads.pending.length >= 10} onClick={() => input.current?.click()}><Paperclip size={17}/>Add attachments</button></div>
    <input ref={input} type="file" hidden multiple aria-label="Content attachments" onChange={event => { void uploads.add(event.target.files); event.target.value = ''; }}/>
    <p className="metadata">Files stay with this saved version. Assignment workers read complete TXT, Markdown, CSV and JSON files up to 64 KB each, 128 KB total.</p>
    {(value.assets ?? []).map(file => <div className="source-link" key={file.id}><a href={`/api/attachments/${file.id}`}><File size={17}/>{file.name}</a>{file.id !== value.source?.fileId && <button className="icon-button" type="button" aria-label={`Remove ${file.name} from Content`} onClick={() => change(previous => ({ ...previous, assets: ((previous as Content).assets ?? []).filter((item: Attachment) => item.id !== file.id) }))}><X size={17}/></button>}</div>)}
    {uploads.pending.map(file => <div className="upload" key={file.id}><span>{file.name}</span><span className="metadata">{uploads.errors[file.id] || 'Uploading…'}</span>{uploads.errors[file.id] && <button type="button" onClick={() => void uploads.retry(file)}>Retry upload</button>}<button type="button" onClick={() => void uploads.remove(file.id)}>Remove</button></div>)}
    {uploads.notice && <p role="status" className="field-error">{uploads.notice}</p>}
  </section>;
}
