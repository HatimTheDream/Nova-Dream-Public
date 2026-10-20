import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import { assistantSpace } from '../../packages/domain/assistant-space.js';
import type { Conversation } from '../../packages/domain/assistant.js';
import {
  conversationCleanupLimit, conversationCleanupActionSchema, conversationCleanupScopeSchema,
  prepareConversationCleanupSchema, decideConversationCleanupSchema, conversationMatchesScope, conversationNeedsCleanup,
  type ConversationCleanupBatch, type ConversationCleanupOutcome, type ConversationCleanupSummary,
} from '../../packages/domain/conversation-cleanup.js';
import type { AssistantService } from './assistant.js';
import { conversationItemRequestId } from './conversation-organization.js';
import { Store, Fault } from './store.js';

const prefix = 'assistant:cleanup:';
const targetSchema = z.object({
  id: z.uuid(), revision: z.number().int().positive(), title: z.string().max(150), space: z.enum(['chat', 'work']),
  projectId: z.string().max(100).nullable(), archived: z.boolean(), deleted: z.boolean(),
  nativeId: z.string().nullable(), nativeKey: z.string(), connectionGeneration: z.string(),
}).strict();
const outcomeSchema = z.object({ id: z.uuid(), state: z.enum(['pending', 'applied', 'blocked', 'unconfirmed']),
  code: z.string().max(100).optional(), revision: z.number().int().positive().optional(), nativeRestorePending: z.boolean().optional() }).strict();
const recordSchema = z.object({
  format: z.literal(1), id: z.uuid(), epoch: z.uuid(), deviceId: z.string().min(1), revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/), action: conversationCleanupActionSchema, scope: conversationCleanupScopeSchema,
  mode: z.enum(['selected', 'matching']), createdAt: z.string(), updatedAt: z.string(),
  state: z.enum(['review', 'applying', 'complete', 'partial', 'unconfirmed', 'cancelled']),
  targets: z.array(targetSchema).min(1).max(conversationCleanupLimit), outcomes: z.array(outcomeSchema).min(1).max(conversationCleanupLimit),
}).strict();
type CleanupRecord = z.infer<typeof recordSchema>;
type Captured = CleanupRecord['targets'][number];
const digest = (value: Pick<CleanupRecord, 'id' | 'epoch' | 'deviceId' | 'action' | 'scope' | 'mode' | 'targets'>) => createHash('sha256').update(canonical({
  id: value.id, epoch: value.epoch, deviceId: value.deviceId, action: value.action, scope: value.scope, mode: value.mode, targets: value.targets,
})).digest('hex');

/** A fixed owner-reviewed batch around existing conversation edits, without a
 * native tool-call origin, a background worker, or automatic restart replay. */
export class ConversationCleanup {
  private flights = new Map<string, Promise<ConversationCleanupBatch>>();
  private closed = false;
  constructor(private store: Store, private assistant: Pick<AssistantService, 'conversations' | 'edit' | 'assertCleanupReady'>, private clock = Date.now) {}
  async close() { this.closed = true; await Promise.allSettled(this.flights.values()); }
  private available() {
    if (this.closed) throw new Fault(503, 'service_closed', 'Conversation cleanup is closed. Reopen its original result.');
    this.store.assertUpdateAdmission();
    if (this.store.recoveryEffectsPaused) throw new Fault(409, 'recovery_connections_paused', 'Cleanup stays paused in this recovered workspace.');
  }
  private read(id: string): CleanupRecord {
    z.uuid().parse(id);
    const raw = this.store.internalRead(prefix + id);
    if (!raw) throw new Fault(404, 'cleanup_missing', 'This cleanup review is unavailable.');
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) throw new Fault(409, 'cleanup_record_invalid', 'The saved cleanup format is unsupported. Its records are kept.');
    const value = parsed.data;
    if (value.digest !== digest(value) || new Set(value.targets.map(t => t.id)).size !== value.targets.length
      || value.outcomes.length !== value.targets.length || value.outcomes.some((o, i) => o.id !== value.targets[i].id)) {
      throw new Fault(409, 'cleanup_record_invalid', 'The saved cleanup inventory does not match. Its records are kept.');
    }
    return value;
  }
  private save(value: CleanupRecord) {
    const next = { ...value, revision: value.revision + 1, updatedAt: new Date(this.clock()).toISOString() };
    recordSchema.parse(next); return this.store.internalWrite(prefix + value.id, next);
  }
  get(id: string): ConversationCleanupBatch {
    const value = this.read(id), running = this.flights.has(id);
    const state = value.state === 'applying' && !running ? 'unconfirmed' : value.state;
    const counts = { pending: 0, applied: 0, blocked: 0, unconfirmed: 0 };
    for (const outcome of value.outcomes) counts[outcome.state]++;
    const remainder: ConversationCleanupBatch['remainder'] = { observedAt: new Date(this.clock()).toISOString(), verified: false, capturedRemaining: [] };
    try {
      const rows = this.assistant.conversations(), ids = new Set(value.targets.map(t => t.id));
      remainder.capturedRemaining = value.targets.filter(target => { const current = rows.find(c => c.id === target.id); return !current || conversationNeedsCleanup(current, value.action); }).map(t => t.id);
      const matching = rows.filter(c => conversationMatchesScope(c, value.scope) && conversationNeedsCleanup(c, value.action));
      remainder.matchingCount = matching.length; remainder.newMatchingCount = matching.filter(c => !ids.has(c.id)).length;
      remainder.verified = value.epoch === this.store.epoch;
      if (!remainder.verified) remainder.error = 'This review belongs to an earlier workspace epoch.';
    } catch { remainder.error = 'The current remaining scope could not be verified.'; }
    return { format: 1, id: value.id, epoch: value.epoch, revision: value.revision, digest: value.digest, action: value.action, scope: value.scope,
      mode: value.mode, createdAt: value.createdAt, updatedAt: value.updatedAt, state, running, counts, outcomes: value.outcomes, remainder,
      targets: value.targets.map(({ nativeId: _id, nativeKey: _key, connectionGeneration: _generation, ...target }) => target) };
  }
  list(offset = 0, limit = 20): { total: number; items: ConversationCleanupSummary[]; nextOffset: number | null } {
    z.number().int().nonnegative().parse(offset); z.number().int().min(1).max(50).parse(limit);
    const records = this.store.internalList<unknown>(prefix).map(raw => {
      const parsed = recordSchema.safeParse(raw);
      if (!parsed.success) throw new Fault(409, 'cleanup_record_invalid', 'A saved cleanup format is unsupported. Its records are kept.');
      return this.read(parsed.data.id);
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const items = records.slice(offset, offset + limit).map(record => {
      const { targets, outcomes: _outcomes, remainder: _remainder, digest: _digest, format: _format, ...summary } = this.get(record.id);
      return { ...summary, count: targets.length };
    });
    return { total: records.length, items, nextOffset: offset + limit < records.length ? offset + limit : null };
  }
  prepare(device: string, raw: unknown): ConversationCleanupBatch {
    this.available();
    const input = prepareConversationCleanupSchema.parse(raw);
    const admitted = this.store.admit(device, input, { type: 'conversation.cleanup.prepare', ...input }, () => {
      const rows = this.assistant.conversations().filter(c => conversationMatchesScope(c, input.scope) && conversationNeedsCleanup(c, input.action));
      const chosen = input.targets ? input.targets.map(target => {
        const current = rows.find(c => c.id === target.id);
        if (!current || current.revision !== target.revision) throw new Fault(409, 'cleanup_scope_changed', 'A selected conversation changed or is outside this scope. Review it again.');
        return current;
      }) : rows;
      if (!chosen.length) throw new Fault(409, 'cleanup_empty', 'No matching conversations need this change.');
      if (chosen.length > conversationCleanupLimit) throw new Fault(400, 'cleanup_limit', `${chosen.length} conversations match. Review at most ${conversationCleanupLimit} exact conversations; nothing was captured or changed.`);
      const targets = chosen.map(c => ({ id: c.id, revision: c.revision, title: c.title, space: assistantSpace(c), projectId: c.projectId,
        archived: c.archived, deleted: !!c.deleted, nativeId: c.nativeId, nativeKey: c.nativeKey, connectionGeneration: c.connectionGeneration })).sort((a, b) => a.id.localeCompare(b.id));
      const stamp = new Date(this.clock()).toISOString();
      const captured = { id: input.requestId, epoch: input.epoch, deviceId: device, action: input.action, scope: input.scope,
        mode: input.targets ? 'selected' as const : 'matching' as const, targets };
      const value: CleanupRecord = { ...captured, format: 1, revision: 1, digest: digest(captured), createdAt: stamp, updatedAt: stamp, state: 'review',
        outcomes: targets.map(t => ({ id: t.id, state: 'pending' })) };
      recordSchema.parse(value); this.store.internalWrite(prefix + value.id, value); return value.id;
    });
    return this.get(admitted.value);
  }
  private command(value: CleanupRecord, target: Captured) {
    return { requestId: conversationItemRequestId(value.id, target.id), epoch: value.epoch, conversationId: target.id, expectedRevision: target.revision,
      ...(value.action === 'trash' ? { deleted: true } : value.action === 'archive' ? { archived: true } : target.deleted ? { deleted: false } : { archived: false }) };
  }
  private prior(value: CleanupRecord, target: Captured) {
    const command = this.command(value, target);
    return this.store.replayAdmission<Conversation>(value.deviceId, command, { type: 'conversation.edit', ...command });
  }
  private applied(id: string, saved: Conversation): ConversationCleanupOutcome {
    return { id, state: 'applied', revision: saved.revision, ...(saved.nativeRestorePending ? { nativeRestorePending: true } : {}) };
  }
  private settle(value: CleanupRecord) {
    const state = value.outcomes.some(o => o.state === 'unconfirmed' || o.state === 'pending') ? 'unconfirmed'
      : value.outcomes.some(o => o.state === 'blocked') ? 'partial' : 'complete';
    return this.save({ ...value, state });
  }
  async decide(device: string, raw: unknown): Promise<ConversationCleanupBatch> {
    const input = decideConversationCleanupSchema.parse(raw);
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Review cleanup in its original workspace.');
    const value = this.read(input.batchId);
    if (value.epoch !== input.epoch || value.digest !== input.digest) throw new Fault(409, 'cleanup_changed', 'The original cleanup inventory does not match.');
    const currentFlight = this.flights.get(value.id);
    if (input.decision === 'check') {
      if (currentFlight) return currentFlight;
      this.available();
      if (value.state === 'review' || value.state === 'cancelled') return this.get(value.id);
      // No invocation of edit: checking cannot start a blocked/unstarted item.
      const outcomes = value.outcomes.map((outcome, index) => {
        if (outcome.state === 'applied' || outcome.state === 'blocked') return outcome;
        const prior = this.prior(value, value.targets[index]);
        return prior ? this.applied(outcome.id, prior) : { id: outcome.id, state: 'blocked' as const, code: 'not_applied' };
      });
      this.settle({ ...value, outcomes }); return this.get(value.id);
    }
    this.available();
    const admission = this.store.admit(device, input, { type: 'conversation.cleanup.decision', ...input }, () => {
      const current = this.read(value.id);
      if (current.revision !== input.expectedRevision || current.state !== 'review') throw new Fault(409, 'cleanup_changed', 'This cleanup review has already changed. Check its original result.');
      this.save({ ...current, state: input.decision === 'cancel' ? 'cancelled' : 'applying' }); return current.id;
    });
    if (!admission.fresh || input.decision === 'cancel') return this.flights.get(value.id) ?? this.get(value.id);
    const flight = this.store.trackUpdateEffect('conversation-cleanup', () => this.apply(value.id)).finally(() => this.flights.delete(value.id)); this.flights.set(value.id, flight);
    return flight;
  }
  private async apply(id: string): Promise<ConversationCleanupBatch> {
    const deadline = this.clock() + 15000;
    let value = this.read(id);
    for (let index = 0; index < value.targets.length; index++) {
      const target = value.targets[index]; let outcome: ConversationCleanupOutcome;
      try {
        this.available();
        if (this.clock() >= deadline) throw new Fault(409, 'time_limit', 'Review remaining conversations in another batch.');
        const prior = this.prior(value, target);
        if (prior) outcome = this.applied(target.id, prior);
        else {
          const current = this.assistant.conversations().find(c => c.id === target.id);
          if (!current) throw new Fault(409, 'conversation_missing', 'The original conversation is unavailable.');
          if (current.revision !== target.revision || current.nativeId !== target.nativeId || current.nativeKey !== target.nativeKey
            || current.connectionGeneration !== target.connectionGeneration || current.archived !== target.archived || !!current.deleted !== target.deleted) {
            throw new Fault(409, 'conversation_changed', 'The original conversation changed.');
          }
          this.assistant.assertCleanupReady(current);
          value.outcomes[index] = { id: target.id, state: 'unconfirmed', code: 'unconfirmed' };
          value = this.save(value);
          outcome = this.applied(target.id, await this.assistant.edit(value.deviceId, this.command(value, target)));
        }
      } catch (error) {
        outcome = { id: target.id, state: error instanceof Fault ? 'blocked' : 'unconfirmed', code: error instanceof Fault ? error.code : 'unconfirmed' };
        // A Fault from post-edit readback cannot undo a committed local receipt.
        // If receipt observation itself fails, retain uncertainty rather than
        // reporting an applied change as blocked.
        if (error instanceof Fault) {
          try { const prior = this.prior(value, target); if (prior) outcome = this.applied(target.id, prior); }
          catch { outcome = { id: target.id, state: 'unconfirmed', code: 'unconfirmed' }; }
        }
      }
      value.outcomes[index] = outcome; value = this.save(value);
    }
    this.settle(value);
    // Resolve after the owned loop has closed; no automatic follow-up worker.
    const result = this.get(id); return { ...result, running: false };
  }
}
