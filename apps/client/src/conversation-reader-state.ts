import type { ConversationHistory } from '../../../packages/domain/assistant';
import type { BrowseTarget } from '../../../packages/domain/search';

export type BrowsedHistory = { target: BrowseTarget; history: ConversationHistory };
export const browseTargetIdentity = (target: BrowseTarget) => JSON.stringify([
  target.epoch, target.conversationId, target.nativeId, target.messageId ?? null,
  target.messageHash ?? null, target.role ?? null, target.offset ?? null,
]);

export function matchesBrowseSource(history: ConversationHistory, target: BrowseTarget): boolean {
  if (history.conversationId !== target.conversationId) return false;
  const exact = target.messageId ? history.messages.some(message =>
    (message.source?.nativeId ?? history.nativeId) === target.nativeId
    && (message.id === target.messageId || message.novaId === target.messageId || message.aliases?.includes(target.messageId!))
    && (!target.role || message.role === target.role) && (!target.messageHash || message.textHash === target.messageHash)) : undefined;
  if (target.messageId && !exact) return false;
  if (history.nativeId === target.nativeId) return true;
  if (!history.transcript) return false;
  return exact ?? (history.transcript.bindings.some(binding => binding.nativeId === target.nativeId) && history.messages.every(message => message.source?.nativeId === target.nativeId));
}

/** Retain a read-only page through refresh/reconnect, but never show it beneath
 * a different source, version, pagination window, or restored workspace. */
export function retainedBrowseHistory(saved: BrowsedHistory | undefined, target: BrowseTarget, epoch: string): ConversationHistory | undefined {
  if (target.epoch !== epoch || !saved || browseTargetIdentity(saved.target) !== browseTargetIdentity(target)) return;
  return matchesBrowseSource(saved.history, target) ? saved.history : undefined;
}
