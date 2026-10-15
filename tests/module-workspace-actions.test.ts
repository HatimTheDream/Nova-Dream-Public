import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { Store } from '../apps/service/store.js';
import { ModuleActions, type ModuleServices } from '../apps/service/module-actions.js';
import { createWorkspaceOperations } from '../apps/service/module-workspace-actions.js';
import { HomeLibrary } from '../apps/service/home-library.js';
import { HomeFeed } from '../apps/service/home-feed.js';
import { AgentActivity } from '../apps/service/agent-activity.js';
import { HubMeetings } from '../apps/service/hub-meetings.js';
import { AgentHub } from '../apps/service/agent-hub.js';
import { AgentRoutines } from '../apps/service/agent-routines.js';
import { AssignmentService } from '../apps/service/assignments.js';
import { ContentWorkspace } from '../apps/service/content-workspace.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import { defaultAgentActivityPreferences } from '../packages/domain/agent-activity.js';
import type { ModuleAction } from '../packages/domain/module-actions.js';
import type { ContentJob } from '../packages/domain/content-workspace.js';
import { WorkerTransport } from './fixtures/assignment-worker.js';

const turn = () => new Promise<void>(resolve => setTimeout(resolve, 25));
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-module-workspace-')), store = new Store(directory), device = store.session().deviceId;
  const gateway = new WorkerTransport(directory, store.epoch), assignments = new AssignmentService(store, gateway);
  const activity = new AgentActivity(store, assignments), meetings = new HubMeetings(store, assignments, Date.now, activity);
  activity.attachMeetings(meetings);
  const library = new HomeLibrary(store), feed = new HomeFeed(store), hub = new AgentHub(store, assignments, Date.now, () => [], activity);
  const routines = new AgentRoutines(store, assignments), content = new ContentWorkspace(store, assignments);
  const conversation: any = { id: randomUUID(), nativeId: randomUUID(), nativeKey: 'agent:main:module-workspace', permissionMode: 'workspace', state: 'ready', connectionGeneration: gateway.generation };
  const operation: any = { id: randomUUID(), epoch: store.epoch, nativeId: conversation.nativeId, nativeKey: conversation.nativeKey, conversationId: conversation.id, deviceId: device, state: 'running', context: { workMode: 'build' } };
  const deps = { store, gateway, assignments, assistant: { conversations: () => [conversation], operations: () => [operation] },
    homeLibrary: library, homeFeed: feed, agentActivity: activity, hubMeetings: meetings, agentHub: hub, agentRoutines: routines, contentWorkspace: content } as unknown as ModuleServices;
  let modules = new ModuleActions(deps);
  const input = (name: string, value: unknown = {}, write = true) => ({ operation: name, input: value, epoch: store.epoch, nativeId: conversation.nativeId, nativeKey: conversation.nativeKey, toolCallId: randomUUID(), permissionMode: conversation.permissionMode, write });
  const invoke = (name: string, value: unknown = {}) => modules.invoke(input(name, value)) as Promise<ModuleAction>;
  const read = (name: string, value: unknown = {}) => modules.invoke(input(name, value, false)) as Promise<any>;
  const decide = (action: ModuleAction, decision: 'apply' | 'cancel' | 'check') => modules.decide(device, { requestId: randomUUID(), epoch: store.epoch, actionId: action.id, expectedRevision: action.revision, decision });
  const agents = ['Aster', 'Harbor'].map(name => {
    const saved = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'agent', entityId: 'agent:' + randomUUID(), expectedRevision: 0, payload: { ...blankRecord('agent', 'UTC'), name, position: 'Editor', access: { content: 'read' } } });
    return store.readEntity('agent', saved.id)!;
  });
  const plans = agents.map(agent => store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'assignment', entityId: 'assignment:' + randomUUID(), expectedRevision: 0, payload: { ...blankRecord('assignment', 'UTC'), title: 'Read the saved brief', agentId: agent.id, agentRevision: agent.revision } }));
  const savedContent = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'content', entityId: 'content:' + randomUUID(), expectedRevision: 0, payload: { ...blankRecord('content', 'UTC'), title: 'A kept draft', body: '# Original writing', brief: 'Explain the saved work.' } });
  const item = store.readEntity('content', savedContent.id)!;
  t.after(async () => { await modules.close(); activity.close(); routines.close(); await meetings.close(); await assignments.close(); gateway.stopJournal?.(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, device, gateway, assignments, activity, meetings, library, feed, hub, routines, content, deps, agents, plans, item, conversation,
    input, invoke, read, decide, get modules() { return modules; }, async restart() { await modules.close(); modules = new ModuleActions(deps); } };
}

test('workspace catalog splits canonical commands, hides authority envelopes and omits unsupported controls', async t => {
  const f = fixture(t), operations = createWorkspaceOperations(f.deps), catalog = await f.read('catalog');
  for (const [name, operation] of Object.entries(operations)) {
    assert(catalog.operations.some((item: any) => item.operation === name), name);
    const schema: any = z.toJSONSchema(operation.schema, { unrepresentable: 'any' });
    assert.equal(schema.type, 'object', name);
    for (const key of ['requestId', 'epoch', 'deviceId', 'writerId']) assert.equal(key in (schema.properties ?? {}), false, `${name}:${key}`);
  }
  for (const name of ['agents.preferences.save', 'agents.meetings.start', 'agents.routines.save', 'content.work', 'content.work.start', 'content.review.decide']) {
    assert.equal((await f.read('catalog', { operation: name })).review, true, name);
  }
  assert(!Object.keys(operations).some(name => /acknowledge|grant|permission|skill|focus\./.test(name)));
  const absent = createWorkspaceOperations({ ...f.deps, homeLibrary: undefined, homeFeed: undefined, agentActivity: undefined, hubMeetings: undefined, agentHub: undefined, agentRoutines: undefined, contentWorkspace: undefined });
  assert(!Object.keys(absent).some(name => name.startsWith('home.') || name.startsWith('agents.') || name.startsWith('content.')));
});

test('Library commands use original receipts, refuse forged envelopes and preserve newer writing', async t => {
  const f = fixture(t), value = { id: 'note:one', expectedRevision: 0, value: { kind: 'note', title: 'Keep', body: 'Original', archived: false } };
  const input = f.input('home.items.save', value), first = await f.modules.invoke(input) as ModuleAction;
  assert.equal(first.state, 'applied'); assert.equal((await f.modules.invoke(input) as ModuleAction).id, first.id);
  assert.equal(f.library.state(f.device).items[0].revision, 1);
  for (const patch of [{ requestId: randomUUID() }, { epoch: randomUUID() }, { type: 'collection-save' }, { deviceId: randomUUID() }]) {
    await assert.rejects(f.invoke('home.items.save', { ...value, ...patch }));
  }
  assert.equal((await f.invoke('home.items.save', { ...value, expectedRevision: 1, value: { ...value.value, body: 'New writing' } })).state, 'applied');
  assert.equal((await f.invoke('home.items.save', value)).state, 'failed');
  assert.equal(f.library.state(f.device).items[0].body, 'New writing');
  await f.restart(); assert.equal((await f.modules.invoke(input) as ModuleAction).id, first.id);
  assert.equal((await f.read('home.library.read')).items[0].body, 'New writing');
});

test('Feed and Library reads retain exact source identities without dispatching work', async t => {
  const f = fixture(t);
  await f.invoke('home.items.save', { id: 'note:feed', expectedRevision: 0, value: { kind: 'note', title: 'Saved note', body: 'Exact source', archived: false } });
  const reference = { kind: 'note', id: 'note:feed', revision: 1 };
  const opened = await f.read('home.feed.reference', { reference }); assert.match(opened.text, /Exact source/);
  const captured = await f.invoke('home.context.capture', { references: [reference] }); assert.equal(captured.state, 'applied');
  await f.invoke('home.items.save', { id: 'note:feed', expectedRevision: 1, value: { kind: 'note', title: 'Changed', body: 'New source', archived: false } });
  assert.equal((await f.read('home.references.read', { reference })).availability, 'changed');
  assert.equal((await f.invoke('home.context.capture', { references: [reference] })).state, 'failed');
  await f.read('home.feed.read'); assert.equal(f.gateway.nativeCalls.length, 0);
});

test('personality and proactive preferences require review and never grant agent access', async t => {
  const f = fixture(t), agent = f.agents[0], { sleep, ...defaults } = defaultAgentActivityPreferences();
  const pending = await f.invoke('agents.preferences.save', { agentId: agent.id, expectedRevision: 0, value: { ...defaults, personality: 'curious', initiative: 'proactive' } });
  assert.equal(pending.state, 'pending'); assert.equal(f.activity.preference(agent.id).revision, 0);
  assert.equal((await f.decide(pending, 'apply')).state, 'applied');
  assert.equal(f.activity.preference(agent.id).value.initiative, 'proactive');
  assert.deepEqual(f.store.readEntity('agent', agent.id)?.value.access, agent.value.access);
  const sleeping = await f.invoke('agents.sleep', { agentId: agent.id, expectedRevision: 1 }); assert.equal(sleeping.state, 'applied');
  assert.equal(f.activity.preference(agent.id).value.sleep, 'asleep');
  assert.equal((await f.invoke('agents.wake', { agentId: agent.id, expectedRevision: 2 })).state, 'applied');
  assert.equal(f.gateway.nativeCalls.length, 0);
});

test('Headquarters commands retain fixed action types and exact layout revisions', async t => {
  const f = fixture(t), revision = f.hub.state().layout.revision;
  const input = f.input('agents.hub.add-room', { template: 'meeting', name: 'Studio meeting', expectedRevision: revision });
  const saved = await f.modules.invoke(input) as ModuleAction; assert.equal(saved.state, 'applied');
  const room = f.hub.state().layout.rooms.find(value => value.name === 'Studio meeting')!;
  await f.modules.invoke(input); assert.equal(f.hub.state().layout.rooms.filter(value => value.id === room.id).length, 1);
  await assert.rejects(f.invoke('agents.hub.add-room', { template: 'meeting', name: 'Injected', expectedRevision: revision, action: { type: 'place-agent' } }));
  assert.equal((await f.invoke('agents.hub.rename-room', { roomId: room.id, name: 'New name', expectedRevision: revision })).state, 'failed');
  assert.equal(f.hub.state().layout.rooms.find(value => value.id === room.id)?.name, 'Studio meeting');
});

test('meeting start is reviewed and original running speakers remain unconfirmed on repeated checks', async t => {
  const f = fixture(t), room = f.hub.state().layout.rooms.find(room => room.template === 'boardroom')!;
  const gathering = await f.invoke('agents.meetings.gather', { roomId: room.id, title: 'Review', agenda: 'Discuss the saved brief.', agentIds: f.agents.map(agent => agent.id) });
  assert.equal(gathering.state, 'applied'); assert.equal(f.gateway.nativeCalls.length, 0);
  const meeting: any = gathering.result;
  const pending = await f.invoke('agents.meetings.start', { meetingId: meeting.id, expectedRevision: meeting.revision });
  assert.equal(pending.state, 'pending'); assert.equal(f.gateway.nativeCalls.length, 0);
  const running = await f.decide(pending, 'apply'); assert.equal(running.state, 'unknown'); await turn();
  const calls = f.gateway.nativeCalls.length; assert.equal(calls, 1);
  assert.equal((await f.decide(running, 'check')).state, 'unknown'); assert.equal(f.gateway.nativeCalls.length, calls);
  const direct = createWorkspaceOperations(f.deps)['agents.meetings.pause'];
  const detail = f.meetings.detail(meeting.id);
  // A speaker may exist before its id is copied into the meeting projection.
  assert.equal(direct.resultState!({ ...detail, state: 'paused', turns: detail.turns.map(({ attemptId, ...turn }) => turn) }), 'unknown');
});

test('routine save requires review, previews do not enable schedules and retries keep one occurrence definition', async t => {
  const f = fixture(t), value = { name: 'Read daily', assignmentId: f.plans[0].id, assignmentRevision: f.plans[0].revision, projectRevision: null,
    schedule: { kind: 'every', minutes: 60, anchor: new Date(Date.now() + 60_000).toISOString() }, timezone: 'UTC', missed: 'review', enabled: true, archived: false };
  assert.equal((await f.read('agents.routines.preview', value)).times.length, 5); assert.equal(f.routines.state().routines.length, 0);
  const input = f.input('agents.routines.save', { id: randomUUID(), expectedRevision: 0, value });
  const pending = await f.modules.invoke(input) as ModuleAction; assert.equal(pending.state, 'pending'); assert.equal(f.routines.state().routines.length, 0);
  assert.equal((await f.decide(pending, 'apply')).state, 'applied'); await f.modules.invoke(input);
  assert.equal(f.routines.state().routines.length, 1); assert.equal(f.gateway.nativeCalls.length, 0);
});

test('Content work lost responses reconcile the original job and never repeat dispatch', async t => {
  const f = fixture(t), original = f.content.command.bind(f.content); let lose = true;
  f.content.command = async (device, input) => { const result = await original(device, input); if (lose) { lose = false; throw new Error('Lost saved Content work response'); } return result; };
  const input = f.input('content.work', { contentId: f.item.id, expectedRevision: f.item.revision, mode: 'draft', agentId: f.agents[0].id, instructions: 'Write a proposal only.' });
  const pending = await f.modules.invoke(input) as ModuleAction; assert.equal(pending.state, 'pending'); assert.equal(f.content.state(f.item.id).jobs.length, 0);
  const unknown = await f.decide(pending, 'apply'); assert.equal(unknown.state, 'unknown'); await turn();
  const job = f.content.state(f.item.id).jobs[0]; assert(job.attempt); assert.equal(f.gateway.nativeCalls.length, 1);
  await f.restart(); const checked = await f.decide(unknown, 'check'); assert.equal(checked.state, 'unknown'); assert.equal(f.gateway.nativeCalls.length, 1);
  f.gateway.finish('A complete proposed draft'); await f.assignments.reconcile(job.attempt!.id);
  const done = await f.decide(checked, 'check'); assert.equal(done.state, 'applied'); assert.equal((done.result as ContentJob).id, job.id);
  assert.equal((await f.read('content.result', { jobId: job.id })).text, 'A complete proposed draft');
  assert.equal(f.store.readEntity('content', f.item.id)?.value.body, '# Original writing');
  await f.modules.invoke(input); assert.equal(f.content.state(f.item.id).jobs.length, 1); assert.equal(f.gateway.nativeCalls.length, 1);
  const applying = await f.invoke('content.apply-work', { contentId: f.item.id, expectedRevision: f.item.revision, jobId: job.id, placement: 'replace' });
  assert.equal(applying.state, 'pending');
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'content', entityId: f.item.id, expectedRevision: f.item.revision, payload: { ...f.item.value, body: 'Newer owner writing' } });
  assert.equal((await f.decide(applying, 'apply')).state, 'failed'); assert.equal(f.store.readEntity('content', f.item.id)?.value.body, 'Newer owner writing');
});

test('missing async receipts cannot turn a check into a new Content run or assignment stop', async t => {
  const f = fixture(t), operations = createWorkspaceOperations(f.deps);
  const action = { id: randomUUID(), epoch: f.store.epoch, deviceId: f.device, input: { contentId: f.item.id, expectedRevision: f.item.revision, mode: 'draft', agentId: f.agents[0].id, instructions: '' } } as unknown as ModuleAction;
  assert.throws(() => operations['content.work'].check!(action, randomUUID()), /no confirmed receipt/);
  assert.throws(() => operations['assignments.stop'].check!({ ...action, input: { attemptId: randomUUID() } }, randomUUID()), /no confirmed receipt/);
  assert.equal(f.content.state(f.item.id).jobs.length, 0); assert.equal(f.gateway.nativeCalls.length, 0);
});

test('unconfirmed work without a receipt remains unknown after checking and never dispatches', async t => {
  const f = fixture(t); f.content.command = async () => { throw new Error('Transport interrupted before a receipt was observed'); };
  const pending = await f.invoke('content.work', { contentId: f.item.id, expectedRevision: f.item.revision, mode: 'draft', agentId: f.agents[0].id, instructions: '' });
  const unknown = await f.decide(pending, 'apply'); assert.equal(unknown.state, 'unknown');
  assert.equal((await f.decide(unknown, 'check')).state, 'unknown');
  assert.equal(f.content.state(f.item.id).jobs.length, 0); assert.equal(f.gateway.nativeCalls.length, 0);
});

test('Content review decisions require review and stale approval preserves newer drafts', async t => {
  const f = fixture(t), source = { contentId: f.item.id, expectedRevision: f.item.revision };
  const requested = await f.invoke('content.review.request', { ...source, reviewerId: null }), review: any = requested.result;
  const approved = await f.invoke('content.review.decide', { ...source, reviewId: review.id, reviewRevision: review.revision, decision: 'approved', note: '' });
  assert.equal(approved.state, 'pending'); assert.equal(f.content.state(f.item.id).reviews[0].state, 'requested');
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'content', entityId: f.item.id, expectedRevision: f.item.revision, payload: { ...f.item.value, body: 'Newer owner writing' } });
  assert.equal((await f.decide(approved, 'apply')).state, 'failed');
  assert.equal(f.store.readEntity('content', f.item.id)?.value.body, 'Newer owner writing');
  assert.equal((await f.read('content.history', { id: f.item.id })).versions.length, 2);
});

test('Task history and ordering reuse maintained revision and membership checks', async t => {
  const f = fixture(t), task = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'task', entityId: 'task:' + randomUUID(), expectedRevision: 0, payload: { title: 'Kept task', notes: '', status: 'open', planned: '', due: '' } });
  assert.equal((await f.read('tasks.history', { taskId: task.id })).versions[0].id, task.id);
  const state = await f.read('tasks.state'); assert(Array.isArray(state.focus)); assert(Array.isArray(state.orders));
  const invalid = await f.invoke('tasks.order', { date: '2099-01-01', timezone: 'UTC', expectedRevision: 0, taskIds: ['task:not-current'] });
  assert.equal(invalid.state, 'failed'); assert.equal((await f.read('tasks.state')).orders.length, 0);
});
