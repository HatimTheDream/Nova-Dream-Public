import type { Conversation } from '../../../packages/domain/assistant';

/** Only follow verified app/native ancestry; a same app ID with replaced history is unrelated. */
export function relatedConversations(current: Conversation, conversations: Conversation[]): Conversation[] {
  const parent = current.forkSource && conversations.find(c => c.id === current.forkSource!.conversationId && c.nativeId === current.forkSource!.nativeId && c.connectionGeneration === current.connectionGeneration);
  const root = parent || current;
  const children = conversations.filter(c => c.id !== root.id && c.connectionGeneration === root.connectionGeneration && c.forkSource?.conversationId === root.id && c.forkSource.nativeId === root.nativeId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return [root, ...children];
}
