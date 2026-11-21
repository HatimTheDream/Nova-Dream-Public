import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {linkedBrowserBinding,verifyLinkedBrowserRecord} from '../scripts/release-delivery-browser-continuation.mjs';
import {canonicalBrowser,sha256} from '../scripts/release-delivery-browser-primitives.mjs';

function fixture(t) {
 const parent=resolve(tmpdir()),dir=mkdtempSync(join(parent,'nova-browser-expiry-'));let number=0;
 t.after(()=>{assert.equal(dirname(dir),parent);rmSync(dir,{recursive:true,force:true});});
 const pin=v=>{const raw=canonicalBrowser(v)+'\n',path=join(dir,(++number)+'.json');writeFileSync(path,raw,{flag:'wx'});return {path,sha256:sha256(raw)};};
 const id='00000000-0000-4000-8000-000000000001',successor='944c960d-ee98-53f8-acdc-be11fe2e2986';
 const candidate=sha256('fixture prior'),target=sha256('fixture target'),epoch='fixture-epoch',kind='one-prior-then-two-targets';
 const base={operationId:id,priorCandidateId:candidate,route:'full',options:{mode:'remote',suite:'tasks-search-focus',timeoutMs:1800000},epoch,
  priorBundledTarget:{candidateId:candidate,version:'2.28.50',buildVersion:'1.0.423'},
  fullTarget:{candidateId:target,version:'2.29.0',buildVersion:'1.0.424'},
  windowPolicy:{kind,priorCandidateId:candidate,targetCandidateId:target,qualification:{reviewSha256:sha256('review'),planSha256:sha256('plan'),terminalSha256:sha256('closed')}}};
 const original={binding:base,startedAtMs:100,deadlineAtMs:1800100},prior=pin(original),unit='nova-browser-'+id+'.service';
 const doc={...base.priorBundledTarget,frontendId:candidate,assets:'/__bundled/'+candidate+'/'};
 const prepared={kind:'nova-pre-promotion-browser',startedAtMs:10000,document:doc,windowPolicy:kind,twoPriorPages:'unverified-live',priorWindowCount:1,epoch,
  priorWindow:{epoch,reducedMotion:true,timeOrigin:1,document:doc},bindingSha256:sha256(canonicalBrowser(base)),
  draft:'Nova release verification '+id+' — retained unsent draft',
  memory:{operationId:id,milestone:'prior-draft-ready',maxBytes:2147483648,peakBytes:250000,events:'oom 0\noom_kill 0\n'}};
 const active={operationId:id,originalSha256:prior.sha256,deadlineAtMs:original.deadlineAtMs,observedAtMs:20000,activeEnterMonotonicUsec:5000,
  runtimeMaxUsec:1790000000,invocationId:'b'.repeat(32),unit,controlGroup:'/system.slice/'+unit,mainPid:100,processStartTicks:2,
  memberVerified:true,killMode:'control-group',memoryHighBytes:1476395008,memoryMaxBytes:2147483648};
 const ev={monotonicUsec:active.activeEnterMonotonicUsec+active.runtimeMaxUsec,realtimeUsec:original.deadlineAtMs*1000};
 const status={state:'observed',operationId:id,originalSha256:prior.sha256,observedAtMs:1810000,files:{prepared,failed:null,closed:null,acceptance:null,'worker-identity':{pid:100}},
  unitState:'MainPID=0\nActiveState=inactive\n',ownedPids:[],activeIdentity:pin(active),
  expiry:{termination:'systemd-runtime-limit',active,events:{elapsed:ev,failed:{...ev,realtimeUsec:ev.realtimeUsec+500}},originalProcessClosed:true,groupEmpty:true,noAcceptanceRequest:true}};
 const grantFor=s=>{const browser={predecessor:prior,status:pin(s),successorSessionId:successor},preparedBrowser=pin(prepared);
  return {kind:'nova-returned-publication-inputs-grant',browser,preparedBrowser,issuedAtMs:1820000,expiresAtMs:6000000,
   request:pin({kind:'nova-returned-publication-inputs-request',operationId:id,browser,preparedBrowser})};};
 return {base,prepared,status,grantFor};
}

test('retains the original timed-out draft, permits one distinct finite session and refuses mixed terminal evidence',t=>{
 const {base,status,grantFor}=fixture(t),grant=grantFor(status);
 const newBinding=linkedBrowserBinding(base,grant.browser,grant);
 const original={binding:newBinding,startedAtMs:1900000,deadlineAtMs:3700000};
 assert.deepEqual(verifyLinkedBrowserRecord(original),original);
 assert.throws(()=>verifyLinkedBrowserRecord({...original,deadlineAtMs:3700001}));
 for(const edit of [s=>{s.files.prepared.draft='changed';},s=>{s.ownedPids=[42];},s=>{s.files.acceptance={};},
  s=>{s.files.failed={operationId:base.operationId,reason:'other'};},s=>{s.expiry.noAcceptanceRequest=false;},
  s=>{s.expiry.active.processStartTicks++;},s=>{delete s.expiry.events.failed;},s=>{s.expiry.events.elapsed.realtimeUsec=90000;}]){
  const changed=structuredClone(status);edit(changed);
  const g=grantFor(changed);
  assert.throws(()=>linkedBrowserBinding(base,g.browser,g));
 }
 const other=structuredClone(grant.browser);other.successorSessionId='00000000-0000-4000-8000-000000000003';
 assert.throws(()=>linkedBrowserBinding(base,other,grant));
});
