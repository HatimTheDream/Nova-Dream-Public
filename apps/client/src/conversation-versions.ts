import type { Conversation } from '../../../packages/domain/assistant';

/** Only follow verified app/native ancestry; a same app ID with replaced history is unrelated. */
export function relatedConversations(current: Conversation, conversations: Conversation[]): Conversation[] {
  const byId = new Map(conversations.map(conversation => [conversation.id, conversation]));
  const listed = byId.get(current.id);
  if (listed && (listed.nativeId !== current.nativeId || listed.connectionGeneration !== current.connectionGeneration)) return [current];
  byId.set(current.id, current);
  const parentOf = (conversation: Conversation) => {
    const source = conversation.forkSource;
    if (!source) return undefined;
    const parent = byId.get(source.conversationId);
    return parent && parent.nativeId === source.nativeId && parent.connectionGeneration === conversation.connectionGeneration ? parent : undefined;
  };

  let root = current;
  const ancestry = new Set([root.id]);
  for (let parent = parentOf(root); parent; parent = parentOf(root)) {
    // Corrupt cyclic ancestry has no verified root. Keep the current chat
    // readable without presenting another member of the cycle as its original.
    if (ancestry.has(parent.id)) return [current];
    ancestry.add(parent.id); root = parent;
  }
  const children = new Map<string, Conversation[]>();
  for (const conversation of byId.values()) {
    const parent = parentOf(conversation);
    if (!parent) continue;
    const siblings = children.get(parent.id) ?? [];
    siblings.push(conversation); children.set(parent.id, siblings);
  }
  const family = [root], visited = new Set([root.id]);
  for (let index = 0; index < family.length; index++) {
    for (const child of children.get(family[index].id) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id); family.push(child);
    }
  }
  return [root, ...family.slice(1).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))];
}
