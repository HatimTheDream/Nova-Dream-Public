import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { AssignmentService } from '../apps/service/assignments.js';
import { AgentHub } from '../apps/service/agent-hub.js';
import { AgentRoutines } from '../apps/service/agent-routines.js';
import { WorkerTransport } from './fixtures/assignment-worker.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import { hubStatus } from '../packages/domain/agent-hub.js';
import type { ModuleAction } from '../packages/domain/module-actions.js';
import type { ReviewApproval } from '../packages/domain/approvals.js';
import { assignmentNeedsApproval } from '../packages/domain/assignment-approvals.js';

async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>, native = false) { const f = setup(native); try { await run(f); } finally { await f.service.close(); f.gateway.stopJournal?.(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); } }
function setup(native = false) {
  const config = native ? {mcp:{servers:{calculator:{command:'/official/driver',codex:{agents:['edition3-native-assignment'],defaultToolsApprovalMode:'prompt'},toolFilter:{include:['click']}}}}} : undefined;
  const directory = mkdtempSync(join(tmpdir(), 'e3-hub-')), store = new Store(directory), gateway = new WorkerTransport(directory, store.epoch, config), device = store.session().deviceId, service = new AssignmentService(store, gateway), hub = new AgentHub(store, service);
  const create = (kind: any, payload: any): any => store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind, entityId: `${kind}:${randomUUID()}`, expectedRevision: 0, payload });
  const agent = create('agent', { ...blankRecord('agent', 'UTC'), name: 'Nova', position: 'Research lead', instructions: 'Private agent instruction sentinel', ...(native ? { access: { tasks: 'read' } } : {}) });
  const plan = create('assignment', { ...blankRecord('assignment', 'UTC'), agentId: agent.id, agentRevision: 1, title: 'Research plan', brief: 'Private plan sentinel' });
  const start = () => service.start(device, { requestId: randomUUID(), epoch: store.epoch, assignmentId: plan.id, revision: 1, projectRevision: null });
  return { directory, store, gateway, device, service, hub, agent, plan, create, start };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 10));
test('Team and Hub surface only exact live native approvals and clear attention after outcome, expiry or stop', () => fixture(async f => {
  const started = f.start(); await tick(); await f.service.reconcile(started.id);
  const attempt = f.service.summary(started.id), now = Date.now();
  assert(attempt.nativeSessionId);
  const item: ReviewApproval = {id:'a'.repeat(64),revision:1,epoch:f.store.epoch,conversationId:attempt.id,nativeId:attempt.nativeSessionId,nativeKey:attempt.sessionKey!,connectionGeneration:attempt.connectionGeneration!,updatedAtMs:now,snapshot:{id:'plugin:bounded-check',status:'pending',createdAtMs:now,expiresAtMs:now+60000,presentation:{kind:'plugin',title:'Private native action',description:'Private tool detail',severity:'warning',allowedDecisions:['allow-once','deny']}}};
  let items=[item]; const hub = new AgentHub(f.store,f.service,()=>now,()=>items);
  assert.equal(hub.state().agents[0].status,'waiting-owner'); assert.equal(hub.state().roster[0].status,'waiting-owner');
  assert.doesNotMatch(JSON.stringify(hub.state()),/Private native action|Private tool detail/);
  for(const field of ['epoch','conversationId','nativeId','nativeKey','connectionGeneration'] as const) {items=[{...item,[field]:'foreign'}];assert.equal(hub.state().agents[0].status,'working');}
  items=[{...item,snapshot:{...item.snapshot,expiresAtMs:now}}];assert.equal(hub.state().agents[0].status,'working');
  items=[{...item,snapshot:{...item.snapshot,status:'allowed',resolvedAtMs:now,decision:'allow-once',reason:'user'}}];assert.equal(hub.state().agents[0].status,'working');
  items=[{...item,snapshot:{...item.snapshot,expiresAtMs:now},action:{requestId:randomUUID(),decision:'allow-once',state:'unknown'}}];assert.equal(hub.state().agents[0].status,'waiting-owner');
  assert.equal(assignmentNeedsApproval({...attempt,deadlineAt:now},items,now),false);
  f.gateway.available=false;assert.equal(hub.state().agents[0].status,'waiting-provider');f.gateway.available=true;
  items=[item];f.service.stop(f.device,{requestId:randomUUID(),epoch:f.store.epoch,attemptId:attempt.id});assert.equal(assignmentNeedsApproval(f.service.summary(attempt.id),items,now),false);
  f.gateway.finish();await f.service.reconcile(attempt.id);assert.equal(hub.state().agents[0].status,'idle');
}, true));
test('Hub derives states from real assignment receipts, distinguishes disconnect/uncertainty and keeps personal progress separate', () => fixture(async f => {
  assert.equal(f.hub.state().agents[0].status, 'idle');
  const attempt = f.start(); await tick();
  let member = f.hub.state().agents[0]; assert.equal(member.status, 'working'); assert.equal(member.active?.id, attempt.id);
  assert.equal(f.store.snapshot(f.device).taskState?.earnedXp, 0);
  f.gateway.available = false; member = f.hub.state().agents[0]; assert.equal(member.status, 'waiting-provider'); assert.equal(member.active?.id, attempt.id);
  f.gateway.available = true; f.gateway.finish('Secret full result body'); await f.service.reconcile(attempt.id);
  member = f.hub.state().agents[0]; assert.equal(member.status, 'idle'); assert.equal(member.returned, 1); assert.equal(member.active, null);
  const publicState = JSON.stringify(f.hub.state()); assert.doesNotMatch(publicState, /Private agent|Private plan|Secret full result/); assert.ok(member.latest?.result?.file.id);
  f.gateway.available = false; assert.equal(f.hub.state().agents[0].status, 'offline');
}));
test('Hub connects canonical plans, routines, Tasks and Content without creating duplicate records', () => fixture(async f => {
  const task = f.store.createRecordTask(f.device, { requestId: randomUUID(), epoch: f.store.epoch, origin: { kind: 'assignment', id: f.plan.id, revision: 1 }, title: 'Review saved research' });
  const routines = new AgentRoutines(f.store, f.service); const routine = routines.save(f.device, { requestId: randomUUID(), epoch: f.store.epoch, id: randomUUID(), expectedRevision: 0, value: { name: 'Research each morning', assignmentId: f.plan.id, assignmentRevision: 1, projectRevision: null, schedule: { kind: 'cron', expression: '0 9 * * *' }, timezone: 'UTC', enabled: false, archived: false, missed: 'skip' } }); routines.close();
  const attempt = f.start(); await tick(); f.gateway.finish('An original retained result'); const result = await f.service.reconcile(attempt.id);
  const content = f.store.createContentFromAssignment(f.device, { requestId: randomUUID(), epoch: f.store.epoch, attemptId: attempt.id, sha256: result.result!.file.sha256 });
  const before = f.store.entityCursor, member = f.hub.state().agents[0];
  assert.equal(member.plans[0].id, f.plan.id); assert.equal(member.routines[0].id, routine.id);
  assert.equal(member.tasks[0].id, task.id); assert.equal(member.content[0].id, content.id); assert.equal(f.store.entityCursor, before);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'agent', entityId: f.agent.id, expectedRevision: 1, payload: { ...f.agent.value, name: 'Nova renamed' } });
  assert.equal(f.hub.state().agents[0].name, 'Nova renamed'); assert.equal(f.hub.state().agents[0].latest?.agentName, 'Nova');
}));
test('all saved attempts contribute beyond the 100-row UI history page, with compact projections repaired from canonical summaries', () => fixture(async f => {
  const started = f.start(); await tick(); f.gateway.finish(); await f.service.reconcile(started.id);
  const original = f.service.summary(started.id);
  f.store.internalAtomic(() => { for (let i = 0; i < 115; i++) { const id = randomUUID(); f.store.internalWrite(`assignments:summary:${id}`, { ...original, id, createdAt: original.createdAt - i - 1 }); } });
  await f.service.close(); const rebuilt = new AssignmentService(f.store, f.gateway), hub = new AgentHub(f.store, rebuilt);
  try { assert.equal(rebuilt.state().attempts.length, 100); assert.equal(hub.state().agents[0].returned, 116); assert.equal(rebuilt.activity().length, 116); }
  finally { await rebuilt.close(); }
}));
test('roster paging never loses an active archived agent, and a selected active identity resolves its own page', () => fixture(async f => {
  for (let i = 0; i < 25; i++) f.create('agent', { ...blankRecord('agent', 'UTC'), name: `Agent ${i}`, position: 'Editor' });
  const first = f.hub.state(), second = f.hub.state(first.nextCursor!), third = f.hub.state(second.nextCursor!);
  assert.equal(first.agents.length, 12); assert.equal(second.agents.length, 12); assert.equal(third.agents.length, 2);
  assert.equal(new Set([...first.agents, ...second.agents, ...third.agents].map(a => a.id)).size, 26);
  assert.ok(f.hub.state(undefined, false, f.agent.id).agents.some(a => a.id === f.agent.id));
  const attempt = f.start(); await tick();
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'agent', entityId: f.agent.id, expectedRevision: 1, payload: { ...f.agent.value, archived: true } });
  assert.equal(f.hub.state().total, 26); assert.equal(f.hub.state(undefined, false, f.agent.id).activeAgentId, f.agent.id);
  f.gateway.finish(); await f.service.reconcile(attempt.id); assert.equal(f.hub.state().total, 25); assert.equal(f.hub.state(undefined, true).agents[0].id, f.agent.id);
  assert.throws(() => f.hub.state('agent:missing'), /roster changed/);
}));
test('reviewed unresolved attempts do not masquerade as new working activity', () => fixture(async f => {
  const attempt = f.start(); await tick();
  const active = f.service.activity()[0];
  assert.equal(hubStatus({ ...active, state: 'unknown' }, true).status, 'waiting-owner');
  assert.equal(hubStatus({ ...active, state: 'prepared' }, true).status, 'waiting-provider');
  // Owner-reviewed uncertainty keeps its original data but releases the slot.
  const key = `assignments:attempt:${attempt.id}`, saved = f.store.internalRead<any>(key);
  f.store.internalWrite(key, { ...saved, state: 'unknown', stopReason: 'owner' });
  f.service.acknowledgeUnresolved(f.device, { requestId: randomUUID(), epoch: f.store.epoch, attemptId: attempt.id, understandUnconfirmed: true });
  const member = f.hub.state().agents[0]; assert.equal(member.status, 'idle'); assert.equal(member.unresolved, 1); assert.equal(member.returned, 0);
}));
test('returned work retains pending review and links only applied canonical records, including older attempts', () => fixture(async f => {
  const attempt=f.start();await tick();f.gateway.finish('Saved research');await f.service.reconcile(attempt.id);
  const originalCursor=f.store.entityCursor, id=randomUUID();
  const action:ModuleAction={id,epoch:f.store.epoch,conversationId:attempt.id,assignmentId:attempt.id,operationId:attempt.id,deviceId:f.device,operation:'records.save',inputHash:'fixture',input:{kind:'task',changes:{title:'Private proposed title'}},title:'Save Task',revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),state:'pending',external:false,preview:{title:'Private proposed title'}};
  f.store.internalWrite('modules:action:'+id,action);
  let member=f.hub.state().agents[0];
  assert.equal(f.store.entityCursor,originalCursor);assert.equal(member.status,'waiting-owner');
  assert.equal(member.reviews[0].attemptId,attempt.id);assert.equal(member.appliedChanges,0);assert.equal(member.tasks.length,0);
  assert.doesNotMatch(JSON.stringify(f.hub.state()),/Private proposed title/);
  const later=f.start();await tick();f.gateway.finish('Later result');await f.service.reconcile(later.id);
  assert.equal(f.hub.state().agents[0].status,'waiting-owner');
  const task=f.create('task',{title:'Review canonical research',notes:'',status:'open',planned:'2026-09-13',due:'2026-09-13'});
  f.store.internalWrite('modules:action:'+id,{...action,state:'applied',revision:2,result:{id:task.id}});
  member=f.hub.state().agents[0];assert.equal(member.status,'idle');assert.equal(member.reviews.length,0);
  assert.equal(member.appliedChanges,1);assert.equal(member.tasks[0].id,task.id);
  const hub=new AgentHub(f.store,f.service);assert.equal(hub.state().agents[0].tasks[0].id,task.id);
  assert.equal(f.store.snapshot(f.device).taskState?.earnedXp,0);
}));

test('team execution is visible in the hub with a direct conversation link and never exports the private brief', () => fixture(async f => {
  const id=randomUUID(),conversationId=randomUUID(),operationId=randomUUID();
  f.store.internalWrite('team:run:'+id,{id,epoch:f.store.epoch,title:'Team check',brief:'Private team brief sentinel',state:'running',next:0,steps:[{agentId:f.agent.id,role:'build',state:'running',conversationId,operationId}]});
  f.store.internalWrite('assistant:operation:'+operationId,{state:'running'});
  assert.equal(f.hub.state().agents[0].status,'working');assert.equal(f.hub.state().agents[0].team?.conversationId,conversationId);assert.equal(f.hub.state().roster[0].status,'working');
  assert.doesNotMatch(JSON.stringify(f.hub.state()),/Private team brief/);
  assert.throws(()=>f.start(),/unfinished team stage/);
  f.store.internalWrite('assistant:operation:'+operationId,{state:'unknown'});assert.equal(f.hub.state().agents[0].status,'waiting-owner');
}));
