import { z } from 'zod';
import {
  conversationCleanupActionSchema, conversationCleanupScopeSchema, prepareConversationCleanupSchema, decideConversationCleanupSchema,
  type ConversationCleanupBatch, type ConversationCleanupScope, type ConversationCleanupAction, type ConversationCleanupSummary,
  type PrepareConversationCleanup, type DecideConversationCleanup,
} from '../../../packages/domain/conversation-cleanup';

const pendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prepare'), command: prepareConversationCleanupSchema }).strict(),
  z.object({ kind: z.literal('decide'), command: decideConversationCleanupSchema }).strict(),
]);
const savedSchema = z.object({
  format: z.literal(1), scope: conversationCleanupScopeSchema, action: conversationCleanupActionSchema,
  selected: z.array(z.object({ id: z.uuid(), revision: z.number().int().positive() }).strict()).max(500),
  batchId: z.uuid().optional(), pending: pendingSchema.optional(), lastRequest: pendingSchema.optional(),
  originalCapture: prepareConversationCleanupSchema.optional(), originalDecision: decideConversationCleanupSchema.optional(),
}).strict();
export type CleanupSelection = z.infer<typeof savedSchema>;
type Pending = z.infer<typeof pendingSchema>;
type History = { items: ConversationCleanupSummary[]; total: number; nextOffset: number | null };
type Identity = { id: string; epoch?: string; digest?: string };
type View = { saved: CleanupSelection; batch?: ConversationCleanupBatch; history: History; historyBusy: boolean; missingPrepareId?: string; busy: boolean; error: string; invalid: boolean };
export type CleanupClientIO = {
  read: () => unknown; write: (value: CleanupSelection) => boolean;
  request: <T>(url: string, input?: unknown) => Promise<T>; uuid: () => string;
};

/** A retained UI request, never an automatic worker. Reopening only reads. */
export class ConversationCleanupClient {
  private view: View;
  private listeners = new Set<() => void>();
  private historyGeneration = 0;
  private historyRequest?: { offset: number; generation: number; promise: Promise<void> };
  constructor(private epoch: string, initialScope: ConversationCleanupScope, private io: CleanupClientIO) {
    const raw = io.read(), parsed = savedSchema.safeParse(raw);
    const invalid = raw !== undefined && raw !== null && !parsed.success;
    this.view = { saved: parsed.success ? parsed.data : { format: 1, scope: initialScope, action: initialScope.folder === 'deleted' ? 'restore' : 'archive', selected: [] }, history: { items: [], total: 0, nextOffset: null }, historyBusy: false, busy: false, invalid, error: invalid ? 'This saved cleanup view is unsupported. Its original browser record is kept.' : '' };
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<View>) { this.view = { ...this.view, ...change }; for (const listener of this.listeners) listener(); }
  private save(value: CleanupSelection) {
    if (this.view.invalid || !this.io.write(savedSchema.parse(value))) throw Error('Free browser storage before changing cleanup. The original request is kept.');
    this.update({ saved: value });
  }
  configure(change: { scope?: ConversationCleanupScope; action?: ConversationCleanupAction; selected?: CleanupSelection['selected'] }) {
    if (this.view.busy || this.view.saved.pending || this.view.batch?.state === 'review') return;
    try { this.save({ ...this.view.saved, ...change }); this.update({ error: '' }); } catch (e) { this.fail(e); }
  }
  private fail(error: unknown) { this.update({ error: error instanceof Error ? error.message : 'The original cleanup result is unconfirmed.' }); }
  private async run(work: () => Promise<void>) {
    if (this.view.busy || this.view.invalid) return;
    this.update({ busy: true, error: '' });
    try { await work(); } catch (e) { this.fail(e); } finally { this.update({ busy: false }); }
  }
  private identity(batch: ConversationCleanupBatch, expected: Identity) {
    if (batch.id !== expected.id || expected.epoch !== undefined && batch.epoch !== expected.epoch || expected.digest !== undefined && batch.digest !== expected.digest) {
      throw Error('The original cleanup identity did not match. Its exact request is kept.');
    }
  }
  private received(batch: ConversationCleanupBatch, expected: Identity, completed?: Pending) {
    this.identity(batch, expected);
    if (batch.epoch !== this.epoch) { this.update({ batch }); return; }
    this.save({ ...this.view.saved, batchId: batch.id, pending: undefined, ...(completed ? { lastRequest: completed } : {}) });
    this.update({ batch, missingPrepareId: undefined });
  }
  private missing(error: unknown) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'cleanup_missing' && 'status' in error && error.status === 404;
  }
  private async submitPrepare(pending: Extract<Pending, { kind: 'prepare' }>) {
    const { command } = pending;
    let batch: ConversationCleanupBatch;
    try { batch = await this.io.request<ConversationCleanupBatch>('assistant/conversation-cleanup/prepare', command); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['cleanup_empty', 'cleanup_limit', 'cleanup_scope_changed'].includes(String(error.code))) this.save({ ...this.view.saved, pending: undefined, batchId: undefined, lastRequest: pending });
      throw error;
    }
    this.received(batch, { id: command.requestId, epoch: command.epoch }, pending);
  }
  prepare(mode: 'selected' | 'matching') {
    return this.run(async () => {
      if (this.view.saved.pending || this.view.batch?.state === 'review') throw Error('Finish checking the original review first.');
      const saved = this.view.saved;
      const command: PrepareConversationCleanup = { requestId: this.io.uuid(), epoch: this.epoch, action: saved.action, scope: saved.scope, ...(mode === 'selected' ? { targets: saved.selected } : {}) };
      prepareConversationCleanupSchema.parse(command);
      const pending = { kind: 'prepare' as const, command };
      this.save({ ...saved, batchId: command.requestId, pending, originalCapture: command, originalDecision: undefined });
      this.update({ missingPrepareId: undefined });
      await this.submitPrepare(pending);
    });
  }
  /** Only an explicit action can resend an absent, original review request.
   * Recheck first: a late admission is adopted without another POST. */
  retryOriginalReview() {
    return this.run(async () => {
      const pending = this.view.saved.pending;
      if (pending?.kind !== 'prepare' || pending.command.epoch !== this.epoch || this.view.saved.batchId !== pending.command.requestId || this.view.missingPrepareId !== pending.command.requestId) {
        throw Error('Check the original review before retrying its saved request.');
      }
      this.update({ missingPrepareId: undefined });
      let batch: ConversationCleanupBatch;
      try { batch = await this.io.request<ConversationCleanupBatch>('assistant/conversation-cleanup?id=' + encodeURIComponent(pending.command.requestId)); }
      catch (error) {
        if (!this.missing(error)) throw error;
        // Verify durable storage again; keep exactly the original envelope.
        this.save(this.view.saved);
        await this.submitPrepare(pending);
        return;
      }
      this.received(batch, { id: pending.command.requestId, epoch: pending.command.epoch }, pending);
    });
  }
  decide(kind: 'apply' | 'cancel', retain: () => boolean = () => true) {
    return this.run(async () => {
      const batch = this.view.batch;
      if (!batch || batch.epoch !== this.epoch || batch.state !== 'review' || kind === 'apply' && this.view.saved.pending) throw Error('Check the original cleanup result before another decision.');
      if (kind === 'apply' && !retain()) throw Error('Your current writing could not be kept. Cleanup has not started.');
      const command: DecideConversationCleanup = { requestId: this.io.uuid(), epoch: this.epoch, batchId: batch.id, expectedRevision: batch.revision, digest: batch.digest, decision: kind };
      const pending: Pending = { kind: 'decide', command };
      this.save({ ...this.view.saved, pending, ...(kind === 'apply' ? { originalDecision: command } : {}), ...(this.view.saved.pending ? { lastRequest: this.view.saved.pending } : {}) });
      this.received(await this.io.request<ConversationCleanupBatch>('assistant/conversation-cleanup/decide', command), { id: command.batchId, epoch: command.epoch, digest: command.digest }, pending);
    });
  }
  /** A lost response never causes a new prepare/apply or repeats the old apply. */
  observe(reconcile = false) {
    return this.run(async () => {
      const id = this.view.saved.batchId; if (!id) return;
      const pending = this.view.saved.pending;
      this.update({ missingPrepareId: undefined });
      let batch: ConversationCleanupBatch;
      try { batch = await this.io.request<ConversationCleanupBatch>('assistant/conversation-cleanup?id=' + encodeURIComponent(id)); }
      catch (error) {
        if (this.missing(error) && pending?.kind === 'prepare' && pending.command.requestId === id && pending.command.epoch === this.epoch) {
          this.update({ missingPrepareId: id });
          throw Error('The service has no saved review for this original request. You can explicitly retry that same review request; no conversations will be changed.');
        }
        throw error;
      }
      const expected: Identity = pending?.kind === 'decide'
        ? { id: pending.command.batchId, epoch: pending.command.epoch, digest: pending.command.digest }
        : pending?.kind === 'prepare' ? { id: pending.command.requestId, epoch: pending.command.epoch }
        : { id, ...(this.view.batch?.id === id ? { epoch: this.view.batch.epoch, digest: this.view.batch.digest } : {}) };
      this.identity(batch, { id }); this.identity(batch, expected);
      this.update({ batch });
      if (batch.epoch !== this.epoch) return;
      // A prepare observation proves only the review exists. An unconfirmed
      // decision with no saved transition remains retained, never resubmitted.
      if (pending?.kind === 'decide' && batch.state === 'review') { this.update({ error: 'The original decision has no saved result yet. Its exact request is kept; it has not been sent again.' }); return; }
      if (reconcile && !batch.running && ['unconfirmed', 'partial'].includes(batch.state)) {
        const command: DecideConversationCleanup = { requestId: this.io.uuid(), epoch: this.epoch, batchId: id, expectedRevision: batch.revision, digest: batch.digest, decision: 'check' };
        const check: Pending = { kind: 'decide', command };
        this.save({ ...this.view.saved, pending: check, ...(pending ? { lastRequest: pending } : {}) });
        this.received(await this.io.request<ConversationCleanupBatch>('assistant/conversation-cleanup/decide', command), { id: command.batchId, epoch: command.epoch, digest: command.digest }, pending ?? check);
      } else if (!batch.running) this.received(batch, expected, pending);
    });
  }
  open(id: string) {
    if (this.view.busy || this.view.saved.pending) return Promise.resolve();
    try { this.save({ ...this.view.saved, batchId: id }); this.update({ batch: undefined }); } catch (e) { this.fail(e); return Promise.resolve(); }
    return this.observe();
  }
  freshReview() {
    if (this.view.busy || this.view.saved.pending || this.view.batch?.state === 'review' || this.view.batch?.running) return;
    try { this.save({ ...this.view.saved, batchId: undefined, selected: [] }); this.update({ batch: undefined, error: '' }); } catch (e) { this.fail(e); }
  }
  history(offset = 0): Promise<void> {
    if (!Number.isInteger(offset) || offset < 0 || this.view.invalid) return Promise.resolve();
    if (this.historyRequest?.offset === offset) return this.historyRequest.promise;
    if (offset && (this.historyRequest || offset !== this.view.history.nextOffset)) return this.historyRequest?.promise ?? Promise.resolve();
    if (!offset) this.historyGeneration++;
    const generation = this.historyGeneration, request = { offset, generation, promise: Promise.resolve() };
    this.historyRequest = request; this.update({ historyBusy: true });
    request.promise = (async () => {
      try {
        const page = await this.io.request<History>('assistant/conversation-cleanup?offset=' + offset);
        if (generation !== this.historyGeneration) return;
        const items = new Map<string, ConversationCleanupSummary>();
        for (const item of [...(offset ? this.view.history.items : []), ...page.items]) {
          const prior = items.get(item.id);
          if (!prior || item.revision > prior.revision) items.set(item.id, item);
        }
        this.update({ history: { ...page, items: [...items.values()] } });
      } catch (e) { if (generation === this.historyGeneration) this.fail(e); }
      finally { if (this.historyRequest === request) { this.historyRequest = undefined; this.update({ historyBusy: false }); } }
    })();
    return request.promise;
  }
}

// The same browser window keeps one authority across Assistant editor remounts.
// The supplied key includes epoch, device and the existing retained window ID.
const clients = new Map<string, ConversationCleanupClient>();
export function retainedCleanupClient(key: string, epoch: string, scope: ConversationCleanupScope, io: CleanupClientIO) {
  let client = clients.get(key);
  if (!client) { client = new ConversationCleanupClient(epoch, scope, io); clients.set(key, client); }
  return client;
}
