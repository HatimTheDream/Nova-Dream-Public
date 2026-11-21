import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import test from 'node:test';
import {publicationInputsRequestSchema} from '../scripts/release-delivery-continuation.mjs';
import {assetBranch,assetGrantKind} from '../scripts/release-delivery-publication-inputs-schema.mjs';
import {acceptedObserverExit,originalAssetRecovery,verifyOriginalPublicationObservation} from '../scripts/release-delivery-publication-inputs-correction.mjs';

const operationId=randomUUID(),digest='a'.repeat(64);
const ref=name=>({path:resolve(name+'.json'),sha256:digest});
const side={root:resolve('source'),repository:'owner/app',branch:assetBranch,commit:'b'.repeat(40)};
const owner=Object.fromEntries(['request','launcher','intent','exit','childResult','stdout','session'].map(n=>[n,ref(n)]));
const request={format:1,kind:'nova-returned-publication-inputs-request',operationId,historical:{root:resolve('history'),manifest:ref('manifest')},
  operatorSources:{private:side,public:side},ciRuns:{private:1,public:2},owner,predecessorGrantSha256:digest,localInputs:ref('local-inputs'),assetPlan:ref('asset-plan'),
  browser:{predecessor:ref('original-browser'),status:ref('closed-browser'),successorSessionId:randomUUID()},preparedBrowser:ref('prepared-browser')};

test('the default storage identity and the publication recovery helper can each be the first import in a new process',()=>{
  for(const name of ['release-delivery-adapters.mjs','release-delivery-publication-inputs-correction.mjs']){
    const url=new URL('../scripts/'+name,import.meta.url);
    const child=spawnSync(process.execPath,['--input-type=module','-e','await import(process.argv[1])',url.href],{encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(child.status,0,child.error?.message??child.stderr);
  }
});

test('a returned publication binds paired operator sources, actual local inputs, the GET-only plan and the original observer',()=>{
  assert.doesNotThrow(()=>publicationInputsRequestSchema.parse(request));
  for(const mutate of [q=>q.durationMs=3600000,q=>q.operatorSources.public.branch='main',q=>delete q.owner.exit,q=>delete q.owner.session,
    q=>delete q.predecessorGrantSha256,q=>delete q.localInputs,q=>delete q.assetPlan,q=>delete q.browser.status,q=>delete q.preparedBrowser]){
    const bad=structuredClone(request);mutate(bad);assert.throws(()=>publicationInputsRequestSchema.parse(bad));
  }
});

test('only the original closed observer with an empty response can qualify',()=>{
  const exit={returnCode:4294967295,finishedAtMilliseconds:10};
  const result={returnCode:exit.returnCode,originalChildClosed:true,logBoundExceeded:false,automaticNewOperationPermitted:false};
  assert.ok(acceptedObserverExit(exit,result,Buffer.alloc(0),10));
  for(const [changed,closed,bytes,now] of [[{...exit,returnCode:0},result,[],10],[exit,{...result,originalChildClosed:false},[],10],
    [exit,{...result,automaticNewOperationPermitted:true},[],10],[exit,{...result,logBoundExceeded:true},[],10],[exit,result,[1],10],[exit,result,[],9]])
    assert.equal(acceptedObserverExit(changed,closed,Buffer.from(bytes),now),false);
});

test('only the returned-asset grant exposes the original first upload to the publication adapter',()=>{
  const proof={kind:assetGrantKind,localInputs:request.localInputs,assetPlan:request.assetPlan,assetRequest:ref('app'),reservation:ref('reservation'),expiresAtMs:42};
  assert.deepEqual(originalAssetRecovery(proof),{assetRequest:proof.assetRequest,reservation:proof.reservation,binding:proof.localInputs,noPostPlan:proof.assetPlan,expiresAtMs:42});
  assert.equal(originalAssetRecovery({...proof,kind:'nova-same-schema-returned-rehearsal-grant'}),undefined);
  assert.equal(originalAssetRecovery(null),undefined);
});

test('later upload, feed and complete observations retain the original reservation and original uncertain response',()=>{
  const sum=bytes=>createHash('sha256').update(bytes).digest('hex');
  const raw=JSON.stringify({state:'uncertain'}),row={at_ms:1,observation_json:raw,observation_hash:sum(raw)};
  const reservation={key:randomUUID(),inputSha256:digest,storedObservationSha256:sum(raw),observationSha256:sum(JSON.stringify({observedAtMs:1,state:'uncertain'}))};
  for(const state of ['running','completed']){
    const current={key:reservation.key,inputSha256:digest,state,current:{state,receipt:{path:'later-result',sha256:digest}}};
    assert.doesNotThrow(()=>verifyOriginalPublicationObservation(current,reservation,row));
    assert.throws(()=>verifyOriginalPublicationObservation({...current,key:randomUUID()},reservation,row),/reservation-changed/);
    assert.throws(()=>verifyOriginalPublicationObservation(current,reservation,{...row,at_ms:2}),/observation-changed/);
    assert.throws(()=>verifyOriginalPublicationObservation(current,reservation,{...row,observation_json:'{}'}),/observation-changed/);
  }
});
