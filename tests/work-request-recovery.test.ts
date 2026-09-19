import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../apps/client/src/api';
import { workRequestRejected } from '../apps/client/src/work-request';
import { runRetainedTeamAction, runRetainedTeamStart, type PendingTeamAction, type PendingTeamStart } from '../apps/client/src/team-work-action';
import type { TeamWork } from '../packages/domain/team-work';

const gates = [
  [401, 'session_expired'], [401, 'session_changed'], [403, 'origin_rejected'],
  [403, 'host_rejected'], [403, 'client_required'], [403, 'phone_pair_required'],
  [409, 'client_update'], [409, 'epoch_changed'], [409, 'request_reused'],
  [400, 'validation'], [413, 'too_large'], [404, 'not_found'],
  [409, 'github_disconnected'], [409, 'github_account_changed'], [409, 'github_request'],
] as const;
type Options<T, R> = { read(): T | undefined; write(value: T | null): boolean; retained(value: T): void; send(value: T): Promise<R> };
type Result<T> = { pending?: T; confirmed: boolean };

async function verifyRecovery<T extends { requestId: string }, R>(original: T, response: R, run: (options: Options<T, R>, command?: T) => Promise<Result<T>>) {
  for (const [status, code] of gates) {
    let saved: T | undefined, stage: 'lost' | 'gated' | 'ready' = 'lost', executions = 0;
    const receipts = new Map<string, R>();
    const options: Options<T, R> = {
      read: () => saved,
      write: value => { saved = value ?? undefined; return true; },
      retained() {},
      async send(command) {
        // These server gates run before an endpoint can read its original receipt.
        if (stage === 'gated') throw new ApiError(code, 'Reconnect or reload first.', undefined, status);
        if (!receipts.has(command.requestId)) { executions++; receipts.set(command.requestId, response); }
        if (stage === 'lost') throw Error('The successful response was lost.');
        return receipts.get(command.requestId)!;
      },
    };
    await run(options, original);
    assert.equal(executions, 1);
    stage = 'gated';
    const blocked = await run(options);
    assert.equal(blocked.confirmed, false);
    assert.deepEqual(blocked.pending, original, `${code} must retain the original request`);
    assert.deepEqual(saved, original);
    stage = 'ready';
    const restored = await run(options, { ...original, requestId: 'new-after-reconnect' });
    assert.equal(restored.confirmed, true); assert.equal(restored.pending, undefined);
    assert.equal(executions, 1, `${code} must not duplicate the original execution`);
  }
}

test('a lost team start survives authentication, update and workspace gates before reconciliation', async () => {
  const command: PendingTeamStart = { requestId: 'original-start', epoch: 'epoch', projectId: 'project', title: 'Original work', brief: 'Keep the original brief.', maxMinutes: 10, steps: [{ agentId: 'builder', role: 'build' }, { agentId: 'reviewer', role: 'review' }] };
  await verifyRecovery(command, { id: 'original-team' } as TeamWork, runRetainedTeamStart);
});

for (const action of ['retry', 'apply_findings'] as const) test(`an uncertain ${action} retains its identity across pre-admission gates`, async () => {
  const command: PendingTeamAction = { requestId: 'original-action', epoch: 'epoch', id: 'team', revision: 4, action };
  await verifyRecovery(command, undefined, runRetainedTeamAction);
});

test('known team, checkout, publication and browser preconditions remain correctable', () => {
  for (const code of ['team_project', 'team_agent', 'team_changed', 'team_review_changed', 'team_retry_unconfirmed', 'work_preparing', 'work_changed', 'work_uncommitted', 'browser_tab', 'browser_stale']) {
    assert.equal(workRequestRejected(new ApiError(code, 'Review this operation.', undefined, 409)), true, code);
  }
  for (const code of ['team_closing', 'host_unavailable', 'request_failed', 'team_missing', 'browser_reused', 'new_future_error']) {
    assert.equal(workRequestRejected(new ApiError(code, 'Original result unavailable.', undefined, 409)), false, code);
  }
  assert.equal(workRequestRejected(new Error('Network disconnected')), false);
  assert.equal(workRequestRejected(new ApiError('team_project', 'Proxy failed.', undefined, 502)), false);
});
