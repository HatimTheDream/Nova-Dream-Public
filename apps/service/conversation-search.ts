import { z } from 'zod';
import type { AssistantTransport } from './gateway.js';
import { Fault, Store } from './store.js';
import type { Conversation } from '../../packages/domain/assistant.js';
import { conversationSearchSchema, inSearchScope, type ConversationSearchHit, type ConversationSearchResult } from '../../packages/domain/search.js';

const hitSchema = z.object({ sessionKey: z.string().min(1).max(1000), sessionId: z.string().uuid(), messageId: z.string().min(1).max(1000), role: z.enum(['user', 'assistant']), timestamp: z.number().int().nonnegative(), snippet: z.string().max(10000) });
/** Native full-text recall, constrained to the app's own explicit session keys. */
export class ConversationSearch {
  constructor(private store: Store, private gateway: AssistantTransport, private conversations: () => Conversation[]) {}
  async search(raw: unknown): Promise<ConversationSearchResult> {
    const input = conversationSearchSchema.parse(raw), before = this.gateway.status();
    const valid = () => input.epoch === this.store.epoch && before.generation === this.gateway.status().generation && this.gateway.status().state === 'ready';
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Search its current saved conversations again.');
    if (before.state !== 'ready' || !before.grantedScopes.includes('operator.read')) throw new Fault(503, 'search_unavailable', 'Connect the Assistant to search its saved messages. Your drafts are kept.');
    if (!before.methods.includes('sessions.search')) throw new Fault(501, 'search_unsupported', 'This OpenClaw host does not offer transcript search. Conversation titles remain available.');
    const scoped = this.conversations().filter(c => inSearchScope(c, input));
    const eligible = scoped.filter(c => !!c.nativeId && c.connectionGeneration === before.generation && c.state === 'ready');
    const chunks: Conversation[][] = []; for (let i = 0; i < eligible.length; i += 200) chunks.push(eligible.slice(i, i + 200));
    const found = new Map<string, ConversationSearchHit>(); let indexing: boolean | null = false, limited = false, changedDuringSearch = false;
    // The protocol bounds sessionKeys at 200 and hits at 25. Never broaden to other native sessions.
    for (let i = 0; i < chunks.length; i += 2) {
      const batches = chunks.slice(i, i + 2);
      const replies = await Promise.all(batches.map(async batch => {
        try { return await this.gateway.request<{ results?: unknown[]; indexing?: boolean; truncated?: boolean }>('sessions.search', { sessionKeys: batch.map(c => c.nativeKey), query: input.query, limit: 25 }); }
        catch { throw new Fault(503, 'search_failed', 'The host could not complete this search. Try a few words or a quoted phrase, then retry.'); }
      }));
      if (!valid()) throw new Fault(409, 'search_changed', 'The Assistant connection changed while searching. Search again on the current host.');
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
    if (!valid()) throw new Fault(409, 'search_changed', 'The workspace changed while searching. Search again.');
    const originals = new Map(eligible.map(c => [c.id, c]));
    const results = [...found.values()].filter(hit => { const original = originals.get(hit.conversationId), current = this.conversations().find(c => c.id === hit.conversationId); const keep = !!original && !!current && current.nativeId === original.nativeId && current.nativeKey === original.nativeKey && current.connectionGeneration === original.connectionGeneration && inSearchScope(current, input); if (!keep) changedDuringSearch = true; return keep; }).sort((a, b) => b.timestamp - a.timestamp || a.messageId.localeCompare(b.messageId));
    return { query: input.query, results: results.slice(0, 25), searchedConversations: eligible.length, excludedConversations: scoped.length - eligible.length, indexing, limited: limited || results.length > 25, changedDuringSearch };
  }
}
