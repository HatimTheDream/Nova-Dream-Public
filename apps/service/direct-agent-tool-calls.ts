import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';

export const directRuntimeAgent = 'edition3-direct';
export const directReadTool = 'nova_direct_read';
export const directReadInputSchema = z.object({
  operation: z.enum(['records.list', 'records.read', 'calendar.read', 'inbox.read', 'profile.read']),
  input: z.record(z.string(), z.unknown()),
}).strict();
export type DirectReadInput = z.infer<typeof directReadInputSchema>;
const id = z.string().min(1).max(512);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const directReadOriginSchema = z.object({
  epoch: z.uuid(), operationId: z.uuid(), requestId: z.uuid(), conversationId: z.uuid(),
  agentId: z.literal(directRuntimeAgent), sessionKey: id, sessionId: z.uuid(),
  runId: z.uuid(), toolCallId: id, generation: id, accountId: id, policySha256: sha, inputSha256: sha,
}).strict();
export type DirectReadOrigin = z.infer<typeof directReadOriginSchema>;
export type TrustedDirectCall = {
  agentId?: string; sessionKey?: string; sessionId?: string; runId?: string;
  toolCallId?: string; toolName: string; abortSignal?: AbortSignal;
};
export type DirectExecutionContext = Pick<TrustedDirectCall, 'agentId' | 'sessionKey' | 'sessionId'> & {
  assertInvocationCurrent: () => void;
};
type Slot = {
  call: Required<Pick<TrustedDirectCall, 'sessionKey' | 'sessionId' | 'runId' | 'toolCallId'>>;
  inputSha256: string; deadline: number; state: 'pending' | 'authorized' | 'consumed' | 'closed';
  controller: AbortController; signal: AbortSignal; origin?: DirectReadOrigin;
};
export function directReadInput(raw: unknown) {
  const input = directReadInputSchema.parse(raw);
  const bytes = canonical(input);
  if (Buffer.byteLength(bytes) > 32768) throw Error('Narrow this read request.');
  return { input: JSON.parse(bytes) as DirectReadInput, inputSha256: createHash('sha256').update(bytes).digest('hex') };
}
const key = (call: { sessionKey: string; sessionId: string; toolCallId: string }) =>
  JSON.stringify([call.sessionKey, call.sessionId, call.toolCallId]);

/** Ephemeral host-call authority only. It is never a saved operation or a retry
 * queue. Closed/consumed slots remain until the exact run ends, preventing a
 * delayed policy callback or repeated tool ID from creating another read. */
export class DirectAgentToolCalls {
  private readonly slots = new Map<string, Slot>();
  private readonly endedRuns = new Set<string>();
  private closed = false;
  constructor(private readonly owner: { epoch: string; policySha256: string },
    private readonly assertCurrent: () => void, private readonly now = () => performance.now()) {
    z.object({ epoch: z.uuid(), policySha256: sha }).strict().parse(owner);
  }
  private current(slot?: Slot) {
    if (this.closed) throw Error('The original direct-agent adapter is closed.');
    this.assertCurrent();
    if (slot) {
      slot.signal.throwIfAborted();
      if (this.endedRuns.has(slot.call.runId) || this.slots.get(key(slot.call)) !== slot || slot.state === 'closed')
        throw Error('The original tool call is no longer current.');
    }
  }
  async authorize(context: TrustedDirectCall, raw: unknown,
    load: (request: {
      epoch: string; policySha256: string; agentId: typeof directRuntimeAgent;
      sessionKey: string; sessionId: string; runId: string; toolCallId: string;
      inputSha256: string; read: DirectReadInput;
    }, signal: AbortSignal) => Promise<unknown>): Promise<void> {
    this.current();
    if (context.agentId !== directRuntimeAgent || context.toolName !== directReadTool || !context.abortSignal)
      throw Error('A trusted direct-agent tool call is required.');
    const call = z.object({ sessionKey: id, sessionId: z.uuid(), runId: z.uuid(), toolCallId: id }).strict().parse({
      sessionKey: context.sessionKey, sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId,
    });
    context.abortSignal.throwIfAborted();
    if (!call.sessionKey.startsWith('agent:edition3-direct:e3:') || this.endedRuns.has(call.runId)
      || this.slots.has(key(call)) || this.slots.size >= 2048)
      throw Error('This original tool identity cannot be admitted again.');
    const parsed = directReadInput(raw), controller = new AbortController();
    const slot: Slot = {
      call, inputSha256: parsed.inputSha256, deadline: this.now() + 5000, state: 'pending', controller,
      signal: AbortSignal.any([context.abortSignal, controller.signal]),
    };
    this.slots.set(key(call), slot);
    try {
      const reply = await load({ ...this.owner, agentId: directRuntimeAgent, ...call, inputSha256: parsed.inputSha256, read: parsed.input }, slot.signal);
      this.current(slot);
      if (slot.state !== 'pending' || this.now() > slot.deadline) throw Error('The original policy observation expired.');
      const origin = directReadOriginSchema.parse(reply);
      if (origin.epoch !== this.owner.epoch || origin.policySha256 !== this.owner.policySha256
        || origin.sessionKey !== call.sessionKey || origin.sessionId !== call.sessionId || origin.runId !== call.runId || origin.toolCallId !== call.toolCallId
        || origin.sessionKey !== `agent:edition3-direct:e3:${origin.conversationId}`
        || origin.requestId !== call.runId || origin.inputSha256 !== slot.inputSha256)
        throw Error('Read authority does not belong to this original native call.');
      slot.origin = origin;
      slot.state = 'authorized';
    } catch (error) {
      slot.state = 'closed'; controller.abort();
      throw error;
    }
  }
  async consume<T>(context: DirectExecutionContext, toolCallId: string, raw: unknown, signal: AbortSignal | undefined,
    read: (origin: DirectReadOrigin, input: DirectReadInput, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (context.agentId !== directRuntimeAgent || !context.sessionKey || !context.sessionId
      || typeof context.assertInvocationCurrent !== 'function') throw Error('The original tool owner is unavailable.');
    const slot = this.slots.get(key({ sessionKey: context.sessionKey, sessionId: context.sessionId, toolCallId }));
    if (!slot || slot.state !== 'authorized' || !slot.origin) throw Error('No unused original read authority exists.');
    // Consume before any external callback. Failures cannot authorize a resend.
    slot.state = 'consumed';
    const parsed = directReadInput(raw);
    if (parsed.inputSha256 !== slot.inputSha256) throw Error('The authorized tool input changed.');
    const combined = AbortSignal.any([slot.signal, ...(signal ? [signal] : [])]);
    const check = () => { this.current(slot); context.assertInvocationCurrent(); combined.throwIfAborted(); };
    check();
    const result = await read(structuredClone(slot.origin), parsed.input, combined);
    check();
    return result;
  }
  finish(context: TrustedDirectCall) {
    if (!context.sessionKey || !context.sessionId || !context.toolCallId) return;
    const slot = this.slots.get(key({ sessionKey: context.sessionKey, sessionId: context.sessionId, toolCallId: context.toolCallId }));
    if (slot && context.agentId === directRuntimeAgent && context.runId === slot.call.runId) {
      slot.state = 'closed'; slot.controller.abort();
    }
  }
  endRun(runId: string, knownDirectRun = false) {
    if (!knownDirectRun && ![...this.slots.values()].some(slot => slot.call.runId === runId)) return;
    this.endedRuns.add(runId);
    for (const [id, slot] of this.slots) if (slot.call.runId === runId) {
      slot.state = 'closed'; slot.controller.abort(); this.slots.delete(id);
    }
    // Never evict original terminal authority to make room for a replay.
    if (this.endedRuns.size >= 4096) this.dispose();
  }
  cleanup(scope: { runId?: string; sessionKey?: string }) {
    if (scope.runId) return this.endRun(scope.runId);
    if (!scope.sessionKey) return this.dispose();
    for (const slot of this.slots.values()) if (slot.call.sessionKey === scope.sessionKey) {
      slot.state = 'closed'; slot.controller.abort();
    }
  }
  dispose() {
    this.closed = true;
    for (const slot of this.slots.values()) { slot.state = 'closed'; slot.controller.abort(); }
    this.slots.clear();
  }
}
