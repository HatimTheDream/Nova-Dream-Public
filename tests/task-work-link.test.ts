import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import type { Command, Entity, Task } from '../packages/domain/contracts.js';
import { blankRecord, type AgentDesign } from '../packages/domain/workspace-records.js';
import type { AssignmentAttempt } from '../packages/domain/assignments.js';
import { taskWorkOrigin, workResultPayload } from '../packages/domain/task-work.js';
import { createTaskAssistantLaunch, readTaskAssistantLaunch, resumeTaskAssistantLaunch, type TaskAssistantLaunchJournal } from '../apps/client/src/task-assistant-launch.js';

function fixture(source?: 'contact' | 'content') {
  const directory = mkdtempSync(join(tmpdir(), 'nova-task-work-link-'));
  let store = new Store(directory);
  const command = (kind: Command['kind'], entityId: string, payload: unknown, expectedRevision = 0): Command => ({ kind, entityId, payload, expectedRevision, epoch: store.epoch, requestId: randomUUID() });
  const agent = store.mutate('device:a', command('agent', 'agent:writer', { ...blankRecord('agent', 'UTC'), name: 'Writer', position: 'Writer' })) as Entity<AgentDesign>;
  const origin = source ? { kind: source, id: `${source}:source`, revision: 1 } : undefined;
  if (source) store.mutate('device:a', command(source, origin!.id, { ...blankRecord(source, 'UTC'), ...(source === 'contact' ? { name: 'Contact' } : { title: 'Saved source' }) }));
  const task = store.mutate('device:a', command('task', 'task:launch', { title: 'Launch notes', notes: 'Preserve this writing', status: 'open', planned: '', due: '', ...(origin ? { origin } : {}) })) as Entity<Task>;
  const scope = { taskId: task.id, deviceId: 'device:a', epoch: store.epoch };
  const journal = createTaskAssistantLaunch({ scope, task, agent, projectRevision: null, brief: 'Draft notes', expectedOutput: '', maxMinutes: 1 });
  let kept: TaskAssistantLaunchJournal | undefined, starts = 0;
  const io = {
    save(value: TaskAssistantLaunchJournal) { kept = structuredClone(value); return true; },
    async commit<T>(value: Command) { return store.mutate(scope.deviceId, value) as Entity<T>; },
    async start(input: NonNullable<TaskAssistantLaunchJournal['startRequest']>) {
      return store.admit(scope.deviceId, input, { type: 'fixture.start', ...input }, () => {
        starts++;
        const attempt: AssignmentAttempt = { id: randomUUID(), epoch: store.epoch, deviceId: scope.deviceId, assignmentId: input.assignmentId, assignmentRevision: input.revision,
          agentId: agent.id, agentRevision: agent.revision, agentName: 'Writer', title: 'Draft notes', projectId: null, createdAt: 1000, updatedAt: 1000, deadlineAt: 61000, state: 'prepared', message: 'Prepared' };
        store.internalWrite(`assignments:attempt:${attempt.id}`, attempt);
        return attempt;
      }).value;
    },
  };
  return { get store() { return store; }, command, task, agent, origin, scope, journal, io, get kept() { return kept!; }, get starts() { return starts; },
    restart() { store.close(); store = new Store(directory); }, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const source of [undefined, 'contact', 'content'] as const) test(`real Store retains independent work for ${source ?? 'ordinary'} tasks across devices and reopen`, async () => {
  const f = fixture(source);
  try {
    const result = await resumeTaskAssistantLaunch(f.journal, f.scope, f.io);
    assert.equal(f.starts, 1);
    assert.deepEqual(result.task!.value.origin, f.origin);
    assert.deepEqual(result.task!.value.workLink, { assignmentId: result.plan!.id, assignmentRevision: 1, taskRevision: f.task.revision });
    f.restart();
    const other = f.store.snapshot('device:b').tasks.find(task => task.id === f.task.id)!;
    assert.equal(taskWorkOrigin(other.value)?.id, result.plan!.id);
    assert.deepEqual(other.value.origin, f.origin);
    const changed = f.store.mutate('device:b', f.command('task', other.id, { ...other.value, notes: 'Second device writing' }, other.revision)) as Entity<Task>;
    assert.deepEqual(changed.value.workLink, other.value.workLink);
    assert.equal(f.store.taskHistory({ taskId: other.id }).versions.find(task => task.revision === 1)?.value.notes, 'Preserve this writing');
  } finally { f.close(); }
});

test('lost task acknowledgement reconciles the same Store receipt after restart', async () => {
  const f = fixture('content');
  try {
    let lose = true;
    await assert.rejects(resumeTaskAssistantLaunch(f.journal, f.scope, { ...f.io, async commit<T>(value: Command) {
      const result = await f.io.commit<T>(value);
      if (value.kind === 'task' && lose) { lose = false; throw new TypeError('Lost response'); }
      return result;
    } }), TypeError);
    const original = f.kept.linkCommand!;
    f.restart();
    const result = await resumeTaskAssistantLaunch(f.kept, f.scope, f.io);
    assert.deepEqual(result.linkCommand, original);
    assert.equal(f.store.snapshot('device:b').tasks.find(task => task.id === f.task.id)!.revision, 2);
    assert.equal(f.store.snapshot('device:b').records!.assignment.length, 1);
    assert.equal(f.starts, 1);
  } finally { f.close(); }
});

test('legacy pending launch keeps original bytes and can link an ordinary task', async () => {
  const f = fixture();
  try {
    const legacy = { ...f.journal, version: 1 as const };
    const result = await resumeTaskAssistantLaunch(legacy, f.scope, f.io);
    assert.equal(result.version, 1);
    assert.equal(result.task!.value.workLink, undefined);
    assert.equal(taskWorkOrigin(result.task!.value)?.id, result.plan!.id);
    assert.equal(result.planCommand.requestId, legacy.planCommand.requestId);
    assert.equal(result.linkCommand!.requestId, legacy.linkRequestId);
    assert.deepEqual(readTaskAssistantLaunch(result, f.scope), result);
  } finally { f.close(); }
});

test('an older source-linked local plan can be explicitly saved without launching another run', async () => {
  const f = fixture('content');
  try {
    const result = await resumeTaskAssistantLaunch({ ...f.journal, version: 1 }, f.scope, f.io);
    const current = f.store.snapshot('device:a').tasks.find(task => task.id === f.task.id)!;
    const linked = f.store.mutate('device:a', f.command('task', current.id, { ...current.value, workLink: { assignmentId: result.plan!.id, assignmentRevision: 1, taskRevision: current.revision } }, current.revision)) as Entity<Task>;
    assert.equal(f.starts, 1);
    assert.deepEqual(linked.value.origin, f.origin);
    f.restart();
    assert.equal(taskWorkOrigin(f.store.snapshot('device:b').tasks.find(t => t.id === current.id)!.value)?.id, result.plan!.id);
    assert.deepEqual(readTaskAssistantLaunch(result, f.scope), result, 'completed legacy journal was not rewritten');
  } finally { f.close(); }
});

test('stale, missing and replaced links are refused; older clients cannot remove a confirmed link', async () => {
  const f = fixture('contact');
  try {
    const result = await resumeTaskAssistantLaunch(f.journal, f.scope, f.io), task = result.task!;
    assert.throws(() => f.store.mutate('device:b', f.command('task', task.id, { ...task.value, notes: 'stale' }, 1)), { code: 'revision_conflict' });
    for (const workLink of [{ ...task.value.workLink!, assignmentId: 'assignment:missing' }, { ...task.value.workLink!, taskRevision: 99 }]) {
      assert.throws(() => f.store.mutate('device:b', f.command('task', task.id, { ...task.value, workLink }, task.revision)), { code: 'task_work_changed' });
    }
    const { workLink: _link, ...oldValue } = task.value;
    const saved = f.store.mutate('device:b', f.command('task', task.id, { ...oldValue, notes: 'Older form writing' }, task.revision)) as Entity<Task>;
    assert.deepEqual(saved.value.workLink, task.value.workLink);
    assert.throws(() => f.store.mutate('device:b', f.command('task', task.id, { ...saved.value, origin: { kind: 'assignment', id: result.plan!.id, revision: 1 } }, saved.revision)), { code: 'source_changed' });
  } finally { f.close(); }
});

test('result acceptance from another device verifies the linked returned attempt and retains source and writing', async () => {
  const f = fixture('content');
  try {
    const result = await resumeTaskAssistantLaunch(f.journal, f.scope, f.io), task = result.task!;
    const file = f.store.upload('device:a', randomUUID(), f.store.epoch, 'result.md', Buffer.from('Saved result').toString('base64'));
    const attempt: AssignmentAttempt = { ...result.attempt!, state: 'returned', runId: 'run:result', nativeSessionId: 'session:result', terminal: { status: 'ok', turnId: 'turn:result', provider: 'fixture', model: 'fixture' }, result: { file, preview: 'Saved result', previewTruncated: false, disposition: 'visible' } };
    f.store.internalWrite(`assignments:attempt:${attempt.id}`, attempt);
    assert.throws(() => f.store.mutate('device:b', f.command('task', task.id, { ...task.value, workResult: { ...workResultPayload(attempt, Date.now()), assignmentId: 'assignment:other' } }, task.revision)), { code: 'task_work_result_changed' });
    for (const invalid of [ { ...attempt, state: 'running' as const }, { ...attempt, terminal: undefined }, { ...attempt, result: { ...attempt.result!, file: { ...file, sha256: '0'.repeat(64) } } }, { ...attempt, result: { ...attempt.result!, file: { ...file, id: 'missing-result' } } } ]) {
      f.store.internalWrite(`assignments:attempt:${attempt.id}`, invalid);
      assert.throws(() => f.store.mutate('device:b', f.command('task', task.id, { ...task.value, workResult: { ...workResultPayload(attempt, Date.now()), fileId: invalid.result?.file.id } }, task.revision)), { code: 'task_work_result_changed' });
    }
    f.store.internalWrite(`assignments:attempt:${attempt.id}`, attempt);
    const command = f.command('task', task.id, { ...task.value, workResult: workResultPayload(attempt, Date.now()) }, task.revision);
    const saved = f.store.mutate('device:b', command) as Entity<Task>;
    f.restart();
    assert.deepEqual(f.store.mutate('device:b', command), saved, 'lost acceptance acknowledgement replays the exact original receipt');
    assert.deepEqual(f.store.snapshot('device:b').tasks.find(item => item.id === task.id), saved);
    assert.equal(saved.value.notes, 'Preserve this writing');
    assert.deepEqual(saved.value.origin, f.origin);
    assert.equal(f.store.download(saved.value.workResult!.fileId!).bytes.toString(), 'Saved result');
  } finally { f.close(); }
});

for (const archived of [false, true]) test(`a ${archived ? 'retired' : 'changed'} plan refuses linking without locking the retained launch or starting work`, async () => {
  const f = fixture('content');
  try {
    await assert.rejects(resumeTaskAssistantLaunch(f.journal, f.scope, { ...f.io, async commit<T>(command: Command) {
      const result = await f.io.commit<T>(command);
      if (command.kind === 'assignment') f.store.mutate('device:b', f.command('assignment', command.entityId, { ...f.journal.planCommand.payload, title: 'Edited on another device', archived }, 1));
      return result;
    } }), { code: 'task_work_changed' });
    const kept = readTaskAssistantLaunch(JSON.parse(JSON.stringify(f.kept)), f.scope)!;
    assert.equal(kept.linkRefusal, 'task_work_changed');
    assert.equal(f.starts, 0);
    assert.deepEqual(kept.planCommand, f.journal.planCommand);
    assert.equal(kept.linkCommand!.requestId, f.journal.linkRequestId);
    await resumeTaskAssistantLaunch(kept, f.scope, f.io);
    assert.equal(f.starts, 0);
    const saved = f.store.mutate('device:a', f.command('task', f.task.id, { ...f.task.value, notes: 'Writing remains editable' }, 1)) as Entity<Task>;
    assert.equal(saved.value.notes, 'Writing remains editable');
    assert.deepEqual(saved.value.origin, f.origin);
  } finally { f.close(); }
});

test('two devices racing on one task admit only the winning plan execution', async () => {
  const f = fixture('contact');
  try {
    const otherScope = { ...f.scope, deviceId: 'device:b' };
    const other = createTaskAssistantLaunch({ scope: otherScope, task: f.task, agent: f.agent, projectRevision: null, brief: 'Other device proposal', expectedOutput: '', maxMinutes: 1 });
    const results = await Promise.allSettled([resumeTaskAssistantLaunch(f.journal, f.scope, f.io), resumeTaskAssistantLaunch(other, otherScope, f.io)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.starts, 1);
    const snapshot = f.store.snapshot('device:b');
    assert.equal(snapshot.records!.assignment.length, 2, 'both reviewed plans remain available');
    assert.equal(snapshot.tasks.find(task => task.id === f.task.id)!.revision, 2);
    assert.deepEqual(snapshot.tasks.find(task => task.id === f.task.id)!.value.origin, f.origin);
  } finally { f.close(); }
});

test('first links validate task and plan revisions, existence, and project before writing', async () => {
  const f = fixture('content');
  try {
    const plan = await f.io.commit(f.journal.planCommand);
    const link = { assignmentId: plan.id, assignmentRevision: plan.revision, taskRevision: f.task.revision };
    for (const workLink of [{ ...link, assignmentId: 'assignment:missing' }, { ...link, assignmentRevision: 2 }, { ...link, taskRevision: 2 }]) {
      assert.throws(() => f.store.mutate('device:b', f.command('task', f.task.id, { ...f.task.value, workLink }, f.task.revision)), { code: 'task_work_changed' });
    }
    assert.throws(() => f.store.mutate('device:b', f.command('task', f.task.id, { ...f.task.value, projectId: 'project:other', workLink: link }, f.task.revision)), { code: 'task_work_changed' });
    assert.equal(f.store.snapshot('device:b').tasks.find(task => task.id === f.task.id)!.revision, 1);
    assert.equal(f.starts, 0);
  } finally { f.close(); }
});
