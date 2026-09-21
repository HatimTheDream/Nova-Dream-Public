import { useEffect, useState } from 'react';
import type { Draft } from '../../../packages/domain/contracts';
import { emptyDraft } from '../../../packages/domain/contracts';
import type { QueuedMessage } from '../../../packages/domain/assistant';
import type { AssistantController } from './useAssistant';
import { ApiError, readLocal, request, saveLocal } from './api';
import { formatSaved } from './ui';

export function messageQueueSummary(items: QueuedMessage[]) {
  const waiting = items.filter(item => item.state === 'paused');
  const queued = waiting.filter(item => item.automatic).length, paused = waiting.length - queued;
  return [queued && `${queued} queued`, paused && `${paused} paused`].filter(Boolean).join(' · ') || 'Message queue';
}

export function MessageQueue({ controller, conversationId, epoch, blocked, copy }: { controller: AssistantController; conversationId: string; epoch: string; blocked: boolean; copy: (draft: Draft) => void }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [errorKey, setErrorKey] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const items = (controller.queue ?? []).filter(item => item.conversationId === conversationId);
  const paused = items.filter(item => item.state === 'paused');
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
    return <article className="queued-message" key={item.id} aria-label={`Queued message: ${item.input.slice(0, 80) || 'Attachments'}`}>
      <div className="section-heading"><strong>{item.state === 'paused' ? item.automatic ? 'Up next' : 'Paused' : item.state === 'removed' ? 'Kept aside' : operation?.state === 'unknown' ? 'Outcome unconfirmed' : operation?.state ?? 'Submission kept'}</strong><span className="metadata">{formatSaved(item.createdAt)}</span></div>
      {editing === item.id ? <QueueEditor key={item.id} item={item} epoch={epoch} refresh={controller.refresh} close={() => setEditing(null)}/> : <p className="preserve-lines">{item.input || 'Attachment message'}</p>}
      {item.autoError && <p className="field-error" role="status">{item.autoError}</p>}<p className="metadata">{item.context.project ? `${item.context.project.name} · ` : ''}{item.model ?? 'Default model'} · {item.context.attachments.length} {item.context.attachments.length === 1 ? 'file' : 'files'}</p>
      {item.context.attachments.map(file => <a className="source-link" key={file.id} href={`/api/attachments/${file.id}`}>{file.name}</a>)}
      <div className="queue-actions">
        {item.state === 'paused' && <><button disabled={!!busy || !!editing || blocked || controller.connection.state !== 'ready'} onClick={() => void act(item, 'run')}>Run next</button><button disabled={!!busy || !!editing} onClick={async () => { if (!item.automatic || await act(item, 'paused')) setEditing(item.id); }}>Edit</button>{item.automatic && <button disabled={!!busy || !!editing} onClick={() => void act(item, 'paused')}>Pause</button>}<button disabled={!!busy || !!editing || paused[0]?.id === item.id} onClick={() => void move(item, -1)}>Move up</button><button disabled={!!busy || !!editing || paused.at(-1)?.id === item.id} onClick={() => void move(item, 1)}>Move down</button><button disabled={!!busy || !!editing} onClick={() => void act(item, 'removed')}>Remove</button></>}
        {item.state === 'removed' && <button disabled={!!busy} onClick={() => void act(item, 'paused')}>Restore to queue</button>}
        <button disabled={!!busy || controller.conversation?.archived} onClick={() => copy({ ...emptyDraft, text: item.input, workMode: item.context.workMode, attachments: item.context.attachments, projectId: item.context.project?.id ?? null, ...(item.context.refineSource ? { refineSource: item.context.refineSource } : {}) })}>Copy to draft</button>
        {operation && !['completed', 'failed', 'cancelled'].includes(operation.state) && <button onClick={() => void controller.checkStatus()}>Check original run</button>}
      </div>
    </article>;
  };
  return <section aria-label="Message queue"><h3>Message queue <span className="count">{paused.length}</span></h3><p className="metadata">Queued messages run after this reply. Paused messages wait for Run Next.</p>{paused.map(card)}{!paused.length && <p className="metadata">No messages waiting.</p>}{items.some(item => item.state !== 'paused') && <details><summary>Earlier queue items</summary>{items.filter(item => item.state !== 'paused').map(card)}</details>}{error && <p className="field-error" role="alert">{error}</p>}</section>;
}

function QueueEditor({ item, epoch, refresh, close }: { item: QueuedMessage; epoch: string; refresh: () => Promise<void>; close: () => void }) {
  const key = `e3:queue-writing:${epoch}:${item.id}`;
  const [text, setText] = useState(() => readLocal<string>(key) ?? item.input), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async () => {
    const intentKey = `${key}:request`;
    const input = readLocal<object>(intentKey) ?? { requestId: crypto.randomUUID(), epoch, queueId: item.id, expectedRevision: item.revision, input: text };
    if (!saveLocal(intentKey, input)) { setError('Free browser storage before saving this revision.'); return; }
    setBusy(true); setError('');
    try { await request('assistant/queue/edit', input); localStorage.removeItem(intentKey); localStorage.removeItem(key); await refresh(); close(); }
    catch (e) { if (e instanceof ApiError && ['queue_changed', 'empty_message'].includes(e.code)) localStorage.removeItem(intentKey); setError(e instanceof Error ? e.message : 'Revision not confirmed.'); await refresh(); }
    finally { setBusy(false); }
  };
  return <form onSubmit={e => { e.preventDefault(); void save(); }}><textarea autoFocus aria-label="Edit queued message" value={text} maxLength={100000} disabled={busy} onChange={e => { setText(e.target.value); if (!saveLocal(key, e.target.value)) setError('This revision is only kept in this window.'); }}/><div className="button-row"><button disabled={busy} type="submit">Save changes</button><button type="button" disabled={busy} onClick={close}>Keep for later</button></div>{error && <p className="field-error" role="alert">{error}</p>}</form>;
}
