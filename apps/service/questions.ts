import { createHash, createHmac, randomBytes } from 'node:crypto';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import { canonicalQuestionAnswers, nativeQuestionSchema, safeQuestionSnapshot, resolveQuestionSchema, checkQuestionSchema, dismissQuestionSchema, type NativeQuestion, type AssistantQuestion, type QuestionState, type QuestionAnswers } from '../../packages/domain/questions.js';
import { canonical } from '../../packages/domain/contracts.js';
import type { Conversation } from '../../packages/domain/assistant.js';
import type { AssistantTransport } from './gateway.js';
import type { AccessTransport } from './full-access.js';
import { Fault, Store } from './store.js';

const prefix = 'assistant:question:';
const hash = (value: unknown) => createHash('sha256').update(canonical(value ?? null)).digest('hex');
const fingerprint = (q: NativeQuestion) => hash([q.id, q.createdAtMs, q.expiresAtMs, q.sessionKey, q.agentId, q.runId, q.questions]);
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const isMissing = (error: unknown) => error instanceof GatewayClientRequestError && object(error.details).reason === 'QUESTION_NOT_FOUND';

/** Retains app-side question history; the native question manager is transient. */
export class AssistantQuestions {
  private control?: AccessTransport;
  private stopControl?: () => void;
  private stopOrdinary: () => void;
  private subscribed = new Set<string>();
  private reads = new Map<string, Promise<AssistantQuestion>>();
  private syncing?: Promise<void>;
  private error?: string;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private store: Store, private ordinary: AssistantTransport, private conversations: () => Conversation[], private verifyConversation: (id: string) => Promise<unknown>, private factory?: () => AccessTransport) {
    for (const item of this.all()) if (item.action?.state === 'sending') this.save({ ...item, action: { ...item.action, state: 'unknown', message: 'The workspace restarted. Check this request before answering again.' } });
    this.stopOrdinary = ordinary.subscribe(event => { if (['e3.connected', 'e3.disconnected', 'e3.connection-stopped'].includes(event.event)) void this.sync(); });
    this.timer = setInterval(() => { void this.sync(); }, 3000); this.timer.unref?.();
  }
  private all() { return this.store.internalList<AssistantQuestion>(prefix); }
  private get(id: string) { const item = this.store.internalRead<AssistantQuestion>(`${prefix}${id}`); if (!item) throw new Fault(404, 'question_missing', 'This question is unavailable.'); return item; }
  private save(item: AssistantQuestion) { if (this.store.internalRead(`assistant:removed:${item.conversationId}`)) return item; return this.store.internalWrite(`${prefix}${item.id}`, { ...item, revision: item.revision + 1 }); }
  state(): QuestionState {
    const base = this.ordinary.status(), control = this.control?.status();
    const ready = !this.closed && base.state === 'ready' && control?.state === 'ready' && base.generation === control.generation && base.url === control.url && control.grantedScopes.includes('operator.questions');
    const conversations = this.conversations();
    return { state: this.error ? 'error' : ready ? 'ready' : this.control ? 'connecting' : 'unavailable', ...(this.error ? { message: this.error } : {}), items: this.all().filter(item => item.epoch === this.store.epoch && item.connectionGeneration === base.generation && conversations.some(c => c.id === item.conversationId && c.nativeId === item.nativeId && c.nativeKey === item.nativeKey)).sort((a, b) => b.snapshot.createdAtMs - a.snapshot.createdAtMs) };
  }
  private target(item: AssistantQuestion) {
    const base = this.ordinary.status(), control = this.control?.status(), conversation = this.conversations().find(c => c.id === item.conversationId);
    if (this.closed || item.epoch !== this.store.epoch || !conversation || conversation.nativeId !== item.nativeId || conversation.nativeKey !== item.nativeKey || conversation.connectionGeneration !== item.connectionGeneration || base.state !== 'ready' || base.generation !== item.connectionGeneration || control?.state !== 'ready' || control.generation !== base.generation || control.url !== base.url || !control.grantedScopes.includes('operator.questions')) throw new Fault(409, 'question_host_changed', 'Reconnect to this question’s original conversation before answering.');
    return conversation;
  }
  private accept(raw: unknown) {
    const record = safeQuestionSnapshot(nativeQuestionSchema.parse(raw));
    const conversation = this.conversations().find(c => c.nativeKey === record.sessionKey && c.nativeId && c.state === 'ready' && c.connectionGeneration === this.ordinary.status().generation);
    if (!conversation || this.closed) return;
    const id = hash([this.store.epoch, conversation.connectionGeneration, conversation.id, conversation.nativeId, record.id, record.createdAtMs]);
    const old = this.store.internalRead<AssistantQuestion>(`${prefix}${id}`), fp = fingerprint(record);
    if (old?.fingerprint && old.fingerprint !== fp) throw new Fault(409, 'question_changed', 'The question changed. The original answer has not been sent.');
    if (old && (old.snapshot.status !== 'pending' || canonical(old.snapshot) === canonical(record) && old.availability === 'live')) return old;
    const action = old?.action && record.status !== 'pending' ? { ...old.action, state: 'confirmed' as const, message: record.status === 'answered' ? old.action.answerHash === hash(record.answers?.answers) ? 'Answer confirmed.' : 'This request was answered with a different response.' : record.status === 'cancelled' ? 'Question cancelled.' : 'Question expired.' } : old?.action;
    return this.save({ id, revision: old?.revision ?? 0, epoch: this.store.epoch, connectionGeneration: conversation.connectionGeneration, conversationId: conversation.id, nativeId: conversation.nativeId!, nativeKey: conversation.nativeKey, fingerprint: fp, availability: 'live', snapshot: record, ...(action ? { action } : {}) });
  }
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.synchronize().catch(() => { if (!this.closed) this.error = 'Questions could not be checked. Reconnect before answering.'; }).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  private async synchronize() {
    if (this.closed) return;
    const base = this.ordinary.status();
    if (this.control && (base.state !== 'ready' || base.generation !== this.control.status().generation || base.url !== this.control.status().url)) await this.disconnect();
    if (this.closed || !this.factory || base.state !== 'ready' || !['question.get', 'question.list', 'question.resolve'].every(m => base.methods.includes(m))) return;
    if (!this.control) {
      const control = this.factory(); this.control = control;
      this.stopControl = control.subscribe(event => {
        if (this.closed || this.control !== control || this.ordinary.status().generation !== control.status().generation) return;
        if (['e3.connected', 'e3.disconnected', 'e3.history-gap'].includes(event.event)) this.subscribed.clear();
        if (event.event === 'question.requested') {
          try { this.accept(event.payload); } catch { this.error = 'A question could not be read completely. Review it in OpenClaw.'; }
        }
        if (event.event === 'question.resolved') {
          const id = object(event.payload).id;
          for (const item of this.state().items.filter(q => q.snapshot.id === id && q.snapshot.status === 'pending')) void this.read(item).catch(() => undefined);
        }
      });
      control.start();
    }
    const control = this.control, status = control.status();
    if (status.state !== 'ready') { if (['pairing', 'error'].includes(status.state)) this.error = status.message; return; }
    if (!status.grantedScopes.includes('operator.questions')) { this.error = 'This device needs OpenClaw question-review permission.'; return; }
    this.error = undefined;
    for (const c of this.conversations().filter(c => c.nativeId && c.state === 'ready' && c.connectionGeneration === base.generation)) {
      const identity = `${c.id}:${c.nativeId}`;
      if (this.subscribed.has(identity)) continue;
      if (status.methods.includes('sessions.messages.subscribe')) {
        const result = await control.request<{ key: string; subscribed: boolean }>('sessions.messages.subscribe', { key: c.nativeKey });
        if (result.key !== c.nativeKey || !result.subscribed) throw Error('Question subscription not confirmed');
      }
      if (this.closed || this.control !== control || this.ordinary.status().generation !== base.generation) return;
      this.subscribed.add(identity);
    }
    const result = await control.request<{ questions: unknown[] }>('question.list', {});
    if (this.closed || this.control !== control || this.ordinary.status().generation !== base.generation) return;
    if (!Array.isArray(result.questions) || result.questions.length > 1000) throw Error('Question list incomplete');
    const present = new Set<string>();
    for (const raw of result.questions) { const source = object(raw); if (!this.conversations().some(c => c.nativeKey === source.sessionKey && c.connectionGeneration === base.generation)) continue; const item = this.accept(raw); if (item) present.add(item.id); }
    for (const item of this.state().items.filter(q => q.snapshot.status === 'pending' && q.availability !== 'missing' && !present.has(q.id))) { try { await this.read(item); } catch { this.error = 'Some question outcomes could not be checked. Reconnect to review them.'; } }
  }
  async prepare(conversationId: string) {
    if (!this.factory || !this.ordinary.status().methods.includes('question.resolve')) return;
    const base = this.ordinary.status(), end = Date.now() + 12000;
    while (!this.closed && Date.now() < end) {
      await this.sync(); const c = this.conversations().find(c => c.id === conversationId);
      if (c && this.state().state === 'ready' && this.subscribed.has(`${c.id}:${c.nativeId}`)) return;
      if (this.ordinary.status().generation !== base.generation || this.state().state === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Fault(503, 'questions_unavailable', 'Question controls are not connected. Your message is kept; reconnect before sending.');
  }
  private read(item: AssistantQuestion) {
    const existing = this.reads.get(item.id); if (existing) return existing;
    const pending = this.readNative(item).finally(() => { this.reads.delete(item.id); }); this.reads.set(item.id, pending); return pending;
  }
  private async readNative(item: AssistantQuestion) {
    this.target(item);
    try {
      const response = await this.control!.request<{ question: unknown }>('question.get', { id: item.snapshot.id }); this.target(item);
      const record = safeQuestionSnapshot(nativeQuestionSchema.parse(response.question));
      if (fingerprint(record) !== item.fingerprint) {
        const current = this.get(item.id);
        return current.snapshot.status === 'pending' ? this.save({ ...current, availability: 'missing', ...(current.action ? { action: { ...current.action, state: 'unknown', message: 'The original request was replaced. Its draft answer has not been sent.' } } : {}) }) : current;
      }
      return this.accept(record) ?? this.get(item.id);
    } catch (error) {
      this.target(item);
      if (!isMissing(error)) throw error;
      const current = this.get(item.id);
      // Missing native records do not establish whether an uncertain answer won.
      return current.snapshot.status === 'pending' ? this.save({ ...current, availability: 'missing', ...(current.action ? { action: { ...current.action, state: 'unknown', message: 'The original request is no longer available. Its outcome cannot be confirmed.' } } : {}) }) : current;
    }
  }
  async check(raw: unknown) {
    const input = checkQuestionSchema.parse(raw);
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Reopen this question.');
    const original = this.get(input.id), current = await this.read(original);
    if (current.snapshot.status === 'pending' && current.availability === 'live' && current.action?.state === 'unknown' && current.action.requestId === original.action?.requestId) return this.save({ ...current, action: undefined });
    return current;
  }
  dismiss(device: string, raw: unknown) {
    const input = dismissQuestionSchema.parse(raw);
    return this.store.admit(device, input, { type: 'assistant.question-dismiss', ...input }, () => {
      const item = this.get(input.id);
      if (item.revision !== input.expectedRevision || item.snapshot.status === 'pending' && item.availability !== 'missing') throw new Fault(409, 'question_changed', 'This request is still active. Answer or cancel it first.');
      return this.save({ ...item, dismissed: true });
    }).value;
  }
  async resolve(device: string, raw: unknown) {
    const input = resolveQuestionSchema.parse(raw);
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Reopen this question.');
    const source = this.get(input.id), secret = source.snapshot.questions.some(q => q.isSecret);
    let answers: QuestionAnswers | undefined;
    try { answers = input.answers ? canonicalQuestionAnswers(source.snapshot.questions, input.answers) : undefined; }
    catch (error) { throw new Fault(400, 'question_answer', error instanceof Error ? error.message : 'Check your answers.'); }
    if (secret && answers && Buffer.byteLength(Object.values(answers)[0][0], 'utf8') > 65536) throw new Fault(400, 'secret_size', 'This secret is too long.');
    let requestHash = hash(answers);
    if (secret && answers) {
      const key = this.store.internalRead<string>('assistant:question-receipt-key') ?? this.store.internalWrite('assistant:question-receipt-key', randomBytes(32).toString('hex'));
      requestHash = createHmac('sha256', Buffer.from(key, 'hex')).update(canonical(answers)).digest('hex');
    }
    const intent = { type: 'assistant.question-answer', requestId: input.requestId, epoch: input.epoch, id: input.id, expectedRevision: input.expectedRevision, cancel: input.cancel, requestHash };
    const admitted = this.store.admit(device, input, intent, () => {
      const item = this.get(input.id), conversation = this.target(item);
      if (conversation.archived || conversation.deleted) throw new Fault(409, 'question_read_only', 'Restore this conversation before answering.');
      if (item.revision !== input.expectedRevision || item.fingerprint !== source.fingerprint || item.snapshot.status !== 'pending' || item.availability !== 'live' || item.action) throw new Fault(409, 'question_changed', 'This question changed. Check its current status before answering.');
      return this.save({ ...item, action: { requestId: input.requestId, kind: input.cancel ? 'cancel' : 'answer', state: 'sending', ...(answers ? { answerHash: hash(secret ? { [item.snapshot.questions[0].questionId]: ['stored'] } : answers) } : {}) } });
    });
    if (!admitted.fresh) return this.get(input.id);
    const original = admitted.value;
    try {
      await this.verifyConversation(original.conversationId); this.target(original);
      const checked = await this.read(original);
      if (checked.snapshot.status !== 'pending' || checked.availability !== 'live') return checked;
      const result = await this.control!.request<Record<string, any>>('question.resolve', { id: original.snapshot.id, ...(input.cancel ? { cancel: true } : { answers: { answers }, resolutionId: input.requestId }) }); this.target(original);
      if (result.status !== (input.cancel ? 'cancelled' : 'answered')) throw Error('Question response unconfirmed');
      const record = safeQuestionSnapshot(nativeQuestionSchema.parse({ ...original.snapshot, status: result.status, ...(result.status === 'answered' ? { answers: result.answers } : { answers: undefined }) }));
      return this.accept(record) ?? this.get(original.id);
    } catch {
      const current = this.get(original.id);
      if (current.snapshot.status !== 'pending') return current;
      return this.save({ ...current, action: { ...original.action!, state: 'unknown', message: 'This answer hasn’t been confirmed. Check the original request before trying again.' } });
    } finally { answers = undefined; }
  }
  private async disconnect() { this.stopControl?.(); this.stopControl = undefined; const control = this.control; this.control = undefined; this.subscribed.clear(); await control?.stop(); }
  async close() { this.closed = true; clearInterval(this.timer); this.stopOrdinary(); await this.disconnect(); await this.syncing; await Promise.allSettled(this.reads.values()); }
}
