import { GatewayClientRequestError } from '@openclaw/gateway-client';
import { removeConversationSchema, type ConversationRemoval } from '../../packages/domain/conversation-removal.js';
import type { VoiceAttempt } from '../../packages/domain/voice.js';
import type { AssistantOperation, Conversation } from '../../packages/domain/assistant.js';
import type { AssistantTransport } from './gateway.js';
import { Store, Fault } from './store.js';

const key = (id: string) => `assistant:removal:${id}`;
const terminal = new Set(['completed', 'failed', 'cancelled']);
/** Delete only an explicitly trashed, settled conversation with its exact native identity. */
export class ConversationRemovals {
  private running = new Map<string, Promise<ConversationRemoval>>();
  private closed = false;
  constructor(private store: Store, private gateway: AssistantTransport, private busy: (id: string) => boolean) {}
  close() { this.closed = true; }
  list() { return this.store.internalList<ConversationRemoval>('assistant:removal:'); }
  pending(id: string) { const requestId = this.store.internalRead<string>(`assistant:removal-current:${id}`); const item = requestId ? this.store.internalRead<ConversationRemoval>(key(requestId)) : undefined; return !!item && ['prepared', 'unknown'].includes(item.state); }
  removed(id: string) { return !!this.store.internalRead(`assistant:removed:${id}`); }
  assertAvailable(id: string) {
    if (this.removed(id)) throw new Fault(410, 'conversation_removed', 'This conversation was permanently removed.');
    if (this.pending(id)) throw new Fault(409, 'conversation_removing', 'Finish checking this conversation’s removal before continuing.');
  }
  private save(item: ConversationRemoval) {
    if (this.closed) throw new Fault(503, 'service_closed', 'Check the removal after reconnecting.');
    return this.store.internalWrite(key(item.requestId), { ...item, updatedAt: new Date().toISOString() });
  }
  private connection(item: ConversationRemoval) {
    const state = this.gateway.status();
    if (this.closed || item.epoch !== this.store.epoch || state.state !== 'ready' || state.generation !== item.connectionGeneration || !state.grantedScopes.includes('operator.write') || !state.methods.includes('sessions.delete') || !state.methods.includes('sessions.describe')) throw new Fault(409, 'removal_connection', 'Reconnect this chat’s original host to finish its removal.');
  }
  async remove(device: string, raw: unknown): Promise<ConversationRemoval> {
    const input = removeConversationSchema.parse(raw);
    const receipt = this.store.admit(device, input, { type: 'conversation.remove', ...input }, () => {
      const currentId = this.store.internalRead<string>(`assistant:removal-current:${input.conversationId}`);
      const current = currentId ? this.store.internalRead<ConversationRemoval>(key(currentId)) : undefined;
      if (current && ['prepared', 'unknown'].includes(current.state) && current.epoch === input.epoch && current.expectedRevision === input.expectedRevision) return { requestId: current.requestId };
      this.assertAvailable(input.conversationId);
      const chat = this.store.internalRead<Conversation>(`assistant:conversation:${input.conversationId}`);
      if (!chat || !chat.deleted || chat.revision !== input.expectedRevision || chat.pendingSettings || chat.state === 'creating' || !chat.nativeId && chat.state !== 'failed') throw new Fault(409, 'removal_changed', 'Move this chat to Deleted and resolve its current status before removing it permanently.');
      if (this.busy(chat.id) || this.store.internalList<AssistantOperation>('assistant:operation:').some(op => op.conversationId === chat.id && !terminal.has(op.state))) throw new Fault(409, 'removal_busy', 'Finish the original reply or voice call before removing this chat.');
      if (this.store.internalList<{ draftId: string; state: string; cleanupPending?: boolean }>('dictation:').some(a => a.draftId.endsWith(`:${chat.id}`) && (a.cleanupPending || !['ended', 'failed'].includes(a.state)))) throw new Fault(409, 'removal_busy', 'Finish dictation and its cleanup before removing this chat.');
      if (this.store.internalList<VoiceAttempt>('voice:attempt:').some(call => call.target.conversation.id === chat.id && (!['ended', 'failed'].includes(call.state) || call.entries.some(entry => !entry.saved) || call.consults.some(consult => !['completed', 'failed'].includes(consult.state))))) throw new Fault(409, 'removal_busy', 'Close the original voice call and finish saving its captions before removing this chat.');
      if (this.store.internalList<{ conversationId: string; state: string }>('assistant:output:').some(output => output.conversationId === chat.id && output.state !== 'ready')) throw new Fault(409, 'removal_busy', 'Finish saving this chat’s output before removing the conversation.');
      for (const prefix of ['assistant:approval:', 'assistant:question:']) if (this.store.internalList<{ conversationId: string; snapshot: { status: string }; action?: { state: string } }>(prefix).some(item => item.conversationId === chat.id && (item.snapshot.status === 'pending' || item.action && item.action.state !== 'confirmed'))) throw new Fault(409, 'removal_busy', 'Resolve this chat’s pending decisions before removing it.');
      const item: ConversationRemoval = { ...input, deviceId: device, nativeId: chat.nativeId, nativeKey: chat.nativeKey, connectionGeneration: chat.connectionGeneration, state: 'prepared', updatedAt: new Date().toISOString() };
      if (chat.nativeId) this.connection(item);
      this.store.internalWrite(`assistant:removal-current:${item.conversationId}`, item.requestId);
      this.save(item); return { requestId: input.requestId };
    });
    const item = this.store.internalRead<ConversationRemoval>(key(receipt.value.requestId))!;
    if (['completed', 'rejected'].includes(item.state)) return item;
    const running = this.running.get(item.requestId); if (running) return running;
    const work = this.apply(item).finally(() => this.running.delete(item.requestId)); this.running.set(item.requestId, work); return work;
  }
  private async apply(item: ConversationRemoval): Promise<ConversationRemoval> {
    try {
      if (item.nativeId) {
        this.connection(item);
        // Describe never creates a missing chat. An absent original after a
        // lost acknowledgement settles without another destructive command.
        const resolved = await this.gateway.request<{ session: { key: string; sessionId: string; hasActiveRun?: boolean; activeRunIds?: string[] } | null }>('sessions.describe', { key: item.nativeKey });
        this.connection(item);
        if (resolved.session) {
          if (resolved.session.key !== item.nativeKey || resolved.session.sessionId !== item.nativeId) throw new Fault(409, 'removal_identity', 'The host returned a different chat. Reopen its current status.');
          if (resolved.session.hasActiveRun || resolved.session.activeRunIds?.length) throw new Fault(409, 'removal_busy', 'Finish the native reply before removing this chat.');
          const result = await this.gateway.request<{ ok: boolean; key: string; deleted: boolean }>('sessions.delete', { key: item.nativeKey, expectedSessionId: item.nativeId, archivedOnly: true, deleteTranscript: true });
          this.connection(item);
          if (result.ok !== true || result.key !== item.nativeKey || result.deleted !== true) throw new Error('Unconfirmed native removal');
        } else if (resolved.session !== null) throw new Error('Unconfirmed native identity');
      }
      if (this.closed) throw new Error('Service closed');
      return this.store.internalAtomic(() => {
        this.store.removeConversationData(item.conversationId);
        this.store.internalWrite(`assistant:removed:${item.conversationId}`, { id: item.conversationId, requestId: item.requestId, at: new Date().toISOString() });
        return this.save({ ...item, state: 'completed', message: undefined });
      });
    } catch (error) {
      if (this.closed) throw error;
      const rejected = error instanceof GatewayClientRequestError && ['INVALID_REQUEST', 'FORBIDDEN'].includes(error.gatewayCode) || error instanceof Fault && ['removal_identity', 'removal_busy'].includes(error.code);
      return this.save({ ...item, state: rejected ? 'rejected' : 'unknown', message: rejected ? 'The host rejected removal. The local chat is kept; review its current status.' : 'Removal is not confirmed. Check again to finish the same request.' });
    }
  }
}
