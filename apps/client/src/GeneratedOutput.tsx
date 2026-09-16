import { apiFailure, clientHeaders } from './api';
import type { Attachment } from '../../../packages/domain/contracts';
import { UseOutputInContent, type ContentOutputActions } from './ContentOutputs';
import { useEffect, useRef, useState } from 'react';
import { Download, File } from './icons';
import type { AssistantOutput, Conversation, ConversationMessage, MessageAttachment } from '../../../packages/domain/assistant';
import type { AssistantController } from './useAssistant';

export function GeneratedOutput({ open, attachment, message, conversation, controller, epoch, blocked, refine, contentActions }: { open?: (file: Attachment, output?: AssistantOutput) => void; contentActions: ContentOutputActions; attachment: MessageAttachment; message: ConversationMessage; conversation: Conversation; controller: AssistantController; epoch: string; blocked: boolean; refine: (output: AssistantOutput) => Promise<void> }) {
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState('');
  const objectUrl = useRef(''), pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    setPreview(''); setLoading(false); setError('');
    return () => { pending.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; };
  }, [epoch, controller.connection.generation, controller.connection.state, conversation.nativeId, attachment.artifactId, message.textHash]);
  const output = controller.outputs.find(o => o.conversationId === conversation.id && o.nativeId === conversation.nativeId && o.messageId === message.id && o.messageHash === message.textHash && o.artifactId === attachment.artifactId && o.state === 'ready');
  const source = { epoch, conversationId: conversation.id, nativeId: conversation.nativeId, messageId: message.id, messageHash: message.textHash, artifactId: attachment.artifactId };
  const showImage = async () => {
    if (preview) { setPreview(''); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; return; }
    const abort = new AbortController(); pending.current = abort; setLoading(true); setError('');
    try {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]);
      const response = output?.file ? await fetch(`/api/attachments/${output.file.id}?preview=1`, { signal, credentials: 'same-origin' }) : await fetch('/api/assistant/artifact/read', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...clientHeaders() }, body: JSON.stringify(source), signal });
      if (!response.ok) { const failure = await response.json(); throw apiFailure(failure, response.status); }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('Preview is unavailable for this format or image size. You can still save and download the original.'); }
      const blob = await response.blob(); if (abort.signal.aborted) return;
      objectUrl.current = URL.createObjectURL(blob); setPreview(objectUrl.current);
    } catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'This preview is unavailable.'); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  };
  const save = async () => { setBusy(true); setError(''); try { await controller.saveArtifact(conversation, message, attachment); } catch (reason) { setError(reason instanceof Error ? reason.message : 'The output save was not confirmed.'); } finally { setBusy(false); } };
  return <section className="generated-output" aria-label={`Generated output: ${attachment.name}`}>
    <div className="generated-output-title"><File size={20}/><strong title={attachment.name}>{attachment.name}</strong>{output && <span className="metadata">v{output.version}</span>}</div>
    <div className="generated-output-actions">
      {(attachment.type === 'image' || attachment.mimeType?.startsWith('image/')) && <button disabled={loading} onClick={() => void showImage()}>{loading ? 'Loading preview…' : preview ? 'Hide preview' : 'Preview image'}</button>}
      {output?.file ? <>{open && <button onClick={() => open(output.file!, output)}>Open file</button>}<a className="output-download" href={`/api/attachments/${output.file.id}`}><Download size={16}/>Download</a><button disabled={busy || blocked || conversation.archived} onClick={() => void refine(output)}>Refine</button><UseOutputInContent key={`${contentActions.snapshot.epoch}:${output.id}:${output.version}`} output={output} {...contentActions}/><span className="metadata">Original version kept</span></> : <button disabled={busy || blocked} onClick={() => void save()}><Download size={16}/>{busy ? 'Saving output…' : 'Save output'}</button>}
    </div>
    {preview && <img className="generated-output-image" src={preview} alt={attachment.name} onError={() => { setError('The image could not be displayed. Its original remains available to download.'); setPreview(''); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; }}/>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
