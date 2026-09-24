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
const researchCallSchema = researchProgressToolSchema.omit({ estimate: true });
const researchExecutionSchema = researchProgressToolSchema.omit({ runId: true });
type ResearchCall = z.infer<typeof researchCallSchema> & { expiresAt: number; consumed: boolean; conflicted: boolean };

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
  // Native tool preparation captures the exact call before execution. Keep
  // its short-lived handoff in the owning service across plugin registrations.
  private calls = new Map<string, ResearchCall>();
  constructor(private store: Store, private host: ResearchHost & { save(operation: AssistantOperation): AssistantOperation }) {}
  private callKey(input: { epoch: string; nativeKey: string; nativeId: string; toolCallId: string }) {
    return hash([input.epoch, input.nativeKey, input.nativeId, input.toolCallId]);
  }
  authorizeTool(raw: unknown) {
    const input = researchCallSchema.parse(raw), now = Date.now();
    for (const [key, call] of this.calls) if (call.expiresAt <= now) this.calls.delete(key);
    const key = this.callKey(input), prior = this.calls.get(key);
    if (prior && (prior.runId !== input.runId || !prior.consumed || prior.conflicted)) {
      prior.conflicted = true;
      throw new Fault(409, 'research_call_conflict', 'The research call identity conflicts with another execution.');
    }
    activeResearchOperation(this.store, this.host, input);
    if (!prior && this.calls.size >= 256) throw new Fault(409, 'research_call_capacity', 'Wait for the outstanding research reports before requesting another.');
    this.calls.set(key, { ...input, expiresAt: now + 60000, consumed: false, conflicted: false });
    return { authorized: true as const };
  }
  reportTool(raw: unknown) {
    const input = researchExecutionSchema.parse(raw), call = this.calls.get(this.callKey(input));
    if (!call || call.consumed || call.conflicted || call.expiresAt <= Date.now()) {
      throw new Fault(409, 'research_call_unverified', 'The original research run could not be verified. Report from its active approved turn.');
    }
    call.consumed = true;
    // The run ID comes only from native preparation admission, never tool
    // arguments or the latest conversation. report rechecks the live context.
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
