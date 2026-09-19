import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../apps/client/src/api';
import type { TeamWork } from '../packages/domain/team-work';
import { runRetainedTeamStart, type PendingTeamStart } from '../apps/client/src/team-work-action';

const command: PendingTeamStart = { requestId: 'original-start', epoch: 'epoch', projectId: 'project', title: 'Original work', brief: 'Keep the original instructions.', maxMinutes: 10,
  steps: [{ role: 'build', agentId: 'maker' }, { role: 'review', agentId: 'reviewer' }],
};
const workflow = { id: 'original-workflow' } as TeamWork;

test('a lost start response reconciles the saved brief once, even when a mounted form offers newer work', async () => {
  let saved: PendingTeamStart | undefined, drop = true, starts = 0;
  const receipts = new Map<string, TeamWork>(), sent: PendingTeamStart[] = [];
  const options = () => ({ read: () => saved, write(value: PendingTeamStart | null) { saved = value ? structuredClone(value) : undefined; return true; }, retained() {}, async send(value: PendingTeamStart) {
    sent.push(structuredClone(value));
    if (!receipts.has(value.requestId)) { starts++; receipts.set(value.requestId, workflow); }
    if (drop) { drop = false; throw Error('Response lost'); }
    return receipts.get(value.requestId)!;
  } });
  const lost = await runRetainedTeamStart(options(), command);
  assert.equal(lost.confirmed, false); assert.deepEqual(lost.pending, command); assert.equal(starts, 1);
  const recovered = await runRetainedTeamStart(options(), { ...command, requestId: 'new-start', title: 'Newer work', brief: 'Different instructions.' });
  assert.equal(recovered.confirmed, true); assert.equal(recovered.response?.id, workflow.id);
  assert.equal(recovered.pending, undefined); assert.equal(saved, undefined);
  assert.deepEqual(sent, [command, command]); assert.equal(starts, 1);
});

test('failed receipt cleanup keeps a confirmed start available to reconcile instead of allowing a duplicate', async () => {
  let saved: PendingTeamStart | undefined, clear = false;
  const sent: PendingTeamStart[] = [];
  const options = { read: () => saved, write(value: PendingTeamStart | null) { if (!value && !clear) return false; saved = value ?? undefined; return true; }, retained() {}, async send(value: PendingTeamStart) { sent.push(value); return workflow; } };
  const confirmed = await runRetainedTeamStart(options, command);
  assert.equal(confirmed.confirmed, true); assert.deepEqual(confirmed.pending, command); assert.equal(confirmed.response?.id, workflow.id);
  assert.match(confirmed.error, /local receipt could not clear/);
  clear = true;
  const reconciled = await runRetainedTeamStart(options, { ...command, requestId: 'new-start' });
  assert.equal(reconciled.confirmed, true); assert.equal(reconciled.pending, undefined); assert.equal(saved, undefined);
  assert.deepEqual(sent, [command, command]);
});

test('a failed receipt write never dispatches and does not discard an uncertain in-memory start', async () => {
  let calls = 0;
  const result = await runRetainedTeamStart({ read: () => undefined, write: () => false, retained() {}, async send() { calls++; return workflow; } }, command);
  assert.equal(calls, 0); assert.equal(result.confirmed, false); assert.deepEqual(result.pending, command);
  assert.match(result.error, /Free browser storage/);
});

test('a late start response preserves another window’s receipt, including after a definitive rejection', async () => {
  const newer = { ...command, requestId: 'other-window', title: 'Another saved start' };
  for (const rejected of [false, true]) {
    let saved: PendingTeamStart | undefined;
    const result = await runRetainedTeamStart({ read: () => saved, write(value) { saved = value ?? undefined; return true; }, retained() {}, async send() {
      saved = newer;
      if (rejected) throw new ApiError('team_project', 'Review this project.', undefined, 409);
      return workflow;
    } }, command);
    assert.equal(result.confirmed, !rejected); assert.deepEqual(result.pending, newer); assert.deepEqual(saved, newer);
  }
});

test('only a definitive rejection with successful cleanup releases a retained start', async () => {
  let saved: PendingTeamStart | undefined = command, clear = false;
  const options = { read: () => saved, write(value: PendingTeamStart | null) { if (!value && !clear) return false; saved = value ?? undefined; return true; }, retained() {}, async send(): Promise<TeamWork> { throw new ApiError('team_project', 'Review this project.', undefined, 409); } };
  const retained = await runRetainedTeamStart(options);
  assert.equal(retained.confirmed, false); assert.deepEqual(retained.pending, command);
  clear = true;
  options.send = async () => { throw new ApiError('host_unavailable', 'Host disconnected.', undefined, 403); };
  const uncertain = await runRetainedTeamStart(options);
  assert.equal(uncertain.confirmed, false); assert.deepEqual(uncertain.pending, command);
  options.send = async () => { throw new ApiError('team_project', 'Review this project.', undefined, 409); };
  const rejected = await runRetainedTeamStart(options);
  assert.equal(rejected.confirmed, false); assert.equal(rejected.pending, undefined); assert.equal(saved, undefined);
});
