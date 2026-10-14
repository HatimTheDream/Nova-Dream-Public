import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ReleaseJournal } from '../scripts/release-coordinate.mjs';
import { ensureDeliverySchema } from '../scripts/release-delivery-journal.mjs';
import { deriveFailedDisposition, reconcileFailedDelivery, PREWRITE_PREREQUISITES } from '../scripts/release-delivery-disposition.mjs';
import { stepDelivery, deliveryExitCode } from '../scripts/release-deliver.mjs';
import { sha256 } from '../scripts/release-plan.mjs';
import { validateFrontendValidityPeriod } from '../scripts/frontend-contract.mjs';

const schema = readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8')
  .match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}',String(0x4e56524c));
const encode=v=>Buffer.from(JSON.stringify(v)+'\n'), now=Date.parse('2026-10-14T18:33:40.668Z');
function fixture(t,{state='failed',valid=false,later=false}={}) {
  const root=mkdtempSync(join(tmpdir(),'nova-failed-disposition-')),journal=Object.create(ReleaseJournal.prototype);
  journal.directory=root;journal.readOnly=false;journal.db=new DatabaseSync(join(root,'release.sqlite'));journal.db.exec(schema);
  t.after(()=>{journal.close();assert.equal(dirname(root),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});});
  const put=(name,v)=>{const path=join(root,name),raw=encode(v);writeFileSync(path,raw,{flag:'wx'});return {path,sha256:sha256(raw)};};
  const operation={id:randomUUID(),stage:'draft',candidateId:null,publicCandidateId:null,bundleSha256:null,helperHashes:null,
    priorCandidateId:sha256('prior'),workspaceEpoch:randomUUID(),version:'2.3.5',buildVersion:'1.0.292',agentVersion:'2026.9.8',priorAgentVersion:'2026.9.8',
    sourceCommits:{private:'a'.repeat(40),public:'b'.repeat(40)},trustedPublicKeySha256:sha256('key'),changeClass:'presentation'};
  const timeline={startedAtMs:now-1000,original:{id:randomUUID(),step:'total',issuedAtMs:now-1000,remainingMs:[600000,1200000],confidence:'low',
    basis:'Synthetic failure fixture.',reason:'Retain original deadline.',nextCheckpointAtMs:now+299000},revisions:[],reviews:[],lastCheckpointAtMs:now-1000};
  const descriptor={format:1,operation,target:put('target.json',{fixtureOnly:true}),targetIdentity:sha256('target'),adapterIdentity:sha256('registry'),timeline,
    sources:Object.fromEntries(['private','public'].map((side,i)=>[side,{root:'/'+side,repository:'Example/'+side,commit:operation.sourceCommits[side],baseCommit:(i?'d':'c').repeat(40),branch:'main'}]))};
  journal.initializeDelivery(descriptor,now-1000);
  const route={route:'frontend',targetCandidateId:sha256('candidate'),baseCandidateId:operation.priorCandidateId};
  for(const phase of PREWRITE_PREREQUISITES){const intent=journal.reserveDeliveryPhase(operation.id,phase,{fixtureOnly:phase},now);
    journal.recordDeliveryObservation(operation.id,phase,{key:intent.intent.key,state:'completed',reason:'synthetic-complete',externalId:null,
      receipt:put(phase+'.json',{syntheticExternal:true,phase}),output:phase==='route'?route:{phase,syntheticExternal:true}},now);}
  const input={route,artifact:{syntheticExternal:true},base:{syntheticExternal:true},options:{createdAt:'2026-10-14T18:23:20.234Z',expiresAt:valid?'2026-10-21T18:23:20.234Z':'2026-10-21T18:23:20.234900Z'}};
  const failed=journal.reserveDeliveryPhase(operation.id,'package',input,now).intent;
  if(later) journal.reserveDeliveryPhase(operation.id,'sign',{fixtureOnly:true},now);
  journal.recordDeliveryObservation(operation.id,'package',{key:failed.key,state,reason:'producer-verification-rejected',externalId:null,receipt:null,output:{verificationFailed:true,originalKey:failed.key}},now,
    state==='failed'?{rejectedObservation:{state:'uncertain',reason:'producer-response-unavailable',externalId:null,receipt:null,output:null}}:{});
  const checked=[];
  const registry={identity:async()=>descriptor.adapterIdentity,targetIdentity:async()=>descriptor.targetIdentity,
    adapter:phase=>({validate:async()=>checked.push(phase+':validate'),verify:async()=>checked.push(phase+':verify'),execute:async()=>{throw Error('No effects permitted');},observe:async()=>{throw Error('No polling permitted');}})};
  return {root,journal,id:operation.id,descriptor,input,failed,put,registry,checked};
}

test('actual 2.3.5 noncanonical timestamp pattern closes only after fixed read-only reconciliation',async t=>{
  const f=fixture(t),before=f.journal.deliveryPhase(f.id,'package'),history=f.journal.db.prepare('SELECT * FROM delivery_observations WHERE operation_id=?').all(f.id);
  assert.throws(()=>validateFrontendValidityPeriod(f.input.options.createdAt,f.input.options.expiresAt),/Invalid frontend validity period/);
  const successor=structuredClone(f.descriptor);successor.operation.id=randomUUID();
  assert.throws(()=>f.journal.initializeDelivery(successor,now),/UNIQUE/);
  const result=await reconcileFailedDelivery(f.journal,f.id,f.registry,{clock:()=>now+1});
  assert.equal(result.closed,true);assert.equal(result.complete,false);assert.equal(result.disposition.proof.automaticReplayPermitted,false);
  assert.equal(result.disposition.proof.failure.canonicalExpiresAt,'2026-10-21T18:23:20.234Z');
  assert.equal(result.originalDeadlineAtMs,f.descriptor.timeline.original.issuedAtMs+1200000);
  assert.deepEqual(f.journal.deliveryPhase(f.id,'package'),before);
  assert.deepEqual(f.journal.db.prepare('SELECT * FROM delivery_observations WHERE operation_id=?').all(f.id),history);
  assert.equal(f.checked.length,13);assert.equal(f.journal.initializeDelivery(successor,now+2).operationId,successor.operation.id);
  assert.equal((await stepDelivery(f.journal,f.id,{identity:()=>{throw Error('must not resume closed delivery');}},{clock:()=>now+3})).closed,true);
  const count=f.checked.length;assert.equal((await reconcileFailedDelivery(f.journal,f.id,f.registry,{clock:()=>now+4})).closed,true);assert.equal(f.checked.length,count);
  assert.equal(deliveryExitCode('reconcile-failure',result),0);assert.equal(deliveryExitCode('resume',result),2);
  assert.throws(()=>f.journal.reserveDeliveryPhase(f.id,'sign',{},now+5),/reconciled/);
  assert.throws(()=>f.journal.db.prepare("UPDATE delivery_dispositions SET proof_json='{}' WHERE operation_id=?").run(f.id),/immutable/);
  assert.throws(()=>f.journal.db.prepare('DELETE FROM delivery_dispositions WHERE operation_id=?').run(f.id),/immutable/);
});

test('partial local outputs, later reservations and lost responses cannot free the target',async t=>{
  for(const scenario of ['package','signature','later','uncertain','valid-input'])await t.test(scenario,async t=>{
    const f=fixture(t,{later:scenario==='later',state:scenario==='uncertain'?'uncertain':'failed',valid:scenario==='valid-input'});
    if(scenario==='package')mkdirSync(join(f.root,'delivery-package-'+f.failed.key));
    if(scenario==='signature')writeFileSync(join(f.root,'delivery-signature-unaccounted.sig'),'partial');
    await assert.rejects(reconcileFailedDelivery(f.journal,f.id,f.registry,{clock:()=>now+1}),/disposition-/);
    assert.equal(f.journal.deliveryDisposition(f.id),null);assert.equal(f.journal.loadDelivery(f.id).state,'active');
    assert.equal(f.checked.length,0);
  });
});

test('corrupt prerequisite, changed graph and failed verification preserve the original lock',async t=>{
  for(const scenario of ['receipt','graph','verification','target'])await t.test(scenario,async t=>{
    const f=fixture(t);
    if(scenario==='receipt')writeFileSync(f.journal.deliveryPhase(f.id,'private-ci').current.receipt.path,'corrupt');
    if(scenario==='graph')f.registry.identity=async()=>sha256('changed');
    if(scenario==='target')f.registry.targetIdentity=async()=>sha256('changed');
    if(scenario==='verification')f.registry.adapter=()=>({validate:async()=>{},verify:async()=>{throw Error('actual-ci-not-verified');}});
    await assert.rejects(reconcileFailedDelivery(f.journal,f.id,f.registry,{clock:()=>now+1}));
    assert.equal(f.journal.deliveryDisposition(f.id),null);
  });
});

test('effect claim, original coordinator and late partial output prevent closure',async t=>{
  for(const scenario of ['completed-claim','coordinator','late-output'])await t.test(scenario,async t=>{
    const f=fixture(t);
    if(scenario==='completed-claim') f.journal.recordDeliveryObservation(f.id,'package',{key:f.failed.key,state:'failed',reason:'producer-verification-rejected',externalId:null,receipt:null,output:{verificationFailed:true}},now+1,
      {rejectedObservation:{state:'completed',reason:'synthetic-effect-claim',externalId:'claimed-effect',receipt:null,output:{frontendId:sha256('claimed')}}});
    if(scenario==='coordinator')f.journal.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(f.id,sha256('id'),'{}',sha256('{}'),sha256('{}'),now);
    if(scenario==='late-output'){const original=f.registry.adapter;f.registry.adapter=phase=>{const a=original(phase);if(phase==='package')a.validate=async()=>mkdirSync(join(f.root,'delivery-package-'+f.failed.key));return a;};}
    await assert.rejects(reconcileFailedDelivery(f.journal,f.id,f.registry,{clock:()=>now+2}),/disposition-/);
    assert.equal(f.journal.deliveryDisposition(f.id),null);
  });
});

test('stale or changed disposition evidence cannot commit and migration preserves version-one history',t=>{
  const f=fixture(t),proof=deriveFailedDisposition(f.journal,f.id,now+1);
  assert.throws(()=>f.journal.recordFailedDeliveryDisposition(f.id,{...proof,inputSha256:sha256('other')},now+2),/evidence-changed/);
  assert.throws(()=>f.journal.recordFailedDeliveryDisposition(f.id,proof,now+60002),/stale/);
  const history=f.journal.db.prepare('SELECT * FROM delivery_phases WHERE operation_id=?').all(f.id);
  f.journal.db.exec('DROP TRIGGER delivery_dispositions_no_update; DROP TRIGGER delivery_dispositions_no_delete; DROP TABLE delivery_dispositions; DROP INDEX delivery_active_target; CREATE UNIQUE INDEX delivery_active_target ON deliveries(target_identity) WHERE state<>\'completed\';');
  assert.equal(f.journal.deliveryDisposition(f.id),null);ensureDeliverySchema(f.journal);
  assert.deepEqual(f.journal.db.prepare('SELECT * FROM delivery_phases WHERE operation_id=?').all(f.id),history);
  assert.equal(f.journal.db.prepare('PRAGMA user_version').get().user_version,1);
  assert.match(f.journal.db.prepare("SELECT sql FROM sqlite_master WHERE name='delivery_active_target'").get().sql,/reconciled-failed/);
  assert.equal(f.journal.loadDelivery(f.id).state,'active');
});

test('standalone coordinator excludes active delivery but recognizes a proven closed failure',async t=>{
  const f=fixture(t),id=randomUUID();
  // Only the coordinator's loaded immutable input is synthetic. Its real planner,
  // SQLite exclusion query and all later prerequisite guards still execute.
  f.journal.load=()=>({input:{format:1,operation:{...f.descriptor.operation,id},timeline:f.descriptor.timeline,evidence:{}},
    report:undefined,adapter:{scopeIdentity:f.descriptor.targetIdentity}});
  assert.throws(()=>f.journal.reserveInstall(id,now+1),/target-delivery-already-active/);
  await reconcileFailedDelivery(f.journal,f.id,f.registry,{clock:()=>now+2});
  assert.throws(()=>f.journal.reserveInstall(id,now+3),/install-prerequisites-unverified/);
  assert.throws(()=>f.journal.reserveInstall(f.id,now+3),/delivery-operation-reconciled/);
  assert.equal(f.journal.intent(id),null);
  assert.throws(()=>f.journal.recordDeliveryRevalidation(f.id,'route',{state:'passed',reason:'late-review'},now+3),/reconciled/);
  assert.throws(()=>f.journal.checkpointDelivery(f.id,f.descriptor.timeline,now+3),/reconciled/);
});
