import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha256} from '../scripts/release-plan.mjs';
import {runtimeAdmissionCapability,runtimeSourceRequestSchema,runtimeSourceImplementationIdentity,SETTLED_RUNTIME_GAP,verifyRetainedRuntimeSources} from '../scripts/release-delivery-runtime-qualification.mjs';

test('existing unchanged9.8 route remains separate; every runtime transition is closed',()=>{
 const base={fromVersion:'2026.9.8',toVersion:'2026.9.8',schemaVersion:55,apiVersion:1};
 assert.deepEqual(runtimeAdmissionCapability(base),{supported:true,runtimeRequired:false,gaps:[]});
 assert.deepEqual(runtimeAdmissionCapability({...base,fromVersion:'2026.9.6'}).gaps,[{code:SETTLED_RUNTIME_GAP}]);
 assert.equal(runtimeAdmissionCapability({...base,fromVersion:'2026.9.2',toVersion:'2026.9.6'}).gaps[0].code,'authenticated-runtime-producer-unavailable');
 for(const input of [{...base,toVersion:'2026.10.0'},{...base,schemaVersion:56},{...base,apiVersion:2}])assert.equal(runtimeAdmissionCapability(input).supported,false);
});
test('synthetic or manually asserted actual receipts cannot open admission',()=>{
 const input={fromVersion:'2026.9.6',toVersion:'2026.9.8',schemaVersion:55,apiVersion:1};
 for(const field of ['qualified','syntheticOnly','actualSettledQualification','productionAdmission','receipt'])assert.throws(()=>runtimeAdmissionCapability({...input,[field]:true}));
 assert.equal(runtimeSourceRequestSchema.safeParse({...input,format:1,productionAdmission:true}).success,false);
});
test('source consumer implementation closure is explicit and deterministic',()=>{
 const result=runtimeSourceImplementationIdentity();assert.deepEqual(Object.keys(result).sort(),['release-ci-primitives.py','release-delivery-ci.py','release-runtime-qualification.py']);
 for(const hash of Object.values(result))assert.match(hash,/^[a-f0-9]{64}$/);
 assert.deepEqual(runtimeSourceImplementationIdentity(),result);
});
test('read-only command binds original request and rejects false production admission',async t=>{
 const root=mkdtempSync(join(tmpdir(),'nova-runtime-transport-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(name,raw)=>{const path=join(root,name);writeFileSync(path,raw);return{path,sha256:sha256(raw)};};
 const tool=put('fake-python',Buffer.from('test executable reference; never launched')),zip=put('zip',Buffer.from('test only'));
 const request={format:1,kind:'retained-runtime-source-evidence',build:{sourceCommit:'a'.repeat(40),runId:1,runAttempt:1,artifactId:2,zip},synthetic:{sourceCommit:'b'.repeat(40),runId:3,runAttempt:1,artifactId:4,zip},tools:{python:tool,git:tool,gitExecPath:root},helperHashes:runtimeSourceImplementationIdentity(),independentVerifier:null};
 const reference=put('request.json',Buffer.from(JSON.stringify(request))),calls=[];
 const run=async(executable,args,options)=>{calls.push({executable,args,options});return JSON.stringify({state:'gap',reason:'authenticated-runtime-artifact-unavailable',sourceEvidenceVerified:false,productionAdmission:false,readOnly:true,hostEffects:false});};
 assert.equal((await verifyRetainedRuntimeSources({request:reference,run})).state,'gap');assert.equal(calls.length,1);
 assert.equal(calls[0].executable,tool.path);assert.deepEqual(calls[0].args.slice(-4),['--request',reference.path,'--request-sha256',reference.sha256]);
 assert.equal(calls[0].options.timeoutMs,240000);
 await assert.rejects(verifyRetainedRuntimeSources({request:reference,run:async()=>JSON.stringify({state:'completed',productionAdmission:true,readOnly:true,hostEffects:false})}),/result-invalid/);
});
