import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {request as httpRequest} from 'node:http';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../apps/service/http.js';
import {Store} from '../apps/service/store.js';
import {FeedAdaptiveController} from '../apps/service/feed-adaptive-controller.js';
import {FeedSemanticHttp} from '../apps/service/feed-semantic-http.js';
import type {AssistantTransport} from '../apps/service/gateway.js';
import {emptyFeedSettings} from '../packages/domain/news-feed.js';

const prefix='home/news/semantic',candidate='a'.repeat(64),phoneOrigin='https://phone.example.ts.net:8443';
const operation=process.env.NOVA_HISTORY_TEST_OPERATION??randomUUID();
if(!operation||!/^[a-zA-Z0-9_-]{1,80}$/.test(operation))throw Error('Exact HTTP integration operation required');
const namespace=fileURLToPath(new URL('../.tmp-qa/http-join/'+operation+'/',import.meta.url));
mkdirSync(namespace,{recursive:true});

/** Supplied through the maintained server transport seam. Any attempted
 * provider/native/model work fails; it cannot manufacture qualification. */
function unavailableTransport(){
 const calls:string[]=[],subscriptions=new Set<unknown>();
 const gateway:AssistantTransport={
  status:()=>({state:'unconfigured',message:'Synthetic local HTTP check',methods:[],grantedScopes:[],modelAuthReady:false}),
  async request<T>(method:string):Promise<T>{calls.push(method);throw Error('Unexpected native transport request: '+method);},
  subscribe(listener){subscriptions.add(listener);return()=>{subscriptions.delete(listener);};},
  async models(){calls.push('models');throw Error('Unexpected model discovery');},
  async modelsWithAuthority(authorize){authorize();calls.push('modelsWithAuthority');throw Error('Unexpected model discovery');},
  attachmentPolicy:()=>({}),
 };
 return {gateway,calls,subscriptions};
}
type Reply={status:number;data:any;cookie?:string};
function call(origin:string,path:string,value?:unknown,headers:Record<string,string>={}):Promise<Reply>{
 return new Promise((resolve,reject)=>{
  const req=httpRequest(origin+'/api/'+path,{method:value===undefined?'GET':'POST',headers:{
   'Content-Type':'application/json','X-Edition3-Client':'1','X-Edition3-Candidate':candidate,...headers,
  }},res=>{
   const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
   res.on('end',()=>{try{resolve({status:res.statusCode!,data:JSON.parse(Buffer.concat(chunks).toString('utf8')),cookie:res.headers['set-cookie']?.[0]});}catch(error){reject(error);}});
  });
  req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Original HTTP request timed out')));
  req.end(value===undefined?undefined:JSON.stringify(value));
 });
}
function confirmed(reply:Reply){assert.equal(reply.status,200,JSON.stringify(reply.data));return reply.data;}

test('Actual local HTTP joins saved Feed originals to authentication, held replay, restart and owned shutdown without native qualification', {timeout:120000}, async()=>{
 const directory=join(namespace,'live'),failedDirectory=join(namespace,'bind'),transport=unavailableTransport(),failedTransport=unavailableTransport();
 const phoneTransport={reconcile:async()=>({state:'ready' as const,origin:phoneOrigin,message:'Synthetic private route'}),disable:async()=>{}};
 const closedPaths:string[]=[],feedClosures:{localSettled:boolean}[]=[];
 const storeClose=Store.prototype.close,feedClose=FeedAdaptiveController.prototype.close;
 Store.prototype.close=function(){const path=this.directory;const result=storeClose.call(this);closedPaths.push(path);return result;};
 FeedAdaptiveController.prototype.close=function(waitMs?:number){return feedClose.call(this,waitMs).then(result=>{feedClosures.push(result);return result;});};
 let server:Awaited<ReturnType<typeof startServer>>|undefined,passed=false;
 try{
  server=await startServer({directory,port:0,phonePort:0,phoneTransport,gateway:transport.gateway,candidateId:candidate,version:'local-http-proof'});
  const host=()=>server!;
  let cookie='';
  const request=(path:string,value?:unknown,extra:Record<string,string>={})=>call(host().origin,path,value,{Cookie:cookie,Origin:host().origin,...extra});
  const envelope=()=>({requestId:randomUUID(),epoch:host().store.epoch});
  assert.equal((await request(prefix+'/view')).status,401);
  const session=await request('session',{}),device=confirmed(session).deviceId;cookie=session.cookie!.split(';')[0];
  assert.equal((await request(prefix+'/view',undefined,{Origin:'https://foreign.example'})).status,403);
  assert.equal((await request(prefix+'/view',undefined,{Host:'foreign.example'})).status,403);
  assert.equal((await request(prefix+'/view',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
  const view=confirmed(await request(prefix+'/view'));
  assert.equal(view.epoch,host().store.epoch);assert.equal(view.deviceId,device);assert.equal(view.permissions.write,true);
  assert.deepEqual(view.native,{prepare:false,observe:false,reason:'unavailable'});
  assert.equal((await request(prefix+'/feed')).status,200);
  assert(['idle','held'].includes(confirmed(await request(prefix+'/advance',{epoch:host().store.epoch})).state));
  assert.equal((await request(prefix+'/advance',{epoch:randomUUID()})).status,403);

  // Existing local Feed settings and their exact receipt keep their old routes.
  const legacy=confirmed(await request('home/news'));
  const settings={...envelope(),expectedRevision:legacy.value.revision,type:'settings',settings:{...emptyFeedSettings(),interests:['Writing']}};
  const savedSettings=confirmed(await request('home/news',settings));assert.equal(savedSettings.state,'saved');
  assert.deepEqual(confirmed(await request('home/news/receipt',settings)),savedSettings);

  const original={kind:'interpret' as const,requestId:randomUUID(),epoch:host().store.epoch,expectedRevision:savedSettings.profileRevision};
  const close={kind:'close',command:{format:3,...envelope(),original}};
  const saved=confirmed(await request(prefix+'/command',close));assert.equal(saved.state,'confirmed');
  const ledger=host().store.internalFeedLedger();
  assert.deepEqual(ledger.rows.map(row=>row.id).sort(),[original.requestId,close.command.requestId].map(id=>'news:semantic-local:'+id).sort());
  assert.deepEqual(confirmed(await request(prefix+'/original/receipt',close)),saved);
  assert.deepEqual(host().store.internalFeedLedger(),ledger);
  const preparation={format:3,...envelope(),kind:'interpret'};
  for(const [path,input] of [[prefix+'/prepare',preparation],[prefix+'/observe',{format:3,epoch:host().store.epoch,id:original.requestId}]] as const){
   const refused=await request(path,input),absentOriginal=path===prefix+'/observe';
   assert.equal(refused.status,absentOriginal?404:409);assert.equal(refused.data.code,absentOriginal?'feed_original_unavailable':'feed_native_unavailable');
  }
  assert.deepEqual(host().store.internalFeedLedger(),ledger);assert.deepEqual(transport.calls,[]);
  assert.equal((await request(prefix+'/command',close,{'X-Edition3-Client':''})).status,403);
  assert.equal((await request(prefix+'/command',close,{'X-Edition3-Candidate':'b'.repeat(64)})).data.code,'client_update');

  // These exact POSTs are reads. Holds and stale windows cannot hide a saved
  // original, but cannot use a neighboring path to gain a write exemption.
  for(const hold of ['maintenance','held','paused'] as const){
   if(hold==='maintenance')host().store.setUpdateMaintenanceHeld(true);
   else host().store.internalWrite('recovery:state',hold==='held'?{held:true}:{held:false,effectsPaused:true});
   assert.deepEqual(confirmed(await request(prefix+'/original/receipt',close,{'X-Edition3-Candidate':'b'.repeat(64)})),saved);
   assert.equal(confirmed(await request(prefix+'/view')).permissions.write,false);
   assert.equal((await request(prefix+'/command',close)).status,409);
   assert.equal((await request(prefix+'/original/receipt/extra',close)).status,hold==='maintenance'?404:409);
   assert.deepEqual(host().store.internalFeedLedger(),ledger);
   if(hold==='maintenance')host().store.setUpdateMaintenanceHeld(false);else host().store.internalDelete('recovery:state');
  }

  // Exercise the actual second listener and paired cookie, without Tailscale
  // commands. The production phone policy adds only the exact Feed pairs.
  confirmed(await request('phone/enable',envelope()));
  const pairing=confirmed(await request('phone/pairing',envelope()));
  const remote={Host:new URL(phoneOrigin).host,Origin:phoneOrigin,'Tailscale-User-Login':'owner@example.test'};
  const paired=await call(host().phoneHost.localOrigin,'pair',{requestId:randomUUID(),code:pairing.code,name:'Feed fixture'},remote);
  const phoneDevice=confirmed(paired).deviceId,phoneHeaders={...remote,Cookie:paired.cookie!.split(';')[0]};
  assert.equal(confirmed(await call(host().phoneHost.localOrigin,prefix+'/view',undefined,phoneHeaders)).deviceId,phoneDevice);
  assert(['idle','held'].includes(confirmed(await call(host().phoneHost.localOrigin,prefix+'/advance',{epoch:host().store.epoch},phoneHeaders)).state));
  assert.equal((await call(host().phoneHost.localOrigin,prefix+'/original/receipt/extra',close,phoneHeaders)).data.code,'desktop_required');
  assert.equal((await call(host().phoneHost.localOrigin,'assistant/runtime/start',{},phoneHeaders)).data.code,'desktop_required');
  confirmed(await request('phone/disable',envelope()));

  // Revoke the exact captured token after the seam promise resolves. Replacing
  // the request cookie with another valid session cannot authorize exposure.
  const replacement=host().store.session(),cookieName=cookie.slice(0,cookie.indexOf('=')),oldToken=cookie.slice(cookie.indexOf('=')+1);
  const handle=FeedSemanticHttp.prototype.handle;let revoked=false;
  FeedSemanticHttp.prototype.handle=async function(req,surface){
   const result=await handle.call(this,req,surface);
   if(!revoked&&req.url==='/api/'+prefix+'/view'){
    revoked=true;(host().store as any).db.prepare('UPDATE sessions SET expires=0 WHERE digest=?').run(createHash('sha256').update(oldToken).digest('hex'));
    req.headers.cookie=cookieName+'='+replacement.token;
   }
   return result;
  };
  try{assert.equal((await request(prefix+'/view')).status,401);assert.equal(revoked,true);}
  finally{FeedSemanticHttp.prototype.handle=handle;}
  // Renew the original owner session only for checking its persisted receipt.
  (host().store as any).db.prepare('UPDATE sessions SET expires=? WHERE digest=?').run(Date.now()+60000,createHash('sha256').update(oldToken).digest('hex'));

  // A competing listener must close its real composed controller and Store,
  // while preserving the original EADDRINUSE failure and this usable server.
  const beforeFailure=feedClosures.length;
  await assert.rejects(startServer({directory:failedDirectory,port:Number(new URL(host().origin).port),gateway:failedTransport.gateway,candidateId:candidate}),
   (error:any)=>error.code==='EADDRINUSE');
  assert.equal(feedClosures.length,beforeFailure+1);assert.equal(feedClosures.at(-1)!.localSettled,true);
  assert(closedPaths.includes(failedDirectory));assert.equal((await request(prefix+'/view')).status,200);
  assert.deepEqual(failedTransport.calls,[]);assert.equal(failedTransport.subscriptions.size,0);

  const settledLedger=host().store.internalFeedLedger();
  const first=host(),closing=first.close(5000);assert.strictEqual(first.close(5000),closing);await closing;
  assert.deepEqual(first.drainStatus(),{closing:true,closed:true,feedAttached:true});assert.equal(transport.subscriptions.size,0);
  server=undefined;
  const reopened=new Store(directory);try{assert.deepEqual(reopened.internalFeedLedger(),settledLedger);}finally{reopened.close();}
  server=await startServer({directory,port:0,phonePort:0,phoneTransport,gateway:transport.gateway,candidateId:candidate,version:'local-http-proof'});
  assert.deepEqual(confirmed(await request(prefix+'/original/receipt',close)),saved);
  const history=confirmed(await request(prefix+'/history'));
  assert.deepEqual(history.entries.map((entry:any)=>entry.request.command.requestId).sort(),[close.command.requestId,original.requestId].sort());
  assert.deepEqual(confirmed(await request('home/news/receipt',settings)),savedSettings);
  assert.deepEqual(transport.calls,[]);assert(feedClosures.every(result=>result.localSettled));
  passed=true;
 }finally{
  try{if(server)await server.close(5000);}catch(error){passed=false;throw error;}
  finally{
   Store.prototype.close=storeClose;FeedAdaptiveController.prototype.close=feedClose;
   writeFileSync(join(namespace,'HTTP-FIXTURES.json'),JSON.stringify({operation,paths:[directory,failedDirectory],passed,nativeExecution:false,retained:true},null,2));
  }
 }
});
