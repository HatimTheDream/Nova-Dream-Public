import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { frontendStagePacket,buildFrontendStageProgram,verifyStageReceipt,verifyCapacity,createFrontendStageCapacityAdapter,createFrontendBoundRecoveryAdapter } from '../scripts/release-delivery-frontend-stage.mjs';
import { sha256 } from '../scripts/release-plan.mjs';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),enc=v=>Buffer.from(canonical(v)+'\n');
function fixture(){
  const root=fileURLToPath(new URL(`../support/fixtures/frontend-stage-${randomUUID()}/`,import.meta.url));mkdirSync(root,{recursive:true});mkdirSync(join(root,'delivery-evidence'));
  const put=(name,bytes)=>{const path=join(root,name);if(existsSync(path))assert.deepEqual(readFileSync(path),bytes);else writeFileSync(path,bytes,{flag:'wx'});return {path,sha256:sha256(bytes)};};
  const op={id:randomUUID(),priorCandidateId:'a'.repeat(64),workspaceEpoch:randomUUID(),version:'2.3.1',buildVersion:'1.0.288'},source='d'.repeat(40),archive=Buffer.from('archive');
  const manifest={frontendId:'c'.repeat(64),sourceRevision:source,frontendVersion:op.version,frontendBuildVersion:op.buildVersion,base:{candidateId:op.priorCandidateId,serviceInputsSha256:'b'.repeat(64)},artifact:{sha256:sha256(archive),bytes:archive.length}};
  const assets={manifest:put('manifest.json',enc(manifest)),signature:put('signature.sig',Buffer.alloc(64)),archive:put('archive.tgz',archive)};
  const options={baseVersion:'2.3.0',worker:{path:'/opt/nova-updater-2.3.0-aaaaaaaaaaaa/deploy/update-runner/frontend.py',sha256:'73ca5399f703f20512a925b0cdb10dde1dfa9b733966d47b5cbdd1f20c34b171'},config:{path:'/etc/nova-update/frontend.json',sha256:'e'.repeat(64)}};
  const descriptor={operation:op,sources:{private:{commit:source}}},prior={route:{route:'frontend',serviceInputsSha256:'b'.repeat(64)},sign:{frontendId:'c'.repeat(64),...assets}};
  const input={operation:op,sourceRevision:source,serviceInputsSha256:'b'.repeat(64),frontendId:'c'.repeat(64),...options,assets};
  const ssh=put('ssh.conf',Buffer.from('Host fixed\n HostName example.invalid\n')),transport=put('transport.json',enc({format:1,sshConfig:ssh,hostAlias:'fixed'}));
  return {root,put,descriptor,prior,input,options,transport,storeReceipt:(_j,key,name,bytes)=>put('delivery-evidence/'+key+'-'+name,bytes)};
}
function cap(staged=false){const newBytes=10000000;return {format:1,kind:'measured-frontend-stage-capacity',stagedInputsAlreadyPaid:staged,expectedReclaimBytes:0,newRecoveryCopies:0,temporaryWritesBytes:0,filesystemGroups:[{device:1,paths:['/var/lib/nova-update/frontend','/opt/nova/frontend'],blockBytes:4096,freeBytes:10*1024**3,freeInodes:10000,newBytes,newInodes:100,reserveBytes:1536*1024**2,allowanceBytes:256*1024**2,requiredFreeBytes:newBytes+1792*1024**2,requiredFreeInodes:1124}]};}
function stageFacts(packet){
  const root='/var/lib/nova-update/frontend/operator-inputs/'+packet.operationId;
  const planInput={format:packet.format,...(packet.format===2?{workerInstallation:packet.workerInstallation}:{}),...Object.fromEntries(['operationId','baseVersion','baseCandidateId','serviceInputsSha256','frontendId','sourceRevision','version','buildVersion','worker','config','workspaceEpoch'].map(k=>[k,packet[k]])),operation:{path:root+'/operation.json',sha256:packet.files['operation.json'].sha256},assets:Object.fromEntries([['manifest','json'],['signature','sig'],['archive','tgz']].map(([role,suffix])=>[role,{path:root+'/frontend.'+suffix,sha256:packet.files['frontend.'+suffix].sha256}])),processIdentity:randomUUID()};
  const identity={format:1,operationId:packet.operationId,runId:packet.runId,packetSha256:sha256(enc(packet)),inputDirectory:root,planInput,files:Object.fromEntries(Object.entries(packet.files).map(([name,row])=>[name,{path:root+'/'+name,sha256:row.sha256,bytes:row.bytes}]))};
  const plan={format:1,kind:'frontend-protected-stage-plan',readOnly:true,identity,capacity:cap(),observedAtMs:1000};
  const intent={format:1,operationId:packet.operationId,runId:packet.runId,packetSha256:identity.packetSha256,planSha256:sha256(enc(plan))};
  return {plan,receipt:{format:1,kind:'protected-frontend-input-stage',identity,intent,preStageCapacity:cap(),staged:true}};
}
function data(program){return JSON.parse(Buffer.from(program.match(/b64decode\('([^']+)'/)[1],'base64'));}
test('packet uses exact six fixed paths and does not let caller supply code files',()=>{
  const f=fixture(),packet=frontendStagePacket(f.input,randomUUID());assert.deepEqual(Object.keys(packet.files).sort(),['frontend-executor.py','frontend-plan.py','frontend.json','frontend.sig','frontend.tgz','operation.json']);
  const wire=data(buildFrontendStageProgram({mode:'plan',packet}));assert.equal(sha256(Buffer.from(wire.sourceBase64,'base64')),wire.sourceSha256);assert.deepEqual(wire.value.packet,packet);
  assert.throws(()=>frontendStagePacket({...f.input,frontendId:'9'.repeat(64)},packet.runId),/signed-input-changed/);assert.throws(()=>buildFrontendStageProgram({mode:'delete',packet}));
});
test('capacity refuses lower reserves, missing filesystem, low space and invented reclaim',()=>{
  verifyCapacity(cap(),{staged:false});for(const mutate of [v=>v.expectedReclaimBytes=1,v=>v.filesystemGroups[0].reserveBytes=0,v=>v.filesystemGroups[0].paths.pop(),v=>v.filesystemGroups[0].freeBytes=1,v=>v.filesystemGroups[0].freeInodes=1,v=>v.filesystemGroups[0].requiredFreeBytes=1]){const v=cap();mutate(v);assert.throws(()=>verifyCapacity(v,{staged:false}));}
  assert.throws(()=>verifyCapacity(cap(),{staged:true}));
});
test('stage packet and receipt keep independent tool installation separate from current service',async()=>{
  const f=fixture();Object.assign(f.options,{baseVersion:'2.3.1',workerInstallation:{version:'2.3.0',candidateId:'e'.repeat(64)}});
  f.options.worker={...f.options.worker,path:'/opt/nova-updater-2.3.0-eeeeeeeeeeee/deploy/update-runner/frontend.py'};
  const adapter=createFrontendStageCapacityAdapter({...f,run:async()=>assert.fail('No host call')}),input=await adapter.input(f);
  const packet=frontendStagePacket(input,randomUUID()),facts=stageFacts(packet);
  assert.equal(packet.format,2);assert.equal(packet.baseCandidateId,f.descriptor.operation.priorCandidateId);
  assert.deepEqual(packet.workerInstallation,f.options.workerInstallation);verifyStageReceipt(facts.receipt,packet);
  for(const mutate of [v=>v.identity.planInput.workerInstallation.candidateId='f'.repeat(64),v=>v.identity.planInput.baseCandidateId='e'.repeat(64),v=>v.identity.planInput.format=1]){
    const receipt=structuredClone(facts.receipt);mutate(receipt);assert.throws(()=>verifyStageReceipt(receipt,packet));
  }
});
test('stage receipt binds all original service/source/config/assets and operation identities',()=>{
  const f=fixture(),packet=frontendStagePacket(f.input,randomUUID()),facts=stageFacts(packet);verifyStageReceipt(facts.receipt,packet);
  for(const mutate of [v=>v.identity.runId=randomUUID(),v=>v.identity.planInput.workspaceEpoch=randomUUID(),v=>v.identity.planInput.config.sha256='8'.repeat(64),v=>v.identity.planInput.assets.archive.sha256='8'.repeat(64),v=>v.identity.planInput.version='2.3.2',v=>v.identity.files['operation.json'].path='/other']){const v=structuredClone(facts.receipt);mutate(v);assert.throws(()=>verifyStageReceipt(v,packet));}
});
test('lost stage response preserves original dispatch and only observes original stage',async()=>{
  const f=fixture(),modes=[];let facts,checks=0;
  const run=async(_t,program)=>{const {value}=data(program);modes.push(value.mode);facts??=stageFacts(value.packet);if(value.mode==='plan')return {exitCode:0,stdout:JSON.stringify(facts.plan)};if(value.mode==='stage'){assert.equal(checks,1);assert.ok(existsSync(join(f.root,'delivery-evidence',value.packet.runId+'-frontend-stage-dispatch.json')));return {uncertain:true};}if(value.mode==='capacity')return {exitCode:0,stdout:JSON.stringify({kind:'frontend-stage-capacity-reverified',operationId:value.packet.operationId,runId:value.packet.runId,readOnly:true,capacity:cap(true)})};return {exitCode:0,stdout:JSON.stringify(facts.receipt)};};
  const adapter=createFrontendStageCapacityAdapter({...f,run}),input=await adapter.input(f),context={...f,input,intent:{input,key:randomUUID()},journal:{directory:f.root},beforeNewEffect:async()=>{checks++;}};
  adapter.validate(context);assert.equal((await adapter.execute(context)).state,'uncertain');const value=await adapter.observe(context);assert.equal(value.state,'completed');await adapter.verify(value,context);assert.deepEqual(modes,['plan','stage','observe','capacity']);assert.equal(checks,1);
  const again=await adapter.observe(context);assert.deepEqual(again,value);assert.equal(modes.filter(m=>m==='stage').length,1);
});
test('lost bind result retains actual original plan and never reissues the binding effect',async()=>{
  const f=fixture(),packet=frontendStagePacket(f.input,randomUUID()),facts=stageFacts(packet),i=facts.receipt.identity.planInput;
  f.prior.capacity={kind:'nova-delivery-frontend-capacity',operationId:packet.operationId,capacityQualified:true,packetInput:f.input,runId:packet.runId,stageReceipt:facts.receipt,frontendStage:{kind:'nova-protected-frontend-stage',planInput:i}};
  const base={candidateId:i.baseCandidateId,serviceInputsSha256:i.serviceInputsSha256,apiVersion:1,schemaVersion:55};
  const plan={format:1,operationId:i.operationId,operationSha256:i.operation.sha256,configSha256:i.config.sha256,manifestSha256:i.assets.manifest.sha256,signatureSha256:i.assets.signature.sha256,archiveSha256:i.assets.archive.sha256,frontendId:i.frontendId,live:{...base,epoch:i.workspaceEpoch,active:false},health:{...base,epoch:i.workspaceEpoch,processIdentity:i.processIdentity},priorRecovery:{base}};
  const raw=enc(plan),recovery={format:1,kind:'nova-maintained-frontend-plan',operationId:i.operationId,workerSha256:i.worker.sha256,plan,planRawBase64:raw.toString('base64'),planSha256:sha256(raw),readOnly:true,capacityQualified:false,effectDispatchQualified:false};
  const modes=[];let checks=0,binding;
  const run=async(_t,program)=>{const wire=data(program);if(wire.input){modes.push('native-plan');return {exitCode:0,stdout:JSON.stringify(recovery)};}
    const v=wire.value;modes.push(v.mode);const request=JSON.parse(Buffer.from(v.requestBase64,'base64'));binding??={format:1,kind:'protected-frontend-execution-binding',operationId:packet.operationId,runId:packet.runId,requestSha256:sha256(Buffer.from(v.requestBase64,'base64')),planSha256:request.workerPlan.sha256,capacity:cap(true),complete:true};
    if(v.mode==='bind'){assert.equal(checks,1);return {uncertain:true};}return {exitCode:0,stdout:JSON.stringify(binding)};};
  const adapter=createFrontendBoundRecoveryAdapter({...f,run}),input=await adapter.input(f),context={...f,input,intent:{input,key:randomUUID()},journal:{directory:f.root},beforeNewEffect:async()=>{checks++;}};
  adapter.validate(context);assert.equal((await adapter.execute(context)).state,'uncertain');const result=await adapter.observe(context);assert.equal(result.state,'completed');await adapter.verify(result,context);assert.equal(checks,1);assert.deepEqual(modes,['native-plan','bind','bind-observe','bind-observe']);assert.equal(result.output.stagedExecution.request.planInput.processIdentity,i.processIdentity);
});
test('private refusal and lost-response diagnostics retain cause without replaying stage',async()=>{
  const f=fixture(),modes=[];let facts,refuse=true;
  const run=async(_t,program,options)=>{assert.equal(options.captureDiagnostics,true);const {value}=data(program);modes.push(value.mode);facts??=stageFacts(value.packet);
    if(value.mode==='plan'&&refuse)return {exitCode:2,stdout:JSON.stringify({state:'uncertain',reason:'frontend-stage-original-result-unavailable',privateDiagnostic:{mode:'plan',exceptionType:'RuntimeError',message:'frontend-capacity-insufficient'}}),stderr:'private context'};
    if(value.mode==='plan')return {exitCode:0,stdout:JSON.stringify(facts.plan)};
    return {uncertain:true,reasonCode:'transport-timeout',stdout:'partial original response',stderr:'original transport detail'};};
  const adapter=createFrontendStageCapacityAdapter({...f,run}),input=await adapter.input(f),context={...f,input,intent:{input,key:randomUUID()},journal:{directory:f.root},beforeNewEffect:async()=>{}};
  const one=await adapter.execute(context);assert.equal(one.state,'uncertain');assert.equal(one.reason,'frontend-stage-plan-unavailable');await adapter.verify(one,context);
  let diagnostic=JSON.parse(readFileSync(one.output.privateDiagnostic.path));assert.match(diagnostic.transport.stdout,/frontend-capacity-insufficient/);assert.equal(diagnostic.transport.stderr,'private context');assert.equal(diagnostic.mode,'plan');
  refuse=false;const two=await adapter.observe(context);assert.equal(two.state,'uncertain');diagnostic=JSON.parse(readFileSync(two.output.privateDiagnostic.path));assert.equal(diagnostic.transport.reasonCode,'transport-timeout');assert.equal(diagnostic.transport.stdout,'partial original response');assert.equal(diagnostic.transport.stderr,'original transport detail');assert.equal(diagnostic.mode,'stage');
  await adapter.observe(context);assert.deepEqual(modes,['plan','plan','stage','observe']);assert.equal(modes.filter(m=>m==='stage').length,1);
});
test('fixed Python exception envelope preserves bounded exact private refusal',()=>{
  const f=fixture(),program=buildFrontendStageProgram({mode:'plan',packet:frontendStagePacket(f.input,randomUUID())});
  // Force only the disposable child's platform probe so this refusal remains
  // a no-effect check even when CI invokes the test as root on Linux.
  const result=spawnSync(process.env.NOVA_TEST_PYTHON??'python3',['-B','-'],{input:"import sys\nsys.platform='fixture-unsupported'\n"+program,encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,2);const value=JSON.parse(result.stdout);assert.equal(value.state,'uncertain');assert.equal(value.privateDiagnostic.mode,'plan');assert.equal(value.privateDiagnostic.exceptionType,'RuntimeError');assert.equal(value.privateDiagnostic.message,'frontend-stage-needs-linux-root');
});
test('maintained SSH transport keeps opt-in failure streams while preserving default shape',async()=>{
  const full=readFileSync(new URL('../scripts/release-adapters.mjs',import.meta.url),'utf8');
  const start=full.indexOf('export function runInstallTransport('),end=full.indexOf('\nexport ',start+1);const source=full.slice(start,end<0?undefined:end).replace(/^export /,'');
  async function call(captureDiagnostics){
    const spawn=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.kill=()=>{};child.stdin.end=()=>queueMicrotask(()=>{child.stdout.emit('data',Buffer.from('partial'));child.stderr.emit('data',Buffer.from('failure detail'));child.emit('close',2);});return child;};
    const fn=runInNewContext('('+source+')',{spawn,setTimeout,clearTimeout});return fn({sshConfig:{path:'fixed.conf'},hostAlias:'fixed'},'program',{captureDiagnostics});
  }
  const plain=await call(false),diagnostic=await call(true);assert.deepEqual(JSON.parse(JSON.stringify(plain)),{stdout:'partial',exitCode:2});assert.equal(diagnostic.stderr,'failure detail');assert.equal(diagnostic.stdout,'partial');assert.equal(diagnostic.diagnosticsTruncated,false);
});
test('zero-exit malformed native plan preserves original private response without binding',async()=>{
  const f=fixture(),packet=frontendStagePacket(f.input,randomUUID()),facts=stageFacts(packet);
  f.prior.capacity={kind:'nova-delivery-frontend-capacity',operationId:packet.operationId,capacityQualified:true,packetInput:f.input,runId:packet.runId,stageReceipt:facts.receipt,frontendStage:{kind:'nova-protected-frontend-stage',planInput:facts.receipt.identity.planInput}};
  let calls=0;const run=async(_target,program,options)=>{calls++;assert.ok(data(program).input);assert.equal(options.captureDiagnostics,true);return {exitCode:0,stdout:'{original malformed',stderr:'retained parser context'};};
  const adapter=createFrontendBoundRecoveryAdapter({...f,run}),input=await adapter.input(f),context={...f,input,intent:{input,key:randomUUID()},journal:{directory:f.root},beforeNewEffect:async()=>assert.fail('No binding may be dispatched')};
  const result=await adapter.execute(context);assert.equal(result.state,'uncertain');assert.equal(calls,1);await adapter.verify(result,context);
  const diagnostic=JSON.parse(readFileSync(result.output.privateDiagnostic.path));assert.equal(diagnostic.mode,'native-plan');assert.equal(diagnostic.parseFailure,true);assert.equal(diagnostic.transport.exitCode,0);assert.equal(diagnostic.transport.stdout,'{original malformed');assert.equal(diagnostic.transport.stderr,'retained parser context');
  assert.equal(existsSync(join(f.root,'delivery-evidence',context.intent.key+'-frontend-bind-dispatch.json')),false);
});
