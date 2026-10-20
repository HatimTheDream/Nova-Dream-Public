import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import { assistantSpace } from '../../packages/domain/assistant-space.js';
import {
  conversationCleanupLimit, conversationMatchesScope, preparePermanentConversationCleanupSchema,
  decidePermanentConversationCleanupSchema, type PermanentConversationCleanupBatch,
  type PermanentConversationCleanupOutcome, type PermanentConversationCleanupSummary,
} from '../../packages/domain/conversation-cleanup.js';
import { removeConversationSchema } from '../../packages/domain/conversation-removal.js';
import type { AssistantService } from './assistant.js';
import { conversationItemRequestId } from './conversation-organization.js';
import { Store, Fault } from './store.js';

const prefix = 'assistant:cleanup:';
const targetSchema = z.object({
  id: z.uuid(), revision: z.number().int().positive(), title: z.string().max(150), space: z.enum(['chat', 'work']),
  projectId: z.string().max(100).nullable(), archived: z.boolean(), deleted: z.literal(true),
  nativeId: z.string().nullable(), nativeKey: z.string(), connectionGeneration: z.string(),
  command: removeConversationSchema,
}).strict();
const outcomeSchema = z.object({
  id: z.uuid(), state: z.enum(['pending', 'applied', 'blocked', 'unconfirmed']), code: z.string().max(100).optional(),
  chunkId: z.uuid().optional(), removalId: z.uuid().optional(),
}).strict();
const chunkSchema = z.object({
  id: z.uuid(), deviceId: z.string().min(1), decision: z.enum(['start', 'continue_remaining']),
  startedAt: z.string(), settledAt: z.string().optional(), state: z.enum(['running', 'closed']),
  itemIds: z.array(z.uuid()).max(25), stopReason: z.string().max(100).optional(),
}).strict();
const recordSchema = z.object({
  format: z.literal(2), id: z.uuid(), epoch: z.uuid(), deviceId: z.string().min(1), revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/), action: z.literal('remove'),
  scope: preparePermanentConversationCleanupSchema.shape.scope, mode: z.enum(['selected', 'matching']),
  createdAt: z.string(), updatedAt: z.string(), state: z.enum(['review', 'applying', 'complete', 'partial', 'unconfirmed', 'cancelled']),
  targets: z.array(targetSchema).min(1).max(conversationCleanupLimit),
  outcomes: z.array(outcomeSchema).min(1).max(conversationCleanupLimit),
  chunks: z.array(chunkSchema).max(conversationCleanupLimit),
}).strict();
type Record = z.infer<typeof recordSchema>;
type Target = Record['targets'][number];
const removalSchema = removeConversationSchema.extend({
  deviceId: z.string().min(1), nativeId: z.string().nullable(), nativeKey: z.string(), connectionGeneration: z.string(),
  state: z.enum(['prepared', 'unknown', 'completed', 'rejected']), message: z.string().optional(), updatedAt: z.string(),
}).strict();
const digest = (value: Pick<Record, 'id' | 'epoch' | 'deviceId' | 'action' | 'scope' | 'mode' | 'targets'>) =>
  createHash('sha256').update(canonical({
    id: value.id, epoch: value.epoch, deviceId: value.deviceId, action: value.action,
    scope: value.scope, mode: value.mode, targets: value.targets,
  })).digest('hex');
const invalid = () => new Fault(409, 'cleanup_record_invalid', 'The saved permanent review is unsupported or inconsistent. Its records are kept.');

/** Only batch accounting: ConversationRemovals remains the sole deletion writer.
 * The parent owns close(), including every admitted removal's original promise. */
export class PermanentConversationCleanup {
  private flights = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private store: Store,
    private assistant: Pick<AssistantService, 'conversations' | 'assertCleanupReady' | 'removals'>,
    private clock = Date.now,
    private monotonic = () => performance.now(),
  ) {}
  async close() { this.closed = true; await Promise.allSettled(this.flights.values()); }
  private available(epoch?: string) {
    if (this.closed) throw new Fault(503, 'service_closed', 'Reopen the original permanent-removal result.');
    this.store.assertUpdateAdmission();
    if (this.store.recoveryEffectsPaused) throw new Fault(409, 'recovery_connections_paused', 'Permanent cleanup stays paused in this recovered workspace.');
    if (epoch && epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Review cleanup in its original workspace.');
  }
  /** Also used by the reversible list before omitting a known permanent record. */
  validate(raw: unknown): Record {
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) throw invalid();
    const value = parsed.data, ids = new Set(value.targets.map(t => t.id)), chunks = new Map(value.chunks.map(c => [c.id, c]));
    if (value.digest !== digest(value) || ids.size !== value.targets.length || chunks.size !== value.chunks.length
      || value.outcomes.length !== value.targets.length || value.outcomes.some((o, i) => o.id !== value.targets[i].id)) throw invalid();
    const started = new Set<string>();
    for (const chunk of value.chunks) {
      if (new Set(chunk.itemIds).size !== chunk.itemIds.length || chunk.itemIds.some(id => !ids.has(id) || started.has(id))) throw invalid();
      chunk.itemIds.forEach(id => started.add(id));
    }
    for (const [index, target] of value.targets.entries()) {
      if (canonical(target.command) !== canonical(this.command(value, target))) throw invalid();
      const outcome = value.outcomes[index], chunk = outcome.chunkId ? chunks.get(outcome.chunkId) : undefined;
      if ((outcome.chunkId && (!chunk || !chunk.itemIds.includes(target.id)))
        || (started.has(target.id) !== !!outcome.chunkId) || (outcome.state === 'pending' && outcome.chunkId)
        || (outcome.removalId && !outcome.chunkId) || (outcome.state === 'applied' && !outcome.removalId)) throw invalid();
    }
    return value;
  }
  private read(id: string): Record {
    z.uuid().parse(id);
    const raw = this.store.internalRead(prefix + id);
    if (!raw) throw new Fault(404, 'cleanup_missing', 'This permanent-removal review is unavailable.');
    const value = this.validate(raw);
    if (value.id !== id) throw invalid();
    return value;
  }
  private save(value: Record) {
    const next = { ...value, revision: value.revision + 1, updatedAt: new Date(this.clock()).toISOString() };
    this.validate(next); return this.store.internalWrite(prefix + value.id, next);
  }
  private command(value: Pick<Record, 'id' | 'epoch'>, target: Pick<Target, 'id' | 'revision'>) {
    return { requestId: conversationItemRequestId(value.id, target.id), epoch: value.epoch, conversationId: target.id, expectedRevision: target.revision };
  }
  private observe(value: Record, target: Target, outcome: Record['outcomes'][number]): PermanentConversationCleanupOutcome {
    if (!outcome.chunkId) return outcome;
    const chunk = value.chunks.find(c => c.id === outcome.chunkId)!;
    const uncertain = (code: string, removalId = outcome.removalId): PermanentConversationCleanupOutcome =>
      ({ id: target.id, chunkId: chunk.id, state: 'unconfirmed', code, ...(removalId ? { removalId } : {}) });
    try {
      const receipt = this.store.replayAdmission<{ requestId: string }>(chunk.deviceId, target.command, { type: 'conversation.remove', ...target.command });
      if (!receipt) return outcome.state === 'blocked' ? outcome : uncertain('removal_unconfirmed');
      if (!z.object({ requestId: z.uuid() }).strict().safeParse(receipt).success) return uncertain('removal_authority');
      const actual = removalSchema.safeParse(this.store.internalRead('assistant:removal:' + receipt.requestId));
      if (!actual.success) return uncertain('removal_authority', receipt.requestId);
      const item = actual.data;
      if (outcome.removalId && outcome.removalId !== item.requestId || item.requestId !== receipt.requestId
        || item.deviceId !== chunk.deviceId || item.epoch !== value.epoch || item.conversationId !== target.id
        || item.expectedRevision !== target.revision || item.nativeId !== target.nativeId || item.nativeKey !== target.nativeKey
        || item.connectionGeneration !== target.connectionGeneration) return uncertain('removal_authority', receipt.requestId);
      const bound = { id: target.id, chunkId: chunk.id, removalId: item.requestId };
      if (item.state === 'rejected') return { ...bound, state: 'blocked', code: 'removal_rejected' };
      if (item.state !== 'completed') return { ...bound, state: 'unconfirmed', code: 'removal_unconfirmed' };
      const tombstone = this.store.internalRead<{ id: string; requestId: string }>('assistant:removed:' + target.id);
      if (tombstone?.id !== target.id || tombstone.requestId !== item.requestId
        || this.store.internalRead('assistant:conversation:' + target.id) !== undefined) return uncertain('removal_unconfirmed', item.requestId);
      return { ...bound, state: 'applied' };
    } catch { return uncertain('removal_unconfirmed'); }
  }
  get(id: string): PermanentConversationCleanupBatch {
    const value = this.read(id), running = this.flights.has(id);
    const outcomes = value.outcomes.map((o, i) => this.observe(value, value.targets[i], o));
    const counts = { pending: 0, applied: 0, blocked: 0, unconfirmed: 0 };
    for (const outcome of outcomes) counts[outcome.state]++;
    const state = value.state === 'review' || value.state === 'cancelled' ? value.state : running ? 'applying'
      : counts.unconfirmed || value.chunks.some(c => c.state === 'running') ? 'unconfirmed' : counts.pending || counts.blocked ? 'partial' : 'complete';
    const remainder: PermanentConversationCleanupBatch['remainder'] = {
      observedAt: new Date(this.clock()).toISOString(), verified: false,
      capturedRemaining: outcomes.filter(o => o.state !== 'applied').map(o => o.id),
    };
    try {
      const rows = this.assistant.conversations(), ids = new Set(value.targets.map(t => t.id));
      const matching = rows.filter(c => conversationMatchesScope(c, value.scope));
      remainder.matchingCount = matching.length; remainder.newMatchingCount = matching.filter(c => !ids.has(c.id)).length;
      // Missing metadata never establishes that an unresolved original is gone.
      remainder.verified = value.epoch === this.store.epoch && !outcomes.some(o => o.state === 'unconfirmed'
        || o.state !== 'applied' && !rows.some(c => c.id === o.id));
      if (!remainder.verified) remainder.error = 'The original remaining scope could not be fully verified.';
    } catch { remainder.error = 'The current remaining scope could not be verified.'; }
    return {
      format: 2, id: value.id, epoch: value.epoch, revision: value.revision, digest: value.digest, action: 'remove', scope: value.scope,
      mode: value.mode, createdAt: value.createdAt, updatedAt: value.updatedAt, state, running, counts, outcomes, remainder,
      targets: value.targets.map(({ nativeId: _id, nativeKey: _key, connectionGeneration: _generation, command: _command, ...target }) => target),
      chunks: value.chunks.map(({ deviceId: _device, ...chunk }) => ({ ...chunk, state: chunk.state === 'running' && !running ? 'unconfirmed' : chunk.state })),
    };
  }
  list(offset = 0, limit = 20): { total: number; items: PermanentConversationCleanupSummary[]; nextOffset: number | null } {
    z.number().int().nonnegative().parse(offset); z.number().int().min(1).max(50).parse(limit);
    // The parent validates every format before this typed list is requested.
    const records = this.store.internalList<{ format?: number }>(prefix).filter(raw => raw.format === 2).map(raw => this.validate(raw))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const items = records.slice(offset, offset + limit).map(record => {
      const { targets, outcomes: _o, chunks: _c, remainder: _r, digest: _d, ...summary } = this.get(record.id);
      return { ...summary, count: targets.length };
    });
    return { total: records.length, items, nextOffset: offset + limit < records.length ? offset + limit : null };
  }
  prepare(device: string, raw: unknown): PermanentConversationCleanupBatch {
    this.available();
    const input = preparePermanentConversationCleanupSchema.parse(raw);
    const admitted = this.store.admit(device, input, { type: 'conversation.cleanup.permanent.prepare', ...input }, () => {
      const rows = this.assistant.conversations().filter(c => conversationMatchesScope(c, input.scope));
      const chosen = input.targets ? input.targets.map(target => {
        const current = rows.find(c => c.id === target.id);
        if (!current || current.revision !== target.revision) throw new Fault(409, 'cleanup_scope_changed', 'A selected conversation changed or is outside Trash. Review it again.');
        return current;
      }) : rows;
      if (!chosen.length) throw new Fault(409, 'cleanup_empty', 'No conversations match this Trash review.');
      if (chosen.length > conversationCleanupLimit) throw new Fault(400, 'cleanup_limit', 'Review at most 500 exact conversations; nothing was captured or removed.');
      const identity = { id: input.requestId, epoch: input.epoch };
      const targets = chosen.map(c => {
        this.assistant.removals.assertAvailable(c.id);
        return { id: c.id, revision: c.revision, title: c.title, space: assistantSpace(c), projectId: c.projectId,
          archived: c.archived, deleted: true as const, nativeId: c.nativeId, nativeKey: c.nativeKey,
          connectionGeneration: c.connectionGeneration, command: this.command(identity, c) };
      }).sort((a, b) => a.id.localeCompare(b.id));
      const stamp = new Date(this.clock()).toISOString();
      const captured = { ...identity, deviceId: device, action: 'remove' as const, scope: input.scope, mode: input.targets ? 'selected' as const : 'matching' as const, targets };
      const value: Record = { ...captured, format: 2, revision: 1, digest: digest(captured), createdAt: stamp, updatedAt: stamp,
        state: 'review', outcomes: targets.map(t => ({ id: t.id, state: 'pending' })), chunks: [] };
      this.validate(value); this.store.internalWrite(prefix + value.id, value); return value.id;
    });
    return this.get(admitted.value);
  }
  decide(device: string, raw: unknown, reauthorize: () => void): PermanentConversationCleanupBatch {
    const input = decidePermanentConversationCleanupSchema.parse(raw);
    this.available(input.epoch); reauthorize();
    const value = this.read(input.batchId);
    if (value.epoch !== input.epoch || value.digest !== input.digest) throw new Fault(409, 'cleanup_changed', 'The original permanent inventory does not match.');
    const admitted = this.store.admit(device, input, { type: 'conversation.cleanup.permanent.decision', ...input }, () => {
      if (value.revision !== input.expectedRevision || this.flights.size > 0
        || (input.decision === 'start' || input.decision === 'cancel' ? value.state !== 'review' : value.state === 'review' || value.state === 'cancelled')
        || !value.outcomes.some(o => o.state === 'pending') || value.chunks.length >= conversationCleanupLimit) {
        throw new Fault(409, 'cleanup_changed', 'Check the original result before deciding about its remaining items.');
      }
      if (input.decision === 'cancel') this.save({ ...value, state: 'cancelled' });
      else this.save({ ...value, state: 'applying', chunks: [...value.chunks, {
        id: input.requestId, deviceId: device, decision: input.decision, startedAt: new Date(this.clock()).toISOString(), state: 'running', itemIds: [],
      }] });
      return value.id;
    });
    if (admitted.fresh && input.decision !== 'cancel') {
      // Defer only the start until the flight is registered; retain the entire
      // promise. An accepted response never waits for network removal.
      const flight = this.store.trackUpdateEffect('conversation-cleanup', async () => {
        await Promise.resolve(); await this.apply(value.id, input.requestId, reauthorize);
      }).finally(() => this.flights.delete(value.id));
      this.flights.set(value.id, flight);
      // Unexpected persistence failures leave durable unconfirmed ownership.
      // Observing the original record, not redispatch, is the recovery path.
      void flight.catch(() => {});
    }
    return this.get(admitted.value);
  }
  private async apply(id: string, chunkId: string, reauthorize: () => void) {
    const deadline = this.monotonic() + 30000;
    let value = this.read(id), chunk = value.chunks.find(c => c.id === chunkId)!;
    for (let index = 0; index < value.targets.length && chunk.itemIds.length < 25; index++) {
      if (value.outcomes[index].state !== 'pending') continue;
      try {
        this.available(value.epoch); reauthorize();
        if (this.monotonic() >= deadline) { chunk.stopReason = 'admission_window'; break; }
      } catch (error) { chunk.stopReason = error instanceof Fault ? error.code : 'authorization_unconfirmed'; break; }
      const target = value.targets[index];
      try {
        const current = this.assistant.conversations().find(c => c.id === target.id);
        if (!current) throw new Fault(409, 'conversation_missing', 'The original conversation is unavailable.');
        if (current.revision !== target.revision || current.nativeId !== target.nativeId || current.nativeKey !== target.nativeKey
          || current.connectionGeneration !== target.connectionGeneration || current.archived !== target.archived || !current.deleted) {
          throw new Fault(409, 'conversation_changed', 'The reviewed conversation changed.');
        }
        this.assistant.assertCleanupReady(current);
        chunk.itemIds.push(target.id);
        value.outcomes[index] = { id: target.id, chunkId, state: 'unconfirmed', code: 'removal_unconfirmed' };
        value = this.save(value); chunk = value.chunks.find(c => c.id === chunkId)!;
        // No await between the exact current guard and the maintained admission.
        const result = await this.assistant.removals.remove(chunk.deviceId, target.command);
        const observed = this.observe(value, target, value.outcomes[index]);
        value.outcomes[index] = observed.removalId === result.requestId ? observed
          : { id: target.id, chunkId, state: 'unconfirmed', code: 'removal_authority' };
      } catch (error) {
        const original = value.outcomes[index];
        if (original.chunkId) {
          const observed = this.observe(value, target, original);
          value.outcomes[index] = observed.state === 'applied' || observed.removalId ? observed
            : { ...original, state: error instanceof Fault ? 'blocked' : 'unconfirmed', code: error instanceof Fault ? error.code : 'removal_unconfirmed' };
        } else value.outcomes[index] = { id: target.id, state: 'blocked', code: error instanceof Fault ? error.code : 'admission_unconfirmed' };
      }
      value = this.save(value); chunk = value.chunks.find(c => c.id === chunkId)!;
    }
    chunk.state = 'closed'; chunk.settledAt = new Date(this.clock()).toISOString();
    if (chunk.itemIds.length === 25) chunk.stopReason ??= 'chunk_limit';
    value.state = value.outcomes.some(o => o.state === 'unconfirmed') ? 'unconfirmed'
      : value.outcomes.some(o => o.state === 'pending' || o.state === 'blocked') ? 'partial' : 'complete';
    this.save(value);
  }
}
