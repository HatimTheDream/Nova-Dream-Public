import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import { effortPreference, taskEffortDemand } from '../../packages/domain/auto-effort.js';
import { assistantAttachmentsIssue } from '../../packages/domain/assistant-attachments.js';
import type { AssistantOperation, Conversation } from '../../packages/domain/assistant.js';
import { planAmendSchema, planDecisionSchema, planToolSchema, planningToolAllowed, planTerminal, type AssistantPlan } from '../../packages/domain/assistant-plan.js';
import type { AssistantQuestion } from '../../packages/domain/questions.js';
import { Fault, Store } from './store.js';

const key = (id: string) => `assistant:plan:${id}`;
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const stamp = () => new Date().toISOString();
type Host = {
  conversation(id: string): Conversation; operation(id: string): AssistantOperation;
  operations(): AssistantOperation[]; assertReady(conversation: Conversation): void;
  save(operation: AssistantOperation): AssistantOperation; dispatch(id: string): void;
};
/** Plan proposals and implementation admission share the workspace's durable request receipts. */
export class AssistantPlans {
  constructor(private store: Store, private host: Host) {}
  list() { return this.store.internalList<AssistantPlan>('assistant:plan:').filter(item => item.epoch === this.store.epoch && !this.store.internalRead(`assistant:removed:${item.conversationId}`)).map(item => ({ ...item, reviewDigest: this.reviewDigest(item) })); }
  private get(id: string) { const item = this.store.internalRead<AssistantPlan>(key(id)); if (!item || item.epoch !== this.store.epoch) throw new Fault(404, 'plan_missing', 'This plan is unavailable.'); return item; }
  private save(item: AssistantPlan) { return this.store.internalWrite(key(item.id), { ...item, updatedAt: stamp() }); }
  requiresProtection(operation: AssistantOperation) {
    const latest = this.list().filter(item => item.conversationId === operation.conversationId).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
    return ['plan', 'research'].includes(operation.context.workMode ?? '') || !!latest && !latest.approval && !operation.context.approvedPlan;
  }
  capture(operation: AssistantOperation, conversation: Conversation) {
    if (operation.context.workMode !== 'plan' || operation.context.planReview) return operation;
    const prior = this.list().find(p => p.conversationId === conversation.id && ['drafting', 'ready', 'implementing', 'unknown'].includes(p.state));
    if (prior) throw new Fault(409, 'plan_pending', 'Review or request changes to the current plan before starting another.');
    const id = randomUUID(), at = stamp();
    this.save({ id, epoch: operation.epoch, conversationId: conversation.id, revision: 1, version: 1, state: 'drafting', permissionMode: conversation.permissionMode ?? 'read-only', sourceContext: operation.context, versions: [{ version: 1, operationId: operation.id, createdAt: at }], createdAt: at, updatedAt: at });
    const { digest: _digest, ...context } = operation.context, captured = { ...context, planReview: { id, version: 1 } };
    return { ...operation, context: { ...captured, digest: hash(captured) } };
  }
  observe(operation: AssistantOperation) {
    const ref = operation.context.planReview ?? operation.context.approvedPlan;
    if (!ref) return;
    const item = this.store.internalRead<AssistantPlan>(key(ref.id));
    if (!item || item.epoch !== operation.epoch || item.version !== ref.version) return;
    if (operation.context.approvedPlan) {
      if (item.approval?.operationId !== operation.id) return;
      const state = operation.state === 'completed' || operation.state === 'failed' || operation.state === 'cancelled' || operation.state === 'unknown' ? operation.state : 'implementing';
      if (state !== item.state || operation.error !== item.error) this.save({ ...item, revision: item.revision + 1, state, error: operation.error });
      return;
    }
    const version = item.versions.find(v => v.version === ref.version);
    if (version?.operationId !== operation.id || item.approval) return;
    const pending = this.questions(operation).some(q => q.snapshot.status !== 'answered');
    const state = operation.state === 'completed' ? version.proposal && !pending ? 'ready' : 'failed' : operation.state === 'unknown' ? 'unknown' : operation.state === 'failed' || operation.state === 'cancelled' ? operation.state : 'drafting';
    const error = operation.state === 'completed' && state === 'failed' ? pending ? 'A planning question is unresolved. Describe what should change to continue.' : 'The reply did not include a saved proposal. Describe what should change to prepare one.' : operation.error;
    if (state !== item.state || error !== item.error) this.save({ ...item, revision: item.revision + 1, state, error });
  }
  private questions(operation: AssistantOperation) { return this.store.internalList<AssistantQuestion>('assistant:question:').filter(q => q.epoch === operation.epoch && q.conversationId === operation.conversationId && q.nativeId === operation.nativeId && (q.snapshot.runId ? q.snapshot.runId === operation.nativeRunId : q.snapshot.createdAtMs >= Date.parse(operation.createdAt) && q.snapshot.createdAtMs <= Date.parse(operation.settledAt ?? stamp()))); }
  private active(nativeKey: string, nativeId: string, runId?: string) {
    const matching = this.host.operations().filter(op => op.epoch === this.store.epoch && op.nativeKey === nativeKey && op.nativeId === nativeId && !op.steerTarget && !op.cancelRequested && ['dispatching', 'accepted', 'running'].includes(op.state) && (!runId || !op.nativeRunId || op.nativeRunId === runId));
    if (matching.length !== 1) throw new Fault(409, 'plan_run_inactive', 'The original planning request is no longer active.');
    const operation = matching[0], conversation = this.host.conversation(operation.conversationId);
    this.host.assertReady(conversation);
    if (conversation.nativeId !== nativeId || conversation.nativeKey !== nativeKey || (conversation.permissionMode ?? 'read-only') !== this.store.internalRead<AssistantPlan>(key(operation.context.planReview?.id ?? ''))?.permissionMode && operation.context.workMode === 'plan') throw new Fault(409, 'plan_context_changed', 'This conversation changed. Review the current plan again.');
    return operation;
  }
  propose(raw: unknown) {
    const input = planToolSchema.parse(raw);
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed.');
    return this.store.internalAtomic(() => {
      const operation = this.active(input.nativeKey, input.nativeId, input.runId), ref = operation.context.planReview;
      if (operation.context.workMode !== 'plan' || !ref) throw new Fault(403, 'plan_only', 'Save a proposal from its original Plan request.');
      const item = this.get(ref.id), version = item.versions.find(v => v.version === ref.version)!;
      if (item.version !== ref.version || item.state !== 'drafting' || item.approval) throw new Fault(409, 'plan_changed', 'This plan changed before its proposal was saved.');
      const questions = this.questions(operation);
      if (questions.some(q => q.snapshot.status !== 'answered')) throw new Fault(409, 'plan_questions', 'Resolve the planning questions before saving the proposal.');
      const digest = hash({ id: item.id, version: item.version, proposal: input.proposal, source: item.sourceContext.digest, questions: questions.map(q => ({ id: q.id, answers: q.snapshot.answers })) });
      if (version.digest && version.digest !== digest) throw new Fault(409, 'plan_proposal_exists', 'This proposal is already saved. Wait for the owner to request changes.');
      if (!version.digest) this.save({ ...item, revision: item.revision + 1, versions: item.versions.map(v => v.version === ref.version ? { ...v, proposal: input.proposal, digest, questionIds: questions.map(q => q.id) } : v) });
      return { saved: true, version: item.version, message: 'The proposal is saved for review when this planning turn finishes. It is not approved for implementation.' };
    });
  }
  toolPolicy(raw: unknown) {
    const input = z.object({ epoch: z.uuid(), nativeKey: z.string().min(1), nativeId: z.uuid(), runId: z.string().optional(), toolName: z.string().min(1).max(500) }).strict().parse(raw);
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed.');
    const bound = this.host.operations().filter(op => op.epoch === this.store.epoch && op.nativeKey === input.nativeKey && op.nativeId === input.nativeId && !op.steerTarget).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    // The shared main agent also owns non-Nova sessions and native Goal continuations.
    // This policy never replaces their existing runtime access policy.
    if (!bound.length) return { block: false };
    const latestPlan = this.list().filter(p => p.conversationId === bound[0].conversationId).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
    const pendingPlan = !!latestPlan && !latestPlan.approval;
    const current = bound.find(op => !planTerminal.has(op.state));
    const readOnly = !!current && ['plan', 'research'].includes(current.context.workMode ?? '') || pendingPlan && !current?.context.approvedPlan;
    if (!readOnly) return { block: false };
    this.active(input.nativeKey, input.nativeId, input.runId);
    return !planningToolAllowed(input.toolName) ? { block: true, blockReason: 'This turn is for planning or research. Use read-only tools; implementation requires approval of the saved plan.' } : { block: false };
  }
  decide(device: string, raw: unknown, amend = false) {
    const input = amend ? planAmendSchema.parse(raw) : planDecisionSchema.parse(raw);
    const admitted = this.store.admit(device, input, { type: amend ? 'plan.amend' : 'plan.approve', ...input }, () => {
      const item = this.get(input.id), version = item.versions.find(v => v.version === item.version)!;
      if (item.revision !== input.expectedRevision || item.version !== input.version || (version.digest ?? hash({ id: item.id, version: item.version })) !== input.digest || item.approval || !(amend ? ['ready', 'failed', 'cancelled'] : ['ready']).includes(item.state)) throw new Fault(409, 'plan_changed', 'This plan changed. Review the latest version before continuing.');
      const source = this.host.operation(version.operationId), conversation = this.host.conversation(item.conversationId);
      this.host.assertReady(conversation);
      if (this.host.operations().some(op => op.conversationId === item.conversationId && !planTerminal.has(op.state))) throw new Fault(409, 'plan_busy', 'Finish or reconcile the current reply before continuing.');
      if (!amend && (conversation.nativeId !== source.nativeId || conversation.nativeKey !== source.nativeKey || conversation.connectionGeneration !== source.connectionGeneration || conversation.revision !== source.conversationRevision || (conversation.permissionMode ?? 'read-only') !== item.permissionMode)) throw new Fault(409, 'plan_context_changed', 'The conversation or access setting changed. Describe what should change to prepare a new version with the current context.');
      if (!amend && source.context.project && this.store.readEntity('project', source.context.project.id)?.revision !== source.context.project.revision) throw new Fault(409, 'plan_source_changed', 'Project sources changed. Describe what should change to review the updated sources before implementation.');
      const id = randomUUID(), at = stamp(), nextVersion = amend ? item.version + 1 : item.version;
      const { digest: _digest, planReview: _review, approvedPlan: _approved, ...captured } = source.context;
      const project = conversation.projectId ? this.store.readEntity('project', conversation.projectId) : undefined;
      if (amend && conversation.projectId && !project) throw new Fault(409, 'plan_project_missing', 'Restore or select the Project before revising this plan.');
      const oldProjectFiles = new Set((source.context.project?.attachments ?? []).map(file => file.id));
      const files = amend ? [...new Map([...source.context.attachments.filter(file => !oldProjectFiles.has(file.id)), ...(project?.value.attachments ?? [])].map(file => [file.id, file])).values()] : source.context.attachments;
      for (const file of files) if (canonical(this.store.blobMetadata(file.id)) !== canonical(file)) throw new Fault(409, 'plan_source_changed', 'A plan source changed or is missing.');
      if (files.length > 10 || assistantAttachmentsIssue(files)) throw new Fault(409, 'plan_sources', 'Review the plan sources before revising: use up to 10 supported files.');
      const refreshed = amend ? { ...captured, attachments: files, project: project ? { id: project.id, revision: project.revision, name: project.value.name, purpose: project.value.purpose, instructions: project.value.instructions, workspace: conversation.workspace ?? project.value.workspace, attachments: project.value.attachments } : null } : captured;
      const context = { ...refreshed, workMode: amend ? 'plan' as const : 'chat' as const, ...(amend ? { planReview: { id: item.id, version: nextVersion, ...(version.proposal ? { previousProposal: version.proposal } : {}) } } : { approvedPlan: { id: item.id, version: item.version, digest: version.digest!, proposal: version.proposal! } }) };
      const operation: AssistantOperation = { ...source, id, requestId: input.requestId, deviceId: device, conversationRevision: conversation.revision, connectionGeneration: conversation.connectionGeneration, nativeId: conversation.nativeId!, nativeKey: conversation.nativeKey, model: conversation.model, thinking: effortPreference(conversation.thinking), fastMode: conversation.fastMode, autoEffort: undefined, nativeRunId: null, state: 'prepared', input: amend ? ('text' in input && typeof input.text === 'string' ? input.text : '') : `Yes, implement this plan: ${version.proposal!.title}`, context: { ...context, digest: hash(context) }, createdAt: at, updatedAt: at, text: '', lastSequence: 0, tools: [], plan: undefined, planSequence: undefined, error: undefined, settledAt: undefined, cancelRequested: undefined, effectiveModel: undefined, nativeTurnId: undefined };
      if (operation.thinking === 'auto') operation.effortDemand = taskEffortDemand(operation.input, operation.context, source.effortDemand);
      this.save({ ...item, ...(amend ? { permissionMode: conversation.permissionMode ?? 'read-only', sourceContext: operation.context } : {}), revision: item.revision + 1, version: nextVersion, state: amend ? 'drafting' : 'implementing', error: undefined, versions: amend ? [...item.versions, { version: nextVersion, operationId: id, createdAt: at, amendment: 'text' in input && typeof input.text === 'string' ? input.text : '' }] : item.versions, ...(amend ? {} : { approval: { requestId: input.requestId, version: item.version, digest: version.digest!, operationId: id, approvedAt: at } }) });
      return this.host.save(operation);
    });
    if (admitted.fresh) this.host.dispatch(admitted.value.id);
    return this.host.operation(admitted.value.id);
  }
  reviewDigest(item: AssistantPlan) { return item.versions.find(v => v.version === item.version)?.digest ?? hash({ id: item.id, version: item.version }); }
}
