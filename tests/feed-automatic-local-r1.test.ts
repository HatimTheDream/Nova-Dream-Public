import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,type Reopen} from './feed-auto-fixture-r1.js';
import {FeedAutomaticLocal} from '../apps/service/feed-automatic-local.js';

const learning={enabled:true,paused:false,instructionsOnly:false,allowed:['library'],scope:'related'};
function prepare(f:any){f.configure({learning});f.library();f.stories();}
function deferred(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
function driver(f:any,overrides:Record<string,unknown>={}){
 const controller=Object.fromEntries(['nativeCapabilities','prepare','start','observe','readOriginal','applyLearning','closeOriginal'].map(name=>[name,f.controller[name].bind(f.controller)]));
 return new FeedAutomaticLocal(f.store,f.news,{...controller,...overrides} as any,f.source,f.authority,()=>f.now());
}
async function finish(f:any,id:string){
 await f.authority.worker.settle();
 const record=f.store.internalRead('news:semantic-adaptive-worker:'+id);assert(record);
 let output:unknown;
 if(record.capture.kind==='learn')output={format:2,requestId:record.id,captureSha256:record.capture.learning.captureSha256,candidates:[{id:'energy',label:'Energy discovery',supports:record.capture.source.context.activity.map((row:any)=>({activityId:row.id,start:0,end:row.text.length,quote:row.text})),relation:{kind:'activity-only',anchors:[]},constraints:[]}]};
 else{
  assert.equal(record.capture.kind,'classify');const preview=record.capture.preview,story=preview.story;
  const evidence=[{field:'summary',start:0,end:Math.min(6,story.summary.length),quote:story.summary.slice(0,6)}];
  output={format:2,requestId:record.id,previewSha256:preview.previewSha256,rules:(preview.basis.kind==='accepted'?preview.basis.plan.rules:[]).map((row:any)=>({id:row.id,outcome:'met',evidence})),candidates:preview.candidates.map((row:any)=>({id:row.kind+':'+row.id,outcome:'met',evidence}))};
 }
 f.gateway.finish(JSON.stringify(output));f.gateway.observation.endedAt=f.now();f.gateway.observation.terminalReceipt.effective={provider:'openai',model:'test-model'};f.gateway.observation.terminalReceipt.sourceReplyDelivered=false;
 return record;
}

test('Automatic Feed learns applies and classifies once across clock changes and actual Store reopen',async()=>{
 let reopen!:Reopen,ledger:unknown;
 await fixture(async f=>{
  prepare(f);const applications:any[]=[];
  const automatic=driver(f,{applyLearning(owner:any,command:any){
   applications.push(structuredClone(command));
   if(applications.length===1)throw Error('Synthetic failure before local learning commit');
   const value=f.controller.applyLearning(owner,command);
   if(applications.length===2)throw Error('Synthetic lost learning acknowledgement');
   return value;
  }});
  const learn=await automatic.advance(f.owner);assert.equal(learn.state,'started');assert.equal((await finish(f,learn.id!)).capture.kind,'learn');
  assert.deepEqual(await automatic.advance(f.owner),{state:'observed',id:learn.id});
  await assert.rejects(automatic.advance(f.owner),/before local learning commit/);assert.equal(f.graph().learning.size,0);
  await assert.rejects(automatic.advance(f.owner),/lost learning acknowledgement/);assert.equal(f.graph().learning.size,1);
  assert.deepEqual(applications[1],applications[0]);
  assert.deepEqual(await automatic.advance(f.owner),{state:'observed',id:applications[0].requestId});assert.equal(applications.length,2);
  const classify=await automatic.advance(f.owner);assert.equal(classify.state,'started');assert.equal((await finish(f,classify.id!)).capture.kind,'classify');
  assert.deepEqual(await automatic.advance(f.owner),{state:'observed',id:classify.id});
  assert.deepEqual(await automatic.advance(f.owner),{state:'idle'});
  assert.equal(f.graph().learning.size,1);assert.equal(f.gateway.nativeCalls.length,2);
  ledger=f.store.internalFeedLedger();f.advance(60000);
  assert.deepEqual(await automatic.advance(f.owner),{state:'idle'});assert.deepEqual(f.store.internalFeedLedger(),ledger);assert.equal(f.gateway.nativeCalls.length,2);
  reopen=f.reopen();
 });
 await fixture(async f=>{
  const before=f.store.internalRead('gateway:configuration'),revision=f.store.internalGatewayConfigurationRevision();
  assert.deepEqual(f.store.internalFeedLedger(),ledger);
  assert.deepEqual(await driver(f).advance(f.owner),{state:'idle'});
  assert.deepEqual(f.store.internalFeedLedger(),ledger);assert.equal(f.gateway.nativeCalls.length,0);
  assert.deepEqual(f.store.internalRead('gateway:configuration'),before);assert.equal(f.store.internalGatewayConfigurationRevision(),revision);
 },reopen);
});

test('Automatic Feed holds the exact uncertain original across source change and refuses foreign pending ownership',async()=>{
 let reopen!:Reopen,ledger:unknown,absentStart:any,keptClose:any;
 await fixture(async f=>{
  prepare(f);let starts=0,reads=0,hideClose=true;const closes:any[]=[];
  const automatic=driver(f,{
   async start(_owner:any,command:any){starts++;absentStart=structuredClone(command);throw Error('Synthetic Start failure before admission');},
   readOriginal(owner:any,request:any){reads++;return hideClose&&request.kind==='close'?{state:'unknown',request}:f.controller.readOriginal(owner,request);},
   closeOriginal(owner:any,command:any){
    closes.push(structuredClone(command));keptClose=structuredClone(command);
    if(closes.length===1)throw Error('Synthetic failure before Close fence');
    if(closes.length===2){
     const admit=f.store.internalAdmitFeed;let transactions=0;
     f.store.internalAdmitFeed=function(this:any,...args:any[]){if(++transactions===2)throw Error('Synthetic failure after fence before acknowledgement');return admit.apply(this,args);};
     try{return f.controller.closeOriginal(owner,command);}finally{f.store.internalAdmitFeed=admit;}
    }
    return f.controller.closeOriginal(owner,command);
   },
  });
  await assert.rejects(automatic.advance(f.owner),/Start failure before admission/);assert.equal(starts,1);assert.equal(f.gateway.nativeCalls.length,0);
  await assert.rejects(automatic.advance(f.owner),/before Close fence/);assert.equal(f.graph().locals.size,0);
  await assert.rejects(automatic.advance(f.owner),/after fence before acknowledgement/);
  assert.equal(f.graph().locals.get(absentStart.requestId).kind,'closed-before-admission');assert.equal(f.graph().locals.has(keptClose.requestId),false);
  assert.deepEqual(closes[1],closes[0]);assert.deepEqual(keptClose.original,absentStart);
  f.command('settings',{settings:{...f.saved().profile.settings,learning:{...learning,allowed:[]}}});
  f.revoke();const priorReads=reads,foreignSession=f.store.session();let foreignChecks=0;
  const foreign={deviceId:foreignSession.deviceId,epoch:f.store.epoch,authorize(){foreignChecks++;assert.equal(f.store.authenticate(foreignSession.token),foreignSession.deviceId);}};
  assert.deepEqual(await automatic.advance(foreign),{state:'held'});assert(foreignChecks>0);assert.equal(reads,priorReads);assert.equal(closes.length,2);
  await assert.rejects(automatic.advance(f.owner),/revoked/);f.restore();
  await assert.rejects(automatic.advance(f.owner),(error:any)=>error.code==='feed_automatic_persistence');
  assert.equal(closes.length,3);assert.deepEqual(closes[2],closes[0]);assert.equal(f.graph().locals.get(keptClose.requestId).outcome,'closed-before-admission');
  hideClose=false;assert.deepEqual(await automatic.advance(f.owner),{state:'observed',id:absentStart.requestId});
  assert.equal(closes.length,3,'confirmed readback does not invoke Close again');assert.equal(starts,1);assert.equal(f.gateway.nativeCalls.length,0);
  assert.deepEqual(f.controller.history(f.owner,{}).entries.map((row:any)=>row.request.command.requestId).sort(),[absentStart.requestId,keptClose.requestId].sort());
  ledger=f.store.internalFeedLedger();reopen=f.reopen();
 });
 await fixture(async f=>{
  assert.deepEqual(f.store.internalFeedLedger(),ledger);
  assert.equal(f.controller.readOriginal(f.owner,{kind:'start',command:absentStart}).state,'confirmed');
  assert.equal(f.controller.readOriginal(f.owner,{kind:'close',command:keptClose}).state,'confirmed');
  assert.equal(f.graph().locals.get(keptClose.requestId).outcome,'closed-before-admission');assert.equal(f.gateway.nativeCalls.length,0);
 },reopen);
 await fixture(async f=>{
  prepare(f);let captured:any,starts=0,closes=0,observations=0,maskStart=true,closeId:string|undefined;
  const automatic=driver(f,{
   async start(owner:any,command:any){starts++;captured=structuredClone(command);await f.controller.start(owner,command);throw Error('Synthetic lost outer acknowledgement');},
   readOriginal(owner:any,request:any){return maskStart&&request.kind==='start'?{state:'unknown',request}:f.controller.readOriginal(owner,request);},
   closeOriginal(owner:any,command:any){closes++;closeId=command.requestId;const value=f.controller.closeOriginal(owner,command);maskStart=false;return value;},
   async observe(owner:any,id:string){owner.authorize();observations++;return {state:'unknown',id};},
  });
  await assert.rejects(automatic.advance(f.owner),/lost outer acknowledgement/);await f.authority.worker.settle();
  assert.deepEqual(await automatic.advance(f.owner),{state:'observed',id:captured.requestId});
  assert.equal(closes,1);assert.equal(f.graph().locals.get(closeId).outcome,'already-admitted');assert.equal(starts,1);assert.equal(f.gateway.nativeCalls.length,1);
  const original=f.store.internalRead('news:semantic-adaptive-worker:'+captured.requestId);assert.deepEqual(original.command,captured);
  f.advance(original.deadlineAt-f.now()+1);
  assert.deepEqual(await automatic.advance(f.owner),{state:'observed',id:captured.requestId});assert.equal(observations,1);
  assert.deepEqual(await automatic.advance(f.owner),{state:'held'});assert.equal(observations,1,'unresolved work gets no repeated automatic observation after its original deadline');
  assert.equal(f.graph().adaptiveWorkers.size,1);assert.equal(starts,1);assert.equal(f.gateway.nativeCalls.length,1);
 });
});

test('Automatic Feed rechecks changed settings and permitted source after preparation and holds repeated failed probes',()=>fixture(async f=>{
 prepare(f);let mode:'settings'|'source'|'failure'='settings',preparations=0;
 const automatic=driver(f,{async prepare(owner:any,descriptor:any){
  preparations++;const command=await f.controller.prepare(owner,descriptor);
  if(mode==='settings')f.command('settings',{settings:{...f.saved().profile.settings,learning:{...learning,paused:true}}});
  else if(mode==='source'){
   const note=f.store.internalRead('home:library:item:note-one');f.store.internalWrite('home:library:item:note-one',{...note,revision:note.revision+1,body:note.body+' changed'});
  }else throw Error('Synthetic failed preparation');
  return command;
 }});
 assert.deepEqual(await automatic.advance(f.owner),{state:'held'});assert.equal(f.gateway.nativeCalls.length,0);
 f.command('settings',{settings:{...f.saved().profile.settings,learning}});mode='source';
 assert.deepEqual(await automatic.advance(f.owner),{state:'held'});assert.equal(f.gateway.nativeCalls.length,0);
 mode='failure';await assert.rejects(automatic.advance(f.owner),/failed preparation/);const before=preparations;
 assert.deepEqual(await automatic.advance(f.owner),{state:'held'});assert.equal(preparations,before,'same semantic input cannot repeatedly probe preparation');
 const note=f.store.internalRead('home:library:item:note-two');f.store.internalWrite('home:library:item:note-two',{...note,revision:note.revision+1,body:note.body+' changed'});
 await assert.rejects(automatic.advance(f.owner),/failed preparation/);assert.equal(preparations,before+1,'genuinely changed allowed source is a different input');
 assert.equal(f.gateway.nativeCalls.length,0);assert.equal(f.graph().adaptiveWorkers.size,0);
}));

test('Automatic Feed keeps an in-flight step in the existing native close and maintenance owner',()=>fixture(async f=>{
 prepare(f);const entered=deferred(),release=deferred();
 const automatic=driver(f,{async prepare(owner:any,descriptor:any){entered.release();await release.promise;return f.controller.prepare(owner,descriptor);}});
 const original=automatic.advance(f.owner);await Promise.race([entered.promise,original.then(()=>{throw Error('Automatic step did not enter the held preparation');})]);
 try{
  assert.deepEqual(await automatic.advance(f.owner),{state:'held'});
  assert.equal(f.controller.maintenanceBlockers()['feed-authority-producer'],1);
  assert.equal((await f.controller.close(5)).localSettled,false);
 }finally{release.release();}
 await assert.rejects(original,/closing|held/);assert.equal((await f.controller.close(1000)).localSettled,true);
 await assert.rejects(automatic.advance(f.owner),/held|closing/);assert.equal(f.gateway.nativeCalls.length,0);
}));
