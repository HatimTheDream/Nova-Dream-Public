import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Conversation } from '../../../packages/domain/assistant';
import { cleanupReason, conversationMatchesScope, type ConversationCleanupScope, type DecidePermanentConversationCleanup } from '../../../packages/domain/conversation-cleanup';
import { request, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { retainedPermanentCleanupClient } from './conversation-permanent-cleanup-client';
import { mayLeaveAssistantDraft } from './assistant-draft-navigation';

type Props = { epoch: string; deviceId: string; conversations: Conversation[]; currentScope: ConversationCleanupScope; active: boolean; refresh: () => Promise<void> };
export function PermanentConversationCleanupPanel({ epoch, deviceId, conversations, currentScope, active, refresh }: Props) {
  const key = `e3:conversation-permanent-cleanup:${epoch}:${deviceId}:${retainedWindowId}`;
  const client = useMemo(() => retainedPermanentCleanupClient(key, { epoch, deviceId, windowId: retainedWindowId }, currentScope, {
    read: () => { const raw = localStorage.getItem(key); return raw === null ? undefined : JSON.parse(raw); },
    write: value => saveLocal(key, value), request, uuid: () => crypto.randomUUID(),
  }), [key]);
  const activeRef = useRef(active); activeRef.current = active; client.setActive(active);
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot), { saved, batch, busy } = view;
  const [shown, setShown] = useState(50), [acknowledged, setAcknowledged] = useState('');
  useEffect(() => {
    activeRef.current = active; client.setActive(active);
    if (active) { void client.observe(); void client.history(); }
    else setAcknowledged('');
    return () => { activeRef.current = false; client.setActive(false); };
  }, [active, client]);
  useEffect(() => { setShown(50); setAcknowledged(''); }, [saved.scope, batch?.id]);
  const locked = !active || busy || view.invalid || !!saved.pending;
  const rows = conversations.filter(chat => conversationMatchesScope(chat, saved.scope));
  const kind = batch?.state === 'review' ? 'start' : 'continue_remaining';
  const cancelledStatus = batch?.state === 'cancelled' && saved.pending?.kind === 'decide' && saved.pending.command.decision === 'cancel';
  const token = client.decisionToken(kind), count = Math.min(25, batch?.counts.pending ?? 0);
  const scope = (change: Partial<ConversationCleanupScope>) => client.configure({ scope: { ...saved.scope, ...change, folder: 'deleted' }, selected: [] });
  const after = async (work: Promise<void>) => {
    await work;
    if (!activeRef.current) return;
    await refresh().catch(() => undefined);
    if (activeRef.current) void client.history();
  };
  const decide = (decision: DecidePermanentConversationCleanup['decision']) => {
    if (!activeRef.current) return;
    const confirmation = acknowledged; setAcknowledged('');
    void after(client.decide(decision, confirmation, mayLeaveAssistantDraft));
  };
  const observe = () => { if (activeRef.current) { setAcknowledged(''); void after(client.observe()); } };
  return <div className="conversation-cleanup-panel permanent-cleanup-panel">
    <div className="permanent-cleanup-warning">
      <h3>Permanent Removal From Trash</h3>
      <p>Removed conversations cannot be restored. Their messages, conversation-owned saved drafts and conversation history are removed. Separate outputs, memories, Projects and shared files are kept.</p>
      <p className="metadata">Review first. Each explicit removal starts at most 25 never-started items from that exact review. New matches and previously blocked or unconfirmed removals are not added.</p>
    </div>
    {view.error && <p className="notice warning" role="alert">{view.error}</p>}
    {saved.pending && <p role="status">The original {saved.pending.kind === 'prepare' ? 'review request' : 'decision'} is kept. Observe its status before another decision; no removal is sent again.</p>}
    {saved.batchId && <button disabled={!active || busy || view.invalid} onClick={observe}>Observe Original Status</button>}
    {view.missingPrepareId && <button disabled={!active || busy || view.invalid} onClick={() => void client.retryOriginalReview()}>Retry Original Review Request</button>}
    {batch ? <section aria-label="Exact permanent review">
      <div className="section-heading"><h3>{batch.targets.length} {batch.targets.length === 1 ? 'Conversation' : 'Conversations'} In This Review</h3><span className="metadata">{batch.mode === 'matching' ? 'All Matching At Review' : 'Selected At Review'}</span></div>
      <p className="metadata">{batch.scope.space === 'all' ? 'Chat And Work' : batch.scope.space === 'work' ? 'Work' : 'Chat'} · Trash{batch.scope.projectId !== undefined ? ' · Captured Project Filter' : ''}{batch.scope.query ? ` · Title contains “${batch.scope.query}”` : ''}</p>
      <p role="status">{batch.state === 'cancelled' ? 'Review cancelled. This review removed no conversations.' : `${batch.counts.applied} removed · ${batch.counts.blocked} blocked · ${batch.counts.unconfirmed} unconfirmed · ${batch.counts.pending} not started`}</p>
      {batch.epoch !== epoch && <p className="notice warning">This is a review from another workspace version. It is read-only here.</p>}
      {batch.running && <p>The original chunk is still running. Observe its status when ready; leaving this panel does not restart it.</p>}
      {!batch.running && batch.state !== 'cancelled' && batch.counts.pending > 0 && <div className="permanent-cleanup-decision">
        <p>{kind === 'start' ? 'Start this exact review' : 'Decide separately about the untouched remainder'}: up to {count} of the {batch.counts.pending} never-started conversations. Changed or busy items will be blocked.</p>
        <label className="permanent-cleanup-ack"><input type="checkbox" checked={!!token && acknowledged === token} disabled={locked || !token} onChange={e => setAcknowledged(e.target.checked && token ? token : '')}/><span>I understand these removals are permanent and cannot be restored.</span></label>
        <button className="danger" disabled={locked || !token || acknowledged !== token} onClick={() => decide(kind)}>{kind === 'start' ? 'Permanently Remove' : 'Remove Never-Started Remainder'} (Up To {count})</button>
      </div>}
      {batch.state === 'review' && <button disabled={!active || busy || view.invalid || !view.observed || batch.epoch !== epoch || saved.pending?.kind === 'prepare'} onClick={() => decide('cancel')}>Cancel Review</button>}
      {batch.counts.unconfirmed > 0 && <p className="notice warning">Unconfirmed originals stay visible. This panel can observe them but cannot retry or continue their native removal.</p>}
      <ol className="cleanup-conversation-list">{batch.targets.slice(0, shown).map((target, index) => {
        const outcome = batch.outcomes[index];
        return <li key={target.id}><div><strong>{target.title}</strong><span className="metadata">{target.space === 'work' ? 'Work' : 'Chat'} · reviewed revision {target.revision}</span></div><span>{outcome.state === 'applied' ? 'Removed' : outcome.state === 'pending' ? 'Not Started' : `${outcome.state === 'blocked' ? 'Blocked' : 'Unconfirmed'} · ${cleanupReason(outcome.code) || 'Observe the original status.'}`}</span></li>;
      })}</ol>
      {batch.targets.length > shown && <button onClick={() => setShown(v => v + 50)}>Show 50 More ({batch.targets.length - shown} Remaining)</button>}
      <div className="cleanup-remainder"><strong>Current Remainder</strong>
        {batch.remainder.verified ? <p>{batch.remainder.capturedRemaining.length} original conversations have not been confirmed removed. {batch.remainder.matchingCount} currently match this scope, including {batch.remainder.newMatchingCount} outside this review.</p>
          : <p>{batch.remainder.error || 'The current remainder could not be fully verified.'} Missing records are not treated as successful removals.</p>}
        <p className="metadata">Observed {new Date(batch.remainder.observedAt).toLocaleTimeString()}. New matches require a separate review.</p>
        {cancelledStatus && <p>The review is cancelled. Its original cancellation response is still unconfirmed; starting a new review keeps that exact request without sending it again.</p>}
        {!batch.running && batch.state !== 'review' && <button disabled={!active || busy || view.invalid || !!saved.pending && !cancelledStatus || !view.observed} onClick={() => client.freshReview()}>Start A New Review</button>}
      </div>
    </section> : !saved.batchId && <section aria-label="Choose Trash conversations">
      <div className="cleanup-scope-controls"><label>Conversations<select disabled={locked} value={saved.scope.space} onChange={e => scope({ space: e.target.value as ConversationCleanupScope['space'] })}><option value="chat">Chat</option><option value="work">Work</option><option value="all">Chat And Work</option></select></label><span className="metadata">Trash Only</span></div>
      <label>Title Search<input type="search" value={saved.scope.query} maxLength={300} disabled={locked} onChange={e => scope({ query: e.target.value })}/></label>
      <p className="metadata">Title search only. Review captures the full matching metadata scope, never just a message-search page.</p>
      <div className="button-row"><button disabled={locked} onClick={() => client.configure({ scope: { ...currentScope, folder: 'deleted' }, selected: [] })}>Use Current Scope In Trash</button>{saved.scope.projectId !== undefined && <button disabled={locked} onClick={() => scope({ projectId: undefined })}>All Projects</button>}</div>
      <p role="status">{rows.length} matching · {saved.selected.length} selected</p>
      <div className="button-row"><button disabled={locked || !saved.selected.length} onClick={() => void client.prepare('selected')}>Review Selected</button><button disabled={locked || !rows.length} onClick={() => void client.prepare('matching')}>Review All {rows.length} Matching</button>{saved.selected.length > 0 && <button disabled={locked} onClick={() => client.configure({ selected: [] })}>Clear Selection</button>}</div>
      {rows.length > 500 && <p className="metadata">Each review holds at most 500 conversations. Narrow the scope or select up to 500; no silent truncation.</p>}
      <ul className="cleanup-conversation-list">{rows.slice(0, shown).map(chat => {
        const checked = saved.selected.some(t => t.id === chat.id);
        return <li key={chat.id}><label><input type="checkbox" checked={checked} disabled={locked || !checked && saved.selected.length >= 500} onChange={e => client.configure({ selected: e.target.checked ? [...saved.selected, { id: chat.id, revision: chat.revision }] : saved.selected.filter(t => t.id !== chat.id) })}/><span><strong>{chat.title}</strong><span className="metadata">{chat.space === 'work' ? 'Work' : 'Chat'} · revision {chat.revision}</span></span></label></li>;
      })}</ul>
      {rows.length > shown && <button onClick={() => setShown(v => v + 50)}>Show 50 More ({rows.length - shown} Remaining)</button>}
    </section>}
    <section aria-label="Permanent review history"><div className="section-heading"><h3>Permanent Reviews And Results</h3><button disabled={!active || busy || view.invalid || view.historyBusy} onClick={() => void client.history()}>Refresh Saved Results</button></div>
      <p className="metadata">{view.history.total} saved reviews. Opening a result only reads its original status.</p>
      <ul className="cleanup-history">{view.history.items.map(item => <li key={item.id}><button disabled={locked || batch?.state === 'review' || !!batch?.running} onClick={() => void client.open(item.id)}><span>{item.count} · {item.scope.space === 'work' ? 'Work' : item.scope.space === 'chat' ? 'Chat' : 'Chat And Work'}</span><span className="metadata">{item.state} · {item.counts.applied} removed · {item.counts.unconfirmed} unconfirmed · {new Date(item.createdAt).toLocaleString()}</span></button></li>)}</ul>
      {view.history.nextOffset !== null && <button disabled={!active || busy || view.historyBusy} onClick={() => void client.history(view.history.nextOffset!)}>Show More Saved Results</button>}
    </section>
  </div>;
}
