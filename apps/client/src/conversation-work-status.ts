import type { AssistantController } from './useAssistant';

type RowState = Pick<AssistantController, 'operations' | 'connection' | 'statusRead' | 'approvals' | 'questions'>;

/** Present only the existing state response; never infer completion from silence. */
export function conversationWorkStatus(conversationId: string, state: RowState): string | undefined {
  const active = state.operations.filter(operation => operation.conversationId === conversationId && !['completed', 'failed', 'cancelled'].includes(operation.state));
  if (!active.length) return;
  if (state.statusRead !== 'ready' || state.connection.state !== 'ready' || active.some(operation => operation.state === 'unknown' || operation.connectionGeneration !== state.connection.generation)) return 'Status unconfirmed';
  if (active.some(operation => operation.cancelRequested)) return 'Stop requested';
  const pendingApproval = state.approvals?.state === 'ready' && state.approvals.items.some(item => item.conversationId === conversationId && item.connectionGeneration === state.connection.generation && item.snapshot.status === 'pending');
  const pendingQuestion = state.questions?.state === 'ready' && state.questions.items.some(item => item.conversationId === conversationId && item.connectionGeneration === state.connection.generation && item.availability === 'live' && !item.dismissed && item.snapshot.status === 'pending');
  if (pendingApproval || pendingQuestion) return 'Needs input';
  if (active.some(operation => operation.state === 'running')) return 'Working';
  return 'Starting';
}
