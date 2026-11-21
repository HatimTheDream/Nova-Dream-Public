import {inflateSync} from 'node:zlib';
/** Read-only collection of exact-candidate, settled same-runtime qualification.
 * Configured receipts select original evidence; only the fixed collector derives
 * a proof. Collection is neither a new qualification nor production admission. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {frontendRegular} from './frontend-contract.mjs';
import {releaseTransportSchema,runInstallTransport} from './release-adapters.mjs';
import {applicationDependencyDescriptionSchema,applicationTransitionSchema,sameSchemaQualificationSchema,startupQualificationMarker,qualificationMarkerFields} from './release-delivery-qualified-dependencies.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/);
const hostPath=z.string().regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/).refine(p=>!p.split('/').some(x=>x==='.'||x==='..'));
const hostRef=z.object({path:hostPath,sha256:hash}).strict();
const SPLIT_OBSERVER_SOURCES=Object.freeze({"compose_reader.py":"e7c2c430549ce2027629fb565b3223a85be35652e6f9d1c384eab8a3a1f46f7c","consume_split.mjs":"7df7df4041ea67ac536fd630ee31b3285fb79237fdd4fdf49145fc48381fd79f","original.py":"de1cec465f2303c6e52452811d5b7479eb756f9b7a2704e7bf6af00b7f07d48c","prepare_observer.py":"619b4fa86a13564116a4f061fdd7c9c913e70163dcebb7a16bd5ed3b61b1d0f6","split_native.inc":"565c0448e413f71375c95752bc3cfd4f056289daf72d43336e4843ab70d4359d","verify_split.mjs":"2ab78e5a9deb1e39eb0d4da27da3b3322072689eb609a4ab26f544b03fcaa880"});
const warmPrivateFile=z.object({path:z.string().min(1),sha256:hash}).strict();
function splitOriginalObservation(call,limit=128*1024){
  const envelope=JSON.parse(call.response.stdout);
  need(envelope.encoding==='zlib-base64'&&Number.isSafeInteger(envelope.bytes)&&envelope.bytes>0&&envelope.bytes<=limit
    &&typeof envelope.data==='string'&&envelope.data.length<=192*1024,'invalid-original-transport-envelope');
  const packed=Buffer.from(envelope.data,'base64');
  need(packed.toString('base64')===envelope.data,'noncanonical-original-wire');
  const data=inflateSync(packed,{maxOutputLength:limit});
  need(data.length===envelope.bytes&&sha256(data)===envelope.sha256,'original-transport-envelope-changed');
  return JSON.parse(data);
}
const warmEvidenceSchema=z.object({format:z.literal(2),donorSeal:warmPrivateFile}).strict();
const warmAuthoritySchema=z.object({format:z.literal(2),kind:z.literal('verified-supplemental-warm-antecedent'),
  operationId:z.uuid(),continuationOperationId:z.uuid(),originalInvocation:z.string().regex(/^[0-9a-f]{32}$/),
  successorInvocation:z.string().regex(/^[0-9a-f]{32}$/),jobId:z.uuid(),priorCandidateId:hash,epoch:z.uuid(),baselineSha256:hash,
  parent:hostRef,producer:hostRef,warmSource:hostRef,disposableRoles:hostRef,seedReplicas:hostRef,
  chain:hostRef,outsideClosure:hostRef,originalFailedStderr:hostRef,protectedCustody:hostRef,terminal:hostRef,
  nativeOutputSha256:hash,projectionSha256:hash,consumptionSha256:hash,independentReviewSha256:hash}).strict();
function digestRef(row){return {path:row.path,sha256:row.sha256};}
function verifiedFirstStoppedFile(observed,sealed){
  return Number.isSafeInteger(observed?.bytes)&&observed.bytes>0
    &&Object.keys(observed).sort().join(',')==='bytes,path,sha256'&&same(observed,sealed);
}
function verifyCombinedPriorBuilders(proof,binding,continuation){
  for(const [index,row] of proof.scenarios.entries()){
    const builder=row.retainedConfigurationBuilder;
    const bytes=proof.references[row.scenario+'/retained-prior-source'];
    need(builder.candidateId===binding.prior.candidateId
      &&builder.path==='/opt/nova/releases/'+binding.prior.version+'-'+binding.prior.candidateId.slice(0,12)
      &&builder.warmProcessSha256===proof.references['warm-source/process'].sha256
      &&builder.source.path==='/mnt/nova-data/qualified-startup-continuation-'+continuation+'/evidence/attempt-'+(index+1)+'/same-schema-prior-source.json'
      &&same(builder.source,digestRef(bytes))&&Number.isSafeInteger(bytes.bytes)&&bytes.bytes>0,
      'different-producer-for-retained-configuration');
  }
}
export function readParkedWarmAuthority(evidence){
  const {donorSeal}=warmEvidenceSchema.parse(evidence);
  const read=(r,maximum=2*1024**2)=>JSON.parse(readEvidenceFile(warmPrivateFile.parse(r),{maximum}));
  const seal=read(donorSeal),accepted=read(seal.consumption),raw=read(seal.rawResponse),projection=read(seal.projection);
  const review=read(seal.independentReview),failed=read(seal.originalFailedTerminal),ended=read(seal.successorTerminal);
  const launched=read(seal.successorLaunch),opening=read(seal.start),source=read(accepted.sourceInputs);
  const op=seal.originalSeedOperationId,cont=seal.continuationOperationId,oldInv=seal.originalInvocation,newInv=seal.successorInvocation;
  const completeResponse=r=>r&&r.exitCode===0&&!r.uncertain&&!r.stderr&&r.diagnosticsTruncated===false;
  need(seal.format===1&&seal.kind==='verified-warm-qualification-across-closed-invocations'
    &&seal.originalInvocationPassed===false&&seal.compositeQualificationPassed===true&&seal.productionAdmission===false
    &&z.uuid().safeParse(op).success&&z.uuid().safeParse(cont).success&&op!==cont&&oldInv!==newInv
    &&review.format===1&&review.status==='passed'&&review.independentReview===true
    &&review.operationId===cont&&review.originalOperationId===op&&same(review.consumption,seal.consumption)
    &&same(review.projection,seal.projection)&&same(review.rawResponse,seal.rawResponse)
    &&accepted.kind==='verified-private-supplemental-warm-qualification'&&accepted.originalInvocationPassed===false
    &&accepted.passed===true&&accepted.productionAdmission===false&&accepted.operationId===cont&&accepted.originalOperationId===op
    &&accepted.originalOutcome==='failed-preserved'&&accepted.originalInvocation===oldInv&&accepted.successorInvocation===newInv
    &&same(accepted.launch,seal.successorLaunch)&&same(accepted.terminal,seal.successorTerminal)
    &&same(accepted.rawResponse,seal.rawResponse)&&same(accepted.projection,seal.projection)&&same(accepted.start,seal.start)
    &&same(raw.launch,seal.successorLaunch)&&same(raw.terminal,seal.successorTerminal)&&same(raw.input,accepted.sourceInputs)
    &&Object.values(accepted.originalLocalRefs).some(r=>same(r,seal.originalFailedTerminal))
    &&completeResponse(failed.response)&&same(failed.observation,splitOriginalObservation(failed))
    &&failed.observation.state==='failed'&&failed.observation.completed===false&&failed.observation.originalEvidencePreserved===true
    &&failed.observation.unit==='nova-qa-qualified-'+op+'.service'
    &&[ended,launched].every(r=>completeResponse(r.response)&&r.operationId===cont&&same(r.observed,JSON.parse(r.response.stdout))&&
      same(r.input,accepted.sourceInputs)&&r.observed.unit==='nova-qa-warm-continuation-'+cont+'.service'&&r.observed.invocationId===newInv)
    &&ended.observed.state==='closed'&&launched.observed.state==='launched'&&completeResponse(raw.result)
    &&source.operationId===cont&&same(raw.request,opening.request)&&same(raw.sources,accepted.sources)&&same(raw.sources,opening.sources)
    &&same(Object.fromEntries(Object.entries(raw.sources).map(([k,r])=>[k,r.sha256])),SPLIT_OBSERVER_SOURCES)
    &&same(raw.programSha256,opening.programSha256)&&same(raw.route,opening.route),'required-distinct-closed-invocations-changed');
  const parsed=splitOriginalObservation({response:raw.result},512*1024),v=parsed.value,request=raw.request;
  need(parsed.ok===true&&v?.format===1&&v?.kind==='private-warm-continuation-observation'
    &&v.operationId===cont&&v.originalOperationId===op&&v.originalOutcome==='failed-preserved'&&v.originalInvocation===oldInv
    &&v.successorInvocation===newInv&&request.origin.operationId===op&&request.origin.invocationId===oldInv
    &&request.successorInvocation===newInv&&v.requestSha256===raw.requestSha256&&v.requestSha256===sha256(Buffer.from(canonical(request)+'\n'))
    &&v.workerClosed===true&&v.independentOriginalRestored===true&&v.sourceWorkspacesPreserved===true
    &&v.productionAdmission===false&&v.freshFullRehearsalStillRequired===true&&v.liveAcceptanceStillRequired===true
    &&same(v.origins,seal.originalScope)&&same(accepted.origins,v.origins)
    &&same(v.origins,{originalOutcome:'failed-preserved',originalWarmAndAttemptOneLifecycle:true,successorStoppedPreservation:[1],
      successorServiceLaunches:[2,3],originalOperationId:op,successorOperationId:cont,originalInvocation:oldInv,successorInvocation:newInv}),
    'separate-native-qualification-origin-required');
  const {observedAtMilliseconds,...stable}=v;
  need(Number.isSafeInteger(observedAtMilliseconds)&&observedAtMilliseconds>=opening.startedAtMs-30000&&
    observedAtMilliseconds<=raw.receivedAtMs+30000&&observedAtMilliseconds===accepted.observedAtMilliseconds&&same(stable,projection),
    'split-observation-was-not-verified');
  const old=startupQualificationBindingSchema.parse(v.originalQualificationBinding);
  const b=startupQualificationBindingSchema.parse(v.qualificationBinding), s=seal.actualSources, history=v.deferredCaptureHistory;
  const failures=v.priorFailedContinuations;
  need(same(failures,request.origin.interveningFailures)
    &&same(Object.keys(failures).sort(),['configurationObserver','continuation','firstObserver'])
    &&Object.values(failures).every(row=>row.passed===false&&z.uuid().safeParse(row.operationId).success)
    &&new Set([op,cont,...Object.values(failures).map(row=>row.operationId)]).size===5
    &&s.protectedCustody.path==='/opt/nova-release-tools/qualified-startup-continuation-custody-'+failures.continuation.operationId+'/result.json',
    'different-intervening-qualification-or-custody');
  need(b.sameSchemaQualification&&b.prior.version==='2.28.39'&&Object.values(b.targets).every(t=>t.version==='2.28.46')
    &&b.prior.candidateId===seal.priorCandidateId&&b.targets.private.candidateId===seal.testedCandidateId
    &&b.workspaceEpoch===seal.workspaceEpoch&&seal.parkedSourceManifestSha256===v.references.baselineManifest.sha256
    &&same(old.helpers,COMPLETE_CAPTURE_STARTUP_HELPERS)&&same(b.helpers,PARKED_CAPTURE_STARTUP_HELPERS)
    &&same({...old,helpers:b.helpers},b)&&same(accepted.scenarios,STARTUP_SCENARIOS)
    &&same(v.scenarios.map(row=>row.scenario),STARTUP_SCENARIOS)&&history.kind==='held-prior-capture-origin'
    &&same(history,seal.originalWarmHistory)&&seal.jobId===history.jobId&&accepted.actualPrior===b.prior.candidateId
    &&accepted.actualTarget===b.targets.private.candidateId,'different-antecedent-application-or-workspace');
  verifyDeferredCaptureHistory(v,b,true);verifyDeferredCaptureScenarios(v,b,true);
  verifyCombinedPriorBuilders(v,b,cont);
  const roles={parent:'successor/parent',chain:'successor/chain',warmSource:'warmSource',outsideClosure:'successor/outsideClosure',
    disposableRoles:'successor/disposableRoles',seedReplicas:'original/seedReplicas',producer:'successor/source/continue.py',
    terminal:'control/terminal',protectedCustody:'custody',originalFailedStderr:'original/failed/stderr'};
  need(Object.keys(s).length===Object.keys(roles).length&&Object.entries(roles).every(([k,role])=>same(digestRef(v.references[role]),s[k]))
    &&same(s.parent,request.parent)&&same(s.chain,request.chain)&&same(s.warmSource,request.origin.warmSource)
    &&same(s.originalFailedStderr,failed.observation.files.stderr)&&same(s.protectedCustody,request.origin.protectedCustody)
    &&same(s.parent,digestRef(ended.observed.result))&&same(s.chain,digestRef(ended.observed.chain))
    &&same(s.terminal,digestRef(ended.observed.terminal))&&same(request.controlRefs.launch,digestRef(launched.observed.launch))
    &&same(accepted.stageSources,request.sourceFiles)&&Object.entries(source.files).every(([k,r])=>request.sourceFiles[k]?.sha256===r.sha256)
    &&Object.entries(request.sourceFiles).every(([k,r])=>v.sourceHashes[k]===r.sha256)&&same(s.producer,request.sourceFiles['continue.py'])
    &&verifiedFirstStoppedFile(v.references['target-first-start/preservation'],seal.firstStoppedVerification),
    'split-native-source-refs-changed');
  for(const [key,r] of Object.entries(request.origin.firstLifecycleRoles)){
    const scenarioRole=key.startsWith('startup-1-capture-')?'deferred/'+key.slice('startup-1-capture-'.length):key;
    need(same(digestRef(v.references['original/first/'+key]),r)&&v.references['target-first-start/'+scenarioRole].sha256===r.sha256,
      'split-first-lifecycle-changed');
  }
  return warmAuthoritySchema.parse({format:2,kind:'verified-supplemental-warm-antecedent',operationId:op,continuationOperationId:cont,
    originalInvocation:oldInv,successorInvocation:newInv,jobId:seal.jobId,priorCandidateId:seal.priorCandidateId,epoch:seal.workspaceEpoch,
    baselineSha256:seal.parkedSourceManifestSha256,...s,nativeOutputSha256:seal.rawResponse.sha256,projectionSha256:seal.projection.sha256,
    consumptionSha256:seal.consumption.sha256,independentReviewSha256:seal.independentReview.sha256});
}

function verifyParkedLoan(proof,request,binding,version){
  const a=warmAuthoritySchema.parse(request.warmAntecedent), l=proof.parkedSeedAntecedent;
  const root='/mnt/nova-data/qualified-startup-inputs-'+a.operationId;
  const seed=proof.references['parkedLoan/seedReplicas'];
  const formal=proof.references['parkedLoan/formalSeedReplicas'];
  need(formal?.path==='/mnt/nova-data/qualified-startup-inputs-'+proof.qualificationOperationId+'/replica-verified.json'
    &&hostRef.safeParse(digestRef(formal)).success&&Number.isSafeInteger(formal.bytes)&&formal.bytes>0&&formal.bytes<=64*1024**2
    &&hash.safeParse(l?.loanSha256).success,'formal-parked-seed-receipt-required');
  need(seed?.path===root+'/replica-verified.json'&&hostRef.safeParse(digestRef(seed)).success
    &&Number.isSafeInteger(seed.bytes)&&seed.bytes>0&&seed.bytes<=64*1024**2,'parked-original-seed-receipt-required');
  const expected={kind:'verified-parked-seed-antecedent',operationId:a.operationId,continuationOperationId:a.continuationOperationId,workspace:root+'/seeds/workspace',
    sourceManifestSha256:a.baselineSha256,warmJobId:a.jobId,nativeOutputSha256:a.nativeOutputSha256,
    projectionSha256:a.projectionSha256,seedReceiptSha256:seed.sha256,formalSeedReceiptSha256:formal.sha256,loanSha256:l.loanSha256};
  need(same(l,expected)&&new Set([a.operationId,a.continuationOperationId,proof.qualificationOperationId]).size===3&&a.priorCandidateId===binding.prior.candidateId
    &&binding.prior.version==='2.28.39'&&Object.values(binding.targets).every(t=>t.version===version)
    &&a.epoch===binding.workspaceEpoch&&a.baselineSha256===proof.deferredCaptureHistory.sourceManifestSha256
    &&proof.deferredCaptureHistory.kind==='signed-prior-capture-windows'
    &&properOriginalCaptureRefs(proof,a),'parked-seed-formal-antecedent-mismatch');
}
function properOriginalCaptureRefs(proof,a){
  return ['parent','warmSource','disposableRoles','outsideClosure','chain','originalFailedStderr','protectedCustody','terminal','producer'].every(k=>{
    const v=proof.references['parkedLoan/'+k];
    return v&&same(digestRef(v),a[k])&&Number.isSafeInteger(v.bytes)&&v.bytes>0&&v.bytes<=8*1024**2;
  })&&same(proof.scenarios.map(s=>s.scenario),STARTUP_SCENARIOS)
    &&proof.scenarios.every(s=>z.uuid().safeParse(s.captureDeferred?.jobId).success
      &&s.captureDeferred.jobId===proof.scenarios[0].captureDeferred.jobId&&s.captureDeferred.jobId!==a.jobId);
}

export const startupQualificationOptionsSchema=z.object({format:z.literal(1),parent:hostRef,producer:hostRef,warmEvidence:warmEvidenceSchema.optional()}).strict();
// Reviewed producer bytes identify the only accepted evidence implementation.
// Source review alone never replaces its actual settled qualification result.
export const QUALIFIED_STARTUP_SOURCES=Object.freeze({
  'qualified-startup.py':'82794c1b913e241bd881d8c89dac4871c2c4b5ae70c12f362754f9fcc60cc9fb',
  'qualified-parent.py':'11bd0945c69845cd66a5f3dd6024328b4630011bbd5a0640690a18584686d722',
  'produce-startup-inputs.py':'caedf6794abfeb20f55b48d983bec238c73d57b501c9b212d800fda7a5d803b5',
  'contracts.py':'99b4ec258324ce3d87e52a01ddd17dcddd76324c204fc6ce6ad991ee3fdbb32d',
});
// Separate exact producer family for a closed schema-60 source and target.
export const SAME_SCHEMA60_STARTUP_SOURCES=Object.freeze({"qualified-startup.py":"2b86508e231a282ceab5b36796090b5759d66ff9dc43c47a93dd766e3d926dff","qualified-parent.py":"81410714bcb95d168fd8c3e90837813a8ce11847bf9b111cc5ecb5c874aa3036","produce-startup-inputs.py":"d4b8dbb9cf866fa12726cf1360b6704f1d7fdf3697a85b805274844eb050ea61","contracts.py":"ec2d4f7942d291c617cc69d57b8492fe9484db9b9495ca1b8c29510f8f608145"});
// Additional exact source family; every actual candidate proof remains mandatory.
export const RETIRED_RECAPTURE_STARTUP_SOURCES=Object.freeze({"qualified-startup.py":"f9307cd30f7c9b4b50034e81942604772f93027f5ba915ebd9e9176e67b00092","qualified-parent.py":"81410714bcb95d168fd8c3e90837813a8ce11847bf9b111cc5ecb5c874aa3036","produce-startup-inputs.py":"12d59c2b45e9a6791cba66cec1d9cf0c077ebce3e6cc12392b6090a3e6a0c580","contracts.py":"ec2d4f7942d291c617cc69d57b8492fe9484db9b9495ca1b8c29510f8f608145"});
export const REHEARSAL_SCHEMA60_STARTUP_SOURCES=Object.freeze({"qualified-startup.py":"0c86d97f56addc71e0d8c57665265da1f40009f14caf19bcf75c1899f4d430c6","qualified-parent.py":"81410714bcb95d168fd8c3e90837813a8ce11847bf9b111cc5ecb5c874aa3036","produce-startup-inputs.py":"12d59c2b45e9a6791cba66cec1d9cf0c077ebce3e6cc12392b6090a3e6a0c580","contracts.py":"ec2d4f7942d291c617cc69d57b8492fe9484db9b9495ca1b8c29510f8f608145"});
export const DEFERRED_CAPTURE_STARTUP_SOURCES=Object.freeze({...REHEARSAL_SCHEMA60_STARTUP_SOURCES,
  'qualified-startup.py':'50f964d0b766a3795d6f819e555da511b58bde3ad3a066f489663067b92971f0'});
// Verified shutdown, restart and rollback for the warmed retained workspace.
export const COMPLETE_CAPTURE_STARTUP_SOURCES=Object.freeze({...DEFERRED_CAPTURE_STARTUP_SOURCES,
  'qualified-startup.py':'3cd8a8699d79011c826ce4e3cbd934fa9611742f418bf614cb917a1d84db63a8',
  'produce-startup-inputs.py':'4cf7e44d800c1c0032f5c4f770d2f6e68f2609c205462e083277597a27fdd68d',
  'qualified-parent.py':'87dfd58860bf166219e0a73cab36c0ce8682a0aa3722cd53d05b6c9abafbed66'});
export const PARKED_CAPTURE_STARTUP_SOURCES=Object.freeze({"contracts.py":"013ea5762fee279ddc614d90e201744b332484f2eb11768c8e4212663da2be4a","produce-startup-inputs.py":"0032c2633b1119a2b15a069e61b357d01bbe83fbbead1d3ea66d2c0e78f96f5a","qualified-parent.py":"87dfd58860bf166219e0a73cab36c0ce8682a0aa3722cd53d05b6c9abafbed66","qualified-startup.py":"7e36af529fb353224722c6db2a2d9c2ea068f490913e2d4bef3c2ae487734e69"});
const WARM_ANTECEDENT_SOURCES=Object.freeze({"qualified-startup.py":"993ec3498edbadeb6f730012f709bb63638b607aeb82b2145da0683384d98e18","qualified-parent.py":"87dfd58860bf166219e0a73cab36c0ce8682a0aa3722cd53d05b6c9abafbed66","produce-startup-inputs.py":"4cf7e44d800c1c0032f5c4f770d2f6e68f2609c205462e083277597a27fdd68d","contracts.py":"ec2d4f7942d291c617cc69d57b8492fe9484db9b9495ca1b8c29510f8f608145"});
export const RETAINED_BINDINGS_STARTUP_SOURCES=Object.freeze({...PARKED_CAPTURE_STARTUP_SOURCES,
  'produce-startup-inputs.py':'3bd0f9e1dae5d233df062a80404c643c24507a9f310d7ae2a8670177ca4f57b7',
  'qualified-startup.py':'9cff2dd7717c5e9d0c5c41421f43a625ae3be6e7f5e6d2307d394d7ff1777f43'});
export const RETAINED_WINDOW_STARTUP_SOURCES=Object.freeze({...RETAINED_BINDINGS_STARTUP_SOURCES,
  'produce-startup-inputs.py':'7ec78cc4d026587a515dba58c7e41b6a0876f156f1e157c2f0b453341eadf202',
  'qualified-startup.py':'896b22918d9e0c184b6942e4d1c13f95e06d86ce1845fab2bbc41a85ebedbfac'});
const parkedReleases=[
  [PARKED_CAPTURE_STARTUP_SOURCES,'2.28.48'],
  [RETAINED_BINDINGS_STARTUP_SOURCES,'2.28.49'],
  [RETAINED_WINDOW_STARTUP_SOURCES,'2.28.50'],
];
const parkedVersion=sources=>parkedReleases.find(([family])=>same(family,sources))?.[1];
const sameSchemaSourceFamilies=[...parkedReleases.map(([family])=>family),SAME_SCHEMA60_STARTUP_SOURCES,RETIRED_RECAPTURE_STARTUP_SOURCES,REHEARSAL_SCHEMA60_STARTUP_SOURCES,DEFERRED_CAPTURE_STARTUP_SOURCES,COMPLETE_CAPTURE_STARTUP_SOURCES];
const sameSchemaSources=sources=>sameSchemaSourceFamilies.some(v=>v!==null&&same(sources,v));
export const SAME_SCHEMA60_STARTUP_HELPERS=Object.freeze({"install.py":"b4cf0ee98ebb80723dba69425f55409adecf7f3d7427d42b53c037251f4b6200","recovery.py":"b4c59da8ee92a1ddf2bbaef4139635494123eab2b299e7e6ea5e627629652ee4","operator_rehearsal.py":"081d4f928b6800ff05dd5a0dbfc3416031425a0c892c5186d994533ca42b1b21","app_dependencies.py":"e7f2617ed8d05b7d83da62e857822b737ff3a1c47b6704af5d3e1783e043b290","codex_log_retention.py":"bc6b09a2b99a9667c9c8fac63f2665362aa3e14b8db10d6be12652250ae2a1f4","workspace_key.py":"e97ae151ff8208c6831e93ef3281e1b1dbff99f4eea4679aa7f6a8ed06c412d2","verify-session-bindings.mjs":"1d51c2af378f27f21c9580a367779ab9192c159c600f02938d780a5de467c5c0","hosted_retained_configuration.py":"a65dff849aa242a0c8eeb51f86ad2cd1cf36a62229169e0197947492d372f55e","local-retained-configuration.mjs":"ec8c0caefbd7bd14cd032755c1351d332dcc00fdd4c1454264678945e1353b56","hosted_retained_catalog.py":"59b33ec350f640d2b8fe2d493e22756f557910ebf2a8cccd107998c9314b9328","hosted-retained-catalog.mjs":"431d5f2741e46a8b2258b6eab22786d369d570c6ec5824434ef0dd2dd4b5f1db"});
export const HISTORICAL_SCHEMA60_HELPERS=Object.freeze({...SAME_SCHEMA60_STARTUP_HELPERS,
  'install.py':'54d8495b616ae94dfce928470ffc46860331f71fc93c70af081f7061943e36ef',
  'recovery.py':'113f2c937e40eac597ec056fcc8042e69392505fa5f5f96dd44a1ea9441e3b11',
  'operator_rehearsal.py':'8fe10fd13b924b78e8eccbe01334ce627e09c46961e5750062c57dcfe957a8d2',
});
export const DEFERRED_CAPTURE_STARTUP_HELPERS=Object.freeze({...SAME_SCHEMA60_STARTUP_HELPERS,
  'install.py':'d44cba1bddb9c39703cc8714e4fe3d5af4704429e746f47efe7a29a533b6b572',
  'recovery.py':'6081a0364c912442a4ff41eecaf99121b35d619ff6a31f0d6aa1310da5b489ee'});
export const COMPLETE_CAPTURE_STARTUP_HELPERS=Object.freeze({...DEFERRED_CAPTURE_STARTUP_HELPERS,
  'install.py':'5199f95f11be155cdd280fec9d315e087ea6951d71bc3020b2cf6678f3d49d8d',
  'recovery.py':'4d6696f7ae03863a66a5e28e1e0aa25dbdc673c7fb97ce401894e0cd7182e787',
  'operator_rehearsal.py':'013dee562963009ab812c5d7d8d1c327783be522b9d95a1e31a966ed46e0d93f'});
export const PARKED_CAPTURE_STARTUP_HELPERS=Object.freeze({...COMPLETE_CAPTURE_STARTUP_HELPERS,'recovery.py':"c316469b114f6beb232cd3fb784b733d7bc13b0696c33523d0ec6cba6ae37c1f"});
export const RETAINED_BINDINGS_STARTUP_HELPERS=Object.freeze({...PARKED_CAPTURE_STARTUP_HELPERS,
  'install.py':'b277ec67598a3a189278eeaca298516b061f9a1ff94569714c9779c8a91b0978',
  'hosted_retained_configuration.py':'7f7e5e3c7730f90e116d38da1ef1c19acab0e437ca26dfc1ff832309dc777a4d',
  'operator_rehearsal.py':'5ec3bc4bc86cdfcafeddbc36d98b247ecd52fed945da6c1c8dbb812e5c12338d'});
function helpersForStartupSources(sources){
  if(same(sources,RETAINED_WINDOW_STARTUP_SOURCES)||same(sources,RETAINED_BINDINGS_STARTUP_SOURCES))return RETAINED_BINDINGS_STARTUP_HELPERS;
  if(same(sources,PARKED_CAPTURE_STARTUP_SOURCES))return PARKED_CAPTURE_STARTUP_HELPERS;
  if(same(sources,COMPLETE_CAPTURE_STARTUP_SOURCES)||same(sources,WARM_ANTECEDENT_SOURCES))return COMPLETE_CAPTURE_STARTUP_HELPERS;
  if(same(sources,DEFERRED_CAPTURE_STARTUP_SOURCES))return DEFERRED_CAPTURE_STARTUP_HELPERS;
  return same(sources,REHEARSAL_SCHEMA60_STARTUP_SOURCES) ? SAME_SCHEMA60_STARTUP_HELPERS : HISTORICAL_SCHEMA60_HELPERS;
}
export function reviewedSameSchemaHelperFamilies(){
 return [...new Set(sameSchemaSourceFamilies.filter(Boolean).map(helpersForStartupSources))];
}
export function reviewedStartupSources(producer){
 const sources=[QUALIFIED_STARTUP_SOURCES,...sameSchemaSourceFamilies].find(v=>v!==null&&producer?.sha256===v['qualified-startup.py']);
 need(sources,'reviewed-startup-producer-required');return sources;
}
// Exact source capability only; it grants no candidate or runtime acceptance.
const retiredRecaptureProducers=new Set([RETIRED_RECAPTURE_STARTUP_SOURCES,REHEARSAL_SCHEMA60_STARTUP_SOURCES,DEFERRED_CAPTURE_STARTUP_SOURCES,COMPLETE_CAPTURE_STARTUP_SOURCES].map(family=>family['qualified-startup.py']));
const CAPTURE_RETIREMENT_PRODUCER='bf65b3f46cdabb5272c7bc2a6824fd242b46d761255f2633887a6f9b61b3fd58';
const CAPTURE_REAPING_PRODUCER='7ca0aa07ead0d6d6672352a59a520cd93e42295993cd36064994bfb701cfe6eb';
const CAPTURE_REAPING_PRODUCERS=new Set([CAPTURE_REAPING_PRODUCER,'352ce2f79419c0722e902a15df639a04b7854d87d3bab6ed7d79484148da6db9','4e1f6d0aaa729b5df938bb0566e7442be6abf9bfc832c0b5ab1cfcd1746b7dd3',
  '479a10e7303411aaf5e76a08d857747798cf6a65362fdd75a2808d7f2a585294',
  '4404a1c0a7658c206b49d6daa64e4f7c1c0bf8ffa905ce19a4015312c823d599',
  'f1004fc0fafec1669c5bd4822cf27925d64e861b0bb74301a033a431becccc10',
  'f8de414f4822707675dbe0fca150ad0dd917202579bacd8432a6115c4a218a28',QUALIFIED_STARTUP_SOURCES['qualified-startup.py']]);
export const STARTUP_SCENARIOS=Object.freeze(['target-first-start','target-restart','pristine-prior-restoration']);
export const STARTUP_BARRIER_FILES=Object.freeze(['gateway.js','http.js','runtime.js','software-updates.js','store.js','update-maintenance.js','update-native-idle.js','update-native-startup.js'].map(n=>'dist/service/apps/service/'+n));
const HELPERS=['install.py','recovery.py','operator_rehearsal.py','app_dependencies.py','codex_log_retention.py','workspace_key.py','verify-session-bindings.mjs'];
export const APPLICATION_TRANSITION_HELPERS=Object.freeze(['hosted_retained_configuration.py','local-retained-configuration.mjs','hosted_retained_catalog.py','hosted-retained-catalog.mjs']);
export function startupHelperNames(marker=null){qualificationMarkerFields(marker);return [...HELPERS,...(marker?APPLICATION_TRANSITION_HELPERS:[])];}
const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const encoded=v=>Buffer.from(canonical(v)+'\n');
const digestMap=z.record(z.string().min(1).max(512),hash);
export {applicationTransitionSchema,sameSchemaQualificationSchema,startupQualificationMarker,qualificationMarkerFields};
/** This describes the only supported schema change; it grants no qualification.
 * The caller must still authenticate the complete original startup projection. */
export function assertStartupApplicationTransition(binding,prior,target){
  const marker=startupQualificationMarker(binding);
  need(prior.apiVersion===1&&target.apiVersion===1,'actual-startup-schema-or-api-unsupported');
  if(prior.schemaVersion===target.schemaVersion&&[55,60].includes(prior.schemaVersion)){
    need(!Object.hasOwn(binding,'applicationTransition'),'unexpected-startup-application-transition');
    need(prior.schemaVersion===60?marker?.kind==='schema-60-same-runtime':marker===null,'actual-startup-same-schema-qualification-required');return null;
  }
  need(prior.schemaVersion===55&&target.schemaVersion===60,'actual-startup-schema-transition-unsupported');
  need(!Object.hasOwn(binding,'sameSchemaQualification'),'unexpected-startup-same-schema-qualification');
  return applicationTransitionSchema.parse(binding.applicationTransition);
}
const targetSchema=z.object({candidateId:hash,version:z.string(),buildVersion:z.string(),archiveSha256:hash,
  archiveBytes:z.number().int().positive(),ciSourceSha256:hash,packageSha256:hash,packageLockSha256:hash,candidateManifestSha256:hash}).strict();
export const startupQualificationBindingSchema=z.object({format:z.literal(1),kind:z.literal('same-runtime-startup-candidate-binding'),
  sourceCommits:z.object({private:commit,public:commit}).strict(),prior:z.object({candidateId:hash,version:z.string()}).strict(),
  targets:z.object({private:targetSchema,public:targetSchema}).strict(),serviceArtifacts:digestMap,
  hostEntrypointSha256:hash,dependencyGraphSha256:hash,helpers:digestMap,runtime:z.record(z.string(),z.unknown()),workspaceEpoch:z.uuid(),
  applicationTransition:applicationTransitionSchema.optional(),sameSchemaQualification:sameSchemaQualificationSchema.optional(),applicationDependencies:applicationDependencyDescriptionSchema.optional(),
}).strict().refine(v=>!(Object.hasOwn(v,'applicationTransition')&&Object.hasOwn(v,'sameSchemaQualification')),'startup-qualification-marker-conflict');
function sourcesReviewed(sources){
  need(same(Object.keys(sources).sort(),Object.keys(QUALIFIED_STARTUP_SOURCES).sort())
    &&Object.values(sources).every(v=>hash.safeParse(v).success&&v!=='0'.repeat(64)),'reviewed-startup-producer-required');
  const registered=parkedReleases.find(([family])=>family['qualified-startup.py']===sources['qualified-startup.py']);
  if(registered)need(same(registered[0],sources),'parked-startup-source-family-changed');
}
export function startupRetainedRequest(options,sources=undefined){
  const v=startupQualificationOptionsSchema.parse(options);sources??=reviewedStartupSources(v.producer);sourcesReviewed(sources);
  need(v.producer.sha256===sources['qualified-startup.py']&&v.producer.path.endsWith('/qualified-startup.py')
    &&v.parent.path.endsWith('/evidence/parent-verified.json'),'reviewed-startup-producer-required');
  need(!same(sources,WARM_ANTECEDENT_SOURCES),'warm-test-cannot-be-a-release-proof');
  const parked=Boolean(parkedVersion(sources));
  need(parked===Object.hasOwn(v,'warmEvidence'),'parked-original-warm-evidence-required');
  return{format:1,kind:'collect-actual-retained-startup-proof',parent:v.parent,producer:v.producer,...(parked?{warmAntecedent:readParkedWarmAuthority(v.warmEvidence)}:{})};
}
export function buildStartupRetainedProgram(request){
  const sources=reviewedStartupSources(request.producer);
  if(parkedVersion(sources)){
    need(same(Object.keys(request).sort(),['format','kind','parent','producer','warmAntecedent'])&&request.format===1&&request.kind==='collect-actual-retained-startup-proof'
      &&hostRef.parse(request.parent).path.endsWith('/evidence/parent-verified.json')&&hostRef.parse(request.producer).path.endsWith('/qualified-startup.py'),'parked-request-original-paths-required');
    warmAuthoritySchema.parse(request.warmAntecedent);
  }else need(same(request,startupRetainedRequest({format:1,parent:request.parent,producer:request.producer})),'startup-collector-request-changed');
  const source=readFileSync(new URL('./release-startup-retained-proof.py',import.meta.url));
  const payload=encoded({source:source.toString('base64'),sha256:sha256(source),request,sources,...(sameSchemaSources(sources)?{sameSchemaHelpers:helpersForStartupSources(sources)}:{})}).toString('base64');
  return `import base64,hashlib,json,signal,resource\nv=json.loads(base64.b64decode('${payload}',validate=True));s=base64.b64decode(v['source'],validate=True)\nassert hashlib.sha256(s).hexdigest()==v['sha256']\nresource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2));signal.alarm(110)\nn={'__name__':'fixed_startup_retained_consumer'};exec(compile(s,'fixed-startup-retained-consumer','exec'),n)\nprint(json.dumps({'ok':True,'value':n['invoke'](v['request'],v['sources'],v.get('sameSchemaHelpers'))},separators=(',',':')))\n`;
}

function verifyDeferredCaptureHistory(proof,binding,complete=false){
  const timestamp=z.number().int().positive();
  const window=z.tuple([timestamp,timestamp]).refine(([a,b])=>a<=b&&b-a<=3600);
  if(complete){
    const role=z.string().regex(/^recovered-workspaces\/[a-f0-9-]{36}\/openclaw-runtime\/state\/tmp\/plugin-captures\/[a-f0-9-]{36}\/owner\.sqlite$/);
    const history=z.object({kind:z.literal('held-prior-capture-origin'),jobId:z.uuid(),priorCandidateId:hash,epoch:z.uuid(),
      sourceManifestSha256:hash,sourceEvidenceSha256:hash,sourceRolesSha256:hash,sourceRosterSha256:hash,
      priorEvidenceSha256:hash,selectedRole:role,sourceStatus:z.enum(['stage','released','retired']),windows:z.record(role,window)}).strict().parse(proof.deferredCaptureHistory);
    need(history.priorCandidateId===binding.prior.candidateId&&history.epoch===binding.workspaceEpoch
      &&history.sourceManifestSha256===proof.references?.['warm-source/workspaceManifest']?.sha256
      &&history.sourceEvidenceSha256===proof.references?.['warm-source/held-prior-native-capture']?.sha256
      &&Object.hasOwn(history.windows,history.selectedRole)&&Object.keys(history.windows).length<=2,
      'held-prior-capture-source-changed');
    const dir=proof.kind==='private-warm-continuation-observation'?proof.references.warmSource.path.slice(0,-'warm-source.json'.length):proof.references.parent.path.slice(0,-'parent-verified.json'.length);
    for(const key of ['warmSource','warm-source/workspaceManifest',...['started','process','ready','bootstrap',
      'startup-0-capture-writer','held-prior-native-capture','prior-stop','stopped-source','closed'].map(k=>'warm-source/'+k)]){
      const ref=proof.references[key];
      const file=key==='warmSource'?'warm-source.json':key==='warm-source/workspaceManifest'?
        'warm-source-workspace-manifest.json':'warm-origin/'+key.split('/')[1]+'.json';
      need(hostRef.safeParse({path:ref?.path,sha256:ref?.sha256}).success&&ref.path===dir+file
        &&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=32*1024**2,'actual-warm-source-reference-required');
    }
    return;
  }
  const history=z.object({kind:z.literal('signed-prior-capture-windows'),priorCandidateId:hash,epoch:z.uuid(),
    sourceManifestSha256:hash,sourceEvidenceSha256:hash,sourceRolesSha256:hash,
    windows:z.object({'target-first-start':window,'target-restart':window}).strict()}).strict().parse(proof.deferredCaptureHistory);
  need(history.priorCandidateId===binding.prior.candidateId&&history.epoch===binding.workspaceEpoch
    &&history.sourceManifestSha256===proof.references?.baselineManifest?.sha256
    &&history.windows['target-first-start'][1]<=history.windows['target-restart'][0],
    'deferred-capture-history-binding-changed');
  for(const [role,name] of [['parent','parent-verified.json'],['preservation','attempt-1/preservation.json'],
                           ['proof','attempt-1/capture-continuity.json']]){
    const ref=proof.references['capture-template/'+role];
    need(hostRef.safeParse({path:ref?.path,sha256:ref?.sha256}).success&&ref.path.endsWith('/'+name)
      &&Number.isSafeInteger(ref.bytes)&&ref.bytes>0,'deferred-history-original-template-required');
  }
  for(const name of ['target-first-start','target-restart']){
    for(const role of ['started','process','ready','closed']){
      const ref=proof.references['capture-history/'+name+'/'+role];
      need(hostRef.safeParse({path:ref?.path,sha256:ref?.sha256}).success&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0,
        'deferred-history-original-lifecycle-required');
    }
  }
}

function verifyDeferredCaptureScenarios(proof,binding,complete=false){
  const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const root=z.tuple([integer.positive(),integer.positive(),integer.refine(v=>(v&0o170000)===0o040000),integer,integer]);
  const disposition=z.enum(['all-retired','staging-present','released-present']);
  const shape=z.object({kind:z.literal('closed-native-deferred-capture'),attempt:z.number().int().min(1).max(3),
    candidateId:hash,workspaceEpoch:z.uuid(),ordinaryWindow:z.tuple([integer,integer]),physicalRoots:z.tuple([root,root]),
    baselineSha256:hash,beforeRosterSha256:hash,afterRosterSha256:hash,beforeSha256:hash,closedSha256:hash,
    writerFileSha256:hash.nullable(),addedCount:integer.max(1),removedCount:integer.max(1),historySha256:hash,
    partitionSha256:hash,admissionsSha256:hash,closedCatalogSha256:hash,predecessorSha256:hash.nullable(),
    ...(complete?{beforeDisposition:disposition,closedDisposition:disposition,jobId:z.uuid(),
      addedRetiredCount:integer.max(1),addedStageCount:integer.max(1),addedReleasedCount:integer.max(1),addedBuildRoleCount:integer.max(1)}:{})}).strict();
  const first=proof.scenarios[0].captureDeferred??proof.scenarios[0].captureTransition;
  const historyHash=sha256(Buffer.from(canonical(proof.deferredCaptureHistory)));
  for(const [index,scenario] of proof.scenarios.entries()){
    if(!scenario.captureDeferred)continue;
    const row=shape.parse(scenario.captureDeferred), prior=proof.scenarios[index-1]?.captureDeferred;
    need(row.attempt===index+1&&row.candidateId===scenario.candidateId&&row.workspaceEpoch===binding.workspaceEpoch
      &&row.historySha256===historyHash&&same(row.ordinaryWindow,[scenario.startedAtSeconds,scenario.closedAtSeconds])
      &&same(row.physicalRoots[0],first.physicalRoots[0])&&!same(row.physicalRoots[0].slice(0,2),row.physicalRoots[1].slice(0,2))
      &&row.physicalRoots[0][0]===scenario.replicaConfigObservation?.sourceDevice
      &&row.physicalRoots[1][0]===scenario.replicaConfigObservation?.replicaDevice
      &&(complete||row.addedCount===0||row.writerFileSha256!==null),'deferred-scenario-native-binding-changed');
    if(complete){
      const sourceKind=proof.deferredCaptureHistory.kind;
      need(row.jobId===first.jobId&&(proof.parkedSeedAntecedent?row.jobId!==proof.parkedSeedAntecedent.warmJobId:row.jobId===proof.deferredCaptureHistory.jobId)&&row.addedCount===row.addedRetiredCount+row.addedReleasedCount+row.addedStageCount
        &&(row.addedStageCount===0||row.closedDisposition==='staging-present'&&row.writerFileSha256!==null)
        &&(row.addedReleasedCount===0||row.closedDisposition==='released-present'&&row.writerFileSha256!==null)
        &&row.addedBuildRoleCount<=row.addedCount&&(row.addedBuildRoleCount===0||row.writerFileSha256!==null)
        &&(index===1?row.beforeDisposition===prior?.closedDisposition:row.beforeDisposition===(proof.parkedSeedAntecedent?'all-retired':({stage:'staging-present',released:'released-present',retired:'all-retired'})[proof.deferredCaptureHistory.sourceStatus]))
        &&(sourceKind==='signed-prior-capture-windows'&&row.beforeDisposition==='all-retired'&&row.closedDisposition==='all-retired')===Object.hasOwn(scenario,'captureTransition'),
        'complete-native-scenario-coverage-changed');
      if(scenario.captureTransition)need(same(row.physicalRoots,scenario.captureTransition.physicalRoots)
        &&same(row.ordinaryWindow,scenario.captureTransition.ordinaryWindow),'supplementary-retired-scope-changed');
    }
    if(index===1){
      need(same(row.physicalRoots,first.physicalRoots)&&(prior?
        row.predecessorSha256===prior.closedSha256&&row.beforeRosterSha256===prior.afterRosterSha256&&row.baselineSha256===prior.baselineSha256:
        row.predecessorSha256===null&&first.closedLiveInventorySha256===first.baselineInventorySha256),
        'deferred-scenario-restart-ancestry-changed');
    }else{
      need(row.predecessorSha256===null&&(index!==2||!same(row.physicalRoots[1].slice(0,2),first.physicalRoots[1].slice(0,2))),
        'deferred-scenario-pristine-state-required');
    }
    for(const [role,expected] of [['before',row.beforeSha256],['closed',row.closedSha256],['writer',row.writerFileSha256]]){
      const ref=proof.references[scenario.scenario+'/deferred/'+role];
      if(expected===null){need(ref===undefined,'unexpected-deferred-writer-reference');continue;}
      need(hostRef.safeParse({path:ref?.path,sha256:ref?.sha256}).success&&ref.sha256===expected
        &&ref.path.endsWith('/attempt-'+row.attempt+'/startup-'+row.attempt+'-capture-'+role+'.json')
        &&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=32*1024**2,'deferred-scenario-original-reference-changed');
    }
  }
}

function verifyCaptureTransition(proof,binding,mixed=false){
  const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const root=z.tuple([integer.positive(),integer.positive(),integer.max(0o177777).refine(v=>(v&0o170000)===0o040000),integer,integer]);
  const window=z.tuple([integer,integer]).refine(v=>v[1]>=v[0]&&v[1]-v[0]<=3600);
  const hashes=['packetSha256','proofSha256','beforeSha256','closedSha256','writerSourcesSha256','baselineManifestSha256',
    'originsSha256','observationRefsSha256','authorityContextSha256','baselineInventorySha256','beforeLiveInventorySha256',
    'closedLiveInventorySha256','baselineClassificationSha256','beforeLiveClassificationSha256','closedLiveClassificationSha256',
    'baselinePartitionSha256','beforePartitionSha256','closedPartitionSha256','canonicalReportsSha256'];
  const shape=z.object({kind:z.literal('closed-9.8-retired-capture-transition'),candidateId:hash,workspaceEpoch:z.uuid(),
    selectedRelative:z.string().regex(/^recovered-workspaces\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
    attempt:integer.min(1).max(3),physicalRoots:z.tuple([root,root]),ordinaryWindow:window,
    predicateSha256:z.literal('df724c3ab3fcbfa53da4ec611603ababe0839c5a41900b606583ffe8a54b27a0'),
    ...Object.fromEntries(hashes.map(k=>[k,hash])),predecessorProofSha256:hash.nullable(),
    unchangedCatalogEarlyReturn:z.boolean(),canonicalFunctionObserved:z.boolean(),canonicalReportCount:integer.max(1)}).strict();
  const rows=proof.scenarios.map(s=>mixed&&!s.captureTransition?null:shape.parse(s.captureTransition));
  const first=rows.find(Boolean),initialRoot=proof.scenarios[0].captureDeferred?.physicalRoots??first?.physicalRoots;
  for(const [i,row]of rows.entries()){
    if(row===null)continue;
    const scenario=proof.scenarios[i],prior=rows[i-1];
    need(row.attempt===i+1&&row.candidateId===scenario.candidateId&&row.workspaceEpoch===binding.workspaceEpoch
      &&row.selectedRelative===first.selectedRelative&&same(row.ordinaryWindow,[scenario.startedAtSeconds,scenario.closedAtSeconds])
      &&same(row.physicalRoots[0],first.physicalRoots[0])&&same(row.physicalRoots[0].slice(3),row.physicalRoots[1].slice(3))
      &&row.physicalRoots[0][0]===scenario.replicaConfigObservation?.sourceDevice&&row.physicalRoots[1][0]===scenario.replicaConfigObservation?.replicaDevice
      &&!same(row.physicalRoots[0].slice(0,2),row.physicalRoots[1].slice(0,2))
      &&['predicateSha256','writerSourcesSha256','baselineManifestSha256','originsSha256','authorityContextSha256','baselineInventorySha256','baselineClassificationSha256','baselinePartitionSha256'].every(k=>row[k]===first[k]),
      'same-schema-capture-transition-binding-changed');
    need(row.unchangedCatalogEarlyReturn===(row.canonicalReportCount===0)&&row.canonicalFunctionObserved===(row.canonicalReportCount===1),
      'same-schema-capture-transition-callback-claim-changed');
    if(i===1){
      need(prior&&row.predecessorProofSha256===prior.proofSha256&&same(row.physicalRoots,prior.physicalRoots)
        &&row.beforeLiveInventorySha256===prior.closedLiveInventorySha256&&row.beforeLiveClassificationSha256===prior.closedLiveClassificationSha256
        &&row.beforePartitionSha256===prior.closedPartitionSha256,'same-schema-capture-transition-predecessor-changed');
    }else{
      need(row.predecessorProofSha256===null&&row.beforeLiveInventorySha256===row.baselineInventorySha256
        &&row.beforeLiveClassificationSha256===row.baselineClassificationSha256
        &&(i!==2||!same(row.physicalRoots[1].slice(0,2),initialRoot[1].slice(0,2))),
        'same-schema-capture-transition-pristine-required');
    }
    if(row.unchangedCatalogEarlyReturn)need(row.beforeLiveInventorySha256===row.closedLiveInventorySha256
      &&row.beforeLiveClassificationSha256===row.closedLiveClassificationSha256&&row.beforePartitionSha256===row.closedPartitionSha256,
      'same-schema-capture-transition-unchanged-state-required');
    for(const [role,file,key]of [['packet','capture-transition-packet.json','packetSha256'],['proof','capture-continuity.json','proofSha256'],
      ['before','capture-before.json','beforeSha256'],['closed','capture-closed.json','closedSha256']]){
      const ref=proof.references?.[scenario.scenario+'/transition/'+role];
      need(hostRef.safeParse({path:ref?.path,sha256:ref?.sha256}).success&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=16*1024**2
        &&ref.sha256===row[key]&&ref.path.endsWith('/attempt-'+(i+1)+'/'+file),'same-schema-capture-transition-raw-references-required');
    }
  }
}

function verifyCaptureContinuity(proof,binding){
  const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const directoryMode=integer.max(0o177777).refine(v=>(v&0o170000)===0o040000);
  const root=z.tuple([integer.positive(),integer.positive(),directoryMode,z.literal(999),z.literal(986)]);
  const window=z.tuple([integer,integer]).refine(v=>v[1]>=v[0]&&v[1]-v[0]<=3600);
  const report=z.object({sha256:hash,packageRootSha256:hash,originalSourceAdmissionsSha256:hash,
    currentSourceAdmissionsSha256:hash,namespaceMappingSha256:hash,
    windowSource:z.enum(['current-startup','exact-preceding-closed-state']),evaluatedWindow:window,
    predecessorClosedSha256:hash.nullable()}).strict();
  const shape=z.object({kind:z.literal('closed-9.8-retired-capture-continuity'),beforeSha256:hash,closedSha256:hash,proofSha256:hash,
    selectedRelative:z.string().regex(/^recovered-workspaces\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
    workspaceEpoch:z.uuid(),candidateId:hash,attempt:integer.min(1).max(3),physicalRoots:z.tuple([root,root]),ordinaryWindow:window,stagingCount:z.literal(0),
    baselineInventorySha256:hash,beforeLiveInventorySha256:hash,closedLiveInventorySha256:hash,
    baselineClassificationSha256:hash,beforeLiveClassificationSha256:hash,closedLiveClassificationSha256:hash,
    pathMappingSha256:hash,hardlinkClassesSha256:hash,predecessorClosedSha256:hash.nullable(),writerSourcesSha256:hash,
    canonicalReportsSha256:hash,namespaceMappingSha256:hash,timestampChangesSha256:hash,canonicalReports:z.array(report).min(1).max(8)}).strict();
  const rows=proof.scenarios.map(s=>shape.parse(s.captureContinuity)),first=rows[0];
  for(const [i,row]of rows.entries()){
    const scenario=proof.scenarios[i],prior=rows[i-1];
    need(row.attempt===i+1&&row.workspaceEpoch===binding.workspaceEpoch&&row.candidateId===scenario.candidateId
      &&row.selectedRelative===first.selectedRelative&&same(row.ordinaryWindow,[scenario.startedAtSeconds,scenario.closedAtSeconds])
      &&row.baselineInventorySha256===first.baselineInventorySha256&&row.baselineClassificationSha256===first.baselineClassificationSha256
      &&row.writerSourcesSha256===first.writerSourcesSha256&&same(row.physicalRoots[0],first.physicalRoots[0])
      &&row.physicalRoots[0][0]===scenario.replicaConfigObservation?.sourceDevice
      &&row.physicalRoots[1][0]===scenario.replicaConfigObservation?.replicaDevice
      &&!same(row.physicalRoots[0].slice(0,2),row.physicalRoots[1].slice(0,2)), 'same-schema-retired-capture-binding-changed');
    if(i===1){
      need(row.predecessorClosedSha256===prior.closedSha256&&same(row.physicalRoots,prior.physicalRoots)
        &&row.beforeLiveInventorySha256===prior.closedLiveInventorySha256
        &&row.beforeLiveClassificationSha256===prior.closedLiveClassificationSha256,
        'same-schema-retired-capture-predecessor-changed');
    }else{
      need(row.predecessorClosedSha256===null&&row.beforeLiveInventorySha256===row.baselineInventorySha256
        &&row.beforeLiveClassificationSha256===row.baselineClassificationSha256
        &&(i!==2||!same(row.physicalRoots[1].slice(0,2),first.physicalRoots[1].slice(0,2))),
        'same-schema-retired-capture-pristine-required');
    }
    for(const [suffix,key]of [['before','beforeSha256'],['closed','closedSha256'],['continuity','proofSha256']]){
      const ref=proof.references?.[scenario.scenario+'/capture-'+suffix];
      need(hostRef.safeParse({path:ref?.path,sha256:ref?.sha256}).success&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0
        &&ref.bytes<=(suffix==='continuity'?4:16)*1024**2&&ref.sha256===row[key]
        &&ref.path.endsWith('/attempt-'+(i+1)+'/capture-'+suffix+'.json'), 'same-schema-retired-capture-references-required');
    }
    for(const r of row.canonicalReports){
      if(r.windowSource==='current-startup'){
        need(same(r.evaluatedWindow,row.ordinaryWindow)&&r.predecessorClosedSha256===null,'same-schema-retired-capture-window-changed');
      }else{
        need(i===1&&r.predecessorClosedSha256===prior.closedSha256
          &&row.closedLiveInventorySha256===prior.closedLiveInventorySha256
          &&row.closedLiveClassificationSha256===prior.closedLiveClassificationSha256
          &&r.evaluatedWindow[1]<=row.ordinaryWindow[0], 'same-schema-retired-capture-inherited-state-changed');
        const matches=prior.canonicalReports.filter(p=>['packageRootSha256','originalSourceAdmissionsSha256','currentSourceAdmissionsSha256','namespaceMappingSha256'].every(k=>p[k]===r[k]));
        need(matches.length===1&&same(matches[0].evaluatedWindow,r.evaluatedWindow),'same-schema-retired-capture-inherited-receipt-changed');
      }
    }
  }
}
function verifyNoStagingCaptures(proof,binding){
  const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const directoryMode=integer.max(0o177777).refine(v=>(v&0o170000)===0o040000);
  const root=z.tuple([integer.positive(),integer.positive(),directoryMode,z.literal(999),z.literal(986)]);
  const shape=z.object({kind:z.literal('closed-9.8-no-staging-captures'),beforeSha256:hash,closedSha256:hash,
    classificationSha256:hash,inventorySha256:hash,selectedRelative:z.string().regex(/^recovered-workspaces\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
    workspaceEpoch:z.uuid(),candidateId:hash,attempt:z.number().int().min(1).max(3),physicalRoots:z.tuple([root,root]),
    stagingCount:z.literal(0),unchanged:z.literal(true)}).strict();
  const rows=proof.scenarios.map(s=>shape.parse(s.captureObservation)),first=rows[0];
  for(const [i,row]of rows.entries()){
    const scenario=proof.scenarios[i],before=proof.references?.[scenario.scenario+'/capture-before'],closed=proof.references?.[scenario.scenario+'/capture-closed'];
    need(row.attempt===i+1&&row.workspaceEpoch===binding.workspaceEpoch&&row.candidateId===scenario.candidateId
      &&row.selectedRelative===first.selectedRelative&&row.classificationSha256===first.classificationSha256&&row.inventorySha256===first.inventorySha256
      &&row.physicalRoots[0][0]===scenario.replicaConfigObservation?.sourceDevice
      &&row.physicalRoots[1][0]===scenario.replicaConfigObservation?.replicaDevice
      &&same(row.physicalRoots[0],first.physicalRoots[0])&&!same(row.physicalRoots[0].slice(0,2),row.physicalRoots[1].slice(0,2))
      &&(i!==1||same(row.physicalRoots[1],first.physicalRoots[1]))
      &&(i!==2||!same(row.physicalRoots[1].slice(0,2),first.physicalRoots[1].slice(0,2))),
      'same-schema-no-staging-capture-binding-changed');
    need(hostRef.safeParse({path:before?.path,sha256:before?.sha256}).success&&hostRef.safeParse({path:closed?.path,sha256:closed?.sha256}).success
      &&Number.isSafeInteger(before.bytes)&&before.bytes>0&&Number.isSafeInteger(closed.bytes)&&closed.bytes>0
      &&before.sha256===row.beforeSha256&&closed.sha256===row.closedSha256,'same-schema-no-staging-capture-references-required');
  }
}
/** Validate every persisted projection again; never trust its passed flags alone. */
export function verifyStartupRetainedProjection(v,request,sources=undefined){
  return verifyRetainedProjection(v,request,sources,false);
}
function verifyRetainedProjection(v,request,sources,antecedentOnly){
  sources??=reviewedStartupSources(request?.producer);sourcesReviewed(sources);
  need(v?.format===1&&v.kind==='actual-retained-startup-qualification-observation'&&v.readOnly===true&&v.hostEffects===false
    &&same(v.request,request)&&v.requestSha256===sha256(encoded(request))&&same(v.sourceHashes,sources)
    &&v.scope==='retained-same-runtime-startup-restart-restoration'&&v.actualSettledQualification===true
    &&v.independentOriginalRestored===true&&v.completeMaintainedSavedAndNativeState===true&&v.heldBootstrapVerified===true
    &&v.workerClosed===true
    &&v.productionAdmission===false&&v.freshFullRehearsalStillRequired===true&&v.liveAcceptanceStillRequired===true,
    'actual-startup-retained-projection-required');
  need(antecedentOnly===same(sources,WARM_ANTECEDENT_SOURCES),'warm-test-cannot-be-a-release-proof');
  z.uuid().parse(v.qualificationOperationId);
  need(Number.isSafeInteger(v.workerIdentity?.pid)&&v.workerIdentity.pid>1&&Number.isSafeInteger(v.workerIdentity.startTicks)&&v.workerIdentity.startTicks>0
    &&v.workerIdentity.controlGroup==='/system.slice/nova-qa-qualified-'+v.qualificationOperationId+'.service','startup-proof-original-worker-identity-required');
  const binding=startupQualificationBindingSchema.parse(v.qualificationBinding);
  if(binding.sameSchemaQualification)need(antecedentOnly||sameSchemaSources(sources),'same-schema-startup-producer-required');
  else need(!sameSchemaSources(sources),'same-schema-startup-marker-required');
  need(binding.prior.candidateId!==binding.targets.private.candidateId&&binding.runtime.agentVersion==='2026.9.8'
    &&same(Object.keys(binding.helpers).sort(),startupHelperNames(startupQualificationMarker(binding)).sort())
    &&Object.keys(binding.serviceArtifacts).length<=1000
    &&Object.keys(binding.serviceArtifacts).every(p=>/^dist\/service\/[a-zA-Z0-9_./-]+$/.test(p)&&!p.split('/').some(v=>['','.','..'].includes(v)))
    &&binding.serviceArtifacts['dist/service/apps/service/main.js']
    &&STARTUP_BARRIER_FILES.every(p=>binding.serviceArtifacts[p]),'startup-qualified-artifact-closure-required');
  if(binding.applicationDependencies)need(startupQualificationMarker(binding)&&binding.applicationDependencies.dependencyGraphSha256===binding.dependencyGraphSha256
    &&Object.values(binding.targets).every(t=>t.packageLockSha256===binding.applicationDependencies.packageLockSha256),'startup-qualified-dependencies-changed');
  need(Array.isArray(v.scenarios)&&same(v.scenarios.map(x=>x.scenario),STARTUP_SCENARIOS)
    &&v.scenarios.every(x=>x.candidateId===(x.scenario==='pristine-prior-restoration'?binding.prior.candidateId:binding.targets.private.candidateId)
      &&Number.isSafeInteger(x.startedAtSeconds)&&Number.isSafeInteger(x.closedAtSeconds)&&x.closedAtSeconds>=x.startedAtSeconds
      &&x.closedAtSeconds-x.startedAtSeconds<=3600),'startup-retained-scenarios-incomplete');
  if([CAPTURE_RETIREMENT_PRODUCER,...CAPTURE_REAPING_PRODUCERS,QUALIFIED_STARTUP_SOURCES['qualified-startup.py'],'9a30fd20d3a8321d763abba55dfc9ba55818d27984b1aa0337f3a17c0607554b','0a45ca346ec848ec8b17a0f1dcab43314ae344b12b5f8a0144f518d05144f3f5','3c433ce80cf48a2988f2fac3818429174b1bcedbdc78bbcc01bee75e3a9479af'].includes(sources['qualified-startup.py'])||binding.sameSchemaQualification){
    const ack=z.object({ordinaryAcknowledgements:z.number().int().min(0).max(1_000_000),
      authenticatedStartSeconds:z.number().int().positive(),retentionDays:z.literal(30)}).strict();
    const original=z.object({mode:z.enum(['unchanged-original-record','same-filesystem-original-equality']),changedFields:z.tuple([])}).strict();
    const relocated=z.object({mode:z.literal('proved-independent-filesystems'),changedFields:z.tuple([z.literal('dev')]),
      configurationHashes:z.tuple([hash,hash]),configurationBytes:z.tuple([z.number().int().positive().max(4*1024*1024),z.number().int().positive().max(4*1024*1024)]),
      observationWriterHashes:z.object({'io.factory-DBfPTl1R.mjs':z.literal('c0cb4b39847898580ac68ca0154498838bf32f028cd4ccfbfbd894e373e50056'),
        'io.warnings-AdNkx0te.mjs':z.literal('836fb6dcdfb3057f581d91e74d791e1c310188dca20815814c12e89d5ec20ab0')}).strict()}).strict();
    const receipt=z.object({kind:z.literal('closed-selected-replica-config-observation'),sourceDevice:z.number().int().nonnegative(),
      replicaDevice:z.number().int().nonnegative(),queueExpiry:ack,observations:z.tuple([z.union([original,relocated])])}).strict();
    for(const [i,scenario] of v.scenarios.entries()){
      const proof=receipt.parse(scenario.replicaConfigObservation),mode=proof.observations[0].mode;
      need(proof.queueExpiry.authenticatedStartSeconds===v.scenarios[i===1?0:i].startedAtSeconds
        &&(mode!=='proved-independent-filesystems'||proof.sourceDevice!==proof.replicaDevice)
        &&(mode!=='same-filesystem-original-equality'||proof.sourceDevice===proof.replicaDevice),'original-replica-evidence-required');
    }
  }
  if(sources['qualified-startup.py']===CAPTURE_RETIREMENT_PRODUCER){
    need(v.baselineLineage==='verified-pre-swap-aborted-operator-snapshot','incident-capture-baseline-required');
    const id=z.string().regex(/^(0|[1-9][0-9]*)$/);
    const role=z.object({roleSha256:hash,headerSha256:hash,contextSha256:hash,physicalOwner:z.tuple([id,id]),
      proofSha256:hash,firstWindow:z.tuple([z.number().int().positive(),z.number().int().positive()])}).strict();
    const receipt=z.object({kind:z.literal('closed-9.8-capture-retirement'),
      beforeSha256:hash,closedSha256:hash,roles:z.array(role).min(1).max(1000)}).strict();
    const sets=v.scenarios.map(s=>receipt.parse(s.captureRetirement).roles);
    const first=new Map(sets[0].map(r=>[r.roleSha256,r]));
    need(first.size===sets[0].length,'capture-proof-role-duplicated');
    for(const [i,rows] of sets.entries()){
      const window=v.scenarios[i===1?0:i];
      need(rows.length===first.size&&new Set(rows.map(r=>r.roleSha256)).size===first.size,'capture-proof-role-coverage-changed');
      for(const r of rows){
        const original=first.get(r.roleSha256);
        need(original&&r.headerSha256===original.headerSha256&&r.contextSha256===original.contextSha256
          &&same(r.firstWindow,[window.startedAtSeconds,window.closedAtSeconds])
          &&(i!==1||same(r,original))&&(i!==2||!same(r.physicalOwner,original.physicalOwner)),
          'capture-proof-retirement-or-restart-provenance-changed');
      }
    }
  }

  const captureKeys=s=>['captureObservation','captureRetirement','captureContinuity','captureTransition','captureDeferred'].filter(k=>Object.hasOwn(s,k));
  const captureOnly=key=>v.scenarios.every(s=>captureKeys(s).join(',')===key);
  const noStaging=binding.sameSchemaQualification&&captureOnly('captureObservation');
  const continuity=binding.sameSchemaQualification&&captureOnly('captureContinuity');
  const transition=binding.sameSchemaQualification&&captureOnly('captureTransition');
  const version=parkedVersion(sources);
  const parked=Boolean(version);
  const complete=antecedentOnly||parked||same(sources,COMPLETE_CAPTURE_STARTUP_SOURCES);
  const newFamily=complete||same(sources,DEFERRED_CAPTURE_STARTUP_SOURCES);
  const deferred=newFamily&&v.scenarios.some(s=>Object.hasOwn(s,'captureDeferred'));
  need(newFamily===Object.hasOwn(v,'deferredCaptureHistory'),'deferred-capture-history-source-changed');
  if(newFamily)verifyDeferredCaptureHistory(v,binding,complete&&!parked);
  need(parked===Object.hasOwn(v,'parkedSeedAntecedent')&&parked===Object.hasOwn(request,'warmAntecedent'),'parked-antecedent-binding-required');
  if(parked)verifyParkedLoan(v,request,binding,version);
  if(binding.sameSchemaQualification){
    need(v.baselineLineage==='verified-closed-schema60-target-retained'&&same(binding.helpers,helpersForStartupSources(sources)),'same-schema-capture-source-required');
    need(noStaging||continuity||transition||captureOnly('captureRetirement')||deferred,'same-schema-capture-branch-changed');
    if(complete)need(deferred,'complete-native-capture-checkpoints-required');
    if(deferred){
      const allowed=complete?['captureDeferred','captureTransition,captureDeferred']:['captureDeferred','captureTransition'];
      need(v.scenarios.every(s=>allowed.includes(captureKeys(s).join(','))),
        'deferred-scenario-needs-one-original-capture-branch');
      verifyDeferredCaptureScenarios(v,binding,complete);
      verifyCaptureTransition(v,binding,true);
    }
    if(noStaging)verifyNoStagingCaptures(v,binding);
    if(transition){
      need(retiredRecaptureProducers.has(sources['qualified-startup.py']),'startup-retired-recapture-source-not-qualified');
      verifyCaptureTransition(v,binding);
    }
    if(continuity){
      need(retiredRecaptureProducers.has(sources['qualified-startup.py']),'startup-retired-recapture-source-not-qualified');
      verifyCaptureContinuity(v,binding);
    }
  }
  if(CAPTURE_REAPING_PRODUCERS.has(sources['qualified-startup.py'])||(binding.sameSchemaQualification&&!noStaging&&!continuity&&!transition&&!deferred)){
    need(v.baselineLineage===(binding.sameSchemaQualification?'verified-closed-schema60-target-retained':'verified-pre-swap-aborted-operator-snapshot'),'incident-capture-baseline-required');
    need(binding.sameSchemaQualification||binding.helpers['recovery.py']==='23b7d18d415393a315a8140b674edee4a12cbc1b8f996b439843472208dcbd15'
      &&['941e295816bbb4c5da054928018ee59ae3164d032dffcab63d79f36b79050a59','f85ef9249d9722558ad6ab6dccee60b8d4412ca793afeeb1a53d316a85a2e62a','522b78eeb6a6d986dde2ac353516c47a987d8283bb030d273b0b4122d08cbe24'].includes(binding.helpers['install.py']),
      'capture-lifecycle-helper-source-required');
    const id=z.string().regex(/^(0|[1-9][0-9]*)$/);
    const names=z.array(z.string().regex(/^admission-[A-Za-z0-9]{6}$/)).max(16);
    const role=z.object({roleSha256:hash,headerSha256:hash,contextSha256:hash,
      physicalOwner:z.tuple([id,id]).nullable(),proofSha256:hash,
      firstWindow:z.tuple([z.number().int().positive(),z.number().int().positive()]),
      state:z.enum(['retired','partially-reaped','reaped']),reaped:z.boolean(),
      remainingNamespaces:names.nullable(),remainingCount:z.number().int().min(0).max(16).nullable(),
      remainingSha256:hash.nullable(),sourceAdmissionsSha256:hash.nullable(),predecessorProofSha256:hash.nullable(),
      lastWindow:z.tuple([z.number().int().positive(),z.number().int().positive()])}).strict();
    const receipt=z.object({kind:z.literal('closed-9.8-capture-lifecycle'),
      beforeSha256:hash,closedSha256:hash,roles:z.array(role).min(1).max(1000)}).strict();
    const sets=v.scenarios.map(s=>receipt.parse(s.captureRetirement).roles);
    const first=new Map(sets[0].map(r=>[r.roleSha256,r]));
    need(first.size===sets[0].length,'capture-proof-role-duplicated');
    for(const [i,rows] of sets.entries()){
      const scenario=v.scenarios[i],firstScenario=v.scenarios[i===1?0:i];
      need(rows.length===first.size&&new Set(rows.map(r=>r.roleSha256)).size===first.size,'capture-proof-role-coverage-changed');
      for(const r of rows){
        const original=first.get(r.roleSha256);
        need(original&&r.headerSha256===original.headerSha256&&r.contextSha256===original.contextSha256
          &&same(r.firstWindow,[firstScenario.startedAtSeconds,firstScenario.closedAtSeconds])
          &&same(r.lastWindow,[scenario.startedAtSeconds,scenario.closedAtSeconds]),'capture-lifecycle-clock-or-source-changed');
        if(i!==1){
          need(r.state==='retired'&&!r.reaped&&r.physicalOwner!==null&&r.remainingNamespaces===null
            &&r.remainingCount===null&&r.remainingSha256===null&&r.sourceAdmissionsSha256===null
            &&r.predecessorProofSha256===null&&(i!==2||!same(r.physicalOwner,original.physicalOwner)),
            'capture-lifecycle-independent-retirement-required');
        }else{
          need(r.predecessorProofSha256===original.proofSha256,'capture-lifecycle-predecessor-changed');
          if(r.state==='retired'){
            need(!r.reaped&&same(r.physicalOwner,original.physicalOwner)&&r.proofSha256===original.proofSha256
              &&r.remainingNamespaces===null&&r.remainingCount===null&&r.remainingSha256===null
              &&r.sourceAdmissionsSha256===null,'capture-lifecycle-unchanged-carry-required');
          }else{
            need(r.proofSha256!==original.proofSha256&&Array.isArray(r.remainingNamespaces)
              &&same(r.remainingNamespaces,[...new Set(r.remainingNamespaces)].sort())
              &&r.remainingCount===r.remainingNamespaces.length
              &&r.remainingSha256===sha256(Buffer.from(canonical(r.remainingNamespaces)))
              &&r.sourceAdmissionsSha256!==null
              &&r.reaped===(r.state==='reaped')
              &&(r.reaped?r.physicalOwner===null&&r.remainingCount===0
                :same(r.physicalOwner,original.physicalOwner)&&r.remainingCount>0),
              'capture-lifecycle-monotonic-generated-reaping-required');
          }
        }
      }
    }
  }


  const required=['producer','parent',...Object.keys(sources).map(k=>'source/'+k),'review','originalPlan','executionIntent',
    'technicalReview','originalIntention','childResult','outsideClosure','restorationIntent','restorationCompleted','effectiveProfile','negativeVerifierSource','negativeVerifierResult',
    ...['result','closure','input','plan','intent','sourceCapture','sourceBefore','sourceAfter','sourcePhysical','sourceMetadata','seedInventory','seedPhysical','seedMetadata','liveContext','effectiveUnit'].map(role=>'homeCapture/'+role),
    ...STARTUP_SCENARIOS.flatMap(x=>['started','process','ready','closed','preservation','bootstrap','clock-attribution'].map(y=>x+'/'+y))];
  if(CAPTURE_REAPING_PRODUCERS.has(sources['qualified-startup.py']))required.push('baselineManifest');
  if(binding.sameSchemaQualification)required.push('baselineManifest','baselineVerified','retainedParent','retainedRoles','retainedClosure','retainedSecondPreservation');
  need(v.references&&required.every(k=>hostRef.safeParse({path:v.references[k]?.path,sha256:v.references[k]?.sha256}).success
    &&Number.isSafeInteger(v.references[k]?.bytes)&&v.references[k].bytes>=0),'startup-retained-original-references-incomplete');
  need(v.references.parent.path===request.parent.path&&v.references.parent.sha256===request.parent.sha256
    &&v.references.producer.path===request.producer.path&&v.references.producer.sha256===request.producer.sha256
    &&Object.entries(sources).every(([name,digest])=>v.references['source/'+name].sha256===digest),
    'startup-retained-original-request-changed');
  return v;
}
/** This is the sole new exception to byte-identical prior startup files. It
 * requires the actual candidate, including files outside the eight-file barrier. */
export function assertStartupQualifiedCandidate(proof,{operation,prior,candidates,artifacts,helpers,dependencyGraphSha256,applicationDependencies=null},sources=undefined){
  verifyStartupRetainedProjection(proof,proof.request,sources);
  const b=proof.qualificationBinding;
  need(operation.agentVersion==='2026.9.8'&&operation.priorAgentVersion==='2026.9.8'
    &&operation.priorCandidateId===prior.id&&b.prior.candidateId===prior.id&&b.prior.version===prior.manifest.version
    &&operation.workspaceEpoch===b.workspaceEpoch&&same(operation.sourceCommits,b.sourceCommits)
    &&b.dependencyGraphSha256===dependencyGraphSha256,'actual-startup-prior-runtime-or-source-changed');
  if(b.applicationDependencies)need(same(b.applicationDependencies,applicationDependencies),'actual-startup-dependency-archive-changed');
  need(Object.entries(helpers).every(([name,digest])=>b.helpers[name]===digest),'actual-startup-helper-changed');
  for(const side of ['private','public']){
    const candidate=candidates[side],artifact=artifacts[side],qualified=b.targets[side];
    assertStartupApplicationTransition(b,prior.manifest,candidate.manifest);
    need(startupQualificationMarker(b)||candidate.manifest.schemaVersion===55,'actual-startup-same-schema60-producer-unavailable');
    need(candidate.id===qualified.candidateId&&candidate.manifest.version===operation.version
      &&candidate.manifest.version===qualified.version&&candidate.manifest.buildVersion===operation.buildVersion
      &&candidate.manifest.buildVersion===qualified.buildVersion,
      'actual-startup-target-candidate-changed');
    const compiled=Object.fromEntries([...candidate.bytes].filter(([p])=>p.startsWith('dist/service/')).map(([p,bytes])=>[p,sha256(bytes)]));
    need(same(compiled,b.serviceArtifacts)&&sha256(candidate.bytes.get('package.json'))===qualified.packageSha256
      &&sha256(frontendRegular(join(artifact.applicationDirectory,'dist/candidate.json'),2*1024**2))===qualified.candidateManifestSha256,'actual-startup-target-service-changed');
    const archive=readEvidenceFile(artifact.archive,{maximum:128*1024**2});
    need(artifact.archive.sha256===qualified.archiveSha256&&archive.length===qualified.archiveBytes
      &&artifact.ciSourceReceipt.sha256===qualified.ciSourceSha256
      &&sha256(frontendRegular(join(artifact.applicationDirectory,'package-lock.json'),8*1024**2))===qualified.packageLockSha256,
      'actual-startup-target-artifact-changed');
    const host=artifact.sourceHashes?.['scripts/host.mjs'];
    need(host?.sha256===b.hostEntrypointSha256
      &&sha256(frontendRegular(join(artifact.frozenSourceDirectory,'scripts/host.mjs'),2*1024**2))===host.sha256,
      'actual-startup-host-entrypoint-changed');
  }
  return proof;
}
export function createStartupRetainedCollector({transport,options,run=runInstallTransport,clock=Date.now}){
  const request=startupRetainedRequest(options);
  return async()=>{
    const target=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport,{maximum:65536})));
    readEvidenceFile(target.sshConfig,{maximum:65536});
    const before=clock(),raw=await run(target,buildStartupRetainedProgram(request),{captureDiagnostics:true});
    need(raw?.uncertain!==true&&raw?.exitCode===0&&typeof raw.stdout==='string'&&Buffer.byteLength(raw.stdout)<=512*1024,
      'actual-startup-proof-observation-unavailable');
    const parsed=JSON.parse(raw.stdout);need(parsed.ok===true,'actual-startup-proof-observation-failed');
    const proof=verifyStartupRetainedProjection(parsed.value,request),after=clock();
    need(Number.isSafeInteger(proof.observedAtMilliseconds)&&proof.observedAtMilliseconds>=before-30000
      &&proof.observedAtMilliseconds<=after+30000,'actual-startup-proof-observation-time-changed');
    const{observedAtMilliseconds,...stable}=proof;return stable;
  };
}
