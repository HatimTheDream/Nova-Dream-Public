import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AssistantTransport } from './gateway.js';
import { Fault, Store } from './store.js';
import type { Conversation, ConversationHistory, ConversationMessage } from '../../packages/domain/assistant.js';
import { conversationSearchSchema, inSearchScope, searchPageSize, type ConversationSearchHit as Hit, type ConversationSearchResult } from '../../packages/domain/search.js';
import { SavedHistory } from './saved-history.js';

const hitSchema = z.object({ sessionKey: z.string().min(1).max(1000), sessionId: z.string().uuid(), messageId: z.string().min(1).max(1000), role: z.enum(['user', 'assistant']), timestamp: z.number().int().nonnegative(), snippet: z.string().max(10000) });
type Input = z.infer<typeof conversationSearchSchema>;
type Coverage = Pick<ConversationSearchResult, 'searchedConversations' | 'excludedConversations' | 'indexing' | 'changedDuringSearch'>;
type Search = { identity: string; generation: string | null; scope: Map<string, Conversation>; terms: string[]; native: Map<string, Hit>; gaps: Conversation[]; nativeLimited: boolean; coverage: Coverage };
type HistoryPosition = { conversation: number; offset: number; total?: number };
type Page = { search: Search; hits: Hit[]; start: number; older?: Hit; history?: HistoryPosition };
const windowSize = searchPageSize * 4;
const hitKey = (hit: Hit) => JSON.stringify([hit.conversationId, hit.nativeId, hit.messageId, hit.role]);
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const order = (a: Hit, b: Hit) => b.timestamp - a.timestamp || compareId(a.messageId, b.messageId) || compareId(a.conversationId, b.conversationId) || compareId(a.nativeId, b.nativeId) || compareId(a.role, b.role);
const sameBinding = (a: Conversation, b: Conversation) => a.nativeId === b.nativeId && a.nativeKey === b.nativeKey && a.connectionGeneration === b.connectionGeneration && !!a.directAgent === !!b.directAgent;
function authoredHit(conversation: Conversation, message: ConversationMessage, terms: string[]): Hit | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') return;
  const nativeId = message.source?.nativeId ?? conversation.nativeId;
  const text = message.authoredText ?? message.text, normalized = text.toLocaleLowerCase();
  if (!nativeId || !terms.every(term => normalized.includes(term))) return;
  const start = Math.max(0, Math.min(...terms.map(term => normalized.indexOf(term))) - 100), stamp = Date.parse(message.createdAt ?? '');
  return { conversationId: conversation.id, nativeId, messageId: message.id, role: message.role, timestamp: Number.isFinite(stamp) ? Math.max(0, stamp) : 0, snippet: text.slice(start, start + 800) };
}

// Retain only the next few result pages, even if every saved message matches.
class HitWindow {
  private hits = new Map<string, Hit>();
  private last?: Hit;
  constructor(private after?: Hit) {}
  add(hit: Hit) {
    if (this.after && order(hit, this.after) <= 0 || this.last && order(hit, this.last) > 0) return;
    this.hits.set(hitKey(hit), hit);
    if (this.hits.size >= windowSize * 2) this.trim();
  }
  private trim() {
    const kept = [...this.hits.values()].sort(order).slice(0, windowSize + 1);
    this.hits = new Map(kept.map(hit => [hitKey(hit), hit]));
    this.last = kept.at(-1);
  }
  take() { return [...this.hits.values()].sort(order).slice(0, windowSize + 1); }
}

export class ConversationSearch {
  // Short-lived, process-local continuation tokens carry no saved data across restarts.
  private pages = new Map<string, { page: Page; expires: number }>();
  constructor(private store: Store, private gateway: AssistantTransport, private conversations: () => Conversation[], private project?: (conversation: Conversation, history: ConversationHistory) => ConversationHistory, private readNative?: (conversation: Conversation, offset: number) => Promise<ConversationHistory>) {}
  private scoped(input: Input) { return this.conversations().filter(c => inSearchScope(c, input) && !this.store.internalRead(`assistant:removed:${c.id}`)); }
  private remember(page: Page) {
    for (const [token, entry] of this.pages) if (entry.expires <= Date.now()) this.pages.delete(token);
    while (this.pages.size >= 32) this.pages.delete(this.pages.keys().next().value!);
    const token = randomUUID(); this.pages.set(token, { page, expires: Date.now() + 15 * 60000 }); return token;
  }
  private savedWindow(search: Search, after?: Hit) {
    const window = new HitWindow(after), local = new Set<string>(), complete = new Set<string>();
    const saved = new SavedHistory(this.store, this.project);
    for (const conversation of search.scope.values()) {
      const history = saved.snapshot(conversation); if (!history) continue;
      local.add(conversation.id); if (history.transcript.complete) complete.add(conversation.id);
      for (const message of history.messages) {
        const hit = authoredHit(conversation, message, search.terms);
        if (hit && !search.native.has(hitKey(hit))) window.add(hit);
      }
    }
    return { window, local, complete };
  }
  private pageFromWindow(search: Search, window: HitWindow): Page {
    for (const hit of search.native.values()) window.add(hit);
    const hits = window.take(), more = hits.length > windowSize;
    if (more) hits.pop();
    return { search, hits, start: 0, older: more ? hits.at(-1) : undefined, history: search.gaps.length ? { conversation: 0, offset: 0 } : undefined };
  }
  private deliver(input: Input, page: Page): ConversationSearchResult {
    const { search } = page, results = page.hits.slice(page.start, page.start + searchPageSize), start = page.start + results.length;
    const nextCursor = start < page.hits.length || page.older || page.history ? this.remember({ ...page, start }) : null;
    return { query: input.query, ...search.coverage, results, nextCursor, nativeLimited: search.nativeLimited, limited: !!nextCursor || search.nativeLimited };
  }
  private assertCurrent(input: Input, search: Search) {
    const status = this.gateway.status();
    if (input.epoch !== this.store.epoch || (status.generation ?? null) !== search.generation || (search.native.size || search.gaps.length) && (status.state !== 'ready' || !status.grantedScopes.includes('operator.read')))
      throw new Fault(409, 'search_changed', 'The Assistant connection changed. Search again on the current host.');
    const current = this.scoped(input);
    if (current.length !== search.scope.size || current.some(c => { const original = search.scope.get(c.id); return !original || !sameBinding(original, c); }))
      throw new Fault(409, 'search_changed', 'The conversations in this search changed. Search again.');
  }
  private async moreHistory(input: Input, search: Search, position: HistoryPosition): Promise<Page> {
    const conversation = search.gaps[position.conversation], offset = position.offset;
    const following = position.conversation + 1 < search.gaps.length ? { conversation: position.conversation + 1, offset: 0 } : undefined;
    const saved = new SavedHistory(this.store, this.project).snapshot(conversation);
    const local = new Set((saved?.messages ?? []).flatMap(message => {
      const hit = authoredHit(conversation, message, search.terms); return hit ? [hitKey(hit)] : [];
    }));
    let page: ConversationHistory;
    try { page = await this.readNative!(conversation, offset); }
    catch { this.assertCurrent(input, search); return { search: { ...search, coverage: { ...search.coverage, changedDuringSearch: true } }, hits: [], start: 0, history: following }; }
    this.assertCurrent(input, search);
    if (page.conversationId !== conversation.id || page.nativeId !== conversation.nativeId || page.offset !== offset || (position.total !== undefined && page.totalMessages !== position.total))
      throw new Fault(409, 'search_changed', 'The native conversation changed. Search again to see its current messages.');
    const hits = new Map<string, Hit>();
    for (const message of page.messages) {
      const hit = authoredHit(conversation, message, search.terms); if (!hit) continue;
      const key = hitKey(hit); if (!search.native.has(key) && !local.has(key)) hits.set(key, hit);
    }
    const hasOlder = page.hasMore && page.nextOffset !== undefined && page.nextOffset > offset;
    if (page.hasMore && !hasOlder) search = { ...search, coverage: { ...search.coverage, changedDuringSearch: true } };
    return { search, hits: [...hits.values()].sort(order), start: 0, history: hasOlder ? { ...position, offset: page.nextOffset!, total: page.totalMessages } : following };
  }
  async search(raw: unknown): Promise<ConversationSearchResult> {
    const input = conversationSearchSchema.parse(raw), before = this.gateway.status();
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Search its current saved conversations again.');
    const identity = JSON.stringify([input.epoch, input.space, input.scope, input.projectId === undefined ? 'all' : [input.projectId], input.query]);
    if (input.cursor) {
      const entry = this.pages.get(input.cursor);
      if (!entry || entry.expires <= Date.now() || entry.page.search.identity !== identity) throw new Fault(409, 'search_cursor', 'This search page has expired or its filters changed. Search messages again.');
      let page = entry.page; this.assertCurrent(input, page.search);
      if (page.start >= page.hits.length) {
        if (page.older) page = this.pageFromWindow(page.search, this.savedWindow(page.search, page.older).window);
        else if (page.history) page = await this.moreHistory(input, page.search, page.history);
      }
      return this.deliver(input, page);
    }
    const scoped = this.scoped(input);
    const search: Search = { identity, generation: before.generation ?? null, scope: new Map(scoped.map(c => [c.id, { ...c }])), terms: [...input.query.matchAll(/"([^"]+)"|(\S+)/g)].map(match => (match[1] ?? match[2]).toLocaleLowerCase()), native: new Map(), gaps: [], nativeLimited: false, coverage: { searchedConversations: 0, excludedConversations: 0, indexing: false, changedDuringSearch: false } };
    const { window, local, complete } = this.savedWindow(search);
    const canSearchNative = before.state === 'ready' && before.grantedScopes.includes('operator.read') && before.methods.includes('sessions.search');
    const eligible = canSearchNative ? scoped.filter(c => !c.directAgent && !complete.has(c.id) && !!c.nativeId && c.connectionGeneration === before.generation && c.state === 'ready') : [];
    const chunks: Conversation[][] = [];
    for (let i = 0; i < eligible.length; i += 200) chunks.push(eligible.slice(i, i + 200));
    const coverage = search.coverage;
    coverage.indexing = complete.size === scoped.length || canSearchNative ? false : null;
    let abandoned = false;
    for (let i = 0; i < chunks.length; i += 2) {
      const batches = chunks.slice(i, i + 2);
      const replies = await Promise.all(batches.map(async batch => {
        try { return await this.gateway.request<{ results?: unknown[]; indexing?: boolean; truncated?: boolean }>('sessions.search', { sessionKeys: batch.map(c => c.nativeKey), query: input.query, limit: 25 }); }
        catch { if (local.size) { abandoned = true; return { results: [] }; } throw new Fault(503, 'search_failed', 'The host could not complete this search. Saved messages remain available.'); }
      }));
      if (input.epoch !== this.store.epoch) throw new Fault(409, 'search_changed', 'The workspace changed while searching. Search again.');
      const status = this.gateway.status();
      if (status.generation !== before.generation || status.state !== 'ready' || !status.grantedScopes.includes('operator.read')) {
        if (!local.size) throw new Fault(409, 'search_changed', 'The Assistant connection changed while searching. Search again on the current host.');
        abandoned = true;
      }
      if (abandoned) { search.native.clear(); search.gaps = []; search.nativeLimited = false; coverage.indexing = null; coverage.changedDuringSearch = true; break; }
      replies.forEach((reply, index) => {
        if (!Array.isArray(reply.results) || reply.results.length > 25) throw new Fault(502, 'search_response', 'The host returned an unsupported search response.');
        if (reply.indexing === true) coverage.indexing = true; else if (typeof reply.indexing !== 'boolean' && coverage.indexing !== true) coverage.indexing = null;
        if (reply.truncated === true || reply.results.length === 25) {
          // The index cannot page omitted reset branches. Current bindings additionally support scoped history offsets.
          search.nativeLimited = true;
          if (this.readNative && status.methods.includes('chat.history')) search.gaps.push(...batches[index]);
        }
        const captured = new Map(batches[index].map(c => [c.nativeKey, c]));
        for (const value of reply.results) {
          const parsed = hitSchema.safeParse(value);
          const original = parsed.success && captured.get(parsed.data.sessionKey);
          if (!parsed.success || !original) { coverage.changedDuringSearch = true; continue; }
          const h = parsed.data, result: Hit = { conversationId: original.id, nativeId: h.sessionId, messageId: h.messageId, role: h.role, timestamp: h.timestamp, snippet: h.snippet.slice(0, 800) };
          search.native.set(hitKey(result), result);
        }
      });
    }
    // Recheck the visible scope after all awaits, including pending/deleted conversations.
    const current = new Map(this.scoped(input).map(c => [c.id, c]));
    for (const [id, original] of search.scope) {
      const row = current.get(id);
      if (row && sameBinding(original, row)) continue;
      search.scope.delete(id); local.delete(id); coverage.changedDuringSearch = true;
    }
    for (const [key, hit] of search.native) if (!search.scope.has(hit.conversationId)) search.native.delete(key);
    search.gaps = search.gaps.filter(c => search.scope.has(c.id));
    coverage.searchedConversations = new Set([...local, ...abandoned ? [] : eligible.filter(c => search.scope.has(c.id)).map(c => c.id)]).size;
    coverage.excludedConversations = scoped.length - coverage.searchedConversations;
    // Rebuild only when an in-flight scope change discarded a previously captured row.
    const resultWindow = search.scope.size === scoped.length && ![...search.native.values()].some(hit => local.has(hit.conversationId)) ? window : this.savedWindow(search).window;
    return this.deliver(input, this.pageFromWindow(search, resultWindow));
  }
}
