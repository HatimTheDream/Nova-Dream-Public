import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ReleaseJournal} from '../scripts/release-coordinate.mjs';
import {frontendRefreshProof,frontendRefreshSourceSha256} from '../scripts/release-delivery-frontend-refresh.mjs';
import { frontendExecutionRequest,buildFrontendExecutionProgram,classifyFrontendExecution,invokeFrontendExecution,createFrontendExecutionAdapter } from '../scripts/release-delivery-frontend-executor.mjs';
import { sha256 } from '../scripts/release-plan.mjs';
function fixture(){
  const operationId=randomUUID(),root=`/var/lib/nova-update/frontend/operator-inputs/${operationId}`,ref=(path,char)=>({path,sha256:char.repeat(64)});
  const input={format:1,operationId,baseVersion:'2.3.0',baseCandidateId:'a'.repeat(64),serviceInputsSha256:'b'.repeat(64),frontendId:'c'.repeat(64),sourceRevision:'d'.repeat(40),version:'2.3.1',buildVersion:'1.0.288',worker:{path:'/opt/nova-updater-2.3.0-aaaaaaaaaaaa/deploy/update-runner/frontend.py',sha256:'73ca5399f703f20512a925b0cdb10dde1dfa9b733966d47b5cbdd1f20c34b171'},config:ref('/etc/nova-update/frontend.json','e'),operation:ref(`${root}/operation.json`,'f'),assets:{manifest:ref(`${root}/frontend.json`,'1'),signature:ref(`${root}/frontend.sig`,'2'),archive:ref(`${root}/frontend.tgz`,'3')},processIdentity:randomUUID(),workspaceEpoch:randomUUID()};
  const base={candidateId:input.baseCandidateId,serviceInputsSha256:input.serviceInputsSha256,apiVersion:1,schemaVersion:55};
  const plan={format:1,operationId,operationSha256:input.operation.sha256,configSha256:input.config.sha256,manifestSha256:input.assets.manifest.sha256,signatureSha256:input.assets.signature.sha256,archiveSha256:input.assets.archive.sha256,frontendId:input.frontendId,live:{...base,epoch:input.workspaceEpoch,active:false},health:{...base,epoch:input.workspaceEpoch,processIdentity:input.processIdentity},priorRecovery:{base}};
  const planBytes=Buffer.from(JSON.stringify(plan)+'\n'),request=frontendExecutionRequest({operationId,runId:randomUUID(),planInput:input,planSha256:sha256(planBytes),intentSha256:'9'.repeat(64)}),requestSha256=sha256(Buffer.from(JSON.stringify(request)+'\n'));
  const journal={...plan,planSha256:request.workerPlan.sha256,phase:'completed',outcome:'selected'},native=Buffer.from(JSON.stringify(journal)+'\n');
  const dispatch={format:1,operationId,runId:request.runId,requestSha256,action:'execute',unit:`nova-frontend-${request.runId}-execute.service`,runtimeMaxSeconds:120,timeoutStopSeconds:15,createdAtMs:1000,deadlineAtMs:136000,bootId:randomUUID(),monotonicDeadlineNs:999};
  const effectiveProfile={Type:'exec',Restart:'no',KillMode:'control-group',MemoryMax:String(768*1024**2),MemorySwapMax:'0',NoNewPrivileges:'yes',ProtectSystem:'strict',RuntimeMaxUSec:120000000,TimeoutStopUSec:15000000,CPUQuotaPerSecUSec:500000,ReadWritePaths:['/opt/nova/frontend','/var/lib/nova-update/frontend']};
  const started={binding:dispatch,pid:123,invocationId:'a'.repeat(32),effectiveProfile,unitProperties:{InvocationID:'a'.repeat(32),MainPID:'123',ControlGroup:`/system.slice/${dispatch.unit}`}};
  const result={state:'completed',reason:'frontend-selected-original-service-preserved',operationId,runId:request.runId,requestSha256,journal,journalSha256:sha256(native),journalRawBase64:native.toString('base64'),dispatch,started,unit:{LoadState:'not-found',ActiveState:'inactive',MainPID:'0',ControlPID:'0'},workerResult:{binding:dispatch,returncode:0,invocationId:started.invocationId},savedReplyAccepted:false,browserAccepted:false};
  const recovery={format:1,kind:'nova-maintained-frontend-plan',operationId,workerSha256:input.worker.sha256,plan,planRawBase64:planBytes.toString('base64'),planSha256:sha256(planBytes),readOnly:true,capacityQualified:false,effectDispatchQualified:false,stagedExecution:{kind:'nova-protected-frontend-execution-input',complete:true,request,requestSha256}};
  const prior={route:{route:'frontend',serviceInputsSha256:input.serviceInputsSha256},recovery,publication:{frontendId:input.frontendId}},descriptor={operation:{id:operationId,priorCandidateId:input.baseCandidateId,version:input.version,buildVersion:input.buildVersion},sources:{private:{commit:input.sourceRevision}}};
  return {input,request,result,prior,descriptor};
}
function localTransport(){
  const root=fileURLToPath(new URL(`../support/fixtures/frontend-executor-${randomUUID()}/`,import.meta.url));mkdirSync(root,{recursive:true});
  const put=(name,bytes)=>{const folder=name==='ssh.conf'||name==='transport.json'?root:join(root,'delivery-evidence');mkdirSync(folder,{recursive:true});const path=join(folder,name);if(existsSync(path))assert.deepEqual(readFileSync(path),bytes);else writeFileSync(path,bytes,{flag:'wx'});return {path,sha256:sha256(bytes)};};
  const ssh=put('ssh.conf',Buffer.from('Host fixed\n HostName example.invalid\n')),transport=put('transport.json',Buffer.from(JSON.stringify({format:1,sshConfig:ssh,hostAlias:'fixed'})));return {root,transport,put};
}
function programData(program){return [...program.matchAll(/b64decode\('([^']+)'/g)].map(m=>JSON.parse(Buffer.from(m[1],'base64'))).find(v=>v.mode);}
test('fixed staged request binds exact helper and original operation for all modes',()=>{
  const f=fixture();for(const mode of ['execute','observe','resume']){const p=programData(buildFrontendExecutionProgram(f.request,mode));assert.equal(p.mode,mode);assert.equal(p.sha256,f.result.requestSha256);assert.deepEqual(JSON.parse(Buffer.from(p.requestBase64,'base64')),f.request);}
  for(const mutate of [r=>r.executor.sha256='1'.repeat(64),r=>r.planHelper.path='/other.py',r=>r.operationId=randomUUID(),r=>r.command='arbitrary']){const r=structuredClone(f.request);mutate(r);assert.throws(()=>buildFrontendExecutionProgram(r,'execute'));}
  assert.throws(()=>buildFrontendExecutionProgram(f.request,'worker'));
});
test('completed result requires exact native bytes, service, original worker and finite profile',()=>{
  const f=fixture();assert.equal(classifyFrontendExecution(f.result,f.request).state,'completed');
  for(const mutate of [v=>v.journal.phase='leased',v=>v.journalSha256='0'.repeat(64),v=>v.dispatch.runId=randomUUID(),v=>v.dispatch.deadlineAtMs++,v=>v.workerResult.returncode=1,v=>v.started.effectiveProfile.RuntimeMaxUSec=0,v=>v.started.unitProperties.ControlGroup='/other',v=>v.unit.MainPID='123',v=>v.browserAccepted=true,v=>v.savedReplyAccepted=true]){const value=structuredClone(f.result);mutate(value);assert.throws(()=>classifyFrontendExecution(value,f.request));}
  const wrong={...f.result,runId:randomUUID()};assert.equal(classifyFrontendExecution(wrong,f.request).state,'uncertain');
});
test('loaded terminal result must prove same invocation and successful exit',()=>{
  const f=fixture();f.result.unit={LoadState:'loaded',ActiveState:'inactive',MainPID:'0',ControlPID:'0',Result:'success',ExecMainStatus:'0',InvocationID:f.result.started.invocationId};assert.equal(classifyFrontendExecution(f.result,f.request).state,'completed');
  for(const change of [{InvocationID:'b'.repeat(32)},{Result:'timeout'},{ExecMainStatus:'2'}])assert.throws(()=>classifyFrontendExecution({...f.result,unit:{...f.result.unit,...change}},f.request));
});
test('lost execute response is observed using same request without repeating execution',async()=>{
  const f=fixture(),t=localTransport(),modes=[];const run=async(_target,program)=>{const p=programData(program);modes.push(p.mode);assert.equal(p.sha256,f.result.requestSha256);return modes.length===1?{uncertain:true}:{exitCode:0,stdout:JSON.stringify(f.result)};};
  const a=await invokeFrontendExecution({transport:t.transport,request:f.request},'execute',{run});assert.equal(a.state,'uncertain');
  const b=await invokeFrontendExecution({transport:t.transport,request:f.request},'observe',{run});assert.equal(b.state,'completed');assert.deepEqual(modes,['execute','observe']);
});
test('adapter checks prerequisites before one initial effect and reconciles lost result from original receipt',async()=>{
  const f=fixture(),t=localTransport(),modes=[];let checks=0;
  const run=async(_target,program)=>{const p=programData(program);modes.push(p.mode);return modes.length===1?{uncertain:true}:{exitCode:0,stdout:JSON.stringify(f.result)};};
  const adapter=createFrontendExecutionAdapter({transport:t.transport,run,storeReceipt:(_j,k,name,bytes)=>t.put(k+'-'+name,bytes)}),input=await adapter.input(f),context={...f,input,intent:{input,key:randomUUID()},journal:{directory:t.root},beforeNewEffect:async()=>{checks++;}};
  adapter.validate(context);assert.equal((await adapter.execute(context)).state,'uncertain');const value=await adapter.observe(context);await adapter.verify(value,context);assert.equal(value.state,'completed');assert.equal(checks,1);assert.deepEqual(modes,['execute','observe']);
  assert.deepEqual(await adapter.observe(context),value);assert.equal(checks,1);
  assert.deepEqual(await adapter.execute(context),value);assert.equal(checks,1);assert.equal(modes.filter(x=>x==='execute').length,1);
  const changed=structuredClone(f);changed.prior.recovery.stagedExecution.request.planInput.processIdentity=randomUUID();await assert.rejects(adapter.input(changed));
});

test('durable genuine refresh witness survives real SQLite reopen without duplicate execute or fabricated proof',async t=>{
  const f=fixture(),local=localTransport(),journal=Object.create(ReleaseJournal.prototype);journal.directory=local.root;journal.readOnly=false;journal.db=new DatabaseSync(join(local.root,'journal.sqlite'));
  const schema=readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8').match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}',String(0x4e56524c));journal.db.exec(schema);
  const now=Date.now(),commits={private:f.input.sourceRevision,public:'e'.repeat(40)},descriptor={format:1,operation:{...f.descriptor.operation,stage:'draft',candidateId:null,publicCandidateId:null,workspaceEpoch:f.input.workspaceEpoch,agentVersion:'2026.9.8',priorAgentVersion:'2026.9.8',sourceCommits:commits,bundleSha256:null,trustedPublicKeySha256:'a'.repeat(64),changeClass:'application',helperHashes:null},sources:Object.fromEntries(['private','public'].map(side=>[side,{root:join(local.root,side),repository:'fixture/'+side,commit:commits[side],baseCommit:'f'.repeat(40),branch:'main'}])),target:local.transport,targetIdentity:'b'.repeat(64),adapterIdentity:'c'.repeat(64),observationBudgetMs:14400000,timeline:{startedAtMs:now,original:{id:randomUUID(),step:'total',issuedAtMs:now,remainingMs:[600000,1200000],confidence:'low',basis:'Focused local SQLite fixture.',reason:'Test only.',nextCheckpointAtMs:now+300000},revisions:[],reviews:[],lastCheckpointAtMs:now}};
  journal.initializeDelivery(descriptor,now);
  t.after(()=>journal.close());const modes=[],adapter=createFrontendExecutionAdapter({transport:local.transport,storeReceipt:(_j,key,name,bytes)=>local.put(key+'-'+name,bytes),run:async(_target,program,options)=>{const p=programData(program);modes.push(p.mode);if(p.mode==='execute'){assert.equal(options.captureDiagnostics,true);assert.ok(program.includes("_refresh_scope['refresh']"));assert.ok(existsSync(join(local.root,'delivery-evidence',key+'-frontend-app-refresh-dispatch.json')));return{uncertain:true};}return{exitCode:0,stdout:JSON.stringify(f.result)};}});
  const input=await adapter.input(f),intent=journal.reserveDeliveryPhase(descriptor.operation.id,'installation',input,now).intent,key=intent.key;
  let context={...f,descriptor,input,intent,journal,beforeNewEffect:async()=>{}};assert.equal((await adapter.execute(context)).state,'uncertain');
  journal.close();journal.db=new DatabaseSync(join(local.root,'journal.sqlite'));context={...context,intent:journal.deliveryPhase(descriptor.operation.id,'installation')};assert.equal(context.intent.key,key);
  const completed=await adapter.execute(context);assert.equal(completed.state,'completed');assert.deepEqual(modes,['execute','observe']);
  const dispatch=JSON.parse(readFileSync(join(local.root,'delivery-evidence',key+'-frontend-app-refresh-dispatch.json')));assert.equal(dispatch.refreshSourceSha256,frontendRefreshSourceSha256);assert.equal(dispatch.requestSha256,f.result.requestSha256);assert.equal(dispatch.automaticReplayPermitted,false);
  assert.equal(existsSync(join(local.root,'delivery-evidence',key+'-frontend-app-refresh-proof.json')),false);
  writeFileSync(join(local.root,'delivery-evidence',key+'-frontend-app-refresh-dispatch.json'),JSON.stringify({...dispatch,requestSha256:'0'.repeat(64)}));await assert.rejects(adapter.observe(context),/original-refresh-dispatch-changed/);assert.deepEqual(modes,['execute','observe']);
});

test('captured actual refresh proof must preserve process/workspace and finite timing without inventing missing output',()=>{
 const f=fixture(),p=f.request.planInput,v={format:1,kind:'actual-app-update-check-before-frontend-execute',candidateId:p.baseCandidateId,processIdentity:p.processIdentity,epoch:p.workspaceEpoch,genuineAppHeartbeat:true,directControllerHeartbeat:false,elapsedMs:962,afterCheckElapsedMs:198,credentialsRecorded:false};
 assert.deepEqual(frontendRefreshProof({stderr:JSON.stringify(v)+'\n'},f.request),v);assert.equal(frontendRefreshProof({},f.request),null);
 for(const delta of [{epoch:randomUUID()},{processIdentity:randomUUID()},{afterCheckElapsedMs:5001},{directControllerHeartbeat:true},{credentialsRecorded:true}])assert.throws(()=>frontendRefreshProof({stderr:JSON.stringify({...v,...delta})},f.request));
 assert.throws(()=>frontendRefreshProof({stderr:JSON.stringify(v)+'\n'+JSON.stringify(v)},f.request),/ambiguous/);
});
test('only qualified original closure permits maintained resume and refreshes prerequisites first',async()=>{
  const f=fixture(),t=localTransport(),modes=[];let checks=0;
  const uncertain={operationId:f.request.operationId,runId:f.request.runId,requestSha256:f.result.requestSha256,state:'uncertain',reason:'frontend-closed-worker-result-missing',resumeEligible:true};
  const run=async(_target,program)=>{const mode=programData(program).mode;modes.push(mode);if(mode==='resume')assert.equal(checks,1);return {exitCode:0,stdout:JSON.stringify(mode==='observe'?uncertain:f.result)};};
  const adapter=createFrontendExecutionAdapter({transport:t.transport,run,storeReceipt:(_j,k,name,bytes)=>t.put(k+'-'+name,bytes)}),input=await adapter.input(f),context={...f,input,intent:{input,key:randomUUID()},journal:{directory:t.root},beforeNewEffect:async()=>{checks++;}};
  assert.equal((await adapter.observe(context)).state,'completed');assert.deepEqual(modes,['observe','resume']);assert.equal(checks,1);
  await assert.rejects(adapter.observe({...context,beforeNewEffect:undefined}),/prerequisite-check-required/);
});
test('unqualified uncertainty never resumes and missing protected producer blocks before transport',async()=>{
  const f=fixture(),t=localTransport(),modes=[];const run=async(_target,program)=>{modes.push(programData(program).mode);return {exitCode:0,stdout:JSON.stringify({operationId:f.request.operationId,runId:f.request.runId,requestSha256:f.result.requestSha256,state:'uncertain',reason:'frontend-worker-start-not-captured'})};};
  const adapter=createFrontendExecutionAdapter({transport:t.transport,run,storeReceipt:(_j,k,name,bytes)=>t.put(k+'-'+name,bytes)}),input=await adapter.input(f),context={...f,input,intent:{input,key:randomUUID()},journal:{directory:t.root},beforeNewEffect:async()=>assert.fail('no effect')};
  assert.equal((await adapter.observe(context)).state,'uncertain');assert.deepEqual(modes,['observe']);await assert.rejects(adapter.input({...f,prior:{}}),/stager-required/);
});
