import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '../../../packages/domain/contracts';
import { AssignmentReview } from './AssignmentReview';
import type { Content, ContentOutputSource } from '../../../packages/domain/workspace-records';

export function ContentSource({ content, openSource }: { content: Content; openSource?: (source: ContentOutputSource) => void }) {
  const source = content.source, [review, setReview] = useState(false);
  return <section className="content-source" aria-label="Original output">
    {source && <><h3>Original output</h3><p className="metadata">{source.name} · {source.kind === 'assignment' ? `assignment plan version ${source.assignmentRevision}` : `version ${source.version}`}</p><p className="metadata">{source.importedText ? 'Your draft began with the complete saved text. Editing it keeps the original file unchanged.' : 'The original file is kept here. Write your brief or draft above; the file has not been converted or shortened.'}</p>{source.kind === 'assignment' ? <button onClick={() => setReview(true)}>Open source assignment</button> : openSource && <button onClick={() => openSource(source)}>Open source conversation</button>}</>}
    {(content.assets ?? []).map(file => <SavedContentFile key={`${file.id}:${file.sha256}`} file={file} text={!!source?.importedText && source.fileId === file.id}/>)}
    {review && source?.kind === 'assignment' && <AssignmentReview id={source.attemptId} expected={source} close={() => setReview(false)}/>}
  </section>;
}

function SavedContentFile({ file, text }: { file: Attachment; text: boolean }) {
  const [preview, setPreview] = useState<{ kind: 'text' | 'image'; value: string }>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const abort = useRef<AbortController | undefined>(undefined), url = useRef('');
  const release = () => { abort.current?.abort(); if (url.current) URL.revokeObjectURL(url.current); url.current = ''; };
  useEffect(() => () => release(), []);
  const show = async () => {
    if (preview) { release(); setPreview(undefined); return; }
    const current = new AbortController(); abort.current = current; setBusy(true); setError('');
    try {
      const response = await fetch(`/api/attachments/${file.id}?preview=1`, { credentials: 'same-origin', signal: AbortSignal.any([current.signal, AbortSignal.timeout(30000)]) });
      if (!response.ok) throw new Error('The original file could not be opened. Retry or download it.');
      if (text) {
        const bytes = await response.arrayBuffer();
        const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (value.length > 100000) throw new Error('Download the original to read this larger file.');
        if (!current.signal.aborted) setPreview({ kind: 'text', value });
      } else {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('Preview is unavailable for this file. Download the original to open it.'); }
        const blob = await response.blob();
        if (!current.signal.aborted) { url.current = URL.createObjectURL(blob); setPreview({ kind: 'image', value: url.current }); }
      }
    } catch (reason) { if (!current.signal.aborted) setError(reason instanceof Error ? reason.message : 'Preview is unavailable.'); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  return <div className="content-source-file"><div className="button-row"><a className="output-download" href={`/api/attachments/${file.id}`}>{file.name} · Download original</a>{(text || /\.(png|jpe?g|webp)$/i.test(file.name)) && <button disabled={busy} onClick={() => void show()}>{busy ? 'Opening preview…' : preview ? 'Hide original preview' : 'Preview original'}</button>}</div>
    {preview?.kind === 'text' && <pre tabIndex={0} aria-label="Original saved text">{preview.value}</pre>}{preview?.kind === 'image' && <img src={preview.value} alt={file.name} onError={() => { release(); setPreview(undefined); setError('The image could not be displayed. Its original is still available to download.'); }}/>}<p className="metadata">{file.size.toLocaleString()} bytes · Original file retained</p>{error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}
