import { z } from 'zod';
import type { AssistantTransport } from './gateway.js';
import { Fault, Store } from './store.js';
import type { Conversation, ConversationHistory } from '../../packages/domain/assistant.js';
import { conversationSearchSchema, inSearchScope, type ConversationSearchHit, type ConversationSearchResult } from '../../packages/domain/search.js';
import { SavedHistory } from './saved-history.js';

const hitSchema = z.object({ sessionKey: z.string().min(1).max(1000), sessionId: z.string().uuid(), messageId: z.string().min(1).max(1000), role: z.enum(['user', 'assistant']), timestamp: z.number().int().nonnegative(), snippet: z.string().max(10000) });
/** Saved Nova dialogue is always searchable; native search fills uncaptured gaps. */
export class ConversationSearch {
  constructor(private store: Store, private gateway: AssistantTransport, private conversations: () => Conversation[], private project?: (conversation: Conversation, history: ConversationHistory) => ConversationHistory) {}
  async search(raw: unknown): Promise<ConversationSearchResult> {
    const input = conversationSearchSchema.parse(raw), before = this.gateway.status();
    const valid = () => input.epoch === this.store.epoch && before.generation === this.gateway.status().generation && this.gateway.status().state === 'ready';
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Search its current saved conversations again.');
    const scoped = this.conversations().filter(c => inSearchScope(c, input));
    const saved = new SavedHistory(this.store, this.project), local = new Map<string, ConversationSearchHit>(), localIds = new Set<string>(), completeIds = new Set<string>();
    const terms = [...input.query.matchAll(/"([^"]+)"|(\S+)/g)].map(match => (match[1] ?? match[2]).toLocaleLowerCase());
    for (const conversation of scoped) {
      const page = saved.snapshot(conversation); if (!page) continue;
      localIds.add(conversation.id); if (page.transcript?.complete) completeIds.add(conversation.id);
      for (const message of page.messages) {
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        const text = message.authoredText ?? message.text, normalized = text.toLocaleLowerCase();
        if (!terms.every(term => normalized.includes(term))) continue;
        const start = Math.max(0, Math.min(...terms.map(term => normalized.indexOf(term))) - 100), nativeId = message.source?.nativeId ?? conversation.nativeId;
        if (!nativeId) continue;
        const stamp = Date.parse(message.createdAt ?? ''), hit: ConversationSearchHit = { conversationId: conversation.id, nativeId, messageId: message.id, role: message.role, timestamp: Number.isFinite(stamp) ? Math.max(0, stamp) : 0, snippet: text.slice(start, start + 800) };
        local.set(JSON.stringify([hit.conversationId, hit.nativeId, hit.messageId, hit.role]), hit);
      }
    }
    const canSearchNative = before.state === 'ready' && before.grantedScopes.includes('operator.read') && before.methods.includes('sessions.search');
    const eligible = canSearchNative ? scoped.filter(c => !completeIds.has(c.id) && !!c.nativeId && c.connectionGeneration === before.generation && c.state === 'ready') : [];
    const chunks: Conversation[][] = []; for (let i = 0; i < eligible.length; i += 200) chunks.push(eligible.slice(i, i + 200));
    const found = new Map(local); let indexing: boolean | null = completeIds.size === scoped.length ? false : canSearchNative ? false : null, limited = false, changedDuringSearch = false, nativeAbandoned = false;
    // The protocol bounds sessionKeys at 200 and hits at 25. Never broaden to other native sessions.
    for (let i = 0; i < chunks.length; i += 2) {
      const batches = chunks.slice(i, i + 2);
      const replies = await Promise.all(batches.map(async batch => {
        try { return await this.gateway.request<{ results?: unknown[]; indexing?: boolean; truncated?: boolean }>('sessions.search', { sessionKeys: batch.map(c => c.nativeKey), query: input.query, limit: 25 }); }
        catch { if (localIds.size) { nativeAbandoned = true; return { results: [] }; } throw new Fault(503, 'search_failed', 'The host could not complete this search. Saved messages remain available.'); }
      }));
      if (input.epoch !== this.store.epoch) throw new Fault(409, 'search_changed', 'The workspace changed while searching. Search again.');
      if (!valid()) { if (localIds.size) nativeAbandoned = true; else throw new Fault(409, 'search_changed', 'The Assistant connection changed while searching. Search again on the current host.'); }
      if (nativeAbandoned) { found.clear(); local.forEach((hit, key) => found.set(key, hit)); indexing = null; changedDuringSearch = true; break; }
      replies.forEach((reply, index) => {
        if (!Array.isArray(reply.results) || reply.results.length > 25) throw new Fault(502, 'search_response', 'The host returned an unsupported search response.');
        if (reply.indexing === true) indexing = true; else if (typeof reply.indexing !== 'boolean' && indexing !== true) indexing = null;
        limited ||= reply.truncated === true || reply.results.length === 25;
        const captured = new Map(batches[index].map(c => [c.nativeKey, c]));
        for (const value of reply.results) {
          const parsed = hitSchema.safeParse(value); if (!parsed.success) { changedDuringSearch = true; continue; }
          const hit = parsed.data, original = captured.get(hit.sessionKey);
          const current = original && this.conversations().find(c => c.id === original.id);
          if (!original || !current || current.nativeKey !== original.nativeKey || current.nativeId !== original.nativeId || current.connectionGeneration !== original.connectionGeneration || !inSearchScope(current, input)) { changedDuringSearch = true; continue; }
          // An older sessionId can identify retained reset history under this same native key.
          const result: ConversationSearchHit = { conversationId: original.id, nativeId: hit.sessionId, messageId: hit.messageId, role: hit.role, timestamp: hit.timestamp, snippet: hit.snippet.slice(0, 800) };
          found.set(JSON.stringify([result.conversationId, result.nativeId, result.messageId, result.role]), result);
        }
      });
    }
    if (input.epoch !== this.store.epoch || eligible.length > 0 && !nativeAbandoned && !valid()) throw new Fault(409, 'search_changed', 'The workspace changed while searching. Search again.');
    const originals = new Map(scoped.map(c => [c.id, c]));
    const results = [...found.values()].filter(hit => { const original = originals.get(hit.conversationId), current = this.conversations().find(c => c.id === hit.conversationId); const isLocal = local.has(JSON.stringify([hit.conversationId, hit.nativeId, hit.messageId, hit.role])); const keep = !!original && !!current && (isLocal || current.nativeId === original.nativeId && current.nativeKey === original.nativeKey && current.connectionGeneration === original.connectionGeneration) && inSearchScope(current, input) && !this.store.internalRead(`assistant:removed:${current.id}`); if (!keep) changedDuringSearch = true; return keep; }).sort((a, b) => b.timestamp - a.timestamp || a.messageId.localeCompare(b.messageId));
    const searched = new Set([...localIds, ...nativeAbandoned ? [] : eligible.map(c => c.id)]).size;
    return { query: input.query, results: results.slice(0, 25), searchedConversations: searched, excludedConversations: scoped.length - searched, indexing, limited: limited || results.length > 25, changedDuringSearch };
  }
}
