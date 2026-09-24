import type { AssistantOutput, Conversation, ConversationMessage } from '../../../packages/domain/assistant';

export function savedMessageOutput(outputs: AssistantOutput[], conversation: Conversation, message: ConversationMessage, artifactId?: string) {
  const nativeId = message.source?.nativeId ?? conversation.nativeId;
  const ids = new Set([message.id, message.source?.nativeMessageId, ...(message.aliases ?? [])]);
  return outputs.find(output => output.conversationId === conversation.id && output.nativeId === nativeId && ids.has(output.messageId) && output.messageHash === message.textHash && output.artifactId === artifactId && output.state === 'ready');
}
