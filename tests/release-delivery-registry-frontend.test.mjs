import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ReleaseJournal} from '../scripts/release-coordinate.mjs';
import {stepDelivery} from '../scripts/release-deliver.mjs';
import {createDeliveryRegistry,deliveryPhaseIntegrationGaps,deliveryTargetSchema} from '../scripts/release-delivery-adapters.mjs';
import {sha256} from '../scripts/release-plan.mjs';
import {createCiAdapter} from '../scripts/release-delivery-ci-adapter.mjs';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),enc=v=>Buffer.from(canonical(v)+'\n');
test('private target supports explicit installed worker identity with strict fields',()=>{
  const ref={path:'/private/config',sha256:'a'.repeat(64)},workerInstallation={version:'2.3.0',candidateId:'e'.repeat(64)};
  const target={format:1,transport:ref,frontendHost:{baseVersion:'2.3.1',worker:ref,config:ref,workerInstallation},browserCapability:'unavailable'};
  assert.deepEqual(deliveryTargetSchema.parse(target).frontendHost.workerInstallation,workerInstallation);
  assert.throws(()=>deliveryTargetSchema.parse({...target,frontendHost:{...target.frontendHost,workerInstallation:{...workerInstallation,command:'arbitrary'}}}));
});
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
function data(program){return [...program.matchAll(/b64decode\('([^']+)'/g)].map(m=>JSON.parse(Buffer.from(m[1],'base64'))).find(v=>v.input||v.executor||v.value);}

const schema=readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8').match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}',String(0x4e56524c));
async function assembly(t,{route='frontend',host=true,installStub=false,independent=false}={}){
  const f=fixture(),modes=[],now=1791923000000;let facts,recovery,binding,sourceInvalid=false;
  if(independent){Object.assign(f.options,{baseVersion:'2.3.1',workerInstallation:{version:'2.3.0',candidateId:'e'.repeat(64)}});f.options.worker={...f.options.worker,path:'/opt/nova-updater-2.3.0-eeeeeeeeeeee/deploy/update-runner/frontend.py'};Object.assign(f.input,f.options);}
  const target={format:1,transport:f.transport,sourceTools:{git:f.transport,python:f.transport,gitExecPath:f.root},artifactTools:{git:f.transport,python:f.transport,node:f.transport,ciNodeSha256:'f'.repeat(64),nodeToolchain:{nodeVersion:'22.23.2',platform:'win32',arch:'x64'}},bases:Object.fromEntries(['private','public'].map(side=>[side,{directory:f.root,candidateId:'a'.repeat(64),manifest:f.input.assets.manifest}])),frontend:{artifactUrl:'https://example.invalid/frontend.tgz',sequence:2,createdAt:'2026-10-13T00:00:00Z',expiresAt:'2026-10-20T00:00:00Z'},signing:{privateKeyPath:'not-executed',publicKey:f.transport,previousManifest:'initial'},...(host?{frontendHost:f.options}:{}),browserCapability:'unavailable'};
  const run=async(_target,program)=>{
    const wire=data(program);
    if(wire.input){modes.push('native-plan');const i=facts.receipt.identity.planInput,base={candidateId:i.baseCandidateId,serviceInputsSha256:i.serviceInputsSha256,apiVersion:1,schemaVersion:55};
      const plan={format:1,operationId:i.operationId,operationSha256:i.operation.sha256,configSha256:i.config.sha256,manifestSha256:i.assets.manifest.sha256,signatureSha256:i.assets.signature.sha256,archiveSha256:i.assets.archive.sha256,frontendId:i.frontendId,live:{...base,epoch:i.workspaceEpoch,active:false},health:{...base,epoch:i.workspaceEpoch,processIdentity:i.processIdentity},priorRecovery:{base}};
      const raw=enc(plan);recovery={format:1,kind:'nova-maintained-frontend-plan',operationId:i.operationId,workerSha256:i.worker.sha256,plan,planRawBase64:raw.toString('base64'),planSha256:sha256(raw),readOnly:true,capacityQualified:false,effectDispatchQualified:false};return {exitCode:0,stdout:JSON.stringify(recovery)};
    }
    if(wire.executor){modes.push('worker-'+wire.mode);const request=JSON.parse(Buffer.from(wire.requestBase64,'base64'));return {exitCode:0,stdout:JSON.stringify({operationId:request.operationId,runId:request.runId,requestSha256:sha256(Buffer.from(wire.requestBase64,'base64')),state:'uncertain',reason:'fixture-original-worker-unsettled',resumeEligible:false})};}
    const v=wire.value;modes.push(v.mode);facts??=stageFacts(v.packet);
    if(v.mode==='plan')return {exitCode:0,stdout:JSON.stringify(facts.plan)};
    if(v.mode==='stage'||v.mode==='bind')return {uncertain:true,stdout:'lost original response',stderr:'fixture only'};
    if(v.mode==='capacity')return {exitCode:0,stdout:JSON.stringify({kind:'frontend-stage-capacity-reverified',operationId:v.packet.operationId,runId:v.packet.runId,readOnly:true,capacity:cap(true)})};
    if(v.mode==='bind-observe'){const request=JSON.parse(Buffer.from(v.requestBase64,'base64'));binding??={format:1,kind:'protected-frontend-execution-binding',operationId:v.packet.operationId,runId:v.packet.runId,requestSha256:sha256(Buffer.from(v.requestBase64,'base64')),planSha256:request.workerPlan.sha256,capacity:cap(true),complete:true};return {exitCode:0,stdout:JSON.stringify(binding)};}
    return {exitCode:0,stdout:JSON.stringify(facts.receipt)};
  };
  const registry=createDeliveryRegistry({run,command:async()=>assert.fail('No external command'),receiptStore:f.storeReceipt});
  const op={...f.descriptor.operation,stage:'draft',candidateId:null,publicCandidateId:null,agentVersion:'2026.9.8',priorAgentVersion:'2026.9.8',sourceCommits:{private:'d'.repeat(40),public:'b'.repeat(40)},bundleSha256:null,trustedPublicKeySha256:'e'.repeat(64),changeClass:'application',helperHashes:null};
  const original={id:randomUUID(),step:'total',issuedAtMs:now,remainingMs:[600000,1200000],confidence:'low',basis:'Local fixture.',reason:'Original estimate.',nextCheckpointAtMs:now+300000};
  const descriptor={format:1,operation:op,sources:Object.fromEntries(['private','public'].map(side=>[side,{root:'/'+side,repository:'HatimTheDream/'+(side==='private'?'Nova-Dream':'Nova-Dream-Public'),commit:op.sourceCommits[side],baseCommit:(side==='private'?'c':'e').repeat(40),branch:'main'}])),target:f.put('target.json',enc(target)),timeline:{startedAtMs:now,original,revisions:[],reviews:[],lastCheckpointAtMs:now},adapterIdentity:await registry.identity()};descriptor.targetIdentity=await registry.targetIdentity(descriptor);
  const journal=Object.create(ReleaseJournal.prototype);journal.db=new DatabaseSync(':memory:');journal.readOnly=false;journal.directory=f.root;journal.db.exec(schema);journal.initializeDelivery(descriptor,now);t.after(()=>journal.close());
  // Only already-tested source/CI/retained candidates/package/sign/publication are
  // fixture producers; the new registry's stage, bind and worker adapters are real.
  const adapter=registry.adapter.bind(registry);registry.adapter=(phase,d,prior)=>{
    if(['capacity','recovery'].includes(phase)||phase==='installation'&&!installStub)return adapter(phase,d,prior);
    if(['assistant','browser'].includes(phase))return adapter(phase,d,prior);
    const output=phase==='route'?{...f.prior.route,route}:phase==='sign'?f.prior.sign:phase==='publication'?{frontendId:f.prior.sign.frontendId}:phase.endsWith('-ci')?{release:{id:phase==='private-ci'?123:456}}:{};
    const complete=async()=>({state:'completed',reason:'fixture-completed',receipt:null,externalId:null,output});
    return {input:async()=>({phase}),validate:async()=>{},execute:complete,observe:complete,verify:async()=>{if(phase==='private-source'&&sourceInvalid)throw Error('fixture-source-changed');}};
  };
  return {...f,target,descriptor,journal,registry,modes,now,tick:()=>stepDelivery(journal,op.id,registry,{clock:()=>now+1}),invalidate:()=>{sourceInvalid=true;}};
}
test('registry assembly resumes the same stage, binding and worker through the real SQLite journal',async t=>{
  const f=await assembly(t);let r=await f.tick();assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'capacity').state,'uncertain');const stageKey=f.journal.deliveryPhase(f.descriptor.operation.id,'capacity').key;
  r=await f.tick();assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'recovery').state,'uncertain');
  r=await f.tick();assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'installation')?.state,'uncertain',JSON.stringify(r));const installKey=f.journal.deliveryPhase(f.descriptor.operation.id,'installation').key;
  r=await f.tick();assert.equal(r.complete,false);assert.equal(f.modes.filter(m=>m==='stage').length,1);assert.equal(f.modes.filter(m=>m==='bind').length,1);assert.equal(f.modes.filter(m=>m==='worker-execute').length,1);assert.equal(f.modes.filter(m=>m==='worker-observe').length,1);
  assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'capacity').key,stageKey);assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'installation').key,installKey);assert.equal(r.originalDeadlineAtMs,f.now+1200000);
  assert.ok(r.capabilityGaps.includes('assistant-host-target-not-configured'));assert.ok(r.capabilityGaps.includes('browser-capability-unavailable'));
  const bound=f.journal.deliveryPhase(f.descriptor.operation.id,'recovery').current.output;assert.equal(bound.stagedExecution.request.runId,stageKey);
});
test('missing host capability, unknown route and full route stop before frontend effects',async t=>{
  for(const options of [{host:false},{route:'unverified'},{route:'full'}]){const f=await assembly(t,options),r=await f.tick();assert.equal(r.complete,false);assert.ok(r.integrationGaps.length);assert.deepEqual(f.modes,[]);assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'package'),null);}
});
test('format 2 worker installation survives real journal canonicalization and original-worker continuation',async t=>{
  const f=await assembly(t,{independent:true});await f.tick();await f.tick();await f.tick();const result=await f.tick();
  const phase=f.journal.deliveryPhase(f.descriptor.operation.id,'installation'),request=phase.input.request;
  assert.equal(phase.state,'uncertain');assert.equal(request.planInput.format,2);
  assert.equal(request.planInput.baseCandidateId,f.descriptor.operation.priorCandidateId);
  assert.deepEqual(request.planInput.workerInstallation,f.options.workerInstallation);
  assert.equal(request.planInput.worker.path,f.options.worker.path);
  assert.equal(f.modes.filter(m=>m==='stage').length,1);assert.equal(f.modes.filter(m=>m==='bind').length,1);
  assert.equal(f.modes.filter(m=>m==='worker-execute').length,1);assert.equal(f.modes.filter(m=>m==='worker-observe').length,1);
  assert.equal(result.originalDeadlineAtMs,f.now+1200000);assert.equal(result.complete,false);
});
test('changed completed source stops resumed assembly before another host observation or effect',async t=>{
  const f=await assembly(t);await f.tick();const modes=[...f.modes];f.invalidate();const r=await f.tick();assert.equal(r.complete,false);assert.deepEqual(f.modes,modes);assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'private-source').validation.state,'failed');
});
test('completed installation never substitutes for distinct Assistant and browser acceptance',async t=>{
  const f=await assembly(t,{installStub:true});await f.tick();await f.tick();const r=await f.tick();assert.equal(r.acceptanceGap,'assistant-host-target-not-configured');assert.ok(r.capabilityGaps.includes('browser-reload-producer-not-integrated'));assert.equal(r.complete,false);assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'assistant'),null);assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id,'browser'),null);assert.throws(()=>f.journal.completeDelivery(f.descriptor.operation.id,f.now+2),/acceptance-incomplete/);
});
test('fixed registry resolves only actual completed CI release locators and rejects handwritten target fields',async t=>{
  const f=await assembly(t),actual=createDeliveryRegistry({run:async()=>assert.fail('No host'),command:async()=>assert.fail('No network')});
  const prior={...f.prior,package:{manifest:f.prior.sign.manifest,archive:f.prior.sign.archive},sign:{...f.prior.sign,route:'frontend'},'private-ci':{release:{id:123}},'public-ci':{release:{id:456}}};
  const producer=actual.adapter('publication',f.descriptor,prior),input=await producer.input({descriptor:f.descriptor,prior});assert.deepEqual(input.releaseIds,{private:123,public:456});
  assert.equal(actual.adapter('publication',f.descriptor,{...prior,route:{route:'full'}}),null);assert.equal(actual.adapter('publication',f.descriptor,{...prior,'public-ci':{}}),null);
  assert.throws(()=>deliveryTargetSchema.parse({...f.target,frontendReleaseIds:{private:1,public:2}}));assert.deepEqual(deliveryPhaseIntegrationGaps('capacity',f.target,prior),[]);
});

test('CI receipt consumer binds the release job and exact tag identity before registry use',async t=>{
  const f=await assembly(t),source=f.descriptor.sources.private,log=f.put('ci-quality.log',Buffer.from('fixture quality\n'));
  const release={id:123,tag:'nova-v2.3.1',sourceCommit:source.commit,repository:source.repository,targetCommitish:source.commit,draft:false,prerelease:false,tagObjectType:'commit'};
  const receipt={format:1,readOnly:true,sourceVersion:'2.3.1',repositories:[{repository:'Nova-Dream',sha:source.commit,release,runs:[{id:100,runAttempt:1,name:'Nova Dream quality and release history',status:'completed',conclusion:'success',jobs:[{id:200,name:'quality',status:'completed',conclusion:'success',logSha256:log.sha256,steps:['Run npm run quality','Verify Linux update recovery'].map(name=>({name,conclusion:'success'}))},{id:201,name:'release',status:'completed',conclusion:'success'}]}]}]};
  const a=createCiAdapter('private',{tools:f.target.sourceTools,validateTools:()=>{}}),input=await a.input({descriptor:f.descriptor}),context={descriptor:f.descriptor,intent:{input,externalId:'100:1'}};
  let counter=0;async function verify(value){const ref=f.put('ci-receipt-'+(++counter)+'.json',enc(value));return a.verify({state:'completed',externalId:'100:1',receipt:ref,output:{receipt:ref,log,repository:source.repository,sourceCommit:source.commit,runId:100,runAttempt:1,release:value.repositories[0].release}},context);}
  await verify(receipt);
  for(const mutate of [v=>v.repositories[0].release.id=0,v=>v.repositories[0].release.tag='nova-v2.3.2',v=>v.repositories[0].release.sourceCommit='e'.repeat(40),v=>v.repositories[0].release.targetCommitish='e'.repeat(40),v=>v.repositories[0].runs[0].jobs[1].conclusion='failure']){const bad=structuredClone(receipt);mutate(bad);await assert.rejects(verify(bad),/ci-release-identity-changed/);}
});
