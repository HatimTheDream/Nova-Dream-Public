import { useEffect, useRef, useState } from 'react';
import { emptyDraft, type Command, type Snapshot } from '../../../packages/domain/contracts';
import type { RetainedTranscriptReview, RetainedTranscriptExport } from '../../../packages/domain/retained-transcript';
import type { AssistantController } from './useAssistant';
import { ApiError, commit, readLocal, request, saveLocal } from './api';
import { Dialog } from './ui';

type Intent = { requestId: string; epoch: string; conversationId: string; digest: string; createId: string; copyId: string };
export function ContinueSavedConversation({ conversationId, snapshot, controller, refreshWorkspace, close, prepared }: {
  conversationId: string; snapshot: Snapshot; controller: AssistantController; refreshWorkspace: () => Promise<void>; close: () => void; prepared?: () => void;
}) {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const key = `e3:continue-saved:${snapshot.epoch}:${snapshot.deviceId}:${conversationId}`;
  const [intent, setIntent] = useState(() => readLocal<Intent>(key));
  const [review, setReview] = useState<RetainedTranscriptReview>();
  const [exported, setExported] = useState<RetainedTranscriptExport>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    void request<RetainedTranscriptReview>(`assistant/retained/${conversationId}`, undefined, abort.signal).then(setReview).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [conversationId]);
  const prepare = async () => {
    if (busy || !review && !intent) return;
    const kept = intent ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId, digest: review!.digest, createId: crypto.randomUUID(), copyId: crypto.randomUUID() };
    if (!saveLocal(key, kept)) { setError('Free browser storage before preparing this draft. The original conversation is kept.'); return; }
    setIntent(kept); setBusy(true); setError('');
    try {
      const saved = await request<RetainedTranscriptExport>('assistant/retained/export', { requestId: kept.requestId, epoch: kept.epoch, conversationId: kept.conversationId, digest: kept.digest });
      setExported(saved);
      // Creating the chat does not send the transcript or start a model turn.
      // It deliberately starts without old Project paths or inherited access.
      const created = await controller.create({ requestId: kept.createId, space: 'chat', title: `Continue · ${saved.review.title}`.slice(0, 150), projectId: null, permissionMode: 'read-only' });
      const draftId = `draft:${snapshot.deviceId}:${created.id}`;
      const command: Command = { requestId: kept.copyId, epoch: kept.epoch, kind: 'draft', entityId: draftId, expectedRevision: 0, payload: { ...emptyDraft, space: 'chat', title: created.title, conversationId: created.id, projectId: null, attachments: [saved.file] } };
      const copyKey = `e3:conversation-copy:${draftId}`;
      if (!saveLocal(copyKey, command)) throw Error('The chat exists. Your transcript is kept; free browser storage and check preparation again.');
      await commit(command);
      localStorage.removeItem(copyKey); localStorage.removeItem(key);
      await refreshWorkspace(); await controller.refresh();
      if (alive.current) { prepared?.(); controller.select(created.id, 'chat'); close(); }
    } catch (e) {
      if (e instanceof ApiError && ['saved_transcript_changed', 'epoch_changed', 'request_reused'].includes(e.code)) {
        localStorage.removeItem(key); setIntent(undefined);
        if (e.code === 'saved_transcript_changed') void request<RetainedTranscriptReview>(`assistant/retained/${conversationId}`).then(setReview).catch(() => {});
      }
      setError(e instanceof Error ? e.message : 'Preparation is unconfirmed. Check again using the same request.');
    } finally { setBusy(false); }
  };
  const coverage = exported?.review ?? review;
  return <Dialog title="Continue from saved conversation" close={busy ? () => {} : close}>
    {coverage ? <><p><strong>{coverage.title}</strong></p><p>{coverage.complete ? 'Complete at capture time' : 'Partial saved transcript'} · {coverage.messageCount} user and Assistant messages · {Math.max(1, Math.ceil(coverage.bytes / 1024))} KB</p>
      <p>{coverage.complete ? 'Newer messages may still exist on the original host.' : 'Some messages are missing from this copy. The new chat will receive that limitation explicitly.'}</p>
      <p>The transcript becomes an attachment in a fresh chat. Write your next request and press Send when ready. Your original conversation and unsent writing stay saved.</p>
      <p className="metadata">Historical permissions, pending actions and memory are not resumed. {coverage.attachmentCount ? `${coverage.attachmentCount} attachment references list names only; reattach files needed for your next request.` : 'Runtime instructions and tool records stay in the original archive.'}</p>
    </> : <p role="status">Reading saved transcript details…</p>}
    {exported && <p><a href={`/api/attachments/${exported.file.id}`}>Download saved transcript</a></p>}
    {!controller.connection.modelAuthReady && <p className="notice">Connect the Assistant in Settings before opening a fresh chat.</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="dialog-footer"><button disabled={busy} onClick={close}>Back</button><button className="primary" disabled={busy || !coverage && !intent || !controller.connection.modelAuthReady} onClick={() => void prepare()}>{busy ? 'Preparing draft…' : intent ? 'Check preparation' : 'Open fresh chat'}</button></div>
  </Dialog>;
}
