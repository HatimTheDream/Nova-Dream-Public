import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Companions } from '../apps/service/companions.js';
import { companionLinkData, companionSignedData, type CompanionPacket } from '../packages/domain/companion.js';
import { Store } from '../apps/service/store.js';
import { ModuleActions, type ModuleServices } from '../apps/service/module-actions.js';
import { ContactCrm } from '../apps/service/contact-crm.js';
import { CalendarService } from '../apps/service/calendar.js';
import { Accounts } from '../apps/service/accounts.js';
import type { ModuleAction } from '../packages/domain/module-actions.js';
import { sourcePdf } from './fixtures/source-files.js';
function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'e3-module-')),store=new Store(directory),device=store.session().deviceId,generation=randomUUID();
 const conversation:any={id:randomUUID(),nativeId:randomUUID(),nativeKey:'agent:main:test',permissionMode:'workspace',state:'ready',connectionGeneration:generation};
 const operation:any={id:randomUUID(),epoch:store.epoch,nativeId:conversation.nativeId,nativeKey:conversation.nativeKey,conversationId:conversation.id,deviceId:device,state:'running',context:{workMode:'build'}};
 const assistant:any={conversations:()=>[conversation],operations:()=>[operation]},gateway:any={status:()=>({generation})};
 const accounts=new Accounts(store),calendar=new CalendarService(store,accounts),crm=new ContactCrm(store);
 const providerCalls:any[]=[],review={id:randomUUID(),revision:1,digest:'a'.repeat(64),state:'prepared',message:{subject:'Hello',to:['one@example.test'],bodyText:'Reviewed writing'}};
 const mailDelivery:any={prepare:async(_d:any,i:any)=>{providerCalls.push(['prepare',i]);return review;},confirm:async(_d:any,i:any)=>{providerCalls.push(['confirm',i]);return {...review,state:i.decision==='cancel'?'cancelled':'accepted'};},reconcile:async(_d:any,i:any)=>{providerCalls.push(['check',i]);return {...review,state:'accepted'};}};
 const mailTriage:any={prepare:async()=>({id:randomUUID(),revision:1,digest:'b'.repeat(64),status:'awaiting_confirmation'}),confirm:async(_d:any,i:any)=>({status:i.decision==='cancel'?'cancelled':'completed',outcomes:[]}),reconcile:async()=>({status:'partial',outcomes:[{state:'observed'}]})};
 const companions=new Companions(store);
 const deps={companions,store,assistant,gateway,accounts,calendar,crm,mailDelivery,mailTriage,calendarWrites:{},mail:{},assignments:{}} as unknown as ModuleServices;
 let service=new ModuleActions(deps);
 t.after(async()=>{await service.close();await calendar.close();await accounts.close();companions.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const input=(operation:string,value:unknown,write=true)=>({operation,input:value,epoch:store.epoch,nativeId:conversation.nativeId,nativeKey:conversation.nativeKey,toolCallId:randomUUID(),permissionMode:conversation.permissionMode,write});
 const save=(kind:string,changes:unknown,id?:string,expectedRevision=0)=>input('records.save',{kind,id,expectedRevision,changes});
 const invoke=(raw:unknown)=>service.invoke(raw) as Promise<ModuleAction>;
 const decide=(a:ModuleAction,decision:'apply'|'cancel'|'check')=>service.decide(device,{requestId:randomUUID(),epoch:store.epoch,actionId:a.id,expectedRevision:a.revision,decision});
 return {companions,store,device,conversation,operation,gateway,accounts,calendar,crm,mailDelivery,mailTriage,providerCalls,input,save,invoke,decide,get service(){return service;},async restart(){await service.close();service=new ModuleActions(deps);}};
}
test('module catalog exposes all supported modules and schemas without drafts or credentials',async t=>{
 const f=fixture(t),catalog:any=await f.service.invoke(f.input('catalog',{},false));
 assert.ok(catalog.operations.some((o:any)=>o.module==='Inbox'));
 for(const name of ['task','contact','content','agent','assignment','profile','layout','project','routine'])assert.ok(catalog.recordKinds.includes(name));
 assert.equal(catalog.recordKinds.includes('draft'),false);
 for(const op of catalog.operations){const schema:any=await f.service.invoke(f.input('catalog',{operation:op.operation},false));assert.equal(schema.schema.type,'object');}
 for(const kind of catalog.recordKinds){const schema:any=await f.service.invoke(f.input('catalog',{kind},false));assert.equal(schema.schema.type,'object');}
 await assert.rejects(f.invoke(f.save('draft',{text:'Must not write'})));
});
test('source tools bind exact captured files and suppress late readings after their originating run is cancelled',async t=>{
 const f=fixture(t),file=f.store.upload(f.device,randomUUID(),f.store.epoch,'source.pdf',sourcePdf().toString('base64'));
 const foreign=f.store.upload(f.device,randomUUID(),f.store.epoch,'unselected.pdf',sourcePdf().toString('base64'));
 f.operation.context.attachments=[file];f.operation.context.project=null;
 const listed:any=await f.service.invoke(f.input('sources.list',{},false));assert.deepEqual(listed.files.map((s:any)=>s.file.id),[file.id]);
 await assert.rejects(f.service.invoke(f.input('sources.read',{fileId:foreign.id},false)),/authorized inputs/);
 const page:any=await f.service.invoke(f.input('sources.read',{fileId:file.id,page:2,view:'text'},false));assert.match(page.text,/SABLE 73/);
 const prefix=`source-reading:${f.store.epoch}:${f.operation.id}:`;assert.equal(f.store.internalList(prefix).length,1);
 const late=f.service.invoke(f.input('sources.read',{fileId:file.id,page:1,view:'image'},false));f.operation.cancelRequested=true;
 await assert.rejects(late,/no longer running/);assert.equal(f.store.internalList(prefix).length,1);
});
test('canonical Task, Contact, Content, Profile, Agent, Project and Home writes preserve unrelated fields and survive duplicate tool calls',async t=>{
 const f=fixture(t);
 for(const [kind,changes] of Object.entries({task:{title:'Workshop'},contact:{name:'Mina',otherOrganizations:['Harbor']},content:{title:'Outline'},agent:{name:'Editor',position:'Content editor'},project:{name:'Workshop',purpose:'Bring people together'},profile:{name:'Alex'}})){
  const input=f.save(kind,changes),[a,b]=await Promise.all([f.invoke(input),f.invoke(input)]);assert.equal(a.state,'applied',kind);assert.equal(a.id,b.id);assert.equal(f.store.listEntities(kind as any).length,1,kind);
  const entity:any=a.result;assert.equal(entity.revision,1);assert.equal(entity.deviceId,f.device);
  assert.equal((await f.invoke(input)).id,a.id);
 }
 const layout=f.store.readEntity('layout','layout')!;
 assert.equal((await f.invoke(f.save('layout',{theme:'dark'},layout.id,layout.revision))).state,'applied');
 assert.deepEqual(f.store.readEntity('layout','layout')!.value.widgets,layout.value.widgets);
 const contact=f.store.listEntities('contact')[0];assert.equal((await f.invoke(f.save('contact',{notes:'Private context'},contact.id,contact.revision))).state,'applied');assert.deepEqual(f.store.readEntity('contact',contact.id)?.value.otherOrganizations,['Harbor']);
});
test('read-only, planning, changed native identity, revoked access and inactive runs are blocked before writes',async t=>{
 const f=fixture(t);const input=f.save('task',{title:'Blocked'});
 for(const patch of [{permissionMode:'read-only'},{nativeId:randomUUID()},{epoch:randomUUID()},{nativeKey:'foreign'}])await assert.rejects(f.invoke({...input,...patch}));
 f.operation.context.workMode='plan';await assert.rejects(f.invoke(input),/planning/);f.operation.context.workMode='build';
 f.operation.cancelRequested=true;await assert.rejects(f.invoke(input),/no longer running/);f.operation.cancelRequested=false;
 f.operation.state='completed';await assert.rejects(f.invoke(input),/no longer running/);f.operation.state='running';
 f.conversation.pendingSettings={};await assert.rejects(f.invoke(input),/active/);assert.equal(f.store.listEntities('task').length,0);
});
test('guarded local changes require review and exact revisions prevent an overwrite after a newer edit',async t=>{
 const f=fixture(t);f.conversation.permissionMode='guarded';
 const a=await f.invoke(f.save('task',{title:'Review first'}));assert.equal(a.state,'pending');assert.equal(f.store.listEntities('task').length,0);
 assert.equal((await f.decide(a,'apply')).state,'applied');const task=f.store.listEntities('task')[0];
 const b=await f.invoke(f.save('task',{title:'Proposed'},task.id,task.revision));
 f.store.mutate(f.device,{requestId:randomUUID(),epoch:f.store.epoch,kind:'task',entityId:task.id,expectedRevision:task.revision,payload:{...task.value,title:'Newer direct edit'}});
 assert.equal((await f.decide(b,'apply')).state,'failed');assert.equal(f.store.readEntity('task',task.id)?.value.title,'Newer direct edit');
 const cancelled=await f.invoke(f.save('task',{title:'Never applied'}));assert.equal((await f.decide(cancelled,'cancel')).state,'cancelled');assert.equal(f.store.listEntities('task').length,1);
});
test('tool identities bind the input and local lost responses recover the original receipt exactly once',async t=>{
 const f=fixture(t),input=f.save('task',{title:'Once'}),mutate=f.store.mutate.bind(f.store);let lose=true;
 f.store.mutate=(device,cmd)=>{const result=mutate(device,cmd);if(lose){lose=false;throw new Error('Lost local response');}return result;};
 const uncertain=await f.invoke(input);assert.equal(uncertain.state,'unknown');assert.equal(f.store.listEntities('task')[0].revision,1);
 await assert.rejects(f.invoke({...input,input:{...input.input as any,changes:{title:'Different'}}}),/different input/);
 await f.restart();const checked=await f.decide(uncertain,'check');assert.equal(checked.state,'applied');assert.equal(f.store.listEntities('task')[0].revision,1);
});
test('review cancellation also cancels the provider preparation without sending, and uncertain sends only reconcile',async t=>{
 const f=fixture(t),compose=()=>f.input('inbox.compose',{accountId:randomUUID(),generation:randomUUID(),mode:'send',message:{from:'owner@example.test',to:['guest@example.test'],subject:'Workshop',bodyText:'You are invited.'}});
 const a=await f.invoke(compose());assert.equal(a.state,'pending');assert.equal(f.providerCalls.filter(c=>c[0]==='confirm').length,0);
 assert.equal((await f.decide(a,'cancel')).state,'cancelled');assert.equal(f.providerCalls.at(-1)[1].decision,'cancel');
 f.mailDelivery.confirm=async()=>{f.providerCalls.push(['send']);return {state:'uncertain'};};
 const b=await f.invoke(compose());assert.equal((await f.decide(b,'apply')).state,'unknown');await f.restart();
 const checked=await f.decide(f.service.list(f.conversation.id).find(a=>a.id===b.id)!,'check');assert.equal(checked.state,'applied');assert.equal(f.providerCalls.filter(c=>c[0]==='send').length,1);
 assert.deepEqual(Object.keys(f.providerCalls.at(-1)[1]).sort(),['epoch','operationId']);
});
test('mail triage handles awaiting-confirmation and partial outcomes without claiming full success',async t=>{
 const f=fixture(t),input=f.input('inbox.organize',{action:'archive',targets:[{provider:'gmail',accountId:randomUUID(),generation:randomUUID(),threadId:'thread'}]});
 const a=await f.invoke(input);assert.equal(a.state,'pending');assert.equal((await f.decide(a,'apply')).state,'applied');
 f.mailTriage.confirm=async()=>({status:'partial',outcomes:[{state:'applied'},{state:'failed'}]});const b=await f.invoke({...input,toolCallId:randomUUID()});assert.equal((await f.decide(b,'apply')).state,'partial');
});
test('preparation is deduplicated and late results never perform provider writes after access is revoked',async t=>{
 const f=fixture(t);let done!:()=>void,count=0;const wait=new Promise<void>(r=>done=r),prepare=f.mailDelivery.prepare;
 f.mailDelivery.prepare=async(...args:any[])=>{count++;await wait;return prepare(...args);};
 const input=f.input('inbox.compose',{accountId:randomUUID(),generation:randomUUID(),mode:'draft',message:{from:'owner@example.test',to:[],subject:'Kept',bodyText:'Writing'}});
 const first=f.invoke(input),second=f.invoke(input);await Promise.resolve();assert.equal(count,1);f.conversation.permissionMode='read-only';done();
 const [a,b]=await Promise.all([first,second]);assert.equal(a.revision,b.revision);assert.equal(a.state,'pending');await assert.rejects(f.decide(a,'apply'),/Access/);assert.equal(f.providerCalls.filter(c=>c[0]==='confirm').length,0);
});
test('calendar and CRM operations update the same existing services',async t=>{
 const f=fixture(t),task=await f.invoke(f.save('task',{title:'Prepare workshop'})),taskId=(task.result as any).id,eventId=randomUUID();
 const event=await f.invoke(f.input('calendar.local.save',{eventId,expectedRevision:0,scope:'event',value:{title:'Workshop',notes:'Agenda',location:'Studio',timezone:'UTC',allDay:false,start:{date:'2026-09-15',time:'10:00'},end:{date:'2026-09-15',time:'11:00'},state:'confirmed',projectId:null,taskId}}));assert.equal(event.state,'applied');assert.equal(f.calendar.readLocal(eventId).event.value.taskId,taskId);
 const contact=await f.invoke(f.save('contact',{name:'Mina'})),contactId=(contact.result as any).id;
 const activity=await f.invoke(f.input('contacts.activity',{id:'activity:'+randomUUID(),contactId,expectedRevision:0,value:{kind:'note',at:'2026-09-01T10:00:00Z',text:'Bring the agenda',archived:false}}));assert.equal(activity.state,'applied');assert.equal(f.crm.read(f.device,{epoch:f.store.epoch,contactId}).activities.length,1);
});

test('Profile quest tools use canonical task receipts and guarded review without minting XP',async t=>{
 const f=fixture(t);f.conversation.permissionMode='guarded';
 const quest={id:randomUUID(),title:'Finish the field guide',description:'A clear next step.',due:'',projectId:null,steps:[{id:randomUUID(),taskId:null,title:'Write the guide'}]};
 const input=f.input('profile.quests.save',{quest,expectedRevision:0});
 const pending=await f.invoke(input);assert.equal(pending.state,'pending');assert.equal(f.store.snapshot(f.device).tasks.length,0);
 const result=await f.decide(pending,'apply');assert.equal(result.state,'applied');assert.equal(f.store.snapshot(f.device).tasks.length,1);assert.equal(f.store.profileProgress().earnedXp,0);
 await f.invoke(input);assert.equal(f.store.snapshot(f.device).tasks.length,1);
 const progress:any=await f.service.invoke(f.input('profile.progress',{},false));assert.equal(progress.personalQuests[0].title,quest.title);
 const schema:any=await f.service.invoke(f.input('catalog',{operation:'profile.quests.save'},false));assert(schema.schema);assert(!JSON.stringify(schema.schema).includes('requestId'));
});

function goalFixture(t:TestContext){
 const f=fixture(t);f.conversation.permissionMode='read-only';f.operation.context.workMode='goal';
 let goal:any={id:randomUUID(),objective:'Verify the requested arithmetic',status:'active'},lose:'before'|'after'|undefined;
 const calls:any[]=[];
 f.gateway.request=async(method:string,params:any)=>{
  if(method==='sessions.describe')return {session:{sessionId:f.conversation.nativeId,goal:{...goal}}};
  assert.equal(method,'sessions.goal.update');calls.push(params);
  if(lose==='before')throw Error('Connection lost before confirmation');
  assert.equal(params.sessionKey,f.operation.nativeKey);assert.equal(params.sessionId,f.operation.nativeId);assert.equal(params.goalId,goal.id);
  goal={...goal,status:params.action==='block'?'blocked':params.action};
  if(lose==='after')throw Error('Response lost after native update');
  return {goal};
 };
 return {...f,calls,get goal(){return goal;},set goal(value){goal=value;},setLoss(value:'before'|'after'|undefined){lose=value;}};
}
test('a read-only Goal request can report its exact saved goal once without gaining record-write access',async t=>{
 const f=goalFixture(t),read:any=await f.service.invoke(f.input('goal.read',{},false));assert.equal(read.goal.id,f.goal.id);
 const input=f.input('goal.update',{goalId:f.goal.id,status:'complete'}),[a,b]=await Promise.all([f.invoke(input),f.invoke(input)]);
 assert.equal(a.state,'applied');assert.equal((a.result as any).goal.status,'complete');assert.equal(a.id,b.id);assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].operationId,a.id);assert.equal(f.calls[0].issuedAtMs,Date.parse(a.createdAt));
 await assert.rejects(f.invoke(f.save('task',{title:'Still denied'})),/read only/);assert.equal(f.store.listEntities('task').length,0);
});
test('goal tools cannot target another session, replace objectives, resume, clear, or run from a normal chat or assignment',async t=>{
 const f=goalFixture(t);
 for(const input of [{goalId:f.goal.id,status:'paused'},{goalId:f.goal.id,status:'complete',nativeId:randomUUID()},{goalId:f.goal.id,status:'complete',objective:'Replacement'}])await assert.rejects(f.invoke(f.input('goal.update',input)));
 f.operation.context.workMode='chat';await assert.rejects(f.invoke(f.input('goal.update',{goalId:f.goal.id,status:'complete'})),/Goal request/);
 f.operation.context.workMode='goal';await assert.rejects(f.invoke({...f.input('goal.update',{goalId:f.goal.id,status:'complete'}),nativeKey:'agent:edition3-assignment:e3-assignment-test'}),/originating Assistant/);
 assert.equal(f.calls.length,0);
});
test('paused/replaced goals and stopped requests reject goal reports without a native mutation',async t=>{
 const f=goalFixture(t),original=f.goal.id;
 f.goal={...f.goal,status:'paused'};assert.equal((await f.invoke(f.input('goal.update',{goalId:original,status:'complete'}))).state,'failed');
 f.goal={...f.goal,id:randomUUID(),status:'active'};assert.equal((await f.invoke(f.input('goal.update',{goalId:original,status:'complete'}))).state,'failed');
 f.operation.cancelRequested=true;await assert.rejects(f.invoke(f.input('goal.update',{goalId:f.goal.id,status:'complete'})),/no longer running/);
 assert.equal(f.calls.length,0);
});
test('a lost goal completion response is reconciled by observation after restart and never sends a second update',async t=>{
 const f=goalFixture(t);f.setLoss('after');const a=await f.invoke(f.input('goal.update',{goalId:f.goal.id,status:'complete'}));assert.equal(a.state,'unknown');assert.equal(f.goal.status,'complete');
 await f.restart();f.operation.state='completed';const checked=await f.decide(a,'check');assert.equal(checked.state,'applied');assert.equal((checked.result as any).goal.status,'complete');assert.equal(f.calls.length,1);
});
test('an unconfirmed goal change stays unknown when the goal is still active; checking never replays it',async t=>{
 const f=goalFixture(t);f.setLoss('before');const a=await f.invoke(f.input('goal.update',{goalId:f.goal.id,status:'blocked'}));assert.equal(a.state,'unknown');
 await f.restart();f.setLoss(undefined);assert.equal((await f.decide(a,'check')).state,'unknown');assert.equal(f.goal.status,'active');assert.equal(f.calls.length,1);
});


test('computer actions require review, expose original results in the same chat and stop before claim when cancelled', async t => {
 const f=fixture(t), keys=generateKeyPairSync('ed25519'), deviceId=randomUUID(), command=()=>({epoch:f.store.epoch,requestId:randomUUID()});
 const challenge=f.companions.challenge(f.device,command());
 f.companions.link(f.device,{...command(),challengeId:challenge.id,deviceId,name:'Fixture desktop',platform:'darwin',publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString(),signature:sign(null,Buffer.from(companionLinkData(challenge,deviceId)),keys.privateKey).toString('base64url')});
 let clock=Date.now(); const packet=(action:CompanionPacket['action'],payload:Record<string,unknown>)=>{const p={protocol:1 as const,epoch:f.store.epoch,deviceId,requestId:randomUUID(),issuedAt:++clock,action,payload};return {...p,signature:sign(null,Buffer.from(companionSignedData(p)),keys.privateKey).toString('base64url')};};
 f.companions.packet(packet('poll',{enabledUntil:Date.now()+60000,apps:['Fixture']}));
 const proposed=await f.invoke(f.input('computer.call',{deviceId,tool:'get_window_state',arguments:{session_id:'fixture'}}));
 assert.equal(proposed.state,'pending');assert.throws(()=>f.companions.result(proposed.id,f.operation.id));
 const queued=await f.decide(proposed,'apply');assert.equal(queued.state,'unknown');assert.equal(f.companions.result(proposed.id,f.operation.id).state,'queued');
 f.operation.cancelRequested=true;assert.throws(()=>f.companions.packet(packet('claim',{id:proposed.id})),/cancelled/);
 f.companions.packet(packet('poll',{enabledUntil:Date.now()+60000,apps:['Fixture']}));assert.equal(f.companions.result(proposed.id,f.operation.id).state,'cancelled');
 f.operation.cancelRequested=false;
 const next=await f.invoke(f.input('computer.call',{deviceId,tool:'get_window_state',arguments:{session_id:'fixture'}}));await f.decide(next,'apply');
 f.companions.packet(packet('claim',{id:next.id}));f.companions.packet(packet('result',{id:next.id,state:'completed',result:{content:[{type:'text',text:'Verified window'}]}}));
 const result:any=await f.service.invoke(f.input('computer.result',{id:next.id},false));assert.equal(result.state,'completed');
 const original=f.operation.id;f.operation.id=randomUUID();assert.equal((await f.service.invoke(f.input('computer.result',{id:next.id},false)) as any).state,'completed');f.operation.id=original;
 f.conversation.id=randomUUID();f.operation.conversationId=f.conversation.id;await assert.rejects(f.service.invoke(f.input('computer.result',{id:next.id},false)),/original conversation/);
});
