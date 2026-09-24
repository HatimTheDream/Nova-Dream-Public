import { apiFailure, clientHeaders } from './api';
import type { Attachment } from '../../../packages/domain/contracts';
import { UseOutputInContent, type ContentOutputActions } from './ContentOutputs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, File } from './icons';
import type { AssistantOutput, Conversation, ConversationMessage, MessageAttachment } from '../../../packages/domain/assistant';
import type { AssistantController } from './useAssistant';
import './image-generation.css';

export { savedMessageOutput } from './saved-message-output';
import { savedMessageOutput } from './saved-message-output';

export function GeneratedOutput({ open, attachment, message, conversation, controller, epoch, blocked, refine, contentActions }: { open?: (file: Attachment, output?: AssistantOutput) => void; contentActions: ContentOutputActions; attachment: MessageAttachment; message: ConversationMessage; conversation: Conversation; controller: AssistantController; epoch: string; blocked: boolean; refine: (output: AssistantOutput) => Promise<void> }) {
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState('');
  const container = useRef<HTMLElement>(null);
  const objectUrl = useRef(''), pending = useRef<AbortController | undefined>(undefined);
  const nativeId = message.source?.nativeId ?? conversation.nativeId;
  const actionKey = JSON.stringify([epoch, conversation.id, nativeId, message.id, message.textHash, attachment.artifactId]);
  const actionScope = useRef({ key: actionKey, live: true, busy: false, canRefine: false });
  if (actionScope.current.key !== actionKey) { actionScope.current.live = false; actionScope.current = { key: actionKey, live: true, busy: false, canRefine: false }; }
  const scope = actionScope.current; scope.canRefine = !blocked && !conversation.archived;
  useEffect(() => { scope.live = true; setBusy(false); return () => { scope.live = false; }; }, [scope]);
  const output = attachment.artifactId ? savedMessageOutput(controller.outputs, conversation, message, attachment.artifactId) : undefined;
  const file = output?.file ?? (attachment.availability !== 'unavailable' ? attachment.localFile : undefined);
  const image = attachment.type === 'image' || attachment.mimeType?.startsWith('image/');
  useEffect(() => {
    setPreview(''); setLoading(false); setError('');
    return () => { pending.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; };
  }, [epoch, conversation.id, nativeId, attachment.artifactId, message.textHash, file?.id, file?.sha256]);
  const source = { epoch, conversationId: conversation.id, nativeId, messageId: message.id, messageHash: message.textHash, artifactId: attachment.artifactId };
  const loadImage = useCallback(async () => {
    pending.current?.abort();
    const abort = new AbortController(); pending.current = abort; setLoading(true); setError('');
    try {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]);
      const response = file ? await fetch(`/api/attachments/${file.id}?preview=1`, { signal, credentials: 'same-origin' }) : await fetch('/api/assistant/artifact/read', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...clientHeaders() }, body: JSON.stringify(source), signal });
      if (!response.ok) { const failure = await response.json(); throw apiFailure(failure, response.status); }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('Preview is unavailable for this format or image size. You can still save and download the original.'); }
      const blob = await response.blob(); if (abort.signal.aborted) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob); setPreview(objectUrl.current);
    } catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'This preview is unavailable.'); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }, [epoch, conversation.id, nativeId, message.id, message.textHash, attachment.artifactId, file?.id, file?.sha256]);
  useEffect(() => {
    if (!image || !file && attachment.availability === 'unavailable') return;
    const target = container.current;
    if (!target) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void loadImage(); }
    });
    observer.observe(target);
    return () => { observer.disconnect(); pending.current?.abort(); };
  }, [loadImage, image, attachment.availability]);
  const save = async () => {
    if (!scope.live || scope.busy) return;
    scope.busy = true; setBusy(true); setError('');
    try { await controller.saveArtifact(conversation, message, attachment); }
    catch (reason) { if (scope.live) setError(reason instanceof Error ? reason.message : 'The output save was not confirmed.'); }
    finally { scope.busy = false; if (scope.live) setBusy(false); }
  };
  const useImage = async (action: 'view' | 'download' | 'refine') => {
    if (!scope.live || scope.busy || action === 'refine' && !scope.canRefine) return;
    scope.busy = true; setBusy(true); setError('');
    try {
      const kept = output ?? (attachment.artifactId ? await controller.saveArtifact(conversation, message, attachment) : undefined);
      if (!scope.live || action === 'refine' && !scope.canRefine) return;
      const original = kept?.file ?? file;
      if (!original) throw new Error('The original image could not be retrieved. Please retry.');
      if (action === 'refine') { if (!kept) throw new Error('Save this output before refining it.'); await refine(kept); }
      else if (action === 'view') open?.(original, kept);
      else { const link = document.createElement('a'); link.href = `/api/attachments/${original.id}`; link.download = original.name; link.click(); }
    } catch (reason) { if (scope.live) setError(reason instanceof Error ? reason.message : 'The image action was not confirmed. Please retry.'); }
    finally { scope.busy = false; if (scope.live) setBusy(false); }
  };
  return <section ref={container} className={`generated-output ${image ? 'generated-image' : ''}`} aria-label={`Generated output: ${attachment.name}`}>
    <div className={image ? 'sr-only' : 'generated-output-title'}>{!image && <File size={20}/>}<strong title={attachment.name}>{attachment.name}</strong>{!image && output && <span className="metadata">v{output.version}</span>}</div>
    {image && loading && <p className="metadata" role="status">Loading image…</p>}
    {preview && <button type="button" className="generated-image-open" aria-label={`View image: ${attachment.name}`} disabled={!open || busy} onClick={() => void useImage('view')}><img className="generated-output-image" src={preview} alt={attachment.name} onError={() => { setError('The image could not be displayed. Its original remains available to download.'); setPreview(''); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; }}/></button>}
    {image ? <div className="generated-output-actions">
      {open && <button className="text-button" disabled={busy || !file && attachment.availability === 'unavailable'} onClick={() => void useImage('view')}>View image</button>}
      {file ? <a className="output-download text-button" download={file.name} href={`/api/attachments/${file.id}`}><Download size={16}/>Download</a> : <button className="text-button" disabled={busy || attachment.availability === 'unavailable'} onClick={() => void useImage('download')}><Download size={16}/>Download</button>}
      {(output || attachment.artifactId) && <button className="text-button" disabled={busy || blocked || conversation.archived || !file && attachment.availability === 'unavailable'} onClick={() => void useImage('refine')}>Refine</button>}
      {output && output.version > 1 && <span className="generated-image-version">v{output.version}</span>}
      {output?.file && <details className="output-action-disclosure"><summary>More</summary><div className="output-action-menu"><UseOutputInContent key={`${contentActions.snapshot.epoch}:${output.id}:${output.version}`} output={output} {...contentActions}/></div></details>}
      {!preview && !loading && <button className="text-button" disabled={!file && attachment.availability === 'unavailable'} onClick={() => void loadImage()}>Retry preview</button>}
    </div> : <div className="generated-output-actions">
      {file && open && <button onClick={() => open(file, output)}>Open file</button>}
      <details className="output-action-disclosure"><summary>More</summary><div className="output-action-menu">
        {file && <>{image && open && <button onClick={() => open(file, output)}>Open file</button>}<a className="output-download" href={`/api/attachments/${file.id}`}><Download size={16}/>Download</a></>}
        {output?.file ? <><button disabled={busy || blocked || conversation.archived} onClick={() => void refine(output)}>Refine</button><UseOutputInContent key={`${contentActions.snapshot.epoch}:${output.id}:${output.version}`} output={output} {...contentActions}/><span className="metadata">Original version kept</span></> : attachment.artifactId && <button disabled={busy || blocked || !file && attachment.availability === 'unavailable'} onClick={() => void save()}><Download size={16}/>{busy ? 'Saving output…' : 'Save output'}</button>}
      </div></details>
    </div>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
