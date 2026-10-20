import { LoadingRing } from './ModuleLoading';
import { useEffect, useRef, useState } from 'react';
import { attachmentSchema, type Attachment } from '../../../packages/domain/contracts';
import { ReplyText } from './ReplyText';
import { readPreviewBytes } from './assistant-preview-reader';

export function AssistantFilePreview({ file }: { file: Attachment }) {
  const identity = JSON.stringify([file.id, file.sha256, file.size, file.name]);
  const latest = useRef(identity); latest.current = identity;
  const attempt = useRef<object | undefined>(undefined);
  const [content, setContent] = useState<{ identity: string; image?: string; imageError?: () => void; text?: string; shortened?: boolean; error?: string }>();
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]), owner = {};
    attempt.current = owner;
    let objectUrl = ''; setContent(undefined);
    const current = () => !abort.signal.aborted && latest.current === identity && attempt.current === owner;
    const revoke = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = ''; };
    const textFile = /\.(md|txt|json|csv|log|ya?ml|tsx?|jsx?|css|py|sh|sql)$/i.test(file.name);
    void (async () => {
      try {
        if (!attachmentSchema.safeParse(file).success) throw Error('This saved file cannot be verified for preview. Download the original instead.');
        const response = await fetch(`/api/attachments/${encodeURIComponent(file.id)}?preview=1`, { credentials: 'same-origin', signal });
        const data = await readPreviewBytes(response, file.size, signal);
        if (!current()) return;
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join('');
        if (hash !== file.sha256) throw new Error('The saved file version could not be verified.');
        signal.throwIfAborted();
        if (!current()) return;
        const type = response.headers.get('content-type') ?? '';
        if (['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
          objectUrl = URL.createObjectURL(new Blob([data], { type }));
          setContent({ identity, image: objectUrl, imageError: () => { if (current()) { revoke(); setContent({ identity, error: 'The image could not be displayed. You can download the original.' }); } } });
        } else if (textFile) {
          let text: string;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
          catch { throw Error('This file is not supported UTF-8 text. Download the original to open it in its app.'); }
          setContent({ identity, text: text.slice(0, 200000), shortened: text.length > 200000 });
        } else setContent({ identity });
      } catch (reason) {
        if (current()) setContent({ identity, error: signal.aborted ? 'Preview took too long. Download or reopen the original to try again.' : reason instanceof Error ? reason.message : 'Preview is unavailable. Download the original instead.' });
      }
    })();
    return () => { abort.abort(); revoke(); };
  }, [identity]);
  const shown = content?.identity === identity ? content : undefined;
  return <div className="assistant-file-preview">{shown?.error ? <p role="alert">{shown.error}</p> : !shown ? <LoadingRing label="Opening file…"/> : shown.image ? <img src={shown.image} alt={file.name} onError={shown.imageError}/> : shown.text !== undefined ? <>{/\.md$/i.test(file.name) ? <ReplyText text={shown.text} role="assistant"/> : <pre>{shown.text}</pre>}{shown.shortened && <p className="metadata">Preview shortened. Download includes the full file.</p>}</> : <p className="metadata">Preview is unavailable for this format. Download the original file to open it in its app.</p>}</div>;
}
