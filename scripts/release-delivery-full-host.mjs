/** Maintained full-release host bindings. The original delivery owns every
 * effect; read-only facts never claim stopped admission or completed recovery. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createPublicKey, verify } from 'node:crypto';
import { assessCapacity, readEvidenceFile, readReleaseInputFile, sha256 } from './release-plan.mjs';
import { releaseTransportSchema, runInstallTransport } from './release-adapters.mjs';
import { verifyRetainedCandidate } from './release-delivery-package.mjs';
import { runtimeAdmissionCapability } from './release-delivery-runtime-qualification.mjs';

const need=(v,r)=>{if(!v)throw Error(r);};
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const hostPath=z.string().regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/).refine(p=>!p.split('/').some(x=>x==='.'||x==='..'));
const hostRef=z.object({path:hostPath,sha256:hash}).strict();
const version=z.string().regex(/^\d+\.\d+\.\d+$/);
export const fullHostOptionsSchema=z.object({format:z.literal(1),hostConfiguration:hostRef,
  helperDirectory:hostPath,acceptedInstallation:hostRef,priorVersion:version,priorBuildVersion:version,priorJobId:z.uuid(),
  stageParent:hostPath.refine(p=>p.startsWith('/opt/nova-release-tools/')&&p.length>'/opt/nova-release-tools/'.length),
  excludedIdentities:z.object({candidateIds:z.array(hash).max(64),bundleSha256s:z.array(hash).max(64),rehearsalLeaseIds:z.array(z.uuid()).max(64)}).strict()
    .refine(v=>Object.values(v).every(a=>new Set(a).size===a.length)),
  startupGuardFile:hostPath.nullable()}).strict();
export const FULL_HELPERS=Object.freeze({
  'app_dependencies.py':'e7f2617ed8d05b7d83da62e857822b737ff3a1c47b6704af5d3e1783e043b290',
  'codex_log_retention.py':'bc6b09a2b99a9667c9c8fac63f2665362aa3e14b8db10d6be12652250ae2a1f4',
  'install.py':'d417d652163cb134583b1d766c650ad0a8597084bfa25ee876d7cf5155f013c4',
  'operator_rehearsal.py':'cec0f65413550a5872c2e97c0835434647a7aeadccd73e8c812ecda0fe251c3c',
  'recovery.py':'03e06cd1e9881cb3814abd91fb91c4486a440e1625c097d12a412a0fb5f2aa71',
  'verify-session-bindings.mjs':'1d51c2af378f27f21c9580a367779ab9192c159c600f02938d780a5de467c5c0',
  'workspace_key.py':'e97ae151ff8208c6831e93ef3281e1b1dbff99f4eea4679aa7f6a8ed06c412d2',
});
const templates=['collect-facts.py','metadata-stage.py','launch-plan-template.py','observe-plan-template.py','launch-execute-template-r2.py','observe-execute-template.py','collect-completion-template.py','online-capacity.py'];
const primitive=name=>{need(templates.includes(name),'full-host-fixed-program-required');return readFileSync(new URL('full-host-primitives/'+name,import.meta.url));};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const encoded=v=>Buffer.from(canonical(v).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))+'\n');
export const fullHostImplementation=()=>sha256(encoded({module:sha256(readFileSync(new URL(import.meta.url))),primitives:Object.fromEntries(templates.map(n=>[n,sha256(primitive(n))]))}));
const outcome=(state,reason,context,output=null,receipt=null)=>({state,reason,externalId:context.descriptor.operation.id,output,receipt});
function record(context,store,name,value){return store(context.journal,context.intent.key,name,encoded(value));}
function original(context,name){const p=join(context.journal.directory,'delivery-evidence',`${context.intent.key}-${name}`);return existsSync(p)?JSON.parse(readReleaseInputFile(p)):null;}

/** Identity is deterministic inside the original phase. A new caller cannot
 * acquire a new lease by resuming the same parent reservation. */
export function fullHostIdentity(key,role){
  z.uuid().parse(key);need(['lease','plan','execute'].includes(role),'full-host-role-invalid');
  const h=sha256(encoded({key,role,namespace:'maintained-full-host-v1'}));
  return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
}
export function fullFactsSpec(descriptor,options,key){
  fullHostOptionsSchema.parse(options);const op=descriptor.operation;
  requireRuntimeCapability(op);
  need(op.changeClass==='application'||op.changeClass==='presentation','full-changed-recovery-qualification-capability-required');
  return {format:2,sourceCommit:descriptor.sources.private.commit,helperDirectory:options.helperDirectory,helperHashes:FULL_HELPERS,
    hostConfiguration:options.hostConfiguration.path,hostConfigurationSha256:options.hostConfiguration.sha256,
    startupGuardFile:options.startupGuardFile,workspaceEpoch:op.workspaceEpoch,leaseId:fullHostIdentity(key,'lease'),
    acceptedInstallation:options.acceptedInstallation,base:{candidateId:op.priorCandidateId,priorVersion:options.priorVersion,
      priorBuildVersion:options.priorBuildVersion,agentVersion:op.priorAgentVersion,priorJobId:options.priorJobId}};
}
// These schema/API values describe this fixed maintained helper closure, not
// supplied target evidence. hostInput separately verifies both real candidates.
// In particular, authentic runtime archives and synthetic migration results do
// not supply the missing settled target startup/restart qualification.
function requireRuntimeCapability(operation,runtime=null){
  const result=runtimeAdmissionCapability({fromVersion:operation.priorAgentVersion,toVersion:operation.agentVersion,schemaVersion:55,apiVersion:1});
  need(result.supported,result.gaps[0]?.code??'full-runtime-qualification-capability-required');
  need(runtime===null,'full-unexpected-runtime-artifact');
}
export function verifyFullFacts(value,spec,nowMs=Date.now(),fresh=true){
  need(value?.format===2&&value.kind==='current-rehearsal-facts'&&value.readOnly===true&&value.noHostWrites===true
    &&value.sourceCommit===spec.sourceCommit&&isDeepStrictEqual(value.base,spec.base)
    &&isDeepStrictEqual(value.acceptedInstallation,spec.acceptedInstallation),'full-host-facts-identity-changed');
  need(Number.isSafeInteger(value.observedAtMilliseconds)&&(!fresh||nowMs-value.observedAtMilliseconds>=-5000&&nowMs-value.observedAtMilliseconds<=900000),'full-host-facts-expired');
  const r=value.review,l=value.operatorStatus?.lease;
  need(r?.leaseId===spec.leaseId&&r.candidateId===spec.base.candidateId&&r.novaVersion===spec.base.priorVersion
    &&r.agentVersion===spec.base.agentVersion&&r.workspaceEpoch===spec.workspaceEpoch&&isDeepStrictEqual(r.helperHashes,FULL_HELPERS)
    &&r.hostConfiguration===spec.hostConfiguration&&value.protectedHashes?.[spec.hostConfiguration]===spec.hostConfigurationSha256
    &&value.protectedHashes?.[spec.acceptedInstallation.path]===spec.acceptedInstallation.sha256,'full-host-current-binding-changed');
  need(value.historicalClosedLeaseRetained===true&&value.operatorStatus.held===false&&['released','cancelled'].includes(l?.phase)
    &&l.workspaceEpoch===spec.workspaceEpoch&&l.id!==spec.leaseId&&hash.safeParse(l.candidateId).success,'full-host-idle-lease-required');
  need(value.health?.status==='ready'&&value.health.candidateId===r.candidateId&&value.health.version===r.novaVersion
    &&value.accessContext?.workspaceEpoch===spec.workspaceEpoch,'full-host-live-identity-changed');
  return r;
}
/** Fixed source only; request data is parsed as JSON. Facts are bounded by the
 * existing 120-second transport and a shorter read-only alarm. */
export function buildFullHostProgram(name,data){
  const source=primitive(name),payload=Buffer.from(JSON.stringify({source:source.toString('base64'),sha256:sha256(source),data})).toString('base64');
  const action=name==='collect-facts.py'?"n={'__name__':'full_facts'};exec(compile(s,'fixed-full-facts','exec'),n);signal.alarm(110);print(json.dumps(n['collect'](v['data'])))"
    :name==='online-capacity.py'?"n={'__name__':'full_online_capacity'};exec(compile(s,'fixed-full-online-capacity','exec'),n);signal.alarm(110);print(json.dumps(n['collect_capacity'](v['data'])))"
    :name==='metadata-stage.py'?"n={'__name__':'__main__','REQUEST':v['data']};exec(compile(s,'fixed-full-stage','exec'),n)"
    :"n={'__name__':'__main__','V':v['data']['values']};n.update(v['data'].get('readiness',{}));exec(compile(s,'fixed-full-rehearsal','exec'),n)";
  return `import base64,hashlib,json,signal,sys\nv=json.loads(base64.b64decode('${payload}',validate=True))\ns=base64.b64decode(v['source'],validate=True)\nassert hashlib.sha256(s).hexdigest()==v['sha256']\ntry:\n ${action}\nexcept Exception as e:\n print(json.dumps({'state':'uncertain','reason':'full-host-original-result-unavailable','privateDiagnostic':{'type':type(e).__name__[:100],'message':str(e)[:2000]}}));sys.exit(2)\n`;
}
async function invoke(context,{transport,run,storeReceipt},name,data){
  const target=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport,{maximum:65536})));readEvidenceFile(target.sshConfig,{maximum:65536});
  const raw=await run(target,buildFullHostProgram(name,data),{captureDiagnostics:true});let value;
  try{value=JSON.parse(raw.stdout);}catch{}
  if(raw.uncertain||raw.exitCode!==0||!value||value.state==='uncertain'){
    const detail={format:1,kind:'private-full-host-failure',operationId:context.descriptor.operation.id,key:context.intent.key,program:name,
      exitCode:raw.exitCode??null,uncertain:raw.uncertain===true,stdout:String(raw.stdout??'').slice(0,120000),stderr:String(raw.stderr??'').slice(0,4000)};
    return {state:'uncertain',diagnostic:record(context,storeReceipt,'full-host-failure-'+sha256(encoded(detail))+'.json',detail)};
  }return value;
}

function hostInput(descriptor,prior,options){
  fullHostOptionsSchema.parse(options);need(prior.route?.route==='full'&&prior.sign?.route==='full','full-host-signed-package-required');
  requireRuntimeCapability(descriptor.operation,prior.sign.runtime??null);
  for(const side of ['private','public']){
    const candidate=verifyRetainedCandidate(prior.artifacts.repositories[side],descriptor.sources[side]);
    need(candidate.manifest.schemaVersion===55&&candidate.manifest.apiVersion===1,'full-schema-qualification-capability-required');
    for(const [name,digest] of Object.entries(FULL_HELPERS))need(prior.artifacts.repositories[side].sourceHashes?.['deploy/update-runner/'+name]?.sha256===digest,'full-helper-qualification-capability-required');
  }
  need(prior.sign.candidateId===prior.route.targetCandidateId&&prior.sign.priorCandidateId===descriptor.operation.priorCandidateId,'full-host-signed-candidate-changed');
  return {format:1,operation:descriptor.operation,sourceCommit:descriptor.sources.private.commit,options,
    artifacts:prior.artifacts.repositories,signed:prior.sign,implementationSha256:fullHostImplementation()};
}
function packetFor(input,facts,key){
  const root=input.options.stageParent+'/rehearsal-'+fullHostIdentity(key,'lease');const payload={};
  for(const [name,digest] of Object.entries(FULL_HELPERS))payload[name]=readEvidenceFile({path:join(input.artifacts.private.frozenSourceDirectory,'deploy','update-runner',name),sha256:digest},{maximum:2*1024**2});
  payload['operator-review.json']=encoded(facts.review);
  const runnerSha256=sha256(primitive('metadata-stage.py'));
  const packet={format:2,capacityScope:'metadata-stage-only',root,stageParent:input.options.stageParent,leaseId:facts.review.leaseId,sourceCommit:input.sourceCommit,
    files:Object.fromEntries(Object.entries(payload).map(([name,b])=>[name,{path:root+'/'+name,sha256:sha256(b),bytes:b.length}])),facts,runnerSha256};
  return {packet,packetSha256:sha256(encoded(packet)),runnerSha256,files:Object.fromEntries(Object.entries(payload).map(([n,b])=>[n,b.toString('base64')]))};
}
export function verifyFullStage(value,request){
  const p=request.packet;
  need(value?.format===1&&value.staged===p.root&&value.leaseId===p.leaseId&&value.sourceCommit===p.sourceCommit
    &&value.reviewSha256===p.files['operator-review.json'].sha256&&isDeepStrictEqual(value.helperHashes,FULL_HELPERS)
    &&value.metadataOnly===true&&value.leaseAcquired===false&&value.appRestarted===false&&value.sourceSqliteOpened===false
    &&value.capacityScope==='metadata-stage-only'&&value.fullRehearsalCapacityAdmitted===false&&value.fullMaintainedPlanStillRequired===true
    &&value.packetSha256===request.packetSha256&&value.runnerSha256===request.runnerSha256,'full-exact-metadata-stage-required');
  const c=value.capacity;need(c?.scope==='metadata-stage-only'&&c.reserveBytes===1610612736&&c.allowanceBytes===268435456
    &&c.operatingFloorBytes===1879048192&&c.requiredFreeBytes===c.operatingFloorBytes+c.incrementalAllocatedBytesMaximum
    &&c.futureReclaimCreditBytes===0&&c.fullRehearsalCapacityAdmitted===false,'full-stage-capacity-scope-changed');
}
function phaseValues(request,result,key){
  const p=request.packet,f=p.facts;
  return {stage:p.root,leaseId:p.leaseId,files:Object.fromEntries(Object.entries(p.files).map(([n,r])=>[n,r.sha256])),stageResult:result,
    stageResultSha256:sha256(encoded(result)),releasedLeaseSha256:f.operatorLeaseSha256,releasedLease:f.operatorStatus.lease,
    candidateId:f.review.candidateId,workspaceEpoch:f.review.workspaceEpoch,stateDirectory:f.stateDirectory,sourceCommit:p.sourceCommit,
    planId:fullHostIdentity(key,'plan'),unit:'nova-current-rehearsal-plan-'+fullHostIdentity(key,'plan')};
}
export function verifyFullPlan(value,values){
  need(value?.format===1&&value.planId===values.planId&&value.unit===values.unit&&value.leaseId===values.leaseId
    &&value.readOnlyObserver===true,'full-original-plan-identity-changed');
  const s=value.unitState;
  need(s?.LoadState==='loaded'&&s.Type==='oneshot'&&s.Restart==='no'&&s.UMask==='0077'&&s.RemainAfterExit==='yes'
    &&s.TimeoutStartUSec==='1h','full-plan-effective-profile-changed');
  if(value.planPassed===true){
    need(s.ActiveState==='active'&&s.SubState==='exited'&&s.Result==='success'&&s.ExecMainStatus==='0'&&s.MainPID==='0'&&s.ControlPID==='0','full-plan-terminal-result-changed');
    need(isDeepStrictEqual(value.maintainedPlan,{format:1,kind:'operator-rehearsal-plan',candidateId:values.candidateId,workspaceEpoch:values.workspaceEpoch,
      leaseId:values.leaseId,threeHeldStarts:true,closedCapacityRequired:true,readOnly:true}),'full-plan-shape-changed');
    need(Object.keys(value.planHostReceipts??{}).sort().join(',')==='intentSha256,launchSha256,logSha256'
      &&Object.values(value.planHostReceipts).every(x=>hash.safeParse(x).success)&&value.planHostReceipts.logSha256===value.logSha256,'full-plan-receipt-closure-changed');
  }
}
export function createFullCapacityAdapter({transport,options,storeReceipt,run=runInstallTransport,clock=Date.now}){
  const bridge={transport,storeReceipt,run};const expected=({descriptor,prior})=>hostInput(descriptor,prior,options);
  const validate=context=>need(isDeepStrictEqual(context.input,expected(context)),'full-host-input-changed');
  const advance=async context=>{
    const input=context.intent.input,spec=fullFactsSpec(context.descriptor,options,context.intent.key);
    let facts=original(context,'full-facts.json');
    if(!facts){facts=await invoke(context,bridge,'collect-facts.py',spec);if(facts.state==='uncertain')return outcome('uncertain','full-current-facts-unavailable',context,{diagnostic:facts.diagnostic});verifyFullFacts(facts,spec,clock());record(context,storeReceipt,'full-facts.json',facts);}
    verifyFullFacts(facts,spec,clock(),!original(context,'full-stage-dispatch.json'));
    const request=packetFor(input,facts,context.intent.key);let staged=original(context,'full-stage-result.json');
    if(!staged){
      if(original(context,'full-stage-dispatch.json')){
        const observed=await invoke(context,bridge,'metadata-stage.py',{...request,mode:'observe'});
        if(observed.state==='uncertain'||observed.stageVerified!==true)return outcome('uncertain','full-original-stage-unsettled',context,observed.diagnostic?{diagnostic:observed.diagnostic}:null);
        const r=observed.records?.['stage-result.json'];need(r&&hash.safeParse(r.sha256).success,'full-original-stage-record-required');
        const raw=Buffer.from(r.rawBase64,'base64');need(raw.toString('base64')===r.rawBase64&&raw.length===r.bytes&&sha256(raw)===r.sha256,'full-original-stage-raw-changed');staged=JSON.parse(raw);
        need(raw.equals(encoded(staged)),'full-original-stage-canonical-bytes-required');
      }else{
        let plan=original(context,'full-stage-plan.json');
        if(!plan){plan=await invoke(context,bridge,'metadata-stage.py',{...request,mode:'plan'});if(plan.state==='uncertain')return outcome('uncertain','full-stage-plan-unavailable',context,{diagnostic:plan.diagnostic});record(context,storeReceipt,'full-stage-plan.json',plan);}
        need(plan.readOnly===true&&plan.identity?.packetSha256===request.packetSha256&&plan.identity?.runnerSha256===request.runnerSha256
          &&plan.capacityScope==='metadata-stage-only'&&plan.fullRehearsalCapacityAdmitted===false,'full-stage-readonly-plan-required');
        const intent={format:1,kind:'execute-current-rehearsal-metadata-stage',leaseId:spec.leaseId,planSha256:sha256(encoded(plan)),packetSha256:request.packetSha256,runnerSha256:request.runnerSha256,automaticReplayPermitted:false};
        need(typeof context.beforeNewEffect==='function','full-fresh-prerequisites-required');await context.beforeNewEffect();
        record(context,storeReceipt,'full-stage-dispatch.json',intent);
        staged=await invoke(context,bridge,'metadata-stage.py',{...request,mode:'stage',planRawBase64:encoded(plan).toString('base64'),intent});
        if(staged.state==='uncertain')return outcome('uncertain','full-original-stage-unsettled',context,{diagnostic:staged.diagnostic});
      }
      verifyFullStage(staged,request);record(context,storeReceipt,'full-stage-result.json',staged);
    }
    verifyFullStage(staged,request);const values=phaseValues(request,staged,context.intent.key);
    if(!original(context,'full-plan-dispatch.json')){
      await context.beforeNewEffect();record(context,storeReceipt,'full-plan-dispatch.json',{format:1,valuesSha256:sha256(encoded(values)),planId:values.planId,unit:values.unit});
      const launched=await invoke(context,bridge,'launch-plan-template.py',{values});
      if(launched.state==='uncertain')return outcome('uncertain','full-original-plan-dispatch-unsettled',context,{diagnostic:launched.diagnostic});
      need(launched.launched===true&&launched.planId===values.planId&&launched.unit===values.unit,'full-plan-launch-changed');record(context,storeReceipt,'full-plan-launch.json',launched);
    }else need(original(context,'full-plan-dispatch.json').valuesSha256===sha256(encoded(values)),'full-original-plan-dispatch-changed');
    const observed=await invoke(context,bridge,'observe-plan-template.py',{values});
    if(observed.state==='uncertain')return outcome('uncertain','full-original-plan-unsettled',context,{diagnostic:observed.diagnostic});verifyFullPlan(observed,values);
    if(!observed.planPassed)return outcome(observed.unitState.ActiveState==='failed'?'failed':'running',observed.unitState.ActiveState==='failed'?'full-maintained-plan-failed':'full-maintained-plan-running',context);
    const output={kind:'nova-delivery-full-capacity',operationId:context.descriptor.operation.id,targetCandidateId:input.signed.candidateId,scope:'metadata-stage-only',fullRehearsalCapacityAdmitted:false,
      facts,spec,stageResult:staged,values,plan:observed,helperHashes:FULL_HELPERS,phaseKey:context.intent.key,
      review:record(context,storeReceipt,'full-operator-review.json',facts.review),stageReceipt:record(context,storeReceipt,'full-stage-result.json',staged)};
    return outcome('completed','full-metadata-and-maintained-readonly-plan-passed',context,output,record(context,storeReceipt,'full-capacity-result.json',output));
  };
  return {input:async c=>expected(c),validate,execute:advance,observe:advance,verify:async(value,context)=>{
    if(value.state!=='completed')return;need(value.externalId===context.descriptor.operation.id&&isDeepStrictEqual(JSON.parse(readEvidenceFile(value.receipt)),value.output),'full-capacity-receipt-changed');
    const o=value.output;need(o.operationId===context.descriptor.operation.id&&o.phaseKey===context.intent.key&&o.scope==='metadata-stage-only'&&o.fullRehearsalCapacityAdmitted===false,'full-capacity-scope-changed');
    const spec=fullFactsSpec(context.descriptor,options,context.intent.key);verifyFullFacts(o.facts,spec,clock(),false);verifyFullStage(o.stageResult,packetFor(context.intent.input,o.facts,context.intent.key));verifyFullPlan(o.plan,o.values);readEvidenceFile(o.review);
  }};
}

export function verifyFullPremaintenance(input,descriptor,nowMs=Date.now()){
  const s=input.signed,op=descriptor.operation;
  need(s?.route==='full'&&s.priorCandidateId===op.priorCandidateId&&s.candidateId===input.capacity?.targetCandidateId
    &&(op.candidateId===null||s.candidateId===op.candidateId),'full-readiness-package-required');
  requireRuntimeCapability(op,s.runtime??null);
  need(s.runtime===null,'full-runtime-role-required');
  need(isDeepStrictEqual(s.sourceCommits,op.sourceCommits)&&['private','public'].every(side=>s.sourceCommits[side]===descriptor.sources[side].commit),'full-readiness-source-changed');
  const feedRaw=readEvidenceFile(s.signedFeed,{maximum:256*1024}),feed=JSON.parse(feedRaw),key=createPublicKey(readEvidenceFile(s.publicKey,{maximum:16384}));
  need(s.publicKey.sha256===op.trustedPublicKeySha256&&key.asymmetricKeyType==='ed25519'&&typeof feed.payload==='string'&&typeof feed.signature==='string','full-readiness-trusted-key-required');
  const payload=Buffer.from(feed.payload,'base64'),signature=Buffer.from(feed.signature,'base64');
  need(payload.toString('base64')===feed.payload&&signature.length===64&&signature.toString('base64')===feed.signature&&verify(null,payload,key,signature),'full-readiness-signature-invalid');
  const manifest=JSON.parse(payload);need(manifest.sequence===s.sequence&&manifest.channel===s.channel&&Date.parse(manifest.createdAt)<=nowMs&&Date.parse(manifest.expiresAt)>nowMs,'full-readiness-signed-feed-expired');
  const release=manifest.releases?.filter(r=>r.candidateId===s.candidateId);need(release?.length===1&&isDeepStrictEqual(release[0],s.release)
    &&s.release.fromCandidateId===op.priorCandidateId&&s.release.novaVersion===op.version&&s.release.agentVersion===op.agentVersion,'full-readiness-signed-release-changed');
  const bundle=readEvidenceFile(s.bundle,{maximum:128*1024**2}),description=s.dependencies.description;
  need(sha256(bundle)===s.release.bundle.sha256&&bundle.length===s.release.bundle.bytes&&s.bundle.sha256===s.release.bundle.sha256,'full-readiness-bundle-changed');
  const archive=readEvidenceFile(s.dependencies.archive,{maximum:128*1024**2}),metadata=JSON.parse(readEvidenceFile(s.dependencies.metadata));
  need(isDeepStrictEqual(metadata,description)&&archive.length===description.archiveBytes&&sha256(archive)===description.archiveSha256
    &&s.release.applicationDependenciesBundle.sha256===description.archiveSha256&&s.release.applicationDependenciesBundle.bytes===archive.length,'full-readiness-dependencies-changed');
  need(s.dependencies.unchangedNativeDependencies===true&&s.dependencies.qualification&&s.dependencies.nativeQualification,'full-native-qualification-producer-required');
  const qualification=JSON.parse(readEvidenceFile(s.dependencies.qualification));readEvidenceFile(s.dependencies.nativeQualification);
  need(qualification.passed===true&&qualification.everyRetainedMemberIdentical===true&&qualification.newNativeExecutionClaimed===false
    &&qualification.newTargetStartupClaimed===false&&qualification.freshFullRehearsalStillRequired===true
    &&isDeepStrictEqual(qualification.archive,s.dependencies.archive)&&isDeepStrictEqual(qualification.metadata,s.dependencies.metadata)
    &&isDeepStrictEqual(qualification.description,description)&&isDeepStrictEqual(qualification.originalNativeQualificationReused,s.dependencies.nativeQualification),'full-native-qualified-reuse-required');
  const files=JSON.parse(bundle).files;need(Array.isArray(files)&&files.length===8,'full-flat-bundle-required');
  for(const [name,digest] of Object.entries(FULL_HELPERS).filter(([n])=>n!=='operator_rehearsal.py')){
    const rows=files.filter(f=>f.name===name);need(rows.length===1&&rows[0].sha256===digest&&sha256(Buffer.from(rows[0].data,'base64'))===digest,'full-reviewed-helper-changed');
  }
  return {format:1,kind:'automated-full-premaintenance-check',operationId:op.id,candidateId:s.candidateId,priorCandidateId:s.priorCandidateId,
    sourceCommits:s.sourceCommits,bundleSha256:s.bundle.sha256,dependenciesSha256:description.archiveSha256,signedFeedSha256:s.signedFeed.sha256,
    qualificationSha256:s.dependencies.qualification.sha256,helperHashes:FULL_HELPERS,evaluatedAtMilliseconds:nowMs,
    humanReviewClaimed:false,stoppedCapacityStillRequired:true,freshFullRehearsalStillRequired:true};
}

/** Called after rehearsal by the fixed publication adapter immediately before
 * coordinator preparation. No old stage/closed receipt is relabeled as fresh. */
export async function collectFullOnlineCapacity(context,{transport,options,storeReceipt,run=runInstallTransport,clock=Date.now}){
  const prior=context.prior,completed=prior.recovery;
  // Refuse unavailable runtime qualification before even observing an old
  // rehearsal. Its successful prior-runtime starts cannot qualify the target.
  requireRuntimeCapability(context.descriptor.operation,prior.sign?.runtime??null);
  need(completed?.kind==='nova-delivery-full-rehearsal','full-current-rehearsal-required');verifyFullCompletion(completed.completion,completed.values);
  let recoveryEvidence=completed.evidence;
  if(clock()-completed.completion.observedAtMilliseconds>55*60000){
    // Re-observe the original completed operation; never repeat a rehearsal or
    // replace its proof to refresh an expired observation.
    const current=await invoke(context,{transport,storeReceipt,run},'collect-completion-template.py',{values:completed.values});
    if(current.state==='uncertain')return current;
    const raw=verifyFullCompletion(current,completed.values);
    need(raw.proofRaw.equals(readEvidenceFile(completed.evidence.proof))&&current.rehearsalEvidenceSha256===completed.completion.rehearsalEvidenceSha256
      &&current.completedProof.reviewSha256===completed.evidence.review.sha256,'full-original-completed-rehearsal-changed');
    need(Number.isSafeInteger(current.observedAtMilliseconds)&&clock()-current.observedAtMilliseconds>=0&&clock()-current.observedAtMilliseconds<=300000,'full-original-rehearsal-observation-expired');
    recoveryEvidence={...completed.evidence,observation:record(context,storeReceipt,'full-rehearsal-reobservation-'+sha256(encoded(current))+'.json',current)};
  }
  const metadata=JSON.parse(readEvidenceFile(prior.artifacts.repositories.private.metadata));
  const input={spec:fullFactsSpec(context.descriptor,options,context.intent.key),collectorSource:primitive('collect-facts.py').toString('base64'),
    collectorSha256:sha256(primitive('collect-facts.py')),application:Object.fromEntries(['archiveBytes','expandedBytes','fileCount'].map(k=>[k,metadata[k]])),
    dependencies:prior.sign.dependencies.description,bundleBytes:prior.sign.release.bundle.bytes,
    recoveryEvidence:{path:completed.values.stateDirectory+'/operator-maintenance/'+completed.leaseId+'/rehearsal.json',sha256:completed.completion.rehearsalEvidenceSha256}};
  const value=await invoke(context,{transport,storeReceipt,run},'online-capacity.py',input);
  if(value.state==='uncertain')return value;
  need(value.format===1&&value.kind==='measured-full-online-capacity'&&value.readOnly===true&&value.hostEffects===false
    &&value.workspaceEpoch===context.descriptor.operation.workspaceEpoch&&value.health?.status==='ready'
    &&value.health.candidateId===context.descriptor.operation.priorCandidateId&&value.runtime?.agentVersion===context.descriptor.operation.priorAgentVersion
    &&value.sourceCommit===context.descriptor.sources.private.commit&&isDeepStrictEqual(value.helperHashes,FULL_HELPERS)
    &&isDeepStrictEqual(value.originalClosedEvidence,input.recoveryEvidence)&&value.expectedReclaimBytes===0&&value.dependencyReuseCreditBytes===0
    &&value.authoritativeStoppedAdmission===false&&value.stoppedAndPostStartChecksStillRequired===true,'full-measured-capacity-authority-changed');
  need(Number.isSafeInteger(value.observedAtMilliseconds)&&clock()-value.observedAtMilliseconds>=0&&clock()-value.observedAtMilliseconds<=300000,'full-measured-capacity-expired');
  const assessed=assessCapacity(value.capacity);need(assessed.fits&&assessed.lifecycle==='online'&&assessed.requiredFreeBytes===value.capacity.requiredFreeBytes,'full-measured-capacity-incomplete');
  return {state:'completed',evidence:{observation:record(context,storeReceipt,'full-online-capacity-'+sha256(encoded(value))+'.json',value)},recoveryEvidence,output:value};
}
export function verifyFullCompletion(value,values){
  const s=value?.unit,p=value?.completedProof?.proof;
  need(value?.format===1&&value.readOnlyObservation===true&&value.hostDataWritten===false&&value.sourceSqliteOpened===false
    &&value.unitName===values.executionUnit&&s?.LoadState==='loaded'&&s.Type==='oneshot'&&s.Restart==='no'&&s.UMask==='0077'
    &&s.RemainAfterExit==='yes'&&s.TimeoutStartUSec==='1h'&&s.ActiveState==='active'&&s.SubState==='exited'&&s.Result==='success'
    &&s.ExecMainStatus==='0'&&s.MainPID==='0'&&s.ControlPID==='0','full-rehearsal-terminal-profile-required');
  const proofRaw=Buffer.from(value.proofRawBase64??'','base64'),detailRaw=Buffer.from(value.evidenceRawBase64??'','base64');
  need(proofRaw.toString('base64')===value.proofRawBase64&&detailRaw.toString('base64')===value.evidenceRawBase64
    &&proofRaw.length<=1024**2&&detailRaw.length<=1024**2&&sha256(proofRaw)===value.completedProof.proofSha256
    &&sha256(detailRaw)===value.rehearsalEvidenceSha256&&isDeepStrictEqual(JSON.parse(proofRaw),p),'full-rehearsal-raw-proof-changed');
  const detail=JSON.parse(detailRaw);
  need(p?.format===1&&p.kind==='operator-maintenance-acceptance'&&p.outcome==='rehearsed'&&p.leaseId===values.leaseId
    &&p.candidateId===values.candidateId&&p.workspaceEpoch===values.workspaceEpoch&&p.evidenceSha256===sha256(detailRaw)
    &&['savedWorkVerified','accountsVerified','healthVerified','recoveryVerified'].every(n=>p[n]===true),'full-rehearsal-acceptance-incomplete');
  need(value.completedProof.reviewSha256===values.files['operator-review.json']&&value.completedProof.originalReturned===true
    &&value.completedProof.nativeLeaseReleaseSettled===true&&value.completedProof.automaticRehearsalPassed===true
    &&value.status?.lastPhase==='complete'&&value.operator?.id===values.leaseId&&value.operator.phase==='released'
    &&value.operator.releaseKind==='rehearsed'&&value.operator.proofSha256===sha256(proofRaw)&&value.socketStatus?.held===false
    &&isDeepStrictEqual(value.socketStatus.lease,value.operator)&&value.requestFailure===null&&isDeepStrictEqual(value.helperHashes,FULL_HELPERS),'full-rehearsal-original-return-required');
  need(detail.manualResumption!==true&&detail.automaticRehearsalPassed!==false&&detail.deliveryQualification!==false
    &&detail.reviewSha256===values.files['operator-review.json']&&detail.leaseId===values.leaseId&&detail.outcome==='rehearsed'
    &&detail.snapshotManifestSha256===value.completedProof.snapshotManifestSha256&&isDeepStrictEqual(detail.sourceRootIdentity,detail.returnedRootIdentity)
    &&isDeepStrictEqual(value.status.roles?.live,value.status.originalRootIdentity)&&value.status.roles?.original===null
    &&value.status.roles?.trial===null&&value.status.roles?.restore===null,'full-rehearsal-restoration-or-native-proof-changed');
  return {proofRaw,detailRaw};
}
export function createFullRehearsalAdapter({transport,options,storeReceipt,run=runInstallTransport,clock=Date.now}){
  const bridge={transport,storeReceipt,run};const expected=({descriptor,prior})=>{
    const c=prior.capacity;need(prior.route?.route==='full'&&c?.kind==='nova-delivery-full-capacity'&&c.operationId===descriptor.operation.id,'full-maintained-plan-required');
    verifyFullPlan(c.plan,c.values);need(c.plan.planPassed===true,'full-maintained-plan-not-passed');
    return {format:1,capacity:c,signed:prior.sign,implementationSha256:fullHostImplementation()};
  };
  const validate=context=>need(isDeepStrictEqual(context.input,expected(context)),'full-rehearsal-input-changed');
  const advance=async context=>{
    const input=context.intent.input,c=input.capacity,v={...c.values,planUnit:c.values.unit,planLogSha256:c.plan.logSha256,
      executionId:fullHostIdentity(context.intent.key,'execute'),executionUnit:'nova-current-rehearsal-'+fullHostIdentity(context.intent.key,'execute')};
    let dispatch=original(context,'full-rehearsal-dispatch.json');
    if(!dispatch){
      const checked=verifyFullPremaintenance(input,context.descriptor,clock());
      const staticRef=record(context,storeReceipt,'full-static-'+sha256(encoded(checked))+'.json',checked);
      const readiness={format:1,kind:'operator-rehearsal-dispatch-readiness',targetVersion:context.descriptor.operation.version,targetCandidateId:input.signed.candidateId,
        leaseId:v.leaseId,sourceCommit:v.sourceCommit,priorCandidateId:v.candidateId,workspaceEpoch:v.workspaceEpoch,planHostReceipts:c.plan.planHostReceipts,
        evidenceFiles:{package:input.signed.preparation,probes:input.signed.dependencies.qualification,static:staticRef,signing:input.signed.signedFeed},
        rootReview:{conclusion:'ready-for-automatic-rehearsal',reviewedAtMilliseconds:clock(),authority:'existing-owner-hosted-update-standing-authorization',
          reviewer:'qualified-automated-full-release-policy',kind:'automated-prerequisite-evaluation',humanReviewClaimed:false,policySha256:fullHostImplementation()}};
      for(const r of Object.values(readiness.evidenceFiles))readEvidenceFile(r);
      need(typeof context.beforeNewEffect==='function','full-fresh-prerequisites-required');await context.beforeNewEffect();verifyFullPremaintenance(input,context.descriptor,clock());
      need(clock()-readiness.rootReview.reviewedAtMilliseconds<=600000,'full-readiness-expired-before-dispatch');
      dispatch={format:1,valuesSha256:sha256(encoded(v)),readiness,readinessSha256:sha256(encoded(readiness)),executionId:v.executionId,unit:v.executionUnit};
      record(context,storeReceipt,'full-rehearsal-dispatch.json',dispatch);
      const launched=await invoke(context,bridge,'launch-execute-template-r2.py',{values:v,readiness:{READINESS:readiness,READINESS_SHA256:dispatch.readinessSha256}});
      if(launched.state==='uncertain')return outcome('uncertain','full-original-rehearsal-dispatch-unsettled',context,{diagnostic:launched.diagnostic});
      need(launched.launched===true&&launched.executionId===v.executionId&&launched.unit===v.executionUnit&&launched.leaseId===v.leaseId,'full-rehearsal-launch-identity-changed');record(context,storeReceipt,'full-rehearsal-launch.json',launched);
    }
    need(dispatch.valuesSha256===sha256(encoded(v))&&dispatch.executionId===v.executionId&&dispatch.unit===v.executionUnit
      &&dispatch.readinessSha256===sha256(encoded(dispatch.readiness)),'full-original-rehearsal-dispatch-changed');
    const status=await invoke(context,bridge,'observe-execute-template.py',{values:v});
    if(status.state==='uncertain')return outcome('uncertain','full-original-rehearsal-unsettled',context,{diagnostic:status.diagnostic});
    need(status.executionId===v.executionId&&status.unit===v.executionUnit&&status.leaseId===v.leaseId&&status.readOnlyObserver===true,'full-rehearsal-observation-identity-changed');
    if(!status.automaticRehearsalPassed){const terminal=status.unitState?.ActiveState==='failed';return outcome(terminal?'failed':'running',terminal?'full-original-rehearsal-failed':'full-original-rehearsal-running',context,{status});}
    const completed=await invoke(context,bridge,'collect-completion-template.py',{values:v});
    if(completed.state==='uncertain')return outcome('uncertain','full-original-completion-unavailable',context,{diagnostic:completed.diagnostic});
    const raw=verifyFullCompletion(completed,v),evidence={observation:record(context,storeReceipt,'full-rehearsal-completion.json',completed),review:c.review,
      proof:storeReceipt(context.journal,context.intent.key,'full-rehearsal-proof.json',raw.proofRaw)};
    const output={kind:'nova-delivery-full-rehearsal',operationId:context.descriptor.operation.id,leaseId:v.leaseId,executionId:v.executionId,unit:v.executionUnit,
      helperHashes:FULL_HELPERS,values:v,evidence,completion:completed,originalReturned:true,savedReplyAccepted:false,browserAccepted:false};
    return outcome('completed','maintained-full-rehearsal-completed-and-restored',context,output,record(context,storeReceipt,'full-recovery-result.json',output));
  };
  return {input:async c=>expected(c),validate,execute:advance,observe:advance,verify:async(value,context)=>{
    if(value.state!=='completed')return;need(value.externalId===context.descriptor.operation.id&&isDeepStrictEqual(JSON.parse(readEvidenceFile(value.receipt)),value.output),'full-recovery-receipt-changed');
    const o=value.output;need(o.operationId===context.descriptor.operation.id&&o.leaseId===context.intent.input.capacity.values.leaseId
      &&o.executionId===fullHostIdentity(context.intent.key,'execute')&&isDeepStrictEqual(o.helperHashes,FULL_HELPERS),'full-recovery-operation-changed');
    const raw=verifyFullCompletion(o.completion,o.values);need(readEvidenceFile(o.evidence.proof).equals(raw.proofRaw)
      &&isDeepStrictEqual(JSON.parse(readEvidenceFile(o.evidence.observation)),o.completion),'full-recovery-evidence-changed');readEvidenceFile(o.evidence.review);
  }};
}
