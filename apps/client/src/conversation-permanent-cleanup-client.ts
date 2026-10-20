import { z } from 'zod';
import { canonical } from '../../../packages/domain/contracts';
import {
  preparePermanentConversationCleanupSchema, decidePermanentConversationCleanupSchema,
  type ConversationCleanupScope, type PermanentConversationCleanupBatch, type PermanentConversationCleanupSummary,
  type PreparePermanentConversationCleanup, type DecidePermanentConversationCleanup,
} from '../../../packages/domain/conversation-cleanup';

const ownerSchema = z.object({ epoch: z.uuid(), deviceId: z.string().min(1), windowId: z.string().min(1) }).strict();
export type PermanentCleanupOwner = z.infer<typeof ownerSchema>;
const targetSchema = z.object({
  id: z.uuid(), revision: z.number().int().positive(), title: z.string().max(150),
  space: z.enum(['chat', 'work']), projectId: z.string().max(100).nullable(), archived: z.boolean(), deleted: z.literal(true),
}).strict();
const scopeSchema = preparePermanentConversationCleanupSchema.shape.scope;
const anchorSchema = z.object({
  id: z.uuid(), epoch: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), scope: scopeSchema,
  mode: z.enum(['selected', 'matching']), targets: z.array(targetSchema).min(1).max(500),
}).strict();
const countsSchema = z.object({ pending: z.number().int().nonnegative(), applied: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(), unconfirmed: z.number().int().nonnegative() }).strict();
const stateSchema = z.enum(['review', 'applying', 'complete', 'partial', 'unconfirmed', 'cancelled']);
const common = z.object({
  format: z.literal(2), id: z.uuid(), epoch: z.uuid(), revision: z.number().int().positive(), action: z.literal('remove'),
  scope: scopeSchema, mode: z.enum(['selected', 'matching']), createdAt: z.string().max(100), updatedAt: z.string().max(100),
  state: stateSchema, counts: countsSchema, running: z.boolean(),
}).strict();
const batchSchema = common.extend({
  digest: anchorSchema.shape.digest, targets: anchorSchema.shape.targets,
  outcomes: z.array(z.object({ id: z.uuid(), state: z.enum(['pending', 'applied', 'blocked', 'unconfirmed']), code: z.string().max(100).optional(), chunkId: z.uuid().optional(), removalId: z.uuid().optional() }).strict()).min(1).max(500),
  chunks: z.array(z.object({ id: z.uuid(), decision: z.enum(['start', 'continue_remaining']), startedAt: z.string().max(100), settledAt: z.string().max(100).optional(), state: z.enum(['running', 'closed', 'unconfirmed']), itemIds: z.array(z.uuid()).max(25), stopReason: z.string().max(100).optional() }).strict()).max(500),
  remainder: z.object({ observedAt: z.string().max(100), verified: z.boolean(), capturedRemaining: z.array(z.uuid()).max(500), matchingCount: z.number().int().nonnegative().optional(), newMatchingCount: z.number().int().nonnegative().optional(), error: z.string().max(1000).optional() }).strict(),
});
const summarySchema = common.extend({ count: z.number().int().min(1).max(500) });
const pendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prepare'), command: preparePermanentConversationCleanupSchema }).strict(),
  z.object({ kind: z.literal('decide'), command: decidePermanentConversationCleanupSchema }).strict(),
]);
const savedSchema = z.object({
  format: z.literal(1), owner: ownerSchema, scope: scopeSchema,
  selected: z.array(z.object({ id: z.uuid(), revision: z.number().int().positive() }).strict()).max(500).refine(items => new Set(items.map(t => t.id)).size === items.length),
  batchId: z.uuid().optional(), anchor: anchorSchema.optional(), pending: pendingSchema.optional(), lastRequest: pendingSchema.optional(),
  originalCapture: preparePermanentConversationCleanupSchema.optional(), originalDecision: decidePermanentConversationCleanupSchema.optional(),
}).strict();
type Pending = z.infer<typeof pendingSchema>;
export type PermanentCleanupSelection = z.infer<typeof savedSchema>;
type History = { items: PermanentConversationCleanupSummary[]; total: number; nextOffset: number | null };
type View = { saved: PermanentCleanupSelection; batch?: PermanentConversationCleanupBatch; observed: boolean; busy: boolean; invalid: boolean; error: string; missingPrepareId?: string; history: History; historyBusy: boolean };
export type PermanentCleanupIO = {
  read: () => unknown; write: (value: PermanentCleanupSelection) => boolean;
  request: <T>(url: string, command?: unknown) => Promise<T>; uuid: () => string;
};
const same = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : canonical(a) === canonical(b);
const anchor = ({ id, epoch, digest, scope, mode, targets }: PermanentConversationCleanupBatch) => anchorSchema.parse({ id, epoch, digest, scope, mode, targets });
const base = 'assistant/conversation-cleanup/permanent';
const unsupported = () => Error('The saved permanent review is unreadable or changed. Its original browser record is kept; reload before continuing.');

/** Validate public response joins, not native removal authority (owned by the service). */
export function readPermanentCleanupBatch(raw: unknown): PermanentConversationCleanupBatch {
  const parsed = batchSchema.safeParse(raw);
  if (!parsed.success) throw Error('The original permanent-removal result is incomplete or unsupported.');
  const value = parsed.data, ids = new Set(value.targets.map(t => t.id)), chunks = new Map(value.chunks.map(c => [c.id, c]));
  const counts = { pending: 0, applied: 0, blocked: 0, unconfirmed: 0 }, started = new Set<string>();
  if (ids.size !== value.targets.length || chunks.size !== value.chunks.length || value.outcomes.length !== ids.size) throw unsupported();
  for (const chunk of value.chunks) for (const id of chunk.itemIds) {
    if (!ids.has(id) || started.has(id)) throw unsupported();
    started.add(id);
  }
  for (const [i, item] of value.outcomes.entries()) {
    counts[item.state]++;
    if (item.id !== value.targets[i].id || (!!item.chunkId !== started.has(item.id))
      || item.chunkId && !chunks.get(item.chunkId)?.itemIds.includes(item.id)
      || item.state === 'pending' && item.chunkId || item.removalId && !item.chunkId || item.state === 'applied' && !item.removalId) throw unsupported();
  }
  const expectedState = ['review', 'cancelled'].includes(value.state) ? value.state : value.running ? 'applying'
    : counts.unconfirmed || value.chunks.some(c => c.state !== 'closed') ? 'unconfirmed'
    : counts.pending || counts.blocked ? 'partial' : 'complete';
  if (!same(counts, value.counts) || !same(value.remainder.capturedRemaining, value.outcomes.filter(o => o.state !== 'applied').map(o => o.id))
    || value.state !== expectedState
    || ['review', 'cancelled'].includes(value.state) && (value.chunks.length || counts.pending !== ids.size || value.running)
    || value.running !== (value.state === 'applying')
    || value.remainder.verified && (counts.unconfirmed > 0 || value.remainder.matchingCount === undefined || value.remainder.newMatchingCount === undefined)) throw unsupported();
  return value;
}

/** One retained owner. Nothing is sent by construction, reload or a status read. */
export class PermanentConversationCleanupClient {
  private view: View;
  private durable: unknown;
  private active = true;
  private listeners = new Set<() => void>();
  private historyFlight?: Promise<void>;
  constructor(private owner: PermanentCleanupOwner, initialScope: ConversationCleanupScope, private io: PermanentCleanupIO) {
    let raw: unknown, invalid = false;
    try { raw = io.read(); } catch { invalid = true; }
    const parsed = savedSchema.safeParse(raw);
    invalid ||= raw !== undefined && (!parsed.success || !same(parsed.data.owner, owner));
    if (parsed.success && !invalid) {
      const saved = parsed.data;
      invalid = new Set(saved.selected.map(t => t.id)).size !== saved.selected.length
        || !!saved.anchor && saved.anchor.id !== saved.batchId
        || !!saved.pending && (saved.pending.command.epoch !== owner.epoch
          || (saved.pending.kind === 'prepare' ? saved.pending.command.requestId : saved.pending.command.batchId) !== saved.batchId);
    }
    this.durable = raw;
    this.view = { saved: parsed.success && !invalid ? parsed.data : { format: 1, owner, scope: { ...initialScope, folder: 'deleted' }, selected: [] },
      observed: false, busy: false, invalid, error: invalid ? unsupported().message : '', history: { items: [], total: 0, nextOffset: null }, historyBusy: false };
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setActive(active: boolean) { this.active = active; }
  private update(change: Partial<View>) { this.view = { ...this.view, ...change }; for (const listener of this.listeners) listener(); }
  private save(value: PermanentCleanupSelection) {
    if (this.view.invalid || !same(this.io.read(), this.durable)) throw unsupported();
    // Match saveLocal's actual JSON bytes: optional undefined members disappear.
    // The CAS baseline must describe what the next read can really return.
    const next: PermanentCleanupSelection = JSON.parse(JSON.stringify(savedSchema.parse(value)));
    if (!same(next.owner, this.owner) || !this.io.write(next)) throw Error('Free browser storage before continuing. The original review and request are kept.');
    this.durable = structuredClone(next); this.update({ saved: next });
  }
  private fail(error: unknown) { this.update({ error: error instanceof Error ? error.message : 'The original result is unconfirmed.' }); }
  private async run(work: () => Promise<void>) {
    if (!this.active || this.view.busy || this.view.invalid) return;
    this.update({ busy: true, error: '' });
    try { await work(); } catch (error) { this.fail(error); } finally { this.update({ busy: false }); }
  }
  configure(change: { scope?: PermanentCleanupSelection['scope']; selected?: PermanentCleanupSelection['selected'] }) {
    if (!this.active || this.view.busy || this.view.saved.batchId || this.view.saved.pending) return;
    try { this.save({ ...this.view.saved, ...change }); this.update({ error: '' }); } catch (error) { this.fail(error); }
  }
  private validate(raw: unknown, id: string, pending?: Pending) {
    const batch = readPermanentCleanupBatch(raw), prior = this.view.saved.anchor;
    if (batch.id !== id || prior && (!same(anchor(batch), prior) || this.view.batch && batch.revision < this.view.batch.revision)
      || pending && (batch.epoch !== pending.command.epoch
        || pending.kind === 'decide' && batch.digest !== pending.command.digest)) throw Error('The original review identity changed. Its exact request is kept.');
    if (pending?.kind === 'prepare') {
      const command = pending.command;
      if (!same(batch.scope, command.scope) || batch.mode !== (command.targets ? 'selected' : 'matching')
        || command.targets && !same([...command.targets].sort((a, b) => a.id.localeCompare(b.id)), batch.targets.map(t => ({ id: t.id, revision: t.revision })))) throw unsupported();
    }
    return batch;
  }
  private received(raw: unknown, id: string, pending?: Pending, direct = false) {
    const batch = this.validate(raw, id, pending);
    if (batch.epoch !== this.owner.epoch) { this.update({ batch, observed: true }); return; }
    const acknowledged = !pending || pending.kind === 'prepare' || (pending.command.decision === 'cancel'
      ? direct && batch.state === 'cancelled' && batch.revision > pending.command.expectedRevision
      : batch.revision > pending.command.expectedRevision && batch.chunks.some(c => c.id === pending.command.requestId && c.decision === pending.command.decision));
    // A direct reply must also contain its actual transition. A different later
    // chunk cannot confirm this request, even if its review now looks complete.
    if (direct && !acknowledged) throw Error('The original decision is not confirmed by this result.');
    this.save({ ...this.view.saved, batchId: id, anchor: anchor(batch),
      ...(acknowledged ? { pending: undefined, ...(pending ? { lastRequest: pending } : {}) } : {}) });
    this.update({ batch, observed: true, missingPrepareId: undefined, error: acknowledged ? '' : 'The original decision remains unconfirmed. Only its status was read; it was not sent again.' });
  }
  private missing(error: unknown) { return !!error && typeof error === 'object' && 'code' in error && error.code === 'cleanup_missing' && 'status' in error && error.status === 404; }
  private async postPrepare(pending: Extract<Pending, { kind: 'prepare' }>) {
    try { this.received(await this.io.request(base + '/prepare', pending.command), pending.command.requestId, pending, true); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['cleanup_empty', 'cleanup_limit', 'cleanup_scope_changed'].includes(String(error.code))) {
        this.save({ ...this.view.saved, pending: undefined, batchId: undefined, lastRequest: pending });
      }
      throw error;
    }
  }
  prepare(mode: 'selected' | 'matching') {
    return this.run(async () => {
      if (this.view.saved.batchId || this.view.saved.pending) throw Error('Finish the original review first.');
      const command: PreparePermanentConversationCleanup = preparePermanentConversationCleanupSchema.parse({
        requestId: this.io.uuid(), epoch: this.owner.epoch, action: 'remove', scope: this.view.saved.scope,
        ...(mode === 'selected' ? { targets: this.view.saved.selected } : {}),
      });
      const pending = { kind: 'prepare' as const, command };
      this.save({ ...this.view.saved, batchId: command.requestId, anchor: undefined, pending, originalCapture: command, originalDecision: undefined });
      this.update({ observed: false }); await this.postPrepare(pending);
    });
  }
  /** This token is acknowledgement of exactly the currently observed review. */
  decisionToken(kind: 'start' | 'continue_remaining'): string | undefined {
    const { batch, saved, observed, invalid } = this.view;
    if (!this.active || invalid || !observed || !batch || batch.epoch !== this.owner.epoch || batch.running || saved.pending
      || !saved.anchor || !same(anchor(batch), saved.anchor) || !batch.counts.pending
      || (kind === 'start' ? batch.state !== 'review' : !['partial', 'unconfirmed'].includes(batch.state))) return;
    return canonical({ id: batch.id, epoch: batch.epoch, revision: batch.revision, digest: batch.digest, kind });
  }
  decide(kind: DecidePermanentConversationCleanup['decision'], acknowledgement?: string, retain: () => boolean = () => true) {
    return this.run(async () => {
      const batch = this.view.batch;
      if (!batch || !this.view.observed || batch.epoch !== this.owner.epoch || batch.running) throw Error('Observe the original review before making another decision.');
      if (kind === 'cancel') {
        if (batch.state !== 'review' || this.view.saved.pending?.kind === 'prepare') throw Error('Only an unstarted review can be cancelled.');
      } else {
        if (!acknowledgement || acknowledgement !== this.decisionToken(kind)) throw Error('Acknowledge this exact review and its current remaining count before removal.');
        if (!retain()) throw Error('Your current writing could not be kept. No new removal was sent.');
      }
      const command = decidePermanentConversationCleanupSchema.parse({ requestId: this.io.uuid(), epoch: this.owner.epoch,
        batchId: batch.id, expectedRevision: batch.revision, digest: batch.digest, decision: kind });
      const pending = { kind: 'decide' as const, command };
      this.save({ ...this.view.saved, pending, ...(kind !== 'cancel' ? { originalDecision: command } : {}),
        ...(this.view.saved.pending ? { lastRequest: this.view.saved.pending } : {}) });
      this.update({ observed: false });
      this.received(await this.io.request(base + '/decide', command), command.batchId, pending, true);
    });
  }
  observe() {
    return this.run(async () => {
      const { batchId, pending } = this.view.saved; if (!batchId) return;
      this.update({ observed: false, missingPrepareId: undefined });
      try { this.received(await this.io.request(base + '?id=' + encodeURIComponent(batchId)), batchId, pending); }
      catch (error) {
        if (this.missing(error) && pending?.kind === 'prepare') this.update({ missingPrepareId: batchId });
        throw error;
      }
    });
  }
  /** Explicit retry is solely for a never-visible, non-effectful review capture. */
  retryOriginalReview() {
    return this.run(async () => {
      const pending = this.view.saved.pending;
      if (pending?.kind !== 'prepare' || this.view.missingPrepareId !== pending.command.requestId) throw Error('Observe the original review first.');
      this.update({ missingPrepareId: undefined, observed: false });
      let result: unknown;
      try { result = await this.io.request(base + '?id=' + encodeURIComponent(pending.command.requestId)); }
      catch (error) {
        if (!this.missing(error) || !this.active) throw error;
        this.save(this.view.saved); await this.postPrepare(pending); return;
      }
      this.received(result, pending.command.requestId, pending);
    });
  }
  open(id: string) {
    if (!this.active || this.view.busy || this.view.saved.pending || this.view.batch?.state === 'review' || this.view.batch?.running) return Promise.resolve();
    try { this.save({ ...this.view.saved, batchId: z.uuid().parse(id), anchor: undefined }); this.update({ batch: undefined, observed: false }); }
    catch (error) { this.fail(error); return Promise.resolve(); }
    return this.observe();
  }
  freshReview() {
    const pending = this.view.saved.pending;
    const cancelledStatus = pending?.kind === 'decide' && pending.command.decision === 'cancel' && this.view.batch?.state === 'cancelled';
    if (!this.active || this.view.busy || pending && !cancelledStatus || !this.view.observed || this.view.batch?.state === 'review' || this.view.batch?.running) return;
    // Explicitly leaving a terminal cancelled review keeps the unanswered
    // cancellation request as history; its response is not labelled confirmed.
    try { this.save({ ...this.view.saved, batchId: undefined, anchor: undefined, selected: [], pending: undefined, ...(pending ? { lastRequest: pending } : {}) }); this.update({ batch: undefined, observed: false, error: '' }); } catch (error) { this.fail(error); }
  }
  history(offset = 0): Promise<void> {
    if (!this.active || this.view.invalid || !Number.isInteger(offset) || offset < 0 || offset && offset !== this.view.history.nextOffset) return Promise.resolve();
    if (this.historyFlight) return this.historyFlight;
    this.update({ historyBusy: true });
    this.historyFlight = (async () => {
      try {
        const page = z.object({ total: z.number().int().nonnegative(), items: z.array(summarySchema).max(20), nextOffset: z.number().int().nonnegative().nullable() }).strict().parse(await this.io.request(base + '?offset=' + offset));
        if (page.items.length !== Math.max(0, Math.min(20, page.total - offset))
          || new Set(page.items.map(item => item.id)).size !== page.items.length
          || page.nextOffset !== (offset + 20 < page.total ? offset + 20 : null)) throw unsupported();
        const items = new Map<string, PermanentConversationCleanupSummary>();
        for (const item of [...(offset ? this.view.history.items : []), ...page.items]) {
          if (Object.values(item.counts).reduce((a, b) => a + b, 0) !== item.count) throw unsupported();
          const prior = items.get(item.id); if (!prior || prior.revision < item.revision) items.set(item.id, item);
        }
        this.update({ history: { ...page, items: [...items.values()] } });
      } catch (error) { this.fail(error); }
      finally { this.historyFlight = undefined; this.update({ historyBusy: false }); }
    })();
    return this.historyFlight;
  }
}

const clients = new Map<string, PermanentConversationCleanupClient>();
export function retainedPermanentCleanupClient(key: string, owner: PermanentCleanupOwner, scope: ConversationCleanupScope, io: PermanentCleanupIO) {
  let client = clients.get(key);
  if (!client) { client = new PermanentConversationCleanupClient(owner, scope, io); clients.set(key, client); }
  return client;
}

export type CleanupMode = 'organize' | 'permanent';
const modeSchema = z.object({ format: z.literal(1), owner: ownerSchema, mode: z.enum(['organize', 'permanent']) }).strict();
/** Raw-aware mode selection never repairs or replaces another retained owner. */
export function readCleanupMode(raw: unknown, owner: PermanentCleanupOwner): CleanupMode {
  if (raw === undefined) return 'organize';
  const parsed = modeSchema.safeParse(raw);
  if (!parsed.success || !same(parsed.data.owner, owner)) throw unsupported();
  return parsed.data.mode;
}
export function keepCleanupMode(mode: CleanupMode, owner: PermanentCleanupOwner, original: unknown, read: () => unknown, write: (value: unknown) => boolean) {
  readCleanupMode(original, owner);
  if (!same(read(), original) || !write(modeSchema.parse({ format: 1, owner, mode }))) throw unsupported();
  return { format: 1 as const, owner, mode };
}
