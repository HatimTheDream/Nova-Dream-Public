import { useEffect, useState } from 'react';
import type { Draft } from '../../../packages/domain/contracts';
import { emptyDraft } from '../../../packages/domain/contracts';
import type { QueuedMessage } from '../../../packages/domain/assistant';
import type { AssistantController } from './useAssistant';
import { ApiError, readLocal, request, saveLocal } from './api';
import { formatSaved } from './ui';
import { ComposerMenu } from './ComposerMenu';
import { MoreHorizontal, Queue, Trash2 } from './icons';
import './message-queue.css';
import { saveRetainedQueueEdit, type QueueEditRequest } from './queue-edit-request';

export function messageQueueSummary(items: QueuedMessage[]) {
  const waiting = items.filter(item => item.state === 'paused');
  const queued = waiting.filter(item => item.automatic).length, paused = waiting.length - queued;
  return [queued && `${queued} queued`, paused && `${paused} paused`].filter(Boolean).join(' · ') || 'Message queue';
}

export function MessageQueue({ controller, conversationId, epoch, blocked, copy, historyOpen = false, onHistoryToggle }: { controller: AssistantController; conversationId: string; epoch: string; blocked: boolean; copy: (draft: Draft) => void; historyOpen?: boolean; onHistoryToggle?: (open: boolean) => void }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [errorKey, setErrorKey] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const items = (controller.queue ?? []).filter(item => item.conversationId === conversationId);
  const paused = items.filter(item => item.state === 'paused');
  const unsettled = items.filter(item => {
    if (item.state !== 'submitted') return false;
    const operation = controller.operations.find(op => op.id === item.operationId);
    return !operation || ['prepared', 'dispatching', 'unknown'].includes(operation.state);
  });
  const earlier = items.filter(item => item.state !== 'paused' && !unsettled.includes(item));
  const move = async (item: QueuedMessage, delta: number) => {
    const index = paused.findIndex(q => q.id === item.id), next = [...paused];
    if (index + delta < 0 || index + delta >= next.length || busy) return;
    next.splice(index, 1); next.splice(index + delta, 0, item);
    const key = `e3:queue-order:${conversationId}`;
    const input = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch, conversationId, items: next.map(q => ({ id: q.id, revision: q.revision })) };
    if (!saveLocal(key, input)) { setError('The queue order could not be retained.'); return; }
    setBusy(item.id); setError('');
    try { await request('assistant/queue/order', input); localStorage.removeItem(key); await controller.refresh(); }
    catch (e) { if (e instanceof ApiError && e.code === 'queue_changed') localStorage.removeItem(key); setError(e instanceof Error ? e.message : 'Order not confirmed.'); await controller.refresh(); }
    finally { setBusy(''); }
  };
  useEffect(() => {
    for (const item of items.filter(item => item.state === 'submitted')) {
      const key = `e3:queue-action:${item.id}:${item.revision - 1}:run`;
      const intent = readLocal<{ requestId: string }>(key);
      if (intent && controller.operations.some(op => op.id === item.operationId && op.requestId === intent.requestId)) {
        localStorage.removeItem(key);
        if (errorKey === key) { setError(''); setErrorKey(''); }
      }
    }
  }, [controller.queue, controller.operations, conversationId, errorKey]);
  const act = async (item: QueuedMessage, action: 'run' | 'removed' | 'paused') => {
    if (busy) return false;
    const key = `e3:queue-action:${item.id}:${item.revision}:${action}`;
    const input = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch, queueId: item.id, expectedRevision: item.revision, ...(action === 'run' ? {} : { state: action }) };
    if (!saveLocal(key, input)) { setError('Free browser storage before changing this queued message.'); return false; }
    setBusy(item.id); setError(''); setErrorKey('');
    try { await request(`assistant/queue/${action === 'run' ? 'run' : 'state'}`, input); localStorage.removeItem(key); await controller.refresh(); return true; }
    catch (reason) { setErrorKey(key); setError(reason instanceof Error ? reason.message : 'The queue action is not confirmed. Its message is kept.'); await controller.refresh(); return false; }
    finally { setBusy(''); }
  };
  const card = (item: QueuedMessage) => {
    const operation = controller.operations.find(op => op.id === item.operationId);
    const awaitingRun = unsettled.includes(item), waiting = item.state === 'paused';
    const runAvailable = !blocked && controller.connection.state === 'ready' && !controller.conversation?.archived;
    const status = waiting ? item.automatic ? paused[0]?.id === item.id ? 'Up next' : 'Queued' : 'Paused'
      : item.state === 'removed' ? 'Kept aside'
      : !operation ? 'Submission kept' : operation.state === 'unknown' ? 'Outcome unconfirmed'
      : ({ prepared: 'Preparing', dispatching: 'Sending', accepted: 'Starting', running: 'Working', completed: 'Completed', failed: 'Reply failed', cancelled: 'Stopped' }[operation.state]);
    const copyToDraft = () => copy({ ...emptyDraft, text: item.input, workMode: item.context.workMode, attachments: item.context.attachments, projectId: item.context.project?.id ?? null, ...(item.context.refineSource ? { refineSource: item.context.refineSource } : {}) });
    return <article className="queued-message queue-entry" key={item.id} aria-label={`Queued message: ${item.input.slice(0, 80) || 'Attachments'}`}>
      <div className="queue-entry-row"><Queue size={14} className="queue-entry-icon"/>
        {editing === item.id ? <span className="queue-entry-title">Editing queued message</span> : <QueueMessageText text={item.input} status={status} quietStatus={waiting && !!item.automatic}/>}
        <div className="queue-entry-actions">
        {awaitingRun ? <button type="button" className="queue-entry-action" onClick={() => void controller.checkStatus(conversationId)}>Check original run</button>
          : waiting && item.automatic ? <button type="button" className="queue-entry-action" disabled={!!busy || !!editing} onClick={() => void act(item, 'paused')}>Pause</button>
          : waiting && runAvailable ? <button type="button" className="queue-entry-action" disabled={!!busy || !!editing} onClick={() => void act(item, 'run')}>Run next</button>
          : item.state === 'removed' ? <button type="button" className="queue-entry-action" disabled={!!busy} onClick={() => void act(item, 'paused')}>Restore to queue</button> : null}
        {waiting && <button type="button" className="queue-entry-action queue-entry-remove" aria-label="Remove queued message" title="Remove queued message" disabled={!!busy || !!editing} onClick={() => void act(item, 'removed')}><Trash2 size={15}/></button>}
        <ComposerMenu kind="menu" className="queue-entry-more" label="Queued message actions" icon={<MoreHorizontal size={17}/>} align="right">{close => <div className="queue-entry-menu">
          {waiting && <>
            <button type="button" role="menuitem" disabled={!!busy || !!editing} onClick={async () => { close(); if (!item.automatic || await act(item, 'paused')) setEditing(item.id); }}>Edit message</button>
            {item.automatic && runAvailable && <button type="button" role="menuitem" disabled={!!busy || !!editing} onClick={() => { close(); void act(item, 'run'); }}>Run next</button>}
            {paused.length > 1 && <><button type="button" role="menuitem" disabled={!!busy || !!editing || paused[0]?.id === item.id} onClick={() => { close(); void move(item, -1); }}>Move up</button><button type="button" role="menuitem" disabled={!!busy || !!editing || paused.at(-1)?.id === item.id} onClick={() => { close(); void move(item, 1); }}>Move down</button></>}
          </>}
          <button type="button" role="menuitem" disabled={!!busy || controller.conversation?.archived} onClick={() => { close(); copyToDraft(); }}>Copy to draft</button>
          <p className="queue-entry-context">{item.context.project ? `${item.context.project.name} · ` : ''}{item.model ?? 'Default model'}<br/>Added {formatSaved(item.createdAt)}</p>
        </div>}</ComposerMenu>
      </div></div>
      {editing === item.id && <QueueEditor key={item.id} item={item} epoch={epoch} refresh={controller.refresh} close={() => setEditing(null)}/>}
      {item.autoError && <p className="field-error" role="status">{item.autoError}</p>}
      {!!item.context.attachments.length && <div className="queue-entry-files">{item.context.attachments.map(file => <a className="source-link" key={file.id} href={`/api/attachments/${file.id}`}>{file.name}</a>)}</div>}
    </article>;
  };
  if (!paused.length && !unsettled.length && !historyOpen && !error) return null;
  return <section className="message-queue" aria-label="Message queue"><h3 className="sr-only">Message queue</h3>{unsettled.map(card)}{paused.map(card)}{historyOpen && <details className="queue-earlier" open onToggle={event => onHistoryToggle?.(event.currentTarget.open)}><summary>Earlier queue items</summary>{earlier.length ? earlier.map(card) : <p className="queue-entry-note">No earlier queued messages.</p>}</details>}{error && <p className="field-error" role="alert">{error}</p>}</section>;
}

function QueueMessageText({ text, status, quietStatus }: { text: string; status: string; quietStatus: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.split('\n')[0].slice(0, 180), shortened = preview.length < text.length;
  return <div className="queue-entry-writing"><button type="button" className="queue-entry-preview" aria-expanded={expanded} title={expanded ? 'Collapse queued message' : 'Read queued message'} onClick={() => setExpanded(value => !value)}><span className={quietStatus ? 'sr-only' : 'queue-entry-status'}>{status}</span>{quietStatus ? null : ' · '}{text ? `${preview}${shortened ? '…' : ''}` : 'Attachment message'}</button>{expanded && <p className="queue-entry-full preserve-lines">{text || 'Attachment message'}</p>}</div>;
}

export function QueueEditor({ item, epoch, refresh, close }: { item: QueuedMessage; epoch: string; refresh: () => Promise<void>; close: () => void }) {
  const key = `e3:queue-writing:${epoch}:${item.id}`;
  const intentKey = `${key}:request`;
  const [pending, setPending] = useState(() => readLocal<QueueEditRequest>(intentKey));
  const [text, setText] = useState(() => readLocal<string>(key) ?? pending?.input ?? item.input), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await saveRetainedQueueEdit({
        read: () => pending ?? readLocal<QueueEditRequest>(intentKey),
        keep: input => { const kept = saveLocal(intentKey, input ?? null); if (kept) setPending(input); return kept; },
        send: input => request('assistant/queue/edit', input),
      }, { requestId: crypto.randomUUID(), epoch, queueId: item.id, expectedRevision: item.revision, input: text });
      setPending(result.pending); setError(result.error);
      await refresh();
      if (result.confirmed) {
        if (text === result.confirmed.input) { if (saveLocal(key, null)) close(); else setError('The edit was saved. Free browser storage before closing this retained draft.'); }
        else setError('The original save is confirmed. Your newer writing is kept; review and save it separately.');
      }
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Queue status could not refresh. Your writing is kept.'); }
    finally { setBusy(false); }
  };
  return <form onSubmit={e => { e.preventDefault(); void save(); }}><textarea autoFocus aria-label="Edit queued message" value={text} maxLength={100000} disabled={busy || !!pending} onChange={e => { setText(e.target.value); if (!saveLocal(key, e.target.value)) setError('This revision is only kept in this window.'); }}/>{pending && <p className="metadata" role="status">The original save is unconfirmed. Check it before changing this message.</p>}<div className="button-row"><button disabled={busy} type="submit">{busy ? 'Saving…' : pending ? 'Reconcile save' : 'Save changes'}</button><button type="button" disabled={busy} onClick={() => { if (saveLocal(key, text)) close(); else setError('Keep this editor open until this writing can be saved on your device.'); }}>Keep for later</button></div>{error && <p className="field-error" role="alert">{error}</p>}</form>;
}
