import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../apps/client/src/api';
import { runRetainedTeamAction, type PendingTeamAction } from '../apps/client/src/team-work-action';

const command: PendingTeamAction = { requestId: 'original-findings', epoch: 'epoch', id: 'team', revision: 12, action: 'apply_findings' };
test('a lost Apply findings response replays the same saved command after reload, even when newer state is offered', async () => {
  let saved: PendingTeamAction | undefined, drop = true, rounds = 0;
  const receipts = new Set<string>(), sent: PendingTeamAction[] = [];
  const options = () => ({ read: () => saved, write(value: PendingTeamAction | null) { saved = value ? structuredClone(value) : undefined; return true; }, retained() {}, async send(value: PendingTeamAction) {
    sent.push(structuredClone(value)); if (!receipts.has(value.requestId)) { receipts.add(value.requestId); rounds++; }
    if (drop) { drop = false; throw Error('Response lost'); }
  } });
  const lost = await runRetainedTeamAction(options(), command);
  assert.equal(lost.confirmed, false); assert.deepEqual(lost.pending, command); assert.equal(rounds, 1);
  const recovered = await runRetainedTeamAction(options(), { ...command, requestId: 'newer-request', revision: 20 });
  assert.equal(recovered.confirmed, true); assert.equal(recovered.pending, undefined); assert.equal(saved, undefined);
  assert.deepEqual(sent, [command, command]); assert.equal(rounds, 1);
});
test('legacy retries remain original requests and definitive rejection clears only the matching command', async () => {
  let saved: PendingTeamAction | undefined = { ...command, action: 'retry' };
  const options = { read: () => saved, write(value: PendingTeamAction | null) { saved = value ?? undefined; return true; }, retained() {}, async send(value: PendingTeamAction) { assert.equal(value.action, 'retry'); throw new ApiError('team_changed', 'Refresh this workflow.', undefined, 409); } };
  const result = await runRetainedTeamAction(options, command);
  assert.equal(result.pending, undefined); assert.equal(saved, undefined); assert.equal(result.error, 'Refresh this workflow.');
  options.send = async () => { throw new ApiError('host_unavailable', 'Disconnected', undefined, 403); };
  const uncertain = await runRetainedTeamAction(options, command);
  assert.deepEqual(uncertain.pending, command); assert.deepEqual(saved, command);
});
test('storage failures never dispatch unretained work and retain a confirmed request when receipt cleanup fails', async () => {
  let saved: PendingTeamAction | undefined, writes = false, clear = false, calls = 0;
  const options = { read: () => saved, write(value: PendingTeamAction | null) { if (!writes || !value && !clear) return false; saved = value ?? undefined; return true; }, retained() {}, async send() { calls++; } };
  const blocked = await runRetainedTeamAction(options, command); assert.equal(blocked.confirmed, false); assert.equal(calls, 0);
  writes = true; const received = await runRetainedTeamAction(options, command);
  assert.equal(received.confirmed, true); assert.deepEqual(received.pending, command); assert.match(received.error, /local receipt could not clear/);
  clear = true; const cleared = await runRetainedTeamAction(options); assert.equal(cleared.confirmed, true); assert.equal(cleared.pending, undefined);
});
test('a late response does not clear another window’s retained action', async () => {
  let saved: PendingTeamAction | undefined;
  const newer = { ...command, requestId: 'other-window', id: 'other-team' };
  const result = await runRetainedTeamAction({ read: () => saved, write(value) { saved = value ?? undefined; return true; }, retained() {}, async send() { saved = newer; } }, command);
  assert.equal(result.confirmed, true); assert.deepEqual(result.pending, newer); assert.deepEqual(saved, newer);
});
test('an unreadable local receipt after confirmation keeps its in-memory command for reconciliation', async () => {
  let saved: PendingTeamAction | undefined, readable = true;
  const result = await runRetainedTeamAction({ read: () => readable ? saved : undefined, write(value) { saved = value ?? undefined; return true; }, retained() {}, async send() { readable = false; } }, command);
  assert.equal(result.confirmed, true); assert.deepEqual(result.pending, command); assert.deepEqual(saved, command);
});
