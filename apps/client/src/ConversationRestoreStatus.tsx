import type { Conversation } from '../../../packages/domain/assistant';

export function ConversationRestoreStatus({ conversation, connected, busy, checkStatus }: { conversation?: Conversation; connected: boolean; busy: boolean; checkStatus: () => void }) {
  if (!conversation?.nativeRestorePending) return null;
  return <div className="history-status" role="status"><span>{connected ? 'Chat restored. Confirm the original connection before starting new work.' : 'Chat restored. Reconnect the Assistant, then check status.'} Your draft and history are kept.</span><button disabled={busy || !connected} onClick={checkStatus}>Check status</button></div>;
}
