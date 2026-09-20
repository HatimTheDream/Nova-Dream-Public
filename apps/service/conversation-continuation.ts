import { randomUUID } from 'node:crypto';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import { z } from 'zod';
import { recoverContinuationSchema, resumeConversationSchema, type AssistantOperation, type Conversation, type QueuedMessage } from '../../packages/domain/assistant.js';
import { canonical, type Attachment } from '../../packages/domain/contracts.js';
import type { RetainedTranscriptReview } from '../../packages/domain/retained-transcript.js';
import type { AssistantTransport } from './gateway.js';
import { SavedHistory } from './saved-history.js';
import { Fault, type Store } from './store.js';

type Continuation = {
  requestId: string; epoch: string; deviceId: string; conversationId: string; source: Conversation; sourceNativeId: string;
  generation: string; nativeKey: string; nativeId?: string; state: 'prepared' | 'dispatching' | 'unknown' | 'completed' | 'failed';
  review: RetainedTranscriptReview; text: string; files: Attachment[]; uploadRequestId: string; transcript?: Attachment;
  updatedAt: string; message?: string;
};
type Hooks = { read(id: string): Conversation; save(conversation: Conversation): Conversation; assertIdle(conversation: Conversation): void; savedHistory?: SavedHistory };
const key = (id: string) => `assistant:continuation:${id}`;
const terminal = new Set(['completed', 'failed', 'cancelled']);
const isSessionId = (value: unknown): value is string => z.string().uuid().safeParse(value).success;

/** Replaces only a settled execution binding. It never dispatches dialogue or replays an action. */
export class ConversationContinuation {
  private running = new Map<string, Promise<Conversation>>();
  private closed = false;
  private saved: SavedHistory;
  constructor(private store: Store, private gateway: AssistantTransport, private hooks: Hooks) { this.saved = hooks.savedHistory ?? new SavedHistory(store); }
  close() { this.closed = true; }
  private connection(generation?: string) {
    const status = this.gateway.status();
    if (this.closed || this.store.recoveryEffectsPaused || status.state !== 'ready' || !status.generation || generation && status.generation !== generation || !status.grantedScopes.includes('operator.read') || !status.grantedScopes.includes('operator.write') || !status.methods.includes('sessions.create') || !status.methods.includes('sessions.describe') || !status.methods.includes('chat.history')) throw new Fault(409, 'continuation_connection', 'Connect the current Assistant before continuing this saved chat. Its history and draft are kept.');
    return status;
  }
  private idle(conversation: Conversation) {
    this.hooks.assertIdle(conversation);
    if (this.store.internalList<AssistantOperation>('assistant:operation:').some(operation => operation.conversationId === conversation.id && !terminal.has(operation.state))) throw new Fault(409, 'continuation_unsettled', 'Resolve the original reply before changing this chat’s connection. It will not be submitted again.');
    if (this.store.internalList<QueuedMessage>('assistant:queue:').some(item => item.conversationId === conversation.id && item.state === 'paused')) throw new Fault(409, 'continuation_queued', 'Review and remove the queued messages before changing this chat’s connection. Your main draft stays saved.');
  }
  private available(conversation: Conversation) {
    if (conversation.deleted || conversation.archived || this.store.internalRead(`assistant:removed:${conversation.id}`)) throw new Fault(409, 'continuation_unavailable', 'Restore this chat before continuing it.');
    if (conversation.workspace || conversation.space === 'work') throw new Fault(409, 'continuation_workspace', 'This Work chat must reconnect to its verified checkout. Its saved history is available, but its working folder cannot be transferred through chat continuation.');
  }
  private verifyFiles(files: Attachment[]) {
    for (const file of files) {
      try { if (canonical(this.store.download(file.id).metadata) !== canonical(file)) throw Error('Changed metadata'); }
      catch { throw new Fault(409, 'continuation_file_missing', 'A file required by this saved chat is missing or changed. Restore the original file before continuing.'); }
    }
  }
  private current(intent: Continuation) {
    if (intent.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Reopen this saved chat before continuing.');
    this.connection(intent.generation);
    const current = this.hooks.read(intent.conversationId); this.available(current); this.idle(current);
    if (current.pendingResume?.requestId !== intent.requestId || current.revision !== intent.source.revision || current.nativeId !== intent.source.nativeId || current.nativeKey !== intent.source.nativeKey || current.connectionGeneration !== intent.source.connectionGeneration || current.pendingSettings || current.projectId !== intent.source.projectId || current.model !== intent.source.model || current.thinking !== intent.source.thinking || current.fastMode !== intent.source.fastMode || current.permissionMode !== intent.source.permissionMode) throw new Fault(409, 'continuation_changed', 'This chat changed while its new connection was being prepared. Its original history and draft remain saved.');
    return current;
  }
  private put(intent: Continuation) { return this.store.internalWrite(key(intent.requestId), { ...intent, updatedAt: new Date().toISOString() }); }
  private async verifyIdle(intent: Continuation, nativeKey: string, nativeId: string, readOnly: boolean) {
    // Ordinary history reads use the key and then verify the returned incarnation;
    // the pinned API permits an explicit sessionId only for anchored reads.
    const history = await this.gateway.request<{ sessionId?: string; sessionInfo?: { sessionId?: string; activeRunIds?: string[]; hasActiveRun?: boolean; permissionMode?: string; permissionModePending?: boolean }; inFlightRun?: unknown }>('chat.history', { sessionKey: nativeKey, limit: 1, maxChars: 1000 });
    this.current(intent);
    const info = history.sessionInfo;
    const idle = info?.hasActiveRun === false || Array.isArray(info?.activeRunIds) && info.activeRunIds.length === 0;
    if ((history.sessionId ?? info?.sessionId) !== nativeId || !idle || info?.hasActiveRun === true || info?.activeRunIds?.length || history.inFlightRun || readOnly && (info?.permissionMode !== 'read-only' || info.permissionModePending === true)) throw new Fault(409, 'continuation_unconfirmed', 'The exact connection and its idle state are not confirmed. Check this same continuation again; no message has been replayed.');
  }
  async resume(device: string, raw: unknown): Promise<Conversation> {
    const input = resumeConversationSchema.parse(raw);
    const admitted = this.store.admit(device, input, { type: 'conversation.continue', ...input }, () => {
      const conversation = this.hooks.read(input.conversationId); this.available(conversation); this.idle(conversation);
      if (conversation.revision !== input.expectedRevision || conversation.pendingSettings || conversation.pendingResume || conversation.state === 'creating' || conversation.forkSource && !conversation.forkSource.resolved) throw new Fault(409, 'continuation_changed', 'Review the current chat and finish its pending setup before continuing.');
      const status = this.connection(), frozen = this.saved.freeze(conversation);
      if (frozen.review.digest !== input.digest) throw new Fault(409, 'saved_transcript_changed', 'The saved transcript changed. Review its current coverage before continuing.');
      if (!frozen.review.complete && input.allowPartial !== true) throw new Fault(409, 'continuation_partial', 'Only part of this chat is saved. Review that coverage before choosing to continue from the saved portion.');
      const snapshot = this.saved.snapshot(conversation);
      if (!snapshot || snapshot.transcript.conflicts > 0) throw new Fault(409, 'continuation_conflict', 'This chat has conflicting saved message versions. Resolve its original history before continuing.');
      const attachments = snapshot.messages.flatMap(message => message.attachments);
      if (attachments.some(attachment => !attachment.localFile || attachment.availability !== 'local')) throw new Fault(409, 'continuation_file_missing', 'Some files in this chat are only references. Save their original contents before continuing on another connection.');
      const files = [...new Map(attachments.map(attachment => [attachment.localFile!.id, attachment.localFile!])).values()];
      if (files.length > 9) throw new Fault(409, 'continuation_file_limit', 'This chat needs more files than one message can carry. Keep using its original connection until its references can be prepared together.');
      this.verifyFiles(files);
      const intent: Continuation = { requestId: input.requestId, epoch: input.epoch, deviceId: device, conversationId: conversation.id, source: structuredClone(conversation), sourceNativeId: snapshot.nativeId, generation: status.generation!, nativeKey: `agent:main:e3:resume-${conversation.id}-${input.requestId}`, state: 'prepared', review: frozen.review, text: frozen.text, files, uploadRequestId: randomUUID(), updatedAt: new Date().toISOString() };
      this.put(intent); this.hooks.save({ ...conversation, pendingResume: { requestId: input.requestId }, error: undefined }); return { requestId: input.requestId };
    });
    const intent = this.store.internalRead<Continuation>(key(admitted.value.requestId));
    if (!intent || intent.deviceId !== device) throw new Fault(409, 'continuation_missing', 'This continuation receipt is unavailable. Reopen the saved chat.');
    return this.proceed(intent);
  }
  async recover(device: string, raw: unknown): Promise<Conversation> {
    const input = recoverContinuationSchema.parse(raw);
    // A new authenticated device admits only a check of the existing frozen
    // intent. Its identity and upload receipts continue to belong to its author.
    const admitted = this.store.admit(device, input, { type: 'conversation.continue.check', ...input }, () => {
      const intent = this.store.internalRead<Continuation>(key(input.pendingRequestId));
      if (!intent || intent.epoch !== input.epoch || intent.conversationId !== input.conversationId) throw new Fault(409, 'continuation_missing', 'This pending connection no longer belongs to the current chat. Reopen its saved history.');
      this.current(intent);
      return { requestId: intent.requestId, conversationId: intent.conversationId };
    });
    const intent = this.store.internalRead<Continuation>(key(admitted.value.requestId));
    if (!intent || intent.epoch !== input.epoch || intent.conversationId !== input.conversationId) throw new Fault(409, 'continuation_missing', 'This continuation receipt is unavailable. Reopen the saved chat.');
    return this.proceed(intent);
  }
  private proceed(intent: Continuation): Promise<Conversation> {
    if (intent.state === 'completed' || intent.state === 'failed') return Promise.resolve(this.hooks.read(intent.conversationId));
    const existing = this.running.get(intent.requestId); if (existing) return existing;
    const work = this.apply(intent).finally(() => this.running.delete(intent.requestId)); this.running.set(intent.requestId, work); return work;
  }
  private finish(intent: Continuation, nativeId: string, sameBinding = false) {
    const current = this.current(intent); this.verifyFiles(intent.files);
    if (!sameBinding && !intent.transcript) throw new Fault(409, 'continuation_reference_missing', 'The saved reference is not ready. Check this continuation again.');
    if (intent.transcript) this.verifyFiles([intent.transcript]);
    return this.store.internalAtomic(() => {
      const next = this.hooks.save({ ...current, ...(sameBinding ? {} : { nativeKey: intent.nativeKey, nativeId, connectionGeneration: intent.generation, permissionMode: 'read-only' as const, accountSelection: undefined, resumeContext: { transcript: intent.transcript!, files: intent.files, digest: intent.review.digest, sourceNativeId: intent.sourceNativeId, complete: intent.review.complete } }), state: 'ready', revision: current.revision + 1, pendingResume: undefined, error: undefined });
      this.put({ ...intent, state: 'completed', nativeId, message: undefined }); return next;
    });
  }
  private async apply(original: Continuation): Promise<Conversation> {
    let intent = original, awaitingCreate = false;
    try {
      this.current(intent);
      if (!intent.transcript) {
        const transcript = this.store.upload(intent.deviceId, intent.uploadRequestId, intent.epoch, `Saved chat - ${intent.source.title.slice(0, 120)}.txt`, Buffer.from(intent.text).toString('base64'));
        intent = this.put({ ...intent, transcript });
      }
      this.verifyFiles([...intent.files, intent.transcript!]);
      if (intent.state !== 'prepared') {
        // A lost create response can only be reconciled against that exact key.
        const response = await this.gateway.request<{ session?: { key?: string; sessionId?: string; permissionMode?: string; permissionModePending?: boolean } | null }>('sessions.describe', { key: intent.nativeKey });
        this.current(intent);
        const session = response.session;
        if (!session || session.key !== intent.nativeKey || !isSessionId(session.sessionId) || session.sessionId === intent.source.nativeId || session.permissionMode !== 'read-only' || session.permissionModePending === true) throw new Fault(409, 'continuation_unconfirmed', 'The new connection is not confirmed. Check this same continuation again; no message has been replayed.');
        await this.verifyIdle(intent, intent.nativeKey, session.sessionId, true);
        return this.finish(intent, session.sessionId);
      }
      if (intent.source.connectionGeneration === intent.generation && intent.source.nativeId) {
        const response = await this.gateway.request<{ session?: { key?: string; sessionId?: string; hasActiveRun?: boolean; activeRunIds?: string[] } | null }>('sessions.describe', { key: intent.source.nativeKey });
        this.current(intent);
        if (response.session?.key === intent.source.nativeKey && response.session.sessionId === intent.source.nativeId) {
          if (response.session.hasActiveRun || response.session.activeRunIds?.length) throw new Fault(409, 'continuation_unsettled', 'The original chat still has running work. Resolve it before continuing.');
          await this.verifyIdle(intent, intent.source.nativeKey, intent.source.nativeId, false);
          return this.finish(intent, intent.source.nativeId, true);
        }
        if (response.session !== null && !response.session?.sessionId) throw new Fault(409, 'continuation_source_unconfirmed', 'The original chat could not be checked. Reconnect and check this continuation again.');
      }
      this.current(intent); intent = this.put({ ...intent, state: 'dispatching' });
      awaitingCreate = true;
      const response = await this.gateway.request<{ key?: string; sessionId?: string; runStarted?: boolean; entry?: { sessionId?: string; permissionMode?: string; permissionModePending?: boolean } }>('sessions.create', { key: intent.nativeKey, idempotencyKey: intent.requestId, label: intent.source.title, ...(intent.source.model ? { model: intent.source.model } : {}), ...(intent.source.thinking ? { thinkingLevel: intent.source.thinking } : {}), ...(intent.source.fastMode != null ? { fastMode: intent.source.fastMode } : {}), permissionMode: 'read-only', emitCommandHooks: false });
      awaitingCreate = false;
      this.current(intent);
      if (response.key !== intent.nativeKey || !isSessionId(response.sessionId) || response.sessionId === intent.source.nativeId || response.runStarted || response.entry?.sessionId !== response.sessionId || response.entry?.permissionMode !== 'read-only' || response.entry.permissionModePending === true) throw new Fault(409, 'continuation_unconfirmed', 'The new connection is not confirmed. Check this same continuation again; no message has been replayed.');
      return this.finish(intent, response.sessionId);
    } catch (error) {
      if (this.closed || intent.epoch !== this.store.epoch || this.store.internalRead(`assistant:removed:${intent.conversationId}`)) throw error;
      const beforeDispatch = intent.state === 'prepared';
      // A rejected recovery read says nothing about whether an earlier create
      // succeeded. Only the create request itself can supply rejection proof.
      const rejected = awaitingCreate && error instanceof GatewayClientRequestError && ['INVALID_REQUEST', 'FORBIDDEN'].includes(error.gatewayCode) || beforeDispatch && error instanceof Fault && ['continuation_changed', 'continuation_workspace', 'continuation_unavailable'].includes(error.code);
      const message = error instanceof Fault ? error.message : rejected ? 'The Assistant rejected this continuation. Your saved chat and draft remain unchanged.' : 'The new connection is not confirmed. Check this same continuation again; your saved chat and draft are kept.';
      this.put({ ...intent, state: rejected ? 'failed' : beforeDispatch ? 'prepared' : 'unknown', message });
      const current = this.hooks.read(intent.conversationId);
      if (current.pendingResume?.requestId !== intent.requestId) throw error;
      return this.hooks.save({ ...current, ...(rejected ? { pendingResume: undefined } : {}), error: message });
    }
  }
}
