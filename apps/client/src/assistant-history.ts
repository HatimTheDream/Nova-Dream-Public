import type { ConversationHistory } from '../../../packages/domain/assistant';

/** A failed pagination read must not replace an already loaded transcript with
 * its smaller offline cache. Only fall back when this identity has no view. */
export function historyAfterReadFailure(current: ConversationHistory | undefined, cached: ConversationHistory | undefined, conversationId: string, nativeId: string | null | undefined): ConversationHistory | undefined {
  const matches = (value: ConversationHistory | undefined) => value?.conversationId === conversationId && (!!value.transcript || value.nativeId === nativeId) && Array.isArray(value.messages);
  return matches(current) ? current : matches(cached) ? cached : undefined;
}

const identity = (message: ConversationHistory['messages'][number]) => `${message.role}:${message.novaId ?? message.id}`;
function retiredOperationUsers(current: ConversationHistory, page: ConversationHistory) {
  const aliases = new Map<string, ConversationHistory['messages'][number]>(page.messages.flatMap(message => (message.aliases ?? []).map(alias => [`${message.role}:${alias}`, message] as const)));
  return new Set(current.messages.filter(message => {
    const confirmed = message.novaId && aliases.get(identity(message));
    // Only the archive's explicit alias can replace an early reading-window
    // placeholder. A known conflicting run or a different binding stays visible.
    return confirmed && message.role === 'user' && message.source?.kind === 'operation' && ['native', 'legacy'].includes(confirmed.source?.kind ?? '') && message.source.bindingId === confirmed.source?.bindingId && message.operationId && message.operationId === confirmed.operationId && confirmed.runId && (!message.runId || message.runId === confirmed.runId);
  }).map(identity));
}

/** A repair outside this window can move either cursor. Reopen an exact saved
 * anchor instead of guessing which side of the window lost a placeholder. */
export function historyRepairAnchor(current: ConversationHistory | undefined, page: ConversationHistory, preferredId?: string) {
  if (!current?.transcript || !page.transcript || current.conversationId !== page.conversationId || current.totalMessages === undefined || page.totalMessages === undefined || current.totalMessages - page.totalMessages <= retiredOperationUsers(current, page).size) return undefined;
  return (preferredId ? current.messages.find(message => message.id === preferredId || message.novaId === preferredId || message.aliases?.includes(preferredId)) : undefined) ?? (current.offset === 0 && !current.hasNewer ? current.messages.at(-1) : current.messages[0]);
}

/** Merge only adjoining windows. A refresh must not hide a gap in a long chat. */
export function mergeHistoryPage(current: ConversationHistory | undefined, page: ConversationHistory, direction: boolean | 'newer'): ConversationHistory {
  if (!current || current.conversationId !== page.conversationId || (!(current.transcript && page.transcript) && current.nativeId !== page.nativeId)) return page;
  if (historyRepairAnchor(current, page)) return current;
  const older = direction === true;
  const existing = new Map(current.messages.map(m => [identity(m), m]));
  const metadata = (m: ConversationHistory['messages'][number]) => JSON.stringify([m.toolInfo, m.runId, m.operationId, m.sequence, m.aliases, m.source && { ...m.source, observedAt: undefined }]);
  const incoming = page.messages.map(m => { const old = existing.get(identity(m)); return old && old.textHash === m.textHash && old.authoredText === m.authoredText && old.id === m.id && old.delivery === m.delivery && JSON.stringify(old.attachments) === JSON.stringify(m.attachments) && metadata(old) === metadata(m) ? old : m; });
  const retiredIds = retiredOperationUsers(current, page), retained = current.messages.filter(message => !retiredIds.has(identity(message)));
  const retired = current.messages.length - retained.length;
  const growth = current.totalMessages !== undefined && page.totalMessages !== undefined ? Math.max(0, page.totalMessages - current.totalMessages + retired) : 0;
  const offset = current.offset === undefined ? undefined : current.offset + growth;
  const nextOffset = current.nextOffset === undefined ? undefined : Math.max(0, current.nextOffset + growth - retired);
  const overlaps = retired > 0 || incoming.some(m => existing.has(identity(m)));
  const currentStart = nextOffset ?? current.totalMessages, pageStart = page.nextOffset ?? page.totalMessages;
  const adjoining = offset !== undefined && page.offset !== undefined && currentStart !== undefined && pageStart !== undefined && page.offset <= currentStart && offset <= pageStart;
  if (current.messages.length && incoming.length && !overlaps && !adjoining && (!older || current.totalMessages !== undefined && page.totalMessages !== undefined)) {
    // Keep the reading window. The latest result may update settings and run state,
    // but its messages belong beyond a gap that has not been loaded yet.
    return { ...current, ...(current.transcript && page.transcript ? { nativeId: page.nativeId, transcript: page.transcript, retained: page.retained } : {}), nativeSettings: page.nativeSettings, activeRunIds: page.activeRunIds, inFlightRun: page.inFlightRun, totalMessages: page.totalMessages ?? current.totalMessages, offset, nextOffset, hasNewer: current.hasNewer || !older || page.offset !== undefined && offset !== undefined && page.offset < offset };
  }
  const messages = new Map((older ? [...incoming, ...retained] : [...retained, ...incoming]).map(m => [identity(m), m]));
  // Older windows may overlap rows already on screen. Keep their position, but
  // accept the newly read outcome/identity just as a head refresh would.
  if (older) for (const message of incoming) messages.set(identity(message), message);
  const all = [...messages.values()]; if (!page.transcript && all.every(m => m.sequence !== undefined)) all.sort((a, b) => a.sequence! - b.sequence!);
  const added = incoming.filter(m => !existing.has(identity(m))).length;
  const pagination = older ? { hasMore: page.hasMore, nextOffset: page.nextOffset, offset, hasNewer: current.hasNewer } : retained.length > page.messages.length || direction === 'newer' ? { hasMore: current.hasMore, nextOffset: nextOffset ?? (current.nextOffset === undefined ? undefined : current.nextOffset + added - retired), offset: page.offset, hasNewer: page.hasNewer } : { hasMore: page.hasMore, nextOffset: page.nextOffset, offset: page.offset, hasNewer: page.hasNewer };
  // Legacy hosts omit total count; newly appended projections still shift their
  // backwards cursor by the number of newly observed messages.
  if (!older && current.totalMessages === undefined && pagination.nextOffset !== undefined) pagination.nextOffset = Math.max(0, (current.nextOffset ?? 0) + added - retired);
  const merged = { ...current, ...page, ...pagination, messages: all };
  if (all.length === current.messages.length && all.every((m, i) => m === current.messages[i]) && JSON.stringify({ ...merged, messages: [] }) === JSON.stringify({ ...current, messages: [] })) return current;
  return merged;
}
