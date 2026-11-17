import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ReleaseJournal} from '../scripts/release-coordinate.mjs';
import {sha256} from '../scripts/release-plan.mjs';
import {assistantAcceptanceInput,verifyAssistantReady,verifySavedAssistantReply,createAssistantAcceptanceAdapter} from '../scripts/release-delivery-assistant.mjs';
import {existingReplyOriginal,existingReplyOutput,verifyExistingReplyAcceptance,verifyExistingReplyEvidence,existingAssistantReplySchema} from '../scripts/release-delivery-existing-reply.mjs';
import {verifyExistingReplyBrowserState} from '../scripts/release-delivery-browser-checks.mjs';
import {deliveryStartInputSchema,deliveryProfileSchema} from '../scripts/release-delivery-initialize.mjs';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=v=>sha256(canonical(v));
const schema=readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8').match(/this\.db\.exec\(\x60(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)\x60\);/)[1].replace('$'+'{APPLICATION_ID}',String(0x4e56524c));
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'nova-existing-reply-')),now=1794930000000,oldId=randomUUID(),id=randomUUID(),epoch=randomUUID();let time=now;
 const journal=Object.create(ReleaseJournal.prototype);journal.directory=root;journal.readOnly=false;journal.db=new DatabaseSync(join(root,'journal.sqlite'));journal.db.exec(schema);
 t.after(()=>{journal.close();rmSync(root,{recursive:true,force:true});});
 const put=(name,value)=>{const bytes=Buffer.from(canonical(value)+'\n'),path=join(root,name);writeFileSync(path,bytes);return{path,sha256:sha256(bytes)};};
 const oldInput={format:1,route:'full',operationId:oldId,installedHealth:{candidateId:sha256('old'),epoch,processIdentity:randomUUID(),apiVersion:1,schemaVersion:60,serviceInputsSha256:sha256('old-service'),frontend:{id:sha256('old'),source:'bundled',version:'2.0.0',buildVersion:'1.0.1'}},installationSha256:sha256('old-install'),budgetMs:300000,browserUiVerified:false};
 const ready=input=>({health:structuredClone(input.installedHealth),access:{workspaceEpoch:epoch,recovery:false,recoveryLocal:false},acceptance:{candidateId:input.installedHealth.candidateId,epoch,heldFor:null,maintenanceHeld:false,nativeSuspended:false},service:{id:'openclaw',state:'ready',version:'2026.9.8'},state:{connection:{state:'ready',modelAuthReady:true,grantedScopes:['operator.read','operator.write'],generation:randomUUID()},operations:[],conversations:[]},appProcess:{ActiveState:'active',SubState:'running',MainPID:'100',ExecMainStartTimestampMonotonic:'1000'},runtimeProof:{configurationSha256:sha256('config'),openclawVersion:'2026.9.8',files:{node:{bytes:1,inode:1,sha256:sha256('node')},codex:{bytes:2,inode:2,sha256:sha256('codex')}}},installationProof:{installationSha256:input.installationSha256},fullRuntimeVerified:true});
 const oldReady=ready(oldInput),key=randomUUID(),deviceId=randomUUID(),session={deviceId,sessionReference:{path:'/var/lib/nova-update/release-coordinator/'+oldId+'/assistant-'+key+'/session-'+randomUUID()+'.json',sha256:sha256('secret')},sessionSha256:sha256('secret'),readiness:verifyAssistantReady(oldReady,oldInput)};
 const selection={profileId:'openai:fixture',label:'fixture@example.invalid',reason:'preferred',selectedAt:'2026-11-17T00:00:00.000Z'};
 const conversation={id:randomUUID(),nativeId:randomUUID(),nativeKey:'agent:main:fixture',revision:1,state:'ready',permissionMode:'read-only',projectId:null,connectionGeneration:oldReady.state.connection.generation,archived:false,accountSelection:selection};
 const body={requestId:randomUUID(),epoch,conversationId:conversation.id,conversationRevision:1},op={id:randomUUID(),...body,deviceId,nativeId:conversation.nativeId,connectionGeneration:conversation.connectionGeneration,state:'completed',nativeRunId:randomUUID(),text:'Nova verification '+key+' passed.',accountSelection:selection};
 oldReady.state.operations=[op];oldReady.state.conversations=[conversation];
 const history={conversationId:conversation.id,nativeId:conversation.nativeId,activeRunIds:[],messages:[{id:randomUUID(),role:'assistant',text:op.text,runId:op.nativeRunId,operationId:op.id}]};
 const evidence={ready:oldReady,operation:op,history},proof=verifySavedAssistantReply(evidence,{input:oldInput,session,conversation,submission:body,expectedReply:op.text,originalOperationId:op.id});
 const accepted={format:1,kind:'nova-delivery-saved-assistant-reply',operationId:oldId,key,inputSha256:hash(oldInput),originalDeadlineAtMs:now-10000,...proof};
 const oldInstall={kind:'maintained-installed-acceptance-identity',operationId:oldId,candidateId:oldInput.installedHealth.candidateId,health:oldInput.installedHealth};
 const request={kind:'nova-existing-saved-reply-observation',originalReceipt:put('original-receipt.json',accepted),originalInstallation:put('old-installed.json',oldInstall),originalBrowserInput:put('old-browser.json',{operationId:oldId,installed:oldInput,assistant:accepted}),session:put('session.json',session),conversation:put('conversation.json',{conversation}),submission:put('submission.json',{requestBody:body,operationId:op.id}),savedReply:put('saved-reply.json',{...proof,evidence})};
 const operation={id,stage:'draft',candidateId:null,publicCandidateId:null,priorCandidateId:oldInput.installedHealth.candidateId,workspaceEpoch:epoch,version:'2.0.1',buildVersion:'1.0.2',agentVersion:'2026.9.8',priorAgentVersion:'2026.9.8',sourceCommits:{private:'a'.repeat(40),public:'b'.repeat(40)},bundleSha256:null,trustedPublicKeySha256:sha256('key'),changeClass:'application',helperHashes:null};
 const estimate={id:randomUUID(),step:'total',issuedAtMs:now,remainingMs:[600000,1200000],confidence:'low',basis:'Fixture.',reason:'Fixture.',nextCheckpointAtMs:now+300000};
 const descriptor={format:1,operation,sources:Object.fromEntries(['private','public'].map((side,i)=>[side,{root:'/'+side,repository:'Example/'+side,commit:operation.sourceCommits[side],baseCommit:(i?'d':'c').repeat(40),branch:'main'}])),target:put('target.json',{}),targetIdentity:sha256('target'),adapterIdentity:sha256('adapter'),observationBudgetMs:14400000,timeline:{startedAtMs:now,original:estimate,revisions:[],reviews:[],lastCheckpointAtMs:now},existingAssistantReply:request};
 const installedHealth={...oldInput.installedHealth,candidateId:sha256('new'),processIdentity:randomUUID(),serviceInputsSha256:sha256('new-service'),frontend:{...oldInput.installedHealth.frontend,id:sha256('new'),version:'2.0.1',buildVersion:'1.0.2'}};
 const prior={route:{route:'full',targetCandidateId:installedHealth.candidateId},installation:{controllerCompleted:true,acceptanceIdentity:{kind:'maintained-installed-acceptance-identity',operationId:id,candidateId:installedHealth.candidateId,health:installedHealth}}};
 const input=assistantAcceptanceInput({descriptor,prior});journal.initializeDelivery(descriptor,now);const intent=journal.reserveDeliveryPhase(id,'assistant',input,now).intent;
 const current=ready(input);current.state.operations=[structuredClone(op)];current.state.conversations=[structuredClone(conversation)];
 const observed=childKey=>({format:1,kind:'nova-existing-reply-observation',operationId:id,parentKey:intent.key,observationKey:childKey,inputSha256:hash(input),deadlineAtMs:now+300000,startedAtMs:now+10,finishedAtMs:now+20,deviceId,sessionSha256:session.sessionSha256,httpMethods:['GET'],sessionCreated:false,inferenceDispatched:false,before:structuredClone(current),after:structuredClone(current),accounts:{state:'available',accounts:[{profileId:selection.profileId,label:selection.label,health:'unknown'}],profileCount:1,checkedAt:now+15},history:structuredClone(history)});
 const context={descriptor,prior,journal,input,intent,beforeNewEffect:async()=>{}},calls=[];
 const trap=async()=>{throw Error('forbidden-effect-called');};
 const transport={validate:async()=>{},observeExisting:async common=>{calls.push(common);return observed(common.observationKey);},session:trap,postExact:trap,readDraft:trap,observeSubmit:trap};
 const adapter=createAssistantAcceptanceAdapter({transport,clock:()=>time,storeReceipt:(_j,k,n,b)=>{const p=join(root,k+'-'+n);writeFileSync(p,b);return{path:p,sha256:sha256(b)};}});
 return{root,put,request,original:existingReplyOriginal(request),input,intent,context,journal,transport,adapter,calls,observed,now,setTime:v=>time=v};
}
test('existing reply verifies fresh generation while retaining historical run and profile lineage',t=>{
 const f=fixture(t),key=randomUUID(),e=f.observed(key),receipt=f.put('fresh.json',e),clocks={parentKey:f.intent.key,observationKey:key,startedAtMs:f.now,deadlineAtMs:f.now+300000};
 const out=existingReplyOutput(e,f.input,receipt,clocks);assert.notEqual(out.connectionGeneration,out.observedConnectionGeneration);assert.equal(out.key,f.original.accepted.key);assert.equal(out.deliveryOperationId,f.input.operationId);assert.equal(verifyExistingReplyAcceptance(out,f.input),out);
 assert.throws(()=>existingReplyOriginal(f.request,{profile:{accepted:{identity:f.request.originalInstallation},previousDelivery:{operationId:randomUUID(),assistantReceipt:f.request.originalReceipt}}}),/lineage/);
});
test('existing reply refuses changed historical bytes and current candidate epoch account generation or exact message',t=>{
 const f=fixture(t),key=randomUUID(),base=f.observed(key),clocks={parentKey:f.intent.key,observationKey:key,startedAtMs:f.now,deadlineAtMs:f.now+300000};
 for(const change of [e=>e.before.health.candidateId=sha256('wrong'),e=>e.after.access.workspaceEpoch=randomUUID(),e=>e.after.state.connection.generation=randomUUID(),e=>e.after.state.operations[0].nativeRunId=randomUUID(),e=>e.accounts.accounts[0].profileId='other',e=>e.accounts.checkedAt=f.now-30000,e=>e.history.messages[0].id=randomUUID(),e=>e.history.messages[0].text+='changed',e=>e.history.messages[0].runId=randomUUID(),e=>e.httpMethods.push('POST'),e=>e.sessionCreated=true,e=>e.finishedAtMs=clocks.deadlineAtMs]){
  const e=structuredClone(base);change(e);if(e.history.messages[0].runId!==base.history.messages[0].runId)e.history.messages[0].operationId=randomUUID();assert.throws(()=>verifyExistingReplyEvidence(e,f.input,clocks));
 }
 const ref=f.request.savedReply;writeFileSync(ref.path,'{}');assert.throws(()=>existingReplyOriginal(f.request));
});
test('real journal observes once with no create draft submit and inspects the same receipt after deadline',async t=>{
 const f=fixture(t),out=await f.adapter.execute(f.context);assert.equal(out.state,'completed');assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].original,f.original);
 for(const name of ['session','create','draft','submit','saved-reply'])assert.equal(f.journal.deliveryPhase(f.input.operationId,'assistant/'+name),null);
 f.setTime(f.now+400000);assert.deepEqual((await f.adapter.inspect(f.context)).output,out.output);assert.equal(f.calls.length,1);
 await f.adapter.verify(out,f.context);
});
test('uncertain observation reconnects the original key without any replacement request',async t=>{
 const f=fixture(t),original=f.transport.observeExisting;let first=true;f.transport.observeExisting=async c=>{if(first){first=false;f.calls.push(c);throw Error('assistant-original-host-response-unavailable');}return original(c);};
 assert.equal((await f.adapter.execute(f.context)).state,'uncertain');assert.equal((await f.adapter.observe(f.context)).state,'completed');assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);
});
test('expired or rejected observation never falls back and journal refuses effect substeps',async t=>{
 const f=fixture(t);f.setTime(f.now+300000);await assert.rejects(()=>f.adapter.execute(f.context),/deadline/);assert.equal(f.calls.length,0);f.setTime(f.now);
 assert.throws(()=>f.journal.reserveDeliveryPhase(f.input.operationId,'assistant/session',{parentKey:f.intent.key,parentInputSha256:f.intent.inputSha256,deadlineAtMs:f.now+300000},f.now),/mode/);
 f.transport.observeExisting=async()=>{throw Error('existing-reply-account-changed');};assert.equal((await f.adapter.execute(f.context)).state,'failed');assert.equal((await f.adapter.observe(f.context)).state,'failed');
});
test('opt-in reference schema is strict and does not admit arbitrary policy or inference fields',t=>{
 const f=fixture(t);assert.deepEqual(existingAssistantReplySchema.parse(f.request),f.request);assert.throws(()=>existingAssistantReplySchema.parse({...f.request,allowNewReply:true}));assert.throws(()=>existingAssistantReplySchema.parse({...f.request,kind:'reuse'}));
 assert.ok(deliveryStartInputSchema.shape.existingAssistantReply);assert.ok(deliveryProfileSchema.shape.previousDelivery);
});

test('browser observation separates current native generation from historical run generation',t=>{
 const f=fixture(t),key=randomUUID(),e=f.observed(key),out=existingReplyOutput(e,f.input,f.put('current-observation.json',e),{parentKey:f.intent.key,observationKey:key,startedAtMs:f.now,deadlineAtMs:f.now+300000});
 const proof=verifyExistingReplyBrowserState(e.after.state,out);assert.equal(proof.connectionGeneration,out.observedConnectionGeneration);assert.equal(proof.historicalConnectionGeneration,out.connectionGeneration);assert.notEqual(proof.connectionGeneration,proof.historicalConnectionGeneration);
 for(const change of [s=>s.connection.generation=out.connectionGeneration,s=>s.operations[0].connectionGeneration=out.observedConnectionGeneration,s=>s.operations[0].nativeRunId=randomUUID(),s=>s.conversations[0].accountSelection.profileId='wrong']){const state=structuredClone(e.after.state);change(state);assert.throws(()=>verifyExistingReplyBrowserState(state,out));}
});

test('pending account metadata uses the maintained thirty-second TTL and refuses exact stale boundary',t=>{
 const f=fixture(t),key=randomUUID(),base=f.observed(key),clocks={parentKey:f.intent.key,observationKey:key,startedAtMs:f.now,deadlineAtMs:f.now+300000};
 base.accounts.checkedAt=base.startedAtMs-1;assert.doesNotThrow(()=>verifyExistingReplyEvidence(base,f.input,clocks));
 for(const at of [base.finishedAtMs-30000,base.finishedAtMs+1,base.finishedAtMs-0.5]){const stale=structuredClone(base);stale.accounts.checkedAt=at;assert.throws(()=>verifyExistingReplyEvidence(stale,f.input,clocks),/fresh-accounts/);}
});

test('retained transcript proves exact saved reply with explicit unverified native activity coverage',t=>{
 const f=fixture(t),key=randomUUID(),e=f.observed(key),clocks={parentKey:f.intent.key,observationKey:key,startedAtMs:f.now,deadlineAtMs:f.now+300000};
 e.history.activeRunIds=null;e.history.retained={complete:true,capturedAt:'2026-11-17T00:00:00.000Z'};e.history.transcript={complete:true,conflicts:0,bindings:[{nativeId:f.original.accepted.nativeId,complete:true,status:'complete'}]};
 const out=existingReplyOutput(e,f.input,f.put('retained-observation.json',e),clocks);assert.equal(out.nativeRunActivityCoverage,'unverified-retained-history');verifyExistingReplyAcceptance(out,f.input);assert.equal(e.history.activeRunIds,null);
 for(const change of [h=>delete h.retained,h=>h.retained.complete=false,h=>h.transcript.complete=false,h=>h.transcript.conflicts=1,h=>h.transcript.bindings[0].nativeId=randomUUID(),h=>h.transcript.bindings.push({...h.transcript.bindings[0]}),h=>h.transcript.bindings[0].complete=false,h=>h.transcript.bindingUnavailable=true,h=>h.messages[0].runId=randomUUID(),h=>h.messages[0].operationId=randomUUID(),h=>h.inFlightRun={id:randomUUID()},h=>h.messages.push({role:'tool'})]){const bad=structuredClone(e);change(bad.history);assert.throws(()=>verifyExistingReplyEvidence(bad,f.input,clocks));}
});
