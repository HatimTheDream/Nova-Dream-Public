import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../scripts/release-plan.mjs';
import { RETAINED_WINDOW_STARTUP_SOURCES } from '../scripts/release-delivery-startup-retained.mjs';
import { prepackageRequestSchema, prepackageGrantSchema } from '../scripts/release-delivery-continuation.mjs';
import { originalStartupFailure, startupCorrectionBranch, startupCorrectionGrant, startupCorrectionRequest,
  verifyOriginalStartupProgram, verifyCorrectedStartupProof } from '../scripts/release-delivery-startup-proof-correction.mjs';

const reason='actual-startup-proof-observation-unavailable';
const trace=['Traceback (most recent call last):','  File "<stdin>", line 6, in <module>',
  ...['invoke','consume','parked_seed_antecedent','read_split_warm_donor','need'].map(name=>'  File "fixed-startup-retained-consumer", line 12, in '+name),
  'RuntimeError: unrelated-or-unchanged-combined-helper',''].join('\n');
function fixture(t) {
  const journal={directory:mkdtempSync(join(tmpdir(),'startup-correction-'))}, id=randomUUID(), digest='1'.repeat(64);
  t.after(()=>rmSync(journal.directory,{recursive:true,force:true}));
  const dir=join(journal.directory,'delivery-evidence');mkdirSync(dir);
  const save=v=>{const raw=Buffer.from(JSON.stringify(v)+'\n'),hash=sha256(raw),path=join(dir,id+'-startup-failure-'+hash+'.json');
    writeFileSync(path,raw);return {path,sha256:hash};};
  const descriptor={operation:{id,version:'2.28.50',buildVersion:'1.0.423',changeClass:'application'}};
  const target={transport:{path:'fixture',sha256:digest},full:{host:{priorVersion:'2.28.39',priorBuildVersion:'1.0.412'},
    dependencyTransport:{format:6,startupQualification:{producer:{sha256:RETAINED_WINDOW_STARTUP_SOURCES['qualified-startup.py']}}}}};
  const raw={format:1,kind:'operator-startup-transport-failure',operationId:id,programSha256:digest,transport:target.transport,
    receivedAtMilliseconds:100,reason,exitCode:null,uncertain:true,diagnosticsTruncated:false,hostWrites:false,
    stdoutBytes:0,stdoutRawBase64:'',stdoutTruncated:false,stderrBytes:Buffer.byteLength(trace),stderrRawBase64:Buffer.from(trace).toString('base64'),stderrTruncated:false};
  const input={journal,descriptor,target,failure:save(raw),status:{kind:'nova-release-delivery-error',reason,automaticReplayPermitted:false},
    exit:{returnCode:1,finishedAtMilliseconds:102},closed:{originalChildClosed:true,returnCode:1,logBoundExceeded:false,automaticNewOperationPermitted:false},createdAt:90,now:110};
  return {input,raw,save};
}

test('startup proof correction admits only the complete original read-only traceback in its journal and time window',t=>{
  const {input,raw,save}=fixture(t);assert.deepEqual(originalStartupFailure(input),raw);
  for(const changed of [{operationId:randomUUID()},{reason:'other-refusal'},{diagnosticsTruncated:true},{stderrTruncated:true},
    {stdoutBytes:1},{stderrBytes:1},{exitCode:0},{hostWrites:true},{receivedAtMilliseconds:103},{receivedAtMilliseconds:89},
    {transport:{}},{stderrRawBase64:Buffer.from(trace.replace('read_split_warm_donor','unexpected_frame')).toString('base64')}]){
    assert.throws(()=>originalStartupFailure({...input,failure:save({...raw,...changed})}),/original-native-refusal/);
  }
  for(const changed of [{exit:{returnCode:2,finishedAtMilliseconds:102}},{closed:{...input.closed,originalChildClosed:false}},
    {status:{...input.status,reason:'other-refusal'}},{failure:{...input.failure,path:input.failure.path+'.other'}},
    {descriptor:{operation:{...input.descriptor.operation,version:'2.28.49'}}}]){
    assert.throws(()=>originalStartupFailure({...input,...changed}),/startup-correction-/);
  }
  assert.throws(()=>verifyOriginalStartupProgram([],input.journal.directory,{},raw,{sources:{private:{root:tmpdir()}}}),/historical-root-changed/);
  assert.throws(()=>verifyCorrectedStartupProof({...input,reference:input.failure,prior:{},since:0}),/proof-location-changed/);
});

test('typed startup request cannot replace a target, extend time, or reuse the dependency-correction branch',t=>{
  const {input}=fixture(t), ref=input.failure, root=input.journal.directory;
  const side={root,repository:'fixture',branch:startupCorrectionBranch,commit:'1'.repeat(40)};
  const request={format:1,kind:startupCorrectionRequest,operationId:input.descriptor.operation.id,
    owner:{request:ref,attempts:[{launcher:ref,intent:ref,exit:ref,childResult:ref,stdout:ref}]},historical:{root,manifest:ref},
    operatorSources:{private:side,public:side},ciRuns:{private:1,public:2},startupFailure:ref};
  assert.deepEqual(prepackageRequestSchema.parse(request),request);
  for(const changed of [{durationMs:3600000},{correction:{correctedNativeInput:ref}},{browserWindowPolicy:{}},{target:ref},
    {operatorSources:{...request.operatorSources,private:{...side,branch:'operator/prepackage-dependency-correction'}}}]){
    assert.equal(prepackageRequestSchema.safeParse({...request,...changed}).success,false);
  }
  const hash=ref.sha256;
  const proof={format:1,kind:startupCorrectionGrant,operationId:request.operationId,descriptorSha256:hash,targetIdentity:hash,
    originalAdapterIdentity:hash,originalTimelineSha256:hash,originalBudgetMs:30000,originalCreatedAtMs:100,snapshotSha256:hash,
    eventHighWaterMark:1,historySha256:hash,prerequisites:['private-source','public-source','private-ci','public-ci','artifacts','route'].map(phase=>({
      phase,key:randomUUID(),inputSha256:hash,observationSha256:hash})),request:ref,ownerPids:[11,12],
    operator:{adapterIdentity:hash,sources:request.operatorSources,sourceFiles:[{name:'fixture',sha256:hash}],ci:{private:ref,public:ref}},
    startupFailure:ref,startupProof:ref,hostFacts:ref,issuedAtMs:150,expiresAtMs:30100,automaticRenewal:false,originalHistoryPreserved:true};
  assert.deepEqual(prepackageGrantSchema.parse(proof),proof);
  for(const changed of [{expiresAtMs:30101},{issuedAtMs:99},{startupProof:undefined},{startupFailure:undefined},{correction:{}}]){
    assert.equal(prepackageGrantSchema.safeParse({...proof,...changed}).success,false);
  }
});
