import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {SoftwareUpdates,type UpdateWorkspace} from '../apps/service/software-updates.js';
import type {UpdateHostView} from '../apps/service/update-host-client.js';
import {startServer} from '../apps/service/http.js';
import type {AssistantTransport} from '../apps/service/gateway.js';

const current='a'.repeat(64),next='b'.repeat(64);
const agent={id:'openclaw',name:'OpenClaw',state:'ready' as const,version:'2026.9.2'};
function setup(){let hold:string|null=null,disconnected=false,view:UpdateHostView={availability:'available',checkedAt:100,release:{candidateId:next,novaVersion:'1.13.0',agentVersion:'2026.9.2',notes:['Update'],downloadBytes:100},installation:{supported:true},holdFor:null};const epoch=randomUUID();const seen:{action:string;value:any}[]=[];
 let suspended:string|null=null;const native={acquire:async(id:string)=>{suspended=id;return [] as {code:string;message:string}[];},release:async(_id:string)=>{suspended=null;return [] as {code:string;message:string}[];},snapshot:(id:string|null)=>({nativeSuspended:!!id&&id===suspended}),pendingJobIds:()=>suspended?[suspended]:[]};
 const workspace:UpdateWorkspace={epoch:()=>epoch,installed:()=>({novaVersion:'1.12.11',candidateId:current,agent}),hold:id=>{hold=id;},heldFor:()=>hold,blockers:()=>[],native};
 const host={async call<T>(action:any,value:any):Promise<T>{seen.push({action,value});if(disconnected)throw Error('disconnected');return structuredClone(view) as T;}};
 return {workspace,host,seen,setView:(value:UpdateHostView)=>{view=value;},disconnect:()=>{disconnected=true;}};
}
test('update maintenance handshake proves native idle before acknowledging its held identity',async()=>{
 const f=setup(),id=randomUUID();let release!:()=>void,entered=false;
 const acquire=f.workspace.native!.acquire;f.workspace.native!.acquire=async(id)=>{entered=true;await new Promise<void>(resolve=>{release=resolve;});return acquire(id);};
 f.setView({availability:'available',installation:{supported:true},holdFor:id,job:{id,candidateId:next,state:'waiting',requestedAt:0,updatedAt:0}});
 const updates=new SoftwareUpdates(f.workspace,f.host),reading=updates.refresh();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(entered,true);assert.equal(f.workspace.heldFor(),id);assert.equal(f.seen.length,1);assert.equal(f.seen[0].value.heldFor,null);
 assert.equal(f.seen[0].value.nativeSuspended,false);release();await reading;assert.equal(f.seen[1].value.heldFor,id);assert.equal(f.seen[1].value.nativeSuspended,true);updates.close();
});
test('busy native proof releases the temporary hold and reports uncertainty without cancelling work',async()=>{
 const f=setup(),id=randomUUID();f.workspace.native!.acquire=async()=>[{code:'native_unknown',message:'Native work is unknown.'}];
 f.setView({availability:'available',installation:{supported:true},holdFor:id,job:{id,candidateId:next,state:'waiting',requestedAt:0,updatedAt:0}});
 const updates=new SoftwareUpdates(f.workspace,f.host);await updates.refresh();assert.equal(f.workspace.heldFor(),null);assert.equal(f.seen[1].value.heldFor,null);assert.equal(f.seen[1].value.blockers[0].code,'native_unknown');updates.close();
});

test('local work releases the temporary hold without awaiting a native round trip',async()=>{
 const f=setup(),id=randomUUID();let probed=false;
 f.workspace.blockers=()=>[{code:'provider',message:'Waiting for mail to finish.'}];
 f.workspace.native!.acquire=async()=>{probed=true;throw Error('Must not pause existing work for this read.');};
 f.setView({availability:'available',installation:{supported:true},holdFor:id,job:{id,candidateId:next,state:'waiting',requestedAt:0,updatedAt:0}});
 const updates=new SoftwareUpdates(f.workspace,f.host);await updates.refresh();assert.equal(probed,false);assert.equal(f.workspace.heldFor(),null);assert.equal(f.seen[1].value.blockers[0].code,'provider');updates.close();
});

test('work admitted during native proof is rechecked before the hold is acknowledged',async()=>{
 const f=setup(),id=randomUUID();let entered=false;
 f.workspace.blockers=()=>entered?[{code:'provider',message:'Waiting for current work.'}]:[];
 f.workspace.native!.acquire=async()=>{entered=true;return [];};
 f.setView({availability:'available',installation:{supported:true},holdFor:id,job:{id,candidateId:next,state:'waiting',requestedAt:0,updatedAt:0}});
 const updates=new SoftwareUpdates(f.workspace,f.host);await updates.refresh();assert.equal(f.workspace.heldFor(),null);assert.equal(f.seen[1].value.blockers[0].code,'provider');updates.close();
});
test('lost supervisor connection never releases an admitted hold or says up to date',async()=>{
 const f=setup(),id=randomUUID();f.setView({availability:'current',installation:{supported:true},holdFor:id,job:{id,candidateId:next,state:'checking',requestedAt:0,updatedAt:0}});
 const updates=new SoftwareUpdates(f.workspace,f.host);await updates.refresh();f.disconnect();await updates.refresh();assert.equal(f.workspace.heldFor(),id);assert.equal(updates.status().availability,'error');assert.equal(updates.status().installation.supported,false);updates.close();
});

test('a confirmed cancelled job keeps local admission held until its native resume is confirmed',async()=>{
 const f=setup(),id=randomUUID();await f.workspace.native!.acquire(id);f.workspace.hold(id);
 const resume=f.workspace.native!.release;f.workspace.native!.release=async()=>[{code:'native_unknown',message:'Resume not yet confirmed.'}];
 const updates=new SoftwareUpdates(f.workspace,f.host);await updates.refresh();assert.equal(f.workspace.heldFor(),id);
 f.workspace.native!.release=resume;await updates.refresh();assert.equal(f.workspace.heldFor(),null);assert.equal(f.workspace.native!.pendingJobIds().length,0);updates.close();
});

test('restart with an orphaned own native lease reconciles it before clearing local admission',async()=>{
 const f=setup(),id=randomUUID();await f.workspace.native!.acquire(id);
 const updates=new SoftwareUpdates(f.workspace,f.host);await updates.refresh();assert.equal(f.workspace.native!.pendingJobIds().length,0);assert.equal(f.workspace.heldFor(),null);updates.close();
});

test('a root completion remains checking and refuses another install until local model readiness',async()=>{
 const f=setup(),id=randomUUID();await f.workspace.native!.acquire(id);f.workspace.hold(id);
 f.setView({availability:'current',installation:{supported:true},holdFor:null,job:{id,candidateId:next,state:'completed',message:'Update installed.',requestedAt:0,updatedAt:0}});
 const original=f.workspace.native!.release;let entered!:()=>void,finish!:()=>void;
 const began=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>finish=resolve);
 f.workspace.native!.release=async()=>{entered();await wait;return [{code:'native_readiness',message:'Checking Assistant access.'}];};
 const updates=new SoftwareUpdates(f.workspace,f.host),reading=updates.refresh();await began;
 assert.equal(updates.status().job?.state,'checking');assert.equal(updates.status().installation.supported,false);
 finish();await reading;assert.equal(f.workspace.heldFor(),id);assert.equal(updates.status().job?.state,'checking');
 await assert.rejects(()=>updates.install({epoch:f.workspace.epoch(),candidateId:next,idempotencyKey:randomUUID(),when:'idle'}),/finish reconnecting/);
 assert.equal(f.seen.some(call=>call.action==='install'),false);
 f.workspace.native!.release=original;await updates.refresh();assert.equal(f.workspace.heldFor(),null);assert.equal(updates.status().job?.state,'completed');updates.close();
});

test('held installation renews its native lease on every heartbeat',async()=>{
 const f=setup(),id=randomUUID(),original=f.workspace.native!.acquire;let count=0;f.workspace.native!.acquire=async(id)=>{count++;return original(id);};
 f.setView({availability:'available',installation:{supported:true},holdFor:id,job:{id,candidateId:next,state:'checking',requestedAt:0,updatedAt:0}});
 const updates=new SoftwareUpdates(f.workspace,f.host);await updates.refresh();await updates.refresh();assert.equal(count,2);assert.equal(f.seen.at(-1)?.value.nativeSuspended,true);updates.close();
});
test('install replay preserves the acknowledged old receipt across a newer authoritative status',async()=>{
 const f=setup(),oldId=randomUUID(),newId=randomUUID();const newView:UpdateHostView={availability:'current',installation:{supported:true},holdFor:null,job:{id:newId,candidateId:'c'.repeat(64),state:'waiting',requestedAt:100,updatedAt:100}};
 f.host.call=async<T>(action:string)=>({ ...newView,...(action==='install'?{job:{id:oldId,candidateId:next,state:'completed',requestedAt:0,updatedAt:50}}:{}) }) as T;
 const updates=new SoftwareUpdates(f.workspace,f.host);const result=await updates.install({epoch:f.workspace.epoch(),candidateId:next,idempotencyKey:randomUUID(),when:'now'});
 assert.equal(result.job?.id,oldId);assert.equal(result.job?.state,'completed');assert.equal(updates.status().job?.id,newId);updates.close();
});
function call(origin:string,path:string,value?:unknown,headers:Record<string,string>={}){return new Promise<{status:number;data:any;cookie?:string}>((resolve,reject)=>{const req=httpRequest(origin+'/api/'+path,{method:value===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Edition3-Client':'1',...headers}},res=>{const chunks:Buffer[]=[];res.on('data',part=>chunks.push(part));res.on('end',()=>resolve({status:res.statusCode!,data:JSON.parse(Buffer.concat(chunks).toString()),cookie:res.headers['set-cookie']?.[0]}));});req.on('error',reject);req.end(value===undefined?undefined:JSON.stringify(value));});}
test('software update endpoints preserve authentication, origin, candidate and epoch guards',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'nova-update-api-')),seen:string[]=[];
 const gateway:AssistantTransport={status:()=>({state:'ready',message:'Fixture',generation:'fixture',methods:[],grantedScopes:[],modelAuthReady:true}),serviceInfo:()=>agent,request:async<T>()=>({})as T,subscribe:()=>()=>{},models:async()=>[],attachmentPolicy:()=>({})};
 const host={async call<T>(action:string):Promise<T>{seen.push(action);return {availability:'current',installation:{supported:true},holdFor:null} as T;}};
 const service=await startServer({directory,port:0,gateway,candidateId:current,version:'1.12.11',updateHostClient:host});
 t.after(async()=>{await service.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal((await call(service.origin,'software-update')).status,401);
 const session=await call(service.origin,'session',{}),headers={Cookie:session.cookie!.split(';')[0],'X-Edition3-Candidate':current};
 const status=await call(service.origin,'software-update',undefined,headers);assert.equal(status.status,200);assert.equal(status.data.installed.agent.version,'2026.9.2');assert.equal(status.data.holdFor,undefined);
 assert.equal((await call(service.origin,'software-update',undefined,{...headers,Origin:'https://hostile.invalid'})).status,403);
 assert.equal((await call(service.origin,'software-update/install',{epoch:service.store.epoch,candidateId:next,idempotencyKey:randomUUID(),when:'now'},{...headers,'X-Edition3-Candidate':next})).status,409);
 assert.equal((await call(service.origin,'software-update/install',{epoch:service.store.epoch,candidateId:next,idempotencyKey:randomUUID(),when:'now'},{...headers,'X-Edition3-Desktop':next})).status,409);
 assert.equal((await call(service.origin,'software-update/check',{epoch:randomUUID()},headers)).status,409);assert.equal(seen.includes('check'),false);
 assert.equal((await call(service.origin,'software-update/check',{epoch:service.store.epoch},headers)).status,200);assert.equal(seen.includes('check'),true);
 service.store.setUpdateMaintenanceHeld(true);
 assert.equal((await call(service.origin,'commands',{},headers)).data.code,'update_maintenance');
 assert.equal((await call(service.origin,'software-update',undefined,headers)).status,200);
});
