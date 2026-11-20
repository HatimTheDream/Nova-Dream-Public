import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../scripts/release-plan.mjs';
import {DEFERRED_CAPTURE_STARTUP_SOURCES,DEFERRED_CAPTURE_STARTUP_HELPERS,
  verifyStartupRetainedProjection} from '../scripts/release-delivery-startup-retained.mjs';
import {startupCommandFixture} from '../support/startup-command-fixture.mjs';

const digest=v=>sha256(Buffer.from(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?
  Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)));
const ref=(path,sha=sha256(path))=>({path,sha256:sha,bytes:123});

function projection(t){
  const {proof}=startupCommandFixture(t,{sameSchema60:true,sources:DEFERRED_CAPTURE_STARTUP_SOURCES});
  const binding=proof.qualificationBinding;
  assert.deepEqual(binding.helpers,DEFERRED_CAPTURE_STARTUP_HELPERS);
  proof.deferredCaptureHistory={kind:'signed-prior-capture-windows',priorCandidateId:binding.prior.candidateId,
    epoch:binding.workspaceEpoch,sourceManifestSha256:proof.references.baselineManifest.sha256,
    sourceEvidenceSha256:sha256('original references'),sourceRolesSha256:sha256('original roles'),
    windows:{'target-first-start':[1,2],'target-restart':[4,5]}};
  for(const [name,file] of [['parent','parent-verified.json'],['preservation','attempt-1/preservation.json'],
    ['proof','attempt-1/capture-continuity.json']])proof.references['capture-template/'+name]=ref('/original/'+file);
  for(const name of ['target-first-start','target-restart'])for(const role of ['started','process','ready','closed'])
    proof.references['capture-history/'+name+'/'+role]=ref('/original/'+name+'/'+role+'.json');
  for(const [i,scenario] of proof.scenarios.entries()){
    const attempt=i+1,physicalRoots=scenario.captureObservation.physicalRoots;
    delete scenario.captureObservation;
    const retained=Object.fromEntries((i===1?['before','closed']:['before','closed','writer']).map(role=>{
      const value=ref('/saved/attempt-'+attempt+'/startup-'+attempt+'-capture-'+role+'.json');
      proof.references[scenario.scenario+'/deferred/'+role]=value;
      return [role,value.sha256];
    }));
    const previous=i===1?proof.scenarios[0].captureDeferred:null;
    scenario.captureDeferred={kind:'closed-native-deferred-capture',attempt,candidateId:scenario.candidateId,
      workspaceEpoch:binding.workspaceEpoch,ordinaryWindow:[scenario.startedAtSeconds,scenario.closedAtSeconds],
      physicalRoots,baselineSha256:sha256('original baseline'),beforeRosterSha256:previous?.afterRosterSha256??sha256('pristine'),
      afterRosterSha256:sha256('roster '+attempt),beforeSha256:retained.before,closedSha256:retained.closed,
      writerFileSha256:retained.writer??null,addedCount:retained.writer?1:0,removedCount:1,
      historySha256:digest(proof.deferredCaptureHistory),partitionSha256:sha256('partition'),
      admissionsSha256:sha256('admissions'),closedCatalogSha256:sha256('catalog'),predecessorSha256:previous?.closedSha256??null};
  }
  return proof;
}

test('closed native capture projection requires authentic writer, restart continuity and separate pristine roots', t=>{
  const proof=projection(t),verify=p=>verifyStartupRetainedProjection(p,p.request);
  assert.equal(verify(proof),proof);
  for(const change of [
    p=>delete p.deferredCaptureHistory,
    p=>p.deferredCaptureHistory.sourceManifestSha256=sha256('changed'),
    p=>delete p.references['capture-history/target-restart/ready'],
    p=>p.scenarios[0].captureDeferred.writerFileSha256=null,
    p=>p.scenarios[1].captureDeferred.predecessorSha256=sha256('replayed'),
    p=>p.scenarios[1].captureDeferred.beforeRosterSha256=sha256('replaced between starts'),
    p=>p.scenarios[2].captureDeferred.physicalRoots=p.scenarios[0].captureDeferred.physicalRoots,
    p=>p.scenarios[2].captureTransition={},
    p=>delete p.references['pristine-prior-restoration/deferred/writer']]){
    const changed=structuredClone(proof);change(changed);assert.throws(()=>verify(changed));
  }
});

test('a pristine restore can use its original retired-only evidence after a measured deferred target restart', t=>{
  const proof=projection(t),scenario=proof.scenarios[2],old=scenario.captureDeferred;
  delete scenario.captureDeferred;
  for(const role of ['before','closed','writer'])delete proof.references[scenario.scenario+'/deferred/'+role];
  const hashes=['packetSha256','proofSha256','beforeSha256','closedSha256','writerSourcesSha256','baselineManifestSha256',
    'originsSha256','observationRefsSha256','authorityContextSha256','baselineInventorySha256','beforeLiveInventorySha256',
    'closedLiveInventorySha256','baselineClassificationSha256','beforeLiveClassificationSha256','closedLiveClassificationSha256',
    'baselinePartitionSha256','beforePartitionSha256','closedPartitionSha256','canonicalReportsSha256'];
  const outcome={...Object.fromEntries(hashes.map(k=>[k,sha256(k)])),kind:'closed-9.8-retired-capture-transition',
    attempt:3,candidateId:scenario.candidateId,workspaceEpoch:proof.qualificationBinding.workspaceEpoch,
    ordinaryWindow:old.ordinaryWindow,physicalRoots:old.physicalRoots,selectedRelative:'recovered-workspaces/11111111-1111-4111-8111-111111111111',
    predicateSha256:'df724c3ab3fcbfa53da4ec611603ababe0839c5a41900b606583ffe8a54b27a0',
    predecessorProofSha256:null,canonicalReportCount:1,unchangedCatalogEarlyReturn:false,canonicalFunctionObserved:true};
  outcome.beforeLiveInventorySha256=outcome.baselineInventorySha256;
  outcome.beforeLiveClassificationSha256=outcome.baselineClassificationSha256;
  scenario.captureTransition=outcome;
  for(const [role,name,key] of [['packet','capture-transition-packet','packetSha256'],['proof','capture-continuity','proofSha256'],
      ['before','capture-before','beforeSha256'],['closed','capture-closed','closedSha256']])
    proof.references[scenario.scenario+'/transition/'+role]=ref('/saved/attempt-3/'+name+'.json',outcome[key]);
  assert.equal(verifyStartupRetainedProjection(proof,proof.request),proof);
  outcome.physicalRoots=proof.scenarios[0].captureDeferred.physicalRoots;
  assert.throws(()=>verifyStartupRetainedProjection(proof,proof.request));
});
