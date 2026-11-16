import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {sha256} from '../scripts/release-plan.mjs';
import {browserBinding,canonicalBrowser} from '../scripts/release-delivery-browser.mjs';
import {prepareRemoteBrowser} from '../scripts/release-delivery-browser-remote.mjs';
import {verifyBrowserPredecessor,verifyPublicationBrowserContinuation,linkedBrowserBinding,verifyLinkedBrowserRecord} from '../scripts/release-delivery-browser-continuation.mjs';
function fixture(t){
 const parent=resolve(tmpdir()),root=mkdtempSync(join(parent,'nova-browser-successor-'));
 t.after(()=>{assert.equal(dirname(root),parent);assert.ok(root.startsWith(parent+sep));rmSync(root,{recursive:true,force:true});});
 const reference=p=>({path:p,sha256:sha256(readFileSync(p))});
 const save=(name,value)=>{const p=join(root,name);writeFileSync(p,canonicalBrowser(value)+'\n',{flag:'wx'});return reference(p);};
 const tool=join(root,'tool');writeFileSync(tool,'tool');const toolRef=reference(tool),closure=save('closure.json',{});
 const transport=save('transport.json',{format:1,hostAlias:'fixture',sshConfig:toolRef});
 const options={format:1,mode:'remote',node:toolRef,executable:toolRef,playwright:closure,baseUrl:'http://127.0.0.1:4383',timeoutMs:300000,suite:'tasks-search-focus',user:'nova',directoryRoot:'/opt/nova-browser-data'};
 const id=randomUUID(),priorId=sha256('prior'),targetId=sha256('target'),manifest=save('base.json',{version:'2.0.0',buildVersion:'1.0.100'});
 const target=save('target.json',{browserTools:options,transport,bases:{private:{candidateId:priorId,manifest}}});
 const descriptor={operation:{id,priorCandidateId:priorId,candidateId:targetId,workspaceEpoch:randomUUID(),version:'3.0.0',buildVersion:'1.0.200'},target};
 const prior={route:{route:'full',targetCandidateId:targetId},sign:{candidateId:targetId,priorCandidateId:priorId}},binding=browserBinding({descriptor,prior},options,transport),now=Date.now();
 mkdirSync(join(root,'browser-session'));const original={binding,startedAtMs:now-303000,deadlineAtMs:now-3000};
 const originalRef=save('browser-session/original.json',original),status={state:'observed',operationId:id,originalSha256:originalRef.sha256,observedAtMs:now-1000,files:{failed:{operationId:id,reason:'browser-original-deadline-exhausted',atMs:now-2500},closed:{operationId:id,browserClosed:true,tunnelClosed:true,atMs:now-2000},acceptance:null},unitState:'ActiveState=inactive\nMainPID=0\n',ownedPids:[]};
 const browser={predecessor:originalRef,status:save('status.json',status),successorSessionId:randomUUID()},journal={directory:root,deliveryPhase:(_id,name)=>({state:'completed',current:{output:prior[name]}})};
 return{root,save,reference,descriptor,prior,binding,original,originalRef,status,browser,journal,now,options,transport};
}
test('linked browser requires original target, expired failure and complete owned closure',t=>{
 const f=fixture(t);assert.deepEqual(verifyPublicationBrowserContinuation(f.browser,{descriptor:f.descriptor,journal:f.journal,now:f.now}),f.browser);
 for(const [name,change] of [
 ['active',s=>s.unitState='ActiveState=active\nMainPID=123\n'],['pid',s=>s.ownedPids=[123]],['closed',s=>s.files.closed=null],['acceptance',s=>s.files.acceptance={}],['operation',s=>s.operationId=randomUUID()],['hash',s=>s.originalSha256='0'.repeat(64)],['failure',s=>s.files.failed.reason='other'],['chronology',s=>s.files.closed.atMs=s.files.failed.atMs-1],['future-failure',s=>s.files.failed.atMs=s.observedAtMs+1]
 ]){const status=structuredClone(f.status);change(status);assert.throws(()=>verifyBrowserPredecessor({...f.browser,status:f.save(name+'.json',status)},f.binding));}
 assert.throws(()=>verifyBrowserPredecessor({...f.browser,successorSessionId:f.binding.operationId},f.binding));
 assert.throws(()=>verifyBrowserPredecessor(f.browser,{...f.binding,epoch:randomUUID()}));
 assert.throws(()=>verifyBrowserPredecessor(f.browser,{...f.binding,fullTarget:{...f.binding.fullTarget,candidateId:'0'.repeat(64)}}));
 const future={...f.status,observedAtMs:f.now+1};assert.throws(()=>verifyPublicationBrowserContinuation({...f.browser,status:f.save('future.json',future)},{descriptor:f.descriptor,journal:f.journal,now:f.now}),/status-future/);
 assert.throws(()=>verifyPublicationBrowserContinuation({...f.browser,predecessor:f.save('copied-original.json',f.original)},{descriptor:f.descriptor,journal:f.journal,now:f.now}),/original-path-changed/);
 assert.equal(f.reference(f.originalRef.path).sha256,f.originalRef.sha256);
});
test('successor keeps original operation and has a distinct finite clock inside grant',t=>{
 const f=fixture(t),grant={kind:'nova-expired-publication-continuation',browser:f.browser,request:f.save('request.json',{fixture:true}),issuedAtMs:f.now,expiresAtMs:f.now+600000};
 const binding=linkedBrowserBinding(f.binding,f.browser,grant),record={binding,startedAtMs:f.now+10,deadlineAtMs:f.now+10+f.options.timeoutMs};
 assert.equal(binding.operationId,f.binding.operationId);assert.notEqual(binding.sessionId,binding.operationId);assert.deepEqual(binding.browserPredecessor,{original:f.browser.predecessor,status:f.browser.status});assert.doesNotThrow(()=>verifyLinkedBrowserRecord(record));
 assert.throws(()=>verifyLinkedBrowserRecord({...record,startedAtMs:grant.expiresAtMs,deadlineAtMs:grant.expiresAtMs+f.options.timeoutMs}),/attempt-clock-changed/);
 assert.throws(()=>verifyLinkedBrowserRecord({...record,startedAtMs:f.original.startedAtMs,deadlineAtMs:f.original.deadlineAtMs}),/attempt-clock-changed/);
 assert.throws(()=>linkedBrowserBinding(f.binding,f.browser,{...grant,browser:{...f.browser,successorSessionId:randomUUID()}}),/grant-changed/);
 assert.equal(f.reference(f.originalRef.path).sha256,f.originalRef.sha256);
});
test('expired remote preparation observes original once and preserves terminal proof without relaunch',async t=>{
 const f=fixture(t),dir=join(f.root,'browser-session');f.save('browser-session/remote-launch-intent.json',{operationId:f.binding.operationId});let effects=0;const modes=[];
 const run=async(_target,program)=>{const payload=JSON.parse(Buffer.from(program.match(/base64\.b64decode\('([^']+)'\)/)[1],'base64').toString());modes.push(payload.mode);return{exitCode:0,stdout:JSON.stringify(f.status)};};
 await assert.rejects(prepareRemoteBrowser({dir,path:f.originalRef.path,binding:f.binding,record:f.original},{beforeNewEffect:async()=>{effects++;}},{options:f.options,transport:f.transport,inspectOnly:true,run}),/browser-original-deadline-exhausted/);
 assert.deepEqual(modes,['status']);assert.equal(effects,0);assert.deepEqual(JSON.parse(readFileSync(join(dir,'failed.json'))),f.status.files.failed);assert.deepEqual(JSON.parse(readFileSync(join(dir,'closed.json'))),f.status.files.closed);assert.equal(f.reference(f.originalRef.path).sha256,f.originalRef.sha256);
});
