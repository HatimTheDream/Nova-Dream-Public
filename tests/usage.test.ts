import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantConnection } from '../packages/domain/assistant.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { AssistantUsage, projectUsage } from '../apps/service/usage.js';
import { startServer } from '../apps/service/http.js';
const quota={updatedAt:1800000000000,providers:[{provider:'openai-codex',displayName:'ChatGPT',plan:'plus',windows:[{label:'5h',usedPercent:25,resetAt:1800001000000},{label:'Week',usedPercent:80}],billing:[{type:'balance',unit:'credits',amount:0}]}]};
const activity={totals:{totalTokens:150,input:100,output:40,cacheRead:10},daily:[{date:'2026-09-15',totalTokens:150}],cacheStatus:{status:'fresh'}};
class Transport implements AssistantTransport {
  connection:AssistantConnection={state:'ready',generation:'first',message:'Fixture',methods:['usage.status','usage.cost'],grantedScopes:['operator.read'],modelAuthReady:true};
  calls:{method:string;params:unknown}[]=[];
  reply:(method:string)=>Promise<unknown>=async method=>method==='usage.status'?quota:activity;
  status(){return this.connection;}
  async request<T>(method:string,params:unknown):Promise<T>{this.calls.push({method,params});return await this.reply(method) as T;}
  subscribe(){return()=>{};}
  async models(){return[];}
  attachmentPolicy(){return{};}
}
test('usage projection distinguishes absent limits from zero, clamps percentages and excludes private error fields',()=>{
  const value=projectUsage(quota,activity,10);assert.equal(value.providers[0].windows[0].usedPercent,25);assert.equal(value.providers[0].windows[0].resetAt,1800001000000);assert.equal(value.providers[0].credits,0);assert.equal(value.activity.tokens,150);
  const missing=projectUsage({providers:[{windows:[{}, {usedPercent:0},{usedPercent:150},{usedPercent:-1},{usedPercent:Infinity}]}]},null,20);
  assert.deepEqual(missing.providers[0].windows.map(w=>w.usedPercent),[null,0,100,null,null]);assert.equal(missing.providers[0].credits,null);assert.equal(missing.activity.status,'unavailable');
  const failure=projectUsage({providers:[{provider:'openai',error:'SECRET_AUTH raw error',accessToken:'SECRET_TOKEN',profile:{email:'private@example.invalid'},windows:[{usedPercent:0}],billing:[{type:'balance',unit:'credits',amount:20}]}]},undefined,30);
  assert.equal(failure.providers[0].unavailable,true);assert.deepEqual(failure.providers[0].windows,[]);assert.equal(failure.providers[0].credits,null);assert(!JSON.stringify(failure).includes('SECRET'));assert(!JSON.stringify(failure).includes('private@'));
  assert.equal(projectUsage(undefined,activity,1).state,'unavailable');assert.equal(projectUsage(undefined,activity,1).activity.tokens,150);
  assert.equal(projectUsage({refreshing:true,providers:[]},{...activity,cacheStatus:{status:'partial'}},1).activity.status,'partial');
});
test('usage reads coalesce, expire and discard results from a replaced host',async()=>{
  const gateway=new Transport();let now=0,release!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve);gateway.reply=async method=>{await held;return method==='usage.status'?quota:activity;};
  const service=new AssistantUsage(gateway,()=>now),first=service.read(),second=service.read();assert.equal(gateway.calls.length,2);release();assert.deepEqual(await first,await second);
  await service.read();assert.equal(gateway.calls.length,2);now=30001;await service.read();assert.equal(gateway.calls.length,4);
  let finish!:(value:unknown)=>void;now=60002;gateway.reply=async method=>method==='usage.status'?new Promise(resolve=>finish=resolve):activity;
  const obsolete=service.read();gateway.connection={...gateway.connection,generation:'second'};finish(quota);assert.equal((await obsolete).state,'unavailable');
  gateway.reply=async()=>({});assert.equal((await service.read()).state,'unavailable');assert.equal(gateway.calls.length,8);
  gateway.connection={...gateway.connection,state:'disconnected'};assert.equal((await service.read()).activity.status,'unavailable');assert.equal(gateway.calls.length,8);
});
test('missing or failing usage methods leave independent figures usable and do not expose raw errors',async()=>{
  const gateway=new Transport();gateway.reply=async method=>{if(method==='usage.cost')throw Error('SECRET_ACCESS');return quota;};
  const service=new AssistantUsage(gateway);const value=await service.read();assert.equal(value.state,'ready');assert.equal(value.activity.status,'unavailable');assert(!JSON.stringify(value).includes('SECRET'));
  assert.deepEqual(gateway.calls.find(c=>c.method==='usage.cost')?.params,{days:7,agentScope:'all'});
  gateway.connection={...gateway.connection,generation:'other',methods:[]};assert.equal((await service.read()).state,'unavailable');assert.equal(gateway.calls.length,2);
});
test('usage HTTP route requires an owner session and projects authenticated runtime observations',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'nova-usage-')),gateway=new Transport();
  const service=await startServer({directory,port:0,candidateId:'a'.repeat(64),gateway});
  t.after(async()=>{await service.close();rmSync(directory,{recursive:true,force:true});});
  const headers={'X-Edition3-Client':'1','X-Edition3-Candidate':'a'.repeat(64),'Content-Type':'application/json'};
  assert.equal((await fetch(service.origin+'/api/assistant/usage',{headers})).status,401);
  const session=await fetch(service.origin+'/api/session',{method:'POST',headers,body:'{}'}),cookie=session.headers.get('set-cookie')!.split(';')[0];
  const response=await fetch(service.origin+'/api/assistant/usage',{headers:{...headers,Cookie:cookie}});assert.equal(response.status,200);
  const value=await response.json();assert.equal(value.providers[0].windows[0].usedPercent,25);assert.equal(value.activity.tokens,150);
  assert.equal((await fetch(service.origin+'/api/assistant/usage',{headers:{...headers,Cookie:cookie,Origin:'https://untrusted.invalid'}})).status,403);
});
