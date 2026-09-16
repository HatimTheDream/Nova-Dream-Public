import type { AssignmentAttempt } from './assignments.js';
import type { AgentRoutine } from './agent-routines.js';
import type { AgentDesign, Content } from './workspace-records.js';
import type { Task } from './contracts.js';
import type { HubLayout } from './hub-layout.js';

export type AssignmentActivity = Pick<AssignmentAttempt, 'id' | 'assignmentId' | 'assignmentRevision' | 'agentId' | 'agentRevision' | 'agentName' | 'title' | 'projectId' | 'createdAt' | 'updatedAt' | 'deadlineAt' | 'state' | 'message' | 'stopReason' | 'unresolvedReview' | 'routine'> & { result?: Pick<NonNullable<AssignmentAttempt['result']>, 'file' | 'disposition'> };
export const activityOf = (attempt: AssignmentAttempt): AssignmentActivity => {
  const { id, assignmentId, assignmentRevision, agentId, agentRevision, agentName, title, projectId, createdAt, updatedAt, deadlineAt, state, message, stopReason, unresolvedReview, routine, result } = attempt;
  return { id, assignmentId, assignmentRevision, agentId, agentRevision, agentName, title, projectId, createdAt, updatedAt, deadlineAt, state, message, ...(stopReason ? { stopReason } : {}), ...(unresolvedReview ? { unresolvedReview } : {}), ...(routine ? { routine } : {}), ...(result ? { result: { file: result.file, disposition: result.disposition } } : {}) };
};
export type HubStatus = 'working' | 'waiting-owner' | 'waiting-provider' | 'failed' | 'offline' | 'idle';
export type HubAgent = {
  id: string; revision: number; name: string; position: string; appearance: AgentDesign['appearance']; archived: boolean;
  status: HubStatus; reason: string; active: AssignmentActivity | null;
  returned: number; unresolved: number; latest: AssignmentActivity | null;
  plans: { id: string; revision: number; title: string; projectId: string | null }[];
  routines: (Pick<AgentRoutine, 'id' | 'revision' | 'nextAt' | 'attention'> & { name: string; timezone: string })[];
  tasks: { id: string; title: string; status: Task['status'] }[];
  content: { id: string; title: string; stage: Content['stage'] }[];
  reviews: { attemptId: string; assignmentId: string; title: string; count: number }[];
  appliedChanges: number;
};
export type HubMember = Pick<HubAgent, 'id' | 'revision' | 'name' | 'position' | 'appearance' | 'archived' | 'status' | 'reason'>;
export type HubState = { observedAt: number; runtimeReady: boolean; runtimeReason: string; agents: HubAgent[]; roster: HubMember[]; layout: HubLayout; total: number; nextCursor: string | null; activeAgentId: string | null };
export function hubStatus(active: AssignmentActivity | undefined, ready: boolean, latest?: AssignmentActivity, pendingChanges = 0, approvalWaiting = false): { status: HubStatus; reason: string } {
  if (active) {
    if (approvalWaiting && ready) return { status: 'waiting-owner', reason: 'An action needs your approval. Open the assignment to review it.' };
    if (active.state === 'running' && ready) return { status: 'working', reason: active.message };
    if (!ready) return { status: 'waiting-provider', reason: 'The worker connection is unavailable. This original attempt still needs reconciliation.' };
    return { status: active.state === 'prepared' || active.state === 'dispatching' ? 'waiting-provider' : 'waiting-owner', reason: active.message };
  }
  if (pendingChanges) return { status: 'waiting-owner', reason: `${pendingChanges} workspace ${pendingChanges === 1 ? 'change needs' : 'changes need'} your review.` };
  if (latest?.state === 'failed') return { status: 'failed', reason: `Last attempt failed. ${latest.message}` };
  return ready ? { status: 'idle', reason: 'No assignment is running for this agent.' } : { status: 'offline', reason: 'Connect the Assistant on this host to run assignments.' };
}
