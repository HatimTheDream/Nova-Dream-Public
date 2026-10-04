import { isConversationVisibilityChange, type Conversation, type ConversationChanges } from '../../../packages/domain/assistant';
import { canonical } from '../../../packages/domain/contracts';
import { ApiError, readLocal, request, saveLocal } from './api';
import { releaseRejectedProjectRequest } from './project-admission';

type EditIntent = ConversationChanges & { requestId: string; epoch: string; conversationId: string; expectedRevision: number };
type VisibilityIntent = { intent: EditIntent; visibilityRevision: number };

/** Local organization must never replay an unrelated, unconfirmed native edit. */
export async function editConversation(epoch: string, conversation: Conversation, changes: ConversationChanges): Promise<Conversation> {
  const visibility = isConversationVisibilityChange(changes);
  const key = visibility ? `e3:conversation-visibility:${epoch}:${conversation.id}` : `e3:conversation-edit:${conversation.id}`;
  const local = visibility ? readLocal<VisibilityIntent>(key) : undefined;
  const kept = visibility ? local?.intent : readLocal<EditIntent>(key);
  const settled = kept && (visibility
    ? (conversation.visibilityRevision ?? 0) > (local?.visibilityRevision ?? 0)
    : !conversation.pendingSettings && (conversation.revision > kept.expectedRevision || conversation.settingsResult?.requestId === kept.requestId));
  if (settled) localStorage.removeItem(key);
  if (visibility && kept && !settled) {
    const { requestId, epoch: keptEpoch, conversationId, expectedRevision, ...original } = kept;
    if (keptEpoch !== epoch || conversationId !== conversation.id || !isConversationVisibilityChange(original) || canonical(original) !== canonical(changes)) {
      throw new Error('The previous chat move is not confirmed. Check its status before making a different move.');
    }
  }
  const intent = (settled ? undefined : kept) ?? { requestId: crypto.randomUUID(), epoch, conversationId: conversation.id, expectedRevision: conversation.revision, ...changes };
  if (!saveLocal(key, visibility ? { intent, visibilityRevision: local && !settled ? local.visibilityRevision : conversation.visibilityRevision ?? 0 } : intent)) throw new Error('Free browser storage before changing this conversation.');
  const clear = () => {
    const current = visibility ? readLocal<VisibilityIntent>(key)?.intent : readLocal<EditIntent>(key);
    if (current?.requestId === intent.requestId) localStorage.removeItem(key);
  };
  try {
    const result = await request<Conversation>('assistant/conversation/edit', intent, undefined, 30000);
    if (visibility || !result.pendingSettings) clear();
    return result;
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'edit_rejected' || visibility && error.status === 409 && ['conversation_changed', 'run_unsettled'].includes(error.code))) clear();
    else releaseRejectedProjectRequest(key, intent.requestId, error);
    throw error;
  }
}
