import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonicalBrowser,retainedWindowPolicy,sha256,verifyRetainedPreparation,verifyRetainedWindowPolicy} from '../scripts/release-delivery-browser-primitives.mjs';
import {observeWindowPair,verifyWindowPairEvidence} from '../scripts/release-delivery-browser-checks.mjs';

function fixture(){
  const priorCandidateId=sha256('prior candidate'),targetCandidateId=sha256('target candidate');
  const policy={kind:retainedWindowPolicy,priorCandidateId,targetCandidateId};
  const binding={operationId:randomUUID(),epoch:randomUUID(),route:'full',priorCandidateId,windowPolicy:policy,
    priorBundledTarget:{candidateId:priorCandidateId,version:'2.28.39',buildVersion:'1.0.412'},
    fullTarget:{candidateId:targetCandidateId,version:'2.28.45',buildVersion:'1.0.418'},options:{mode:'remote',suite:'tasks-search-focus'}};
  const doc=t=>({...t,frontendId:t.candidateId,assets:`/__bundled/${t.candidateId}/`});
  const window=(target,timeOrigin,reducedMotion)=>({document:doc(target),timeOrigin,reducedMotion,epoch:binding.epoch});
  const priorWindow=window(binding.priorBundledTarget,100,true),opened=window(binding.fullTarget,200,false);
  const prepared={bindingSha256:sha256(canonicalBrowser(binding)),windowPolicy:policy.kind,twoPriorPages:'unverified-live',priorWindowCount:1,priorWindow,
    epoch:binding.epoch,document:priorWindow.document,draft:`Nova release verification ${binding.operationId} — retained unsent draft`,
    memory:{operationId:binding.operationId,milestone:'prior-draft-ready',maxBytes:2**31,peakBytes:2**30,events:'oom 0\noom_kill 0\noom_group_kill 0'}};
  const pair=(original,opened)=>({count:2,original,opened,draftSha256:sha256(prepared.draft)});
  const coverage={policy:policy.kind,twoPriorPages:'unverified-live',mixed:pair({...priorWindow,reducedMotion:false},opened),
    reloaded:pair(window(binding.fullTarget,300,false),opened)};
  return {policy,binding,prepared,coverage};
}
test('only the specified signed full transition and remote Tasks suite can use the typed window policy',()=>{
  const {binding,policy}=fixture();
  assert.equal(verifyRetainedWindowPolicy(undefined,binding),false);assert.equal(verifyRetainedWindowPolicy(policy,binding),true);
  for(const change of [v=>v.route='frontend',v=>v.options.suite='tasks-search-escape',v=>v.options.mode='local',
    v=>v.priorBundledTarget.candidateId=sha256('other'),v=>v.priorBundledTarget.version='2.28.38',v=>v.fullTarget.buildVersion='1.0.419']){
    const value=structuredClone(binding);change(value);assert.throws(()=>verifyRetainedWindowPolicy(policy,value));
  }
});
test('single prior preparation validates the original draft, real prior motion, bound versions, and measured headroom',()=>{
  const {binding,prepared}=fixture();verifyRetainedPreparation(binding,prepared);
  for(const change of [p=>p.priorWindowCount=2,p=>p.secondPage={},p=>p.priorWindow.reducedMotion=false,p=>p.draft='other',
    p=>p.memory.peakBytes=2**31,p=>p.memory.events='oom 1\noom_kill 0',p=>delete p.memory,p=>p.priorWindow.epoch=randomUUID()]){
    const value=structuredClone(prepared);change(value);assert.throws(()=>verifyRetainedPreparation(binding,value));
  }
});
test('simultaneous observations retain their exact old/new document and epoch through original-page reload',()=>{
  const {binding,prepared,coverage}=fixture();verifyWindowPairEvidence(binding,prepared,coverage);
  for(const change of [v=>v.twoPriorPages='passed',v=>v.mixed.original.reducedMotion=true,v=>v.mixed.original.timeOrigin++,
    v=>v.mixed.opened.epoch=randomUUID(),v=>v.mixed.count=1,v=>v.mixed.draftSha256=sha256('wrong'),v=>v.reloaded.original.document=prepared.document,
    v=>v.reloaded.opened.timeOrigin++,v=>v.reloaded.original.timeOrigin=v.reloaded.opened.timeOrigin,
    v=>v.reloaded.opened.document.assets='/different/',v=>v.reloaded.original.reducedMotion=true]){
    const value=JSON.parse(JSON.stringify(coverage));change(value);assert.throws(()=>verifyWindowPairEvidence(binding,prepared,value));
  }
});
test('producer observes both actual page handles and refuses a replaced draft or closed page',async()=>{
  const {binding,prepared,coverage}=fixture(),{mixed}=coverage;
  const field={waitFor:async()=>{},isVisible:async()=>true,inputValue:async()=>prepared.draft};
  const page=w=>({getByRole:()=>field,isClosed:()=>false,evaluate:async fn=>fn.toString().includes('performance.timeOrigin')
    ?{timeOrigin:w.timeOrigin,reducedMotion:w.reducedMotion}:w.document});
  const old=page(mixed.original),opened=page(mixed.opened),context={pages:()=>[old,opened]};
  assert.deepEqual(await observeWindowPair(context,old,opened,binding.epoch,binding.epoch,prepared.draft),mixed);
  await assert.rejects(observeWindowPair(context,old,old,binding.epoch,binding.epoch,prepared.draft),/two-live/);
  await assert.rejects(observeWindowPair(context,old,opened,binding.epoch,binding.epoch,'other'),/draft-lost/);
  opened.isClosed=()=>true;await assert.rejects(observeWindowPair(context,old,opened,binding.epoch,binding.epoch,prepared.draft),/two-live/);
});
