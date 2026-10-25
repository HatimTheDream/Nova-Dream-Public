import { createHash } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';
import { assertGroupExecutionRound, groupRuntimeAgent, type GroupExecution } from '../../packages/domain/assistant-group-execution.js';
import { groupContextMessage, type GroupPreparationBundle, type PreparedGroupRound } from '../../packages/domain/assistant-group-turns.js';
import type { GroupOwnerObservation } from './group-execution-owner.js';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Pure construction from an immutable, verified common-context manifest.
 * Historical inputs are explicit data; sibling output and personal history are
 * never read. The runtime/tool policy separately enforces no dynamic tools. */
export function groupExecutionRequest(child: GroupExecution, round: PreparedGroupRound,
  preparation: GroupPreparationBundle, observed: GroupOwnerObservation) {
  const recipient = assertGroupExecutionRound(child, round, digest), session = observed.policy.session;
  if (!child.send || child.send.state !== 'preparing' || child.send.dispatchStarted || child.stop
    || !session || session.id !== child.nativeId || session.key !== child.binding.nativeKey
    || session.accountId !== child.binding.account.profileId || session.model !== child.binding.account.model
    || observed.policy.agentId !== groupRuntimeAgent || observed.account.profileId !== child.binding.account.profileId)
    throw Error('The original Group child is not admitted to this session/account.');
  for (const ref of round.context.history) {
    const prior = preparation.rounds.get(ref.roundId);
    if (!prior || digest(prior) !== ref.sha256 || prior.sequence >= round.sequence)
      throw Error('The exact common historical input is unavailable.');
  }
  const agent = recipient.captured.value;
  const extraSystemPrompt = [
    `You are the saved Nova Group recipient ${JSON.stringify(agent.name)}, ${JSON.stringify(agent.position)}.`,
    `Purpose:\n${agent.purpose}`, `Instructions:\n${agent.instructions}`, `Knowledge supplied by the owner:\n${agent.knowledge}`,
    `Non-goals:\n${agent.nonGoals}`, `Review criteria:\n${agent.reviewCriteria}`,
    'Use only the explicitly provided common context. You have no tools. Do not send, modify records, browse, run commands, delegate, or claim an unconfirmed effect. Other recipients receive this same common context independently.',
  ].join('\n\n');
  const message = groupContextMessage(round.text, round.context, preparation.rounds);
  if (Buffer.byteLength(extraSystemPrompt) > 120000 || Buffer.byteLength(message) > 250000)
    throw Error('This exact Group input exceeds the supported native request bound. Its prepared writing is kept.');
  return { sessionKey: child.binding.nativeKey, expectedExistingSessionId: child.nativeId,
    expectedExistingSessionLifecycleRevision: session.lifecycleRevision, idempotencyKey: child.send.requestId,
    promptMode: 'minimal' as const, bootstrapContextMode: 'lightweight' as const, extraSystemPrompt,
    message, attachments: [], deliver: false as const };
}
export function groupAcknowledgement(child: GroupExecution, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !child.send) return false;
  const value = raw as Record<string, unknown>;
  return value.runId === child.send.requestId && value.status === 'accepted'
    && value.sessionKey === child.binding.nativeKey && value.agentId === groupRuntimeAgent;
}
