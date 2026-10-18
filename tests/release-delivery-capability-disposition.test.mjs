import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { join,dirname,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ReleaseJournal } from '../scripts/release-coordinate.mjs';
import { stepDelivery } from '../scripts/release-deliver.mjs';
import { ensureDeliverySchema } from '../scripts/release-delivery-journal.mjs';
import { PREWRITE_PREREQUISITES } from '../scripts/release-delivery-disposition.mjs';
import { CAPABILITY_GAP,deriveCapabilityDisposition,reconcileCapabilityGap,verifyHistoricalGraph,verifyCapabilityOwner,verifyRecoveryPredecessor,capabilityReadOnlyCommand } from '../scripts/release-delivery-capability-disposition.mjs';
import { sha256 } from '../scripts/release-plan.mjs';

const schema=readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8')
  .match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}',String(0x4e56524c));
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const now=Date.parse('2026-10-18T17:19:20Z');
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'nova-capability-gap-')),journal=Object.create(ReleaseJournal.prototype);
  journal.directory=root;journal.readOnly=false;journal.db=new DatabaseSync(join(root,'release.sqlite'));journal.db.exec(schema);
  t.after(()=>{journal.close();assert.equal(dirname(root),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});});
  const put=(name,value)=>{const path=join(root,name),raw=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n');writeFileSync(path,raw,{flag:'wx'});return{path,sha256:sha256(raw)};};
  mkdirSync(join(root,'historical','scripts'),{recursive:true});
  const source=put('historical/scripts/release-delivery-adapters.mjs',Buffer.from('// inert synthetic historical graph\n'));
  const rows=[{name:'release-delivery-adapters.mjs',sha256:source.sha256}],manifest=put('historical-graph.json',rows),node=put('node-fixture',Buffer.from('inert'));
  const operation={id:randomUUID(),stage:'draft',candidateId:null,publicCandidateId:null,bundleSha256:null,helperHashes:null,
    priorCandidateId:sha256('prior'),workspaceEpoch:randomUUID(),version:'2.8.0',buildVersion:'1.0.311',agentVersion:'2026.9.8',priorAgentVersion:'2026.9.8',
    sourceCommits:{private:'a'.repeat(40),public:'b'.repeat(40)},trustedPublicKeySha256:sha256('key'),changeClass:'application'};
  const timeline={startedAtMs:now-1000,original:{id:randomUUID(),step:'total',issuedAtMs:now-1000,remainingMs:[600000,1200000],confidence:'low',
    basis:'Synthetic capability fixture.',reason:'Retain original deadline.',nextCheckpointAtMs:now+299000},revisions:[],reviews:[],lastCheckpointAtMs:now-1000};
  const descriptor={format:1,operation,target:put('target.json',{artifactTools:{node}}),targetIdentity:sha256('target'),adapterIdentity:sha256(canonical(rows)),timeline,
    sources:Object.fromEntries(['private','public'].map((side,i)=>[side,{root:'/'+side,repository:'Example/'+side,commit:operation.sourceCommits[side],baseCommit:(i?'d':'c').repeat(40),branch:'main'}]))};
  journal.initializeDelivery(descriptor,now-1000);
  for(const phase of PREWRITE_PREREQUISITES){const intent=journal.reserveDeliveryPhase(operation.id,phase,{fixtureOnly:phase},now-500);
    journal.recordDeliveryObservation(operation.id,phase,{key:intent.intent.key,state:'completed',reason:'synthetic-complete',externalId:null,
      receipt:put(phase+'.json',{fixtureOnly:phase}),output:phase==='route'?{route:'full'}:{fixtureOnly:phase}},now-500);}
  const historical={root:join(root,'historical'),manifest};
  const launch={operationId:operation.id,pid:2147483000,launcherPid:2147483001,node,cwd:historical.root,
    argv:[node.path,join(historical.root,'scripts','release-deliver.mjs'),'resume',root,operation.id],startedAt:new Date(now-400).toISOString()};
  const completion={originalOperationId:operation.id,pid:launch.pid,outcome:'transport-returned',exitCode:2,deliverySuccessInferred:false,
    automaticReplayPermitted:false,processTerminationPerformed:false,completedAt:new Date(now-200).toISOString()};
  const stdout={operationId:operation.id,originalOperationPreserved:true,state:'release-pending',storageCloseoutPerformed:false,complete:false,
    release:{...journal.deliveryStatus(operation.id,now-200),acceptanceGap:CAPABILITY_GAP,integrationGaps:[CAPABILITY_GAP]}};
  const request={format:1,kind:'nova-delivery-capability-reconciliation',operationId:operation.id,historical,
    owner:{launched:put('launched.json',launch),completed:put('completed.json',completion),stdout:put('stdout.json',stdout)}};
  const requestRef=put('request.json',request),checks=[];
  const registry={identity:async()=>descriptor.adapterIdentity,targetIdentity:async()=>descriptor.targetIdentity,
    phasePreflight:async()=>{checks.push('gap');return[CAPABILITY_GAP];},adapter:phase=>({validate:async()=>checks.push(phase+':validate'),verify:async()=>checks.push(phase+':verify'),
      execute:()=>assert.fail('producer executed'),observe:()=>assert.fail('producer observed')})};
  const options={clock:()=>now,loadRegistry:async()=>registry,assertAbsent:pid=>checks.push('absent:'+pid)};
  return{root,journal,id:operation.id,descriptor,request,requestRef,registry,options,checks,put,launch,completion,stdout};
}

test('six completed real journal phases close truthfully without reserving a package or changing history',async t=>{
  const f=fixture(t),phases=f.journal.db.prepare('SELECT * FROM delivery_phases').all(),observations=f.journal.db.prepare('SELECT * FROM delivery_observations').all();
  const next=structuredClone(f.descriptor);next.operation.id=randomUUID();assert.throws(()=>f.journal.initializeDelivery(next,now),/UNIQUE/);
  const result=await reconcileCapabilityGap(f.journal,f.id,f.requestRef,f.options);
  assert.equal(result.closed,true);assert.equal(result.complete,false);assert.equal(result.disposition.proof.gap.reserved,false);
  assert.equal(f.journal.deliveryPhase(f.id,'package'),null);assert.deepEqual(f.journal.db.prepare('SELECT * FROM delivery_phases').all(),phases);
  assert.deepEqual(f.journal.db.prepare('SELECT * FROM delivery_observations').all(),observations);
  assert.equal(result.originalDeadlineAtMs,f.descriptor.timeline.original.issuedAtMs+1200000);
  assert.equal(f.checks.filter(x=>x.endsWith(':verify')).length,6);assert.equal(f.checks.filter(x=>x==='gap').length,1);
  assert.equal((await reconcileCapabilityGap(f.journal,f.id,f.requestRef,f.options)).disposition.sha256,result.disposition.sha256);
  assert.equal((await stepDelivery(f.journal,f.id,{identity:()=>assert.fail('closed operation consulted registry')})).closed,true);
  assert.throws(()=>f.journal.reserveDeliveryPhase(f.id,'package',{},now),/reconciled/);
  assert.throws(()=>f.journal.checkpointDelivery(f.id,f.descriptor.timeline,now),/reconciled/);
  assert.throws(()=>f.journal.recordDeliveryRevalidation(f.id,'route',{state:'passed',reason:'late-review'},now),/reconciled/);
  assert.throws(()=>f.journal.recordDeliveryObservation(f.id,'route',{...observations[0],key:randomUUID()}),/./);
  assert.equal(f.journal.initializeDelivery(next,now).operationId,next.operation.id);
  assert.throws(()=>f.journal.db.prepare("UPDATE delivery_dispositions SET proof_json='{}'").run(),/immutable/);
});

test('every downstream reservation or unexplained output keeps the original active',async t=>{
  for(const scenario of ['package','package/dependency-stage','sign','capacity','recovery','publication','installation','assistant','browser','unknown','coordinator','output'])await t.test(scenario,async t=>{
    const f=fixture(t);
    if(scenario==='coordinator')f.journal.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(f.id,sha256('id'),'{}',sha256('{}'),sha256('{}'),now);
    else if(scenario==='output')mkdirSync(join(f.root,'dependency-unknown'));
    else f.journal.db.prepare('INSERT INTO delivery_phases VALUES(?,?,?,?,?,?)').run(f.id,scenario,randomUUID(),'{}',sha256('{}'),now);
    await assert.rejects(reconcileCapabilityGap(f.journal,f.id,f.requestRef,f.options),/capability-/);
    assert.equal(f.journal.loadDelivery(f.id).state,'active');assert.equal(f.journal.deliveryDisposition(f.id),null);
  });
});

test('changed identities, missing gap and a different gap cannot close the operation',async t=>{
  for(const scenario of ['graph','target','receipt','registry','vanished','other','validation'])await t.test(scenario,async t=>{
    const f=fixture(t);
    if(scenario==='graph')writeFileSync(join(f.request.historical.root,'scripts','release-delivery-adapters.mjs'),'changed');
    if(scenario==='target')writeFileSync(f.descriptor.target.path,'{}');
    if(scenario==='receipt')writeFileSync(f.journal.deliveryPhase(f.id,'private-ci').current.receipt.path,'{}');
    if(scenario==='registry')f.registry.identity=async()=>sha256('new graph masquerading as old');
    if(scenario==='vanished')f.registry.phasePreflight=async()=>[];
    if(scenario==='other')f.registry.phasePreflight=async()=>['changed-schema-qualification-producer-required'];
    if(scenario==='validation')f.registry.adapter=()=>({validate:()=>{throw Error('retained-source-corrupt');},verify:()=>{}});
    await assert.rejects(reconcileCapabilityGap(f.journal,f.id,f.requestRef,f.options));assert.equal(f.journal.deliveryDisposition(f.id),null);
  });
});

test('terminal owner evidence binds actual argv, original PID and journal state',async t=>{
  for(const scenario of ['unknown','killed','wrongPid','wrongArgv','reportedPackage','livePid'])await t.test(scenario,async t=>{
    const f=fixture(t),request=structuredClone(f.request);
    if(scenario==='unknown')request.owner.completed=f.put('unknown.json',{...f.completion,outcome:'unknown',exitCode:null});
    if(scenario==='killed')request.owner.completed=f.put('killed.json',{...f.completion,processTerminationPerformed:true});
    if(scenario==='wrongPid')request.owner.completed=f.put('wrong-pid.json',{...f.completion,pid:123});
    if(scenario==='wrongArgv')request.owner.launched=f.put('wrong-argv.json',{...f.launch,argv:[...f.launch.argv.slice(0,2),'start',f.root,f.id]});
    if(scenario==='reportedPackage'){const v=structuredClone(f.stdout);v.release.phases.find(p=>p.phase==='package').key=randomUUID();request.owner.stdout=f.put('wrong-output.json',v);}
    if(scenario==='livePid'){const launch={...f.launch,pid:process.pid};request.owner.launched=f.put('live-launch.json',launch);request.owner.completed=f.put('live-complete.json',{...f.completion,pid:process.pid});}
    assert.throws(()=>verifyCapabilityOwner(request,f.journal,f.id,f.descriptor,scenario==='livePid'?{}:{assertAbsent:()=>{}}),/capability-/);
  });
});

test('transaction recheck refuses reservations and file changes after the read-only verifier',async t=>{
  for(const scenario of ['reservation','output','receipt','owner','timeline'])await t.test(scenario,async t=>{
    const f=fixture(t),record=f.journal.recordCapabilityDisposition.bind(f.journal);
    f.journal.recordCapabilityDisposition=(...args)=>{
      if(scenario==='reservation')f.journal.reserveDeliveryPhase(f.id,'package',{},now);
      if(scenario==='output')mkdirSync(join(f.root,'delivery-package-late'));
      if(scenario==='receipt')writeFileSync(f.request.owner.completed.path,'{}');
      if(scenario==='owner')args[3]={assertAbsent:()=>{throw Error('capability-original-owner-still-present');}};
      if(scenario==='timeline'){const value=structuredClone(f.descriptor.timeline);value.lastCheckpointAtMs=now;f.journal.checkpointDelivery(f.id,value,now);}
      return record(...args);
    };
    await assert.rejects(reconcileCapabilityGap(f.journal,f.id,f.requestRef,f.options));assert.equal(f.journal.loadDelivery(f.id).state,'active');
    assert.equal(f.journal.deliveryDisposition(f.id),null);
  });
});

test('new lineage requires the actual immutable gap disposition and keeps the accepted base',async t=>{
  const f=fixture(t),result=await reconcileCapabilityGap(f.journal,f.id,f.requestRef,f.options),proof=result.disposition.proof;
  const lineage={journalDirectory:f.root,operationId:f.id,descriptorSha256:proof.descriptorSha256,dispositionSha256:result.disposition.sha256,originalTimelineSha256:proof.originalTimelineSha256};
  const next={...f.descriptor.operation,id:randomUUID(),version:'2.8.1',buildVersion:'1.0.312',sourceCommits:{private:'e'.repeat(40),public:'f'.repeat(40)}};
  // Open an actual second SQLite connection; the production path validation is
  // independently tested by ReleaseJournal. This fixture owns its temp root.
  class OpenJournal{constructor(path){const j=Object.create(ReleaseJournal.prototype);j.directory=path;j.readOnly=true;j.db=new DatabaseSync(join(path,'release.sqlite'),{readOnly:true});return j;}}
  const opts={openJournal:OpenJournal,targetIdentity:f.descriptor.targetIdentity};
  assert.deepEqual(await verifyRecoveryPredecessor(lineage,next,opts),lineage);
  for(const bad of [{...next,id:f.id},{...next,priorCandidateId:sha256('wrong base')},{...next,workspaceEpoch:randomUUID()},{...next,version:'2.8.0'},{...next,version:'2.7.99'},{...next,sourceCommits:f.descriptor.operation.sourceCommits}])
    await assert.rejects(verifyRecoveryPredecessor(lineage,bad,opts),/capability-/);
  await assert.rejects(verifyRecoveryPredecessor({...lineage,dispositionSha256:sha256('invented')},next,opts),/capability-/);
  await assert.rejects(verifyRecoveryPredecessor(lineage,next,{...opts,targetIdentity:sha256('other host')}),/capability-/);
});

test('a commit failure rolls back both closure and disposition; closed gap blocks the coordinator',async t=>{
  const f=fixture(t);
  f.journal.db.exec("CREATE TRIGGER test_refuse_gap_event BEFORE INSERT ON delivery_events WHEN NEW.kind='capability-gap-reconciled' BEGIN SELECT RAISE(ABORT,'injected-commit-failure'); END;");
  await assert.rejects(reconcileCapabilityGap(f.journal,f.id,f.requestRef,f.options),/injected-commit-failure/);
  assert.equal(f.journal.loadDelivery(f.id).state,'active');assert.equal(f.journal.deliveryDisposition(f.id),null);
  f.journal.db.exec('DROP TRIGGER test_refuse_gap_event');await reconcileCapabilityGap(f.journal,f.id,f.requestRef,f.options);
  f.journal.load=()=>({input:{format:1,operation:f.descriptor.operation,timeline:f.descriptor.timeline,evidence:{}},report:undefined,adapter:{scopeIdentity:f.descriptor.targetIdentity}});
  assert.throws(()=>f.journal.reserveInstall(f.id,now+1),/delivery-operation-reconciled/);assert.equal(f.journal.intent(f.id),null);
});

test('historical local command boundary allows exact read-only Git argv and rejects effects or substitutions',t=>{
  const f=fixture(t),target={sourceTools:{git:{path:'pinned-git'},gitExecPath:'pinned-exec'}},calls=[];
  const command=capabilityReadOnlyCommand(target,f.descriptor,(...args)=>calls.push(args));
  command('pinned-git',['-C','/private','remote','get-url','--push','origin'],{gitExecPath:'pinned-exec'});
  assert.equal(calls.length,1);
  for(const [exe,args,options] of [['pinned-git',['-C','/private','push','origin','main'],{gitExecPath:'pinned-exec'}],
    ['python',['collector.py'],{}],['pinned-git',['-C','/other','remote','get-url','--push','origin'],{gitExecPath:'pinned-exec'}],
    ['pinned-git',['-C','/private','remote','get-url','--push','origin'],{gitExecPath:'changed'}],
    ['pinned-git',['-C','/private','-c','alias.x=!effect','x'],{gitExecPath:'pinned-exec'}]])
    assert.throws(()=>command(exe,args,options),/command-forbidden/);
  assert.equal(calls.length,1);
});

test('a legitimate checkpoint after original terminal output uses current review time without rewriting that output',async t=>{
  const f=fixture(t),bytes=readFileSync(f.request.owner.stdout.path),timeline=structuredClone(f.descriptor.timeline);
  timeline.lastCheckpointAtMs=now-100;
  f.journal.checkpointDelivery(f.id,timeline,now-100);
  assert.throws(()=>f.journal.deliveryStatus(f.id,Date.parse(f.completion.completedAt)),/timeline-time-invalid/);
  const result=await reconcileCapabilityGap(f.journal,f.id,f.requestRef,f.options);
  assert.equal(result.closed,true);assert.deepEqual(readFileSync(f.request.owner.stdout.path),bytes);
  assert.equal(result.disposition.proof.originalTimelineSha256,sha256(canonical(timeline)));
  assert.equal(result.originalDeadlineAtMs,f.descriptor.timeline.original.issuedAtMs+1200000);
});

test('old active-target index migrates additively and a stale proof cannot commit',t=>{
  const f=fixture(t),phases=f.journal.db.prepare('SELECT * FROM delivery_phases').all();
  f.journal.db.exec("DROP INDEX delivery_active_target; CREATE UNIQUE INDEX delivery_active_target ON deliveries(target_identity) WHERE state NOT IN ('completed','reconciled-failed');");
  ensureDeliverySchema(f.journal);assert.deepEqual(f.journal.db.prepare('SELECT * FROM delivery_phases').all(),phases);
  assert.match(f.journal.db.prepare("SELECT sql FROM sqlite_master WHERE name='delivery_active_target'").get().sql,/reconciled-gap/);
  const proof=deriveCapabilityDisposition(f.journal,f.id,f.requestRef,now,{assertAbsent:()=>{}});
  assert.throws(()=>f.journal.recordCapabilityDisposition(f.id,proof,now+60001,{assertAbsent:()=>{}}),/stale/);
  assert.equal(f.journal.deliveryDisposition(f.id),null);
  const bad=structuredClone(f.request);bad.historical.manifest=f.put('bad-graph.json',[{name:'../../escaped.mjs',sha256:sha256('absent')}]);
  assert.throws(()=>verifyHistoricalGraph(bad,f.descriptor),/escape/);
});
