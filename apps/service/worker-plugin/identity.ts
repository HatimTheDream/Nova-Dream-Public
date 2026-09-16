import { createHash } from 'node:crypto';
import { assignmentRuntimeAgent, assignmentNativeRuntimeAgent } from '../../../packages/domain/agent-capabilities.js';
import type { WorkerIdentity } from '../../../packages/domain/worker.js';

export const workerInputHash = (message: string) => createHash('sha256').update(message, 'utf8').digest('hex');
export function workerNativeIdentity(input: Pick<WorkerIdentity, 'epoch' | 'hostId' | 'attemptId' | 'toolMode' | 'nativeTools'>) {
  const bytes = createHash('sha256').update(`edition3-worker-v1:${input.epoch}:${input.hostId}:${input.attemptId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const runId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  // The pinned native agent preflight assigns runId = idempotencyKey. Keep that
  // identity before dispatch, and verify the SDK acknowledgment rather than
  // treating this expected identity as evidence that execution was accepted.
  return { runId, sessionKey: `agent:${input.toolMode === 'workspace' ? input.nativeTools?.length ? assignmentNativeRuntimeAgent : assignmentRuntimeAgent : 'main'}:e3-assignment-${runId}` };
}
