import { matchesSearchQuery, type SearchQueryRequest } from './search-workspace';
import { assistantSpace } from '../../../packages/domain/assistant-space';
import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { inSearchScope, searchPageSize, type BrowseTarget, type ConversationSearchResult } from '../../../packages/domain/search';
import type { AssistantController } from './useAssistant';
import { request } from './api';
import { Search } from './icons';

export function ConversationSearch({ snapshot, controller, open, seed, seedAccepted }: { seed?: SearchQueryRequest; seedAccepted?: (nonce: string) => void; snapshot: Snapshot; controller: AssistantController; open: (target: BrowseTarget) => void }) {
  const [query, setQuery] = useState(''), [scope, setScope] = useState<'active' | 'archived' | 'all'>('all'), [project, setProject] = useState('all');
  const [pages, setPages] = useState<ConversationSearchResult[]>([]), [pageIndex, setPageIndex] = useState(0);
  const [titleIndex, setTitleIndex] = useState(0), result = pages[pageIndex];
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const scopedConversations = controller.conversations.filter(c => inSearchScope(c, { space: controller.space, scope, ...(project !== 'all' ? { projectId: project || null } : {}) }));
  const visibleBindings = JSON.stringify(scopedConversations.map(c => [c.id, c.nativeId, c.nativeKey, c.connectionGeneration]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const serial = useRef(0), pending = useRef<AbortController | undefined>(undefined);
  const reset = () => { serial.current++; pending.current?.abort(); setPages([]); setPageIndex(0); setTitleIndex(0); setBusy(false); setError(''); };
  const seeded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!matchesSearchQuery(seed, snapshot) || seeded.current === seed!.nonce) return;
    seeded.current = seed!.nonce; reset(); setQuery(seed!.query); seedAccepted?.(seed!.nonce);
  }, [seed?.nonce, snapshot.epoch, snapshot.deviceId]);
  useEffect(() => { reset(); return () => { serial.current++; pending.current?.abort(); }; }, [snapshot.deviceId, snapshot.epoch, controller.connection.generation, controller.space, visibleBindings]);
  const search = async (cursor?: string) => {
    if (!query.trim()) return;
    if (cursor && pages[pageIndex + 1]) { setPageIndex(pageIndex + 1); return; }
    if (cursor) { serial.current++; pending.current?.abort(); setError(''); } else reset();
    const turn = serial.current, abort = new AbortController(); pending.current = abort; setBusy(true);
    try {
      const data = await request<ConversationSearchResult>('assistant/search', { epoch: snapshot.epoch, query: query.trim(), space: controller.space, scope, ...(project !== 'all' ? { projectId: project || null } : {}), ...(cursor ? { cursor } : {}) }, abort.signal);
      if (turn === serial.current && !abort.signal.aborted) {
        setPages(previous => cursor ? [...previous, data] : [data]); setPageIndex(cursor ? pageIndex + 1 : 0);
      }
    } catch (reason) { if (!abort.signal.aborted && turn === serial.current) setError(reason instanceof Error ? reason.message : 'Search is unavailable.'); }
    finally { if (turn === serial.current) setBusy(false); }
  };
  const titles = query.trim() ? scopedConversations.filter(c => c.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [];
  const titleStart = Math.min(titleIndex, Math.max(0, Math.ceil(titles.length / searchPageSize) - 1)) * searchPageSize;
  const previousCount = pages.slice(0, pageIndex).reduce((count, page) => count + page.results.length, 0);
  const show = (conversationId: string, nativeId: string, extra: Partial<BrowseTarget> = {}) => open({ epoch: snapshot.epoch, conversationId, nativeId, ...extra });
  return <section className="conversation-search" aria-label="Search conversations"><form onSubmit={e => { e.preventDefault(); void search(); }}><label>Search saved messages<input type="search" value={query} maxLength={4096} onChange={e => { reset(); setQuery(e.target.value); }} placeholder="Words or a quoted phrase"/></label><div className="search-scope"><select aria-label="Search conversation scope" value={scope} onChange={e => { reset(); setScope(e.target.value as typeof scope); }}><option value="all">{controller.space === 'work' ? 'All work' : 'All chats'}</option><option value="active">Active only</option><option value="archived">Archive only</option></select><select aria-label="Search Project" value={project} onChange={e => { reset(); setProject(e.target.value); }}><option value="all">All Projects</option><option value="">Unfiled</option>{snapshot.projects.filter(p => assistantSpace(p.value) === controller.space).map(p => <option value={p.id} key={p.id}>{p.value.name}</option>)}</select></div><button type="submit" disabled={busy || !query.trim()}><Search size={16}/>{busy ? 'Searching…' : 'Search messages'}</button></form>
    {error && <p className="field-error" role="alert">{error}</p>}
    {titles.length > 0 && <div className="title-matches"><h3>Conversation titles</h3>{titles.slice(titleStart, titleStart + searchPageSize).map(c => <button key={c.id} disabled={!c.nativeId} onClick={() => c.nativeId && show(c.id, c.nativeId)}><strong>{c.title}</strong><small>{c.archived ? 'Archive' : 'Conversation'} · {c.nativeId ? 'Read only' : 'Setup unconfirmed'}</small></button>)}
      {titles.length > searchPageSize && <nav aria-label="Title result pages"><button disabled={!titleStart} onClick={() => setTitleIndex(titleStart / searchPageSize - 1)}>Previous titles</button><span>{titleStart + 1}–{Math.min(titles.length, titleStart + searchPageSize)} of {titles.length}</span><button disabled={titleStart + searchPageSize >= titles.length} onClick={() => setTitleIndex(titleStart / searchPageSize + 1)}>Next titles</button></nav>}
    </div>}
    {result && <div className="message-matches" aria-live="polite"><h3>{result.results.length ? previousCount || result.nextCursor ? `Message matches ${previousCount + 1}–${previousCount + result.results.length}` : `${result.results.length} message ${result.results.length === 1 ? 'match' : 'matches'}` : previousCount ? 'No additional matches on this page' : 'No message matches on this page'}</h3><p className="metadata">Searched {result.searchedConversations} app conversations. User and Assistant text on searchable branches; files, tool activity and reasoning are excluded.</p>{result.indexing !== false && <p className="search-coverage">{result.indexing ? 'Indexing is still in progress. These results may be incomplete.' : 'This host did not report index coverage.'}<button onClick={() => void search()} disabled={busy}>Refresh results</button></p>}{result.nativeLimited && <p className="metadata">The host limits its index results. Older reset branches may have additional matches.</p>}{(result.excludedConversations > 0 || result.changedDuringSearch) && <p className="metadata">Some conversations were unavailable or changed during this search. Reconnect or search again to check them.</p>}
    {result.results.map(hit => { const conversation = scopedConversations.find(c => c.id === hit.conversationId); if (!conversation) return null; return <button className="message-match" key={JSON.stringify([hit.conversationId, hit.nativeId, hit.messageId, hit.role])} onClick={() => show(hit.conversationId, hit.nativeId, { messageId: hit.messageId, role: hit.role })}><strong>{conversation?.title ?? 'Saved conversation'}</strong><small>{conversation?.archived ? 'Archive · ' : ''}{hit.role === 'user' ? 'You' : 'Nova'} · {new Date(hit.timestamp).toLocaleDateString()}</small><span>{hit.snippet}</span><small>Open exact message</small></button>; })}
      {(pageIndex > 0 || result.nextCursor) && <nav aria-label="Message result pages"><button disabled={!pageIndex || busy} onClick={() => { setError(''); setPageIndex(pageIndex - 1); }}>Previous matches</button><button disabled={!result.nextCursor || busy} onClick={() => result.nextCursor && void search(result.nextCursor)}>Next matches</button></nav>}
    </div>}
  </section>;
}
