import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerifiedUpdateRelease } from '../apps/service/update-feed.js';
import { UpdateSupervisor, type HostUpdateJob, type Installer, type UpdateJournal } from '../apps/service/update-supervisor.js';
import { FileUpdateJournal, updateJournalLimits, writeUpdateJson } from '../apps/service/update-storage.js';

const from='a'.repeat(64),target='b'.repeat(64),epoch=randomUUID();
const release:VerifiedUpdateRelease={candidateId:target,fromCandidateId:from,novaVersion:'1.13.0',agentVersion:'2026.9.2',platform:'linux',arch:'x64',nodeMajor:24,notes:['Reviewed update'],compatibility:{reviewed:true,gatewayProtocol:4,fromNovaVersion:'1.12.11',fromAgentVersion:'2026.9.2',fromSchemaVersion:55,toSchemaVersion:55,pluginVersion:'1.13.0'},recovery:{pairedSnapshot:true,independentRestore:true,readinessTimeoutSeconds:120},bundle:{url:'https://example.test/bundle.json',bytes:2048,sha256:'c'.repeat(64),runnerSha256:'d'.repeat(64)},manifestSequence:1,manifestExpiresAt:9999999};
function saved(patch:Partial<HostUpdateJob>={}):HostUpdateJob{return {id:randomUUID(),candidateId:target,fromCandidateId:from,epoch,idempotencyKey:randomUUID(),when:'now',hold:false,started:false,prepared:false,state:'waiting',requestedAt:1,updatedAt:1,release:structuredClone(release),...patch};}
function memory(initial?:HostUpdateJob):UpdateJournal{
  let current=initial;const jobs=new Map(initial?[[initial.idempotencyKey,initial]]:[]);
  return {current:()=>current&&structuredClone(current),find:key=>{const job=jobs.get(key);return job&&structuredClone(job);},save:job=>{current=structuredClone(job);jobs.set(job.idempotencyKey,current);}};
}
function deferred(){let resolve!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(journal=memory(), overrides:Partial<Installer>={}){
  let verified=true,checking=false;
  let installed=from,preparations=0,preflights=0,runs=0,reconciles=0,clock=1000;
  const installer:Installer={prepare:async(_release,progress)=>{preparations++;progress(2048,2048);},preflight:async()=>{preflights++;},run:async()=>{runs++;installed=target;return 'completed';},reconcile:async()=>{reconciles++;return undefined;},...overrides};
  const feed={status:()=>({availability:checking?'checking' as const:verified?'available' as const:'unavailable' as const}),check:async()=>({availability:'available' as const}),verifiedRelease:(id:string)=>verified&&id===target?structuredClone(release):undefined};
  const supervisor=new UpdateSupervisor(feed,journal,installer,()=>installed,()=>clock);
  const beat=(heldFor:string|null=null,blockers:{code:string;message:string}[]=[])=>supervisor.beat({candidateId:installed,epoch,heldFor,nativeSuspended:!!heldFor,blockers});
  const input=(key=randomUUID())=>({epoch,candidateId:target,currentCandidateId:installed,idempotencyKey:key,when:'now' as const});
  return {supervisor,journal,beat,input,verification:(valid:boolean,refreshing=false)=>{verified=valid;checking=refreshing;},setInstalled:(id:string)=>{installed=id;},advance:(delta=1000)=>{clock+=delta;},preparations:()=>preparations,preflights:()=>preflights,runs:()=>runs,reconciles:()=>reconciles};
}

test('clock rollback cannot turn an older heartbeat into fresh installation authority',async()=>{
 const f=fixture();f.beat();f.advance(-1);
 await assert.rejects(f.supervisor.request(f.input()),/Refresh Software Update/);
 assert.equal(f.supervisor.view().blocker?.code,'workspace_unknown');assert.equal(f.runs(),0);
});

test('read-only preflight qualifies the exact prior workspace before maintenance is requested',async()=>{
  const waiting=deferred(),calls:{candidateId:string;workspaceEpoch:string;jobId:string}[]=[];
  const f=fixture(memory(),{preflight:async(candidate,jobId,prior)=>{
    assert.deepEqual(candidate,release);calls.push({...prior,jobId});await waiting.promise;
  }});
  f.beat();await f.supervisor.request(f.input());
  await new Promise(resolve=>setImmediate(resolve));
  const job=f.journal.current()!;
  assert.deepEqual(calls,[{candidateId:from,workspaceEpoch:epoch,jobId:job.id}]);
  assert.equal(job.started,false);assert.equal(job.hold,false);assert.equal(f.runs(),0);
  waiting.resolve();await f.supervisor.settle();
  assert.equal(f.supervisor.view().holdFor,job.id);assert.equal(f.runs(),0);
});

test('missing qualified recovery refuses preparation without holding work or starting an attempt',async()=>{
  let checks=0;
  const f=fixture(memory(),{preflight:async()=>{checks++;throw Error('The recovery baseline is not paired with the installed candidate.');}});
  f.beat();const input=f.input();await f.supervisor.request(input);await f.supervisor.settle();
  const job=f.journal.current()!;
  assert.equal(job.state,'failed');assert.equal(job.started,false);assert.equal(job.hold,false);
  assert.equal(f.runs(),0);assert.equal(f.reconciles(),0);
  assert.match(job.message!,/Nothing was installed/);assert.doesNotMatch(job.message!,/baseline|candidate/);
  const replay=await f.supervisor.request(input);await f.supervisor.settle();
  assert.equal(replay.job?.id,job.id);assert.equal(checks,1,'Same-key replay retains the original refusal.');
});

test('a lost read-only preflight response never authorizes a switch or requests maintenance',async()=>{
  const f=fixture(memory(),{preflight:async()=>{throw Error('Preflight response was lost');}});
  f.beat();await f.supervisor.request(f.input());await f.supervisor.settle();
  assert.equal(f.supervisor.view().job?.state,'failed');assert.equal(f.supervisor.view().holdFor,null);
  assert.equal(f.journal.current()?.started,false);assert.equal(f.runs(),0);
});

test('admission is rechecked for an unstarted held job after a controller restart',async()=>{
  const job=saved({state:'waiting',hold:true,prepared:true});let checks=0;
  const f=fixture(memory(job),{preflight:async()=>{checks++;throw Error('Host configuration changed');}});
  f.beat(job.id);await f.supervisor.settle();
  assert.equal(checks,1);assert.equal(f.runs(),0);assert.equal(f.reconciles(),0);
  assert.equal(f.supervisor.view().holdFor,null);assert.equal(f.journal.current()?.started,false);
});

test('preflight is not reused after acquiring maintenance',async()=>{
  const f=fixture();f.beat();await f.supervisor.request(f.input());await f.supervisor.settle();
  assert.equal(f.preflights(),1);assert.equal(f.runs(),0);
  f.beat(f.supervisor.view().job!.id);await f.supervisor.settle();
  assert.equal(f.preflights(),2);assert.equal(f.runs(),1);assert.equal(f.supervisor.view().job?.state,'completed');
});

test('execution is bound to the original job workspace even after read-only admission succeeds',async()=>{
  let captured:{candidateId:string;workspaceEpoch:string}|undefined;
  const f=fixture(memory(),{run:async(_release,_job,_phase,prior)=>{captured=prior;throw Error('Workspace changed after preflight; actual runner refuses');}});
  f.beat();await f.supervisor.request(f.input());await f.supervisor.settle();
  const job=f.supervisor.view().job!;f.beat(job.id);await f.supervisor.settle();
  assert.deepEqual(captured,{candidateId:from,workspaceEpoch:epoch});
  assert.equal(f.supervisor.view().holdFor,job.id);assert.equal(f.supervisor.view().job?.state,'failed');
});

test('stale, switched or different-workspace heartbeats cannot inherit completed preflight authority',async()=>{
  for(const change of ['stale','candidate','workspace'] as const){
    const waiting=deferred(),f=fixture(memory(),{preflight:async()=>waiting.promise});
    f.beat();await f.supervisor.request(f.input());await new Promise(resolve=>setImmediate(resolve));
    if(change==='stale')f.advance(10000);
    if(change==='candidate')f.setInstalled('e'.repeat(64));
    if(change==='workspace')f.supervisor.beat({candidateId:from,epoch:randomUUID(),heldFor:null,nativeSuspended:false,blockers:[]});
    waiting.resolve();await f.supervisor.settle();
    assert.equal(f.supervisor.view().job?.state,'waiting',change);assert.equal(f.supervisor.view().holdFor,null,change);assert.equal(f.runs(),0,change);
  }
});

test('a refreshed matching heartbeat can qualify completion of a slow preflight',async()=>{
  const waiting=deferred(),f=fixture(memory(),{preflight:async()=>waiting.promise});
  f.beat();await f.supervisor.request(f.input());await new Promise(resolve=>setImmediate(resolve));
  f.advance(10000);f.beat();waiting.resolve();await f.supervisor.settle();
  assert.equal(f.supervisor.view().holdFor,f.supervisor.view().job?.id);assert.equal(f.runs(),0);
});

test('cancellation and lost release verification during preflight cannot acquire maintenance',async()=>{
  for(const change of ['cancel','verification','stop'] as const){
    const waiting=deferred(),f=fixture(memory(),{preflight:async()=>waiting.promise});
    f.beat();await f.supervisor.request(f.input());await new Promise(resolve=>setImmediate(resolve));
    if(change==='cancel')f.supervisor.cancel({epoch,jobId:f.supervisor.view().job!.id});
    if(change==='verification')f.verification(false);
    if(change==='stop')f.supervisor.stop();
    waiting.resolve();await f.supervisor.settle();
    assert.equal(f.supervisor.view().holdFor,null,change);assert.equal(f.runs(),0,change);
    if(change==='cancel')assert.equal(f.supervisor.view().job?.state,'cancelled');
  }
});

test('a lost response from a started runner retains maintenance even when the prior candidate remains selected',async()=>{
  let runs=0;
  const f=fixture(memory(),{run:async()=>{runs++;throw Error('Runner response lost before acceptance');},preflight:async()=>{assert.equal(runs,0,'Started work must reconcile without fresh preflight.');}});
  f.beat();const input=f.input();await f.supervisor.request(input);await f.supervisor.settle();
  const id=f.supervisor.view().job!.id;f.beat(id);await f.supervisor.settle();
  assert.equal(f.journal.current()?.started,true);assert.equal(f.supervisor.view().holdFor,id);assert.equal(runs,1);
  await f.supervisor.request(input);f.supervisor.poll();await f.supervisor.settle();
  assert.equal(runs,1);assert.equal(f.reconciles(),1);assert.equal(f.supervisor.view().holdFor,id);
});

test('runtime updates require the exact displayed release even when the app candidate stays unchanged',async()=>{
  const engine={...structuredClone(release),candidateId:from,agentVersion:'2026.9.6',runtimeBundle:{url:'https://example.test/runtime.tgz',bytes:100,sha256:'e'.repeat(64)}};
  const journal=memory(),supervisor=new UpdateSupervisor({status:()=>({availability:'available'}),check:async()=>({availability:'available'}),verifiedRelease:()=>structuredClone(engine)},journal,{prepare:async()=>{},preflight:async()=>{},run:async()=>assert.fail('No native hold was acquired'),reconcile:async()=>undefined},()=>from,()=>1000);
  supervisor.beat({candidateId:from,epoch,heldFor:null,nativeSuspended:false,blockers:[]});
  const input={epoch,candidateId:from,currentCandidateId:from,idempotencyKey:randomUUID(),when:'now'};
  await assert.rejects(supervisor.request(input),/available update changed/);
  await assert.rejects(supervisor.request({...input,releaseId:'f'.repeat(64)}),/available update changed/);
  const accepted=await supervisor.request({...input,releaseId:engine.bundle.sha256});await supervisor.settle();assert.equal(accepted.job?.releaseId,engine.bundle.sha256);
  await assert.rejects(supervisor.request({...input,releaseId:'f'.repeat(64)}),/different operation/);
  supervisor.stop();
});

test('dependency updates require an exact reviewed release and reject asset replacement during preflight',async()=>{
  const candidate={...structuredClone(release),applicationDependenciesBundle:{url:'https://example.test/app-dependencies.tgz',bytes:100,sha256:'e'.repeat(64)}};
  const journal=memory(),supervisor=new UpdateSupervisor({status:()=>({availability:'available'}),check:async()=>({availability:'available'}),verifiedRelease:()=>structuredClone(candidate)},journal,{prepare:async()=>{},preflight:async()=>{candidate.applicationDependenciesBundle.sha256='f'.repeat(64);},run:async()=>assert.fail('Changed dependencies cannot start installation'),reconcile:async()=>undefined},()=>from,()=>1000);
  supervisor.beat({candidateId:from,epoch,heldFor:null,nativeSuspended:false,blockers:[]});
  const input={epoch,candidateId:target,currentCandidateId:from,idempotencyKey:randomUUID(),when:'now'};
  await assert.rejects(supervisor.request(input),/available update changed/);
  await assert.rejects(supervisor.request({...input,releaseId:'f'.repeat(64)}),/available update changed/);
  await supervisor.request({...input,releaseId:candidate.bundle.sha256});await supervisor.settle();
  assert.equal(supervisor.view().holdFor,null);assert.equal(supervisor.view().job?.state,'failed');assert.equal(journal.current()?.started,false);
});

test('lost release verification releases an unstarted hold, while refresh remains pending',async()=>{
  const f=fixture();f.beat();await f.supervisor.request(f.input());await f.supervisor.settle();
  const id=f.supervisor.view().job!.id;assert.equal(f.supervisor.view().holdFor,id);
  f.verification(false,true);f.beat(id);await f.supervisor.settle();
  assert.equal(f.supervisor.view().holdFor,id);assert.equal(f.runs(),0);
  f.verification(false);f.supervisor.poll();await f.supervisor.settle();
  assert.equal(f.supervisor.view().holdFor,null);assert.equal(f.supervisor.view().job?.state,'failed');assert.equal(f.runs(),0);
});

test('controller shutdown during preparation cannot start installation afterwards',async()=>{
  const waiting=deferred(),f=fixture(memory(),{prepare:async()=>waiting.promise});f.beat();
  await f.supervisor.request(f.input());f.supervisor.stop();waiting.resolve();await f.supervisor.settle();
  assert.equal(f.supervisor.view().holdFor,null);assert.equal(f.runs(),0);
});

test('cancelled preparation drains before another receipt can be admitted',async()=>{
  const waiting=deferred(),f=fixture(memory(),{prepare:async()=>waiting.promise});f.beat();
  const first=f.input();await f.supervisor.request(first);const original=f.supervisor.view().job!;
  f.supervisor.cancel({epoch,jobId:original.id});
  assert.equal((await f.supervisor.request(first)).job?.state,'cancelled');
  await assert.rejects(f.supervisor.request(f.input()),/still settling/);
  waiting.reject(Error('Original download failed after cancellation'));await f.supervisor.settle();
  assert.equal(f.supervisor.view().job?.state,'cancelled');
  await f.supervisor.request(f.input());await f.supervisor.settle();
  assert.notEqual(f.supervisor.view().job?.id,original.id);
});

test('replayed receipts return their own job after newer attempts and after a version switch',async()=>{
  const f=fixture();f.beat();const first=f.input();await f.supervisor.request(first);await f.supervisor.settle();
  const original=f.supervisor.view().job!;f.supervisor.cancel({epoch,jobId:original.id});
  const second=f.input();await f.supervisor.request(second);await f.supervisor.settle();
  const active=f.supervisor.view().job!;
  assert.equal((await f.supervisor.request(first)).job?.id,original.id);
  assert.equal(f.supervisor.view().job?.id,active.id);
  f.beat(active.id);await f.supervisor.settle();assert.equal(f.runs(),1);
  const replay=await f.supervisor.request({...second,currentCandidateId:target});
  assert.equal(replay.job?.state,'completed');assert.equal(replay.job?.id,active.id);assert.equal(f.runs(),1);
  await assert.rejects(f.supervisor.request({...second,candidateId:'e'.repeat(64)}),/different operation/);
});

test('a last-chunk observation cannot replace verified preparation after restart',async()=>{
  const f=fixture(memory(saved({state:'downloading',download:{received:2048,total:2048}})));f.beat();await f.supervisor.settle();
  assert.equal(f.preparations(),1);assert.equal(f.journal.current()?.prepared,true);assert.equal(f.runs(),0);
  const job=f.supervisor.view().job!;f.beat(job.id);await f.supervisor.settle();assert.equal(f.runs(),1);
});

test('restart acceptance retains the hold until both receipt and actual selected candidate agree',async()=>{
  for(const outcome of ['completed','restored','unchanged'] as const){
    let result:typeof outcome|undefined;let readCount=0;
    const f=fixture(memory(saved({state:'checking',started:true,prepared:true,hold:true})),{reconcile:async()=>{readCount++;return result;},run:async()=>assert.fail('Restart reconciliation cannot launch another runner')});
    f.supervisor.poll();await f.supervisor.settle();assert.equal(f.supervisor.view().job?.state,'failed');assert.ok(f.supervisor.view().holdFor);
    const stamp=f.journal.current()!.updatedAt;f.advance();f.supervisor.poll();await f.supervisor.settle();assert.equal(f.journal.current()!.updatedAt,stamp,'Unchanged reads are not fresh progress.');
    result=outcome;f.setInstalled('e'.repeat(64));f.supervisor.poll();await f.supervisor.settle();assert.ok(f.supervisor.view().holdFor);
    f.setInstalled(outcome==='completed'?target:from);f.supervisor.poll();await f.supervisor.settle();
    assert.equal(f.supervisor.view().job?.state,outcome==='unchanged'?'failed':outcome);assert.equal(f.supervisor.view().holdFor,null);assert.ok(readCount>=4);assert.equal(f.runs(),0);
  }
});

test('verified unchanged preflight releases work and permits a fresh authorized retry',async()=>{
  const f=fixture(memory(),{run:async()=> 'unchanged'});f.beat();await f.supervisor.request(f.input());await f.supervisor.settle();const original=f.supervisor.view().job!;
  f.beat(original.id);await f.supervisor.settle();assert.equal(f.supervisor.view().job?.state,'failed');assert.equal(f.supervisor.view().holdFor,null);
  f.beat();await f.supervisor.request(f.input());await f.supervisor.settle();assert.notEqual(f.supervisor.view().job?.id,original.id);assert.equal(f.supervisor.view().job?.state,'waiting');
});

test('verified storage failures explain the blocker without claiming a restore or exposing host details',async()=>{
 const f=fixture(memory(),{run:async()=>({outcome:'unchanged',reasonCode:'insufficient_storage'})});f.beat();await f.supervisor.request(f.input());await f.supervisor.settle();
 const id=f.supervisor.view().job!.id;f.beat(id);await f.supervisor.settle();
 assert.equal(f.supervisor.view().holdFor,null);assert.match(f.supervisor.view().job!.message!,/not enough free storage/);assert.doesNotMatch(f.supervisor.view().job!.message!,/restored/);
});

test('a local hold alone cannot authorize installation without native suspension proof',async()=>{
 const f=fixture();f.beat();await f.supervisor.request(f.input());await f.supervisor.settle();const id=f.supervisor.view().job!.id;
 assert.equal(f.preflights(),1);
 f.supervisor.beat({candidateId:from,epoch,heldFor:id,nativeSuspended:false,blockers:[]});await f.supervisor.settle();assert.equal(f.runs(),0);assert.equal(f.preflights(),1,'Waiting for native suspension must not repeat expensive read-only inventories.');
 f.beat(id);await f.supervisor.settle();assert.equal(f.runs(),1);assert.equal(f.preflights(),2);
});

test('an uncertain durable save is adopted by same-key replay instead of launching a new request',async()=>{
  const persisted=memory();let throwAfterCommit=true;
  const journal:UpdateJournal={...persisted,save:job=>{persisted.save(job);if(throwAfterCommit){throwAfterCommit=false;throw Error('Directory flush acknowledgement lost');}}};
  const f=fixture(journal);f.beat();const input=f.input();await assert.rejects(f.supervisor.request(input),/acknowledgement lost/);
  const original=persisted.current()!;assert.equal(f.supervisor.view().job,undefined);
  const reply=await f.supervisor.request(input);await f.supervisor.settle();
  assert.equal(reply.job?.id,original.id);assert.equal(f.supervisor.view().job?.id,original.id);assert.equal(f.preparations(),1);
});

test('file journal commits current selection and all old receipts atomically',()=>{
  const directory=mkdtempSync(join(tmpdir(),'nova-update-journal-'));
  try{
    const journal=new FileUpdateJournal(directory),first=saved({state:'cancelled'}),second=saved({releaseId:release.bundle.sha256});journal.save(first);journal.save(second);
    assert.deepEqual(readdirSync(directory),['journal.json']);
    const reopened=new FileUpdateJournal(directory);assert.equal(reopened.current()?.id,second.id);assert.equal(reopened.current()?.releaseId,release.bundle.sha256);assert.equal(reopened.find(first.idempotencyKey)?.state,'cancelled');
    const before=readFileSync(join(directory,'journal.json'),'utf8');
    assert.throws(()=>journal.save({...first,candidateId:'e'.repeat(64)}));
    assert.equal(readFileSync(join(directory,'journal.json'),'utf8'),before);
    const full=Array.from({length:updateJournalLimits.receipts},()=>saved({state:'cancelled'}));
    writeUpdateJson(join(directory,'journal.json'),{format:1,currentId:full.at(-1)!.id,jobs:full});
    assert.throws(()=>journal.save(saved()));assert.equal(journal.find(full[0].idempotencyKey)?.id,full[0].id);
    writeFileSync(join(directory,'journal.json'),' '.repeat(updateJournalLimits.bytes+1));assert.throws(()=>journal.current(),/Invalid update state/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('durable dependency release receipts require their exact bundle identity',()=>{
  const directory=mkdtempSync(join(tmpdir(),'nova-update-journal-dependencies-'));
  try{
    const journal=new FileUpdateJournal(directory),job=saved({release:{...structuredClone(release),applicationDependenciesBundle:{url:'https://example.test/app-dependencies.tgz',bytes:100,sha256:'e'.repeat(64)}}});
    assert.throws(()=>journal.save(job),/saved release identity/);
    assert.throws(()=>journal.save({...job,releaseId:'f'.repeat(64)}),/saved release identity/);
    journal.save({...job,releaseId:job.release.bundle.sha256});
    const reopened=new FileUpdateJournal(directory);assert.deepEqual(reopened.current()?.release.applicationDependenciesBundle,job.release.applicationDependenciesBundle);
    assert.throws(()=>journal.save({...job,releaseId:job.release.bundle.sha256,release:{...job.release,applicationDependenciesBundle:{...job.release.applicationDependenciesBundle!,sha256:'f'.repeat(64)}}}),/original identity/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
