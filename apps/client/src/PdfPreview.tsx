import { useEffect, useRef, useState } from 'react';
import { attachmentSchema, type Attachment } from '../../../packages/domain/contracts';
import { clientHeaders } from './api';
import { LoadingRing } from './ModuleLoading';
import { readPreviewBytes } from './assistant-preview-reader';

type Page = { number: number; url?: string; error?: string };

export type PdfArtifact = { epoch: string; conversationId: string; nativeId: string; messageId: string; messageHash: string; artifactId: string };

export function PdfPreview({ file, artifact }: { file: Attachment; artifact?: never } | { artifact: PdfArtifact; file?: never }) {
  const artifactBody = artifact && JSON.stringify(artifact);
  const verifiedHash = useRef(file?.sha256);
  const [number, select] = useState(1);
  const [pages, setPages] = useState(0);
  const [page, show] = useState<Page>();
  useEffect(() => {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]);
    let url = '';
    void (async () => {
      try {
        if (file && !attachmentSchema.safeParse(file).success) throw Error('This saved PDF cannot be verified.');
        const query = new URLSearchParams({ pdfPage: String(number) });
        if (verifiedHash.current) query.set('sha256', verifiedHash.current);
        if (file) query.set('size', String(file.size));
        const path = file ? `attachments/${encodeURIComponent(file.id)}` : 'assistant/artifact/read';
        const response = await fetch(`/api/${path}?${query}`, { credentials: 'same-origin', signal, cache: 'no-store',
          ...(artifactBody ? { method: 'POST', headers: { ...clientHeaders(), 'Content-Type': 'application/json' }, body: artifactBody } : {}) });
        const sourceHash = response.headers.get('X-Source-SHA256') ?? '';
        const count = Number(response.headers.get('X-PDF-Pages'));
        const size = Number(response.headers.get('X-PDF-Page-Bytes'));
        if (!response.ok || response.headers.get('content-type') !== 'image/jpeg' || !/^[a-f0-9]{64}$/.test(sourceHash) || verifiedHash.current && sourceHash !== verifiedHash.current
          || Number(response.headers.get('X-PDF-Page')) !== number || !Number.isInteger(count) || count < number || count > 1000
          || !Number.isInteger(size) || size < 3 || size > 700000) {
          void response.body?.cancel().catch(() => {});
          if (response.status === 401 || response.status === 403) throw Error('Sign in again to open this PDF.');
          if (response.status === 409) throw Error('The saved PDF is unavailable or the reader is busy.');
          throw Error('This PDF page could not be opened.');
        }
        const bytes = await readPreviewBytes(response, size, signal);
        signal.throwIfAborted();
        if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw Error('This PDF page could not be displayed.');
        url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
        verifiedHash.current = sourceHash;
        setPages(count);
        show({ number, url });
      } catch (error) {
        if (!abort.signal.aborted) show({ number, error: signal.aborted ? 'Opening this PDF page took too long.' : error instanceof Error ? error.message : 'This PDF page could not be displayed.' });
      }
    })();
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [file?.id, file?.sha256, file?.size, file?.name, artifactBody, number]);
  const current = page?.number === number ? page : undefined;
  return <div className="assistant-file-preview">
    {pages > 0 && <div className="pdf-preview-controls">
      <button type="button" className="text-button" disabled={number <= 1} onClick={() => select(number - 1)}>Previous page</button>
      <span className="metadata" aria-live="polite">Page {number} of {pages}</span>
      <button type="button" className="text-button" disabled={number >= pages} onClick={() => select(number + 1)}>Next page</button>
    </div>}
    {current?.error ? <p role="alert">{current.error}{file && ' Download the original to open it in your PDF reader.'}</p>
      : current?.url ? <img className="pdf-preview-image" src={current.url} alt={`PDF page ${number} of ${pages}`} onError={() => show(value => value === current ? { number, error: 'This PDF page could not be displayed.' } : value)}/>
      : <LoadingRing label="Opening PDF page…"/>}
  </div>;
}

