import test from 'node:test';
import { computerControlGuidance } from '../packages/domain/computer-control.js';
import { workerInputHash } from '../apps/service/worker-plugin/identity.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { AssignmentService } from '../apps/service/assignments.js';
import { ModuleActions, type ModuleServices } from '../apps/service/module-actions.js';
import { WorkerTransport } from './fixtures/assignment-worker.js';
import { agentMayUse, agentAccessSchema, matchesAssignmentRuntimePolicy, assignmentRuntimePolicy, configuredAssignmentNativeTools, assignmentPolicyWithNativeTools, assignmentNativeRuntimeAgent } from '../packages/domain/agent-capabilities.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { ModuleAction } from '../packages/domain/module-actions.js';

test('agent capabilities are sparse, module-scoped and cannot expand a pinned grant',()=>{
 assert.deepEqual(agentAccessSchema.parse({tasks:'edit'}),{tasks:'edit'});
 assert.equal(agentMayUse({tasks:'read'},{tasks:'edit'},'records.save',{kind:'task'},true),false);
 assert.equal(agentMayUse({tasks:'edit'},{tasks:'read'},'records.save',{kind:'task'},true),false);
 assert.equal(agentMayUse({tasks:'edit'},{tasks:'edit'},'records.save',{kind:'agent'},true),false);
 assert.equal(agentMayUse({tasks:'edit'},{tasks:'edit'},'agents.start',{},true),false);
 assert.equal(agentMayUse({tasks:'edit'},{tasks:'edit'},'records.save',{kind:'task'},true),true);
});
test('native policy normalization may reorder fields but may not add grants',()=>{
 const reordered={subagents:{allowAgents:[]},tools:{elevated:{enabled:false},allow:['nova_read','nova_write']},skills:[],name:'Nova Dream assignments'};
 assert.equal(matchesAssignmentRuntimePolicy(reordered),true);
 assert.equal(matchesAssignmentRuntimePolicy({...assignmentRuntimePolicy,tools:{...assignmentRuntimePolicy.tools,allow:['nova_read','nova_write','exec']}}),false);
 assert.equal(matchesAssignmentRuntimePolicy({...reordered,workspace:'/unreviewed'}),false);
});
for(const native of [false,true]) test(`a ${native?'native-tool':'workspace'} assignment proposal uses canonical records, is reviewed once, and loses access on stop or revocation`,async t=>{
 const config=native?{mcp:{servers:{calculator:{command:'/official/driver',codex:{agents:[assignmentNativeRuntimeAgent],defaultToolsApprovalMode:'prompt'},toolFilter:{include:['click']}}}}}:undefined;
 const dir=mkdtempSync(join(tmpdir(),'e3-agent-tools-')),store=new Store(dir),device=store.session().deviceId,gateway=new WorkerTransport(dir,store.epoch,config),assignments=new AssignmentService(store,gateway);
 const create=(kind:any,value:any)=>store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind,entityId:kind+':'+randomUUID(),expectedRevision:0,payload:{...blankRecord(kind,'UTC'),...value}});
 let agent:any=create('agent',{name:'Planner',position:'Planning',access:{tasks:'edit'}});
 const plan=create('assignment',{title:'Make a plan',agentId:agent.id,agentRevision:agent.revision});
 const service=new ModuleActions({store,assignments,gateway,assistant:{conversations:()=>[],operations:()=>[]}} as unknown as ModuleServices);
 t.after(async()=>{await service.close();await assignments.close();gateway.stopJournal?.();store.close();rmSync(dir,{recursive:true,force:true});});
 const a=assignments.start(device,{requestId:randomUUID(),epoch:store.epoch,assignmentId:plan.id,revision:plan.revision,projectRevision:null});
 for(let n=0;n<100&&assignments.summary(a.id).state!=='running';n++)await new Promise(r=>setTimeout(r,5));
 const running=assignments.summary(a.id);assert.equal(running.state,'running');assert(running.sessionKey!.startsWith(`agent:edition3${native?'-native':''}-assignment:`));assert.equal(gateway.nativeCalls[0].disableTools,false);
 const input={epoch:store.epoch,nativeKey:running.sessionKey!,nativeId:gateway.nativeId,permissionMode:'read-only',toolCallId:randomUUID(),operation:'records.save',input:{kind:'task',expectedRevision:0,changes:{title:'Prepare agenda'}},write:true};
 const proposal=await service.invoke(input) as ModuleAction;assert.equal(proposal.state,'pending');assert.equal(proposal.assignmentId,a.id);assert.equal(store.listEntities('task').length,0);
 assert.equal((await service.invoke(input) as ModuleAction).id,proposal.id);
 await assert.rejects(service.invoke({...input,nativeId:randomUUID()}),/no longer active/);
 await assert.rejects(service.invoke({...input,toolCallId:randomUUID(),input:{...input.input,kind:'contact'}}),/selected capabilities/);
 const command={requestId:randomUUID(),epoch:store.epoch,actionId:proposal.id,expectedRevision:proposal.revision,decision:'apply'};
 assert.equal((await service.decide(device,command)).state,'applied');assert.equal((await service.decide(device,command)).state,'applied');assert.equal(store.listEntities('task')[0].revision,1);
 const later=await service.invoke({...input,toolCallId:randomUUID()}) as ModuleAction;
 agent=store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind:'agent',entityId:agent.id,expectedRevision:agent.revision,payload:{...agent.value,access:{tasks:'read'}}});
 await assert.rejects(service.decide(device,{...command,requestId:randomUUID(),actionId:later.id,expectedRevision:later.revision}),/Access/);
 await assert.rejects(service.invoke({...input,toolCallId:randomUUID()}),/selected capabilities/);
 const read={...input,operation:'records.list',input:{kind:'task'},write:false,toolCallId:randomUUID()};assert.equal((await service.invoke(read) as any).total,1);
 assignments.stop(device,{requestId:randomUUID(),epoch:store.epoch,attemptId:a.id});await assert.rejects(service.invoke(read),/no longer active/);
});

test('native MCP tools require explicit isolated worker selection, finite filters and prompt approval',()=>{
 const server={command:'/official/driver',codex:{agents:[assignmentNativeRuntimeAgent],defaultToolsApprovalMode:'prompt'},toolFilter:{include:['start_session','click'],exclude:['click']}};
 const config={mcp:{servers:{calculator:server,unscoped:{...server,codex:{defaultToolsApprovalMode:'prompt'}},main:{...server,codex:{...server.codex,agents:['main']}}}}};
 assert.deepEqual(configuredAssignmentNativeTools(config),['calculator__start_session']);
 for(const modified of [{...server,toolFilter:{include:['*']}},{...server,toolFilter:{}},{...server,codex:{...server.codex,defaultToolsApprovalMode:'approve'}}]) assert.throws(()=>configuredAssignmentNativeTools({mcp:{servers:{calculator:modified}}}));
 assert.deepEqual(configuredAssignmentNativeTools({mcp:{servers:{calculator:{...server,enabled:false}}}}),[]);
 assert.equal(matchesAssignmentRuntimePolicy(assignmentPolicyWithNativeTools(['calculator__start_session'])),false);
});

test('native work pins tools and approval identity; proposals stay on the workspace-only runtime',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'e3-native-worker-')),store=new Store(dir),device=store.session().deviceId;
 const config={mcp:{servers:{calculator:{command:'/official/driver',codex:{agents:[assignmentNativeRuntimeAgent],defaultToolsApprovalMode:'prompt'},toolFilter:{include:['click']}}}}};
 const gateway=new WorkerTransport(dir,store.epoch,config),assignments=new AssignmentService(store,gateway);
 t.after(async()=>{await assignments.close();gateway.stopJournal?.();store.close();rmSync(dir,{recursive:true,force:true});});
 const create=(kind:any,value:any)=>store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind,entityId:kind+':'+randomUUID(),expectedRevision:0,payload:{...blankRecord(kind,'UTC'),...value}});
 const agent=create('agent',{name:'Bounded maker',position:'Maker',access:{tasks:'read'}});
 const start=async(mode:'work'|'proposal'|'discussion')=>{
  const plan=create('assignment',{title:'Computer check',agentId:agent.id,agentRevision:agent.revision,executionMode:mode});
  const attempt=assignments.start(device,{requestId:randomUUID(),epoch:store.epoch,assignmentId:plan.id,revision:plan.revision,projectRevision:null});
  for(let n=0;n<100&&assignments.summary(attempt.id).state!=='running';n++)await new Promise(r=>setTimeout(r,5));
  await assignments.reconcile(attempt.id);return assignments.summary(attempt.id);
 };
 const work=await start('work'); const captured=store.internalRead<any>('assignments:attempt:'+work.id); assert(captured.prompt.includes(computerControlGuidance)); assert.equal(captured.inputHash,workerInputHash(captured.prompt)); assert.equal(gateway.nativeCalls[0].message,captured.prompt);assert.deepEqual(work.nativeTools,['calculator__click']);assert.match(work.sessionKey!,/^agent:edition3-native-assignment:/);assert.equal(assignments.approvalTargets()[0].nativeId,gateway.nativeId);assert.equal(assignments.approvalTargets()[0].readOnly,false);
 gateway.finish('Observed Calculator');gateway.observation.terminalReceipt.successfulToolNames=['calculator__click'];await assignments.reconcile(work.id);assert.equal(assignments.summary(work.id).state,'returned');assert.equal(assignments.approvalTargets()[0].readOnly,true);
 for(const mode of ['proposal','discussion'] as const){const attempt=await start(mode);assert.equal(gateway.nativeCalls.at(-1).message.includes(computerControlGuidance),false);assert.equal(attempt.nativeTools,undefined);assert.match(attempt.sessionKey!,/^agent:edition3-assignment:/);gateway.finish();await assignments.reconcile(attempt.id);}
});
