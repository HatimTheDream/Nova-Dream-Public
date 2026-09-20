import type { ConversationMessage } from './assistant.js';

/** A message's historical source survives a change to the conversation's current engine. */
export const messageNativeId = (message: ConversationMessage, fallback: string | null | undefined) => message.source?.nativeId ?? fallback;
export function matchesMessageSource(message: ConversationMessage, input: { nativeId: string; messageId: string; messageHash?: string; role?: string }, fallback?: string | null) {
  return messageNativeId(message, fallback) === input.nativeId
    && (message.id === input.messageId || message.novaId === input.messageId || message.aliases?.includes(input.messageId))
    && (!input.role || message.role === input.role)
    && (!input.messageHash || message.textHash === input.messageHash);
}
