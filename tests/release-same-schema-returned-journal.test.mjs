import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {returnedRehearsalRequestSchema,returnedStorageAdmissionSchema} from '../scripts/release-delivery-continuation.mjs';
import {completionBranch,completionGrantKind,completionValues,completedRehearsalTransport,verifyReturnedReservation} from '../scripts/release-delivery-returned-rehearsal.mjs';
import {fullHostImplementation} from '../scripts/release-delivery-full-host.mjs';
import {returnedRosterSchema} from '../scripts/release-same-schema-returned-proof.mjs';

const digest='a'.repeat(64);
const ref={path:resolve('sample-rehearsal.json'),sha256:digest};
const operationId=randomUUID(), descriptor={operation:{id:operationId}};

test('same-schema reconciliation binds both original observers, the real diagnostic, a reviewed remaining budget and the exact roster',()=>{
  const side={root:resolve('source'),repository:'owner/application',branch:completionBranch,commit:'b'.repeat(40)};
  const attempt={launcher:ref,intent:ref,exit:ref,childResult:ref,stdout:ref};
  const roster=Object.fromEntries(Object.keys(returnedRosterSchema.shape).map(n=>[n,{bytes:100,sha256:digest}]));
  const request={format:1,kind:'nova-same-schema-returned-rehearsal-request',operationId,historical:{root:resolve('source'),manifest:ref},
    operatorSources:{private:side,public:side},ciRuns:{private:1,public:2},owner:{request:ref,attempts:[attempt,attempt],resumeSession:ref},
    diagnostic:ref,remainingBudget:ref,remainingBudgetReview:ref,roster};
  assert.equal(Object.keys(roster).length,17);
  assert.doesNotThrow(()=>returnedRehearsalRequestSchema.parse(request));
  for(const mutate of [
    q=>q.predecessorGrantSha256=digest,q=>q.durationMs=3600000,q=>delete q.diagnostic,
    q=>delete q.remainingBudget,q=>delete q.remainingBudgetReview,q=>delete q.owner.resumeSession,
    q=>q.owner.attempts.pop(),q=>q.operatorSources.public.branch='main',q=>delete q.roster['startup-2-ready.json'],
    q=>q.roster['startup-1-capture-writer.json']={bytes:50,sha256:digest},
  ]){
    const changed=structuredClone(request);mutate(changed);assert.throws(()=>returnedRehearsalRequestSchema.parse(changed));
  }
});

test('the reserve and the prior capacity keep their original implementation, signed selection and execution key',()=>{
  const impl=fullHostImplementation(),key=randomUUID(),capacity={values:{unit:'original'},plan:{logSha256:digest}},signed={candidateId:digest};
  const phases={capacity:{state:'completed',input:{implementationSha256:impl},current:{output:capacity}},
    recovery:{key,input:{implementationSha256:impl,capacity,signed}},sign:{current:{output:signed}}};
  const observe=state=>completionValues({deliveryPhase:(_id,n)=>state[n]},operationId);
  assert.equal(observe(phases).planUnit,'original');
  for(const mutate of [p=>p.capacity.state='uncertain',p=>p.capacity.input.implementationSha256='c'.repeat(64),
    p=>p.recovery.input.signed={candidateId:'d'.repeat(64)},p=>p.recovery.input.capacity={...capacity,values:{unit:'different'}}]){
    const changed=structuredClone(phases);mutate(changed);assert.throws(()=>observe(changed),/original-host-implementation/);
  }
});

test('an ordinary transport is unchanged and recovery cannot acquire a new execution key',()=>{
  const run=async()=>{throw Error('unexpected transport');};
  assert.equal(completedRehearsalTransport({journal:{deliveryOperatorContinuation:()=>null},descriptor,run}),run);
  const proof={kind:completionGrantKind,recovery:{key:randomUUID(),inputSha256:digest}};
  const context={journal:{deliveryOperatorContinuation:()=>({proof}),directory:join(resolve('fixture'),'original')},descriptor,
    intent:{key:randomUUID(),inputSha256:digest}};
  assert.throws(()=>verifyReturnedReservation(context),/original-reservation-changed/);
  context.intent={key:proof.recovery.key,inputSha256:'e'.repeat(64)};
  assert.throws(()=>verifyReturnedReservation(context),/original-reservation-changed/);
});

test('fresh storage admission is distinguished from the original dispatch and a publication admission',()=>{
  const admission={format:1,kind:'nova-returned-rehearsal-storage-admission',operationId,grantSha256:digest,dispatch:ref,session:ref,verifiedAtMs:1};
  assert.doesNotThrow(()=>returnedStorageAdmissionSchema.parse(admission));
  for(const mutate of [a=>a.kind='nova-publication-continuation-storage-admission',a=>delete a.dispatch,a=>delete a.session,a=>a.verifiedAtMs=-1]){
    const changed=structuredClone(admission);mutate(changed);assert.throws(()=>returnedStorageAdmissionSchema.parse(changed));
  }
});
