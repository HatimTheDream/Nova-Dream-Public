import type { AssistantOperation, Conversation } from '../../../packages/domain/assistant';
import type { ConversationRemoval } from '../../../packages/domain/conversation-removal';

export const conversationWritePending = (conversation: Conversation | undefined): boolean => !!conversation?.pendingSettings || !!conversation?.nativeRestorePending;

export function conversationVisibilityBlocked(conversation: Conversation, operations: AssistantOperation[], removals: ConversationRemoval[] | undefined, busy: boolean, hiding: boolean): boolean {
  return busy || conversation.state === 'creating' || !!conversation.pendingResume
    || !!removals?.some(item => item.conversationId === conversation.id && ['prepared', 'unknown'].includes(item.state))
    || hiding && operations.some(op => op.conversationId === conversation.id && !['completed', 'failed', 'cancelled', 'unknown'].includes(op.state));
}
