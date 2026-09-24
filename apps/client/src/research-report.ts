import type { AssistantOperation, ConversationMessage } from '../../../packages/domain/assistant';

export function isResearchReport(message: ConversationMessage, operations: AssistantOperation[], conversationId: string, nativeId?: string): boolean {
  if (message.role !== 'assistant' || message.toolInfo || !message.text.trim()) return false;
  return operations.some(operation => operation.conversationId === conversationId && !operation.steerTarget
    && operation.state === 'completed' && operation.context.workMode === 'research' && operation.text === message.text
    && operation.nativeId === (message.source?.nativeId ?? nativeId)
    && (!message.source || message.source.nativeKey === operation.nativeKey && message.source.connectionGeneration === operation.connectionGeneration)
    && (message.operationId ? message.operationId === operation.id && (!message.runId || !operation.nativeRunId || message.runId === operation.nativeRunId) : !!message.runId && message.runId === operation.nativeRunId));
}
