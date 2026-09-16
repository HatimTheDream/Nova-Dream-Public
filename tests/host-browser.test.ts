import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantConnection } from '../packages/domain/assistant.js';
import { HostBrowser } from '../apps/service/host-browser.js';
import { Store } from '../apps/service/store.js';
class Transport{
  connection:AssistantConnection={state:'ready',url:'ws://127.0.0.1:4444',generation:'first',methods:['browser.request'],grantedScopes:['operator.admin'],message:'Fixture',modelAuthReady:true};
  calls:any[]=[];fail=false;
  status(){return this.connection;}start(){}async stop(){}subscribe(){return()=>{};}async models(){return [];}attachmentPolicy(){return {};}
  async request<T>(_method:string,params:any):Promise<T>{this.calls.push(params);if(this.fail&&params.path==='/act')throw Error('Lost response');const response=params.path==='/'?{enabled:true,running:true}:params.path==='/tabs'?{tabs:[{targetId:'tab1',url:'https://example.com/',title:'Example'}]}:params.path==='/snapshot'?{url:'https://example.com/',snapshot:'- button "Save" [ref=e1]'}:params.path==='/screenshot'?{}:{targetId:'tab1',ok:true};return response as T;}
}
function fixture(t:any){const directory=mkdtempSync(join(tmpdir(),'nova-browser-')),store=new Store(directory),transport=new Transport();let now=1000;const browser=new HostBrowser(store,transport,()=>transport,async()=>{},()=>now);t.after(async()=>{await browser.close();store.close();rmSync(directory,{recursive:true,force:true});});return {store,transport,browser,advance:()=>{now+=120001;}};}
test('browser stays disabled until selected, uses only the Nova profile, and refuses stale observations',async t=>{
  const f=fixture(t);assert.equal((await f.browser.state()).enabled,false);assert.equal(f.transport.calls.length,0);
  await f.browser.configure('owner',{requestId:randomUUID(),epoch:f.store.epoch,enabled:true});const o=await f.browser.observe('owner','tab1');assert.match(o.text,/Save/);assert.equal(o.image,undefined);
  const id=randomUUID();assert.equal((await f.browser.act('owner',id,{action:'click',targetId:'tab1',ref:'e1',observationId:o.id})).state,'completed');
  assert(f.transport.calls.every(c=>c.query.profile==='nova-work'));f.advance();await assert.rejects(f.browser.act('owner',randomUUID(),{action:'click',targetId:'tab1',ref:'e1',observationId:o.id}),/Observe/);
  await f.browser.configure('owner',{requestId:randomUUID(),epoch:f.store.epoch,enabled:false});await assert.rejects(f.browser.observe('owner','tab1'),/Enable/);
});
test('a disconnected browser action is never replayed; reused IDs and revoked task access are rejected',async t=>{
  const f=fixture(t);await f.browser.configure('owner',{requestId:randomUUID(),epoch:f.store.epoch,enabled:true});const o=await f.browser.observe('owner','tab1'),id=randomUUID(),input={action:'click',targetId:'tab1',ref:'e1',observationId:o.id};f.transport.fail=true;
  assert.equal((await f.browser.act('owner',id,input)).state,'unknown');assert.equal((await f.browser.act('owner',id,input)).state,'unknown');assert.equal(f.transport.calls.filter(c=>c.path==='/act').length,1);
  await assert.rejects(f.browser.act('owner',id,{...input,ref:'e2'}),/different input/);await assert.rejects(f.browser.act('owner',randomUUID(),input,()=>{throw Error('Revoked');}),/Revoked/);
});

test('simultaneous retries make one action and a newer observation invalidates older element references',async t=>{
  const f=fixture(t);await f.browser.configure('owner',{requestId:randomUUID(),epoch:f.store.epoch,enabled:true});
  const old=await f.browser.observe('owner','tab1'),fresh=await f.browser.observe('owner','tab1');
  await assert.rejects(f.browser.act('owner',randomUUID(),{action:'click',targetId:'tab1',ref:'e1',observationId:old.id}),/Observe/);
  const id=randomUUID(),input={action:'click',targetId:'tab1',ref:'e1',observationId:fresh.id};
  const results=await Promise.all([f.browser.act('owner',id,input),f.browser.act('owner',id,input)]);
  assert(results.every(r=>r.state==='completed'));assert.equal(f.transport.calls.filter(c=>c.path==='/act').length,1);
  await assert.rejects(f.browser.act('owner',randomUUID(),input),/Observe/);
});
test('a failed enable never claims that browsing is enabled and an old setting receipt cannot undo a newer choice',async t=>{
  const f=fixture(t),broken=new HostBrowser(f.store,f.transport,()=>f.transport,async()=>{throw Error('Config write failed');});
  await assert.rejects(broken.configure('owner',{requestId:randomUUID(),epoch:f.store.epoch,enabled:true}),/Config write/);assert.equal((await broken.state()).enabled,false);await broken.close();
  const first={requestId:randomUUID(),epoch:f.store.epoch,enabled:true};await f.browser.configure('owner',first);await f.browser.configure('owner',{requestId:randomUUID(),epoch:f.store.epoch,enabled:false});await f.browser.configure('owner',first);assert.equal((await f.browser.state()).enabled,false);
});
