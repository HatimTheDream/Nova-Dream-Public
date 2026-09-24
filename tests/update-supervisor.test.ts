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
  let installed=from,preparations=0,runs=0,reconciles=0,clock=1000;
  const installer:Installer={prepare:async(_release,progress)=>{preparations++;progress(2048,2048);},run:async()=>{runs++;installed=target;return 'completed';},reconcile:async()=>{reconciles++;return undefined;},...overrides};
  const feed={status:()=>({availability:checking?'checking' as const:verified?'available' as const:'unavailable' as const}),check:async()=>({availability:'available' as const}),verifiedRelease:(id:string)=>verified&&id===target?structuredClone(release):undefined};
  const supervisor=new UpdateSupervisor(feed,journal,installer,()=>installed,()=>clock);
  const beat=(heldFor:string|null=null,blockers:{code:string;message:string}[]=[])=>supervisor.beat({candidateId:installed,epoch,heldFor,nativeSuspended:!!heldFor,blockers});
  const input=(key=randomUUID())=>({epoch,candidateId:target,currentCandidateId:installed,idempotencyKey:key,when:'now' as const});
  return {supervisor,journal,beat,input,verification:(valid:boolean,refreshing=false)=>{verified=valid;checking=refreshing;},setInstalled:(id:string)=>{installed=id;},advance:(delta=1000)=>{clock+=delta;},preparations:()=>preparations,runs:()=>runs,reconciles:()=>reconciles};
}

test('clock rollback cannot turn an older heartbeat into fresh installation authority',async()=>{
 const f=fixture();f.beat();f.advance(-1);
 await assert.rejects(f.supervisor.request(f.input()),/Refresh Software Update/);
 assert.equal(f.supervisor.view().blocker?.code,'workspace_unknown');assert.equal(f.runs(),0);
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
 f.supervisor.beat({candidateId:from,epoch,heldFor:id,nativeSuspended:false,blockers:[]});await f.supervisor.settle();assert.equal(f.runs(),0);
 f.beat(id);await f.supervisor.settle();assert.equal(f.runs(),1);
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
    const journal=new FileUpdateJournal(directory),first=saved({state:'cancelled'}),second=saved();journal.save(first);journal.save(second);
    assert.deepEqual(readdirSync(directory),['journal.json']);
    const reopened=new FileUpdateJournal(directory);assert.equal(reopened.current()?.id,second.id);assert.equal(reopened.find(first.idempotencyKey)?.state,'cancelled');
    const before=readFileSync(join(directory,'journal.json'),'utf8');
    assert.throws(()=>journal.save({...first,candidateId:'e'.repeat(64)}));
    assert.equal(readFileSync(join(directory,'journal.json'),'utf8'),before);
    const full=Array.from({length:updateJournalLimits.receipts},()=>saved({state:'cancelled'}));
    writeUpdateJson(join(directory,'journal.json'),{format:1,currentId:full.at(-1)!.id,jobs:full});
    assert.throws(()=>journal.save(saved()));assert.equal(journal.find(full[0].idempotencyKey)?.id,full[0].id);
    writeFileSync(join(directory,'journal.json'),' '.repeat(updateJournalLimits.bytes+1));assert.throws(()=>journal.current(),/Invalid update state/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
