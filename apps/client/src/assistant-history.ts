import type { ConversationHistory } from '../../../packages/domain/assistant';

/** A failed pagination read must not replace an already loaded transcript with
 * its smaller offline cache. Only fall back when this identity has no view. */
export function historyAfterReadFailure(current: ConversationHistory | undefined, cached: ConversationHistory | undefined, conversationId: string, nativeId: string | null | undefined): ConversationHistory | undefined {
  const matches = (value: ConversationHistory | undefined) => value?.conversationId === conversationId && (!!value.transcript || value.nativeId === nativeId) && Array.isArray(value.messages);
  return matches(current) ? current : matches(cached) ? cached : undefined;
}

/** Merge only adjoining windows. A refresh must not hide a gap in a long chat. */
export function mergeHistoryPage(current: ConversationHistory | undefined, page: ConversationHistory, direction: boolean | 'newer'): ConversationHistory {
  if (!current || current.conversationId !== page.conversationId || (!(current.transcript && page.transcript) && current.nativeId !== page.nativeId)) return page;
  const older = direction === true;
  const identity = (m: ConversationHistory['messages'][number]) => `${m.role}:${m.novaId ?? m.id}`;
  const existing = new Map(current.messages.map(m => [identity(m), m]));
  const incoming = page.messages.map(m => { const old = existing.get(identity(m)); return old && old.textHash === m.textHash && old.authoredText === m.authoredText && old.id === m.id && old.delivery === m.delivery && JSON.stringify(old.attachments) === JSON.stringify(m.attachments) ? old : m; });
  const growth = current.totalMessages !== undefined && page.totalMessages !== undefined ? Math.max(0, page.totalMessages - current.totalMessages) : 0;
  const offset = current.offset === undefined ? undefined : current.offset + growth;
  const nextOffset = current.nextOffset === undefined ? undefined : current.nextOffset + growth;
  const overlaps = incoming.some(m => existing.has(identity(m)));
  const currentStart = nextOffset ?? current.totalMessages, pageStart = page.nextOffset ?? page.totalMessages;
  const adjoining = offset !== undefined && page.offset !== undefined && currentStart !== undefined && pageStart !== undefined && page.offset <= currentStart && offset <= pageStart;
  if (current.messages.length && incoming.length && !overlaps && !adjoining && (!older || current.totalMessages !== undefined && page.totalMessages !== undefined)) {
    // Keep the reading window. The latest result may update settings and run state,
    // but its messages belong beyond a gap that has not been loaded yet.
    return { ...current, ...(current.transcript && page.transcript ? { nativeId: page.nativeId, transcript: page.transcript, retained: page.retained } : {}), nativeSettings: page.nativeSettings, activeRunIds: page.activeRunIds, inFlightRun: page.inFlightRun, totalMessages: page.totalMessages ?? current.totalMessages, offset, nextOffset, hasNewer: current.hasNewer || !older || page.offset !== undefined && offset !== undefined && page.offset < offset };
  }
  const messages = new Map((older ? [...incoming, ...current.messages] : [...current.messages, ...incoming]).map(m => [identity(m), m]));
  const all = [...messages.values()]; if (!page.transcript && all.every(m => m.sequence !== undefined)) all.sort((a, b) => a.sequence! - b.sequence!);
  const added = incoming.filter(m => !existing.has(identity(m))).length;
  const pagination = older ? { hasMore: page.hasMore, nextOffset: page.nextOffset, offset, hasNewer: current.hasNewer } : current.messages.length > page.messages.length || direction === 'newer' ? { hasMore: current.hasMore, nextOffset: nextOffset ?? (current.nextOffset === undefined ? undefined : current.nextOffset + added), offset: page.offset, hasNewer: page.hasNewer } : { hasMore: page.hasMore, nextOffset: page.nextOffset, offset: page.offset, hasNewer: page.hasNewer };
  // Legacy hosts omit total count; newly appended projections still shift their
  // backwards cursor by the number of newly observed messages.
  if (!older && current.totalMessages === undefined && pagination.nextOffset !== undefined) pagination.nextOffset = (current.nextOffset ?? 0) + added;
  const merged = { ...current, ...page, ...pagination, messages: all };
  if (all.length === current.messages.length && all.every((m, i) => m === current.messages[i]) && JSON.stringify({ ...merged, messages: [] }) === JSON.stringify({ ...current, messages: [] })) return current;
  return merged;
}
