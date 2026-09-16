import { assignmentTerminal, type AssignmentAttempt } from './assignments.js';
import type { ReviewApproval } from './approvals.js';

/** Attention belongs to the exact live attempt, never a previous session. */
export function assignmentNeedsApproval(attempt: AssignmentAttempt, items: readonly ReviewApproval[], now = Date.now()): boolean {
  if (assignmentTerminal(attempt.state) || attempt.stopReason || now >= attempt.deadlineAt) return false;
  return items.some(item => item.conversationId === attempt.id && item.epoch === attempt.epoch
    && item.connectionGeneration === attempt.connectionGeneration && item.nativeKey === attempt.sessionKey
    && item.nativeId === attempt.nativeSessionId && (item.action?.state === 'unknown'
      || item.snapshot.status === 'pending' && now < item.snapshot.expiresAtMs));
}
