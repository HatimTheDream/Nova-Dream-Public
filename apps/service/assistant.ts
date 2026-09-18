import { workProjectDiffSchema } from '../../packages/domain/work-project.js';
import { assistantSpace, spaceDraftId, spaceInstructions } from '../../packages/domain/assistant-space.js';
import { initialConversationTitle } from '../../packages/domain/conversation-title.js';
import { planningGuidance, readRunPlan } from '../../packages/domain/run-plan.js';
import { chatGoalSchema, chatGoalActionSchema } from '../../packages/domain/chat-goal.js';
import { ConversationRemovals } from './conversation-removal.js';
import { AssistantMemory } from './memory.js';
import { memoryContext } from '../../packages/domain/memory.js';
import { toolActivity, historyToolInfo } from '../../packages/domain/tool-activity.js';
import { MessagePins } from './message-pins.js';
import { locateHistoryPosition } from './history-position.js';
import type { SessionSettingsControl } from './full-access.js';
import { workModeInstructions } from '../../packages/domain/work-mode.js';
import { computerControlGuidance } from '../../packages/domain/computer-control.js';
import { createHash, randomUUID } from 'node:crypto';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import { canonical, type Attachment } from '../../packages/domain/contracts.js';
import { createConversationSchema, submitSchema, enqueueSchema, steerSchema, conversationEditSchema, recoverSettingsSchema, saveOutputSchema, saveArtifactSchema, artifactSourceSchema, queueActionSchema, queueStateSchema, queueEditSchema, queueOrderSchema, forkConversationSchema, type QueuedMessage, type AssistantOutput, type AssistantOperation, type AssistantState, type ContextManifest, type Conversation, type ConversationHistory, type ConversationMessage, type MessageAttachment } from '../../packages/domain/assistant.js';
import { Fault, Store } from './store.js';
import type { AssistantTransport } from './gateway.js';
import type { VoiceTarget } from '../../packages/domain/voice.js';
import { browseConversationSchema } from '../../packages/domain/search.js';
import { ConversationSearch } from './conversation-search.js';
import { ArtifactReader } from './artifacts.js';
import { SavedHistory } from './saved-history.js';

const conversationKey = (id: string) => `assistant:conversation:${id}`;
const operationKey = (id: string) => `assistant:operation:${id}`;
const terminal = new Set(['completed', 'failed', 'cancelled']);
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const textOf = (message: any): string => typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.filter((part: any) => part?.type === 'text' || ['tool', 'toolResult'].includes(message.role) && part?.type === 'toolResult').map((part: any) => typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? part.content.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('\n') : '').join('\n') : typeof message?.text === 'string' ? message.text : '';
const ownerMessage = (operation: AssistantOperation) => {
  // Reconstruct previously captured envelopes exactly; only new sends use the current name.
  const brand = operation.context.brandVersion === 1 ? 'Nova Dream' : 'Edition 3';
  const context = operation.context.project;
  const modeGuidance = operation.context.workMode === 'goal' && !operation.context.goalReporting ? '' : workModeInstructions(operation.context.workMode);
  const guidance = [spaceInstructions(operation.context.space), operation.context.planning ? planningGuidance : '', modeGuidance, operation.context.computerControlGuidance].filter(Boolean).join('\n\n');
  if (operation.context.messageVersion === 2) return `Owner message:\n${operation.input}\n\n${memoryContext(operation.context.memory, brand)}${guidance ? `${brand} work mode:\n${guidance}\n\n` : ''}${context ? `Selected Project context (supplied context, not a filesystem sandbox):\n${JSON.stringify(context)}\n` : ''}`;
  return `${memoryContext(operation.context.memory, brand)}${guidance ? `${brand} work mode:\n${guidance}\n\n` : ''}${context ? `${brand} selected Project context (organization and supplied context; not a filesystem sandbox):\n${JSON.stringify(context)}\nContext manifest: ${operation.context.digest}\n\nOwner message:\n` : `${brand} owner message:\n`}${operation.input}`;
};

// Native sends trim the envelope before saving it. Normalize only its boundary
// whitespace for comparison, keeping the original input and native text exact.
const matchesOwnerMessage = (operation: AssistantOperation, text: string) => ownerMessage(operation).trim() === text.trim();

/** App intent and native history have separate authority. Unknown sends are never replayed. */
export class AssistantService {
  private stopListening: () => void;
  private earlyEvents = new Map<string, EventFrame[]>();
  private closed = false;
  private settingRequests = new Map<string, string>();
  private queueTimer?: ReturnType<typeof setInterval>;
  private historyReads = new Map<string, Promise<ConversationHistory>>();
  private pendingCompletions = new Map<string, { nextCheck: number; lastActive: number }>();
  private completionReads = new Set<string>();
  private subscribed = new Set<string>();
  private approvalReady: (conversationId: string) => Promise<void> = async () => {};
  prepareApprovalReview(conversationId: string) { return this.approvalReady(conversationId); }
  setApprovalReview(ready: (conversationId: string) => Promise<void>) { this.approvalReady = ready; }
  private voiceBusy: (conversationId: string) => boolean = () => false;
  private artifactReader: ArtifactReader;
  readonly pins: MessagePins;
  readonly memory: AssistantMemory;
  readonly removals: ConversationRemovals;
  private historyVersions: Record<string, number> = {};
  constructor(private store: Store, private gateway: AssistantTransport, artifactExchange?: typeof fetch, private accessControl?: Pick<SessionSettingsControl, 'request'>, private responseControl?: Pick<SessionSettingsControl, 'request'>) {
    this.removals = new ConversationRemovals(store, gateway, id => this.voiceBusy(id));
    this.artifactReader = new ArtifactReader(gateway, artifactExchange);
    this.pins = new MessagePins(store, id => this.conversation(id), id => this.cachedHistory(id));
    this.memory = new AssistantMemory(store, id => this.conversation(id), id => this.cachedHistory(id));
    for (const op of this.operations()) if (!terminal.has(op.state)) this.saveOperation({ ...op, state: 'unknown', error: 'The service restarted. Check the original run; it will not be dispatched again.' });
    for (const conversation of this.conversations()) if (conversation.state === 'creating') this.saveConversation({ ...conversation, state: 'unknown', error: 'Creation was interrupted. Reconcile its original session identity.' });
    this.stopListening = gateway.subscribe(event => { void this.event(event).catch(() => undefined); });
    this.queueTimer = setInterval(() => this.runAutomaticQueues(), 750); this.queueTimer.unref?.();
  }
  close() { this.removals.close(); this.closed = true; clearInterval(this.queueTimer); this.stopListening(); this.artifactReader.close(); }
  private runAutomaticQueues() {
    if (this.closed || this.gateway.status().state !== 'ready') return;
    for (const [id, check] of this.pendingCompletions) {
      const operation = this.operations().find(item => item.id === id);
      if (!operation || terminal.has(operation.state) || operation.state === 'unknown') { this.pendingCompletions.delete(id); continue; }
      if (check.nextCheck > Date.now() || this.completionReads.has(operation.conversationId)) continue;
      check.nextCheck = Date.now() + 2500;
      this.completionReads.add(operation.conversationId);
      void this.reconcile(operation.conversationId).then(history => {
        if (this.closed) return;
        const current = this.operations().find(item => item.id === id);
        if (!current || terminal.has(current.state)) this.pendingCompletions.delete(id);
        else if (history.inFlightRun?.runId === current.nativeRunId) check.lastActive = Date.now();
        else if (Date.now() - check.lastActive > 30000) this.unconfirmedCompletion(current);
      }).catch(() => { const current = !this.closed && this.operations().find(item => item.id === id); if (current) this.unconfirmedCompletion(current); else this.pendingCompletions.delete(id); }).finally(() => this.completionReads.delete(operation.conversationId));
    }
    const seen = new Set<string>();
    for (const item of this.queue().filter(q => q.state === 'paused')) {
      if (seen.has(item.conversationId)) continue;
      seen.add(item.conversationId);
      if (!item.automatic || !item.autoRequestId || this.voiceBusy(item.conversationId)) continue;
      const operations = this.operations().filter(op => op.conversationId === item.conversationId);
      // A direction can settle after the original reply. Keep the follow-up
      // automatic while waiting; runQueued must not turn this normal wait into
      // a permanent pause (or replay an unconfirmed direction).
      if (operations.some(op => !terminal.has(op.state))) continue;
      const previous = operations.filter(op => !op.steerTarget).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      // A stopped/failed reply is a pause, never permission to launch more work.
      if (previous && (previous.state !== 'completed' || previous.cancelRequested)) {
        this.store.internalWrite(`assistant:queue:${item.id}`, { ...item, revision: item.revision + 1, automatic: false, autoError: 'The previous reply stopped. Review this message before continuing.', updatedAt: now() });
        continue;
      }
      try { this.runQueued(item.deviceId, { requestId: item.autoRequestId, epoch: item.epoch, queueId: item.id, expectedRevision: item.revision }); }
      catch (reason) {
        const current = this.queued(item.id);
        if (current.state === 'paused' && current.revision === item.revision) this.store.internalWrite(`assistant:queue:${item.id}`, { ...current, revision: current.revision + 1, automatic: false, autoError: reason instanceof Error ? reason.message : 'Review this queued message before continuing.', updatedAt: now() });
      }
    }
  }
  private unconfirmedCompletion(operation: AssistantOperation) {
    this.pendingCompletions.delete(operation.id);
    if (!terminal.has(operation.state)) this.saveOperation({ ...operation, state: 'unknown', error: 'OpenClaw has not confirmed that this reply finished. Check its status before continuing; the original input is kept.' });
  }
  private awaitCompletionReceipt(operation: AssistantOperation) {
    if (!this.gateway.status().methods.includes('agent.wait')) return false;
    // A native text segment can publish "final" before the turn's tools finish.
    // Only the receipt for this exact run/session can release follow-up work.
    this.saveOperation({ ...operation, state: 'running' });
    if (!this.pendingCompletions.has(operation.id)) this.pendingCompletions.set(operation.id, { nextCheck: 0, lastActive: Date.now() });
    return true;
  }
  setVoiceGuard(guard: (conversationId: string) => boolean) { this.voiceBusy = guard; }
  captureVoiceTarget(id: string, revision: number, projectRevision: number): VoiceTarget {
    const conversation = this.conversation(id);
    this.assertConnection(conversation);
    if (conversation.revision !== revision || conversation.archived || conversation.state !== 'ready' || conversation.pendingSettings || !conversation.nativeId) throw new Fault(409, 'conversation_changed', 'Review the current conversation before starting voice.');
    if (this.operations().some(op => op.conversationId === id && !terminal.has(op.state))) throw new Fault(409, 'run_unsettled', 'Settle the current Assistant reply before starting voice.');
    const project = conversation.projectId ? this.store.readEntity('project', conversation.projectId) : undefined;
    if ((project?.revision ?? 0) !== projectRevision || (conversation.projectId && !project)) throw new Fault(409, 'project_changed', 'Review the current Project before starting voice.');
    const refinement = conversation.refineSource;
    const output = refinement ? this.outputs().find(value => value.id === refinement.outputId && value.version === refinement.version && value.file?.sha256 === refinement.sha256 && value.state === 'ready') : undefined;
    if (refinement && !output?.file) throw new Fault(409, 'voice_refinement_missing', 'The original refinement file is unavailable. Review the saved output before starting voice.');
    const memory = this.memory.capture(conversation.projectId);
    return { ...(memory ? { memory } : {}), conversation: { ...conversation, nativeId: conversation.nativeId }, project: project ? { id: project.id, revision: project.revision, name: project.value.name, purpose: project.value.purpose, ...(project.value.instructions ? { instructions: project.value.instructions } : {}), ...(project.value.workspace ? { workspace: conversation.workspace ?? project.value.workspace } : {}), ...(project.value.attachments?.length ? { attachments: project.value.attachments } : {}) } : null, ...(output?.file ? { refineFile: output.file } : {}) };
  }
  conversations() { return this.store.internalList<Conversation>('assistant:conversation:').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  operations() { return this.store.internalList<AssistantOperation>('assistant:operation:').sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  outputs() { return this.store.internalList<AssistantOutput>('assistant:output:').sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  private outputParent(conversation: Conversation, message: ConversationMessage) {
    const operations = this.operations();
    if (conversation.refineSource) {
      // Media tools can append their final attachment asynchronously without a
      // runId. The explicitly created refinement branch owns its version lineage;
      // require an admitted, completed submission of that exact source first.
      if (!operations.some(op => op.conversationId === conversation.id && op.nativeId === conversation.nativeId && op.nativeRunId && op.state === 'completed' && canonical(op.context.refineSource) === canonical(conversation.refineSource))) throw new Fault(409, 'refinement_unfinished', 'Finish the refinement with its original source before saving a new version.');
      return this.outputs().find(o => o.id === conversation.refineSource!.outputId);
    }
    const run = message.runId ? operations.find(op => op.nativeRunId === message.runId) : undefined;
    return run?.context.refineSource ? this.outputs().find(o => o.id === run.context.refineSource!.outputId) : undefined;
  }
  saveOutput(device: string, raw: unknown) {
    const input = saveOutputSchema.parse(raw);
    const admitted = this.store.admit(device, input, { type: 'assistant.output', ...input }, () => {
      const conversation = this.conversation(input.conversationId);
      const history = this.cachedHistory(conversation.id);
      if (conversation.nativeId !== input.nativeId || history?.nativeId !== input.nativeId) throw new Fault(409, 'output_source_changed', 'Load the original conversation before saving this output.');
      const message = history.messages.find(m => m.id === input.messageId && m.role === 'assistant' && m.textHash === input.messageHash);
      if (!message || !message.text.trim()) throw new Fault(409, 'output_source_changed', 'This exact reply is no longer in the loaded history. Open its source again.');
      if (message.runId && this.operations().some(op => op.nativeRunId === message.runId && !terminal.has(op.state))) throw new Fault(409, 'output_unfinished', 'Wait for the reply to finish before saving it as an output.');
      const parent = this.outputParent(conversation, message);
      const output: AssistantOutput = { id: randomUUID(), version: parent ? parent.version + 1 : 1, ...(parent ? { parentOutputId: parent.id } : {}), conversationId: conversation.id, projectId: conversation.projectId, createdAt: now(), nativeId: input.nativeId, messageId: message.id, messageHash: message.textHash, runId: message.runId, text: message.text, name: input.name.replace(/[\x00-\x1f/\\]/g, '_').replace(/\.md$/i, '') + '.md', uploadRequestId: randomUUID(), state: 'prepared' };
      return this.store.internalWrite(`assistant:output:${output.id}`, output);
    });
    const original = this.store.internalRead<AssistantOutput>(`assistant:output:${admitted.value.id}`)!;
    if (original.state === 'ready') return original;
    // Stable upload receipts recover a crash before the output link is recorded.
    const file = this.store.upload(device, original.uploadRequestId, input.epoch, original.name, Buffer.from(original.text, 'utf8').toString('base64'));
    return this.store.internalWrite(`assistant:output:${original.id}`, { ...original, file, state: 'ready' as const });
  }
  private artifactReference(input: { conversationId: string; nativeId: string; messageId: string; messageHash: string; artifactId: string }, history = this.cachedHistory(input.conversationId)) {
    const conversation = this.conversation(input.conversationId);
    if (conversation.nativeId !== input.nativeId || history?.nativeId !== input.nativeId) throw new Fault(409, 'output_source_changed', 'Load this output’s original conversation before continuing.');
    const message = history.messages.find(m => m.id === input.messageId && m.role === 'assistant' && m.textHash === input.messageHash);
    const reference = message?.attachments.find(a => a.artifactId === input.artifactId);
    if (!message || !reference) throw new Fault(409, 'output_source_changed', 'This exact output is no longer in the loaded conversation.');
    return { conversation, message, reference };
  }
  async readArtifact(raw: unknown, retainedReference?: MessageAttachment) {
    const input = artifactSourceSchema.parse(raw);
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Review this output after workspace recovery.');
    const original = this.artifactReference(input);
    if (retainedReference && canonical(retainedReference) !== canonical(original.reference)) throw new Fault(409, 'output_source_changed', 'The saved output reference changed. Reopen its original version.');
    return this.artifactReader.read({ nativeKey: original.conversation.nativeKey, nativeId: input.nativeId, connectionGeneration: original.conversation.connectionGeneration, artifactId: input.artifactId }, async () => {
      if (this.closed || input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Review this output after workspace recovery.');
      const current = this.artifactReference(input, await this.history(input.conversationId));
      if (canonical(current.reference) !== canonical(original.reference)) throw new Fault(409, 'output_source_changed', 'The output reference changed while it was loading.');
    });
  }
  async saveArtifact(device: string, raw: unknown): Promise<AssistantOutput> {
    const input = saveArtifactSchema.parse(raw);
    const receipt = this.store.admit(device, input, { type: 'assistant.artifact', ...input }, () => {
      const { conversation, message, reference } = this.artifactReference(input);
      if (message.runId && this.operations().some(op => op.nativeRunId === message.runId && !terminal.has(op.state))) throw new Fault(409, 'output_unfinished', 'Wait for this output to finish before saving it.');
      const parent = this.outputParent(conversation, message);
      return this.store.internalWrite<AssistantOutput>(`assistant:output:${input.requestId}`, { id: input.requestId, version: parent ? parent.version + 1 : 1, ...(parent ? { parentOutputId: parent.id } : {}), conversationId: conversation.id, projectId: conversation.projectId, createdAt: now(), nativeId: input.nativeId, messageId: message.id, messageHash: message.textHash, runId: message.runId, text: '', name: input.name.replace(/[\x00-\x1f/\\]/g, '_'), uploadRequestId: randomUUID(), state: 'prepared', artifactId: input.artifactId, artifactReference: reference });
    });
    const original = this.store.internalRead<AssistantOutput>(`assistant:output:${receipt.value.id}`)!;
    if (original.state === 'ready') return original;
    const { requestId: _requestId, name: _name, ...source } = input;
    const content = await this.readArtifact(source, original.artifactReference);
    const latest = this.store.internalRead<AssistantOutput>(`assistant:output:${original.id}`)!;
    if (latest.contentSha256 && latest.contentSha256 !== content.sha256) throw new Fault(409, 'output_bytes_changed', 'The original output bytes changed. Its saved version was not replaced.');
    if (latest.state === 'ready') return latest;
    const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt', 'image/svg+xml': '.svg' } as Record<string, string>)[content.mimeType] ?? '';
    const name = /\.[a-z0-9]{1,8}$/i.test(original.name) ? original.name : original.name + extension;
    const prepared = { ...latest, name, contentSha256: content.sha256, mimeType: content.mimeType };
    this.store.internalWrite(`assistant:output:${original.id}`, prepared);
    const file = this.store.upload(device, original.uploadRequestId, input.epoch, name, content.bytes.toString('base64'));
    return this.store.internalWrite(`assistant:output:${original.id}`, { ...prepared, file, state: 'ready' as const });
  }
  state(): AssistantState { return { removals: this.removals.list(), connection: this.gateway.status(), conversations: this.conversations(), operations: this.operations(), queue: this.queue(), pins: this.pins.list(), memory: this.memory.state(), historyVersions: { ...this.historyVersions } }; }
  private saveConversation(value: Conversation) { if (this.closed || this.removals.removed(value.id) || this.removals.pending(value.id)) return value; return this.store.internalWrite(conversationKey(value.id), { ...value, updatedAt: now() }); }
  private saveOperation(value: AssistantOperation) {
    if (this.closed || this.removals.removed(value.conversationId)) return value;
    const current = this.store.internalRead<AssistantOperation>(operationKey(value.id));
    if (current && terminal.has(current.state)) {
      // History, abort and terminal receipts can return after a newer event.
      // Once settled, the original outcome and output are safe to retain or
      // retry; a late response must never make that execution active again.
      if (value.state !== current.state) return current;
      value = { ...value, text: current.text, error: current.error,
        effectiveModel: current.effectiveModel ?? value.effectiveModel,
        nativeTurnId: current.nativeTurnId ?? value.nativeTurnId, updatedAt: current.updatedAt };
    }
    if (terminal.has(value.state) || value.state === 'unknown') value = { ...value, ...(value.tools ? { tools: value.tools.map(tool => tool.state === 'running' ? { ...tool, state: 'unknown' as const } : tool) } : {}) };
    if (current && terminal.has(current.state) && canonical(value) === canonical(current)) return current;
    return this.store.internalWrite(operationKey(value.id), { ...value, updatedAt: now() });
  }
  private conversation(id: string): Conversation {
    this.removals.assertAvailable(id);
    const value = this.store.internalRead<Conversation>(conversationKey(id));
    if (!value) throw new Fault(404, 'conversation_missing', 'This conversation is unavailable.');
    return value;
  }
  private operation(id: string): AssistantOperation {
    const value = this.store.internalRead<AssistantOperation>(operationKey(id));
    if (!value) throw new Fault(404, 'operation_missing', 'This operation is unavailable.');
    return value;
  }
  private assertConnection(conversation?: Conversation, write = true) {
    if (conversation) this.removals.assertAvailable(conversation.id);
    const status = this.gateway.status();
    if (status.state !== 'ready') throw new Fault(503, 'gateway_disconnected', 'Connect OpenClaw before continuing. Saved work is kept.');
    if (!status.grantedScopes.includes(write ? 'operator.write' : 'operator.read')) throw new Fault(403, 'gateway_scope', write ? 'This OpenClaw connection is read-only.' : 'This OpenClaw connection cannot read conversation history.');
    if (conversation && status.generation !== conversation.connectionGeneration) throw new Fault(409, 'gateway_changed', 'This conversation belongs to a different Gateway. Reconnect its original host.');
    return status;
  }
  private assertTeamCheckout(folder:string|undefined, teamId?:string) {
    if(folder && this.store.internalList<{id:string;folder:string;state:string;epoch:string}>('team:run:').some(team=>team.epoch===this.store.epoch && team.folder===folder && team.id!==teamId && ['running','stopping'].includes(team.state)))throw new Fault(409,'team_checkout_busy','The team is working in this checkout. Pause the workflow before starting another coding task there.');
  }
  async create(device: string, raw: unknown, teamId?:string): Promise<Conversation> {
    const input = createConversationSchema.parse(raw);
    const status = this.assertConnection();
    const admitted = this.store.admit(device, input, { type: 'conversation.create', ...input }, () => {
      const project = input.projectId ? this.store.readEntity('project', input.projectId) : undefined;
      this.assertTeamCheckout(project?.value.workspace?.folder,teamId);
      if (input.projectId && !project) throw new Fault(409, 'missing_project', 'The selected Project is unavailable.');
      if (project && assistantSpace(project.value) !== assistantSpace(input)) throw new Fault(409, 'project_space', 'Choose a Project in this space.');
      if (input.refineSource) {
        const source = this.outputs().find(o => o.id === input.refineSource!.outputId);
        if (!source || source.state !== 'ready' || source.version !== input.refineSource.version || source.file?.sha256 !== input.refineSource.sha256 || source.projectId !== input.projectId) throw new Fault(409, 'refine_source_changed', 'Open the exact saved output version before starting its refinement.');
      }
      if (project?.value.workspace && status.url && !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(status.url).hostname)) throw new Fault(409, 'work_host', 'Work folders require the Assistant running on this workspace host.');
      const id = randomUUID();
      const titles = new Set(this.conversations().filter(c => assistantSpace(c) === assistantSpace(input)).map(c => c.title));
      let title = input.title;
      for (let number = 2; titles.has(title); number++) { const suffix = ` (${number})`; title = input.title.slice(0, 150 - suffix.length) + suffix; }
      return this.saveConversation({ id, revision: 1, space: assistantSpace(input), ...(project?.value.workspace ? { workspace: structuredClone(project.value.workspace) } : {}), title, ...(input.autoTitle ? { autoTitle: true } : {}), projectId: input.projectId, archived: false, model: input.model ?? null, thinking: input.thinking ?? null, fastMode: input.fastMode ?? null, permissionMode: input.permissionMode ?? 'read-only', ...(input.refineSource ? { refineSource: input.refineSource } : {}), createdAt: now(), updatedAt: now(), connectionGeneration: status.generation!, nativeKey: input.autoTitle ? `agent:main:dashboard:e3-${id}` : `agent:main:e3:${id}`, nativeId: null, state: 'creating' });
    });
    const original = this.conversation(admitted.value.id);
    if (!admitted.fresh) return original;
    try {
      const result = await ((original.permissionMode === 'full' || original.workspace) && this.accessControl ? this.accessControl : this.gateway).request<{ key: string; sessionId?: string; runStarted?: boolean; entry?: Record<string, unknown>; worktree?: { path: string; branch: string } }>('sessions.create', { key: original.nativeKey, idempotencyKey: input.requestId, ...(original.workspace ? { cwd: original.workspace.folder, worktree: original.workspace.environment === 'worktree' } : {}), ...(!original.autoTitle ? { label: original.title } : {}), ...(original.model ? { model: original.model } : {}), ...(original.thinking ? { thinkingLevel: original.thinking } : {}), ...(original.fastMode != null ? { fastMode: original.fastMode } : {}), permissionMode: original.permissionMode ?? 'read-only', emitCommandHooks: false });
      if (!result.key || !result.sessionId || result.runStarted) throw new Error('Unexpected native session result');
      if (this.closed) return original;
      this.assertConnection(original);
      const actual = object(result.entry);
      const pending = original.permissionMode === 'full' && (actual.sessionId !== result.sessionId || actual.permissionMode !== 'full' || actual.permissionModePending === true);
      if (pending) this.store.internalWrite(`assistant:edit:${input.requestId}`, { conversationId: original.id, state: 'prepared' });
      return this.saveConversation({ ...original, nativeKey: result.key, nativeId: result.sessionId, ...(original.workspace ? { workspace: { ...original.workspace, path: result.worktree?.path ?? original.workspace.folder, ...(result.worktree?.branch ? { branch: result.worktree.branch } : {}) } } : {}), state: 'ready', ...(pending ? { pendingSettings: { requestId: input.requestId, permissionMode: 'full' as const } } : {}) });
    } catch (error) {
      const worktreeSpace = original.workspace?.environment === 'worktree' && error instanceof GatewayClientRequestError && error.gatewayCode === 'UNAVAILABLE' && error.message.startsWith('Insufficient disk space near ');
      const notSent = error instanceof Fault && ['access_not_sent', 'response_not_sent'].includes(error.code);
      const rejected = worktreeSpace || notSent || error instanceof GatewayClientRequestError && ['INVALID_REQUEST', 'FORBIDDEN'].includes(error.gatewayCode);
      return this.saveConversation({ ...original, state: rejected ? 'failed' : 'unknown', error: worktreeSpace ? 'Not enough free disk space for a separate Git worktree. Use a Local Project or free space before starting again.' : notSent ? error.message : rejected ? 'OpenClaw rejected conversation setup. The draft is kept; review the name and access before starting another chat.' : 'OpenClaw has not confirmed session creation. The original identity is retained; use Check status.' });
    }
  }
  async fork(device: string, raw: unknown): Promise<Conversation> {
    const input = forkConversationSchema.parse(raw), source = this.conversation(input.conversationId);
    const status = this.assertConnection(source);
    if (!status.methods.includes('sessions.fork')) throw new Fault(409, 'fork_unavailable', 'This runtime does not support conversation branches.');
    const receipt = this.store.admit(device, input, { type: 'conversation.fork', ...input }, () => {
      if (source.revision !== input.expectedRevision || source.nativeId !== input.nativeId || source.deleted || source.pendingSettings || source.state !== 'ready') throw new Fault(409, 'conversation_changed', 'The source conversation changed. Reopen the message.');
      if (this.voiceBusy(source.id) || this.operations().some(op => op.conversationId === source.id && !terminal.has(op.state))) throw new Fault(409, 'run_unsettled', 'Finish the current reply before branching or revising it.');
      const message = this.cachedHistory(source.id)?.messages.find(m => m.id === input.messageId && m.textHash === input.messageHash);
      if (!message || input.purpose !== 'branch' && message.role !== 'user') throw new Fault(409, 'message_changed', 'Reload the exact source message before revising it.');
      const originalInput = this.operations().find(op => op.conversationId === source.id && op.nativeId === input.nativeId && matchesOwnerMessage(op, message.text));
      if (message.role === 'user' && message.attachments.length && !originalInput?.context.attachments.length) throw new Fault(409, 'source_files_unavailable', 'This message has files that cannot yet be carried into a revision. Keep the original and attach its files to a new message.');
      const id = randomUUID();
      const branch = this.saveConversation({ ...source, id, revision: 1, title: `${input.purpose === 'branch' ? 'Branch' : input.purpose === 'edit' ? 'Revision' : 'Retry'} · ${source.title}`.slice(0, 150), archived: false, deleted: false, pinned: false, unread: false, permissionMode: 'read-only', nativeKey: `agent:main:e3:${id}`, nativeId: null, state: 'creating', createdAt: now(), updatedAt: now(), refineSource: undefined, forkSource: { conversationId: source.id, nativeId: input.nativeId, messageId: input.messageId, messageHash: input.messageHash, purpose: input.purpose, requestId: input.requestId } });
      const text = input.purpose === 'branch' && message.role !== 'user' ? '' : input.text ?? message.authoredText ?? message.text;
      const draft = { space: assistantSpace(source), ...(originalInput?.context.workMode ? { workMode: originalInput.context.workMode } : {}), title: branch.title, conversationId: id, projectId: branch.projectId, text, attachments: input.purpose === 'branch' && message.role !== 'user' ? [] : originalInput?.context.attachments ?? [], ...(branch.refineSource ? { refineSource: branch.refineSource } : {}) };
      this.store.internalWrite(`assistant:fork-draft:${id}`, { requestId: randomUUID(), epoch: input.epoch, kind: 'draft', entityId: `draft:${device}:${id}`, expectedRevision: 0, payload: draft });
      return branch;
    });
    this.store.mutate(device, this.store.internalRead<import('../../packages/domain/contracts.js').Command>(`assistant:fork-draft:${receipt.value.id}`)!);
    if (!receipt.fresh) return this.conversation(receipt.value.id);
    let branch = receipt.value, dispatched = false;
    try {
      const history = await this.history(source.id, { messageId: input.messageId });
      if (!history.messages.some(m => m.id === input.messageId && m.textHash === input.messageHash) || this.conversation(source.id).revision !== input.expectedRevision) throw new Fault(409, 'message_changed', 'The source message changed before branching.');
      const sourceMessage = history.messages.find(m => m.id === input.messageId && m.textHash === input.messageHash)!;
      let cutEntryId: string | undefined = sourceMessage.role === 'user' ? sourceMessage.id : undefined;
      if (sourceMessage.role !== 'user') {
        if (sourceMessage.role !== 'assistant') throw new Fault(409, 'fork_source', 'Branch from a message or a completed reply.');
        const following = history.messages.slice(history.messages.indexOf(sourceMessage) + 1);
        const nextUser = following.find(m => m.role === 'user');
        if (nextUser && !following.slice(0, following.indexOf(nextUser)).some(m => m.role === 'assistant')) cutEntryId = nextUser.id;
        else {
          const head = await this.history(source.id), last = head.messages.findLast(m => m.role === 'assistant');
          if (last?.id !== sourceMessage.id || last.textHash !== sourceMessage.textHash || head.activeRunIds?.length !== 0) throw new Fault(409, 'fork_boundary', 'This runtime can branch before a user message or after a complete reply. Open the next user message to branch from this part of the conversation.');
        }
      }
      if (this.conversation(source.id).revision !== input.expectedRevision) throw new Fault(409, 'conversation_changed', 'The conversation changed before branching.');
      dispatched = true;
      // Native forks cut BEFORE a user message. Last completed replies use the
      // supported parent-transcript creation path, with no automatic message.
      const result = cutEntryId
        ? await this.gateway.request<{ sessionKey?: string }>('sessions.fork', { sessionKey: source.nativeKey, entryId: cutEntryId })
        : await this.gateway.request<{ key?: string; sessionKey?: string }>('sessions.create', { key: branch.nativeKey, idempotencyKey: input.requestId, displayName: branch.title, parentSessionKey: source.nativeKey, fork: true, forkFrom: 'last-completed', permissionMode: 'read-only', emitCommandHooks: false });
      const childKey = 'key' in result && typeof result.key === 'string' ? result.key : result.sessionKey;
      if (!childKey || childKey === source.nativeKey) throw Error('Branch identity is unconfirmed');
      this.assertConnection(source);
      branch = this.saveConversation({ ...branch, nativeKey: childKey, state: 'unknown' });
      const projection = await this.gateway.request<Record<string, any>>('chat.history', { sessionKey: branch.nativeKey, limit: 100, maxChars: 300000 });
      if (cutEntryId && Array.isArray(projection.messages) && projection.messages.some((m: any) => String(m.__openclaw?.id ?? m.id) === cutEntryId)) throw new Fault(409, 'fork_boundary_changed', 'The branch did not stop before the selected message. No new message was sent.');
      if (sourceMessage.role === 'assistant') {
        const last = Array.isArray(projection.messages) ? projection.messages.findLast((m: any) => m.role === 'assistant') : undefined;
        if (!last || String(last.__openclaw?.id ?? last.id) !== sourceMessage.id || digest(textOf(last)) !== sourceMessage.textHash) throw new Fault(409, 'fork_boundary_changed', 'The returned branch did not retain this exact reply as its last response. The original chat is kept; no new message was sent.');
      }
      const sessionId = projection.sessionId ?? projection.sessionInfo?.sessionId;
      if (typeof sessionId !== 'string' || sessionId === source.nativeId) throw Error('Branch session identity unavailable');
      branch = this.saveConversation({ ...branch, nativeId: sessionId });
      await this.gateway.request('sessions.patch', { key: branch.nativeKey, expectedSessionId: sessionId, permissionMode: 'read-only' });
      this.assertConnection(source);
      branch = this.saveConversation({ ...branch, state: 'ready', forkSource: { ...branch.forkSource!, resolved: true } });
      await this.history(branch.id);
      return this.conversation(branch.id);
    } catch (e) {
      return this.saveConversation({ ...this.conversation(branch.id), state: !dispatched || e instanceof GatewayClientRequestError ? 'failed' : 'unknown', error: e instanceof Fault ? e.message : e instanceof GatewayClientRequestError ? 'The runtime rejected this branch. The original chat and revised draft are kept.' : 'Branch creation is unconfirmed. Its revised draft is kept; the original chat was not replaced.' });
    }
  }
  search(raw: unknown) { return new ConversationSearch(this.store, this.gateway, () => this.conversations()).search(raw); }
  async browse(raw: unknown): Promise<ConversationHistory> {
    const input = browseConversationSchema.parse(raw);
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Reopen the source from a current search.');
    const current = this.conversation(input.conversationId);
    if (!input.messageId && current.nativeId !== input.nativeId) throw new Fault(409, 'session_replaced', 'Open the exact matching message to read retained older history.');
    let history: ConversationHistory;
    try { history = await this.readHistory(input.conversationId, { messageId: input.messageId, offset: input.offset, nativeId: input.nativeId, readOnly: true }); }
    catch (error) {
      this.removals.assertAvailable(input.conversationId);
      const latest = this.conversation(input.conversationId);
      const saved = input.nativeId === latest.nativeId ? this.savedHistory().read(latest, { messageId: input.messageId, offset: input.offset }) : undefined;
      if (!saved) throw error;
      history = saved;
    }
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed while this source was loading.');
    if (input.messageId && !history.messages.some(m => m.id === input.messageId && (!input.role || m.role === input.role))) throw new Fault(404, 'message_missing', 'This exact message is no longer available. Search again; no different message was opened.');
    if (input.messageHash && !history.messages.some(m => m.id === input.messageId && (!input.role || m.role === input.role) && m.textHash === input.messageHash)) throw new Fault(409, 'message_changed', 'This source message has changed. The original saved output remains available in Content.');
    return history;
  }
  async history(id: string, options: { offset?: number; messageId?: string; resume?: boolean } = {}): Promise<ConversationHistory> {
    const key = canonical({ id, ...options });
    const pending = this.historyReads.get(key);
    if (pending) return pending;
    const read = this.readHistory(id, options).finally(() => this.historyReads.delete(key));
    this.historyReads.set(key, read);
    return read;
  }
  async historyForReading(id: string, options: { offset?: number; messageId?: string; resume?: boolean } = {}) {
    try { return await this.history(id, options); }
    catch (error) {
      this.removals.assertAvailable(id);
      const saved = this.savedHistory().read(this.conversation(id), options);
      if (saved) return saved;
      throw error;
    }
  }
  async captureSavedHistories() {
    if (this.store.recoveryEffectsPaused || this.gateway.status().state !== 'ready') return;
    const generation = this.gateway.status().generation;
    await this.savedHistory().capture(this.conversations().filter(c => c.connectionGeneration === generation), (id, offset) => this.readHistory(id, { offset, readOnly: true }));
  }
  retainedTranscriptReview(id: string) {
    this.removals.assertAvailable(id);
    return this.savedHistory().review(this.conversation(id));
  }
  exportRetainedTranscript(device: string, input: unknown) {
    return this.savedHistory().export(device, input, id => { this.removals.assertAvailable(id); return this.conversation(id); });
  }
  private async readHistory(id: string, options: { offset?: number; messageId?: string; nativeId?: string; readOnly?: boolean; resume?: boolean }): Promise<ConversationHistory> {
    let conversation = this.conversation(id);
    if (conversation.forkSource && !conversation.forkSource.resolved) throw new Fault(409, 'fork_unconfirmed', 'The runtime has not confirmed this branch identity. The original chat and revised draft are kept.');
    this.assertConnection(conversation, false);
    if (!this.subscribed.has(conversation.nativeKey) && this.gateway.status().methods.includes('sessions.messages.subscribe')) {
      await this.gateway.request('sessions.messages.subscribe', { key: conversation.nativeKey });
      this.assertConnection(conversation, false);
      this.subscribed.add(conversation.nativeKey);
    }
    // The public API permits sessionId only for an exact message anchor.
    // Ordinary history reads verify the returned incarnation before use.
    let result = await this.gateway.request<Record<string, any>>('chat.history', { sessionKey: conversation.nativeKey, ...(options.messageId && conversation.nativeId ? { sessionId: options.nativeId ?? conversation.nativeId } : {}), limit: 100, maxChars: 300000, ...(options.messageId ? { messageId: options.messageId } : {}), ...(options.offset !== undefined ? { offset: options.offset } : {}) });
    if (options.resume && options.messageId) result = await locateHistoryPosition(result, options.messageId, async offset => {
      this.assertConnection(conversation, false);
      const page = await this.gateway.request<Record<string, any>>('chat.history', { sessionKey: conversation.nativeKey, limit: 100, maxChars: 300000, offset });
      this.assertConnection(conversation, false); return page;
    });
    const nativeId = typeof result.sessionId === 'string' ? result.sessionId : typeof result.sessionInfo?.sessionId === 'string' ? result.sessionInfo.sessionId : null;
    if (!nativeId || ((options.nativeId ?? conversation.nativeId) && nativeId !== (options.nativeId ?? conversation.nativeId))) throw new Fault(409, 'session_replaced', 'The native conversation was replaced. Existing work is kept; open a new conversation.');
    if (this.closed) throw new Fault(503, 'service_closed', 'The workspace service is closing.');
    this.assertConnection(conversation, false);
    if (!options.readOnly && !conversation.nativeId) conversation = this.saveConversation({ ...conversation, nativeId, state: 'ready', error: undefined });
    let messages: ConversationMessage[] = (Array.isArray(result.messages) ? result.messages : []).map((raw: any, index: number) => {
      const message = object(raw), meta = object(message.__openclaw);
      return { id: String(meta.id ?? message.id ?? `projection:${index}:${digest(message).slice(0, 16)}`), sequence: Number.isInteger(meta.seq) ? meta.seq : undefined, role: message.role === 'toolResult' ? 'tool' : ['user', 'assistant', 'system', 'tool'].includes(message.role) ? message.role : 'system', ...(historyToolInfo(message) ? { toolInfo: historyToolInfo(message) } : {}), text: textOf(message), textHash: digest(textOf(message)), createdAt: typeof message.timestamp === 'string' ? message.timestamp : undefined, runId: typeof meta.runId === 'string' ? meta.runId : typeof message.runId === 'string' ? message.runId : undefined, attachments: (Array.isArray(message.content) ? message.content : []).filter((part: any) => typeof part?.artifactId === 'string' && part.artifactId.length <= 2000).map((part: any) => ({ artifactId: part.artifactId, name: String(part.fileName ?? part.filename ?? part.alt ?? 'Generated output').slice(0, 150), ...(typeof part.mimeType === 'string' ? { mimeType: part.mimeType } : {}), ...(typeof part.type === 'string' ? { type: part.type } : {}), ...(Number.isSafeInteger(part.sizeBytes) && part.sizeBytes >= 0 ? { size: part.sizeBytes } : {}) })) };
    });
    if (!options.readOnly) for (const operation of this.operations().filter(op => op.epoch === this.store.epoch && op.conversationId === id && op.nativeId === nativeId && op.connectionGeneration === conversation.connectionGeneration)) {
      let tools = operation.tools ?? [];
      for (const message of messages.filter(m => m.role === 'tool' && m.runId === operation.nativeRunId && m.toolInfo?.id)) {
        const prior = tools.find(tool => tool.id === message.toolInfo!.id);
        const tool = { ...prior, id: message.toolInfo!.id!, name: message.toolInfo!.name, sequence: prior?.sequence ?? 0, state: message.toolInfo!.state === 'failed' ? 'failed' as const : 'completed' as const, ...(message.text ? { output: message.text.slice(0, 16000), truncated: message.text.length > 16000 } : {}) };
        tools = prior ? tools.map(item => item.id === tool.id ? tool : item) : [...tools, tool].slice(-100);
      }
      if (canonical(tools) !== canonical(operation.tools ?? [])) this.saveOperation({ ...operation, tools });
    }
    const info = object(result.sessionInfo);
    messages = this.authoredMessages(conversation, nativeId, messages);
    const activeRunIds = Array.isArray(info.activeRunIds) ? info.activeRunIds.filter((id: unknown) => typeof id === 'string') : info.hasActiveRun === false ? [] : null;
    const inFlight = object(result.inFlightRun);
    const nativeSettings = { pinned: typeof info.pinned === 'boolean' ? info.pinned : undefined, unread: typeof info.unread === 'boolean' ? info.unread : undefined, title: typeof info.label === 'string' ? info.label : typeof info.displayName === 'string' ? info.displayName : undefined, archived: typeof info.archived === 'boolean' ? info.archived : undefined, model: typeof info.model === 'string' ? info.model.includes('/') ? info.model : `${info.modelProvider}/${info.model}` : undefined, thinking: typeof info.thinkingLevel === 'string' ? info.thinkingLevel : undefined, fastMode: typeof info.fastMode === 'boolean' || info.fastMode === 'auto' ? info.fastMode : null, permissionModePending: info.permissionModePending === true, permissionMode: ['read-only', 'guarded', 'workspace', 'full'].includes(info.permissionMode) ? info.permissionMode : undefined, lifecycleRevision: Number.isInteger(info.lifecycleRevision) ? info.lifecycleRevision : undefined };
    const history: ConversationHistory = { conversationId: id, nativeId, messages, hasMore: result.hasMore === true, ...(Number.isSafeInteger(result.offset) && result.offset >= 0 ? { offset: result.offset, hasNewer: result.offset > 0 } : !options.messageId ? { offset: options.offset ?? 0, hasNewer: (options.offset ?? 0) > 0 } : {}), ...(Number.isSafeInteger(result.totalMessages) && result.totalMessages >= 0 ? { totalMessages: result.totalMessages } : {}), ...(Number.isInteger(result.nextOffset) ? { nextOffset: result.nextOffset } : {}), activeRunIds, ...(typeof inFlight.runId === 'string' ? { inFlightRun: { runId: inFlight.runId, text: typeof inFlight.text === 'string' ? inFlight.text : '' } } : {}), ...(typeof info.routingContract === 'string' ? { routingContract: info.routingContract } : {}), ...(typeof result.leafEntryId === 'string' || result.leafEntryId === null ? { leafEntryId: result.leafEntryId } : {}) };
    const currentTitle = this.conversation(id);
    // Voice captures this title with its conversation context. Defer automatic
    // naming until End so saving the first caption cannot invalidate that call.
    if (!options.readOnly && currentTitle.autoTitle && !currentTitle.pendingSettings && !this.voiceBusy(id)) {
      const first = messages.find(message => message.role === 'user');
      const title = nativeSettings.title?.trim() || (!currentTitle.autoTitleSeeded && first ? initialConversationTitle(first.authoredText ?? first.text) : undefined);
      if (title) this.saveConversation({ ...currentTitle, title: title.slice(0, 150), autoTitleSeeded: true });
    }
    const complete = { ...history, nativeSettings, leafEntryId: history.leafEntryId ?? (typeof info.activeLeafEntryId === 'string' ? info.activeLeafEntryId : undefined) };
    if (!options.readOnly) this.store.internalWrite(`assistant:history:${id}`, complete);
    return complete;
  }
  async workChanges(id: string) {
    const conversation = this.conversation(id); this.assertConnection(conversation, false);
    if (assistantSpace(conversation) !== 'work' || !conversation.workspace || !conversation.nativeId) throw new Fault(400, 'work_project_required', 'Open a task in a Work Project to review its changes.');
    const check = async () => {
      const description = await this.gateway.request<{ session?: { sessionId?: string } }>('sessions.describe', { key: conversation.nativeKey });
      const current = this.conversation(id); this.assertConnection(current, false);
      if (description.session?.sessionId !== conversation.nativeId || current.nativeId !== conversation.nativeId || current.revision !== conversation.revision) throw new Fault(409, 'work_session_changed', 'The original working session changed. Reopen this task.');
    };
    await check();
    const result = workProjectDiffSchema.parse(await this.gateway.request('sessions.diff', { sessionKey: conversation.nativeKey, scope: 'all' }));
    await check();
    if (result.sessionKey !== conversation.nativeKey) throw new Fault(409, 'work_session_changed', 'The change report belongs to another session.');
    return result;
  }
  private authoredMessages(conversation: Conversation, nativeId: string, messages: ConversationMessage[]) {
    const lineage = new Map([[conversation.id, nativeId]]), known = this.conversations();
    let ancestor = conversation;
    while (ancestor.forkSource?.resolved && lineage.size < 100) {
      const source = ancestor.forkSource, parent = known.find(c => c.id === source.conversationId && c.nativeId === source.nativeId && c.connectionGeneration === conversation.connectionGeneration);
      if (!parent || lineage.has(parent.id)) break;
      lineage.set(parent.id, source.nativeId); ancestor = parent;
    }
    const authored = new Map(this.operations().filter(op => lineage.get(op.conversationId) === op.nativeId && op.connectionGeneration === conversation.connectionGeneration).map(op => [ownerMessage(op).trim(), op.input]));
    // Never parse user-supplied "Owner message:" headings or remove arbitrary
    // text. A captured operation in this exact lineage must match the envelope.
    return messages.map(message => message.role === 'user' && authored.has(message.text.trim())
      ? { ...message, authoredText: authored.get(message.text.trim()) } : message);
  }
  private savedHistory() {
    return new SavedHistory(this.store, (conversation, history) => ({ ...history, messages: this.authoredMessages(conversation, history.nativeId, history.messages) }));
  }
  cachedHistory(id: string) {
    const conversation = this.conversation(id), history = this.store.internalRead<ConversationHistory>(`assistant:history:${id}`);
    return history ? { ...history, messages: this.authoredMessages(conversation, history.nativeId, history.messages) } : undefined;
  }
  private context(device: string, draftId: string, draftRevision: number, projectRevision: number, conversation: Conversation, includeProjectFiles = true) {
    if (draftId !== spaceDraftId(device, assistantSpace(conversation)) && draftId !== `draft:${device}:${conversation.id}`) throw new Fault(403, 'draft_branch', 'Send only from your own conversation draft.');
    const draft = this.store.readEntity('draft', draftId);
    if (draft?.value.conversationId && draft.value.conversationId !== conversation.id || draft?.value.space !== undefined && assistantSpace(draft.value) !== assistantSpace(conversation)) throw new Fault(409, 'conversation_changed', 'The draft belongs to another conversation.');
    if (!draft || draft.revision !== draftRevision) throw new Fault(409, 'draft_changed', 'Save and review the current draft before sending.');
    if (!draft.value.text.trim() && !draft.value.attachments.length) throw new Fault(400, 'empty_message', 'Write a message or attach a file.');
    if (draft.value.projectId !== conversation.projectId) throw new Fault(409, 'project_changed', 'This draft belongs to a different Project. Start a conversation in that Project.');
    const project = conversation.projectId ? this.store.readEntity('project', conversation.projectId) : undefined;
    if ((project?.revision ?? 0) !== projectRevision || (conversation.projectId && !project)) throw new Fault(409, 'project_changed', 'Project context changed. Review it before sending.');
    if (conversation.refineSource && canonical(draft.value.refineSource) !== canonical(conversation.refineSource)) throw new Fault(409, 'refine_source_changed', 'This refinement must keep its original output version attached.');
    if (conversation.refineSource && !draft.value.text.trim()) throw new Fault(400, 'refinement_instructions', 'Describe what you would like to change in this output.');
    const files = [...new Map([...(includeProjectFiles ? project?.value.attachments ?? [] : []), ...draft.value.attachments].map(file => [file.id, file])).values()];
    if (files.length > 10) throw new Fault(409, 'attachment_limit', 'A message can include up to 10 files, including Project sources. Remove a draft attachment or update Project sources before sending. Your draft is kept.');
    const memory = this.memory.capture(conversation.projectId);
    const manifest = { brandVersion: 1 as const, computerControlGuidance, space: assistantSpace(conversation), planning: true as const, ...(draft.value.workMode === 'goal' ? { goalReporting: true as const } : {}), ...(conversation.autoTitle ? { messageVersion: 2 as const } : {}), ...(memory ? { memory } : {}), ...(draft.value.workMode && draft.value.workMode !== 'chat' ? { workMode: draft.value.workMode } : {}), ...(draft.value.refineSource ? { refineSource: draft.value.refineSource } : {}), project: project ? { id: project.id, revision: project.revision, name: project.value.name, purpose: project.value.purpose, ...(project.value.instructions ? { instructions: project.value.instructions } : {}), ...(project.value.workspace ? { workspace: conversation.workspace ?? project.value.workspace } : {}), ...(project.value.attachments?.length ? { attachments: project.value.attachments } : {}) } : null, attachments: files, draftId: draft.id, draftRevision };
    for (const attachment of manifest.attachments) if (canonical(this.store.blobMetadata(attachment.id)) !== canonical(attachment)) throw new Fault(409, 'attachment_changed', 'A required attachment changed or is missing.');
    return { input: draft.value.text, manifest: { ...manifest, digest: digest(manifest) } as ContextManifest };
  }
  submit(device: string, raw: unknown, steering = false, teamId?:string): AssistantOperation {
    const input = steering ? steerSchema.parse(raw) : submitSchema.parse(raw);
    const admitted = this.store.admit(device, input, { type: steering ? 'assistant.steer' : 'assistant.submit', ...input }, () => {
      const conversation = this.conversation(input.conversationId);
      this.assertTeamCheckout(conversation.workspace?.path??conversation.workspace?.folder,teamId);
      this.assertConnection(conversation);
      if (this.voiceBusy(conversation.id)) throw new Fault(409, 'voice_active', 'End the voice call before sending this draft. Your writing is kept.');
      if (conversation.revision !== input.conversationRevision || conversation.archived || conversation.state !== 'ready' || conversation.pendingSettings || !conversation.nativeId) throw new Fault(409, 'conversation_changed', 'Review the current conversation before sending.');
      const target = 'targetOperationId' in input && typeof input.targetOperationId === 'string' ? this.operation(input.targetOperationId) : undefined;
      if (target) {
        if (target.conversationId !== conversation.id || target.nativeId !== conversation.nativeId || target.connectionGeneration !== conversation.connectionGeneration || target.steerTarget || !target.nativeRunId || !['accepted', 'running'].includes(target.state) || target.cancelRequested) throw new Fault(409, 'steer_target_changed', 'That reply is no longer accepting direction. Your message remains in the draft.');
        if (this.operations().some(op => op.conversationId === conversation.id && op.steerTarget && !terminal.has(op.state))) throw new Fault(409, 'steer_unconfirmed', 'Check the previous direction before sending another.');
      } else if (this.operations().some(op => op.conversationId === conversation.id && !terminal.has(op.state))) throw new Fault(409, 'run_unsettled', 'Finish or reconcile the existing run before sending another message.');
      const context = this.context(device, input.draftId, input.draftRevision, input.projectRevision, conversation, !target);
      // Only the trusted workflow dispatcher can capture handoff authority. A
      // client-supplied draft or a later message cannot select arbitrary results.
      if (teamId) {
        const binding = this.store.internalRead<import('../../packages/domain/team-work.js').TeamConversationAccess>('team:conversation:' + conversation.id);
        if (!binding || binding.epoch !== this.store.epoch || binding.teamId !== teamId) throw new Fault(409, 'team_context_changed', 'The saved team context is unavailable.');
        const { digest: _digest, ...captured } = context.manifest;
        const manifest = { ...captured, teamHandoffs: { teamId, ids: [...(binding.handoffIds ?? [])] } };
        context.manifest = { ...manifest, digest: digest(manifest) };
      }
      if (target && canonical(context.manifest.project) !== canonical(target.context.project)) throw new Fault(409, 'steer_project_changed', 'Project context changed since this reply started. Queue your message to use the updated sources. Your draft is kept.');
      if (target && context.manifest.attachments.length) throw new Fault(409, 'steer_attachments', 'Queue messages with files so their attachments stay intact.');
      const operation: AssistantOperation = { id: randomUUID(), requestId: input.requestId, deviceId: device, epoch: input.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, connectionGeneration: conversation.connectionGeneration, nativeKey: conversation.nativeKey, nativeId: conversation.nativeId, nativeRunId: null, state: 'prepared', ...(target ? { steerTarget: target.id } : {}), input: context.input, context: context.manifest, model: conversation.model, thinking: conversation.thinking, fastMode: conversation.fastMode ?? null, createdAt: now(), updatedAt: now(), text: '', lastSequence: 0 };
      return this.saveOperation(operation);
    });
    if (admitted.fresh) void this.dispatch(admitted.value.id);
    return this.operation(admitted.value.id);
  }
  queue() { return this.store.internalList<QueuedMessage>('assistant:queue:').sort((a, b) => (a.position ?? Date.parse(a.createdAt)) - (b.position ?? Date.parse(b.createdAt)) || a.id.localeCompare(b.id)); }
  private queued(id: string) {
    const item = this.store.internalRead<QueuedMessage>(`assistant:queue:${id}`);
    if (!item) throw new Fault(404, 'queue_missing', 'This queued message is unavailable.');
    this.removals.assertAvailable(item.conversationId);
    return item;
  }
  enqueue(device: string, raw: unknown): QueuedMessage {
    const input = enqueueSchema.parse(raw);
    const admitted = this.store.admit(device, input, { type: 'assistant.queue', ...input }, () => {
      const conversation = this.conversation(input.conversationId);
      if (conversation.revision !== input.conversationRevision || conversation.archived || conversation.state !== 'ready' || !conversation.nativeId || conversation.pendingSettings) throw new Fault(409, 'conversation_changed', 'Review this conversation before queuing its message.');
      if (this.queue().filter(item => item.state === 'paused').length >= 50) throw new Fault(409, 'queue_full', 'The queue holds 50 paused messages. Keep or run an existing message before adding another.');
      const captured = this.context(device, input.draftId, input.draftRevision, input.projectRevision, conversation);
      const item: QueuedMessage = { id: input.requestId, revision: 1, deviceId: device, epoch: input.epoch, conversationId: conversation.id, nativeId: conversation.nativeId, connectionGeneration: conversation.connectionGeneration, input: captured.input, context: captured.manifest, model: conversation.model, thinking: conversation.thinking, fastMode: conversation.fastMode ?? null, state: 'paused', ...(input.automatic ? { automatic: true, autoRequestId: randomUUID() } : {}), position: Math.max(Date.now(), ...this.queue().map(q => (q.position ?? Date.parse(q.createdAt)) + 1)), createdAt: now(), updatedAt: now() };
      return this.store.internalWrite(`assistant:queue:${item.id}`, item);
    });
    return this.queued(admitted.value.id);
  }
  setQueueState(device: string, raw: unknown): QueuedMessage {
    const input = queueStateSchema.parse(raw);
    const admitted = this.store.admit(device, input, { type: 'assistant.queue-state', ...input }, () => {
      const item = this.queued(input.queueId);
      if (item.revision !== input.expectedRevision || item.state === 'submitted') throw new Fault(409, 'queue_changed', 'This queue item changed. Its original message is kept.');
      if (input.state === 'paused' && this.queue().filter(q => q.state === 'paused').length >= 50) throw new Fault(409, 'queue_full', 'The queue holds 50 paused messages.');
      return this.store.internalWrite(`assistant:queue:${item.id}`, { ...item, revision: item.revision + 1, state: input.state, automatic: false, autoError: undefined, updatedAt: now() });
    });
    return this.queued(admitted.value.id);
  }
  editQueued(device: string, raw: unknown): QueuedMessage {
    const input = queueEditSchema.parse(raw);
    const receipt = this.store.admit(device, input, { type: 'assistant.queue-edit', ...input }, () => {
      const item = this.queued(input.queueId);
      if (item.epoch !== input.epoch || item.revision !== input.expectedRevision || item.state !== 'paused') throw new Fault(409, 'queue_changed', 'This queued message changed. Your revision is kept for review.');
      if (!input.input.trim() && (!item.context.attachments.length || item.context.refineSource)) throw new Fault(400, 'empty_message', 'Write a message before saving this revision.');
      return this.store.internalWrite(`assistant:queue:${item.id}`, { ...item, input: input.input, revision: item.revision + 1, updatedAt: now() });
    });
    return this.queued(receipt.value.id);
  }
  reorderQueue(device: string, raw: unknown) {
    const input = queueOrderSchema.parse(raw);
    this.store.admit(device, input, { type: 'assistant.queue-order', ...input }, () => {
      this.conversation(input.conversationId);
      const current = this.queue().filter(q => q.conversationId === input.conversationId && q.state === 'paused');
      if (new Set(input.items.map(i => i.id)).size !== current.length || input.items.length !== current.length || current.some(q => q.epoch !== input.epoch || !input.items.some(i => i.id === q.id && i.revision === q.revision))) throw new Fault(409, 'queue_changed', 'The queue changed. Review its current order.');
      const base = Date.now();
      for (const [index, identity] of input.items.entries()) { const item = current.find(q => q.id === identity.id)!; this.store.internalWrite(`assistant:queue:${item.id}`, { ...item, position: base + index, revision: item.revision + 1, updatedAt: now() }); }
      return { conversationId: input.conversationId };
    });
    return this.queue().filter(q => q.conversationId === input.conversationId);
  }
  async readAccess(id: string) {
    const conversation = this.conversation(id); this.assertConnection(conversation, false);
    const result = await this.gateway.request<{ sessions?: Record<string, unknown>[] }>('sessions.list', { search: conversation.nativeKey, limit: 200, archived: 'all' });
    this.assertConnection(conversation, false);
    const row = result.sessions?.find(s => s.key === conversation.nativeKey && s.sessionId === conversation.nativeId);
    if (!row || this.conversation(id).nativeId !== conversation.nativeId || !['read-only', 'guarded', 'workspace', 'full'].includes(String(row.permissionMode))) throw new Fault(409, 'access_unverified', 'The current access policy could not be verified.');
    return { conversationId: id, nativeId: conversation.nativeId, mode: row.permissionMode as string, pending: row.permissionModePending === true };
  }
  runQueued(device: string, raw: unknown): AssistantOperation {
    const input = queueActionSchema.parse(raw);
    const admitted = this.store.admit(device, input, { type: 'assistant.queue-run', ...input }, () => {
      const item = this.queued(input.queueId), conversation = this.conversation(item.conversationId);
      this.assertConnection(conversation);
      if (item.state !== 'paused' || item.revision !== input.expectedRevision) throw new Fault(409, 'queue_changed', 'This message already changed or has a submission. Check its original outcome.');
      if (item.epoch !== input.epoch || item.nativeId !== conversation.nativeId || item.connectionGeneration !== conversation.connectionGeneration || conversation.archived || conversation.pendingSettings || conversation.state !== 'ready' || conversation.model !== item.model || conversation.thinking !== item.thinking || (conversation.fastMode ?? null) !== (item.fastMode ?? null)) throw new Fault(409, 'queue_target_changed', 'The queued conversation or model changed. Copy the message to your draft to review it.');
      if (this.voiceBusy(conversation.id)) throw new Fault(409, 'voice_active', 'End the voice call before running this queued message.');
      if (this.operations().some(op => op.conversationId === conversation.id && !terminal.has(op.state))) throw new Fault(409, 'run_unsettled', 'Finish or reconcile the existing run first. This message stays paused.');
      const project = item.context.project;
      if (conversation.projectId !== (project?.id ?? null) || (project && this.store.readEntity('project', project.id)?.revision !== project.revision)) throw new Fault(409, 'project_changed', 'The queued Project context changed. Copy the message to your draft to review it.');
      for (const file of item.context.attachments) if (canonical(this.store.blobMetadata(file.id)) !== canonical(file)) throw new Fault(409, 'attachment_changed', 'A queued attachment is unavailable. The original message is kept.');
      const operation: AssistantOperation = { id: randomUUID(), requestId: input.requestId, deviceId: device, epoch: input.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, connectionGeneration: conversation.connectionGeneration, nativeKey: conversation.nativeKey, nativeId: item.nativeId, nativeRunId: null, state: 'prepared', input: item.input, context: item.context, model: item.model, thinking: item.thinking, fastMode: item.fastMode ?? null, createdAt: now(), updatedAt: now(), text: '', lastSequence: 0 };
      this.saveOperation(operation);
      this.store.internalWrite(`assistant:queue:${item.id}`, { ...item, revision: item.revision + 1, state: 'submitted', operationId: operation.id, updatedAt: now() });
      return operation;
    });
    if (admitted.fresh) void this.dispatch(admitted.value.id);
    return this.operation(admitted.value.id);
  }
  private attachment(attachment: Attachment) {
    const file = this.store.download(attachment.id);
    const ext = attachment.name.split('.').pop()?.toLowerCase();
    const mime: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', json: 'application/json', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', csv: 'text/csv' };
    if (!ext || !mime[ext]) throw new Fault(400, 'attachment_type', 'This file type cannot yet be supplied to OpenClaw. The saved original is kept.');
    const policy = this.gateway.attachmentPolicy(), isImage = mime[ext].startsWith('image/');
    const limit = isImage ? policy.maxImageBytes : policy.maxBytes;
    if (limit && file.bytes.length > limit) throw new Fault(413, 'gateway_attachment_limit', 'An attachment exceeds this Gateway’s current limit.');
    return { type: isImage ? 'image' : 'file', fileName: attachment.name, mimeType: mime[ext], sizeBytes: file.bytes.length, content: file.bytes.toString('base64') };
  }
  private async dispatch(id: string) {
    let operation = this.operation(id);
    try {
      const conversation = this.conversation(operation.conversationId);
      this.assertConnection(conversation);
      await this.prepareApprovalReview(conversation.id);
      const history = await this.history(conversation.id);
      if (this.closed) return;
      const target = operation.steerTarget ? this.operation(operation.steerTarget) : undefined;
      if (target) {
        // Native embedded runtimes can omit the complete active-run list while
        // still identifying the current visible reply in inFlightRun. Match
        // that exact target; never interpret an omitted list as an idle chat.
        const matchingRun = history.activeRunIds === null
          ? history.inFlightRun?.runId === target.nativeRunId
          : history.activeRunIds.length === 1 && history.activeRunIds[0] === target.nativeRunId;
        if (!matchingRun || history.inFlightRun && history.inFlightRun.runId !== target.nativeRunId || terminal.has(target.state) || target.cancelRequested) throw new Fault(409, 'steer_target_changed', 'The original reply changed before direction could be delivered. Your input is kept.');
      } else {
        if (history.activeRunIds === null) throw new Fault(409, 'native_activity_unknown', 'OpenClaw has not supplied exact activity for this conversation. Refresh before sending.');
        if (history.inFlightRun || history.activeRunIds.length) throw new Fault(409, 'native_run_active', 'OpenClaw already has an active run in this conversation.');
      }
      // No await between these final admission fences and marking the send boundary.
      const current = this.conversation(conversation.id);
      if (operation.epoch !== this.store.epoch || current.archived || current.pendingSettings || current.revision !== operation.conversationRevision || current.nativeId !== operation.nativeId) throw new Fault(409, 'admission_changed', 'Conversation changed before dispatch. The saved input is kept.');
      if (operation.context.project && this.store.readEntity('project', operation.context.project.id)?.revision !== operation.context.project.revision) throw new Fault(409, 'project_changed', 'Project changed before dispatch. Review the kept input.');
      const message = ownerMessage(operation);
      // A non-command envelope keeps a leading slash in authored content from
      // becoming a Gateway command without requiring administrative provenance.
      const goal = operation.context.workMode === 'goal';
      if (goal && target) throw new Fault(409, 'goal_steering', 'Start a Goal after this reply finishes. Your objective is kept.');
      const params = { ...(goal ? { intent: { kind: 'session-goal-start', version: 1, issuedAtMs: Date.parse(operation.createdAt) } } : {}), sessionKey: operation.nativeKey, sessionId: operation.nativeId, message, ...(target ? { queueMode: 'steer' } : {}), idempotencyKey: operation.requestId, deliver: false, attachments: operation.context.attachments.map(a => this.attachment(a)), ...(!goal && operation.thinking ? { thinking: operation.thinking } : {}), ...(!goal && operation.fastMode != null ? { fastMode: operation.fastMode } : {}), ...(history.routingContract ? { expectedSessionRoutingContract: history.routingContract } : {}), ...(history.leafEntryId !== undefined ? { expectedLeafEntryId: history.leafEntryId } : {}) };
      const ceiling = this.gateway.attachmentPolicy().maxPayload;
      if (ceiling && Buffer.byteLength(JSON.stringify(params)) + 1024 > ceiling) throw new Fault(413, 'gateway_payload_limit', 'This message exceeds the Gateway limit. Its input and files are kept.');
      operation = this.saveOperation({ ...operation, state: 'dispatching' });
      const receipt = await this.gateway.request<{ runId?: string; status?: string }>('chat.send', params);
      if (this.closed) return;
      if (typeof receipt.runId !== 'string') throw new Error('Missing native run identity');
      operation = this.saveOperation({ ...this.operation(id), nativeRunId: receipt.runId, state: 'accepted' });
      for (const event of this.earlyEvents.get(receipt.runId) ?? []) await this.event(event);
      this.earlyEvents.delete(receipt.runId);
    } catch (error) {
      if (this.closed) return;
      operation = this.operation(id);
      const rejected = error instanceof GatewayClientRequestError && error.gatewayCode === 'INVALID_REQUEST';
      const beforeSend = operation.state === 'prepared';
      this.saveOperation({ ...operation, state: beforeSend || rejected ? 'failed' : 'unknown', error: beforeSend && error instanceof Fault ? error.message : rejected ? 'OpenClaw rejected this request before admission. The original input is kept for review.' : 'OpenClaw has not confirmed the outcome. Check the original run; it will not be sent again.' });
    }
  }
  async edit(device: string, raw: unknown) {
    const input = conversationEditSchema.parse(raw), conversation = this.conversation(input.conversationId);
    // A failed/unknown setup has no native session to archive. Trash only its
    // retained local record, leaving setup receipts, drafts and files intact.
    if (!conversation.nativeId && input.deleted !== undefined && Object.keys(input).every(key => ['requestId', 'epoch', 'conversationId', 'expectedRevision', 'deleted'].includes(key))) {
      return this.store.admit(device, input, { type: 'conversation.edit', ...input }, () => {
        if (conversation.revision !== input.expectedRevision || conversation.pendingSettings || conversation.state === 'creating') throw new Fault(409, 'conversation_changed', 'This chat is still changing. Check its current status.');
        if (this.voiceBusy(conversation.id) || this.operations().some(op => op.conversationId === conversation.id && !terminal.has(op.state))) throw new Fault(409, 'run_unsettled', 'Finish the current reply before deleting this chat.');
        return this.saveConversation({ ...conversation, revision: conversation.revision + 1, deleted: !!input.deleted, archived: !!input.deleted });
      }).value;
    }
    if (input.deleted !== undefined) input.archived = input.deleted;
    const nextProject = input.projectId ? this.store.readEntity('project', input.projectId) : undefined;
    if (input.projectId && !nextProject) throw new Fault(409, 'missing_project', 'The selected Project is unavailable.');
    if (nextProject && assistantSpace(nextProject.value) !== assistantSpace(conversation)) throw new Fault(409, 'project_space', 'Choose a Project in this space.');
    if (assistantSpace(conversation) === 'work' && input.projectId !== undefined && input.projectId !== conversation.projectId) throw new Fault(409, 'work_project_bound', 'Start new work in the other Project to keep this task linked to its original working folder.');
    this.assertConnection(conversation);
    if (this.voiceBusy(conversation.id)) throw new Fault(409, 'voice_active', 'End the voice call before changing this conversation.');
    const intent = this.store.admit(device, input, { type: 'conversation.edit', ...input }, () => {
      if (conversation.revision !== input.expectedRevision || conversation.pendingSettings || !conversation.nativeId) throw new Fault(409, 'conversation_changed', 'The conversation changed. Review its current state.');
      if (this.operations().some(op => op.conversationId === conversation.id && !terminal.has(op.state))) throw new Fault(409, 'run_unsettled', 'Settle the current run before changing conversation settings.');
      this.saveConversation({ ...conversation, settingsResult: undefined, pendingSettings: { permissionMode: input.permissionMode, requestId: input.requestId, title: input.title, archived: input.archived, deleted: input.deleted, pinned: input.pinned, unread: input.unread, projectId: input.projectId, model: input.model, thinking: input.thinking, fastMode: input.fastMode } });
      return this.store.internalWrite(`assistant:edit:${input.requestId}`, { conversationId: conversation.id, state: 'prepared' });
    });
    if (!intent.fresh) return this.conversation(conversation.id);
    return this.applySettings(conversation.id, input.requestId);
  }
  private rejectSettings(id: string, requestId: string, message: string) {
    const current = this.conversation(id);
    if (current.pendingSettings?.requestId !== requestId) return current;
    this.store.internalWrite(`assistant:edit:${requestId}`, { conversationId: id, state: 'rejected', message });
    return this.saveConversation({ ...current, revision: current.revision + 1, pendingSettings: undefined, settingsResult: { requestId, state: 'rejected', message } });
  }
  private async applySettings(id: string, requestId: string): Promise<Conversation> {
    const conversation = this.conversation(id), input = conversation.pendingSettings;
    if (!input || input.requestId !== requestId || this.settingRequests.has(requestId)) return conversation;
    this.settingRequests.set(requestId, id);
    try {
      const transport = input.permissionMode === 'full' && this.accessControl ? this.accessControl : (input.thinking !== undefined || input.fastMode !== undefined) && this.responseControl ? this.responseControl : this.gateway;
      const response = await transport.request<Record<string, any>>('sessions.patch', { key: conversation.nativeKey, expectedSessionId: conversation.nativeId, ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}), ...(input.title !== undefined ? { label: input.title } : {}), ...(input.archived !== undefined ? { archived: input.archived } : {}), ...(input.pinned !== undefined ? { pinned: input.pinned } : {}), ...(input.unread !== undefined ? { unread: input.unread } : {}), ...(input.model !== undefined && input.model !== conversation.model ? { model: input.model } : {}), ...(input.thinking !== undefined ? { thinkingLevel: input.thinking } : {}), ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}) });
      this.assertConnection(conversation);
      const actual = object(response.entry);
      if (actual.sessionId !== conversation.nativeId || (input.permissionMode !== undefined && (actual.permissionMode !== input.permissionMode || actual.permissionModePending === true)) || (input.thinking !== undefined && (actual.thinkingLevel ?? null) !== input.thinking) || (input.fastMode !== undefined && (actual.fastMode ?? null) !== input.fastMode)) throw new Error('Response settings await effective readback');
      return this.settleSettings(id, requestId);
    } catch (error) {
      const notSent = error instanceof Fault && ['access_not_sent', 'response_not_sent'].includes(error.code);
      const rejected = error instanceof GatewayClientRequestError && ['INVALID_REQUEST', 'FORBIDDEN'].includes(error.gatewayCode);
      if (notSent || rejected) {
        if (this.conversation(id).pendingSettings?.requestId !== requestId) return this.conversation(id);
        const message = notSent ? error.message : input.permissionMode !== undefined && error instanceof GatewayClientRequestError && error.gatewayCode === 'FORBIDDEN' ? 'The host rejected this access change. Your current access is unchanged.' : 'The host rejected these settings. Your previous settings are kept.';
        this.rejectSettings(id, requestId, message);
        throw new Fault(409, 'edit_rejected', message);
      }
      throw new Fault(409, 'edit_unknown', 'This settings change is not confirmed. Check status, retry the same settings, or keep the settings currently on the host.');
    } finally { this.settingRequests.delete(requestId); }
  }
  async recoverSettings(device: string, raw: unknown): Promise<Conversation> {
    const input = recoverSettingsSchema.parse(raw), conversation = this.conversation(input.conversationId);
    this.assertConnection(conversation);
    if ([...this.settingRequests.values()].includes(conversation.id) || this.voiceBusy(conversation.id) || this.operations().some(op => op.conversationId === conversation.id && !terminal.has(op.state))) throw new Fault(409, 'settings_busy', 'Wait for the current reply or settings change to finish.');
    const receipt = this.store.admit(device, input, { type: 'conversation.recover-settings', ...input }, () => {
      if (conversation.revision !== input.expectedRevision || conversation.pendingSettings?.requestId !== input.pendingRequestId) throw new Fault(409, 'conversation_changed', 'These settings changed. Review the current conversation.');
      return { conversationId: conversation.id };
    });
    if (!receipt.fresh && (input.action === 'retry' || this.conversation(conversation.id).pendingSettings?.requestId !== input.pendingRequestId)) return this.conversation(conversation.id);
    if (input.action === 'retry') return this.applySettings(conversation.id, input.pendingRequestId);
    this.settingRequests.set(input.requestId, conversation.id);
    try {
      const history = await this.history(conversation.id), current = this.conversation(conversation.id), actual = history.nativeSettings;
      this.assertConnection(conversation);
      if (current.revision !== input.expectedRevision || current.pendingSettings?.requestId !== input.pendingRequestId || history.nativeId !== conversation.nativeId || !actual || actual.permissionModePending) throw new Fault(409, 'settings_unverified', 'The host settings are still changing. Check their status before continuing.');
      const pending = current.pendingSettings, patch: Partial<Conversation> = {};
      const fields = ['title', 'archived', 'pinned', 'unread', 'model', 'thinking', 'fastMode', 'permissionMode'] as const;
      for (const field of fields) if (pending[field] !== undefined) {
        const value = actual[field];
        if (value === undefined || value === null && !['model', 'thinking', 'fastMode'].includes(field)) throw new Fault(409, 'settings_unverified', 'The host did not return every changed setting. Check status or retry the original settings.');
        Object.assign(patch, { [field]: value });
      }
      if (pending.deleted !== undefined) patch.deleted = actual.archived ? current.deleted : false;
      this.store.internalWrite(`assistant:edit:${input.pendingRequestId}`, { conversationId: current.id, state: 'superseded', observedAt: now(), nativeId: history.nativeId });
      return this.saveConversation({ ...current, ...patch, revision: current.revision + 1, pendingSettings: undefined, settingsResult: { requestId: input.pendingRequestId, state: 'kept-current' } });
    } finally { this.settingRequests.delete(input.requestId); }
  }

  private settleSettings(id: string, requestId: string) {
    // A history reconciliation can confirm this edit before its RPC response
    // arrives. Only the still-pending intent may change the current revision.
    const current = this.conversation(id), pending = current.pendingSettings;
    if (!pending || pending.requestId !== requestId) return current;
    const result = this.saveConversation({ ...current, revision: current.revision + 1, permissionMode: pending.permissionMode ?? current.permissionMode, title: pending.title ?? current.title, ...(pending.title !== undefined ? { autoTitle: false } : {}), archived: pending.archived ?? current.archived, deleted: pending.deleted ?? current.deleted, pinned: pending.pinned ?? current.pinned, unread: pending.unread ?? current.unread, projectId: pending.projectId !== undefined ? pending.projectId : current.projectId, model: pending.model !== undefined ? pending.model : current.model, thinking: pending.thinking !== undefined ? pending.thinking : current.thinking, fastMode: pending.fastMode !== undefined ? pending.fastMode : current.fastMode, pendingSettings: undefined, settingsResult: { requestId, state: 'completed' } });
    this.store.internalWrite(`assistant:edit:${requestId}`, { conversationId: id, state: 'completed' });
    return result;
  }
  async goal(id: string) {
    const conversation = this.conversation(id); this.assertConnection(conversation, false);
    const result = await this.gateway.request<{ session: { sessionId: string; goal?: unknown } | null }>('sessions.describe', { key: conversation.nativeKey });
    this.assertConnection(conversation, false);
    if (result.session?.sessionId !== conversation.nativeId) throw new Fault(409, 'goal_session_changed', 'The goal belongs to a changed conversation.');
    const goal = result.session.goal ? chatGoalSchema.parse(result.session.goal) : null;
    // A resumed/automatic native goal turn is already running. Observe its exact
    // identity so the normal progress, steering and Stop controls can own it.
    if (goal) {
      const history = await this.history(id), run = history.inFlightRun;
      const source = this.operations().find(op => op.conversationId === id && op.nativeId === conversation.nativeId && op.context.workMode === 'goal');
      if (run && source && !this.operations().some(op => op.nativeRunId === run.runId)) {
        this.saveOperation({ ...source, id: randomUUID(), requestId: randomUUID(), nativeRunId: run.runId, state: 'running', input: 'Continue pursuing the current goal.', text: run.text, createdAt: now(), updatedAt: now(), lastSequence: 0, tools: [], plan: undefined, planSequence: undefined, error: undefined, cancelRequested: undefined, effectiveModel: undefined, nativeTurnId: undefined });
      }
    }
    const authored = goal && this.operations().find(op => op.conversationId === id && op.nativeId === conversation.nativeId && op.context.workMode === 'goal' && matchesOwnerMessage(op, goal.objective));
    return { goal: goal ? { ...goal, ...(authored ? { displayObjective: authored.input } : {}) } : null };
  }
  async changeGoal(device: string, raw: unknown) {
    const input = chatGoalActionSchema.parse(raw), conversation = this.conversation(input.conversationId); this.assertConnection(conversation);
    if (input.nativeId !== conversation.nativeId || conversation.archived) throw new Fault(409, 'goal_session_changed', 'Reopen this goal in its original chat.');
    const admitted = this.store.admit(device, input, { type: 'assistant.goal', ...input }, () => input);
    const method = input.action === 'clear' ? 'sessions.goal.clear' : 'sessions.goal.update';
    try {
      await this.gateway.request(method, { sessionKey: conversation.nativeKey, sessionId: conversation.nativeId, goalId: admitted.value.goalId, operationId: admitted.value.requestId, issuedAtMs: admitted.value.issuedAtMs, ...(input.action !== 'clear' ? { action: input.action } : {}) });
    } catch (error) {
      if (error instanceof GatewayClientRequestError && ['INVALID_REQUEST', 'FORBIDDEN'].includes(error.gatewayCode)) throw new Fault(409, 'goal_changed', 'The goal change was rejected. Refresh its current state before trying again.');
      throw error;
    }
    this.assertConnection(conversation); return this.goal(conversation.id);
  }
  async cancel(device: string, input: { requestId: string; epoch: string; operationId: string }) {
    const original = this.operation(input.operationId);
    if (!original.nativeRunId) throw new Fault(409, 'run_identity_unknown', 'The exact native run is not known yet. Check its status first.');
    const admitted = this.store.admit(device, input, { type: 'assistant.cancel', ...input }, () => this.saveOperation({ ...original, cancelRequested: true }));
    if (admitted.fresh && !terminal.has(original.state)) {
      try { this.assertConnection(this.conversation(original.conversationId)); await this.gateway.request('chat.abort', { sessionKey: original.nativeKey, runId: original.nativeRunId, preserveSideRuns: true }); }
      catch { this.saveOperation({ ...this.operation(original.id), state: 'unknown', error: 'Cancellation has not been confirmed. Check the original run.' }); }
    }
    return this.operation(original.id);
  }
  async reconcile(id: string) {
    const conversation = this.conversation(id);
    const history = await this.history(id);
    if (conversation.pendingSettings && history.nativeSettings) {
      const pending = conversation.pendingSettings, actual = history.nativeSettings;
      const matches = (pending.permissionMode === undefined || pending.permissionMode === actual.permissionMode && !actual.permissionModePending) && (pending.pinned === undefined || pending.pinned === actual.pinned) && (pending.unread === undefined || pending.unread === actual.unread) && (pending.title === undefined || pending.title === actual.title) && (pending.archived === undefined || pending.archived === actual.archived) && (pending.model === undefined || pending.model === actual.model) && (pending.thinking === undefined || pending.thinking === (actual.thinking ?? null)) && (pending.fastMode === undefined || pending.fastMode === (actual.fastMode ?? null));
      if (matches) this.settleSettings(conversation.id, pending.requestId);
    }
    for (const operation of this.operations().filter(op => op.conversationId === id && (!terminal.has(op.state) || !op.effectiveModel))) {
      if (operation.epoch !== this.store.epoch || operation.connectionGeneration !== conversation.connectionGeneration) continue;
      const exact = history.inFlightRun?.runId === operation.nativeRunId ? history.inFlightRun : null;
      if (exact) this.saveOperation({ ...operation, state: 'running', text: exact.text });
      else if (operation.nativeRunId && this.gateway.status().methods.includes('agent.wait')) {
        const receipt = await this.gateway.request<Record<string, any>>('agent.wait', { runId: operation.nativeRunId, timeoutMs: 0 });
        if (this.closed) return history;
        this.assertConnection(conversation, false);
        const proof = object(receipt.terminalReceipt), reply = object(receipt.terminalReply);
        if (receipt.runId !== operation.nativeRunId || proof.runId !== operation.nativeRunId || proof.sessionId !== operation.nativeId || !['ok', 'error'].includes(receipt.status)) continue;
        const effective = object(proof.effective);
        this.saveOperation({ ...this.operation(operation.id), state: receipt.status === 'ok' ? 'completed' : 'failed', text: typeof reply.text === 'string' ? reply.text : operation.text, error: receipt.status === 'error' ? 'OpenClaw confirmed this run failed. The original input is kept.' : undefined, effectiveModel: typeof effective.provider === 'string' && typeof effective.model === 'string' ? `${effective.provider}/${effective.model}` : undefined, nativeTurnId: typeof proof.turnId === 'string' ? proof.turnId : undefined });
      }
      // An idle session alone cannot prove a particular unknown send succeeded or failed.
    }
    return history;
  }
  private async event(event: EventFrame) {
    if (event.event === 'e3.connected' || event.event === 'e3.history-gap') {
      this.subscribed.clear();
      for (const conversation of this.conversations().filter(c => !c.archived && c.state !== 'failed')) void this.reconcile(conversation.id).catch(() => undefined);
      return;
    }
    if (this.closed) return;
    const data = object(event.payload), runId = data.runId;
    if (event.event === 'sessions.changed' && data.reason === 'chat.title') { const chat = this.conversations().find(c => c.autoTitle && c.nativeKey === data.sessionKey); if (chat) void this.history(chat.id).catch(() => undefined); }
    if (event.event === 'session.message') {
      const conversation = this.conversations().find(c => c.nativeKey === data.sessionKey && c.connectionGeneration === this.gateway.status().generation && (!data.sessionId || data.sessionId === c.nativeId));
      if (conversation) this.historyVersions[conversation.id] = (this.historyVersions[conversation.id] ?? 0) + 1;
      return;
    }
    if (typeof runId !== 'string') return;
    const operation = this.operations().find(op => op.nativeRunId === runId && (!terminal.has(op.state) || event.event === 'agent' && ['tool', 'plan'].includes(data.stream)));
    if (!operation) {
      if (this.operations().some(op => op.state === 'dispatching')) { const events = this.earlyEvents.get(runId) ?? []; if (events.length < 100) this.earlyEvents.set(runId, [...events, event]); if (this.earlyEvents.size > 20) this.earlyEvents.delete(this.earlyEvents.keys().next().value!); }
      return;
    }
    if (operation.epoch !== this.store.epoch || operation.connectionGeneration !== this.gateway.status().generation || (data.sessionKey && data.sessionKey !== operation.nativeKey)) return;
    if (event.event === 'agent') {
      if (!Number.isInteger(data.seq) || data.seq <= operation.lastSequence && !['tool', 'plan'].includes(data.stream)) return;
      const detail = object(data.data);
      const plan = (data.stream === 'plan' || data.stream === 'tool' && ['progress_card', 'update_plan'].includes(detail.name)) && data.seq > (operation.planSequence ?? -1) ? readRunPlan(detail) : undefined;
      const updated = { ...operation, ...(plan ? { plan, planSequence: data.seq } : {}), ...(data.stream === 'tool' ? { tools: toolActivity(operation.tools, detail, data.seq) } : {}), lastSequence: Math.max(data.seq, operation.lastSequence), state: terminal.has(operation.state) ? operation.state : 'running' as const, ...(typeof detail.text === 'string' && data.stream === 'assistant' ? { text: detail.text } : {}) };
      if (data.seq > operation.lastSequence + 1 && operation.lastSequence > 0) void this.reconcile(operation.conversationId).catch(() => undefined);
      if (data.stream === 'lifecycle' && ['end', 'error', 'aborted'].includes(detail.phase)) {
        if (detail.phase === 'end' && this.awaitCompletionReceipt(updated)) return;
        this.saveOperation({ ...updated, state: detail.phase === 'end' ? 'completed' : detail.phase === 'aborted' ? 'cancelled' : 'failed', ...(detail.phase === 'error' ? { error: 'OpenClaw reported a run failure. Inspect the retained conversation.' } : {}) });
        void this.reconcile(operation.conversationId).catch(() => undefined);
      } else this.saveOperation(updated);
    } else if (event.event === 'chat' && ['final', 'error', 'aborted'].includes(data.state)) {
      if (data.state === 'final' && this.awaitCompletionReceipt({ ...operation, text: textOf(data.message) || operation.text })) return;
      this.saveOperation({ ...operation, state: data.state === 'final' ? 'completed' : data.state === 'aborted' ? 'cancelled' : 'failed', text: textOf(data.message) || operation.text, ...(data.state === 'error' ? { error: 'OpenClaw reported a run failure.' } : {}) });
      void this.reconcile(operation.conversationId).catch(() => undefined);
    }
  }
}
