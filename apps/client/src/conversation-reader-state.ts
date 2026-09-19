import type { ConversationHistory } from '../../../packages/domain/assistant';
import type { BrowseTarget } from '../../../packages/domain/search';

export type BrowsedHistory = { target: BrowseTarget; history: ConversationHistory };
export const browseTargetIdentity = (target: BrowseTarget) => JSON.stringify([
  target.epoch, target.conversationId, target.nativeId, target.messageId ?? null,
  target.messageHash ?? null, target.role ?? null, target.offset ?? null,
]);

/** Retain a read-only page through refresh/reconnect, but never show it beneath
 * a different source, version, pagination window, or restored workspace. */
export function retainedBrowseHistory(saved: BrowsedHistory | undefined, target: BrowseTarget, epoch: string): ConversationHistory | undefined {
  if (target.epoch !== epoch || !saved || browseTargetIdentity(saved.target) !== browseTargetIdentity(target)) return;
  return saved.history.conversationId === target.conversationId && saved.history.nativeId === target.nativeId ? saved.history : undefined;
}
