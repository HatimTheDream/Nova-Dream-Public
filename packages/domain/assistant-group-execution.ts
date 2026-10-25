import { z } from 'zod';
import { canonical } from './contracts.js';
import { preparedGroupRoundSchema, type PreparedGroupRound } from './assistant-group-turns.js';
import { chatGptProfileIdSchema } from './chatgpt-accounts.js';

const uuid = /* @__PURE__ */ (() => (z.string().uuid()))(), sha = /* @__PURE__ */ (() => (z.string().regex(/^[a-f0-9]{64}$/)))();
const revision = /* @__PURE__ */ (() => (z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)))();
const label = /* @__PURE__ */ (() => (z.string().min(1).max(512)))(), at = /* @__PURE__ */ (() => (z.string().datetime()))();
export const groupExecutionPrefix = 'assistant:group-execution:';
export const groupExecutionEventLimit = 64;
export const groupExecutionChildBytes = 8 * 1024 * 1024;
export const groupExecutionGroupBytes = 128 * 1024 * 1024;
export const groupRuntimeAgent = 'edition3-group';
export const groupExecutionAccountSchema = /* @__PURE__ */ (() => (z.object({
  profileId: chatGptProfileIdSchema,
  model: z.string().regex(/^openai\/[^\s@]+$/).max(512),
}).strict()))();
const original = {
  requestId: uuid, epoch: uuid, groupId: uuid, roundId: uuid, roundSha256: sha, attemptId: uuid,
  expectedRevision: revision,
};
export const groupExecutionCommandSchema = /* @__PURE__ */ (() => (z.discriminatedUnion('action', [
  z.object({ ...original, action: z.literal('setup'), expectedRevision: z.literal(0),
    account: groupExecutionAccountSchema }).strict(),
  z.object({ ...original, action: z.literal('send') }).strict(),
  z.object({ ...original, action: z.literal('stop'), stopTracking: z.literal(1).optional() }).strict(),
  z.object({ ...original, action: z.literal('continue-stop'),
    originalRequestId: uuid, expectedSha256: sha }).strict(),
  z.object({ ...original, action: z.literal('continue-unsent'), phase: z.enum(['setup', 'send']),
    originalRequestId: uuid, expectedSha256: sha }).strict(),
])))();
export type GroupExecutionCommand = z.infer<typeof groupExecutionCommandSchema>;

/** A policy/account observation is authority for one synchronous boundary only.
 * These identities are retained as provenance, never as a reusable live lease. */
export const groupRuntimeProofSchema = /* @__PURE__ */ (() => (z.object({
  epoch: uuid, generation: uuid, runtimePid: revision.min(1), runtimeStartedAt: z.number().finite().positive(),
  registrationId: uuid, sourcePolicySha256: sha, policySha256: sha, pluginSha256: sha,
  accountIdentitySha256: sha,
}).strict()))();
export type GroupRuntimeProof = z.infer<typeof groupRuntimeProofSchema>;
const phaseState = /* @__PURE__ */ (() => (z.enum(['preparing', 'dispatching', 'ready', 'accepted', 'unknown', 'failed', 'completed', 'cancelled'])))();
const phaseSchema = /* @__PURE__ */ (() => (z.object({
  requestId: uuid, commandId: uuid, state: phaseState, dispatchStarted: z.boolean(),
  attempts: revision.min(1).max(4), proof: groupRuntimeProofSchema.nullable(), error: z.string().max(500).nullable(),
}).strict()))();
const bindingSchema = /* @__PURE__ */ (() => (z.object({
  epoch: uuid, deviceId: uuid, groupId: uuid, roundId: uuid, roundSha256: sha, attemptId: uuid,
  membershipId: uuid, agentId: z.string().regex(/^agent:/).max(2000), agentRevision: revision.min(1),
  account: groupExecutionAccountSchema,
  nativeKey: z.string().regex(/^agent:edition3-group:e3:[0-9a-f-]{36}$/),
}).strict()))();
const legacyStopSchema = /* @__PURE__ */ (() => (z.object({ requestId: uuid, state: z.enum(['requested', 'unconfirmed', 'confirmed']) }).strict()))();
export const groupStopSchema = /* @__PURE__ */ (() => (z.union([legacyStopSchema, z.object({
  format: z.literal(2), requestId: uuid, commandId: uuid,
  state: z.enum(['requested', 'unconfirmed', 'confirmed', 'failed']),
  dispatchStarted: z.boolean(), attempts: revision.min(1).max(4), error: z.string().max(500).nullable(),
}).strict()])))();
export const groupExecutionSchema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), kind: z.literal('assistant-group-child'), revision: revision.min(1),
  binding: bindingSchema, setup: phaseSchema, nativeId: uuid.nullable(),
  send: phaseSchema.nullable(), nativeRunId: uuid.nullable(),
  stop: groupStopSchema.nullable(),
  text: z.string().max(262144), nativeTurnId: label.nullable(), effectiveModel: label.nullable(),
}).strict()))();
export type GroupExecution = z.infer<typeof groupExecutionSchema>;
const observationSchema = /* @__PURE__ */ (() => (z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dispatch'), phase: z.enum(['setup', 'send']), proof: groupRuntimeProofSchema }).strict(),
  z.object({ kind: z.literal('failure'), phase: z.enum(['setup', 'send']), message: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal('setup-ready'), nativeId: uuid, proof: groupRuntimeProofSchema }).strict(),
  z.object({ kind: z.literal('send-accepted'), runId: uuid, proof: groupRuntimeProofSchema }).strict(),
  z.object({ kind: z.literal('terminal'), runId: uuid, nativeId: uuid, proof: groupRuntimeProofSchema,
    state: z.enum(['completed', 'failed', 'cancelled']), text: z.string().max(262144),
    nativeTurnId: label.nullable(), effectiveModel: label.nullable() }).strict(),
  z.object({ kind: z.literal('stop-unconfirmed') }).strict(),
  z.object({ kind: z.literal('stop-dispatch'), proof: groupRuntimeProofSchema }).strict(),
  z.object({ kind: z.literal('stop-failure'), message: z.string().min(1).max(500) }).strict(),
])))();
export type GroupExecutionObservation = z.infer<typeof observationSchema>;
export const groupExecutionEventSchema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), kind: z.literal('assistant-group-child-event'), groupId: uuid, attemptId: uuid,
  sequence: revision.min(1).max(groupExecutionEventLimit), at, previousSha256: sha.nullable(),
  command: groupExecutionCommandSchema.nullable(), observation: observationSchema.nullable(),
  value: groupExecutionSchema,
}).strict()))();
export type GroupExecutionEvent = z.infer<typeof groupExecutionEventSchema>;
export const groupExecutionReceiptSchema = /* @__PURE__ */ (() => (z.object({
  format: z.literal(1), kind: z.literal('assistant-group-execution-receipt'), requestId: uuid, epoch: uuid,
  groupId: uuid, attemptId: uuid, sequence: revision.min(1), eventSha256: sha,
}).strict()))();
export type GroupExecutionReceipt = z.infer<typeof groupExecutionReceiptSchema>;

const publicPhaseSchema = /* @__PURE__ */ (() => (phaseSchema.pick({ requestId: true, commandId: true, state: true,
  dispatchStarted: true, error: true }).extend({ canContinueUnsent: z.boolean() }).strict()))();
/** Authenticated saved projection. It carries no reusable runtime lease or credentials. */
export const groupExecutionViewSchema = /* @__PURE__ */ (() => (z.object({
  epoch: uuid, groupId: uuid, attemptId: uuid, roundId: uuid, roundSha256: sha, revision: revision.min(1),
  originalReceipt: groupExecutionReceiptSchema.nullable(), originalCommand: groupExecutionCommandSchema.nullable(),
  account: groupExecutionAccountSchema, sha256: sha, setup: publicPhaseSchema,
  send: publicPhaseSchema.nullable(), stop: groupExecutionSchema.shape.stop,
  canSend: z.boolean(), canStop: z.boolean(), canContinueStop: z.boolean().optional(), observationInFlight: z.boolean(),
  text: z.string().max(262144), nativeTurnId: label.nullable(), effectiveModel: label.nullable(),
  author: z.object({ agentId: bindingSchema.shape.agentId, agentRevision: revision.min(1),
    membershipId: uuid, roundId: uuid }).strict(),
  // The owned lease uses -1 until its first native event arrives.
  activity: z.object({ text: z.string().max(262144), sequence: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
    completionConfirmed: z.literal(false) }).strict().nullable(),
}).strict()))();
export type GroupExecutionView = z.infer<typeof groupExecutionViewSchema>;
export const groupExecutionRejectionSchema = /* @__PURE__ */ (() => (z.object({
  kind: z.literal('assistant-group-execution-rejection'), command: groupExecutionCommandSchema,
}).strict()))();
type Digest = (value: unknown) => string;
type Row = { id: string; revision: number; value: unknown };
type Receipt = { requestId: string; deviceId: string; digest: string; value: unknown };
function need(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function same(a: unknown, b: unknown) { return canonical(a) === canonical(b); }
export const groupExecutionIntent = (command: GroupExecutionCommand) => ({ type: 'assistant.group-execution', ...command });
export function executionChildPrefix(groupId: string, attemptId: string) {
  return `${groupExecutionPrefix}${uuid.parse(groupId)}:${uuid.parse(attemptId)}:`;
}
export const executionValueKey = (groupId: string, attemptId: string) => executionChildPrefix(groupId, attemptId) + 'current';
export const executionEventKey = (event: Pick<GroupExecutionEvent, 'groupId' | 'attemptId' | 'sequence'>) =>
  executionChildPrefix(event.groupId, event.attemptId) + 'event:' + String(event.sequence).padStart(3, '0');
export function hasGroupExecutionReceipt(raw: unknown) {
  return !!raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'assistant-group-execution-receipt';
}
export function executionReceipt(event: GroupExecutionEvent, digest: Digest): GroupExecutionReceipt {
  need(event.command, 'An internal observation is not an owner command receipt.');
  return { format: 1, kind: 'assistant-group-execution-receipt', requestId: event.command.requestId,
    epoch: event.command.epoch, groupId: event.groupId, attemptId: event.attemptId,
    sequence: event.sequence, eventSha256: digest(event) };
}
export function assertGroupExecutionRound(value: GroupExecution, raw: PreparedGroupRound, digest: Digest) {
  const round = preparedGroupRoundSchema.parse(raw), b = value.binding;
  const recipient = round.recipients.find(row => row.attempt.id === b.attemptId);
  need(round.id === b.roundId && round.groupId === b.groupId && digest(round) === b.roundSha256
    && round.epoch === b.epoch && round.deviceId === b.deviceId && recipient
    && recipient.membership.id === b.membershipId && recipient.captured.id === b.agentId
    && recipient.captured.revision === b.agentRevision
    && b.nativeKey === `agent:edition3-group:e3:${b.attemptId}`, 'The original Group child input changed.');
  return recipient;
}
function phase(requestId: string): GroupExecution['setup'] {
  return { requestId, commandId: requestId, state: 'preparing', dispatchStarted: false, attempts: 1, proof: null, error: null };
}
export function assertGroupRuntimeProof(original: GroupRuntimeProof | null, next: GroupRuntimeProof) {
  need(original && original.epoch === next.epoch && original.generation === next.generation
    && original.runtimePid === next.runtimePid && original.runtimeStartedAt === next.runtimeStartedAt
    && original.registrationId === next.registrationId && original.policySha256 === next.policySha256
    && original.sourcePolicySha256 === next.sourcePolicySha256 && original.pluginSha256 === next.pluginSha256
    && original.accountIdentitySha256 === next.accountIdentitySha256,
  'The original Group runtime, configuration or selected account changed.');
}
export function changeGroupExecution(current: GroupExecution | undefined, raw: GroupExecutionCommand,
  deviceId: string, round: PreparedGroupRound, digest: Digest): GroupExecution {
  const command = groupExecutionCommandSchema.parse(raw);
  need(command.epoch === round.epoch && command.groupId === round.groupId && command.roundId === round.id
    && command.roundSha256 === digest(round) && deviceId === round.deviceId, 'The original Group request scope changed.');
  if (!current) {
    need(command.action === 'setup', 'Set up this exact prepared child explicitly before sending.');
    const recipient = round.recipients.find(row => row.attempt.id === command.attemptId);
    need(recipient, 'This child is not a recipient of the original round.');
    return groupExecutionSchema.parse({ format: 1, kind: 'assistant-group-child', revision: 1,
      binding: { epoch: command.epoch, deviceId, groupId: command.groupId, roundId: round.id,
        roundSha256: command.roundSha256, attemptId: command.attemptId, membershipId: recipient.membership.id,
        agentId: recipient.captured.id, agentRevision: recipient.captured.revision, account: command.account,
        nativeKey: `agent:edition3-group:e3:${command.attemptId}` },
      setup: phase(command.requestId), nativeId: null, send: null, nativeRunId: null, stop: null,
      text: '', nativeTurnId: null, effectiveModel: null });
  }
  groupExecutionSchema.parse(current); assertGroupExecutionRound(current, round, digest);
  need(current.binding.deviceId === deviceId && current.binding.attemptId === command.attemptId
    && current.revision === command.expectedRevision, 'The original child revision or device changed.');
  const next = structuredClone(current); next.revision++;
  if (command.action === 'send') {
    need(current.setup.state === 'ready' && current.nativeId && !current.send && !current.stop,
      'This original child is not ready for its first send.');
    next.send = phase(command.requestId);
  } else if (command.action === 'continue-unsent') {
    const originalPhase = current[command.phase];
    need(originalPhase && originalPhase.state === 'failed' && !originalPhase.dispatchStarted
      && originalPhase.attempts < 4
      && originalPhase.requestId === command.originalRequestId && digest(current) === command.expectedSha256
      && !current.stop && (command.phase === 'setup' ? !current.nativeId && !current.send : current.setup.state === 'ready'),
    'Only this exact confirmed unsent original may be continued.');
    next[command.phase] = { ...originalPhase, commandId: command.requestId, attempts: originalPhase.attempts + 1,
      state: 'preparing', error: null };
  } else if (command.action === 'stop') {
    need(current.send?.dispatchStarted && !current.stop
      && !['completed', 'failed', 'cancelled'].includes(current.send.state),
    'Observe this original run; no new stop is available.');
    next.stop = command.stopTracking === 1
      ? { format: 2, requestId: command.requestId, commandId: command.requestId, state: 'requested',
        dispatchStarted: false, attempts: 1, error: null }
      : { requestId: command.requestId, state: 'requested' };
  } else if (command.action === 'continue-stop') {
    const stop = current.stop;
    need(stop && 'format' in stop && stop.format === 2 && stop.state === 'failed' && !stop.dispatchStarted
      && stop.attempts < 4 && stop.requestId === command.originalRequestId && digest(current) === command.expectedSha256
      && current.send?.dispatchStarted && !['completed', 'failed', 'cancelled'].includes(current.send.state),
    'Only this exact proven undispatched original stop may be continued.');
    next.stop = { ...stop, commandId: command.requestId, state: 'requested', attempts: stop.attempts + 1, error: null };
  } else throw Error('This original child already exists; observe it instead of creating another session.');
  return groupExecutionSchema.parse(next);
}
export function observeGroupExecution(current: GroupExecution, raw: GroupExecutionObservation): GroupExecution {
  groupExecutionSchema.parse(current);
  const observation = observationSchema.parse(raw), next = structuredClone(current);
  next.revision++;
  if (observation.kind === 'dispatch') {
    const originalPhase = current[observation.phase];
    need(originalPhase?.state === 'preparing' && !originalPhase.dispatchStarted && !current.stop,
      'The original phase has already reached or passed dispatch.');
    need(observation.proof.epoch === current.binding.epoch, 'The original runtime epoch changed.');
    if (observation.phase === 'send') assertGroupRuntimeProof(current.setup.proof, observation.proof);
    next[observation.phase] = { ...originalPhase, state: 'dispatching', dispatchStarted: true, proof: observation.proof };
  } else if (observation.kind === 'failure') {
    const originalPhase = current[observation.phase];
    need(originalPhase && ['preparing', 'dispatching'].includes(originalPhase.state), 'This phase has already settled.');
    next[observation.phase] = { ...originalPhase, state: originalPhase.dispatchStarted ? 'unknown' : 'failed', error: observation.message };
  } else if (observation.kind === 'setup-ready') {
    need(current.setup.dispatchStarted && ['dispatching', 'unknown'].includes(current.setup.state)
      && !current.nativeId, 'This is not an unresolved original setup.');
    assertGroupRuntimeProof(current.setup.proof, observation.proof);
    next.nativeId = observation.nativeId; next.setup = { ...current.setup, state: 'ready', error: null };
  } else if (observation.kind === 'send-accepted') {
    need(current.send?.dispatchStarted && ['dispatching', 'unknown'].includes(current.send.state)
      && observation.runId === current.send.requestId, 'The native acknowledgement is not this original send.');
    assertGroupRuntimeProof(current.send.proof, observation.proof);
    next.nativeRunId = observation.runId; next.send = { ...current.send, state: 'accepted', error: null };
  } else if (observation.kind === 'terminal') {
    need(current.send?.dispatchStarted && !['completed', 'failed', 'cancelled'].includes(current.send.state)
      && observation.runId === current.send.requestId && observation.nativeId === current.nativeId,
    'The native terminal observation belongs to a different or settled original run.');
    assertGroupRuntimeProof(current.send.proof, observation.proof);
    next.nativeRunId = observation.runId; next.send = { ...current.send, state: observation.state, error: null };
    next.text = observation.text; next.nativeTurnId = observation.nativeTurnId; next.effectiveModel = observation.effectiveModel;
    if (next.stop && observation.state === 'cancelled') next.stop.state = 'confirmed';
  } else if (observation.kind === 'stop-dispatch') {
    const stop = current.stop;
    need(stop && 'format' in stop && stop.format === 2 && stop.state === 'requested' && !stop.dispatchStarted
      && current.send?.dispatchStarted && !['completed', 'failed', 'cancelled'].includes(current.send.state),
    'The original stop is not available for its first native dispatch.');
    assertGroupRuntimeProof(current.send.proof, observation.proof);
    next.stop = { ...stop, dispatchStarted: true, error: null };
  } else if (observation.kind === 'stop-failure') {
    const stop = current.stop;
    need(stop && 'format' in stop && stop.format === 2 && stop.state === 'requested' && !stop.dispatchStarted,
      'Only the live original stop may prove failure before dispatch.');
    next.stop = { ...stop, state: 'failed', error: observation.message };
  } else {
    need(current.stop?.state === 'requested', 'No original unconfirmed stop exists.');
    next.stop = { ...current.stop, state: 'unconfirmed' };
  }
  return groupExecutionSchema.parse(next);
}
/** Complete append-only replay, with receipt linkage in both directions. Even
 * removing every child row cannot turn a retained original receipt into success. */
export function verifyGroupExecutions(schema: number, records: Row[], receipts: Receipt[],
  round: (groupId: string, roundId: string) => PreparedGroupRound | undefined, digest: Digest) {
  const rows = records.filter(row => row.id.startsWith(groupExecutionPrefix));
  const originals = receipts.filter(row => hasGroupExecutionReceipt(row.value));
  need(schema >= 59 || !rows.length && !originals.length, 'Group execution needs a compatible workspace schema.');
  const results = new Map<string, { value: GroupExecution; events: GroupExecutionEvent[] }>();
  const grouped = new Map<string, Row[]>(), matchedReceipts = new Set<string>(), unique = new Set<string>();
  const groupBytes = new Map<string, number>();
  for (const row of rows) {
    need(!unique.has(row.id), 'A Group execution identity is duplicated.'); unique.add(row.id);
    const match = /^assistant:group-execution:([0-9a-f-]{36}):([0-9a-f-]{36}):(current|event:\d{3})$/.exec(row.id);
    need(match, 'An unsupported Group execution record is retained.');
    const bytes = (groupBytes.get(match[1]) ?? 0) + new TextEncoder().encode(canonical(row.value)).byteLength;
    need(bytes <= groupExecutionGroupBytes, 'This Group execution history exceeds its retained byte bound.');
    groupBytes.set(match[1], bytes);
    const prefix = executionChildPrefix(match[1], match[2]);
    const group = grouped.get(prefix) ?? []; group.push(row); grouped.set(prefix, group);
  }
  const receiptMap = new Map<string, Receipt>();
  for (const receipt of originals) { need(!receiptMap.has(receipt.requestId), 'An original Group execution receipt is duplicated.'); receiptMap.set(receipt.requestId, receipt); }
  for (const [prefix, children] of grouped) {
    need(children.length <= groupExecutionEventLimit + 1
      && new TextEncoder().encode(canonical(children)).byteLength <= groupExecutionChildBytes, 'The original child exceeds its supported history bound.');
    const values = children.filter(row => row.id === prefix + 'current');
    need(values.length === 1, 'An original Group child is missing.');
    const saved = groupExecutionSchema.parse(values[0].value);
    const events = children.filter(row => row.id !== prefix + 'current')
      .sort((a, b) => a.id.localeCompare(b.id)).map(row => {
        const event = groupExecutionEventSchema.parse(row.value);
        need(row.revision === 1 && row.id === executionEventKey(event), 'A Group child event was replaced.');
        return event;
      });
    need(events.length > 0 && values[0].revision === events.length, 'The complete original child history is unavailable.');
    let current: GroupExecution | undefined;
    for (const event of events) {
      need(event.sequence === (current?.revision ?? 0) + 1 && event.value.revision === event.sequence
        && event.previousSha256 === (current ? digest(current) : null)
        && !!event.command !== !!event.observation, 'An original Group transition is missing or ambiguous.');
      const source = round(event.groupId, event.value.binding.roundId);
      need(source, 'The exact original prepared Group round is unavailable.');
      const next = event.command ? changeGroupExecution(current, event.command, event.value.binding.deviceId, source, digest)
        : (need(current, 'A child observation has no original command.'), observeGroupExecution(current, event.observation!));
      assertGroupExecutionRound(next, source, digest);
      need(event.groupId === next.binding.groupId && event.attemptId === next.binding.attemptId
        && prefix === executionChildPrefix(event.groupId, event.attemptId) && same(next, event.value),
      'The saved Group transition differs from its original command or observation.');
      if (event.command) {
        const receipt = receiptMap.get(event.command.requestId);
        need(receipt && !matchedReceipts.has(receipt.requestId)
          && receipt.deviceId === next.binding.deviceId && receipt.digest === digest(groupExecutionIntent(event.command))
          && same(groupExecutionReceiptSchema.parse(receipt.value), executionReceipt(event, digest)),
        'The exact original Group execution receipt is unavailable or changed.');
        matchedReceipts.add(receipt.requestId);
      }
      current = next;
    }
    need(current && same(current, saved), 'The saved child does not match its complete original history.');
    results.set(prefix, { value: saved, events });
  }
  need(matchedReceipts.size === originals.length, 'An original Group execution receipt has no complete child history.');
  return results;
}
