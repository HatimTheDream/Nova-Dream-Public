import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Conversation } from '../../../packages/domain/assistant';
import { cleanupReason, conversationMatchesScope, conversationNeedsCleanup, type ConversationCleanupScope, type ConversationCleanupAction } from '../../../packages/domain/conversation-cleanup';
import { request, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { retainedCleanupClient } from './conversation-cleanup-client';
import { mayLeaveAssistantDraft } from './assistant-draft-navigation';
import './conversation-cleanup.css';

type Props = { epoch: string; deviceId: string; conversations: Conversation[]; currentScope: ConversationCleanupScope; active: boolean; refresh: () => Promise<void> };
const actionLabel = { archive: 'Archive', trash: 'Move To Trash', restore: 'Restore' };
export function ConversationCleanupPanel({ epoch, deviceId, conversations, currentScope, active, refresh }: Props) {
  const key = `e3:conversation-cleanup:${epoch}:${deviceId}:${retainedWindowId}`;
  const client = useMemo(() => retainedCleanupClient(key, epoch, currentScope, { read: () => { const raw = localStorage.getItem(key); if (raw === null) return undefined; try { return JSON.parse(raw); } catch { return { unsupported: true }; } }, write: value => saveLocal(key, value), request, uuid: () => crypto.randomUUID() }), [key]);
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot), { saved, batch, busy } = view;
  const [shown, setShown] = useState(50);
  useEffect(() => { if (active) { void client.observe(); void client.history(); } }, [active, client]);
  useEffect(() => { setShown(50); }, [saved.scope, batch?.id]);
  const rows = conversations.filter(chat => conversationMatchesScope(chat, saved.scope) && conversationNeedsCleanup(chat, saved.action));
  const locked = busy || !!saved.pending || view.invalid;
  const scope = (change: Partial<ConversationCleanupScope>) => client.configure({ scope: { ...saved.scope, ...change }, selected: [] });
  const decide = async (kind: 'apply' | 'cancel') => { await client.decide(kind, mayLeaveAssistantDraft); await refresh().catch(() => undefined); void client.history(); };
  const check = async () => { await client.observe(true); await refresh().catch(() => undefined); void client.history(); };
  return <div className="conversation-cleanup-panel">
    <div><p className="metadata">Review exact conversations before changing their organization. Messages, saved writing and Project groups are kept. Nothing is permanently deleted.</p></div>
    {view.error && <p className="notice warning" role="alert">{view.error}</p>}
    {saved.pending && <p role="status">The original request is kept. Check its result before starting another cleanup.</p>}
    {(!batch && saved.batchId || saved.pending) && <button disabled={busy || view.invalid} onClick={() => void check()}>Check Original Result</button>}
    {view.missingPrepareId && <button disabled={busy || view.invalid} onClick={() => void client.retryOriginalReview()}>Retry Original Review Request</button>}
    {batch ? <section aria-label="Exact cleanup review">
      <div className="section-heading"><h3>{actionLabel[batch.action]}: {batch.targets.length} {batch.targets.length === 1 ? 'Conversation' : 'Conversations'}</h3><span className="metadata">{batch.mode === 'matching' ? 'All Matching At Review' : 'Selected At Review'}</span></div>
      <p className="metadata">{batch.scope.space === 'all' ? 'Chat And Work' : batch.scope.space === 'work' ? 'Work' : 'Chat'} · {batch.scope.folder === 'kept' ? 'Active And Archive' : batch.scope.folder === 'deleted' ? 'Trash' : batch.scope.folder}{batch.scope.query ? ` · Title contains “${batch.scope.query}”` : ''}</p>
      {batch.state === 'review' ? <><p>New matching conversations will not be added. Changed or busy conversations will stay where they are.</p><div className="button-row"><button className="primary" disabled={locked || batch.epoch !== epoch} onClick={() => void decide('apply')}>{actionLabel[batch.action]} {batch.targets.length}</button><button disabled={busy || view.invalid || batch.epoch !== epoch} onClick={() => void decide('cancel')}>Cancel Review</button></div></> : <>
        <p role="status">{batch.state === 'cancelled' ? 'Review cancelled. No conversations were changed by this review.' : `${batch.counts.applied} applied · ${batch.counts.blocked} blocked · ${batch.counts.unconfirmed} unconfirmed · ${batch.counts.pending} not started`}</p>
        {batch.running && <p>Finishing the original cleanup. Leaving this panel does not send it again.</p>}
        {!batch.running && <button disabled={busy || view.invalid} onClick={() => void check()}>Check Original Result</button>}
      </>}
      <ol className="cleanup-conversation-list">{batch.targets.slice(0, shown).map((target, index) => { const outcome = batch.outcomes[index]; return <li key={target.id}><div><strong>{target.title}</strong><span className="metadata">{target.space === 'work' ? 'Work' : 'Chat'} · revision {target.revision}</span></div><span>{batch.state === 'review' || batch.state === 'cancelled' ? 'Kept for review' : outcome.state === 'applied' ? outcome.nativeRestorePending ? 'Restored locally; native status still needs checking' : 'Applied' : cleanupReason(outcome.code) || 'Not started'}</span></li>; })}</ol>
      {batch.targets.length > shown && <button onClick={() => setShown(v => v + 50)}>Show 50 More ({batch.targets.length - shown} Remaining)</button>}
      {batch.state !== 'review' && <div className="cleanup-remainder"><strong>Current Remainder</strong>{batch.remainder.verified ? <p>{batch.remainder.capturedRemaining.length} original {batch.remainder.capturedRemaining.length === 1 ? 'conversation still needs this change or is unavailable' : 'conversations still need this change or are unavailable'}. {batch.remainder.matchingCount} currently match this scope, including {batch.remainder.newMatchingCount} not in this review.</p> : <p>{batch.remainder.error || 'The remaining scope could not be verified.'}</p>}<p className="metadata">Checked {new Date(batch.remainder.observedAt).toLocaleTimeString()}.</p>{!batch.running && !saved.pending && <button disabled={busy} onClick={() => client.freshReview()}>Start A New Review</button>}</div>}
    </section> : !saved.batchId && <section aria-label="Choose conversations">
      <div className="cleanup-scope-controls"><label>Conversations<select value={saved.scope.space} disabled={locked} onChange={e => scope({ space: e.target.value as ConversationCleanupScope['space'] })}><option value="chat">Chat</option><option value="work">Work</option><option value="all">Chat And Work</option></select></label><label>Folder<select value={saved.scope.folder} disabled={locked} onChange={e => scope({ folder: e.target.value as ConversationCleanupScope['folder'] })}><option value="active">Active</option><option value="archived">Archive</option><option value="kept">Active And Archive</option><option value="deleted">Trash</option></select></label><label>Action<select value={saved.action} disabled={locked} onChange={e => client.configure({ action: e.target.value as ConversationCleanupAction, selected: [] })}><option value="archive">Archive</option><option value="trash">Move To Trash</option><option value="restore">Restore</option></select></label></div>
      <label>Title Search<input type="search" value={saved.scope.query} maxLength={300} disabled={locked} onChange={e => scope({ query: e.target.value })} placeholder="Filter conversation titles"/></label><p className="metadata">Title search only. Message-search pages are not used to select all conversations.</p>
      <div className="button-row"><button disabled={locked} onClick={() => client.configure({ scope: currentScope, selected: [] })}>Use Current View</button>{saved.scope.projectId !== undefined && <button disabled={locked} onClick={() => scope({ projectId: undefined })}>All Projects</button>}</div>
      <p role="status">{rows.length} matching {rows.length === 1 ? 'conversation' : 'conversations'} · {saved.selected.length} selected</p>
      <div className="button-row"><button disabled={locked || !saved.selected.length} onClick={() => void client.prepare('selected')}>Review Selected</button><button disabled={locked || !rows.length} onClick={() => void client.prepare('matching')}>Review All {rows.length} Matching</button>{saved.selected.length > 0 && <button disabled={locked} onClick={() => client.configure({ selected: [] })}>Clear Selection</button>}</div>
      {rows.length > 500 && <p className="metadata">A review holds at most 500 exact conversations. Narrow this scope or select up to 500; the service will not silently truncate it.</p>}
      <ul className="cleanup-conversation-list">{rows.slice(0, shown).map(chat => { const checked = saved.selected.some(item => item.id === chat.id); return <li key={chat.id}><label><input type="checkbox" checked={checked} disabled={locked || !checked && saved.selected.length >= 500} onChange={e => client.configure({ selected: e.target.checked ? [...saved.selected, { id: chat.id, revision: chat.revision }] : saved.selected.filter(item => item.id !== chat.id) })}/><span><strong>{chat.title}</strong><span className="metadata">{chat.space === 'work' ? 'Work' : 'Chat'} · revision {chat.revision}</span></span></label></li>; })}</ul>
      {rows.length > shown && <button onClick={() => setShown(v => v + 50)}>Show 50 More ({rows.length - shown} Remaining)</button>}
    </section>}
    <section aria-label="Saved cleanup results"><div className="section-heading"><h3>Saved Reviews And Results</h3><button disabled={busy || view.historyBusy} onClick={() => void client.history()}>Refresh</button></div><p className="metadata">{view.history.total} saved {view.history.total === 1 ? 'review' : 'reviews'}. Original results remain available across sessions.</p><ul className="cleanup-history">{view.history.items.map(item => <li key={item.id}><button disabled={locked || batch?.state === 'review' && batch.id !== item.id} onClick={() => void client.open(item.id)}><span>{actionLabel[item.action]} · {item.count}</span><span className="metadata">{item.state} · {new Date(item.createdAt).toLocaleString()}</span></button></li>)}</ul>{view.history.nextOffset !== null && <button disabled={busy || view.historyBusy} onClick={() => void client.history(view.history.nextOffset!)}>Show More Saved Results</button>}</section>
  </div>;
}
