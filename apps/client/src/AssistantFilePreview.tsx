import { useEffect, useState } from 'react';
import type { Attachment } from '../../../packages/domain/contracts';
import { ReplyText } from './ReplyText';

export function AssistantFilePreview({ file }: { file: Attachment }) {
  const [content, setContent] = useState<{ image?: string; text?: string; shortened?: boolean }>(), [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController(); let objectUrl = ''; setContent(undefined); setError('');
    const textFile = /\.(md|txt|json|csv|log|ya?ml|tsx?|jsx?|css|py|sh|sql)$/i.test(file.name);
    void (async () => {
      try {
        const response = await fetch(`/api/attachments/${encodeURIComponent(file.id)}?preview=1`, { credentials: 'same-origin', signal: abort.signal });
        if (!response.ok) throw new Error('This file could not be opened. Download or reopen it to try again.');
        const data = await response.arrayBuffer(); if (abort.signal.aborted) return;
        if (data.byteLength !== file.size || data.byteLength > 8 * 1024 * 1024) throw new Error('The saved file could not be verified.');
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join('');
        if (hash !== file.sha256) throw new Error('The saved file version could not be verified.');
        if (abort.signal.aborted) return;
        const type = response.headers.get('content-type') ?? '';
        if (['image/png', 'image/jpeg', 'image/webp'].includes(type)) { objectUrl = URL.createObjectURL(new Blob([data], { type })); setContent({ image: objectUrl }); }
        else if (textFile) { const text = new TextDecoder('utf-8', { fatal: true }).decode(data); setContent({ text: text.slice(0, 200000), shortened: text.length > 200000 }); }
        else setContent({});
      } catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Preview is unavailable.'); }
    })();
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.id, file.sha256, file.size, file.name]);
  return <div className="assistant-file-preview">{error ? <p role="alert">{error}</p> : !content ? <p role="status" className="metadata">Opening file…</p> : content.image ? <img src={content.image} alt={file.name} onError={() => setError('The image could not be displayed. You can download the original.')}/> : content.text !== undefined ? <>{/\.md$/i.test(file.name) ? <ReplyText text={content.text} role="assistant"/> : <pre>{content.text}</pre>}{content.shortened && <p className="metadata">Preview shortened. Download includes the full file.</p>}</> : <p className="metadata">Download this file to open it in its app.</p>}</div>;
}
