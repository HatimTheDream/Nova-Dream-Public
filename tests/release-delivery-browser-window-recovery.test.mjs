import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {sha256} from '../scripts/release-plan.mjs';
import {browserBinding,canonicalBrowser,writeBrowserOnce} from '../scripts/release-delivery-browser.mjs';
import {prepareRemoteBrowser} from '../scripts/release-delivery-browser-remote.mjs';
import {createDeliveryRegistry} from '../scripts/release-delivery-adapters.mjs';
import {linkedBrowserBinding,verifyLinkedBrowserRecord,verifyBrowserWindowReservation,verifyBrowserWindowRecoveryReadiness} from '../scripts/release-delivery-browser-continuation.mjs';
const hash=v=>sha256(canonicalBrowser(v));
function fixture(t){
 const parent=resolve(tmpdir()),root=mkdtempSync(join(parent,'nova-browser-window-'));
 t.after(()=>{assert.equal(dirname(root),parent);assert.ok(root.startsWith(parent+sep));rmSync(root,{recursive:true,force:true});});
 const reference=path=>({path,sha256:sha256(readFileSync(path))});
 const save=(name,value)=>{const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,canonicalBrowser(value)+'\n',{flag:'wx'});return reference(path);};
 const tool=save('tool.json',{synthetic:true}),closure=save('closure.json',{format:1,files:[],entry:'/opt/fixture'}),transport=save('transport.json',{format:1,hostAlias:'fixture',sshConfig:tool});
 const options={format:1,mode:'remote',node:tool,executable:tool,playwright:closure,baseUrl:'http://127.0.0.1:4383',timeoutMs:1800000,suite:'tasks-search-focus',user:'nova',directoryRoot:'/opt/nova-browser-tests'};
 const now=Date.now(),id=randomUUID(),priorId=sha256('prior'),candidateId=sha256('candidate'),manifest=save('base.json',{version:'2.0.0',buildVersion:'1.0.100'});
 const base={directory:root,candidateId:priorId,manifest},target={format:1,transport,browserTools:options,browserCapability:'available',bases:{private:base,public:base}};
 const descriptor={operation:{id,priorCandidateId:priorId,candidateId,workspaceEpoch:randomUUID(),version:'3.0.0',buildVersion:'1.0.200'},target:save('target.json',target)};
 const prior={route:{route:'full',targetCandidateId:candidateId},sign:{candidateId,priorCandidateId:priorId}},binding=browserBinding({descriptor,prior},options,transport);
 const original={binding,startedAtMs:now-8000000,deadlineAtMs:now-6200000},originalRef=save('browser-session/original.json',original);
 const browser={predecessor:originalRef,status:save('old-status.json',{state:'observed',operationId:id,originalSha256:originalRef.sha256,observedAtMs:now-6000000,files:{failed:{operationId:id,reason:'browser-original-deadline-exhausted',atMs:now-6199000},closed:{operationId:id,browserClosed:true,tunnelClosed:true,atMs:now-6198000},acceptance:null},unitState:'ActiveState=inactive\nMainPID=0\n',ownedPids:[]}),successorSessionId:randomUUID()};
 const predecessor={kind:'nova-expired-publication-continuation',operationId:id,browser,request:save('predecessor-request.json',{operationId:id,browser,successor:{synthetic:true}}),issuedAtMs:now-4000000,expiresAtMs:now-2000000,successor:{synthetic:true}};
 const predecessorSaved={proof:predecessor,sha256:hash(predecessor),recordedAtMs:predecessor.issuedAtMs,eventId:20};
 const request={operationId:id,browser,browserWindowRecovery:{predecessorGrantSha256:predecessorSaved.sha256,storageAdmission:{synthetic:true},reason:'Synthetic no-browser recovery.'}};
 const grant={kind:'nova-expired-publication-continuation',operationId:id,browser,request:save('recovery-request.json',request),issuedAtMs:now,expiresAtMs:now+2000000,browserWindowRecovery:request.browserWindowRecovery,browserReservation:{sessionId:browser.successorSessionId,startedAtMs:now,deadlineAtMs:now+1800000}};
 const journal={directory:root,deliveryPhase:(_id,name)=>({state:'completed',current:{output:prior[name]}}),deliveryOperatorContinuationBySha256:(_id,digest)=>digest===predecessorSaved.sha256?predecessorSaved:null};
 const context={descriptor,prior,journal,request},linked=linkedBrowserBinding(binding,browser,grant),dir=join(root,'browser-session','successor-'+browser.successorSessionId),path=join(dir,'original.json');
 const kept=()=>({dir,path,binding:linked,record:existsSync(path)?JSON.parse(readFileSync(path)):null});
 const fixed={binding:linked,startedAtMs:grant.browserReservation.startedAtMs,deadlineAtMs:grant.browserReservation.deadlineAtMs};
 const plan=original=>({format:1,kind:'nova-remote-browser-plan',operationId:id,sessionId:original.binding.sessionId,directory:options.directoryRoot+'/'+original.binding.sessionId,unit:'nova-browser-'+original.binding.sessionId,uid:1001,gid:1001,workerSha256:sha256('worker'),originalSha256:sha256(Buffer.from(canonicalBrowser(original)+'\n')),node:options.node,executable:options.executable,playwrightSha256:options.playwright.sha256,memoryMaxBytes:1073741824,hostReserveBytes:2147483648});
 const planned=original=>{const value=plan(original);return{state:'planned',plan:value,planSha256:hash(value),existingOperation:false,memoryAdmission:{availableBytes:4*1024**3,requiredBytes:3*1024**3,atMs:now}};};
 const observed=original=>({state:'observed',operationId:id,originalSha256:sha256(Buffer.from(canonicalBrowser(original)+'\n')),observedAtMs:now,unitState:'ActiveState=active\nMainPID=123\n',ownedPids:[123],files:{heartbeat:{operationId:id,originalSha256:sha256(Buffer.from(canonicalBrowser(original)+'\n')),browserAlive:true,transport:'remote-direct',atMs:now,pid:123},prepared:{bindingSha256:hash(original.binding),epoch:binding.epoch,document:{candidateId:priorId},startedAtMs:now},failed:null,closed:null}});
 const modes=[];let override;
 const run=async(_config,program)=>{const payload=JSON.parse(Buffer.from(program.match(/base64\.b64decode\('([^']+)'\)/)[1],'base64').toString());modes.push(payload.mode);if(override){const result=await override(payload);if(result!==undefined)return result;}
  const response=payload.mode==='readiness'?{...planned(payload.original),state:'ready',sessionAbsent:true,hostWrites:false}:payload.mode==='plan'?planned(payload.original):observed(payload.original);
  return{exitCode:0,stdout:JSON.stringify(response)};};
 return{root,save,reference,now,id,options,transport,target,descriptor,prior,original,originalRef,browser,predecessorSaved,request,grant,journal,context,linked,dir,path,kept,fixed,planned,observed,run,modes,setOverride:value=>override=value};
}
function options(f,clock=()=>f.now+1000){return{options:f.options,transport:f.transport,run:f.run,clock};}
function dispatchContext(f,calls){return{...f.context,beforeNewEffect:async()=>{calls.push('gate');}};}

test('configured registry readiness proves the absent reserved session without creating browser artifacts',async t=>{
 const f=fixture(t),registry=createDeliveryRegistry({run:f.run,clock:()=>f.now,command:async()=>assert.fail('No process command permitted')});
 const ref=await registry.browserWindowRecoveryReadiness(f.context);
 assert.deepEqual(f.modes,['readiness']);assert.equal(existsSync(f.dir),false);assert.equal(existsSync(f.path),false);
 assert.doesNotThrow(()=>verifyBrowserWindowRecoveryReadiness(ref,{...f.context,now:f.now,requireUnmaterialized:true}));
 assert.throws(()=>verifyBrowserWindowRecoveryReadiness(ref,{...f.context,now:f.now+900001}),/readiness-changed/);
 assert.throws(()=>verifyBrowserWindowRecoveryReadiness(ref,{...f.context,now:f.now-1}),/readiness-changed/);
 const proof=JSON.parse(readFileSync(ref.path));for(const [name,change]of [
  ['remote-session',p=>p.remote.plan.sessionId=randomUUID()],['remote-target',p=>p.remote.plan.node.sha256='0'.repeat(64)],
  ['remote-existing',p=>p.remote.existingOperation=true],['remote-memory',p=>p.remote.memoryAdmission.availableBytes=1],['remote-writes',p=>p.remote.hostWrites=true]
 ]){const changed=structuredClone(proof);change(changed);assert.throws(()=>verifyBrowserWindowRecoveryReadiness(f.save(name+'.json',changed),{...f.context,now:f.now}),/readiness-changed/);}
 mkdirSync(f.dir);writeFileSync(f.path,'{}');assert.throws(()=>verifyBrowserWindowRecoveryReadiness(ref,{...f.context,now:f.now,requireUnmaterialized:true}),/already-materialized/);
 assert.equal(f.reference(f.originalRef.path).sha256,f.originalRef.sha256);
});

test('wrong operation grant session tool target or current epoch refuses before remote readiness',async t=>{
 for(const label of ['operation','grant','session','tool','target','epoch'])await t.test(label,async t=>{
  const f=fixture(t),context={...f.context,request:structuredClone(f.request),descriptor:structuredClone(f.descriptor)};
  if(label==='operation')context.request.operationId=randomUUID();
  if(label==='grant')context.request.browserWindowRecovery.predecessorGrantSha256='0'.repeat(64);
  if(label==='session')context.request.browser.successorSessionId=randomUUID();
  if(label==='epoch')context.descriptor.operation.workspaceEpoch=randomUUID();
  if(label==='target')context.descriptor.operation.candidateId='0'.repeat(64);
  if(label==='tool'){const target=structuredClone(f.target);target.browserTools.node.sha256='0'.repeat(64);context.descriptor.target=f.save('changed-target.json',target);}
  const registry=createDeliveryRegistry({run:f.run,clock:()=>f.now});await assert.rejects(registry.browserWindowRecoveryReadiness(context));assert.deepEqual(f.modes,[]);assert.equal(existsSync(f.dir),false);
 });
});

test('recovery materializes the exact atomic reservation after a pre-original crash and repeated preparation observes one session',async t=>{
 const f=fixture(t),gates=[];mkdirSync(f.dir);
 await prepareRemoteBrowser(f.kept(),dispatchContext(f,gates),options(f));
 const before=readFileSync(f.path);assert.deepEqual(JSON.parse(before),f.fixed);assert.deepEqual(f.modes,['plan','start','status']);assert.equal(gates.length,2);
 f.modes.length=0;gates.length=0;
 await prepareRemoteBrowser(f.kept(),dispatchContext(f,gates),options(f,()=>f.now+5000));
 assert.deepEqual(f.modes,['status']);assert.deepEqual(gates,[]);assert.deepEqual(readFileSync(f.path),before);
 assert.equal(f.reference(f.originalRef.path).sha256,f.originalRef.sha256);
});

test('crashes after original or remote plan reuse fixed clocks and produce one immutable launch intent',async t=>{
 for(const phase of ['original','plan'])await t.test(phase,async t=>{
  const f=fixture(t),gates=[];mkdirSync(f.dir);writeBrowserOnce(f.path,f.fixed);
  if(phase==='plan')writeBrowserOnce(join(f.dir,'remote-plan.json'),f.planned(f.fixed));
  await prepareRemoteBrowser(f.kept(),dispatchContext(f,gates),options(f,()=>f.now+30000));
  assert.deepEqual(JSON.parse(readFileSync(f.path)),f.fixed);assert.deepEqual(f.modes,phase==='plan'?['start','status']:['plan','start','status']);assert.equal(gates.length,1);
  const plan=JSON.parse(readFileSync(join(f.dir,'remote-plan.json'))),intent=JSON.parse(readFileSync(join(f.dir,'remote-launch-intent.json')));
  assert.deepEqual(intent,{operationId:f.id,planSha256:plan.planSha256,originalSha256:sha256(readFileSync(f.path))});
 });
});

test('lost launch response and crash after intent only observe the same original and never relaunch',async t=>{
 for(const phase of ['lost-response','uncertain-response','before-launch'])await t.test(phase,async t=>{
  const f=fixture(t),gates=[];mkdirSync(f.dir);
  if(phase!=='before-launch'){
   f.setOverride(async p=>{if(p.mode==='start'){if(phase==='lost-response')throw Error('lost-launch-response');return{exitCode:0,stdout:JSON.stringify(f.observed(p.original)),uncertain:true};}});
   await assert.rejects(prepareRemoteBrowser(f.kept(),dispatchContext(f,gates),options(f)),/lost-launch-response|browser-remote-response-unavailable/);
  }else{
   writeBrowserOnce(f.path,f.fixed);const plan=f.planned(f.fixed);writeBrowserOnce(join(f.dir,'remote-plan.json'),plan);
   writeBrowserOnce(join(f.dir,'remote-launch-intent.json'),{operationId:f.id,planSha256:plan.planSha256,originalSha256:sha256(readFileSync(f.path))});
  }
  const originalBytes=readFileSync(f.path),intentBytes=readFileSync(join(f.dir,'remote-launch-intent.json'));f.modes.length=0;gates.length=0;
  f.setOverride(async p=>{assert.equal(p.mode,'status');if(phase==='before-launch')return{exitCode:2,stdout:JSON.stringify({state:'gap',reason:'browser-remote-original-operation-missing'})};});
  if(phase==='before-launch')await assert.rejects(prepareRemoteBrowser(f.kept(),dispatchContext(f,gates),options(f)),/original-operation-missing/);
  else await prepareRemoteBrowser(f.kept(),dispatchContext(f,gates),options(f));
  assert.deepEqual(f.modes,['status']);assert.deepEqual(gates,[]);assert.deepEqual(readFileSync(f.path),originalBytes);assert.deepEqual(readFileSync(join(f.dir,'remote-launch-intent.json')),intentBytes);
 });
});

test('expired reservation before original or launch intent refuses without fresh effects or a replacement clock',async t=>{
 for(const phase of ['absent','original'])await t.test(phase,async t=>{
  const f=fixture(t),gates=[];mkdirSync(f.dir);if(phase==='original')writeBrowserOnce(f.path,f.fixed);
  await assert.rejects(prepareRemoteBrowser(f.kept(),dispatchContext(f,gates),options(f,()=>f.grant.browserReservation.deadlineAtMs)),/deadline-exhausted/);
  assert.deepEqual(f.modes,[]);assert.deepEqual(gates,[]);assert.equal(existsSync(join(f.dir,'remote-launch-intent.json')),false);
  if(phase==='absent')assert.equal(existsSync(f.path),false);else assert.deepEqual(JSON.parse(readFileSync(f.path)),f.fixed);
 });
});

test('conflicting reservation original and launch intent fail closed',async t=>{
 const f=fixture(t),r=f.grant.browserReservation,args={browser:f.browser,issuedAtMs:f.grant.issuedAtMs,expiresAtMs:f.grant.expiresAtMs,timeoutMs:f.options.timeoutMs};
 for(const changed of [{...r,sessionId:randomUUID()},{...r,startedAtMs:r.startedAtMs+1},{...r,deadlineAtMs:r.deadlineAtMs+1}])assert.throws(()=>verifyBrowserWindowReservation(changed,args),/reservation-changed/);
 assert.throws(()=>verifyLinkedBrowserRecord({...f.fixed,startedAtMs:f.fixed.startedAtMs+1,deadlineAtMs:f.fixed.deadlineAtMs+1}),/reservation-clock-changed/);
 mkdirSync(f.dir);writeBrowserOnce(f.path,f.fixed);const plan=f.planned(f.fixed);writeBrowserOnce(join(f.dir,'remote-plan.json'),plan);writeBrowserOnce(join(f.dir,'remote-launch-intent.json'),{operationId:f.id,planSha256:'0'.repeat(64),originalSha256:sha256(readFileSync(f.path))});
 await assert.rejects(prepareRemoteBrowser(f.kept(),dispatchContext(f,[]),options(f)),/launch-intent-changed/);assert.deepEqual(f.modes,[]);
});

test('another linked session blocks readiness before remote observation',async t=>{
 const f=fixture(t);mkdirSync(join(f.root,'browser-session','successor-'+randomUUID()));
 const registry=createDeliveryRegistry({run:f.run,clock:()=>f.now});
 await assert.rejects(registry.browserWindowRecoveryReadiness(f.context),/other-session-present/);assert.deepEqual(f.modes,[]);
});

test('expired materialized intent only collects original terminal evidence',async t=>{
 const f=fixture(t),gates=[];mkdirSync(f.dir);writeBrowserOnce(f.path,f.fixed);const plan=f.planned(f.fixed);writeBrowserOnce(join(f.dir,'remote-plan.json'),plan);
 writeBrowserOnce(join(f.dir,'remote-launch-intent.json'),{operationId:f.id,planSha256:plan.planSha256,originalSha256:sha256(readFileSync(f.path))});
 f.setOverride(async p=>{assert.equal(p.mode,'status');const state=f.observed(p.original);state.files.failed={operationId:f.id,reason:'browser-original-deadline-exhausted',atMs:f.fixed.deadlineAtMs};return{exitCode:0,stdout:JSON.stringify(state)};});
 await assert.rejects(prepareRemoteBrowser(f.kept(),dispatchContext(f,gates),options(f,()=>f.fixed.deadlineAtMs)),/deadline-exhausted/);
 assert.deepEqual(f.modes,['status']);assert.deepEqual(gates,[]);assert.deepEqual(JSON.parse(readFileSync(f.path)),f.fixed);assert.equal(existsSync(join(f.dir,'failed.json')),true);
});
