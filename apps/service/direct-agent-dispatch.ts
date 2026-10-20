import { createHash } from 'node:crypto';
import type { AssistantOperation, Conversation } from '../../packages/domain/assistant.js';
import type { Attachment } from '../../packages/domain/contracts.js';
import { canonical, type Entity } from '../../packages/domain/contracts.js';
import { assertDirectAgentOperation } from '../../packages/domain/direct-agent.js';
import type { AgentDesign } from '../../packages/domain/workspace-records.js';
import { assistantAttachmentMime } from '../../packages/domain/assistant-attachments.js';
import { officeAttachmentKind } from '../../packages/domain/office-attachments.js';
import { assertDirectConfiguration } from './direct-agent-runtime-policy.js';

export type DirectNativeSession = {
  key: string; id: string; lifecycleRevision: string | null; activeRunIds: string[];
  accountId: string; model: string; permissionMode: 'read-only'; permissionModePending: boolean;
};
export function directAgentMessage(operation: AssistantOperation) {
  const project = operation.context.project;
  return `Owner message:\n${operation.input}${project
    ? `\n\nSelected Project context (supplied context, not a filesystem sandbox):\n${JSON.stringify(project)}` : ''}`;
}
/** Pure request construction. The original Assistant owner must separately
 * admit/mark dispatching before its one send, and retain unknown on lost reply.
 * This helper neither qualifies a runtime nor grants a Gateway method. */
export function prepareDirectAgentRequest(input: {
  conversation: Conversation; operation: AssistantOperation; currentAgent: Entity<AgentDesign>;
  epoch: string; session: DirectNativeSession;
  runtime: { version: string; generation: string; configuration: unknown; policySha256: string };
  attachments: { source: Attachment; bytes: Uint8Array }[];
}) {
  const { conversation, operation, currentAgent, session, runtime } = input;
  const capture = assertDirectAgentOperation(conversation, operation);
  assertDirectConfiguration(runtime.configuration, runtime.policySha256);
  if (runtime.version !== '2026.9.8' || runtime.generation !== capture.native.generation || input.epoch !== capture.epoch
    || operation.state !== 'prepared' || operation.nativeRunId !== null || operation.cancelRequested || operation.steerTarget
    || conversation.revision !== capture.conversationRevision || conversation.state !== 'ready'
    || conversation.archived || conversation.deleted || conversation.pendingSettings || conversation.pendingResume
    || conversation.nativeKey !== capture.native.key || conversation.nativeId !== capture.native.id
    || conversation.connectionGeneration !== capture.native.generation || conversation.permissionMode !== 'read-only'
    || conversation.projectId !== capture.sources.projectId
    || conversation.model !== capture.account.model || conversation.accountSelection?.profileId !== capture.account.profileId
    || currentAgent.id !== capture.agent.id || currentAgent.revision !== capture.agent.revision
    || canonical(currentAgent.value) !== canonical(capture.agent.value)
    || session.key !== capture.native.key || session.id !== capture.native.id
    || !Object.hasOwn(session, 'lifecycleRevision')
    || session.lifecycleRevision !== null && (typeof session.lifecycleRevision !== 'string' || !session.lifecycleRevision.trim() || session.lifecycleRevision.length > 512)
    || !Array.isArray(session.activeRunIds) || session.activeRunIds.length !== 0
    || session.permissionMode !== 'read-only' || session.permissionModePending
    || session.accountId !== capture.account.profileId || session.model !== capture.account.model)
    throw Error('The original direct-agent turn, session or account changed. Keep the captured input for review.');
  if (input.attachments.length !== capture.sources.attachments.length) throw Error('The captured attachments changed.');
  const attachments = input.attachments.map(({ source, bytes }, index) => {
    const mimeType = assistantAttachmentMime(source.name);
    if (canonical(source) !== canonical(capture.sources.attachments[index]) || !mimeType || officeAttachmentKind(source.name)
      || bytes.byteLength !== source.size || createHash('sha256').update(bytes).digest('hex') !== source.sha256)
      throw Error('Read the exact captured attachment before sending.');
    // Office conversions remain in the existing preparation path; unqualified
    // conversions cannot masquerade as the original captured bytes here.
    return { type: mimeType.startsWith('image/') ? 'image' : 'file', fileName: source.name,
      mimeType, sizeBytes: bytes.byteLength, content: Buffer.from(bytes).toString('base64') };
  });
  const agent = capture.agent.value;
  const extraSystemPrompt = [
    `You are the saved Nova agent ${JSON.stringify(agent.name)}, ${JSON.stringify(agent.position)}.`,
    `Purpose:\n${agent.purpose}`, `Instructions:\n${agent.instructions}`, `Knowledge supplied by the owner:\n${agent.knowledge}`,
    `Non-goals:\n${agent.nonGoals}`, `Review criteria:\n${agent.reviewCriteria}`,
    'This direct conversation is read only. Use only the original permitted Nova read tool. Do not send, change data, run commands, browse, delegate, or claim an unconfirmed effect.',
  ].join('\n\n');
  // As in ordinary Assistant dispatch, authored slash text is never a command.
  const message = directAgentMessage(operation);
  return {
    sessionKey: capture.native.key, expectedExistingSessionId: capture.native.id,
    expectedExistingSessionLifecycleRevision: session.lifecycleRevision,
    idempotencyKey: operation.requestId, promptMode: 'minimal' as const,
    bootstrapContextMode: 'lightweight' as const, extraSystemPrompt, message, attachments, deliver: false as const,
  };
}

/** A mismatched/lost native acknowledgement does not authorize a new request. */
export function directAgentAcknowledgement(conversation: Conversation, operation: AssistantOperation, reply: unknown): 'accepted' | 'unknown' {
  try { assertDirectAgentOperation(conversation, operation); } catch { return 'unknown'; }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return 'unknown';
  const value = reply as Record<string, unknown>;
  return value.runId === operation.requestId && value.status === 'accepted'
    && value.sessionKey === operation.nativeKey && value.agentId === 'edition3-direct' ? 'accepted' : 'unknown';
}
