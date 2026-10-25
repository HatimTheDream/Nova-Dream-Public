import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import { groupExecutionCommandSchema, groupRuntimeAgent, type GroupExecution,
  executionReceipt, groupExecutionIntent, groupExecutionRejectionSchema,
  type GroupExecutionObservation } from '../../packages/domain/assistant-group-execution.js';
import { Fault, type Store } from './store.js';
import type { AssistantTransport } from './gateway.js';
import { GroupExecutionOwner, type GroupOwnerObservation } from './group-execution-owner.js';
import { groupExecutionRequest, groupAcknowledgement } from './group-execution-request.js';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const object = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
const querySchema = z.object({ groupId: z.string().uuid(), attemptId: z.string().uuid(),
  requestId: z.string().uuid().optional() }).strict();
const availabilitySchema = z.object({ view: z.literal('availability'), groupId: z.string().uuid(),
  roundId: z.string().uuid(), roundSha256: z.string().regex(/^[a-f0-9]{64}$/), attemptId: z.string().uuid() }).strict();
const readQuerySchema = z.union([querySchema, availabilitySchema]);
export function groupExecutionQuery(params: URLSearchParams) {
  const raw: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(raw, key)) throw new Fault(400, 'group_execution_query', 'Use each original child query field once.');
    raw[key] = value;
  }
  return readQuerySchema.parse(raw);
}
const observeSchema = querySchema.omit({ requestId: true }).extend({ epoch: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();
type Lease = { child: GroupExecution; observed: GroupOwnerObservation; sequence: number; text: string; lifecycleBound: boolean };
const terminal = new Set(['completed', 'failed', 'cancelled']);

/** One owned lifecycle per original child on the maintained Gateway. No timer,
 * constructor, cached GET or replay dispatches anything. Every promise belongs
 * to this owner and close waits for those exact original calls. */
export class AssistantGroupExecutions {
  private closed = false;
  private flights = new Map<string, Promise<unknown>>();
  private leases = new Map<string, Lease>();
  private unsubscribe: () => void;
  constructor(private store: Store, private gateway: AssistantTransport, private owner: GroupExecutionOwner) {
    this.unsubscribe = gateway.subscribe(event => this.event(event));
  }
  private current(original: GroupExecution) {
    if (this.closed || this.store.recoveryEffectsPaused || this.store.updateMaintenanceHeld
      || original.binding.epoch !== this.store.epoch)
      throw new Fault(409, 'group_owner_closed', 'The original Group owner is paused or closed.');
    const current = this.store.readGroupExecution(original.binding.groupId, original.binding.attemptId)?.value;
    if (!current || canonical(current.binding) !== canonical(original.binding))
      throw new Fault(409, 'group_original_changed', 'The original Group child is unavailable or changed.');
    return current;
  }
  private available(original: GroupExecution) {
    const current = this.current(original);
    const { group, preparation } = this.store.readGroupPreparation(current.binding.groupId);
    const round = preparation.rounds.get(current.binding.roundId);
    if (!round || digest(round) !== current.binding.roundSha256)
      throw new Fault(409, 'group_input_changed', 'The exact prepared Group input is unavailable.');
    const availability = this.store.groupPreparationAvailability(round, group);
    if (!availability.current) throw new Fault(409, availability.reason!, availability.message!);
    return { current, round, preparation };
  }
  private retain(original: GroupExecution, observation: GroupExecutionObservation) {
    const current = this.current(original);
    return this.store.recordGroupExecutionObservation(current.binding.groupId, current.binding.attemptId, digest(current), observation);
  }
  private own<T>(key: string, action: () => Promise<T>): Promise<T> {
    const existing = this.flights.get(key);
    if (existing) return existing as Promise<T>;
    const promise = Promise.resolve().then(() => {
      if (this.closed) throw new Fault(409, 'group_owner_closed', 'This original Group owner is closed.');
      return action();
    });
    this.flights.set(key, promise);
    void promise.finally(() => { if (this.flights.get(key) === promise) this.flights.delete(key); }).catch(() => undefined);
    return promise;
  }
  readQuery(device: string, raw: unknown) {
    const input = readQuerySchema.parse(raw);
    return 'view' in input ? this.setupAvailability(device, input) : this.read(device, input);
  }
  /** Pure local admission projection, not account readiness or permission to
   * send. Explicit setup still makes its own fresh atomic/runtime checks. */
  setupAvailability(device: string, raw: unknown) {
    const input = availabilitySchema.parse(raw), { preparation, group } = this.store.readGroupPreparation(input.groupId);
    const round = preparation.rounds.get(input.roundId);
    if (!round || round.deviceId !== device || digest(round) !== input.roundSha256
      || !round.recipients.some(recipient => recipient.attempt.id === input.attemptId))
      throw new Fault(404, 'group_round_missing', 'This device has no exact prepared child with that identity.');
    const base = { epoch: this.store.epoch, groupId: input.groupId, roundId: input.roundId,
      roundSha256: input.roundSha256, attemptId: input.attemptId, accountReadiness: 'not-observed' as const,
      sendReadiness: 'not-admitted' as const };
    try {
      if (this.closed) throw new Fault(409, 'group_owner_closed', 'This original Group owner is closed.');
      const authority = this.store.groupPreparationAvailability(round, group);
      if (!authority.current) throw new Fault(409, authority.reason!, authority.message!);
      if (this.store.readGroupExecution(input.groupId, input.attemptId))
        throw new Fault(409, 'group_original_exists', 'Keep and observe the original child; do not create it again.');
      this.owner.current();
      return { ...base, availableForExplicitSetup: true as const, reason: null };
    } catch (error) {
      return { ...base, availableForExplicitSetup: false as const,
        reason: error instanceof Fault ? error.code : 'group_runtime_unavailable' };
    }
  }
  read(device: string, raw: unknown) {
    const input = querySchema.parse(raw), original = this.store.readGroupExecution(input.groupId, input.attemptId);
    if (!original || original.value.binding.deviceId !== device)
      throw new Fault(404, 'group_child_missing', 'This device has no original child with that identity.');
    const value = original.value, lease = value.send && this.leases.get(value.send.requestId);
    const selected = input.requestId ? original.events.find(event => event.command?.requestId === input.requestId) : undefined;
    if (input.requestId && !selected)
      throw new Fault(404, 'group_request_missing', 'This original child has no admitted command with that exact identity.');
    let currentAuthority = false;
    try { this.available(value); currentAuthority = true; } catch { /* Historical results remain readable. */ }
    // Account identity hashes and runtime internals are private provenance.
    const phase = (part: GroupExecution['send']) => part && ({ requestId: part.requestId, commandId: part.commandId,
      state: part.state, dispatchStarted: part.dispatchStarted, error: part.error,
      canContinueUnsent: currentAuthority && part.state === 'failed' && !part.dispatchStarted && part.attempts < 4 && !value.stop });
    return { epoch: value.binding.epoch, groupId: input.groupId, attemptId: input.attemptId,
      roundId: value.binding.roundId, roundSha256: value.binding.roundSha256, revision: value.revision,
      originalReceipt: selected ? executionReceipt(selected, digest) : null,
      originalCommand: selected?.command ?? null, account: value.binding.account,
      canSend: currentAuthority && value.setup.state === 'ready' && !!value.nativeId && !value.send && !value.stop,
      canStop: !!value.send?.dispatchStarted && !terminal.has(value.send.state) && !value.stop,
      canContinueStop: !!value.send?.dispatchStarted && !terminal.has(value.send.state)
        && !!value.stop && 'format' in value.stop && value.stop.format === 2
        && value.stop.state === 'failed' && !value.stop.dispatchStarted && value.stop.attempts < 4,
      observationInFlight: this.flights.has(`observe:${input.attemptId}`),
      sha256: digest(value), setup: phase(value.setup), send: phase(value.send), stop: value.stop,
      text: value.text, nativeTurnId: value.nativeTurnId, effectiveModel: value.effectiveModel,
      author: { agentId: value.binding.agentId, agentRevision: value.binding.agentRevision,
        membershipId: value.binding.membershipId, roundId: value.binding.roundId },
      activity: lease ? { text: lease.text, sequence: lease.sequence, completionConfirmed: false as const } : null };
  }
  async command(device: string, raw: unknown, authorize: () => void = () => {}) {
    authorize();
    const command = groupExecutionCommandSchema.parse(raw);
    let admitted: ReturnType<Store['admitGroupExecution']>;
    try {
      admitted = this.store.admitGroupExecution(device, command, () => {
        if (this.closed) throw new Fault(409, 'group_owner_closed', 'This Group owner is closed.');
        authorize();
        this.owner.current();
      });
    } catch (error) {
      // Only synchronous admission has ended here. A later native/authorization
      // failure must never claim absence or permit replacing an uncertain call.
      let absent = false;
      try {
        absent = this.store.internalAtomic(() => {
          if (this.store.replayAdmission(device, command, groupExecutionIntent(command)) !== undefined) return false;
          this.store.readGroupPreparation(command.groupId); // Complete joined graph.
          const child = this.store.readGroupExecution(command.groupId, command.attemptId);
          return !child?.events.some(event => event.command?.requestId === command.requestId);
        });
      } catch { /* Original receipt collisions, epoch changes and corrupt state stay unresolved. */ }
      if (absent) throw new Fault(error instanceof Fault ? error.status : 409,
        error instanceof Fault ? error.code : 'group_execution_changed',
        error instanceof Error ? error.message : 'Review the original Group reply before trying a new action.',
        groupExecutionRejectionSchema.parse({ kind: 'assistant-group-execution-rejection', command }));
      throw error;
    }
    if (admitted.fresh) {
      const child = admitted.current;
      await this.own(command.requestId, () => command.action === 'stop' || command.action === 'continue-stop' ? this.stop(child, authorize)
        : this.runPhase(child, command.action === 'setup' ? 'setup'
          : command.action === 'continue-unsent' ? command.phase : 'send', authorize));
    }
    authorize();
    return { receipt: admitted.value, current: this.read(device, {
      groupId: command.groupId, attemptId: command.attemptId, requestId: command.requestId,
    }) };
  }
  private async runPhase(original: GroupExecution, phase: 'setup' | 'send', authorize: () => void) {
    const commandId = original[phase]!.commandId;
    try {
      if (phase === 'setup') await this.setup(original, authorize);
      else await this.send(original, authorize);
    } catch {
      // Only the live original call can establish a no-dispatch failure. A
      // restart never rewrites preparing/dispatching to manufacture this proof.
      if (this.closed || this.store.recoveryEffectsPaused || this.store.updateMaintenanceHeld) return;
      const current = this.current(original), state = current[phase];
      if (state?.commandId === commandId && ['preparing', 'dispatching'].includes(state.state))
        this.retain(current, { kind: 'failure', phase,
          message: state.dispatchStarted ? 'The original native result is unconfirmed. Observe it; do not resend.'
            : 'This original phase failed before native dispatch. Review it before an explicit continuation.' });
    }
  }
  private async setup(original: GroupExecution, authorize: () => void) {
    const observed = await this.owner.observe(original, authorize);
    const { current } = this.available(original);
    if (current.setup.commandId !== original.setup.commandId || current.setup.state !== 'preparing'
      || current.nativeId || observed.policy.session)
      throw new Fault(409, 'group_setup_changed', 'The original native key is not authoritatively absent.');
    this.owner.assertReady(observed);
    const proof = this.owner.proof(observed); authorize();
    this.retain(current, { kind: 'dispatch', phase: 'setup', proof });
    // No await between final authority, durable marker and this one request.
    const reply = object(await this.gateway.request('sessions.create', {
      key: current.binding.nativeKey, idempotencyKey: current.setup.requestId,
      model: `${current.binding.account.model}@${current.binding.account.profileId}`,
      permissionMode: 'read-only', emitCommandHooks: false,
    }));
    const entry = object(reply.entry);
    if (reply.key !== current.binding.nativeKey || !z.string().uuid().safeParse(reply.sessionId).success
      || reply.runStarted !== false || entry.sessionId !== reply.sessionId
      || entry.permissionMode !== 'read-only' || entry.permissionModePending === true)
      throw Error('The original native setup response is unconfirmed.');
    const actual = await this.owner.observe({ ...current, nativeId: reply.sessionId as string }, authorize, 'original');
    const latest = this.current(current);
    if (latest.setup.commandId !== current.setup.commandId || actual.policy.session?.id !== reply.sessionId)
      throw Error('The original setup changed before confirmation.');
    this.retain(latest, { kind: 'setup-ready', nativeId: reply.sessionId as string, proof: this.owner.proof(actual) });
  }
  private async send(original: GroupExecution, authorize: () => void) {
    this.available(original); this.owner.current(); authorize();
    const history = object(await this.gateway.request('chat.history', {
      sessionKey: original.binding.nativeKey, limit: 1, maxChars: 1000,
    }));
    const info = object(history.sessionInfo);
    if ((history.sessionId ?? info.sessionId) !== original.nativeId || !Array.isArray(history.messages) || history.messages.length
      || !Array.isArray(info.activeRunIds) || info.activeRunIds.length || info.hasActiveRun !== false)
      throw Error('The fresh original Group session is not confirmed empty and idle.');
    const observed = await this.owner.observe(original, authorize);
    const { current, round, preparation } = this.available(original);
    if (current.send?.commandId !== original.send?.commandId) throw Error('The original send changed.');
    const params = groupExecutionRequest(current, round, preparation, observed);
    const ceiling = this.gateway.attachmentPolicy().maxPayload;
    if (ceiling && Buffer.byteLength(JSON.stringify(params)) + 1024 > ceiling)
      throw Error('The exact prepared Group input exceeds the native payload bound.');
    this.owner.assertReady(observed);
    const proof = this.owner.proof(observed); authorize();
    const dispatched = this.retain(current, { kind: 'dispatch', phase: 'send', proof });
    this.leases.set(dispatched.send!.requestId, { child: dispatched, observed, sequence: -1, text: '', lifecycleBound: false });
    const reply = await this.gateway.request('agent', params);
    if (!groupAcknowledgement(dispatched, reply)) throw Error('The original Group send is unconfirmed.');
    this.owner.assertCurrent(observed);
    const latest = this.current(dispatched);
    if (!latest.send || terminal.has(latest.send.state)) return;
    this.retain(latest, { kind: 'send-accepted', runId: dispatched.send!.requestId, proof: this.owner.proof(observed) });
  }
  private async stop(original: GroupExecution, authorize: () => void) {
    try {
      const observed = await this.owner.observe(original, authorize, 'original'), current = this.current(original);
      if (!current.send?.dispatchStarted || !current.stop || current.stop.requestId !== original.stop?.requestId
        || 'format' in current.stop && (!original.stop || !('format' in original.stop)
          || current.stop.commandId !== original.stop.commandId))
        throw Error('The original stop changed.');
      if (terminal.has(current.send.state)) return;
      this.owner.assertCurrent(observed); authorize();
      if ('format' in current.stop)
        this.retain(current, { kind: 'stop-dispatch', proof: this.owner.proof(observed) });
      // After the durable marker, even a thrown/lost request remains uncertain.
      // There is no await between this marker and the exact original abort.
      await this.gateway.request('chat.abort', { sessionKey: current.binding.nativeKey,
        runId: current.send.requestId, preserveSideRuns: true });
      // An abort acknowledgement is not terminal confirmation.
    } finally {
      if (!this.closed) {
        const current = this.current(original);
        if (current.stop?.state === 'requested' && !terminal.has(current.send!.state)) {
          const stop = current.stop;
          if ('format' in stop && original.stop && 'format' in original.stop
            && stop.commandId === original.stop.commandId && !stop.dispatchStarted)
            this.retain(current, { kind: 'stop-failure', message: 'The original stop failed before native dispatch. Review it before continuing that exact stop.' });
          else if (!('format' in stop) || original.stop && 'format' in original.stop && stop.commandId === original.stop.commandId)
            this.retain(current, { kind: 'stop-unconfirmed' });
        }
      }
    }
  }
  /** Explicit original-only native observation. No sessions.create/agent/abort
   * is reachable here, including after restart or a lost acknowledgement. */
  async observe(device: string, raw: unknown, authorize: () => void = () => {}) {
    authorize();
    const input = observeSchema.parse(raw), original = this.store.readGroupExecution(input.groupId, input.attemptId)?.value;
    if (!original || original.binding.deviceId !== device || original.binding.epoch !== input.epoch
      || original.revision !== input.expectedRevision)
      throw new Fault(409, 'group_observation_changed', 'Review the exact original child before observing it.');
    await this.own(`observe:${input.attemptId}`, () => this.observeOriginal(original, authorize));
    authorize();
    return this.read(device, { groupId: input.groupId, attemptId: input.attemptId });
  }
  private async observeOriginal(original: GroupExecution, authorize: () => void = () => {}) {
    const observed = await this.owner.observe(original, authorize, 'original'), current = this.current(original);
    if (current.setup.dispatchStarted && ['dispatching', 'unknown'].includes(current.setup.state)) {
      if (observed.policy.session)
        this.retain(current, { kind: 'setup-ready', nativeId: observed.policy.session.id, proof: this.owner.proof(observed) });
      return;
    }
    if (!current.send?.dispatchStarted || terminal.has(current.send.state)) return;
    authorize();
    const reply = object(await this.gateway.request('agent.wait', { runId: current.send.requestId, timeoutMs: 0 }));
    const terminalReceipt = object(reply.terminalReceipt), terminalReply = object(reply.terminalReply);
    if (reply.runId !== current.send.requestId || terminalReceipt.runId !== current.send.requestId
      || terminalReceipt.sessionId !== current.nativeId || !['ok', 'error'].includes(String(reply.status))) return;
    const final = await this.owner.observe(current, authorize, 'original'), latest = this.current(current);
    if (!latest.send || terminal.has(latest.send.state)) return;
    const effective = object(terminalReceipt.effective);
    if (typeof terminalReply.text !== 'string' || terminalReply.text.length > 262144) return;
    this.retain(latest, { kind: 'terminal', nativeId: latest.nativeId!, runId: latest.send.requestId,
      proof: this.owner.proof(final), state: reply.status === 'ok' ? 'completed' : 'failed',
      text: terminalReply.text, nativeTurnId: typeof terminalReceipt.turnId === 'string' ? terminalReceipt.turnId : null,
      effectiveModel: typeof effective.provider === 'string' && typeof effective.model === 'string'
        ? `${effective.provider}/${effective.model}` : null });
    this.leases.delete(latest.send.requestId);
  }
  private event(event: { event: string; payload?: unknown }) {
    const data = object(event.payload), lease = typeof data.runId === 'string' ? this.leases.get(data.runId) : undefined;
    if (!lease || this.closed) return;
    try {
      this.owner.assertCurrent(lease.observed);
      const child = this.current(lease.child);
      if (!child.send || terminal.has(child.send.state) || data.sessionKey !== child.binding.nativeKey
        || data.agentId !== groupRuntimeAgent || data.sessionId !== undefined && data.sessionId !== child.nativeId
        || !Number.isSafeInteger(data.seq) || Number(data.seq) <= lease.sequence) return;
      const detail = object(data.data);
      // SDK lifecycle events carry the original session identity. Some text
      // events omit sessionId; join them only after this owned run's exact
      // lifecycle start, never merely because an arbitrary run ID matches.
      if (event.event !== 'agent' || data.stream !== 'assistant' && data.stream !== 'lifecycle') return;
      if (data.stream === 'lifecycle' && data.sessionId !== child.nativeId) return;
      if (data.stream === 'assistant' && !lease.lifecycleBound) return;
      if (data.stream === 'lifecycle' && detail.phase === 'start') {
        if (typeof detail.startedAt !== 'number' || !Number.isFinite(detail.startedAt)) return;
        lease.lifecycleBound = true;
      }
      lease.sequence = Number(data.seq);
      if (event.event === 'agent' && data.stream === 'assistant' && typeof detail.text === 'string' && detail.text.length <= 262144)
        lease.text = detail.text;
      if (event.event === 'agent' && data.stream === 'lifecycle' && ['end', 'error'].includes(String(detail.phase))
        && detail.aborted === true && detail.stopReason === 'aborted') {
        this.retain(child, { kind: 'terminal', nativeId: child.nativeId!, runId: child.send.requestId,
          proof: this.owner.proof(lease.observed), state: 'cancelled', text: lease.text, nativeTurnId: null, effectiveModel: null });
        this.leases.delete(child.send.requestId);
      } else if (event.event === 'agent' && data.stream === 'lifecycle' && ['end', 'error'].includes(String(detail.phase))) {
        void this.own(`observe:${child.binding.attemptId}`, () => this.observeOriginal(child)).catch(() => undefined);
      }
    } catch { /* Keep the exact original request; a stale event grants no authority. */ }
  }
  async close() {
    this.closed = true; this.unsubscribe(); this.owner.close(); this.leases.clear();
    await Promise.allSettled([...this.flights.values()]);
  }
}
