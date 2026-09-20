import { createHash } from 'node:crypto';
import { messagePinSchema, type MessagePin } from '../../packages/domain/message-pins.js';
import type { Conversation, ConversationHistory } from '../../packages/domain/assistant.js';
import { Store, Fault } from './store.js';
import { matchesMessageSource } from '../../packages/domain/conversation-source.js';

/** Bookmarks are app records, never edits to the native transcript. */
export class MessagePins {
  constructor(private store: Store, private conversation: (id: string) => Conversation, private history: (id: string) => ConversationHistory | undefined) {}
  list() { return this.store.internalList<MessagePin>('assistant:message-pin:'); }
  change(device: string, raw: unknown) {
    const input = messagePinSchema.parse(raw);
    return this.store.admit(device, input, { type: 'assistant.message-pin', ...input }, () => {
      const id = createHash('sha256').update(JSON.stringify([input.conversationId, input.nativeId, input.role, input.messageId])).digest('hex'), key = `assistant:message-pin:${id}`;
      const previous = this.store.internalRead<MessagePin>(key);
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new Fault(409, 'pin_changed', 'This pin changed in another window. Review its current state and try again.');
      const conversation = this.conversation(input.conversationId), history = this.history(input.conversationId);
      const message = history?.messages.find(m => matchesMessageSource(m, input, history.nativeId));
      if (input.pinned && (conversation.deleted || !message)) throw new Fault(409, 'pin_source_changed', 'Open the exact original message before pinning it.');
      if (!input.pinned && (!previous || previous.messageHash !== input.messageHash)) throw new Fault(409, 'pin_source_changed', 'Review the current pin before removing it.');
      return this.store.internalWrite<MessagePin>(key, { id, revision: (previous?.revision ?? 0) + 1, conversationId: input.conversationId, nativeId: input.nativeId, messageId: input.messageId, messageHash: input.messageHash, role: input.role, pinned: input.pinned, excerpt: input.pinned ? (message!.authoredText ?? message!.text).slice(0, 240) : previous!.excerpt, updatedAt: new Date().toISOString() });
    }).value;
  }
}
