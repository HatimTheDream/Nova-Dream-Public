import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { taskSchema, type Task, type Entity, type Attachment } from '../packages/domain/contracts.js';
import type { AgentDesign } from '../packages/domain/workspace-records.js';
import type { AssignmentAttempt } from '../packages/domain/assignments.js';
import {
  briefFromTask,
  planValueFromTask,
  latestAttemptForPlan,
  canAcceptAttempt,
  workResultPayload,
} from '../packages/domain/task-work.js';

const baseTask = {
  title: 'Write the launch notes',
  notes: '',
  status: 'open',
  planned: '',
  due: '',
} as const;

function makeAttempt(overrides: Partial<AssignmentAttempt> = {}): AssignmentAttempt {
  return {
    id: randomUUID(),
    epoch: randomUUID(),
    deviceId: 'device-1',
    assignmentId: 'assign-1',
    assignmentRevision: 1,
    title: 'Work: Write the launch notes',
    agentId: 'agent-1',
    agentRevision: 1,
    agentName: 'Mira',
    projectId: null,
    createdAt: 1000,
    updatedAt: 1000,
    deadlineAt: 2000,
    state: 'returned',
    message: '',
    result: {
      file: { id: 'file-1', name: 'notes.md', size: 12, sha256: '0'.repeat(64) } as Attachment,
      preview: 'done',
      previewTruncated: false,
      disposition: 'visible' as const,
    },
    ...overrides,
  };
}

const agent: Entity<AgentDesign> = {
  id: 'agent-1',
  revision: 3,
  updatedAt: '2026-09-30T00:00:00.000Z',
  deviceId: 'device-1',
  value: {
    name: 'Mira',
    position: 'Writer',
    purpose: 'Write things',
    instructions: '',
    knowledge: '',
    nonGoals: '',
    reviewCriteria: '',
    appearance: null,
    archived: false,
  },
};

test('taskSchema parses a task with a valid workResult and preserves it', () => {
  const workResult = { attemptId: randomUUID(), assignmentId: 'assign-1', fileId: 'file-1', acceptedAt: 1759219200000 };
  const parsed = taskSchema.parse({ ...baseTask, workResult });
  assert.deepEqual(parsed.workResult, workResult);
});

test('taskSchema rejects workResult with a non-uuid attemptId', () => {
  assert.throws(
    () => taskSchema.parse({ ...baseTask, workResult: { attemptId: 'not-a-uuid', assignmentId: 'assign-1', acceptedAt: 1 } }),
    /attemptId/,
  );
});

test('task without workResult still parses (backward compatible)', () => {
  const parsed = taskSchema.parse({ ...baseTask });
  assert.equal(parsed.workResult, undefined);
  assert.equal(parsed.title, baseTask.title);
});

test('briefFromTask with notes', () => {
  assert.equal(briefFromTask({ ...baseTask, title: 'Launch', notes: '  Keep it welcoming. ' } as Task), 'Launch\n\nKeep it welcoming.');
});

test('briefFromTask with blank notes returns just the title', () => {
  assert.equal(briefFromTask({ ...baseTask, title: 'Launch', notes: '   ' } as Task), 'Launch');
});

test('planValueFromTask sets agent/state/brief/title correctly', () => {
  const value = planValueFromTask({ ...baseTask, title: 'Write the launch notes', notes: 'Draft the highlights.' } as Task, agent);
  assert.equal(value.title, 'Work: Write the launch notes');
  assert.equal(value.brief, 'Write the launch notes\n\nDraft the highlights.');
  assert.equal(value.expectedOutput, '');
  assert.equal(value.agentId, 'agent-1');
  assert.equal(value.agentRevision, 3);
  assert.equal(value.projectId, null);
  assert.equal(value.due, '');
  assert.equal(value.state, 'planned');
  assert.equal(value.archived, false);
});

test('planValueFromTask truncates a long title to 240 characters', () => {
  const value = planValueFromTask({ ...baseTask, title: 'x'.repeat(400) } as Task, agent);
  assert.equal(value.title.length, 240);
});

test('canAcceptAttempt true only for returned attempts with a result', () => {
  assert.equal(canAcceptAttempt(makeAttempt()), true);
  assert.equal(canAcceptAttempt(makeAttempt({ state: 'returned', result: undefined })), false);
  assert.equal(canAcceptAttempt(makeAttempt({ state: 'failed' })), false);
  assert.equal(canAcceptAttempt(makeAttempt({ state: 'running' })), false);
  assert.equal(canAcceptAttempt(makeAttempt({ state: 'cancelled' })), false);
});

test('latestAttemptForPlan returns newest for the assignmentId and ignores other ids', () => {
  const old = makeAttempt({ id: 'old', createdAt: 100, assignmentId: 'assign-1' });
  const newer = makeAttempt({ id: 'newer', createdAt: 300, assignmentId: 'assign-1' });
  const other = makeAttempt({ id: 'other', createdAt: 900, assignmentId: 'assign-2' });
  const latest = latestAttemptForPlan([old, other, newer], 'assign-1');
  assert.equal(latest?.id, 'newer');
  assert.equal(latestAttemptForPlan([old, newer], 'assign-2'), undefined);
  assert.equal(latestAttemptForPlan([], 'assign-1'), undefined);
});

test('workResultPayload returns the payload for an acceptable attempt', () => {
  const attempt = makeAttempt({ id: randomUUID() });
  const payload = workResultPayload(attempt, 12345);
  assert.deepEqual(payload, {
    attemptId: attempt.id,
    assignmentId: 'assign-1',
    fileId: 'file-1',
    acceptedAt: 12345,
  });
});

test('workResultPayload throws for a non-acceptable attempt', () => {
  assert.throws(() => workResultPayload(makeAttempt({ state: 'failed' }), 1), /cannot be accepted/);
  assert.throws(() => workResultPayload(makeAttempt({ state: 'returned', result: undefined }), 1), /cannot be accepted/);
});
