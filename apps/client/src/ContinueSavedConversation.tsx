import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { Conversation } from '../../../packages/domain/assistant';
import type { RetainedTranscriptReview, RetainedTranscriptExport } from '../../../packages/domain/retained-transcript';
import type { AssistantController } from './useAssistant';
import { ApiError, readLocal, request, saveLocal } from './api';
import { Dialog } from './ui';

type Intent = { requestId: string; epoch: string; conversationId: string; expectedRevision: number; digest: string; allowPartial: boolean };
export function ContinueSavedConversation({ conversationId, snapshot, controller, refreshWorkspace, close, prepared }: { conversationId: string; snapshot: Snapshot; controller: AssistantController; refreshWorkspace: () => Promise<void>; close: () => void; prepared?: () => void }) {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const key = `e3:resume-chat:${snapshot.epoch}:${snapshot.deviceId}:${conversationId}`;
  const pendingRequestId = controller.conversations.find(c => c.id === conversationId)?.pendingResume?.requestId;
  const [intent, setIntent] = useState(() => readLocal<Intent>(key)), [review, setReview] = useState<RetainedTranscriptReview>(), [exported, setExported] = useState<RetainedTranscriptExport>();
  const [allowPartial, setAllowPartial] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { const abort = new AbortController(); void request<RetainedTranscriptReview>(`assistant/retained/${conversationId}`, undefined, abort.signal).then(value => { if (!abort.signal.aborted) setReview(value); }).catch(e => { if (!abort.signal.aborted) setError(e.message); }); return () => abort.abort(); }, [conversationId]);
  const prepare = async () => {
    const conversation = controller.conversations.find(c => c.id === conversationId);
    if (busy || !conversation || !review && !intent && !conversation.pendingResume) return;
    if (conversation.pendingResume && !intent) {
      const checkKey = `${key}:check:${conversation.pendingResume.requestId}`;
      const check = readLocal<object>(checkKey) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId, pendingRequestId: conversation.pendingResume.requestId };
      if (!saveLocal(checkKey, check)) { setError('Free browser storage before checking this connection.'); return; }
      setBusy(true); setError('');
      try {
        const result = await request<Conversation>('assistant/conversation/resume/check', check, undefined, 30000);
        await refreshWorkspace(); await controller.refresh();
        if (!alive.current) return;
        if (result.pendingResume) { setError(result.error ?? 'Connection is unconfirmed. Check again.'); return; }
        localStorage.removeItem(checkKey);
        if (result.error) { setError(result.error); return; }
        prepared?.(); controller.select(result.id); await controller.loadHistory(result.id); close();
      } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Connection is unconfirmed. Check again.'); }
      finally { if (alive.current) setBusy(false); }
      return;
    }
    const kept = intent ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId, expectedRevision: conversation.revision, digest: review!.digest, allowPartial };
    if (!saveLocal(key, kept)) { setError('Free browser storage before reconnecting this chat.'); return; }
    setIntent(kept); setBusy(true); setError('');
    try {
      const result = await request<Conversation>('assistant/conversation/resume', kept, undefined, 30000);
      await refreshWorkspace(); await controller.refresh();
      if (!alive.current) return;
      if (result.pendingResume) { setError(result.error ?? 'Connection is unconfirmed. Check again.'); return; }
      localStorage.removeItem(key); setIntent(undefined);
      if (result.error) { setError(result.error); return; }
      prepared?.(); controller.select(result.id); await controller.loadHistory(result.id); close();
    } catch (e) {
      if (e instanceof ApiError && ['saved_transcript_changed', 'epoch_changed', 'request_reused', 'continuation_partial', 'continuation_file_missing', 'continuation_file_limit', 'continuation_conflict', 'continuation_workspace', 'continuation_changed', 'continuation_unsettled', 'continuation_queued', 'voice_active'].includes(e.code)) {
        localStorage.removeItem(key); setIntent(undefined);
        if (e.code === 'saved_transcript_changed') void request<RetainedTranscriptReview>(`assistant/retained/${conversationId}`).then(setReview).catch(() => {});
      }
      if (alive.current) setError(e instanceof Error ? e.message : 'Connection is unconfirmed. Check again using the same request.');
    } finally { if (alive.current) setBusy(false); }
  };
  const download = async () => {
    if (!review) return; setBusy(true); setError('');
    try { const value = await request<RetainedTranscriptExport>('assistant/retained/export', { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId, digest: review.digest }); if (alive.current) setExported(value); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Export unavailable.'); }
    finally { if (alive.current) setBusy(false); }
  };
  return <Dialog title="Resume Chat" close={busy ? () => {} : close}>
    {review ? <><p><strong>{review.title}</strong></p><p>{review.messageCount} Saved Messages · {review.complete ? 'Complete At Capture' : 'Partial History'}</p><p>Your next message includes saved history and available files. Your draft, pins and Project stay in this chat. The new connection starts with read-only access.</p>{!review.complete && <label className="check-row"><input type="checkbox" checked={allowPartial} disabled={!!intent || busy} onChange={e => setAllowPartial(e.target.checked)}/>Continue With The Saved Portion</label>}</> : <p role="status">Reading Saved History…</p>}
    {exported ? <p><a href={`/api/attachments/${exported.file.id}`}>Download Transcript</a></p> : <button disabled={busy || !review} onClick={() => void download()}>Export Transcript</button>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="dialog-footer"><button disabled={busy} onClick={close}>Back</button><button className="primary" disabled={busy || !intent && !pendingRequestId && (!review || !review.complete && !allowPartial) || controller.connection.state !== 'ready'} onClick={() => void prepare()}>{busy ? 'Connecting…' : intent || pendingRequestId ? 'Check Connection' : 'Resume Chat'}</button></div>
  </Dialog>;
}
