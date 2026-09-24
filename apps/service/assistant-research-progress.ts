import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AssistantOperation, Conversation } from '../../packages/domain/assistant.js';
import type { AssistantPlan } from '../../packages/domain/assistant-plan.js';
import { canonical } from '../../packages/domain/contracts.js';
import { reconcileResearchEstimate, researchEstimateInputSchema, ResearchEstimateError } from '../../packages/domain/research-estimate.js';
import { Fault, Store } from './store.js';

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
type ResearchHost = {
  operations(): AssistantOperation[];
  conversation(id: string): Conversation;
  assertReady(conversation: Conversation): void;
};
type NativeBinding = { epoch: string; nativeKey: string; nativeId: string; runId?: string };
const researchProgressToolSchema = z.object({
  epoch: z.uuid(), nativeKey: z.string().min(1).max(300), nativeId: z.uuid(),
  runId: z.string().min(1).max(500), toolCallId: z.string().min(1).max(500),
  estimate: researchEstimateInputSchema,
}).strict();
const researchExecutionSchema = researchProgressToolSchema.omit({ runId: true });
const nativeToolEventSchema = z.object({
  runId: z.string().min(1).max(500), sessionKey: z.string().min(1).max(300).optional(), sessionId: z.uuid().optional(),
  seq: z.number().int().positive(), data: z.object({ name: z.literal('nova_research_progress'), phase: z.enum(['start', 'result']), toolCallId: z.string().min(1).max(500) }),
});
type ResearchCall = NativeBinding & { runId: string; operationId: string; toolCallId: string; sequence: number; expiresAt: number; settled: boolean; conflicted: boolean; inputHash?: string };

/** Resolve the reported native run itself. Never infer it from the latest chat. */
export function activeResearchOperation(store: Store, host: ResearchHost, input: NativeBinding) {
  if (input.epoch !== store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed.');
  if (!input.runId) throw new Fault(409, 'research_run_required', 'Report progress from the original research run.');
  const matching = host.operations().filter(operation => operation.epoch === input.epoch
    && operation.nativeKey === input.nativeKey && operation.nativeId === input.nativeId
    && operation.nativeRunId === input.runId);
  if (matching.length !== 1) throw new Fault(409, 'research_run_inactive', 'The original research run is unavailable.');
  const operation = matching[0], ref = operation.context.approvedPlan;
  if (!['accepted', 'running'].includes(operation.state) || operation.cancelRequested || operation.steerTarget
    || operation.context.space !== 'chat' || operation.context.workMode !== 'research'
    || operation.context.researchWorkflow !== 'chat-research-v1' || !ref || operation.context.planReview) {
    throw new Fault(409, 'research_run_inactive', 'Only active, approved Chat research can report its progress.');
  }
  const conversation = host.conversation(operation.conversationId);
  host.assertReady(conversation);
  if (conversation.nativeKey !== operation.nativeKey || conversation.nativeId !== operation.nativeId
    || conversation.connectionGeneration !== operation.connectionGeneration || conversation.revision !== operation.conversationRevision
    || conversation.archived || conversation.deleted || conversation.pendingSettings || conversation.state !== 'ready'
    || (conversation.space ?? 'chat') !== 'chat' || conversation.projectId !== (operation.context.project?.id ?? null)) {
    throw new Fault(409, 'research_context_changed', 'The original research conversation changed.');
  }
  const { digest, ...context } = operation.context;
  const plan = store.internalRead<AssistantPlan>(`assistant:plan:${ref.id}`);
  const version = plan?.versions.find(item => item.version === ref.version);
  if (hash(context) !== digest || !plan || plan.kind !== 'research' || plan.epoch !== operation.epoch
    || plan.conversationId !== operation.conversationId || plan.state !== 'implementing' || plan.version !== ref.version
    || plan.approval?.operationId !== operation.id || plan.approval.version !== ref.version || plan.approval.digest !== ref.digest
    || version?.digest !== ref.digest || canonical(version.proposal) !== canonical(ref.proposal)) {
    throw new Fault(409, 'research_plan_changed', 'The approved research context could not be verified.');
  }
  if ((conversation.permissionMode ?? 'read-only') !== plan.permissionMode) throw new Fault(409, 'research_context_changed', 'The research access setting changed.');
  if (context.project && store.readEntity('project', context.project.id)?.revision !== context.project.revision) {
    throw new Fault(409, 'research_project_changed', 'The research Project changed.');
  }
  return operation;
}

/** A bounded report on the existing operation, not a separate work dispatcher. */
export class AssistantResearchProgress {
  // Only authenticated native events admit calls. Cached runtime descriptors
  // can discard preparation callbacks before executing the original tool.
  private calls = new Map<string, ResearchCall>();
  private waiting = new Set<() => void>();
  private closed = false;
  constructor(private store: Store, private host: ResearchHost & { save(operation: AssistantOperation): AssistantOperation }) {}
  private callKey(input: { epoch: string; nativeKey: string; nativeId: string; toolCallId: string }) {
    return hash([input.epoch, input.nativeKey, input.nativeId, input.toolCallId]);
  }
  private prune() {
    const operations = new Map(this.host.operations().map(operation => [operation.id, operation]));
    for (const [key, call] of this.calls) {
      const operation = operations.get(call.operationId);
      // Retain stale identities while their run can still produce events.
      if (call.expiresAt <= Date.now() && (!operation || ['completed', 'failed', 'cancelled'].includes(operation.state))) this.calls.delete(key);
    }
  }
  /** Called only by Assistant.event after its authenticated run/generation fences. */
  observeNativeTool(operation: AssistantOperation, raw: unknown) {
    const parsed = nativeToolEventSchema.safeParse(raw);
    if (this.closed || !parsed.success || !operation.nativeId) return;
    const event = parsed.data;
    if (event.runId !== operation.nativeRunId || event.sessionKey && event.sessionKey !== operation.nativeKey
      || event.sessionId && event.sessionId !== operation.nativeId || event.seq > operation.lastSequence) return;
    const input = { epoch: operation.epoch, nativeKey: operation.nativeKey, nativeId: operation.nativeId, runId: event.runId };
    try { if (activeResearchOperation(this.store, this.host, input).id !== operation.id) return; } catch { this.changed(); return; }
    this.prune();
    const key = this.callKey({ ...input, toolCallId: event.data.toolCallId }), prior = this.calls.get(key);
    if (prior && prior.runId !== event.runId) { prior.conflicted = true; this.changed(); return; }
    if (prior && event.seq <= prior.sequence) {
      if (event.data.phase === 'result') { prior.settled = true; this.changed(); }
      return;
    }
    if (!prior && this.calls.size >= 256) return; // Never evict a live collision fence.
    this.calls.set(key, { ...input, operationId: operation.id, toolCallId: event.data.toolCallId, sequence: event.seq,
      expiresAt: prior?.expiresAt ?? Date.now() + 60000, settled: Boolean(prior?.settled || event.data.phase === 'result'), conflicted: prior?.conflicted ?? false, inputHash: prior?.inputHash });
    this.changed();
  }
  changed() { for (const wake of [...this.waiting]) wake(); }
  close() { this.closed = true; this.changed(); }
  private unverified() { return new Fault(409, 'research_call_unverified', 'The original research run could not be verified. Report from its active approved turn.'); }
  private assertWaitingContext(input: z.infer<typeof researchExecutionSchema>) {
    if (this.closed) throw this.unverified();
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed.');
    // This only decides whether to wait. The exact native event must supply
    // the run ID before any operation is selected or authorized.
    for (const operation of this.host.operations()) {
      if (operation.nativeKey !== input.nativeKey || operation.nativeId !== input.nativeId || operation.epoch !== input.epoch) continue;
      // chat.send may acknowledge after its first event/HTTP report. Keep the
      // bounded wait alive until the exact receipt replays those early events.
      if (!operation.nativeRunId && operation.state === 'dispatching' && !operation.cancelRequested && !operation.steerTarget
        && operation.context.space === 'chat' && operation.context.workMode === 'research'
        && operation.context.researchWorkflow === 'chat-research-v1' && operation.context.approvedPlan && !operation.context.planReview) {
        try {
          const conversation = this.host.conversation(operation.conversationId); this.host.assertReady(conversation);
          if (conversation.nativeKey === operation.nativeKey && conversation.nativeId === operation.nativeId
            && conversation.connectionGeneration === operation.connectionGeneration && conversation.revision === operation.conversationRevision
            && conversation.state === 'ready' && !conversation.archived && !conversation.deleted && !conversation.pendingSettings) return;
        } catch { /* An unavailable dispatch cannot extend the wait. */ }
      }
      if (!operation.nativeRunId) continue;
      try { activeResearchOperation(this.store, this.host, { ...input, runId: operation.nativeRunId }); return; } catch { /* Keep looking only for an eligible wait context. */ }
    }
    throw this.unverified();
  }
  private lookup(input: z.infer<typeof researchExecutionSchema>) {
    this.assertWaitingContext(input);
    const call = this.calls.get(this.callKey(input));
    if (!call) return;
    const replay = call.inputHash === hash(input) && this.store.internalRead(`assistant:research-progress:${call.operationId}:${hash(input.toolCallId)}`);
    if (call.conflicted || call.inputHash && call.inputHash !== hash(input) || !replay && (call.settled || call.expiresAt <= Date.now())) throw this.unverified();
    activeResearchOperation(this.store, this.host, { ...input, runId: call.runId });
    return call;
  }
  async reportTool(raw: unknown, signal?: AbortSignal) {
    const input = researchExecutionSchema.parse(raw);
    signal?.throwIfAborted(); this.prune();
    let call = this.lookup(input);
    if (!call) {
      if (this.waiting.size >= 64) throw new Fault(409, 'research_call_capacity', 'Wait for the outstanding research reports before requesting another.');
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = (error?: unknown) => { clearTimeout(timer); this.waiting.delete(wake); signal?.removeEventListener('abort', wake); error ? reject(error) : resolve(); };
        const wake = () => { try { signal?.throwIfAborted(); if (this.lookup(input)) finish(); } catch (error) { finish(error); } };
        timer = setTimeout(() => finish(this.unverified()), 2500);
        this.waiting.add(wake); signal?.addEventListener('abort', wake, { once: true }); wake();
      });
      signal?.throwIfAborted(); call = this.lookup(input);
    }
    if (!call) throw this.unverified();
    call.inputHash = hash(input);
    // Native events identify the run; the atomic exact-body receipt prevents
    // concurrent or lost-response retries from applying a revision twice.
    return this.report({ ...input, runId: call.runId });
  }
  report(raw: unknown) {
    const input = researchProgressToolSchema.parse(raw);
    return this.store.internalAtomic(() => {
      const operation = activeResearchOperation(this.store, this.host, input);
      const receiptKey = `assistant:research-progress:${operation.id}:${hash(input.toolCallId)}`, inputHash = hash(input);
      const receipt = this.store.internalRead<{ inputHash: string; result: { saved: true; revision: number } }>(receiptKey);
      if (receipt) {
        if (receipt.inputHash !== inputHash) throw new Fault(409, 'research_progress_reused', 'This progress call already saved a different update.');
        return receipt.result;
      }
      const ref = operation.context.approvedPlan!;
      let estimate;
      try {
        estimate = reconcileResearchEstimate(operation.researchEstimate, input.estimate, new Date().toISOString(), operation.lastSequence,
          { operationId: operation.id, epoch: operation.epoch, nativeRunId: input.runId, planId: ref.id, planVersion: ref.version, planDigest: ref.digest });
      } catch (reason) {
        if (reason instanceof ResearchEstimateError && reason.code === 'revision_conflict') {
          const prior = operation.researchEstimate;
          throw new Fault(409, 'research_progress_revision', `The research estimate changed. Use expectedRevision ${prior?.revision ?? 0} and retain completed work.`, { revision: prior?.revision ?? 0, estimate: prior ? { activity: prior.activity, basis: prior.basis, items: prior.items } : null });
        }
        throw new Fault(409, 'research_progress_changed', reason instanceof Error ? reason.message : 'Review the current progress revision before updating it.');
      }
      this.host.save({ ...operation, researchEstimate: estimate });
      const result = { saved: true as const, revision: estimate.revision };
      this.store.internalWrite(receiptKey, { conversationId: operation.conversationId, inputHash, result });
      return result;
    });
  }
}
