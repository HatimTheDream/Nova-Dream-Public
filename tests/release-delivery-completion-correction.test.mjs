import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join, resolve} from 'node:path';
import {completionRequestSchema} from '../scripts/release-delivery-continuation.mjs';
import {completionBranch, completionGrantKind, completionValues, completedRehearsalTransport, verifyReturnedReservation} from '../scripts/release-delivery-completion-correction.mjs';
import {fullHostImplementation} from '../scripts/release-delivery-full-host.mjs';
import {returnedRosterSchema} from '../scripts/release-returned-completion-proof.mjs';

const hash='a'.repeat(64), ref={path:resolve('specimen.json'),sha256:hash};
const operationId=randomUUID(), descriptor={operation:{id:operationId}};

test('a completion successor requires the predecessor, both original observers, independent roster and ledger',()=>{
 const side={root:resolve('source'),repository:'owner/application',branch:completionBranch,commit:'a'.repeat(40)};
 const attempt={launcher:ref,intent:ref,exit:ref,childResult:ref,stdout:ref};
 const roster=Object.fromEntries(Object.keys(returnedRosterSchema.shape).map(n=>[n,{bytes:100,sha256:hash}]));
 const request={format:1,kind:'nova-recovery-completion-request',operationId,historical:{root:resolve('source'),manifest:ref},
  operatorSources:{private:side,public:side},ciRuns:{private:1,public:2},owner:{request:ref,attempts:[attempt,attempt],resumeSession:ref},
  predecessorGrantSha256:hash,diagnostic:ref,publicationLedger:ref,roster};
 assert.doesNotThrow(()=>completionRequestSchema.parse(request));
 for(const change of [q=>delete q.publicationLedger,q=>delete q.predecessorGrantSha256,q=>delete q.diagnostic,q=>delete q.owner.resumeSession,
  q=>q.owner.attempts.pop(),q=>q.operatorSources.public.branch='main',q=>delete q.roster['startup-2-ready.json'],q=>q.durationMs=3600000]){
  const altered=structuredClone(request);change(altered);assert.throws(()=>completionRequestSchema.parse(altered));
 }
});

test('both reserved inputs must still select the exact stock implementation, signed target and prior capacity',()=>{
 const impl=fullHostImplementation(),key=randomUUID(),capacity={values:{unit:'original'},plan:{logSha256:hash}},signed={candidateId:hash};
 const phases={capacity:{state:'completed',input:{implementationSha256:impl},current:{output:capacity}},
  recovery:{key,input:{implementationSha256:impl,capacity,signed}},sign:{current:{output:signed}}};
 const observe=p=>completionValues({deliveryPhase:(_id,n)=>p[n]},operationId);
 assert.equal(observe(phases).planUnit,'original');
 for(const change of [p=>p.capacity.state='uncertain',p=>p.capacity.input.implementationSha256='b'.repeat(64),
  p=>p.recovery.input.implementationSha256='c'.repeat(64),p=>p.recovery.input.signed={candidateId:'e'.repeat(64)},
  p=>p.recovery.input.capacity={...capacity,values:{unit:'another'}}]){
  const p=structuredClone(phases);change(p);assert.throws(()=>observe(p),/original-host-implementation/);
 }
});

test('ordinary transports retain their implementation and a successor cannot change the recovery reservation',()=>{
 const run=async()=>{throw Error('test transport should remain idle');};
 assert.equal(completedRehearsalTransport({journal:{deliveryOperatorContinuation:()=>null},descriptor,run}),run);
 const key=randomUUID(),proof={kind:completionGrantKind,recovery:{key,inputSha256:hash}};
 const context={journal:{deliveryOperatorContinuation:()=>({proof}),directory:join(resolve('fixture'),'original')},descriptor,intent:{key:randomUUID(),inputSha256:hash}};
 assert.throws(()=>verifyReturnedReservation(context),/original-reservation-changed/);
 context.intent={key,inputSha256:'b'.repeat(64)};assert.throws(()=>verifyReturnedReservation(context),/original-reservation-changed/);
});
