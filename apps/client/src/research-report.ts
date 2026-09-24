import type { AssistantOperation, ConversationMessage } from '../../../packages/domain/assistant';

export function researchReportOperation(message: ConversationMessage, operations: AssistantOperation[], conversationId: string, nativeId?: string, space: 'chat' | 'work' = 'chat'): AssistantOperation | undefined {
  if (message.role !== 'assistant' || message.toolInfo || !message.text.trim()) return undefined;
  return operations.find(operation => operation.conversationId === conversationId && !operation.steerTarget
    && (operation.context.space ?? space) === 'chat'
    && (operation.context.researchWorkflow !== 'chat-research-v1' || !!operation.context.approvedPlan && !operation.context.planReview)
    && operation.state === 'completed' && operation.context.workMode === 'research' && operation.text === message.text
    && operation.nativeId === (message.source?.nativeId ?? nativeId)
    && (!message.source || message.source.nativeKey === operation.nativeKey && message.source.connectionGeneration === operation.connectionGeneration)
    && (message.operationId ? message.operationId === operation.id && (!message.runId || !operation.nativeRunId || message.runId === operation.nativeRunId) : !!message.runId && message.runId === operation.nativeRunId));
}

export function isResearchReport(message: ConversationMessage, operations: AssistantOperation[], conversationId: string, nativeId?: string, space: 'chat' | 'work' = 'chat'): boolean {
  return !!researchReportOperation(message, operations, conversationId, nativeId, space);
}
