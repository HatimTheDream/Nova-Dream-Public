import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../scripts/release-plan.mjs';
import { frontendExecutionRequest } from '../scripts/release-delivery-frontend-executor.mjs';
import { assistantAcceptanceInput } from '../scripts/release-delivery-assistant.mjs';
import { assistantHostBinding,buildAssistantHostProgram,assistantHostTransportIdentity,createAssistantHostTransport } from '../scripts/release-delivery-assistant-transport.mjs';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'nova-assistant-host-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const ref=(path,c)=>({path,sha256:c.repeat(64)}),put=(name,bytes)=>{const path=join(root,name);writeFileSync(path,bytes);return{path,sha256:sha256(bytes)};};
 const id=randomUUID(),key=randomUUID(),host=`/var/lib/nova-update/frontend/operator-inputs/${id}`,epoch=randomUUID(),processIdentity=randomUUID();
 const planInput={format:1,operationId:id,baseVersion:'2.3.0',baseCandidateId:'a'.repeat(64),serviceInputsSha256:'b'.repeat(64),frontendId:'c'.repeat(64),sourceRevision:'d'.repeat(40),version:'2.3.1',buildVersion:'1.0.288',worker:ref('/opt/nova-updater-2.3.0-aaaaaaaaaaaa/deploy/update-runner/frontend.py','e'),config:ref('/etc/nova-update/frontend.json','f'),operation:ref(host+'/operation.json','1'),assets:{manifest:ref(host+'/frontend.json','2'),signature:ref(host+'/frontend.sig','3'),archive:ref(host+'/frontend.tgz','4')},processIdentity,workspaceEpoch:epoch};
 const request=frontendExecutionRequest({operationId:id,runId:randomUUID(),planInput,planSha256:'5'.repeat(64),intentSha256:'6'.repeat(64)});
 const descriptor={operation:{id,priorCandidateId:planInput.baseCandidateId,version:'2.3.1',buildVersion:'1.0.288'}};
 const prior={route:{route:'frontend',serviceInputsSha256:planInput.serviceInputsSha256},sign:{frontendId:planInput.frontendId},publication:{frontendId:planInput.frontendId},recovery:{stagedExecution:{request}},installation:{state:'completed',operationId:id,journalSha256:'7'.repeat(64),journal:{phase:'completed',outcome:'selected',frontendId:planInput.frontendId,health:{candidateId:planInput.baseCandidateId,serviceInputsSha256:planInput.serviceInputsSha256,epoch,processIdentity,apiVersion:1,schemaVersion:55,frontend:{id:'8'.repeat(64),source:'bundled'}}}}};
 const input=assistantAcceptanceInput({descriptor,prior}),intent={key,input,inputSha256:'9'.repeat(64)},parent={...intent,createdAtMs:1000};
 const context={descriptor,prior,input,intent,journal:{directory:root,deliveryPhase:()=>parent}};
 const ssh=put('ssh.conf',Buffer.from('Host fixed\n HostName example.invalid\n')),transport=put('transport.json',Buffer.from(JSON.stringify({format:1,hostAlias:'fixed',sshConfig:ssh})));
 const startupReview=ref('/opt/nova-release-tools/actual-startup/checked/startup-review.json','a'),hostConfig=ref('/etc/nova-update/config.json','b'),records=[];
 const storeReceipt=(_j,k,name,bytes)=>{records.push(JSON.parse(bytes));return put(k+'-'+name,bytes);};
 const common={operationId:id,parentKey:key,inputSha256:intent.inputSha256,input,deadlineAtMs:301000};
 return{context,startupReview,hostConfig,transport,storeReceipt,common,records,parent};
}
const payload=program=>JSON.parse(Buffer.from(program.match(/b64decode\('([^']+)'/)[1],'base64'));
test('binding uses actual selected frontend and original host/runtime references',t=>{
 const f=fixture(t),b=assistantHostBinding(f.context,f.startupReview,f.hostConfig);
 assert.equal(b.deadlineAtMs,301000);assert.equal(b.input.installedHealth.frontend.id,'c'.repeat(64));assert.deepEqual(b.runtime,{startupReview:f.startupReview,hostConfig:f.hostConfig});
 for(const mutate of [c=>c.prior.recovery.stagedExecution.request.executor.sha256='0'.repeat(64),c=>c.prior.recovery.stagedExecution.request.planInput.processIdentity=randomUUID(),c=>c.prior.installation.journalSha256=null]){
   const c={...f.context,prior:structuredClone(f.context.prior)};mutate(c);assert.throws(()=>assistantHostBinding(c,f.startupReview,f.hostConfig));
 }
 assert.throws(()=>assistantHostBinding(f.context,f.startupReview,{...f.hostConfig,path:'/tmp/config'}));
});
test('fixed wire embeds exact reviewed source, no external code or credential input',t=>{
 const f=fixture(t),b=assistantHostBinding(f.context,f.startupReview,f.hostConfig),p=payload(buildAssistantHostProgram({mode:'ready',binding:b,common:f.common}));
 assert.equal(sha256(Buffer.from(p.sourceBase64,'base64')),assistantHostTransportIdentity());assert.equal(p.sourceSha256,assistantHostTransportIdentity());
 assert.deepEqual(p.value.binding,b);assert.throws(()=>buildAssistantHostProgram({mode:'shell'}));
});
test('real endpoint response shape passes unchanged, modes and deadline stay fixed',async t=>{
 const f=fixture(t),modes=[],entity={id:'draft:fixture',deviceId:randomUUID(),revision:1,value:{text:'fixture'}};
 const transport=createAssistantHostTransport({...f,run:async(_t,program)=>{const v=payload(program).value;modes.push(v.mode);assert.equal(v.common.deadlineAtMs,301000);return{exitCode:0,stdout:JSON.stringify({ok:true,value:entity})};}});
 await transport.validate(f.context);assert.deepEqual(await transport.readDraft({...f.common,draftId:entity.id}),entity);
 assert.equal(Object.hasOwn(entity,'kind'),false);assert.deepEqual(modes,['draft']);
 await assert.rejects(transport.readReady({...f.common,deadlineAtMs:301001}),/call-changed/);
});
test('zero exit malformed response and SSH loss preserve bounded original private diagnostics',async t=>{
 const f=fixture(t),responses=[{exitCode:0,stdout:'not-json',stderr:'parse fixture'},{uncertain:true,reasonCode:'transport-timeout',stdout:'partial',stderr:'private fixture'}];
 const transport=createAssistantHostTransport({...f,run:async()=>responses.shift()});await transport.validate(f.context);
 for(let i=0;i<2;i++)await assert.rejects(transport.readReady(f.common),error=>Boolean(error.privateDiagnostic?.sha256));
 assert.equal(f.records[0].parseFailure,true);assert.equal(f.records[0].transport.stdout,'not-json');assert.equal(f.records[1].transport.stderr,'private fixture');
});
test('actual API terminal code/status survive wrapper without public raw response',async t=>{
 const f=fixture(t),transport=createAssistantHostTransport({...f,run:async()=>({exitCode:0,stdout:JSON.stringify({ok:false,code:'epoch_changed',status:409,privateDiagnostic:{response:'synthetic-secret'}})})});await transport.validate(f.context);
 await assert.rejects(transport.postExact(f.common),e=>e.code==='epoch_changed'&&e.status===409&&!e.message.includes('synthetic-secret'));
 assert.ok(f.records[0].transport.stdout.includes('synthetic-secret'));
});
test('changed original deadline or runtime reference refuses reuse before another transport',async t=>{
 const f=fixture(t);let calls=0;const transport=createAssistantHostTransport({...f,run:async()=>{calls++;return{exitCode:0,stdout:'{"ok":true,"value":{}}'};}});await transport.validate(f.context);
 f.parent.createdAtMs++;await assert.rejects(transport.validate(f.context),/binding-changed/);assert.equal(calls,0);
});
test('success flag without response body still preserves original diagnostic',async t=>{
 const f=fixture(t),transport=createAssistantHostTransport({...f,run:async()=>({exitCode:0,stdout:'{"ok":true}',stderr:'original fixture'})});await transport.validate(f.context);
 await assert.rejects(transport.readReady(f.common),e=>Boolean(e.privateDiagnostic?.sha256));assert.equal(f.records[0].transport.stdout,'{"ok":true}');
});
