import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import { captureTeamHandoff } from '../apps/service/team-handoffs.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { AssistantOperation } from '../packages/domain/assistant.js';
import type { AssignmentAttempt } from '../packages/domain/assignments.js';
import { type Command, type Entity, type Task, type Snapshot, type Project } from '../packages/domain/contracts.js';
import { blankRecord, type AgentDesign, type Assignment } from '../packages/domain/workspace-records.js';
import type { TeamWork, TeamWorkPage, TeamHandoffPage } from '../packages/domain/team-work.js';
import { workResultPayload } from '../packages/domain/task-work.js';

// This starts the actual HTTP service and background readers over an isolated
// encrypted workspace. The deliberately unconfigured transport has no provider
// or native runtime; it does not qualify a native upgrade or a hosted release.
test('actual service startup and restart retain task links, source, results, receipts and paged team history', { timeout: 25000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-task-history-startup-'));
  let seeded: Store | undefined = new Store(directory);
  let service: Awaited<ReturnType<typeof startServer>> | undefined;
  const transportCalls: string[] = [];
  const gateway: AssistantTransport = {
    status: () => ({ state: 'unconfigured', message: 'Isolated startup fixture', methods: [], grantedScopes: [], modelAuthReady: false }),
    subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
    async request<T>(method: string): Promise<T> { transportCalls.push(method); throw Error('Unexpected provider request: ' + method); },
  };
  try {
    const store = seeded;
    const first = store.session(), second = store.session();
    const a = { cookie: 'e3_session=' + first.token, device: first.deviceId };
    const b = { cookie: 'e3_session=' + second.token, device: second.deviceId };
    const epoch = store.epoch;
    const command = (kind: Command['kind'], entityId: string, payload: unknown, expectedRevision = 0): Command =>
      ({ kind, entityId, payload, expectedRevision, epoch, requestId: randomUUID() });
    const taskValue: Task = { title: 'Retained task', notes: 'Keep the exact writing', status: 'open', planned: '', due: '' };
    const oldCommand = command('task', 'task:old-format', taskValue);
    const oldTask = store.mutate(a.device, oldCommand) as Entity<Task>;
    const source = store.mutate(a.device, command('content', 'content:original', { ...blankRecord('content', 'UTC'), title: 'Original source' }));
    const task = store.mutate(a.device, command('task', 'task:source-linked', { ...taskValue, origin: { kind: 'content', id: source.id, revision: source.revision } })) as Entity<Task>;
    const agents = ['Researcher', 'Builder'].map((name, index) => store.mutate(a.device, command('agent', 'agent:startup-' + index, { ...blankRecord('agent', 'UTC'), name, position: name })) as Entity<AgentDesign>);
    const plan = store.mutate(a.device, command('assignment', 'assignment:retained-plan', {
      title: 'Saved task plan', brief: 'Keep the source and result', expectedOutput: 'Saved result', agentId: agents[0].id, agentRevision: 1,
      projectId: null, due: '', state: 'planned', archived: false, sources: [{ kind: 'content', id: source.id, revision: source.revision }],
    })) as Entity<Assignment>;
    const linkCommand = command('task', task.id, { ...task.value, workLink: { assignmentId: plan.id, assignmentRevision: plan.revision, taskRevision: task.revision } }, task.revision);
    const linked = store.mutate(a.device, linkCommand) as Entity<Task>;
    const resultBytes = Buffer.from('Complete saved assignment result.\n');
    const upload = { requestId: randomUUID(), epoch, name: 'retained-result.md', base64: resultBytes.toString('base64') };
    const file = store.upload(a.device, upload.requestId, epoch, upload.name, upload.base64);
    const attempt: AssignmentAttempt = {
      id: randomUUID(), epoch, deviceId: a.device, assignmentId: plan.id, assignmentRevision: plan.revision, title: plan.value.title,
      agentId: agents[0].id, agentRevision: 1, agentName: 'Researcher', projectId: null,
      createdAt: 1000, updatedAt: 2000, deadlineAt: 61000, state: 'returned', message: 'Retained completed result',
      runId: randomUUID(), nativeSessionId: randomUUID(), terminal: { status: 'ok', turnId: randomUUID(), provider: 'fixture', model: 'fixture' },
      result: { file, preview: resultBytes.toString(), previewTruncated: false, disposition: 'visible' },
    };
    store.internalWrite('assignments:attempt:' + attempt.id, attempt);
    store.internalWrite('assignments:summary:' + attempt.id, attempt);
    const resultCommand = command('task', task.id, { ...linked.value, workResult: workResultPayload(attempt, 3000) }, linked.revision);
    const completedTask = store.mutate(a.device, resultCommand) as Entity<Task>;
    const taskHistory = store.taskHistory({ taskId: task.id });
    const folder = join(directory, 'checkout'); mkdirSync(folder);
    const project = store.mutate(a.device, command('project', 'project:history', { name: 'Retained team project', purpose: '', space: 'work', workspace: { folder, environment: 'local' } })) as Entity<Project>;
    const fullHandoffText = 'Complete retained handoff with Unicode 🦊 and final evidence.\n'.repeat(500);
    const teams = Array.from({ length: 106 }, (_, index) => {
      const id = randomUUID();
      const requests = agents.map(() => ({ create: randomUUID(), draft: randomUUID(), submit: randomUUID(), cancel: randomUUID() }));
      const steps: TeamWork['steps'] = agents.map((agent, stage) => ({
        agentId: agent.id, agentName: agent.value.name, agentRevision: agent.revision, role: stage ? 'build' : 'research',
        state: 'complete', attempt: 1, result: 'Original saved result ' + index + ':' + stage,
      }));
      if (index === 0) {
        const operation: AssistantOperation = {
          id: randomUUID(), requestId: requests[0].submit, deviceId: a.device, epoch, conversationId: randomUUID(), conversationRevision: 1,
          connectionGeneration: 'retained-fixture', nativeKey: 'agent:fixture:retained', nativeId: randomUUID(), nativeRunId: randomUUID(),
          state: 'completed', input: 'Original request', context: { draftId: 'draft:retained', draftRevision: 1, project: null, attachments: [], digest: 'fixture' },
          model: null, thinking: null, createdAt: new Date(1000).toISOString(), updatedAt: new Date(2000).toISOString(), text: fullHandoffText, lastSequence: 1,
        };
        steps[0].handoff = captureTeamHandoff(store, { epoch, teamId: id, stage: 0, attempt: 1, operation }, 2000);
        steps[0].result = fullHandoffText.slice(0, 20000);
      }
      const value = {
        id, revision: 1, device: a.device, epoch, projectId: project.id, projectName: project.value.name, projectRevision: project.revision,
        title: 'Saved workflow ' + index, brief: 'Retained work', folder, maxMinutes: 10,
        state: index % 2 ? 'cancelled' as const : 'complete' as const, message: 'Original completion', createdAt: index, updatedAt: index, next: 2,
        agents, steps, requests,
      };
      store.internalWrite('team:run:' + id, value); return value;
    });
    // A terminal label cannot hide an uncertain original execution in history.
    const uncertain = { ...structuredClone(teams[0]), id: randomUUID(), title: 'Unconfirmed original work', createdAt: 1000,
      steps: teams[0].steps.map((step, index) => index ? { ...step } : { ...step, state: 'unknown' as const, handoff: undefined }) };
    store.internalWrite('team:run:' + uncertain.id, uncertain);
    const retainedRecords = store.internalList('team:run:');
    const originalHandoff = store.internalRead('team:handoff:' + teams[0].steps[0].handoff!.id);
    store.close(); seeded = undefined;

    const api = async <T>(client: typeof a, path: string, body?: unknown) => {
      const response = await fetch(service!.origin + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
        headers: { Cookie: client.cookie, 'X-Edition3-Client': '1', 'Content-Type': 'application/json', Origin: service!.origin },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() as T };
    };
    const read = async <T>(path: string, body?: unknown) => { const result = await api<T>(b, path, body); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
    let retainedCursor = '', retainedSecondPage: TeamWorkPage | undefined;
    for (const lifecycle of ['first startup', 'restart']) {
      service = await startServer({ directory, port: 0, gateway });
      assert.equal((await read<{ status: string }>('health')).status, 'ready');
      // Allow a normal team polling cycle and task timer to run before comparing.
      await delay(3200);
      const snapshot = await read<Snapshot>('snapshot');
      assert.equal(snapshot.epoch, epoch);
      assert.equal(snapshot.deviceId, b.device);
      assert.deepEqual(snapshot.tasks.find(row => row.id === oldTask.id), oldTask, lifecycle + ': old rows need no rewrite');
      assert.deepEqual(snapshot.tasks.find(row => row.id === task.id), completedTask, lifecycle + ': task, source link and result stay exact');
      assert.deepEqual(snapshot.records?.content.find(row => row.id === source.id), source);
      assert.deepEqual(await read('tasks/history', { taskId: task.id }), taskHistory);
      const active = await read<TeamWorkPage>('work/team?view=active');
      assert.deepEqual(active.runs.map(run => run.id), [uncertain.id]);
      assert.equal(active.runs[0].steps[0].state, 'unknown');
      const history = await read<TeamWorkPage>('work/team?view=history&limit=25');
      assert.equal(history.runs.length, 25); assert.ok(history.nextCursor);
      assert.equal(history.runs.some(run => run.id === teams[0].id), false, 'oldest workflow is beyond the initial page');
      const secondPage = await read<TeamWorkPage>('work/team?view=history&limit=25&cursor=' + encodeURIComponent(history.nextCursor!));
      if (retainedCursor) assert.deepEqual(await read<TeamWorkPage>('work/team?view=history&limit=25&cursor=' + encodeURIComponent(retainedCursor)), retainedSecondPage, 'original cursor remains valid across restart');
      else { retainedCursor = history.nextCursor!; retainedSecondPage = secondPage; }
      const ids = history.runs.map(run => run.id);
      let cursor: string | null = history.nextCursor;
      while (cursor) {
        const page: TeamWorkPage = await read<TeamWorkPage>('work/team?view=history&limit=25&cursor=' + encodeURIComponent(cursor));
        ids.push(...page.runs.map(run => run.id)); cursor = page.nextCursor;
      }
      assert.deepEqual(ids, [...teams].reverse().map(team => team.id));
      const exact = await read<TeamWorkPage>('work/team?id=' + teams[0].id);
      assert.equal(exact.runs[0].steps[0].handoff!.sha256, teams[0].steps[0].handoff!.sha256);
      let fullText = '', offset = 0;
      for (;;) {
        const page = await read<TeamHandoffPage>('work/team/handoff?teamId=' + teams[0].id + '&id=' + teams[0].steps[0].handoff!.id + '&offset=' + offset + '&limit=7000');
        fullText += page.text; if (page.nextOffset === null) break; offset = page.nextOffset;
      }
      assert.equal(fullText, fullHandoffText, lifecycle + ': complete result survives paging');
      assert.deepEqual((await api(a, 'commands', linkCommand)).data, linked, 'original link receipt returns its original result');
      assert.deepEqual((await api(a, 'commands', resultCommand)).data, completedTask);
      assert.deepEqual((await api(a, 'attachments', upload)).data, file);
      assert.equal((await api(b, 'commands', linkCommand)).status, 409, 'another device cannot adopt the original receipt');
      const download = await fetch(service.origin + '/api/attachments/' + file.id, { headers: { Cookie: b.cookie }, signal: AbortSignal.timeout(5000) });
      assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), resultBytes);
      assert.deepEqual(service.store.internalList('team:run:'), retainedRecords);
      assert.deepEqual(service.store.internalRead('team:handoff:' + teams[0].steps[0].handoff!.id), originalHandoff);
      assert.deepEqual(service.store.internalRead('assignments:attempt:' + attempt.id), attempt);
      assert.equal(snapshot.records?.assignment.length, 1);
      assert.deepEqual(transportCalls, [], lifecycle + ': retained reads cannot dispatch provider effects');
      const closedOrigin = service.origin;
      await service.close(); service = undefined;
      await assert.rejects(fetch(closedOrigin + '/api/health', { signal: AbortSignal.timeout(1000) }), 'task-owned HTTP listener closes');
    }
  } finally {
    await service?.close(); seeded?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

