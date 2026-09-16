import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { AssignmentService } from '../apps/service/assignments.js';
import { AgentRoutines } from '../apps/service/agent-routines.js';
import { nextAgentRun, latestAgentRun } from '../apps/service/agent-schedule.js';
import { agentRoutineSchema, type AgentRoutineValue } from '../packages/domain/agent-routines.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import { WorkerTransport } from './fixtures/assignment-worker.js';

const base: AgentRoutineValue = { name: 'Daily source review', assignmentId: 'assignment:fixture', assignmentRevision: 1, projectRevision: null, timezone: 'UTC', schedule: { kind: 'cron', expression: '0 9 * * 1-5' }, missed: 'skip', enabled: true, archived: false };
test('schedules retain original once/interval/custom choices, timezone and clock-change behavior', () => {
  const daily = { ...base, timezone: 'America/Los_Angeles', schedule: { kind: 'cron' as const, expression: '0 9 * * *' } };
  assert.equal(new Date(nextAgentRun(daily, Date.parse('2026-03-07T18:00Z'))!).toISOString(), '2026-03-08T16:00:00.000Z');
  assert.equal(new Date(nextAgentRun(daily, Date.parse('2026-10-31T18:00Z'))!).toISOString(), '2026-11-01T17:00:00.000Z');
  const gap = { ...daily, schedule: { kind: 'once' as const, date: '2026-03-08', time: '02:30' } };
  assert.throws(() => nextAgentRun(gap, 0), /does not exist/);
  const overlap = { ...daily, schedule: { kind: 'once' as const, date: '2026-11-01', time: '01:30' } };
  assert.throws(() => nextAgentRun(overlap, 0), /occurs twice/);
  assert.equal(nextAgentRun({ ...overlap, schedule: { ...overlap.schedule, overlap: 'later' } }, 0)! - nextAgentRun({ ...overlap, schedule: { ...overlap.schedule, overlap: 'earlier' } }, 0)!, 3600000);
  const interval = { ...base, schedule: { kind: 'every' as const, minutes: 60, anchor: '2026-01-01T00:00:00Z' } };
  assert.equal(new Date(nextAgentRun(interval, Date.parse('2036-01-01T00:30Z'))!).toISOString(), '2036-01-01T01:00:00.000Z');
  assert.equal(latestAgentRun(base, Date.parse('2026-09-14T08:00Z'), Date.parse('2026-09-10T09:00Z')), Date.parse('2026-09-11T09:00Z'));
  assert.throws(() => nextAgentRun({ ...base, schedule: { kind: 'cron', expression: '* * * * * *' } }, Date.now()), /five-field/);
  assert.throws(() => nextAgentRun({ ...base, schedule: { kind: 'cron', expression: '99 9 * * *' } }, Date.now()), /invalid/);
  assert.equal(agentRoutineSchema.safeParse({ ...base, enabled: true, archived: true }).success, false);
});

async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
  const f = setup(); try { await run(f); } finally { f.routines.close(); await f.assignments.close(); f.gateway.stopJournal?.(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-agent-routines-')), store = new Store(directory), gateway = new WorkerTransport(directory, store.epoch), device = store.session().deviceId;
  let now = Date.parse('2026-09-09T08:00:00Z');
  // Schedule fixtures advance civil time; native worker deadlines use its real
  // clock. The assignment's scheduled provenance remains the fixture instant.
  const assignments = new AssignmentService(store, gateway), routines = new AgentRoutines(store, assignments, () => now);
  const create = (kind: any, payload: any): any => store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind, entityId: `${kind}:${randomUUID()}`, expectedRevision: 0, payload });
  const agent = create('agent', { ...blankRecord('agent', 'UTC'), name: 'Nova', position: 'Editor' });
  const plan = create('assignment', { ...blankRecord('assignment', 'UTC'), title: 'Routine test assignment', agentId: agent.id, agentRevision: agent.revision, brief: 'Return a useful draft' });
  const value: AgentRoutineValue = { ...base, assignmentId: plan.id, schedule: { kind: 'every', minutes: 1, anchor: '2026-09-09T08:01:00Z' } };
  const input = (patch: Partial<AgentRoutineValue> = {}) => ({ requestId: randomUUID(), epoch: store.epoch, id: randomUUID(), expectedRevision: 0, value: { ...value, ...patch } });
  const advance = (ms: number) => { now += ms; };
  return { directory, store, gateway, device, assignments, routines, agent, plan, value, input, advance, now: () => now };
}
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 10));

test('routine occurrence, assignment and receipt commit together, retain exact provenance and never replay after restart', () => fixture(async f => {
  const input = f.input(), saved = f.routines.save(f.device, input);
  assert.deepEqual(f.routines.save(f.device, input), saved);
  f.advance(60000); f.routines.tick(); f.routines.tick();
  const state = f.routines.state(saved.id), event = state.history[0], attempt = event.attempt!;
  assert.equal(state.history.length, 1); assert.equal(event.state, 'started');
  assert.deepEqual(attempt.routine, { routineId: saved.id, routineRevision: 1, scheduledAt: f.now(), occurrenceId: event.id });
  assert.equal(attempt.assignmentId, f.plan.id); assert.equal(state.routines[0].nextAt, f.now() + 60000);
  await turn(); assert.equal(f.gateway.nativeCalls.length, 1);
  f.gateway.finish('Full scheduled result'); await f.assignments.reconcile(attempt.id);
  assert.equal(f.routines.state(saved.id).history[0].attempt!.state, 'returned');
  assert.equal(f.store.download(f.routines.state(saved.id).history[0].attempt!.result!.file.id).bytes.toString(), 'Full scheduled result');
  f.routines.close(); const reopened = new AgentRoutines(f.store, f.assignments, f.now); reopened.tick(); reopened.close();
  assert.equal(f.gateway.nativeCalls.length, 1); assert.equal(f.assignments.state().attempts.length, 1);
  assert.equal(readFileSync(join(f.directory, 'workspace.sqlite')).includes(Buffer.from('Daily source review')), false);
}));

test('transaction failure keeps the original due time and cannot dispatch an orphan assignment', () => fixture(async f => {
  const saved = f.routines.save(f.device, f.input()), original = f.store.internalWrite.bind(f.store);
  f.store.internalWrite = ((id: string, value: unknown) => { if (id.startsWith('agent-routines:history:')) throw new Error('Fixture storage failure'); return original(id, value); }) as typeof f.store.internalWrite;
  f.advance(60000); assert.throws(() => f.routines.tick(), /Fixture storage failure/);
  assert.equal(f.assignments.state().attempts.length, 0); assert.equal(f.routines.state().routines[0].nextAt, saved.nextAt); assert.equal(f.gateway.calls.length, 0);
  f.store.internalWrite = original; f.routines.tick(); await turn(); assert.equal(f.gateway.nativeCalls.length, 1);
}));

test('missed policies skip elapsed windows, start only the latest, or pause for review', () => fixture(async f => {
  const skip = f.routines.save(f.device, f.input({ missed: 'skip' }));
  const latest = f.routines.save(f.device, f.input({ missed: 'latest' }));
  const review = f.routines.save(f.device, f.input({ missed: 'review' }));
  f.advance(365 * 86400000); f.routines.tick(); await turn();
  assert.equal(f.routines.state(skip.id).history[0].state, 'skipped');
  assert.equal(f.routines.state(review.id).history[0].state, 'review');
  assert.equal(f.routines.state().routines.find(r => r.id === review.id)!.nextAt, null);
  assert.equal(f.routines.state(latest.id).history[0].attempt!.routine!.scheduledAt, f.now());
  assert.equal(f.gateway.nativeCalls.length, 1);
  f.routines.tick(); assert.equal(f.routines.state().history.length, 3);
}));

test('manual/uncertain active assignments and disconnected hosts skip overlaps without replacement or fabricated results', () => fixture(async f => {
  const saved = f.routines.save(f.device, f.input());
  f.assignments.start(f.device, { requestId: randomUUID(), epoch: f.store.epoch, assignmentId: f.plan.id, revision: 1, projectRevision: null });
  f.advance(60000); f.routines.tick(); assert.equal(f.routines.state(saved.id).history[0].state, 'skipped');
  await turn(); assert.equal(f.gateway.nativeCalls.length, 1);
  f.gateway.finish(); await f.assignments.reconcile(f.assignments.state().attempts[0].id); f.gateway.available = false;
  f.advance(60000); f.routines.tick(); assert.match(f.routines.state(saved.id).history[0].message, /connect/);
  assert.equal(f.assignments.state().attempts.length, 1);
}));

test('changed plans pause automatic work, revision conflicts preserve edits, archive retains outcomes and replay does not re-enable', () => fixture(async f => {
  const input = f.input(), saved = f.routines.save(f.device, input);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'assignment', entityId: f.plan.id, expectedRevision: 1, payload: { ...f.plan.value, brief: 'Unreviewed changed brief' } });
  f.advance(60000); f.routines.tick(); assert.equal(f.gateway.calls.length, 0);
  assert.equal(f.routines.state(saved.id).history[0].state, 'review');
  const archived = f.routines.save(f.device, { ...input, requestId: randomUUID(), expectedRevision: 1, value: { ...input.value, enabled: false, archived: true } });
  assert.throws(() => f.routines.save(f.device, { ...input, requestId: randomUUID(), value: { ...input.value, name: 'Stale edits' } }), /routine changed/);
  f.routines.save(f.device, input); assert.equal(f.routines.state().routines[0].value.archived, true);
  assert.equal(f.routines.state(saved.id).history.length, 1);
  const restored = f.routines.save(f.device, { ...input, requestId: randomUUID(), expectedRevision: archived.revision, value: { ...input.value, enabled: false } });
  assert.equal(restored.nextAt, null); assert.equal(restored.value.enabled, false);
}));

test('history pages are bounded, keep stable cursors across newer events and reject another routine cursor', () => fixture(async f => {
  f.gateway.available = false;
  const saved = f.routines.save(f.device, f.input());
  for (let n = 0; n < 105; n++) { f.advance(60000); f.routines.tick(); }
  const first = f.routines.state(saved.id); assert.equal(first.history.length, 100); assert.ok(first.nextCursor);
  f.advance(60000); f.routines.tick();
  const rest = f.routines.state(saved.id, first.nextCursor!); assert.equal(rest.history.length, 5); assert.equal(rest.nextCursor, null);
  assert.equal(new Set([...first.history, ...rest.history].map(r => r.id)).size, 105);
  assert.throws(() => f.routines.state(randomUUID(), first.nextCursor!), /Reload/);
  assert.equal(f.store.internalRead('agent-routines:count'), 106);
}));
