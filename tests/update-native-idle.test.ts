import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EventFrame, HelloOk } from '@openclaw/gateway-protocol/frame-guards';
import type { GatewayClientOptions } from '@openclaw/gateway-client';
import type { AssistantConnection } from '../packages/domain/assistant.js';
import { Store } from '../apps/service/store.js';
import { NativeUpdateLease } from '../apps/service/update-native-idle.js';
import { qualifyNativeUpdateStartup } from '../apps/service/update-native-startup.js';
import { Gateway } from '../apps/service/gateway.js';
import { ManagedRuntime } from '../apps/service/runtime.js';

function setup(t:TestContext){
  const root=mkdtempSync(join(tmpdir(),'nova-native-lease-')),store=new Store(join(root,'app'));let time=Date.now();
  let owned={epoch:store.epoch,pid:112,url:'ws://127.0.0.1:55321',generation:randomUUID(),startedAt:time-5000,version:'2026.9.2' as const};
  let state:AssistantConnection={state:'ready',url:owned.url,generation:owned.generation,message:'',grantedScopes:['operator.read','operator.admin'],methods:['system.info','gateway.suspend.prepare','gateway.suspend.status','gateway.suspend.resume'],modelAuthReady:false};
  let current:{requestId:string;suspensionId:string;expiresAtMs:number}|undefined,busy=false,drop=false,prepares=0,resumes=0,systems=0;
  const requests:string[]=[];const listeners=new Set<(event:EventFrame)=>void>();
  const factory=()=>({start(){},async stop(){},status:()=>state,serviceInfo:()=>({id:'openclaw',name:'OpenClaw',state:'ready' as const,version:'2026.9.2'}),subscribe(listener:(event:EventFrame)=>void){listeners.add(listener);return()=>listeners.delete(listener);},async request<T>(method:string,raw:unknown):Promise<T>{
    const input=raw as any;if(current&&current.expiresAtMs<=time)current=undefined;
    if(method==='system.info'){systems++;if(current)throw Error('suspended');return {pid:owned.pid,processInstanceId:'process-'+owned.pid} as T;}
    if(method==='gateway.suspend.prepare'){
      assert.equal(input.terminalPolicy,'preserve');assert.equal(input.drain,false);requests.push(input.requestId);prepares++;
      if(busy)return {status:'busy',reason:'active-work',activeCount:1,retryAfterMs:20000,blockers:[{kind:'terminal-session',count:1,message:'private task title'}]} as T;
      if(current&&current.requestId!==input.requestId)throw Error('other lease');
      current??={requestId:input.requestId,suspensionId:randomUUID(),expiresAtMs:time+120000};current.expiresAtMs=time+120000;
      if(drop){drop=false;throw Error('lost reply');}return {status:'ready',suspensionId:current.suspensionId,expiresAtMs:current.expiresAtMs,activeCount:0,blockers:[]} as T;
    }
    if(method==='gateway.suspend.resume'){resumes++;if(current&&current.suspensionId!==input.suspensionId)throw Error('wrong lease');const resumed=!!current;current=undefined;return {ok:true,status:'running',resumed} as T;}
    throw Error(method);
  }});
  const runtime={updateIdentity:()=>owned,updateStartupBlockers:()=>[] as {code:string;message:string}[]};const lease=new NativeUpdateLease(store,runtime,factory,()=>time);store.setUpdateMaintenanceHeld(true);
  t.after(async()=>{await lease.close();store.close();rmSync(root,{recursive:true,force:true});});
  return {root,store,lease,runtime,factory,job:randomUUID(),requests,now:()=>time,advance:(ms:number)=>time+=ms,busy:()=>busy=true,drop:()=>drop=true,counts:()=>({prepares,resumes,systems}),disconnect:()=>state={...state,state:'disconnected'},event:()=>{for(const listener of listeners)listener({type:'event',event:'gateway.suspension',payload:{phase:'accepting'}});},restart:()=>{owned={...owned,pid:113,startedAt:time};current=undefined;},changeGeneration:()=>{owned={...owned,generation:randomUUID()};state={...state,generation:owned.generation};}};
}
test('native global lease renews and never uses terminal destruction or leaks task details',async t=>{
  const f=setup(t);assert.deepEqual(await f.lease.acquire(f.job),[]);assert.equal(f.lease.snapshot(f.job).nativeSuspended,true);
  f.advance(50000);assert.deepEqual(await f.lease.acquire(f.job),[]);assert.equal(new Set(f.requests).size,1);assert.equal(f.counts().systems,1);
  assert.deepEqual(f.lease.pendingJobIds(),[f.job]);assert.deepEqual(await f.lease.release(f.job),[]);assert.deepEqual(f.lease.pendingJobIds(),[]);assert.equal(f.lease.snapshot(f.job).nativeSuspended,false);
  f.busy();const result=await f.lease.acquire(randomUUID());assert.equal(result[0].code,'native_busy');assert.equal(JSON.stringify(result).includes('private task title'),false);
});
test('lost prepare reply and app helper restart recover and release only the original native lease',async t=>{
  const f=setup(t);f.drop();assert.equal((await f.lease.acquire(f.job))[0].code,'native_unknown');assert.deepEqual(f.lease.pendingJobIds(),[f.job]);
  const resumed=new NativeUpdateLease(f.store,f.runtime,f.factory,f.now);t.after(()=>resumed.close());assert.equal(resumed.snapshot(f.job).nativeSuspended,false);
  assert.deepEqual(await resumed.release(f.job),[]);assert.equal(new Set(f.requests).size,1);assert.equal(f.counts().resumes,1);assert.equal(f.counts().systems,1);
});
test('native process replacement retires its old receipt without resuming the successor',async t=>{
  const f=setup(t);await f.lease.acquire(f.job);f.restart();assert.equal(f.lease.snapshot(f.job).nativeSuspended,false);
  assert.deepEqual(await f.lease.release(f.job),[]);assert.equal(f.counts().resumes,0);assert.deepEqual(f.lease.pendingJobIds(),[]);
  assert.deepEqual(await f.lease.acquire(f.job),[]);assert.equal(new Set(f.requests).size,2);assert.equal(f.lease.snapshot(f.job).nativeSuspended,true);
});
test('expiry, connection changes and native admission events invalidate readiness',async t=>{
  const f=setup(t);await f.lease.acquire(f.job);f.advance(106000);assert.equal(f.lease.snapshot(f.job).nativeSuspended,false);
  await f.lease.acquire(f.job);f.event();assert.equal(f.lease.snapshot(f.job).nativeSuspended,false);
  await f.lease.acquire(f.job);f.changeGeneration();assert.equal(f.lease.snapshot(f.job).nativeSuspended,false);assert.equal((await f.lease.release(f.job))[0].code,'native_unknown');assert.equal(f.counts().resumes,0);
});
test('a concurrent job cannot acquire or release another controller lease',async t=>{
  const f=setup(t);await f.lease.acquire(f.job);const other=randomUUID();assert.equal((await f.lease.acquire(other))[0].code,'native_unknown');assert.deepEqual(await f.lease.release(other),[]);assert.equal(f.counts().resumes,0);assert.deepEqual(f.lease.pendingJobIds(),[f.job]);
});
test('startup qualification is cached only for the same ready lease and failure stays releasable',async t=>{
  const f=setup(t);let checks=0;
  f.runtime.updateStartupBlockers=()=>{checks++;return [{code:'native_startup_policy',message:'Review startup.'}];};
  assert.equal((await f.lease.acquire(f.job))[0].code,'native_startup_policy');assert.equal(f.lease.snapshot(f.job).nativeSuspended,false);
  await f.lease.acquire(f.job);assert.equal(checks,1);assert.deepEqual(await f.lease.release(f.job),[]);
  f.runtime.updateStartupBlockers=()=>{checks++;return [];};assert.deepEqual(await f.lease.acquire(f.job),[]);assert.equal(checks,2);assert.equal(f.lease.snapshot(f.job).nativeSuspended,true);
});
test('closing during a late native prepare preserves its receipt without claiming readiness',async t=>{
  const f=setup(t);let finish!:()=>void,entered!:()=>void;
  const enteredPromise=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>finish=resolve);
  const factory=()=>{const transport=f.factory(),request=transport.request;return {...transport,async request<T>(method:string,params:unknown):Promise<T>{const result=await request<T>(method,params);if(method==='gateway.suspend.prepare'){entered();await wait;}return result;}};};
  const lease=new NativeUpdateLease(f.store,f.runtime,factory,f.now),pending=lease.acquire(f.job);await enteredPromise;
  const closing=lease.close();finish();assert.equal((await pending)[0].code,'native_unknown');await closing;
  assert.equal(lease.snapshot(f.job).nativeSuspended,false);assert.deepEqual(lease.pendingJobIds(),[f.job]);
  assert.deepEqual(await f.lease.release(f.job),[]);
});

test('real update control has finite authority and repeated configuration preserves the saved record',async t=>{
  const f=setup(t),clients:GatewayClientOptions[]=[],calls:string[]=[];
  const original=f.store.internalWrite.bind(f.store);let writes=0;
  f.store.internalWrite=((key:string,value:unknown)=>{if(key==='gateway:configuration')writes++;return original(key,value);}) as typeof f.store.internalWrite;
  const factory=(options:GatewayClientOptions)=>{clients.push(options);return {start(){},async stopAndWait(){},async request<T>(method:string){calls.push(method);return (method==='models.list'?{models:[]}:{ok:true}) as T;}};};
  const ordinary=new Gateway(f.store,'fixture',factory),control=new Gateway(f.store,'fixture',factory,'update-control');
  t.after(async()=>{await control.stop();await ordinary.stop();});
  const hello=(scopes:string[])=>({protocol:4,features:{methods:['models.list','chat.send','system.info','gateway.suspend.prepare','gateway.suspend.status','gateway.suspend.resume'],events:[]},auth:{scopes},policy:{}}) as unknown as HelloOk;
  await ordinary.configure('ws://127.0.0.1:59999','fixture');await ordinary.configure('ws://127.0.0.1:59999');assert.equal(writes,1);assert.equal(clients.length,2);
  clients[1].onHelloOk?.(hello(['operator.read','operator.write']));control.start();clients[2].onHelloOk?.(hello(['operator.read','operator.admin']));
  await assert.rejects(ordinary.request('gateway.suspend.prepare',{}),/not exposed/);
  await assert.rejects(control.request('chat.send',{}),/not exposed/);
  await assert.rejects(control.request('gateway.suspend.prepare',{requestId:f.job,terminalPolicy:'terminate',drain:false}));
  await assert.rejects(control.request('gateway.suspend.prepare',{requestId:f.job,terminalPolicy:'preserve',drain:true}));
  f.store.setUpdateMaintenanceHeld(false);await assert.rejects(control.request('gateway.suspend.prepare',{requestId:f.job,terminalPolicy:'preserve',drain:false}));
  f.store.setUpdateMaintenanceHeld(true);await control.request('gateway.suspend.prepare',{requestId:f.job,terminalPolicy:'preserve',drain:false});
  await control.request('gateway.suspend.resume',{suspensionId:'our-lease'});assert.equal(calls.filter(x=>x==='gateway.suspend.prepare').length,1);
  await ordinary.configure('ws://127.0.0.1:59999','changed-fixture');assert.equal(writes,2);
});

test('maintenance startup reads actual configuration and native journals without rewriting either',t=>{
  const root=mkdtempSync(join(tmpdir(),'nova-native-startup-')),service=join(root,'service'),runtime=join(root,'runtime');mkdirSync(runtime);mkdirSync(join(runtime,'state','agents','main','agent'),{recursive:true});mkdirSync(join(runtime,'state','state'));
  const configuration={gateway:{bind:'loopback',controlUi:{enabled:false}},agents:{defaults:{heartbeat:{every:'0m'}},entries:{main:{}}},cron:{enabled:false},update:{checkOnStart:false,auto:{enabled:false}},models:{catalogRefresh:{enabled:false}},plugins:{allow:['openai','codex'],entries:{openai:{enabled:true},codex:{enabled:true}}}};
  const path=join(runtime,'openclaw.json');writeFileSync(path,JSON.stringify(configuration));writeFileSync(join(runtime,'edition3-runtime.identity'),'edition3-owned-gateway\n');
  const native=new DatabaseSync(join(runtime,'state','agents','main','agent','openclaw-agent.sqlite'));native.exec('PRAGMA user_version=19;CREATE TABLE session_nodes(status TEXT,entry_json TEXT);CREATE TABLE session_pending_inputs(state TEXT);');native.prepare('INSERT INTO session_nodes VALUES (?,?)').run('done',JSON.stringify({goal:{status:'paused'}}));
  const shared=new DatabaseSync(join(runtime,'state','state','openclaw.sqlite'));shared.exec("PRAGMA user_version=15;CREATE TABLE task_runs(status TEXT,delivery_status TEXT);CREATE TABLE subagent_runs(payload_json TEXT);CREATE TABLE flow_runs(status TEXT);CREATE TABLE delivery_queue_entries(status TEXT);INSERT INTO delivery_queue_entries VALUES ('completed');CREATE TABLE gateway_restart_sentinel(sentinel_key TEXT);INSERT INTO gateway_restart_sentinel VALUES ('revision-floor');CREATE TABLE worker_session_placements(state TEXT);");
  t.after(()=>{native.close();shared.close();rmSync(root,{recursive:true,force:true});});
  const before=readFileSync(path,'utf8');assert.deepEqual(qualifyNativeUpdateStartup(runtime,service),[]);
  native.prepare('UPDATE session_nodes SET entry_json=?').run(JSON.stringify({goal:{status:'active'}}));assert.equal(qualifyNativeUpdateStartup(runtime,service)[0].code,'native_startup_policy');
  native.prepare('UPDATE session_nodes SET entry_json=?').run(JSON.stringify({status:'done',abortedLastRun:true,restartRecoveryRuns:[{runId:'old'}]}));assert.deepEqual(qualifyNativeUpdateStartup(runtime,service),[]);
  native.exec("UPDATE session_nodes SET status='running'");assert.equal(qualifyNativeUpdateStartup(runtime,service).length,1);native.exec("UPDATE session_nodes SET status='done'");
  native.prepare('UPDATE session_nodes SET entry_json=?').run('{}');shared.prepare('INSERT INTO task_runs VALUES (?,?)').run('succeeded','pending');assert.equal(qualifyNativeUpdateStartup(runtime,service).length,1);shared.exec('DELETE FROM task_runs');
  shared.prepare('INSERT INTO subagent_runs VALUES (?)').run(JSON.stringify({execution:{status:'interrupted'},delivery:{status:'pending'}}));assert.equal(qualifyNativeUpdateStartup(runtime,service).length,1);shared.exec('DELETE FROM subagent_runs');
  native.exec("INSERT INTO session_pending_inputs VALUES ('queued')");assert.equal(qualifyNativeUpdateStartup(runtime,service).length,1);native.exec('DELETE FROM session_pending_inputs');
  shared.exec("INSERT INTO task_runs VALUES ('succeeded','not_applicable')");assert.deepEqual(qualifyNativeUpdateStartup(runtime,service),[]);
  shared.exec("UPDATE delivery_queue_entries SET status='pending'");assert.equal(qualifyNativeUpdateStartup(runtime,service).length,1);shared.exec("UPDATE delivery_queue_entries SET status='completed'");
  shared.exec("INSERT INTO gateway_restart_sentinel VALUES ('current')");assert.equal(qualifyNativeUpdateStartup(runtime,service).length,1);shared.exec("DELETE FROM gateway_restart_sentinel WHERE sentinel_key='current'");
  shared.exec("INSERT INTO worker_session_placements VALUES ('reconciling')");assert.equal(qualifyNativeUpdateStartup(runtime,service).length,1);shared.exec("UPDATE worker_session_placements SET state='reclaimed'");
  native.exec('PRAGMA user_version=20');assert.equal(qualifyNativeUpdateStartup(runtime,service).length,1);native.exec('PRAGMA user_version=19');
  assert.deepEqual(qualifyNativeUpdateStartup(runtime,service),[]);assert.equal(readFileSync(path,'utf8'),before);
  writeFileSync(path,JSON.stringify({...configuration,cron:{enabled:true}}));assert.equal(qualifyNativeUpdateStartup(runtime,service).length,1);
});

test('a held startup with unsupported native automation returns status without launching or rewriting configuration',async()=>{
  const root=mkdtempSync(join(tmpdir(),'nova-update-startup-gate-')),entry=join(root,'openclaw.mjs'),previous=process.env.E3_OPENCLAW_ENTRY;
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'openclaw',version:'2026.9.2'}));writeFileSync(entry,"import {writeFileSync} from 'node:fs';writeFileSync('unexpected-launch','yes');");process.env.E3_OPENCLAW_ENTRY=entry;
  const store=new Store(join(root,'app'));const gateway={status:()=>({state:'disconnected',message:'',methods:[],grantedScopes:[],modelAuthReady:false} as AssistantConnection),async configure(){throw Error('must not connect');}};
  const runtime=new ManagedRuntime(store,gateway),native=join(store.directory,'openclaw-runtime'),config=join(native,'openclaw.json');
  try{
    mkdirSync(native,{recursive:true});writeFileSync(config,JSON.stringify({cron:{enabled:true},plugins:{allow:[],entries:{}}}));const original=readFileSync(config,'utf8');store.setUpdateMaintenanceHeld(true);
    const status=await runtime.start();assert.equal(status.state,'error');assert.equal(status.phase,'failed');assert.equal(existsSync(join(native,'unexpected-launch')),false);assert.equal(readFileSync(config,'utf8'),original);
  }finally{await runtime.stop();store.close();if(previous===undefined)delete process.env.E3_OPENCLAW_ENTRY;else process.env.E3_OPENCLAW_ENTRY=previous;rmSync(root,{recursive:true,force:true});}
});
