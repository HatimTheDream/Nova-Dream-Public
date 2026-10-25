import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../apps/service/store';
import {IdeaPursuits,captureIdeaBinding,ideaOperationIndex} from '../apps/service/idea-pursuits';
import {HomeLibrary} from '../apps/service/home-library';
import type {IdeaCommand,IdeaEntry,IdeaPursuit} from '../packages/domain/idea-pursuits';
import type {AssistantOperation,Conversation} from '../packages/domain/assistant';
function fixture(run:(f:ReturnType<typeof setup>)=>void){
 const f=setup();try{run(f);}finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
}
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'nova-ideas-')),store=new Store(dir),device=store.session().deviceId,ideas=new IdeaPursuits(store);
 const capture=new HomeLibrary(store).capture(device,{requestId:randomUUID(),epoch:store.epoch,references:[]});
 const create=():Extract<IdeaCommand,{type:'create'}>=>({requestId:randomUUID(),epoch:store.epoch,type:'create',id:randomUUID(),entryId:randomUUID(),
  handoff:{title:'Draft Notes',text:'Complete original brief\n\nIncluding every line.',space:'chat',projectId:null,sourceCaptureId:capture.id,sourceRefs:[],ideaId:'draft-notes',outputs:['draft']}});
 return {dir,store,device,ideas,create,capture};
}
test('each pursuit is distinct; exact original create/readback has no duplicate or automatic operation',()=>fixture(f=>{
 const a=f.create(),b=f.create(),saved=f.ideas.command(f.device,a);
 assert.equal(saved.state,'saved');assert.deepEqual(f.ideas.command(f.device,a),saved);
 assert.deepEqual(f.ideas.receipt(f.device,a),saved);f.ideas.command(f.device,b);
 assert.equal(f.ideas.list().rows.length,2);assert.equal(f.ideas.entries(a.id).rows[0].handoff.text,a.handoff.text);
 assert.deepEqual(f.store.internalList('assistant:operation:'),[]);
 const before=f.store.internalList('home:ideas:');f.ideas.list();f.ideas.detail(a.id);f.ideas.entries(a.id);f.ideas.receipt(f.device,a);
 assert.deepEqual(f.store.internalList('home:ideas:'),before);
}));
test('questions preserve original brief and earlier entries; conflicts remain durably refused',()=>fixture(f=>{
 const c=f.create();f.ideas.command(f.device,c);
 const question:IdeaCommand={requestId:randomUUID(),epoch:f.store.epoch,type:'question',id:c.id,entryId:randomUUID(),expectedRevision:1,text:'  My exact follow-up\nSecond line  '};
 const saved=f.ideas.command(f.device,question);assert.equal(saved.state,'saved');
 assert.equal(f.ideas.entries(c.id).rows.length,2);assert.equal(f.ideas.entry(c.entryId).entry.handoff.text,c.handoff.text);
 assert.equal(f.ideas.entry(question.entryId).entry.question,question.text);
 assert.ok(f.ideas.entry(question.entryId).entry.handoff.text.endsWith(question.text));
 const stale={...question,requestId:randomUUID(),entryId:randomUUID()};
 const rejected=f.ideas.command(f.device,stale);assert.equal(rejected.state,'rejected');
 assert.deepEqual(f.ideas.receipt(f.device,stale),rejected);assert.deepEqual(f.ideas.command(f.device,stale),rejected);
 assert.equal(f.ideas.entries(c.id).rows.length,2);
}));
test('captured source identity and binding are checked without replacing a missing historical source',()=>fixture(f=>{
 const c=f.create();const bad={...c,handoff:{...c.handoff,sourceCaptureId:randomUUID()}};
 assert.equal(f.ideas.command(f.device,bad).state,'rejected');assert.equal(f.ideas.list().rows.length,0);
 f.ideas.command(f.device,{...c,requestId:randomUUID()});
 const binding={pursuitId:c.id,entryId:c.entryId};assert.deepEqual(captureIdeaBinding(f.store,binding),binding);
 assert.throws(()=>captureIdeaBinding(f.store,{...binding,entryId:randomUUID()}),/original Idea/);
 assert.throws(()=>f.ideas.receipt(randomUUID(),c));assert.throws(()=>f.ideas.receipt(f.device,{...c,epoch:randomUUID()}));
}));
test('older pursuits and entries remain reachable across bounded pages; wrong cursors are rejected',()=>fixture(f=>{
 for(let i=0;i<54;i++)f.ideas.command(f.device,f.create());
 const first=f.ideas.list(),second=f.ideas.list(first.next!);
 assert.equal(first.rows.length,50);assert.equal(second.rows.length,4);assert.equal(second.next,null);
 assert.equal(new Set([...first.rows,...second.rows].map(row=>row.id)).size,54);
 assert.throws(()=>f.ideas.list('assistant:operation:'),/continuation/);
 const c=f.create();f.ideas.command(f.device,c);
 for(let i=0;i<52;i++)f.ideas.command(f.device,{requestId:randomUUID(),epoch:f.store.epoch,type:'question',id:c.id,entryId:randomUUID(),expectedRevision:i+1,text:'Question '+i});
 const entries=f.ideas.entries(c.id);assert.equal(entries.rows.length,50);assert.equal(f.ideas.entries(c.id,entries.next!).rows.length,3);
 assert.throws(()=>f.ideas.entries(c.id,first.next!),/continuation/);
}));
test('original operation index and full results remain exact and opening never marks Reviewed',()=>fixture(f=>{
 const c=f.create();f.ideas.command(f.device,c);
 const operation={id:randomUUID(),epoch:f.store.epoch,conversationId:randomUUID(),createdAt:'2026-10-21T02:00:00Z',
  context:{idea:{pursuitId:c.id,entryId:c.entryId}},input:'Exact edited submitted brief',text:'Full original result\n'.repeat(2000),
  state:'completed',nativeId:randomUUID(),nativeRunId:randomUUID()} as AssistantOperation;
 f.store.internalWrite('assistant:conversation:'+operation.conversationId,{id:operation.conversationId,deleted:false} as Conversation);
 f.store.internalBatchJoined([{id:'assistant:operation:'+operation.id,value:operation},...ideaOperationIndex(f.store,operation)]);
 assert.deepEqual(ideaOperationIndex(f.store,operation),[]);
 assert.equal(f.ideas.runs(c.id).rows[0].operationId,operation.id);
 const detail=f.ideas.run(c.id,operation.id);assert.equal(detail.operation!.text,operation.text);assert.equal(detail.operation!.input,operation.input);
 assert.deepEqual(detail.capture,f.capture);assert.equal(f.ideas.detail(c.id).pursuit.reviewed,false);
 const other=f.create();f.ideas.command(f.device,other);assert.throws(()=>f.ideas.run(other.id,operation.id),/unavailable/);
 f.store.internalWrite('assistant:removed:'+operation.conversationId,{id:operation.conversationId});
 assert.equal(f.ideas.run(c.id,operation.id).operation,null);assert.equal(f.ideas.runs(c.id).rows.length,1);
}));
test('personal review is explicit and distinct from work outcome; new question does not overwrite it silently',()=>fixture(f=>{
 const c=f.create();f.ideas.command(f.device,c);
 f.ideas.command(f.device,{requestId:randomUUID(),epoch:f.store.epoch,type:'review',id:c.id,expectedRevision:1,reviewed:true});
 assert.equal(f.ideas.detail(c.id).pursuit.reviewed,true);
 f.ideas.command(f.device,{requestId:randomUUID(),epoch:f.store.epoch,type:'question',id:c.id,entryId:randomUUID(),expectedRevision:2,text:'Next question'});
 assert.equal(f.ideas.detail(c.id).pursuit.reviewed,false);assert.equal(f.ideas.entries(c.id).rows.length,2);
 assert.deepEqual(f.store.internalList('assistant:operation:'),[]);
}));
test('duplicate entry identity and excessive complete writing never partially update a pursuit',()=>fixture(f=>{
 const c=f.create();c.handoff.text='x'.repeat(99990);f.ideas.command(f.device,c);
 const before=f.ideas.detail(c.id).pursuit;
 const input={requestId:randomUUID(),epoch:f.store.epoch,type:'question' as const,id:c.id,entryId:randomUUID(),expectedRevision:1,text:'Full question is not truncated'};
 assert.equal(f.ideas.command(f.device,input).state,'rejected');assert.deepEqual(f.ideas.detail(c.id).pursuit,before);
 const c2=f.create();c2.entryId=c.entryId;assert.equal(f.ideas.command(f.device,c2).state,'rejected');
 assert.equal(f.ideas.list().rows.length,1);assert.equal(f.ideas.entries(c.id).rows.length,1);
}));

test('Ideas HTTP reads and changes require the authenticated same-origin owner; original receipt is a read',async()=>{
 const {startServer}=await import('../apps/service/http');
 const dir=mkdtempSync(join(tmpdir(),'nova-ideas-http-')),server=await startServer({port:0,directory:dir,version:'test'});
 try{
  const base=server.origin,headers={Origin:base,'Content-Type':'application/json','X-Edition3-Client':'1'};
  assert.equal((await fetch(base+'/api/home/ideas')).status,401);
  assert.equal((await fetch(base+'/api/home/ideas/receipt',{method:'POST',headers,body:'{}'})).status,401);
  const session=await fetch(base+'/api/session',{method:'POST',headers,body:'{}'}),authenticated={...headers,Cookie:session.headers.get('set-cookie')!.split(';')[0]};
  const command={requestId:randomUUID(),epoch:server.store.epoch,type:'review',id:randomUUID(),expectedRevision:1,reviewed:true};
  assert.equal((await fetch(base+'/api/home/ideas',{method:'POST',headers:{...authenticated,Origin:'https://elsewhere.test'},body:JSON.stringify(command)})).status,403);
  const before=server.store.internalList('home:ideas:');
  const observed=await fetch(base+'/api/home/ideas/receipt',{method:'POST',headers:authenticated,body:JSON.stringify(command)});
  assert.equal(observed.status,200);assert.equal((await observed.json() as any).state,'unknown');assert.deepEqual(server.store.internalList('home:ideas:'),before);
  const refused=await fetch(base+'/api/home/ideas',{method:'POST',headers:authenticated,body:JSON.stringify(command)});assert.equal(refused.status,200);
  const saved=await refused.json();assert.equal((saved as any).state,'rejected');
  assert.deepEqual(await (await fetch(base+'/api/home/ideas/receipt',{method:'POST',headers:authenticated,body:JSON.stringify(command)})).json(),saved);
 }finally{await server.close();rmSync(dir,{recursive:true,force:true});}
});
