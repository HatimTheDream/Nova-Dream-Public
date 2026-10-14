/** Durable local transport for the demonstrated unchanged-native dependency route.
 * The exact maintained successor owns archive validation and member equality.
 * Changed runtime/dependency/startup contracts require their qualification producer.
 * A reserved but uncertain effect is observed, never repeated. */
import {constants,openSync,closeSync,writeFileSync,fsyncSync,existsSync,readdirSync,statfsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {frontendRegular} from './frontend-contract.mjs';
import {verifyCandidate} from './candidate.mjs';
import {verifyRetainedCandidate} from './release-delivery-package.mjs';
import {validateJournalDirectory} from './release-coordinate.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),ref=z.object({path:z.string().min(1).max(4096),sha256:hash}).strict();
const transportFields={mode:z.literal('retained-native-metadata-successor'),python:ref,helper:ref,nativeInput:ref,selectedPair:ref,selectedInstaller:ref,selectedBundle:ref};
export const dependencyTransportSchema=z.discriminatedUnion('format',[
 z.object({format:z.literal(1),...transportFields}).strict(),
 z.object({format:z.literal(2),...transportFields,metadataPolicy:z.literal('release-deliver-script-v1')}).strict(),
]);
export const DEPENDENCY_SUCCESSOR_SHA='962645b929a50754a6307d64d1ed35ac7bad51a8635737ebcc8d708b433e17c0';
export const DEPENDENCY_PARSER_SHA='e7f2617ed8d05b7d83da62e857822b737ff3a1c47b6704af5d3e1783e043b290';
const producer=fileURLToPath(new URL('./release-dependency-metadata-successor.py',import.meta.url));
export const DEPENDENCY_WORKER_SHA='3b0e74ca8a34ce9fbedd5876090997a87dda24ed17b9879c806a166055c6d615';
const workerPath=fileURLToPath(new URL('./release-dependency-local-worker.py',import.meta.url));
const MAX=128*1024**2,RESERVE=256*1024**2,WINDOW=600000;
const helpers=['install.py','recovery.py','codex_log_retention.py','app_dependencies.py','workspace_key.py','verify-session-bindings.mjs'];
const startup=['gateway.js','http.js','runtime.js','software-updates.js','store.js','update-maintenance.js','update-native-idle.js','update-native-startup.js'].map(x=>'dist/service/apps/service/'+x);
const need=(value,reason)=>{if(!value)throw Error(reason);};
const canonical=value=>JSON.stringify(value,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const encoded=value=>Buffer.from(canonical(value)+'\n');
const json=(reference,maximum=8*1024**2)=>JSON.parse(readEvidenceFile(ref.parse(reference),{maximum}));
const reference=(path,maximum=MAX)=>({path,sha256:sha256(frontendRegular(path,maximum))});
const result=(state,reason,c,output=null,receipt=null)=>({state,reason,externalId:c.intent.key,receipt,output});
const pIntent=c=>c.parentIntent??c.intent;
const rootPath=c=>join(c.journal.directory,'dependency-'+pIntent(c).key);
const assertKeys=(value,keys,reason)=>need(same(Object.keys(value).sort(),keys.slice().sort()),reason);
function writeExclusive(path,bytes){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function versionMetadataOnly(oldPackage,oldLock,newPackage,newLock,policy='version-only'){
 const a=structuredClone(oldPackage),b=structuredClone(newPackage),x=structuredClone(oldLock),y=structuredClone(newLock);
 need(a.edition3&&b.edition3&&x.packages?.['']&&y.packages?.[''],'dependency-metadata-shape-required');
 need(['version-only','release-deliver-script-v1'].includes(policy),'unsupported-dependency-metadata-policy');
 if(policy==='release-deliver-script-v1'){
  need(a.scripts&&b.scripts&&typeof a.scripts==='object'&&typeof b.scripts==='object'&&!Array.isArray(a.scripts)&&!Array.isArray(b.scripts)
   &&b.scripts['release:deliver']==='node scripts/release-deliver.mjs'&&(!Object.hasOwn(a.scripts,'release:deliver')||a.scripts['release:deliver']===b.scripts['release:deliver']),'release-command-metadata-differs');
  if(!Object.hasOwn(a.scripts,'release:deliver'))delete b.scripts['release:deliver'];
 }
 b.version=a.version;b.edition3.buildVersion=a.edition3.buildVersion;y.version=x.version;y.packages[''].version=x.packages[''].version;
 need(same(a,b)&&same(x,y),'changed-dependency-qualification-producer-required');
}
export {versionMetadataOnly};
function capacity(directory,archiveBudget=MAX){const v=statfsSync(directory,{bigint:true}),free=v.bavail*v.bsize,required=BigInt(RESERVE+archiveBudget+4*1024**2);need(free>=required,'local-dependency-capacity-insufficient');return{freeBytes:String(free),requiredBytes:String(required),archiveBudgetBytes:archiveBudget,reserveBytes:RESERVE};}
function exactBundle(referenceValue,pairReference){
 const bundle=json(referenceValue,MAX);need(bundle.format===1&&Array.isArray(bundle.files),'selected-bundle-invalid');
 assertKeys(Object.fromEntries(bundle.files.map(x=>[x.name,x])),[...helpers,'app.tgz','reviewed-pair.json'],'selected-bundle-file-set-changed');
 need(bundle.files.length===helpers.length+2,'selected-bundle-duplicate-file');
 const files={};for(const entry of bundle.files){const raw=Buffer.from(entry.data,'base64');need(raw.toString('base64')===entry.data&&sha256(raw)===entry.sha256,'selected-bundle-file-changed');files[entry.name]=raw;}
 need(sha256(files['reviewed-pair.json'])===pairReference.sha256&&files['reviewed-pair.json'].equals(readEvidenceFile(pairReference)),'selected-bundle-pair-changed');return files;
}

export function createMaintainedDependencyTransport({options:rawOptions,base,storeReceipt,run,clock=Date.now}){
 const options=dependencyTransportSchema.parse(rawOptions);
 const check=c=>{
  const parent=pIntent(c),input=parent?.input??c.input,descriptor=c.descriptor;
  need(input.route?.route==='full'&&input.route.baseCandidateId===descriptor.operation.priorCandidateId,'full-selected-base-required');
  need(descriptor.operation.agentVersion==='2026.9.8'&&descriptor.operation.priorAgentVersion===descriptor.operation.agentVersion,'changed-runtime-qualification-producer-required');
  readEvidenceFile({path:producer,sha256:DEPENDENCY_SUCCESSOR_SHA},{maximum:2*1024**2});readEvidenceFile({path:workerPath,sha256:DEPENDENCY_WORKER_SHA},{maximum:2*1024**2});readEvidenceFile(options.python,{maximum:MAX});
  need(options.helper.sha256===DEPENDENCY_PARSER_SHA,'maintained-dependency-parser-required');readEvidenceFile(options.helper,{maximum:2*1024**2});
  const candidates=Object.fromEntries(['private','public'].map(side=>[side,verifyRetainedCandidate(input.artifacts[side],descriptor.sources[side])]));
  need(candidates.private.id===input.route.targetCandidateId&&candidates.public.id===input.route.publicCandidateId,'dependency-target-candidate-changed');
  for(const candidate of Object.values(candidates))need(candidate.manifest.version===descriptor.operation.version&&candidate.manifest.buildVersion===descriptor.operation.buildVersion,'dependency-target-version-changed');
  need(base.manifest.path===join(base.directory,'dist','candidate.json'),'selected-base-manifest-path-changed');readEvidenceFile(base.manifest);const selected=verifyCandidate(base.directory);
  need(selected.id===base.candidateId&&selected.id===descriptor.operation.priorCandidateId,'selected-base-candidate-changed');
  for(const candidate of [selected,...Object.values(candidates)])need(candidate.manifest.schemaVersion===55&&candidate.manifest.apiVersion===1,'changed-schema-qualification-producer-required');
  const pair=json(options.selectedPair),installed=json(options.selectedInstaller),files=exactBundle(options.selectedBundle,options.selectedPair),anchor=json(options.nativeInput);
  need(pair.format===1&&pair.candidateId===selected.id&&installed.format===1&&installed.outcome==='completed'&&installed.candidateId===selected.id&&['savedWorkVerified','accountsVerified','recoveryVerified','healthVerified'].every(k=>installed[k]===true),'actual-selected-accepted-pair-required');
  need(sha256(files['app.tgz'])===pair.archiveSha256&&files['app.tgz'].length===pair.archiveBytes,'selected-application-archive-changed');
  need(anchor.format===1&&anchor.kind==='metadata-only-dependency-successor'&&same(anchor.helper,options.helper),'qualified-native-input-required');
  for(const value of Object.values(anchor))if(value&&typeof value==='object'&&'path'in value&&'sha256'in value)readEvidenceFile(ref.parse(value),{maximum:MAX});
  const oldDescription=json(anchor.oldMetadata);need(oldDescription.dependencyGraphSha256===pair.applicationDependencies?.dependencyGraphSha256&&oldDescription.platform==='linux'&&oldDescription.arch==='x64'&&oldDescription.nodeVersion==='22.23.2'&&oldDescription.nodeAbi===127,'selected-native-dependency-graph-changed');
  need(pair.startupBarrier?.format===1,'selected-startup-barrier-required');assertKeys(pair.startupBarrier.target,startup,'complete-selected-startup-barrier-required');
  const barrier={};for(const path of startup){const bytes=selected.bytes.get(path);need(bytes&&sha256(bytes)===pair.startupBarrier.target[path],'selected-startup-bytes-changed');barrier[path]=sha256(bytes);for(const value of Object.values(candidates))need(value.bytes.get(path)&&sha256(value.bytes.get(path))===barrier[path],'changed-startup-qualification-producer-required');}
  const helperBytes={};for(const name of helpers){need(files[name]&&(name==='install.py'||pair.helpers?.[name]===sha256(files[name])),'selected-helper-description-changed');for(const side of ['private','public']){const artifact=input.artifacts[side],claimed=artifact.sourceHashes?.['deploy/update-runner/'+name];need(claimed?.sha256===sha256(files[name]),'changed-updater-qualification-producer-required');const raw=frontendRegular(join(artifact.frozenSourceDirectory,'deploy/update-runner',name),2*1024**2);need(sha256(raw)===claimed.sha256,'authenticated-helper-source-changed');helperBytes[name]=raw;}}
  const pkg=candidates.private.bytes.get('package.json'),lock=frontendRegular(join(input.artifacts.private.applicationDirectory,'package-lock.json'),8*1024**2);
  for(const side of ['private','public']){const artifact=input.artifacts[side],receipt=json(artifact.ciSourceReceipt),sideLock=frontendRegular(join(artifact.applicationDirectory,'package-lock.json'),8*1024**2);need(receipt.application.packageLockSha256===sha256(sideLock)&&sideLock.equals(lock)&&candidates[side].bytes.get('package.json').equals(pkg),'paired-official-dependency-metadata-changed');}
  const selectedPackage=selected.bytes.get('package.json'),selectedLock=frontendRegular(join(base.directory,'package-lock.json'),8*1024**2);
  need(sha256(selectedLock)===pair.applicationDependencies.packageLockSha256,'selected-official-lock-changed');
  versionMetadataOnly(JSON.parse(selectedPackage),JSON.parse(selectedLock),JSON.parse(pkg),JSON.parse(lock),options.format===2?options.metadataPolicy:'version-only');
  let releaseCommand;
  if(options.format===2){
   const sources={};let commandBytes;
   for(const side of ['private','public']){
    const artifact=input.artifacts[side],claimed=artifact.sourceHashes?.['scripts/release-deliver.mjs'];
    need(hash.safeParse(claimed?.sha256).success,'authenticated-release-command-required');
    const path=join(artifact.frozenSourceDirectory,'scripts/release-deliver.mjs'),bytes=frontendRegular(path,2*1024**2);
    need(bytes.length>0&&sha256(bytes)===claimed.sha256&&(!commandBytes||bytes.equals(commandBytes)),'paired-release-command-source-changed');
    commandBytes=bytes;sources[side]={path,sha256:claimed.sha256};
   }
   releaseCommand={policy:options.metadataPolicy,command:'node scripts/release-deliver.mjs',sourceCommits:descriptor.operation.sourceCommits,sources};
  }
  // The maintained outer adapter validates before reserving its package phase.
  // This path validates sources only and cannot derive effect paths or identities.
  if(!parent)return{pair,barrier,helperBytes,selected,candidates,pkg,lock};
  const directory=rootPath(c),targetPackage={path:join(directory,'package.json'),sha256:sha256(pkg)},targetLock={path:join(directory,'package-lock.json'),sha256:sha256(lock)};
  const successor={...anchor,...(releaseCommand?{format:2,releaseCommand}:{}),helper:options.helper,targetPackage,targetLock,transition:{...anchor.transition,toVersion:descriptor.operation.version,toBuild:descriptor.operation.buildVersion}};
  const identity={format:1,operationId:descriptor.operation.id,parentKey:parent.key,parentInputSha256:parent.inputSha256,sourceCommits:descriptor.operation.sourceCommits,candidateId:candidates.private.id,publicCandidateId:candidates.public.id,priorCandidateId:selected.id,producerSha256:DEPENDENCY_SUCCESSOR_SHA,options,base};
  return{identity,directory,pkg,lock,successor,pair,barrier,helperBytes,selected,candidates};
 };
 const stageOutput=c=>{const value=check(c);return{...value.identity,kind:'maintained-dependency-local-stage',directory:value.directory,input:{path:join(value.directory,'input.json'),sha256:sha256(encoded(value.successor))},package:value.successor.targetPackage,lock:value.successor.targetLock};};
 const readStaged=c=>{const output=stageOutput(c);for(const key of ['input','package','lock'])readEvidenceFile(output[key],{maximum:8*1024**2});return output;};
 const paths=c=>({plan:join(rootPath(c),'plan.json'),intent:join(rootPath(c),'intent.json'),execution:join(rootPath(c),'execution.json'),result:join(rootPath(c),'produced/result.json'),output:join(rootPath(c),'produced'),pair:join(rootPath(c),'pair'),pairResult:join(rootPath(c),'pair-result.json')});
 const workerRequest=(c,phase)=>{const row=c.journal.deliveryPhase(c.descriptor.operation.id,'package/dependency-'+phase);need(row,'original-dependency-worker-reservation-required');return{format:1,kind:'maintained-local-dependency-request',phase,operationId:c.descriptor.operation.id,parentKey:pIntent(c).key,phaseKey:row.key,inputSha256:row.inputSha256,reservedAtMs:row.createdAtMs,deadlineAtMs:row.createdAtMs+615000,producerSha256:DEPENDENCY_SUCCESSOR_SHA,input:readStaged(c).input,outputDirectory:phase==='execute'?paths(c).output:null};};
 const workerOutcome=(c,phase)=>{const path=join(rootPath(c),phase+'-outcome.json');if(!existsSync(path))return null;const requestPath=join(rootPath(c),phase+'-request.json'),request=workerRequest(c,phase);need(same(json(reference(requestPath)),request),'original-dependency-worker-request-changed');const out=json(reference(path));
  need(out.format===1&&out.kind==='maintained-local-dependency-outcome'&&same(out.request,reference(requestPath))&&['operationId','parentKey','phaseKey','inputSha256','reservedAtMs','deadlineAtMs','producerSha256','phase'].every(k=>out[k]===request[k])&&out.hostEffects===false&&Number.isSafeInteger(out.finishedAtMs)&&out.finishedAtMs>=request.reservedAtMs&&['completed','failed'].includes(out.state)&&/^[a-z][a-z0-9-]{0,99}$/.test(out.reason),'original-dependency-worker-outcome-changed');
  if(out.state==='completed'){need(out.finishedAtMs<request.deadlineAtMs,'original-dependency-worker-completed-late');if(phase==='plan')need(same(out.result,{passed:true,readOnly:true,hostEffects:false}),'maintained-dependency-plan-result-changed');else need(same(out.result,reference(paths(c).result)),'maintained-dependency-execute-result-changed');}else need(out.result===null,'failed-dependency-worker-result-changed');return{out,reference:reference(path)};};
 const runWorker=async(c,phase,milliseconds)=>{const request=workerRequest(c,phase),path=join(rootPath(c),phase+'-request.json');writeExclusive(path,encoded(request));await run(options.python.path,[workerPath,'--request',path,'--approved-request-sha',reference(path).sha256],{timeoutMs:milliseconds,maximum:8*1024**2,acceptJsonFailure:true});const outcome=workerOutcome(c,phase);need(outcome,'original-dependency-worker-outcome-missing');return outcome;};
 const failure=(c,value)=>result('failed',value.out.reason,c,null,value.reference);
 const checkPlan=c=>{const staged=readStaged(c),path=paths(c).plan,p=json(reference(path)),worker=workerOutcome(c,'plan');need(worker?.out.state==='completed'&&p.kind==='maintained-dependency-local-plan'&&same(p.stage,staged)&&p.readOnly===true&&p.hostEffects===false&&p.plannedAtMs===worker.out.finishedAtMs&&same(p.workerOutcome,worker.reference),'original-dependency-plan-changed');return p;};
 const checkIntent=c=>{const plan=checkPlan(c),v=json(reference(paths(c).intent));need(v.kind==='maintained-dependency-execution-intent'&&v.operationId===c.descriptor.operation.id&&v.parentKey===pIntent(c).key&&same(v.plan,reference(paths(c).plan))&&v.outputDirectory===paths(c).output,'original-dependency-intent-changed');return{plan,intent:v};};
 const readProduced=c=>{
  const v=check(c),{intent}=checkIntent(c),p=paths(c);if(!existsSync(p.execution)||!existsSync(p.result))return null;
  const completedWorker=workerOutcome(c,'execute');if(!completedWorker||completedWorker.out.state!=='completed')return null;
  const witness=json(reference(p.execution)),executeRow=c.journal.deliveryPhase(c.descriptor.operation.id,'package/dependency-execute');
  need(executeRow&&same(witness,{format:1,kind:'original-local-dependency-dispatch',operationId:c.descriptor.operation.id,parentKey:pIntent(c).key,phaseKey:executeRow.key,inputSha256:executeRow.inputSha256,reservedAtMs:executeRow.createdAtMs,deadlineAtMs:executeRow.createdAtMs+615000,intent:reference(p.intent),producerSha256:DEPENDENCY_SUCCESSOR_SHA}),'original-dependency-dispatch-changed');
  const out=json(reference(p.result));need(out.format===options.format&&(options.format===1?!Object.hasOwn(out,'metadataPolicy'):out.metadataPolicy===options.metadataPolicy)&&out.kind==='verified-metadata-only-dependency-successor'&&out.passed===true&&same(out.input,v.successor)&&out.everyRetainedMemberIdentical===true&&out.retainedMemberCount>0&&hash.safeParse(out.retainedInventorySha256).success&&out.newNativeExecutionClaimed===false&&out.newTargetStartupClaimed===false&&out.hostEffects===false&&out.deliveryQualification===false&&out.freshFullRehearsalStillRequired===true&&out.liveAcceptanceStillRequired===true&&same(out.originalNativeQualificationReused,v.successor.nativeReceipt),'maintained-dependency-result-changed');
  need(out.archive.path===join(p.output,'app-dependencies.tgz')&&out.metadata.path===join(p.output,'app-dependencies.tgz.metadata.json')&&out.archive.sha256===out.description.archiveSha256&&out.description.packageLockSha256===sha256(v.lock),'produced-dependency-artifact-binding-changed');
  const archive=readEvidenceFile(out.archive,{maximum:MAX});need(archive.length===out.description.archiveBytes&&same(json(out.metadata),out.description),'produced-dependency-artifact-changed');
  assertKeys(Object.fromEntries(readdirSync(p.output).map(x=>[x,true])),['app-dependencies.tgz','app-dependencies.tgz.metadata.json','result.json'],'produced-dependency-file-set-changed');
  return{kind:'maintained-local-dependency-result',operationId:c.descriptor.operation.id,parentKey:pIntent(c).key,executionKey:executeRow.key,result:reference(p.result),dispatch:reference(p.execution),dependencies:{archive:out.archive,metadata:out.metadata,description:out.description,qualification:reference(p.result),unchangedNativeDependencies:true,nativeQualification:v.successor.nativeReceipt},freshFullRehearsalStillRequired:true,newNativeExecutionClaimed:false};
 };
 const observePair=c=>{
  const value=check(c),produced=readProduced(c),p=paths(c);if(!produced||!existsSync(p.pairResult))return null;
  const output=json(reference(p.pairResult));const pair={...value.pair,priorCandidateId:value.selected.id,candidateId:value.candidates.private.id,archiveBytes:frontendRegular(pIntent(c).input.artifacts.private.archive.path,MAX).length,archiveSha256:pIntent(c).input.artifacts.private.archive.sha256,applicationDependencies:produced.dependencies.description,startupBarrier:{format:1,prior:value.barrier,target:value.barrier}};
  need(output.kind==='maintained-qualified-update-pair'&&output.operationId===c.descriptor.operation.id&&output.key===pIntent(c).key&&same(output.sourceCommits,c.descriptor.operation.sourceCommits)&&output.candidateId===pair.candidateId&&output.publicCandidateId===value.candidates.public.id&&output.priorCandidateId===pair.priorCandidateId&&output.directory===p.pair&&same(output.dependencies,produced.dependencies)&&same(output.preparation,reference(p.pairResult+'.preparation.json')),'maintained-pair-output-changed');
  assertKeys(Object.fromEntries(readdirSync(p.pair).map(x=>[x,true])),[...helpers,'app.tgz','reviewed-pair.json'],'maintained-pair-file-set-changed');
  need(same(json(reference(join(p.pair,'reviewed-pair.json'))),pair),'maintained-pair-description-changed');
  for(const name of helpers)need(frontendRegular(join(p.pair,name),2*1024**2).equals(value.helperBytes[name]),'maintained-pair-helper-changed');
  need(sha256(frontendRegular(join(p.pair,'app.tgz'),MAX))===pair.archiveSha256,'maintained-pair-archive-changed');
  const expectedRelease=release(value,c);need(same(output.release,expectedRelease)&&output.runtime===null,'maintained-pair-release-changed');readEvidenceFile(output.preparation);return output;
 };
 const release=(value,c)=>({candidateId:value.candidates.private.id,fromCandidateId:value.selected.id,novaVersion:c.descriptor.operation.version,agentVersion:c.descriptor.operation.agentVersion,platform:'linux',arch:'x64',nodeMajor:22,notes:['Updates Nova Dream to '+c.descriptor.operation.version+'.'],compatibility:{reviewed:true,gatewayProtocol:4,fromNovaVersion:value.selected.manifest.version,fromAgentVersion:c.descriptor.operation.priorAgentVersion,fromSchemaVersion:value.selected.manifest.schemaVersion,toSchemaVersion:value.candidates.private.manifest.schemaVersion,pluginVersion:c.descriptor.operation.version},recovery:{pairedSnapshot:true,independentRestore:true,readinessTimeoutSeconds:600}});
 const deadline=c=>{need(Number.isSafeInteger(c.worker?.deadlineAtMs)&&clock()>=c.worker.reservedAtMs&&clock()<c.worker.deadlineAtMs-15000,'original-dependency-deadline-expired');return Math.min(WINDOW,c.worker.deadlineAtMs-15000-clock());};
 const persist=(c,name,output)=>({receipt:storeReceipt(c.journal,c.intent.key,name,encoded(output)),output});
 const completed=(c,name,output)=>{const stored=persist(c,name,output);return result('completed','maintained-dependency-'+name,c,stored.output,stored.receipt);};
 const readRecord=(c,name,derive)=>{const path=join(c.journal.directory,'delivery-evidence',c.intent.key+'-'+name);if(!existsSync(path))return result('uncertain','original-dependency-step-incomplete',c);const stored=json(reference(path));const expected=derive();need(same(stored,expected),'original-dependency-step-output-changed');return result('completed','maintained-dependency-'+name,c,stored,reference(path));};
 const step=(name,derive,execute)=>({input:async c=>({kind:name,identity:check(c).identity}),validate:async c=>{const expected={kind:name,identity:check(c).identity};need(same(c.input,expected),'dependency-substep-input-changed');},execute,observe:async c=>{try{const output=derive(c);return output?completed(c,name,output):result('uncertain','original-dependency-step-incomplete',c);}catch(error){if(error?.code==='ENOENT')return result('uncertain','original-dependency-step-incomplete',c);throw error;}},verify:async(value,c)=>{if(value.state==='completed'){readEvidenceFile(value.receipt);need(same(value.output,derive(c))&&same(json(value.receipt),value.output),'dependency-substep-verification-failed');}}});
 const steps={};
 steps['dependency-stage']=step('dependency-stage',readStaged,async c=>{const v=check(c);deadline(c);need(!existsSync(v.directory),'unreserved-dependency-stage-present');capacity(c.journal.directory,MAX+v.pkg.length+v.lock.length);validateJournalDirectory(v.directory,{create:true});writeExclusive(join(v.directory,'package.json'),v.pkg);writeExclusive(join(v.directory,'package-lock.json'),v.lock);writeExclusive(join(v.directory,'input.json'),encoded(v.successor));return completed(c,'dependency-stage',readStaged(c));});
 const settlePlan=c=>{const value=workerOutcome(c,'plan');if(!value)return result('uncertain','original-dependency-plan-incomplete',c);if(value.out.state==='failed')return failure(c,value);if(!existsSync(paths(c).plan)){const plan={format:1,kind:'maintained-dependency-local-plan',stage:readStaged(c),plannedAtMs:value.out.finishedAtMs,readOnly:true,hostEffects:false,workerOutcome:value.reference,capacity:capacity(c.journal.directory),capacityObservedAtMs:clock()};writeExclusive(paths(c).plan,encoded(plan));}return completed(c,'dependency-plan',checkPlan(c));};
 steps['dependency-plan']=step('dependency-plan',checkPlan,async c=>{const milliseconds=deadline(c);readStaged(c);capacity(c.journal.directory);const value=await runWorker(c,'plan',milliseconds);return value.out.state==='failed'?failure(c,value):settlePlan(c);});
 steps['dependency-plan'].observe=async c=>settlePlan(c);
 steps['dependency-intent']=step('dependency-intent',c=>checkIntent(c).intent,async c=>{const plan=checkPlan(c);deadline(c);need(clock()-plan.plannedAtMs<=WINDOW,'dependency-local-plan-expired');const intent={format:1,kind:'maintained-dependency-execution-intent',operationId:c.descriptor.operation.id,parentKey:pIntent(c).key,plan:reference(paths(c).plan),outputDirectory:paths(c).output};writeExclusive(paths(c).intent,encoded(intent));return completed(c,'dependency-intent',checkIntent(c).intent);});
 steps['dependency-execute']=step('dependency-execute',readProduced,async c=>{const {plan}=checkIntent(c),p=paths(c),milliseconds=deadline(c);need(clock()-plan.plannedAtMs<=WINDOW,'dependency-local-plan-expired');need(!existsSync(p.execution)&&!existsSync(p.output),'original-dependency-effect-already-present');capacity(c.journal.directory);const witness={format:1,kind:'original-local-dependency-dispatch',operationId:c.descriptor.operation.id,parentKey:pIntent(c).key,phaseKey:c.intent.key,inputSha256:c.intent.inputSha256,reservedAtMs:c.intent.createdAtMs,deadlineAtMs:c.worker.deadlineAtMs,intent:reference(p.intent),producerSha256:DEPENDENCY_SUCCESSOR_SHA};writeExclusive(p.execution,encoded(witness));const value=await runWorker(c,'execute',milliseconds);if(value.out.state==='failed')return failure(c,value);const output=readProduced(c);need(output,'maintained-dependency-result-missing');return completed(c,'dependency-execute',output);});
 // A lost process response can still leave the producer's complete immutable result.
 steps['dependency-execute'].observe=async c=>{const value=workerOutcome(c,'execute');if(value?.out.state==='failed')return failure(c,value);const output=readProduced(c);return output?completed(c,'dependency-execute',output):result('uncertain','original-dependency-execution-incomplete',c);};
 steps['dependency-retrieval']=step('dependency-retrieval',readProduced,async c=>{deadline(c);const output=readProduced(c);need(output,'maintained-dependency-result-missing');return completed(c,'dependency-retrieval',output);});
 steps.pair=step('pair',observePair,async c=>{const value=check(c),produced=readProduced(c),p=paths(c);deadline(c);need(produced&&!existsSync(p.pair)&&!existsSync(p.pairResult),'original-pair-output-present-or-dependency-missing');const archive=readEvidenceFile(pIntent(c).input.artifacts.private.archive,{maximum:MAX}),pair={...value.pair,priorCandidateId:value.selected.id,candidateId:value.candidates.private.id,archiveBytes:archive.length,archiveSha256:sha256(archive),applicationDependencies:produced.dependencies.description,startupBarrier:{format:1,prior:value.barrier,target:value.barrier}},flatBytes=archive.length+Object.values(value.helperBytes).reduce((n,b)=>n+b.length,0)+encoded(pair).length;capacity(c.journal.directory,flatBytes+Math.ceil(flatBytes*4/3)+2*1024**2);validateJournalDirectory(p.pair,{create:true});
  for(const name of helpers)writeExclusive(join(p.pair,name),value.helperBytes[name]);writeExclusive(join(p.pair,'app.tgz'),archive);writeExclusive(join(p.pair,'reviewed-pair.json'),encoded(pair));
  const preparation={format:1,kind:'automatic-retained-native-pair-preparation',identity:value.identity,dependencies:produced,sourceHelpers:Object.fromEntries(helpers.map(name=>[name,sha256(value.helperBytes[name])])),startupBarrier:pair.startupBarrier,hostEffects:false,newNativeExecutionClaimed:false,newTargetStartupClaimed:false,freshFullRehearsalStillRequired:true,liveAcceptanceStillRequired:true};writeExclusive(p.pairResult+'.preparation.json',encoded(preparation));
  const output={kind:'maintained-qualified-update-pair',operationId:c.descriptor.operation.id,key:pIntent(c).key,sourceCommits:c.descriptor.operation.sourceCommits,candidateId:pair.candidateId,publicCandidateId:value.candidates.public.id,priorCandidateId:pair.priorCandidateId,directory:p.pair,dependencies:produced.dependencies,runtime:null,release:release(value,c),preparation:reference(p.pairResult+'.preparation.json')};writeExclusive(p.pairResult,encoded(output));return completed(c,'pair',observePair(c));});
 steps.pair.observe=async c=>{const output=observePair(c);return output?completed(c,'pair',output):result('uncertain','original-pair-output-incomplete',c);};
 return{validate:async c=>{check(c);},steps,normalizePair:async(value,c)=>{const actual=observePair(c);need(same(value,actual),'normalized-dependency-pair-changed');return actual;},verifyPair:async(value,c)=>need(same(value,observePair(c)),'verified-dependency-pair-changed')};
}
