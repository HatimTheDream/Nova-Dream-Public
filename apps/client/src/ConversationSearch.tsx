import { assistantSpace } from '../../../packages/domain/assistant-space';
import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { inSearchScope, type BrowseTarget, type ConversationSearchResult } from '../../../packages/domain/search';
import type { AssistantController } from './useAssistant';
import { request } from './api';
import { Search } from './icons';

export function ConversationSearch({ snapshot, controller, open }: { snapshot: Snapshot; controller: AssistantController; open: (target: BrowseTarget) => void }) {
  const [query, setQuery] = useState(''), [scope, setScope] = useState<'active' | 'archived' | 'all'>('all'), [project, setProject] = useState('all');
  const [result, setResult] = useState<ConversationSearchResult>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const serial = useRef(0), pending = useRef<AbortController | undefined>(undefined);
  const reset = () => { serial.current++; pending.current?.abort(); setResult(undefined); setBusy(false); setError(''); };
  useEffect(() => { reset(); return () => { serial.current++; pending.current?.abort(); }; }, [snapshot.epoch, controller.connection.generation, controller.space]);
  const search = async () => {
    if (!query.trim()) return;
    reset(); const turn = serial.current, abort = new AbortController(); pending.current = abort; setBusy(true);
    try {
      const data = await request<ConversationSearchResult>('assistant/search', { epoch: snapshot.epoch, query: query.trim(), space: controller.space, scope, ...(project !== 'all' ? { projectId: project || null } : {}) }, abort.signal);
      if (turn === serial.current && !abort.signal.aborted) setResult(data);
    } catch (reason) { if (!abort.signal.aborted && turn === serial.current) setError(reason instanceof Error ? reason.message : 'Search is unavailable.'); }
    finally { if (turn === serial.current) setBusy(false); }
  };
  const titles = query.trim() ? controller.conversations.filter(c => inSearchScope(c, { space: controller.space, scope, ...(project !== 'all' ? { projectId: project || null } : {}) }) && c.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 25) : [];
  const show = (conversationId: string, nativeId: string, extra: Partial<BrowseTarget> = {}) => open({ epoch: snapshot.epoch, conversationId, nativeId, ...extra });
  return <section className="conversation-search" aria-label="Search conversations"><form onSubmit={e => { e.preventDefault(); void search(); }}><label>Search saved messages<input type="search" value={query} maxLength={4096} onChange={e => { reset(); setQuery(e.target.value); }} placeholder="Words or a quoted phrase"/></label><div className="search-scope"><select aria-label="Search conversation scope" value={scope} onChange={e => { reset(); setScope(e.target.value as typeof scope); }}><option value="all">{controller.space === 'work' ? 'All work' : 'All chats'}</option><option value="active">Active only</option><option value="archived">Archive only</option></select><select aria-label="Search Project" value={project} onChange={e => { reset(); setProject(e.target.value); }}><option value="all">All Projects</option><option value="">Unfiled</option>{snapshot.projects.filter(p => assistantSpace(p.value) === controller.space).map(p => <option value={p.id} key={p.id}>{p.value.name}</option>)}</select></div><button type="submit" disabled={busy || !query.trim()}><Search size={16}/>{busy ? 'Searching…' : 'Search messages'}</button></form>
    {error && <p className="field-error" role="alert">{error}</p>}
    {titles.length > 0 && <div className="title-matches"><h3>Conversation titles</h3>{titles.map(c => <button key={c.id} disabled={!c.nativeId} onClick={() => c.nativeId && show(c.id, c.nativeId)}><strong>{c.title}</strong><small>{c.archived ? 'Archive' : 'Conversation'} · {c.nativeId ? 'Read only' : 'Setup unconfirmed'}</small></button>)}</div>}
    {result && <div className="message-matches" aria-live="polite"><h3>{result.results.length} message {result.results.length === 1 ? 'match' : 'matches'}</h3><p className="metadata">Searched {result.searchedConversations} app conversations. User and Assistant text on searchable branches; files, tool activity and reasoning are excluded.</p>{result.indexing !== false && <p className="search-coverage">{result.indexing ? 'Indexing is still in progress. These results may be incomplete.' : 'This host did not report index coverage.'}<button onClick={() => void search()} disabled={busy}>Refresh results</button></p>}{result.limited && <p className="metadata">More matches may exist. Add words or narrow the scope.</p>}{(result.excludedConversations > 0 || result.changedDuringSearch) && <p className="metadata">Some conversations were unavailable or changed during this search. Reconnect or search again to check them.</p>}
    {result.results.map(hit => { const conversation = controller.conversations.find(c => c.id === hit.conversationId); return <button className="message-match" key={JSON.stringify([hit.conversationId, hit.nativeId, hit.messageId, hit.role])} onClick={() => show(hit.conversationId, hit.nativeId, { messageId: hit.messageId, role: hit.role })}><strong>{conversation?.title ?? 'Saved conversation'}</strong><small>{conversation?.archived ? 'Archive · ' : ''}{hit.role === 'user' ? 'You' : 'Nova'} · {new Date(hit.timestamp).toLocaleDateString()}</small><span>{hit.snippet}</span><small>Open exact message</small></button>; })}</div>}
  </section>;
}
