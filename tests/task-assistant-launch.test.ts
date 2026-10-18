import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Command, Entity, Task } from '../packages/domain/contracts.js';
import type { AgentDesign } from '../packages/domain/workspace-records.js';
import type { AssignmentAttempt, AssignmentStart } from '../packages/domain/assignments.js';
import {
  createTaskAssistantLaunch, readTaskAssistantLaunch, resumeTaskAssistantLaunch, taskAssistantLaunchFailure,
  type TaskAssistantLaunchIO, type TaskAssistantLaunchJournal,
} from '../apps/client/src/task-assistant-launch.js';

function fixture() {
  const scope = { epoch: randomUUID(), deviceId: 'device:test', taskId: 'task:test' };
  const task: Entity<Task> = {
    id: scope.taskId, revision: 4, deviceId: 'device:creator', updatedAt: '2026-10-17T12:00:00Z',
    value: { title: 'Prepare launch notes', notes: 'Keep the summary useful.', planned: '', due: '', status: 'open', projectId: 'project:test' },
  };
  const agent: Entity<AgentDesign> = {
    id: 'agent:test', revision: 3, deviceId: scope.deviceId, updatedAt: task.updatedAt,
    value: { name: 'Writer', position: 'Writer', purpose: '', instructions: '', knowledge: '', nonGoals: '', reviewCriteria: '', appearance: null, archived: false },
  };
  const input = { scope, task, agent, projectRevision: 2, brief: 'Draft the launch notes.', expectedOutput: 'A short draft.', maxMinutes: 5 };
  return { scope, task, agent, input, journal: createTaskAssistantLaunch(input) };
}

function service(initial: TaskAssistantLaunchJournal) {
  let kept: TaskAssistantLaunchJournal | undefined;
  let saves = 0, failSave = -1, loseReply: 'assignment' | 'task' | 'start' | undefined;
  const commits: Command[] = [], starts: AssignmentStart[] = [];
  const entities = new Map<string, Entity<unknown>>(), attempts = new Map<string, AssignmentAttempt>();
  const io: TaskAssistantLaunchIO = {
    save(journal) {
      saves++;
      if (saves === failSave) return false;
      kept = JSON.parse(JSON.stringify(journal));
      return true;
    },
    async commit<T>(command: Command) {
      commits.push(structuredClone(command));
      let result = entities.get(command.requestId);
      if (!result) {
        result = { id: command.entityId, revision: command.expectedRevision + 1, updatedAt: '2026-10-17T12:01:00Z', deviceId: initial.scope.deviceId, value: structuredClone(command.payload) };
        entities.set(command.requestId, result);
      }
      if (loseReply === command.kind) { loseReply = undefined; throw new TypeError('Connection lost after the write'); }
      return structuredClone(result) as Entity<T>;
    },
    async start(request: AssignmentStart) {
      starts.push(structuredClone(request));
      let attempt = attempts.get(request.requestId);
      if (!attempt) {
        attempt = {
          id: randomUUID(), epoch: request.epoch, deviceId: initial.scope.deviceId, assignmentId: request.assignmentId,
          assignmentRevision: request.revision, title: 'Work: Prepare launch notes', agentId: 'agent:test', agentRevision: 3,
          agentName: 'Writer', projectId: 'project:test', createdAt: 1000, updatedAt: 1000, deadlineAt: 301000,
          state: 'prepared', message: 'Preparing the saved assignment.',
        };
        attempts.set(request.requestId, attempt);
      }
      if (loseReply === 'start') { loseReply = undefined; throw new TypeError('Connection lost after admission'); }
      return structuredClone(attempt);
    },
  };
  return {
    io, commits, starts, entities, attempts,
    kept: () => kept,
    failSave: (ordinal: number) => { failSave = ordinal; },
    loseReply: (stage: typeof loseReply) => { loseReply = stage; },
  };
}

for (const stage of ['assignment', 'task', 'start'] as const) {
  test(`a lost ${stage} reply and reload reconcile the original requests`, async () => {
    const { scope, journal } = fixture(), host = service(journal);
    host.loseReply(stage);
    await assert.rejects(resumeTaskAssistantLaunch(journal, scope, host.io), TypeError);
    assert.ok(host.kept());
    const reloaded = readTaskAssistantLaunch(JSON.parse(JSON.stringify(host.kept())), scope)!;
    const result = await resumeTaskAssistantLaunch(reloaded, scope, host.io);
    assert.equal(host.entities.size, 2, 'one plan and one linked task');
    assert.equal(host.attempts.size, 1, 'one execution admission');
    assert.equal(result.task?.revision, 5);
    assert.equal(result.task?.value.workLink?.assignmentId, result.plan?.id);
    const repeated = stage === 'start' ? host.starts : host.commits.filter(command => command.kind === stage);
    assert.equal(repeated.length, 2);
    assert.deepEqual(repeated[0], repeated[1], 'the whole original request is replayed');
    const calls = host.commits.length + host.starts.length;
    await resumeTaskAssistantLaunch(result, scope, host.io);
    assert.equal(host.commits.length + host.starts.length, calls, 'completed journal is read only');
  });
}

for (const [saveOrdinal, expectedCommits, expectedStarts] of [[1, 0, 0], [2, 1, 0], [3, 1, 0], [4, 2, 0], [5, 2, 0], [6, 2, 1]]) {
  test(`storage failure at checkpoint ${saveOrdinal} stops subsequent effects and can reconcile`, async () => {
    const { scope, journal } = fixture(), host = service(journal);
    host.failSave(saveOrdinal);
    await assert.rejects(resumeTaskAssistantLaunch(journal, scope, host.io), error => taskAssistantLaunchFailure(error) === 'storage');
    assert.equal(host.commits.length, expectedCommits);
    assert.equal(host.starts.length, expectedStarts);
    const result = await resumeTaskAssistantLaunch(host.kept() ?? journal, scope, host.io);
    assert.ok(result.attempt);
    assert.equal(host.entities.size, 2);
    assert.equal(host.attempts.size, 1);
  });
}

test('task linking conflict keeps the created plan and original task proposal', async () => {
  const { scope, journal, task } = fixture(), host = service(journal);
  const current = { ...task, revision: 5, value: { ...task.value, notes: 'A different window changed this.' } };
  const conflict = Object.assign(new Error('Changed task'), { code: 'revision_conflict', status: 409, current });
  const io: TaskAssistantLaunchIO = { ...host.io, commit: async <T>(command: Command) => {
    if (command.kind === 'task') throw conflict;
    return host.io.commit<T>(command);
  } };
  await assert.rejects(resumeTaskAssistantLaunch(journal, scope, io), error => error === conflict);
  const reloaded = readTaskAssistantLaunch(JSON.parse(JSON.stringify(host.kept())), scope)!;
  assert.equal(reloaded.linkRefusal, 'revision_conflict', 'confirmed refusal survives reload and releases task editing');
  await resumeTaskAssistantLaunch(reloaded, scope, io);
  assert.equal(host.entities.size, 1);
  assert.equal(host.commits.length, 1, 'no new plan on conflict retry');
  assert.equal(host.starts.length, 0);
  assert.equal(host.kept()?.plan?.id, journal.planCommand.entityId);
  assert.equal(host.kept()?.linkCommand?.expectedRevision, task.revision);
  assert.equal(host.kept()?.linkCommand?.payload.notes, task.value.notes);
  assert.equal(taskAssistantLaunchFailure(conflict), 'conflict');
});

test('confirmed task revision is retained before uncertain start', async () => {
  const { scope, journal } = fixture(), host = service(journal);
  host.loseReply('start');
  await assert.rejects(resumeTaskAssistantLaunch(journal, scope, host.io));
  assert.equal(host.kept()?.task?.revision, 5);
  assert.ok(host.kept()?.startRequest);
  assert.equal(host.kept()?.attempt, undefined);
});

test('captured task, agent and brief remain unchanged by subsequent editor changes', async () => {
  const { scope, input, task, agent, journal } = fixture(), host = service(journal);
  task.value.notes = 'New unsaved writing'; task.revision = 99;
  agent.revision = 8; input.brief = 'A different brief'; input.projectRevision = 7;
  const result = await resumeTaskAssistantLaunch(journal, scope, host.io);
  assert.equal(result.plan?.value.brief, 'Draft the launch notes.');
  assert.equal(result.plan?.value.agentRevision, 3);
  assert.equal(result.task?.value.notes, 'Keep the summary useful.');
  assert.equal(host.starts[0].projectRevision, 2);
});

test('an existing contact/content source is preserved by linking', async () => {
  for (const kind of ['contact', 'content'] as const) {
    const { scope, input } = fixture();
    input.task.value.origin = { kind, id: `${kind}:source`, revision: 2 };
    const journal = createTaskAssistantLaunch(input), host = service(journal);
    const result = await resumeTaskAssistantLaunch(journal, scope, host.io);
    assert.deepEqual(result.task?.value.origin, input.task.value.origin);
    assert.ok(result.plan && result.attempt, 'the journal retains the independent launch identity');
  }
});

test('wrong task, epoch or device cannot resume even a valid journal', async () => {
  const { scope, journal } = fixture();
  for (const changed of [{ ...scope, taskId: 'task:another' }, { ...scope, epoch: randomUUID() }, { ...scope, deviceId: 'device:another' }]) {
    const host = service(journal);
    await assert.rejects(resumeTaskAssistantLaunch(journal, changed, host.io));
    assert.equal(host.commits.length + host.starts.length, 0);
    assert.equal(host.kept(), undefined);
  }
});

test('malformed or inconsistent retained stages fail closed', async () => {
  const { scope, journal } = fixture(), host = service(journal);
  const complete = await resumeTaskAssistantLaunch(journal, scope, host.io);
  const bad = [
    {}, { ...journal, version: 3 }, { ...journal, capturedTask: { ...journal.capturedTask, id: 'task:another' } },
    { ...complete, plan: { ...complete.plan!, id: 'assignment:another' } },
    { ...complete, linkCommand: { ...complete.linkCommand!, expectedRevision: 99 } },
    { ...complete, task: { ...complete.task!, revision: 99 } },
    { ...complete, startRequest: { ...complete.startRequest!, requestId: randomUUID() } },
    { ...complete, attempt: { ...complete.attempt!, assignmentId: 'assignment:another' } },
    { ...complete, plan: undefined }, { ...complete, task: undefined },
  ];
  for (const value of bad) assert.throws(() => readTaskAssistantLaunch(value, scope));
  assert.equal(readTaskAssistantLaunch(null, scope), undefined);
});

test('a mismatched service response is not retained or followed by another mutation', async () => {
  const { scope, journal } = fixture(), host = service(journal);
  const io: TaskAssistantLaunchIO = { ...host.io, commit: async <T>(command: Command) => {
    const entity = await host.io.commit<T>(command);
    return { ...entity, id: 'assignment:wrong' };
  } };
  await assert.rejects(resumeTaskAssistantLaunch(journal, scope, io));
  assert.equal(host.kept()?.plan, undefined);
  assert.equal(host.commits.length, 1);
  assert.equal(host.starts.length, 0);
});

test('uncertain transport failures are distinguished from an explicit service refusal', () => {
  assert.equal(taskAssistantLaunchFailure(new TypeError('Network failed')), 'unconfirmed');
  assert.equal(taskAssistantLaunchFailure({ code: 'internal_error', status: 500 }), 'unconfirmed');
  assert.equal(taskAssistantLaunchFailure({ code: 'host_unavailable', status: 403 }), 'unconfirmed');
  assert.equal(taskAssistantLaunchFailure({ code: 'assignment_unavailable', status: 409 }), 'rejected');
});
