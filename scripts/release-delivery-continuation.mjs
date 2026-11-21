/** One explicit current-operator grant for an expired, untouched package phase.
 * Candidate identity and original execution history are never rewritten. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { PREWRITE_PREREQUISITES } from './release-delivery-disposition.mjs';
import { withVerificationPass } from './release-verification-pass.mjs';
import { fullFactsSpec, verifyFullFacts } from './release-delivery-full-host.mjs';
import { verifyPublicationBrowserContinuation, verifyBrowserWindowRecoveryReadiness, assertBrowserWindowRecoveryUnmaterialized } from './release-delivery-browser-continuation.mjs';
import { configuredBrowserWindowRecoveryStorageReadiness, verifyBrowserWindowRecoveryStorageReadiness } from './release-storage-default.mjs';

import { originalStartupFailure, startupCorrectionBranch, startupCorrectionGrant, startupCorrectionRequest, verifyOriginalStartupProgram, verifyCorrectedStartupProof } from './release-delivery-startup-proof-correction.mjs';
import { correctionRequestKind, correctionGrantKind, correctionBranch, correctedDependencyTarget, dependencyCorrectionSchema, requireCorrectionExit } from './release-delivery-dependency-correction.mjs';

const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/),path=z.string().min(1).max(4096).refine(isAbsolute);
const ref=z.object({path,sha256:hash}).strict();
const source=z.object({root:path,repository:z.string(),branch:z.literal('codex/operator-continuation-31'),commit}).strict();
const pair=s=>z.object({private:s,public:s}).strict();
const json=r=>JSON.parse(readEvidenceFile(ref.parse(r),{maximum:2*1024**2}));
const reference=p=>({path:resolve(p),sha256:sha256(readFileSync(p))});
const graphSchema=z.array(z.object({name:z.string(),sha256:hash}).strict()).min(1).max(512);
export const continuationRequestSchema=z.object({format:z.literal(1),kind:z.literal('nova-expired-prepackage-request'),operationId:z.uuid(),
 historical:z.object({root:path,manifest:ref}).strict(),owner:z.object({request:ref,attempts:z.array(z.object({launcher:ref,intent:ref,exit:ref,childResult:ref,stdout:ref}).strict()).min(1).max(8)}).strict(),
 operatorSources:pair(source),ciRuns:pair(z.number().int().positive()),durationMs:z.number().int().min(60000).max(14400000)}).strict();
export const continuationGrantSchema=z.object({format:z.literal(1),kind:z.literal('nova-expired-prepackage-continuation'),operationId:z.uuid(),
 descriptorSha256:hash,targetIdentity:hash,originalAdapterIdentity:hash,originalTimelineSha256:hash,originalBudgetMs:z.number().int().positive(),
 originalCreatedAtMs:z.number().int().nonnegative(),snapshotSha256:hash,eventHighWaterMark:z.number().int().nonnegative(),historySha256:hash,
 prerequisites:z.array(z.object({phase:z.enum(PREWRITE_PREREQUISITES),key:z.uuid(),inputSha256:hash,observationSha256:hash}).strict()).length(6),
 request:ref,ownerPids:z.array(z.number().int().positive()).min(2).max(16),
 operator:z.object({adapterIdentity:hash,sources:pair(source),sourceFiles:graphSchema,ci:pair(ref)}).strict(),
 hostFacts:ref,issuedAtMs:z.number().int().nonnegative(),expiresAtMs:z.number().int().positive(),
 automaticRenewal:z.literal(false),originalHistoryPreserved:z.literal(true)}).strict().refine(v=>v.expiresAtMs>v.issuedAtMs&&v.expiresAtMs-v.issuedAtMs<=14400000,'finite-continuation-window-required');


const startupSources=pair(source.extend({branch:z.literal(startupCorrectionBranch)}));
const startupRequest=continuationRequestSchema.omit({durationMs:true}).extend({
 kind:z.literal(startupCorrectionRequest),operatorSources:startupSources,startupFailure:ref
});
const startupGrant=z.object({...continuationGrantSchema.shape,kind:z.literal(startupCorrectionGrant),startupFailure:ref,startupProof:ref,
 operator:continuationGrantSchema.shape.operator.extend({sources:startupSources})
}).strict().refine(p=>p.issuedAtMs>=p.originalCreatedAtMs&&p.expiresAtMs>p.issuedAtMs&&p.expiresAtMs===p.originalCreatedAtMs+p.originalBudgetMs,
 'startup-correction-original-deadline-required');
const correctionSources=pair(source.extend({branch:z.literal(correctionBranch)}));
const browserWindowPolicy=z.object({kind:z.literal('one-prior-then-two-targets'),priorCandidateId:hash,targetCandidateId:hash}).strict().optional();
const correctionRequest=continuationRequestSchema.omit({durationMs:true}).extend({
 kind:z.literal(correctionRequestKind),operatorSources:correctionSources,correction:dependencyCorrectionSchema,browserWindowPolicy
});
const correctionGrant=z.object({...continuationGrantSchema.shape,kind:z.literal(correctionGrantKind),correction:dependencyCorrectionSchema,
 operator:continuationGrantSchema.shape.operator.extend({sources:correctionSources}),browserWindowPolicy
}).strict().refine(value=>value.expiresAtMs>value.issuedAtMs&&value.expiresAtMs===value.originalCreatedAtMs+value.originalBudgetMs,
 'dependency-correction-original-deadline-required');
export const prepackageRequestSchema=z.discriminatedUnion('kind',[continuationRequestSchema,correctionRequest,startupRequest]);
export const prepackageGrantSchema=z.union([continuationGrantSchema,correctionGrant,startupGrant]);

/** One bounded continuation of the already reserved publication phase. */
export const PUBLICATION_CONTINUATION_PREREQUISITES=Object.freeze([...PREWRITE_PREREQUISITES,'package','sign','capacity','recovery']);
export const PUBLICATION_PACKAGE_SUBSTEPS=Object.freeze(['dependency-stage','dependency-plan','dependency-intent','dependency-execute','dependency-retrieval','pair','bundle'].map(n=>'package/'+n));
const PUBLICATION_BRANCH='operator/publication-continuation-r1',STORAGE_SUCCESSOR_BRANCH='operator/publication-storage-successor-r1',BROWSER_RECOVERY_BRANCH='operator/browser-window-recovery-r1';
const publicationSource=source.extend({branch:z.enum([PUBLICATION_BRANCH,STORAGE_SUCCESSOR_BRANCH,BROWSER_RECOVERY_BRANCH])});
export const completedOriginalStorageSchema=z.object({result:ref,review:ref}).strict();
export const publicationStorageSuccessorSchema=z.object({predecessorGrantSha256:hash,completedOriginalStorage:completedOriginalStorageSchema,reason:z.string().trim().min(1).max(1000)}).strict();
export const browserWindowRecoverySchema=z.object({predecessorGrantSha256:hash,storageAdmission:z.object({eventId:z.number().int().positive(),sha256:hash,session:ref,dispatch:ref}).strict(),reason:z.string().trim().min(1).max(1000)}).strict();
export const browserWindowReservationSchema=z.object({sessionId:z.uuid(),startedAtMs:z.number().int().nonnegative(),deadlineAtMs:z.number().int().positive()}).strict();
const publicationBranchMatches=v=>!(v.successor&&v.browserWindowRecovery)&&Object.values(v.operatorSources??v.operator.sources).every(s=>s.branch===(v.browserWindowRecovery?BROWSER_RECOVERY_BRANCH:v.successor?STORAGE_SUCCESSOR_BRANCH:PUBLICATION_BRANCH));
const browserWindowShape=v=>Boolean(v.browserWindowRecovery)===Boolean(v.browserReservation)&&Boolean(v.browserWindowRecovery)===Boolean(v.browserWindowReadiness)&&Boolean(v.browserWindowRecovery)===Boolean(v.storageWindowReadiness)&&(!v.browserWindowRecovery||(v.browserReservation.sessionId===v.browser.successorSessionId&&v.browserReservation.startedAtMs===v.issuedAtMs&&v.browserReservation.deadlineAtMs===v.issuedAtMs+1800000&&v.browserReservation.deadlineAtMs<=v.expiresAtMs));
const publicationReservation=z.object({key:z.uuid(),inputSha256:hash,observationSha256:hash}).strict();
const publicationBrowser=z.object({predecessor:ref,status:ref,successorSessionId:z.uuid()}).strict();
const publicationAdmission=z.object({plan:ref,review:ref,intent:ref}).strict();
export const publicationContinuationRequestSchema=continuationRequestSchema.extend({kind:z.literal('nova-expired-publication-request'),
 operatorSources:pair(publicationSource),publication:publicationReservation,browser:publicationBrowser,admission:publicationAdmission.optional(),successor:publicationStorageSuccessorSchema.optional(),browserWindowRecovery:browserWindowRecoverySchema.optional()}).refine(publicationBranchMatches,'publication-successor-source-branch-required');
export const publicationContinuationGrantSchema=z.object({...continuationGrantSchema.shape,kind:z.literal('nova-expired-publication-continuation'),
 prerequisites:z.array(z.object({phase:z.enum(PUBLICATION_CONTINUATION_PREREQUISITES),key:z.uuid(),inputSha256:hash,observationSha256:hash}).strict()).length(10),
 packageSubsteps:z.array(z.object({phase:z.enum(PUBLICATION_PACKAGE_SUBSTEPS),key:z.uuid(),inputSha256:hash,observationSha256:hash,parentKey:z.uuid(),parentInputSha256:hash}).strict()).length(7),
 publication:publicationReservation,browser:publicationBrowser,admission:publicationAdmission,prestageVerification:ref,successor:publicationStorageSuccessorSchema.optional(),browserWindowRecovery:browserWindowRecoverySchema.optional(),browserReservation:browserWindowReservationSchema.optional(),browserWindowReadiness:ref.optional(),storageWindowReadiness:ref.optional(),
 operator:z.object({adapterIdentity:hash,sources:pair(publicationSource),sourceFiles:graphSchema,ci:pair(ref)}).strict()
}).strict().refine(v=>v.expiresAtMs>v.issuedAtMs&&v.expiresAtMs-v.issuedAtMs<=14400000,'finite-continuation-window-required').refine(publicationBranchMatches,'publication-successor-source-branch-required').refine(browserWindowShape,'browser-window-fixed-reservation-required');

const preJournalSource=source.extend({branch:z.enum(['operator/prejournal-c494-r1','operator/prejournal-c494-r2'])});
const noChildDispositionSchema=z.object({format:z.literal(1),kind:z.literal('nova-prejournal-no-child-disposition'),operationId:z.uuid(),
 previousProof:ref,admission:ref,observationIntent:ref,sourceGraph:ref,launcher:ref,
 authority:z.object({intent:ref,result:ref,stdout:ref,stderr:ref}).strict(),
 review:z.object({status:z.literal('passed'),independentReview:z.literal(true),reviewedAt:z.string().datetime({offset:true}),
  sourceOrdering:z.literal('session-and-logs-before-native-spawn'),originalWrapperClosed:z.literal(true),nativeChildDispatched:z.literal(false),
  noJournalCreated:z.literal(true),automaticReplayPermitted:z.literal(false)}).strict()}).strict();
export const preJournalRequestSchema=z.object({format:z.literal(1),kind:z.literal('nova-pre-journal-dispatch-request'),operationId:z.uuid(),
 historical:z.object({root:path,manifest:ref}).strict(),
 original:z.object({request:ref,initialization:ref,descriptor:ref,dispatch:ref,session:ref,directoryPreparation:ref,
  launcher:ref,observation:z.object({intent:ref,exit:ref,childResult:ref,stdout:ref,stderr:ref}).strict()}).strict(),
 operatorSources:pair(preJournalSource),ciRuns:pair(z.number().int().positive()),outputDirectory:path,
 durationMs:z.number().int().min(60000).max(1800000),
 reason:z.enum(['closed-storage-start-rejected-before-journal','reserved-attempt-confirmed-before-native-dispatch']),reservedFailure:ref.optional(),
 automaticRenewal:z.literal(false)}).strict().refine(r=>Boolean(r.reservedFailure)===(r.reason==='reserved-attempt-confirmed-before-native-dispatch'),'explicit-reserved-failure-disposition-required');
export const preJournalGrantSchema=z.object({format:z.literal(1),kind:z.literal('nova-pre-journal-dispatch-reconciliation'),operationId:z.uuid(),
 descriptorSha256:hash,targetIdentity:hash,originalAdapterIdentity:hash,originalTimelineSha256:hash,originalBudgetMs:z.number().int().positive(),
 originalDispatch:ref,originalDirectoryPreparation:ref,originalStorageDeadline:z.string(),originalStartAtMs:z.number().int().nonnegative(),
 request:ref,operator:z.object({adapterIdentity:hash,sources:pair(preJournalSource),sourceFiles:graphSchema,ci:pair(ref)}).strict(),
 issuedAtMs:z.number().int().nonnegative(),expiresAtMs:z.number().int().positive(),
 automaticRenewal:z.literal(false),originalHistoryPreserved:z.literal(true)}).strict().refine(v=>v.expiresAtMs>v.issuedAtMs&&v.expiresAtMs-v.issuedAtMs<=1800000,'finite-prejournal-window-required');
export const operatorGrantSchema=z.union([prepackageGrantSchema,preJournalGrantSchema,publicationContinuationGrantSchema]);

/** A closed first child is different from a lost response or a started journal. */
export function preJournalOriginal(raw,{requireEmpty=true,exclusiveHistory=false,assertAbsent=absentOwner}={}){
 const request=preJournalRequestSchema.parse(raw),o=request.original,original=json(o.request),init=json(o.initialization),d=json(o.descriptor),start=json(original.releaseInput);
 const root=resolve(o.request.path,'..'),j=resolve(init.journalDirectory),dir=join(root,'observations','observation-0001');
 need(original.operationId===request.operationId&&start.operationId===request.operationId&&d.operation.id===request.operationId
  &&init.kind==='nova-delivery-initialization'&&same(init.input,start)&&same(init.descriptor.reference,o.descriptor)&&same(init.descriptor.value,d)
  &&same(init.profile,start.profile)&&same(d.timeline,start.timeline)&&d.observationBudgetMs===start.observationBudgetMs
  &&same(d.operation.sourceCommits,start.sourceCommits),'prejournal-original-initialization-changed');
 need(o.initialization.path===join(resolve(start.outputRoot),'request-'+request.operationId,'initialization.json')
  &&o.descriptor.path===join(resolve(start.outputRoot),'request-'+request.operationId,'descriptor.json')
  &&j===join(resolve(start.outputRoot),'journal-'+request.operationId),'prejournal-original-paths-changed');
 verifyOriginalContinuationGraph(request,d);
 const dispatch=json(o.dispatch),session=json(o.session),intent=json(o.observation.intent),closed=json(o.observation.childResult),exit=json(o.observation.exit),result=json(o.observation.stdout),preparation=json(o.directoryPreparation),launcher=json(o.launcher);
 need(o.dispatch.path===join(root,'release-dispatch.json')&&o.session.path===join(root,'session-observation-0001.json')
  &&same(dispatch.request,o.request)&&dispatch.automaticNewOperationPermitted===false
  &&same(session.request,o.request)&&same(session.dispatch,o.dispatch)&&same(session.initialization,o.initialization)&&same(session.descriptor,o.descriptor)
  &&session.kind==='nova-storage-default-session'&&session.mode==='start'&&session.operationId===request.operationId,'prejournal-original-dispatch-changed');
 const expected=[original.node.path,original.deliveryEntry.path,'start',j,o.descriptor.path];
 need(same(intent.argv,expected)&&same(session.argv,expected)&&same(intent.request,o.request)&&intent.sameReleaseOperation===true,'prejournal-original-start-command-changed');
 need(original.deliveryEntry.path===join(request.historical.root,'scripts','release-deliver.mjs')
  &&same(original.node,json(d.target).artifactTools.node),'prejournal-original-entry-or-node-changed');
 for(const [role,name]of Object.entries({intent:'intent.json',exit:'exit.json',childResult:'default-child-result.json',stdout:'stdout.json',stderr:'stderr.log'})){
  need(o.observation[role].path===join(dir,name),'prejournal-original-observation-path-changed');readEvidenceFile(o.observation[role]);}
 if(exclusiveHistory)need(same(readdirSync(join(root,'observations')).filter(n=>/^observation-[0-9]{4,}$/.test(n)).sort(),request.reservedFailure?['observation-0001','observation-0002']:['observation-0001']),'prejournal-unclassified-original-observation');
 need(closed.originalChildClosed===true&&closed.returnCode===1&&closed.logBoundExceeded===false&&closed.automaticNewOperationPermitted===false
  &&exit.returnCode===1&&Number.isSafeInteger(exit.finishedAtMilliseconds)
  &&same(result,{kind:'nova-release-delivery-error',reason:'storage-start-already-dispatched-use-resume',automaticReplayPermitted:false}),'prejournal-original-start-not-definitively-closed');
 need(preparation.kind==='original-empty-journal-directory-preparation'&&same(preparation.originalInitialization,o.initialization)
  &&preparation.journalDirectory===j&&preparation.absentBefore===true&&preparation.protected===true&&preparation.emptyAfter===true
  &&preparation.databaseCreated===false&&preparation.newOperationCreated===false&&preparation.hostEffects===false,'prejournal-empty-directory-provenance-required');
 readEvidenceFile(preparation.source);
 need(preparation.source.path===join(request.historical.root,'scripts','release-coordinate.mjs'),'prejournal-directory-validator-changed');
 need(launcher.kind==='verified-waiting-release-launcher'&&launcher.dispatchAuthority===false&&launcher.operationId===request.operationId
  &&same(launcher.start,original.releaseInput)&&same(launcher.budget,original.storageBudget)&&same(launcher.entry,original.deliveryEntry)
  &&same(launcher.node,original.node)&&launcher.worker.parentPid===launcher.owner.pid,'prejournal-original-owner-changed');
 for(const owner of [launcher.owner,launcher.worker])assertAbsent(owner);
 for(const r of [launcher.config,launcher.runner,launcher.entry,launcher.node])readEvidenceFile(r,{maximum:128*1024**2});
 const originalConfig=json(launcher.config);
 need(same(session.config,launcher.config)&&same(session.sourceReview,originalConfig.sourceReview)&&same(session.storageReview,originalConfig.storageReview)
  &&same(session.sourceGraph,request.historical.manifest)&&session.adapterIdentity===d.adapterIdentity,'prejournal-original-session-source-changed');
 const storage=json(dispatch.storageInput),maintenance=dispatch.storageMaintenanceResult,completion=json(maintenance.result),{result:completionRef,...retainedMaintenance}=maintenance;
 need(same(storage.profile,start.profile)&&same(storage.budget,original.storageBudget)&&maintenance.state==='ready'&&maintenance.cleanupPerformed===true
  &&maintenance.protectedRolesVerified===true&&same(completion,retainedMaintenance)&&maintenance.releaseAdmission===false,'prejournal-completed-maintenance-required');
 const info=lstatSync(j);need(info.isDirectory()&&!info.isSymbolicLink()&&resolve(realpathSync(j))===j,'prejournal-canonical-directory-required');
 if(requireEmpty)need(readdirSync(j).length===0,'prejournal-empty-uninitialized-directory-required');
 if(request.reservedFailure)verifyReservedPreJournalFailure(request,{assertAbsent});
 return {request,original,initialization:init,descriptor:d,journalDirectory:j,dispatch,storage,
  binding:{descriptorSha256:sha256(canonical(d)),targetIdentity:d.targetIdentity,originalAdapterIdentity:d.adapterIdentity,
   originalTimelineSha256:sha256(canonical(d.timeline)),originalBudgetMs:d.observationBudgetMs,originalDispatch:o.dispatch,
   originalDirectoryPreparation:o.directoryPreparation,originalStorageDeadline:storage.originalDeadline,originalStartAtMs:d.timeline.startedAtMs}};
}

/** Reconcile a reviewed pre-execution refusal; missing output alone is never authority. */
export function verifyReservedPreJournalFailure(raw,{assertAbsent=absentOwner}={}){
 const request=preJournalRequestSchema.parse(raw),r=noChildDispositionSchema.parse(json(request.reservedFailure));
 const previous=preJournalGrantSchema.parse(json(r.previousProof)),priorRequest=preJournalRequestSchema.parse(json(previous.request));
 need(!priorRequest.reservedFailure&&request.operationId===r.operationId&&r.operationId===previous.operationId
  &&same(request.original,priorRequest.original)&&same(request.historical,priorRequest.historical),'prejournal-reserved-predecessor-changed');
 verifyPreJournalProof(previous,{requireEmpty:false,assertAbsent});
 const root=resolve(request.original.request.path,'..'),attempt=join(root,'observations','observation-0002'),
  init=json(request.original.initialization),original=json(request.original.request),launcher=json(r.launcher),config=json(launcher.config),
  review=json(config.sourceReview),storageReview=json(config.storageReview),grantHash=sha256(canonical(previous)),admission=json(r.admission),
  intent=json(r.observationIntent),graph=json(r.sourceGraph),authorityIntent=json(r.authority.intent),result=json(r.authority.result),
  previousApp=join(previous.operator.sources.private.root,'edition3'),entry=join(previousApp,'scripts','release-deliver.mjs');
 need(r.previousProof.path===join(priorRequest.outputDirectory,'prejournal-authority.json')
  &&r.admission.path===join(root,'continuations',grantHash,'admission-0001','release-dispatch.json')
  &&r.observationIntent.path===join(attempt,'intent.json')&&r.sourceGraph.path===join(root,'source-graph-observation-0002.json'),
  'prejournal-reserved-evidence-path-changed');
 const info=lstatSync(attempt);need(info.isDirectory()&&!info.isSymbolicLink()&&resolve(realpathSync(attempt))===attempt
  &&same(readdirSync(attempt).sort(),['intent.json'])&&!existsSync(join(root,'session-observation-0002.json')),
  'prejournal-reserved-child-dispatch-uncertain');
 need(launcher.kind==='verified-waiting-release-launcher'&&launcher.mode==='resume'&&launcher.dispatchAuthority===false
  &&launcher.operationId===request.operationId&&same(launcher.start,original.releaseInput)&&same(launcher.budget,original.storageBudget)
  &&same(launcher.node,original.node)&&same(launcher.entry,reference(entry))&&launcher.worker.parentPid===launcher.owner.pid,
  'prejournal-reserved-owner-context-changed');
 for(const owner of [launcher.owner,launcher.worker])assertAbsent(owner);
 need(config.kind==='nova-storage-default'&&same(config.runner,launcher.runner)
  &&same(config.operatorContinuation.preJournalProof,r.previousProof)&&same(config.operatorContinuation.originalRequest,request.original.request)
  &&config.operatorContinuation.operationId===request.operationId&&config.operatorContinuation.journalDirectory===init.journalDirectory
  &&same(config.applicationRoots,[previousApp,previous.operator.sources.public.root])
  &&review.kind==='nova-storage-default-source-review'&&review.status==='passed'&&review.independentReview===true
  &&storageReview.kind==='independent-storage-source-review'&&storageReview.status==='passed'&&storageReview.independentReview===true,
  'prejournal-reserved-reviewed-runtime-required');
 for(const pinned of [launcher.runner,launcher.entry,authorityIntent.bootstrap,authorityIntent.retryHelper]){
  need(review.files[pinned.path]===pinned.sha256,'prejournal-reserved-unreviewed-source');readEvidenceFile(pinned,{maximum:8*1024**2});
 }
 need(same(intent,{request:request.original.request,argv:[original.node.path,entry,'start',init.journalDirectory,request.original.descriptor.path],sameReleaseOperation:true})
  &&admission.grantSha256===grantHash&&same(admission.request,request.original.request)&&same(admission.originalDispatch,request.original.dispatch)
  &&admission.automaticNewOperationPermitted===false&&admission.startedAtMilliseconds>=previous.issuedAtMs
  &&admission.startedAtMilliseconds<previous.expiresAtMs,'prejournal-reserved-admission-changed');
 const expectedGraph=previous.operator.sourceFiles.map(s=>({path:resolve(previousApp,'scripts',s.name),sha256:s.sha256}));
 need(graph.format===1&&graph.adapterIdentity===previous.operator.adapterIdentity&&same(graph.sourceFiles,expectedGraph),'prejournal-reserved-source-graph-changed');
 for(const pinned of expectedGraph)readEvidenceFile(pinned,{maximum:8*1024**2});
 const authorityDir=resolve(r.authority.intent.path,'..');
 need(resolve(authorityDir,'..')===join(root,'authority-observations')
  &&same(authorityIntent.config,launcher.config)&&same(authorityIntent.originalRequest,request.original.request)
  &&authorityIntent.readOnly===true&&authorityIntent.totalTimeoutSeconds===60
  &&same(authorityIntent.argv,[original.node.path,authorityIntent.bootstrap.path,entry,
   review.files[join(previousApp,'scripts','release-delivery-continuation.mjs')],review.files[join(previousApp,'scripts','release-coordinate.mjs')],
   init.journalDirectory,request.operationId,r.previousProof.path,r.previousProof.sha256]),'prejournal-reserved-authority-context-changed');
 need(r.authority.result.path===join(authorityDir,'result.json')&&result.readOnly===true&&result.releaseEffectRetry===false
  &&result.failure===null&&result.returnCode===1&&result.elapsedSeconds>=0&&result.elapsedSeconds<60,
  'prejournal-reserved-authority-failure-required');
 for(const name of ['stdout','stderr']){
  const pinned=r.authority[name],bytes=readEvidenceFile(pinned,{maximum:65536}),observed=result.outputs[name];
  need(pinned.path===join(authorityDir,name+'.log')&&same(observed.reference,pinned)&&observed.complete===true
   &&observed.totalBytes===bytes.length&&observed.wholeSha256===pinned.sha256,'prejournal-reserved-failure-output-changed');
 }
 const error=readEvidenceFile(r.authority.stderr).toString();
 need(result.outputs.stdout.totalBytes===0&&error.includes('Error: spawnSync ')&&error.includes('powershell.exe EPERM')
  &&error.includes('at protectDirectory (')&&error.includes('at validateJournalDirectory (')&&error.includes('at verifyPreJournalStorageAuthority (')
  &&/errno: -4048/.test(error)&&/code: 'EPERM'/.test(error)&&/pid: 0/.test(error)&&/status: null/.test(error),
  'prejournal-reserved-exact-readonly-launch-refusal-required');
 return r;
}

export async function preparePreJournalReconciliation(requestRef,{clock=Date.now,assertAbsent,command}={}){
 const request=preJournalRequestSchema.parse(json(requestRef)),before=preJournalOriginal(request,{assertAbsent,exclusiveHistory:true});
 const {validateJournalDirectory}=await import('./release-coordinate.mjs');
 validateJournalDirectory(before.journalDirectory,{create:false});
 const out=validateJournalDirectory(request.outputDirectory,{create:true}),proofPath=join(out,'prejournal-authority.json');
 need(!existsSync(proofPath),'prejournal-authority-already-prepared-no-renewal');
 const operator=await qualifyOperatorSources(request,before.descriptor,{command});operator.ci={};
 const A=await import('./release-delivery-adapters.mjs');command??=A.fixedCommand;
 const target=json(before.descriptor.target),container={directory:out};
 for(const side of ['private','public']){
  const s=operator.sources[side],runId=request.ciRuns[side],input=save(container,'operator-ci-request-'+side,{format:1,source:s,runId,tools:target.sourceTools});
  const value=JSON.parse(await command(target.sourceTools.python.path,[fileURLToPath(new URL('release-operator-ci.py',import.meta.url)),'--request',input.path,'--request-sha256',input.sha256],{maximum:8*1024**2,timeoutMs:180000}));
  need(value.run.id===runId,'prejournal-operator-ci-id-changed');operator.ci[side]=save(container,'operator-ci-'+side,verifyOperatorCi(value,s));
 }
 const after=preJournalOriginal(request,{assertAbsent,exclusiveHistory:true});need(same(after.binding,before.binding),'prejournal-original-context-raced');
 const at=clock(),proof=preJournalGrantSchema.parse({format:1,kind:'nova-pre-journal-dispatch-reconciliation',operationId:request.operationId,
  ...after.binding,request:requestRef,operator,issuedAtMs:at,expiresAtMs:at+request.durationMs,automaticRenewal:false,originalHistoryPreserved:true});
 const fd=openSync(proofPath,'wx',0o600);try{writeFileSync(fd,canonical(proof)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 return reference(proofPath);
}

export function verifyPreJournalProof(raw,{now=Date.now(),requireEmpty=false,assertAbsent}={}){
 const proof=preJournalGrantSchema.parse(raw),request=preJournalRequestSchema.parse(json(proof.request));
 const original=preJournalOriginal(request,{requireEmpty,assertAbsent});
 need(proof.operationId===request.operationId&&Object.entries(original.binding).every(([k,v])=>same(v,proof[k]))
  &&same(proof.operator.sources,request.operatorSources)&&proof.expiresAtMs-proof.issuedAtMs===request.durationMs,'prejournal-proof-original-context-changed');
 for(const side of ['private','public'])need(verifyOperatorCi(json(proof.operator.ci[side]),proof.operator.sources[side]).run.id===request.ciRuns[side],'prejournal-proof-ci-changed');
 if(requireEmpty)need(now>=proof.issuedAtMs&&now<proof.expiresAtMs,'prejournal-first-dispatch-window-expired');
 return {proof,original};
}

export async function verifyPreJournalStorageAuthority({proofReference,entry=null,operationId=null,journalDirectory=null,now=Date.now(),requireEmpty=true}){
 const checked=verifyPreJournalProof(json(proofReference),{now,requireEmpty}),p=checked.proof,A=await import('./release-delivery-adapters.mjs');
 need((operationId===null||operationId===p.operationId)&&(journalDirectory===null||resolve(journalDirectory)===checked.original.journalDirectory),'prejournal-requested-operation-changed');
 need(resolve(proofReference.path)===join(checked.original.request.outputDirectory,'prejournal-authority.json'),'prejournal-proof-location-changed');
 const current=A.deliveryAdapterSourceFiles().map(name=>({name,sha256:sha256(readFileSync(new URL(name,import.meta.url)))}));
 need(A.deliveryAdapterIdentity()===p.operator.adapterIdentity&&same(current,p.operator.sourceFiles),'prejournal-current-operator-graph-changed');
 const roots=[join(p.operator.sources.private.root,'edition3'),p.operator.sources.public.root],actual=join(roots[0],'scripts/release-deliver.mjs');
 need(entry===null||resolve(entry)===resolve(actual),'prejournal-current-operator-entry-changed');
 const {validateJournalDirectory}=await import('./release-coordinate.mjs');validateJournalDirectory(checked.original.journalDirectory,{create:false});
 return {grantSha256:sha256(canonical(p)),operatorAdapterIdentity:p.operator.adapterIdentity,operatorEntry:reference(actual),operatorRoots:roots,
  operatorSources:p.operator.sources,expiresAtMs:p.expiresAtMs,originalAdapterIdentity:p.originalAdapterIdentity,descriptorSha256:p.descriptorSha256,
  newEffectsAllowed:now>=p.issuedAtMs&&now<p.expiresAtMs,continuationStarted:false};
}

export function originalOwnerObservationArguments(pid){
 need(Number.isSafeInteger(pid)&&pid>0,'continuation-original-process-id-invalid');
 const script="$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = "+pid+"';if($null -eq $p){'null'}else{@{pid=[int]$p.ProcessId;created=$p.CreationDate}|ConvertTo-Json -Compress}";
 return ['-NoProfile','-NonInteractive','-Command',script];
}
export function verifyOriginalOwnerAbsent(owner){
 need(Number.isSafeInteger(owner.pid)&&owner.pid>0&&/^\/Date\([0-9]+\)\/$/.test(owner.created??'')&&typeof owner.executable==='string'&&hash.safeParse(owner.commandLineSha256).success,'continuation-original-process-identity-invalid');
 try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')return;throw Error('continuation-owner-closure-unavailable');}
 need(process.platform==='win32','continuation-original-owner-still-present');
 const args=originalOwnerObservationArguments(owner.pid);
 const raw=execFileSync(join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),args,{encoding:'utf8',timeout:15000,maxBuffer:65536,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const current=JSON.parse(raw);need(current===null||(current.pid===owner.pid&&/^\/Date\([0-9]+\)\/$/.test(current.created)&&current.created!==owner.created),'continuation-original-owner-still-present');
}
const absentOwner=verifyOriginalOwnerAbsent;
export function verifyOriginalContinuationGraph(request,descriptor){
 const graph=json(request.historical.manifest);need(graph.format===1&&graph.adapterIdentity===descriptor.adapterIdentity&&Array.isArray(graph.sourceFiles)&&graph.sourceFiles.length>0&&graph.sourceFiles.length<=512,'continuation-original-graph-invalid');
 const rows=graph.sourceFiles.map(r=>{ref.parse(r);const name=relative(join(request.historical.root,'scripts'),r.path).replaceAll('\\','/');need(!isAbsolute(name)&&!name.startsWith('../../')&&!name.includes('\0'),'continuation-original-graph-path-invalid');readEvidenceFile(r,{maximum:8*1024**2});return{name,sha256:r.sha256};});
 need(new Set(rows.map(r=>r.name)).size===rows.length&&rows.some(r=>r.name==='release-delivery-adapters.mjs')&&sha256(canonical(rows))===descriptor.adapterIdentity,'continuation-original-adapter-changed');return rows;
}
function history(journal,id,through=null){
 const rows=journal.db.prepare('SELECT id,at_ms,kind,payload_hash FROM delivery_events WHERE operation_id=? AND id<=? ORDER BY id').all(id,through??Number.MAX_SAFE_INTEGER);
 return {eventHighWaterMark:rows.at(-1)?.id??0,historySha256:sha256(canonical(rows))};
}
export function continuationSnapshot(journal,id,now,{assertAbsent=absentOwner,request=null}={}){
 const retained=journal.loadDelivery(id),d=retained.descriptor;
 need(retained.state==='active'&&!journal.deliveryDisposition(id),'continuation-original-active-operation-required');
 const correction=request?.kind===correctionRequestKind,startup=request?.kind===startupCorrectionRequest,deadline=retained.created_at+d.observationBudgetMs;
 if(correction||startup)need(Number.isSafeInteger(now)&&now>=retained.created_at&&now<deadline,startup?'startup-correction-original-budget-expired':'dependency-correction-original-budget-expired');
 else need(Number.isSafeInteger(now)&&now>deadline,'continuation-original-budget-not-expired');
 const names=journal.db.prepare('SELECT phase FROM delivery_phases WHERE operation_id=? ORDER BY phase').all(id).map(x=>x.phase);
 need(same(names,[...PREWRITE_PREREQUISITES].sort()),'continuation-downstream-reservation-present');
 const phases=PREWRITE_PREREQUISITES.map(n=>journal.deliveryPhase(id,n));
 need(phases.every(p=>p?.state==='completed'&&p.validation?.state!=='failed'),'continuation-prerequisites-not-complete');
 need(phases.at(-1).current.output?.route==='full','continuation-full-route-required');
 need(!journal.db.prepare('SELECT id FROM operations WHERE id=?').get(id)&&!journal.intent(id),'continuation-coordinator-effect-present');
 need(!journal.db.prepare("SELECT id FROM delivery_events WHERE operation_id=? AND kind='rejected-producer-observation'").get(id),'continuation-rejected-effect-history');
 need(!readdirSync(journal.directory).some(n=>/^(delivery-package-|delivery-signature-|delivery-full-|dependency-)/.test(n)),'continuation-downstream-output-present');
 let ownerPids=[];
 if(request){
  need(request.operationId===id,'continuation-request-operation-changed');const originalGraph=verifyOriginalContinuationGraph(request,d);
  const original=json(request.owner.request),root=resolve(request.owner.request.path,'..'),target=json(d.target),dirs=[];
  need(original.operationId===id&&same(original.node,target.artifactTools.node),'continuation-original-storage-request-changed');
  if(correction||startup)need(request.owner.attempts.length===1,startup?'startup-correction-single-closed-attempt-required':'dependency-correction-single-closed-attempt-required');
  if(correction){
   const prior=Object.fromEntries(phases.map(p=>[p.phase,p.current.output]));
   correctedDependencyTarget(target,d,prior,request.correction);
   const policy=request.browserWindowPolicy;
   if(policy){
    need(prior.route.route==='full'&&policy.priorCandidateId===d.operation.priorCandidateId
     &&policy.priorCandidateId===prior.route.baseCandidateId&&policy.targetCandidateId===prior.route.targetCandidateId
     &&target.full.host.priorVersion==='2.28.39'&&target.full.host.priorBuildVersion==='1.0.412'
     &&d.operation.version==='2.28.45'&&d.operation.buildVersion==='1.0.418'&&target.browserTools?.mode==='remote'
     &&target.browserTools.suite==='tasks-search-focus','browser-retained-window-policy-target-changed');
   }
  }
  for(const a of request.owner.attempts){
   const launcher=json(a.launcher),intent=json(a.intent),closed=json(a.childResult),exit=json(a.exit),status=json(a.stdout),dir=resolve(a.intent.path,'..');dirs.push(dir);
   need(/^observation-[0-9]{4,}$/.test(relative(join(root,'observations'),dir))&&a.intent.path===join(dir,'intent.json')&&a.exit.path===join(dir,'exit.json')&&a.childResult.path===join(dir,'default-child-result.json')&&a.stdout.path===join(dir,'stdout.json'),'continuation-original-observation-path-changed');
   need(launcher.kind==='verified-waiting-release-launcher'&&launcher.dispatchAuthority===false&&launcher.operationId===id&&['start','resume'].includes(launcher.mode)
    &&same(launcher.node,original.node)&&same(launcher.entry,original.deliveryEntry)&&same(launcher.start,original.releaseInput)&&same(launcher.budget,original.storageBudget)
    &&resolve(launcher.cwd)===resolve(request.historical.root)&&launcher.worker.parentPid===launcher.owner.pid,'continuation-original-owner-identity-changed');
   for(const r of [launcher.node,launcher.entry,launcher.runner,launcher.config])readEvidenceFile(r,{maximum:128*1024**2});
   const tail=launcher.mode==='resume'?id:join(resolve(journal.directory,'..'),'request-'+id,'descriptor.json');
   need(same(intent.request,request.owner.request)&&intent.sameReleaseOperation===true&&same(intent.argv,[launcher.node.path,launcher.entry.path,launcher.mode,journal.directory,tail]),'continuation-original-child-argv-changed');
   if(correction||startup){
    need(launcher.mode==='start'&&dir===join(root,'observations','observation-0001'),'dependency-correction-original-first-attempt-required');
    if(startup){
     const failure=originalStartupFailure({journal,descriptor:d,target,failure:request.startupFailure,status,exit,closed,createdAt:retained.created_at,now});
     verifyOriginalStartupProgram(originalGraph,request.historical.root,target.full.dependencyTransport.startupQualification,failure,d);
    }else requireCorrectionExit(status,exit,closed,now);
   }else{
    need(closed.originalChildClosed===true&&closed.returnCode===2&&closed.logBoundExceeded===false&&closed.automaticNewOperationPermitted===false&&exit.returnCode===2
     &&Number.isSafeInteger(exit.finishedAtMilliseconds)&&exit.finishedAtMilliseconds<=now,'continuation-original-owner-not-closed');
    need(status.operationId===id&&status.complete===false&&status.closed===false,'continuation-original-result-changed');
   }
   for(const p of [launcher.owner,launcher.worker]){need(Number(p.created.match(/^\/Date\(([0-9]+)\)\/$/)?.[1])<=exit.finishedAtMilliseconds,'continuation-original-owner-time-changed');assertAbsent(p);ownerPids.push(p.pid);}
  }
  const actual=readdirSync(join(root,'observations')).filter(n=>/^observation-[0-9]{4,}$/.test(n)).map(n=>join(root,'observations',n));
  need(new Set(dirs).size===dirs.length&&same([...dirs].sort(),actual.sort()),'continuation-unclassified-original-owner');
  const latest=request.owner.attempts.find(a=>resolve(a.intent.path,'..')===[...dirs].sort().at(-1)),status=json(latest.stdout);
  if(!correction&&!startup){
   need(status.observationBudgetExpired===true,'continuation-original-expired-result-required');
   const states=rows=>rows.map(({phase,state,key,externalId,reason})=>({phase,state,key,externalId,reason}));
   need(same(states(status.phases),states(journal.deliveryStatus(id,now).phases)),'continuation-original-owner-result-changed');
  }
 }
 return {descriptorSha256:retained.descriptor_hash,targetIdentity:d.targetIdentity,originalAdapterIdentity:d.adapterIdentity,
  originalTimelineSha256:sha256(canonical(d.timeline)),originalBudgetMs:d.observationBudgetMs,originalCreatedAtMs:retained.created_at,...history(journal,id),
  snapshotSha256:sha256(canonical(phases)),prerequisites:phases.map(p=>({phase:p.phase,key:p.key,inputSha256:p.inputSha256,observationSha256:sha256(canonical(p.current))})),ownerPids};
}

function storageUuid(namespace,name){
 const bytes=createHash('sha1').update(Buffer.from(z.uuid().parse(namespace).replaceAll('-',''),'hex')).update(name).digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
}
/** Completed original maintenance is provenance, never fresh release capacity. */
export function verifyCompletedOriginalStorage(journal,id,raw,{predecessor,now=Date.now(),assertAbsent=absentOwner,observeOwners=false}={}){
 const marker=completedOriginalStorageSchema.parse(raw),result=json(marker.result),review=json(marker.review);
 need(predecessor?.proof.kind==='nova-expired-publication-continuation'&&!predecessor.proof.successor&&predecessor.proof.operationId===id,'storage-successor-original-grant-required');
 need(result.format===1&&result.kind==='original-storage-recovery-result'&&result.state==='ready'&&result.releaseDispatched===false&&result.deploymentLockReleased===true,'storage-successor-genuine-recovery-required');
 need(Number.isSafeInteger(Date.parse(result.recordedAt))&&Date.parse(result.recordedAt)>=predecessor.proof.issuedAtMs&&Date.parse(result.recordedAt)<=now,'storage-successor-recovery-time-invalid');
 const plan=json(result.plan),fixed=json(plan.fixedContext),parent=json(plan.originalInput),child=json(plan.batchInput),originalRequest=json(plan.originalRequest);
 need(plan.kind==='original-storage-recovery-plan'&&plan.releaseOperationId===id&&plan.maximumBatches===1&&plan.releaseDispatchPermitted===false&&plan.automaticRetry===false,'storage-successor-single-original-batch-required');
 need(fixed.releaseOperationId===id&&fixed.grantSha256===predecessor.sha256&&resolve(fixed.journalDirectory)===resolve(journal.directory)
  &&same(fixed.storageInput,plan.originalInput)&&same(fixed.batchInput,plan.batchInput)&&same(fixed.request,plan.originalRequest)&&same(fixed.configuration,plan.configuration),'storage-successor-fixed-context-changed');
 const root=resolve(plan.originalRequest.path,'..'),admission=relative(join(root,'continuations',predecessor.sha256),resolve(plan.directory)).replaceAll('\\','/');
 need(/^admission-[0-9]{4,}\/before-delivery$/.test(admission)&&resolve(plan.originalInput.path)===join(resolve(plan.directory),'input.json')
  &&resolve(plan.batchInput.path)===join(resolve(plan.directory),'batch-001-input.json')&&resolve(plan.batchDirectory)===join(resolve(plan.directory),'batch-001')
  &&resolve(fixed.directory)===resolve(plan.directory)&&resolve(fixed.batchDirectory)===resolve(plan.batchDirectory),'storage-successor-original-admission-path-changed');
 need(originalRequest.operationId===id&&same(originalRequest.storageBudget,parent.budget)&&same(json(originalRequest.releaseInput).profile,parent.profile)
  &&parent.phase==='before-allocation'&&parent.operationId===plan.storageOperationId&&same(child,{...parent,operationId:storageUuid(parent.operationId,'batch-001')})
  &&plan.generationOperationId===storageUuid(child.operationId,'whole-generation-retention')&&fixed.generationOperationId===plan.generationOperationId,'storage-successor-original-lineage-changed');
 need(result.originalDeadline===plan.originalDeadline&&child.originalDeadline===plan.originalDeadline&&fixed.originalDeadline===plan.originalDeadline
  &&Date.parse(plan.originalDeadline)===predecessor.proof.expiresAtMs,'storage-successor-original-deadline-changed');
 need(!existsSync(join(resolve(plan.directory),'..','release-dispatch.json'))&&!readdirSync(plan.directory).some(n=>{const m=/^batch-([0-9]{3,})(?:-|$)/.exec(n);return m&&m[1]!=='001';}),'storage-successor-original-admission-already-used');
 const s=result.storage,completion=json(s?.result),{result:_ref,...claimed}=s??{};
 need(s?.format===1&&s.kind==='private-storage-maintenance-result'&&s.state==='ready'&&s.operationId===child.operationId&&s.originalDeadline===plan.originalDeadline
  &&s.cleanupPerformed===true&&s.protectedRolesVerified===true&&s.releaseAdmission===false&&same(completion,claimed),'storage-successor-native-completion-changed');
 const completionName=relative(resolve(plan.batchDirectory),resolve(s.result.path));
 need(/^(complete\.json|completion-refresh-[a-f0-9]{16}\.json)$/.test(completionName),'storage-successor-native-completion-path-changed');
 if(s.originalCompletion){const old=json(s.originalCompletion);need(old.kind===s.kind&&old.operationId===s.operationId&&old.originalDeadline===s.originalDeadline&&same(old.cleanup,s.cleanup)&&old.cleanupPerformed===true&&old.protectedRolesVerified===true,'storage-successor-original-completion-changed');}
 const cleanup=json(s.cleanup),preflight=json(s.finalPreflight),inventory=json(preflight.inventory),budget=json(parent.budget),assessment=preflight.assessment;
 need(cleanup.cleanupComplete===true&&cleanup.protectedRolesVerified===true&&cleanup.originalWorkerClosed===true&&cleanup.originalDeadline===plan.originalDeadline
  &&Number.isSafeInteger(s.reclaimedBytes)&&s.reclaimedBytes>0&&cleanup.observedFreeIncreaseBytes===s.reclaimedBytes,'storage-successor-cleanup-not-closed');
 need(preflight.format===1&&preflight.kind==='private-storage-preflight'&&preflight.state==='ready'&&preflight.phase===parent.phase&&preflight.originalDeadline===parent.originalDeadline
  &&assessment?.format===1&&assessment.kind==='storage-lifecycle-budget-result'&&assessment.phase===parent.phase&&assessment.fits===true
  &&assessment.allocationBudgetAdmissionOnly===true&&assessment.releaseAdmission===false&&assessment.stoppedAndPostStartChecksStillRequired===true
  &&assessment.observationExpiresAtMilliseconds===s.observationExpiresAtMilliseconds,'storage-successor-completion-capacity-invalid');
 need(inventory.readOnly===true&&same(inventory.sourceEvidence?.profile,parent.profile)&&same(inventory.sourceEvidence?.configuration,parent.configuration)
  &&inventory.observedAtMilliseconds+120000===assessment.observationExpiresAtMilliseconds,'storage-successor-capacity-context-changed');
 const rows=assessment.filesystems,order=a=>[...a].sort((x,y)=>String(x.id).localeCompare(String(y.id)));
 need(Array.isArray(rows)&&rows.length>0&&rows.length<=64&&rows.every(r=>Number.isSafeInteger(r.availableBytes)&&Number.isSafeInteger(r.requiredFreeBytes)&&r.requiredFreeBytes>=0&&r.availableBytes>=r.requiredFreeBytes&&r.deficitBytes===0&&Array.isArray(r.allocations))
  &&Array.isArray(budget.allocations)&&same(order(rows.flatMap(r=>r.allocations)),order(budget.allocations)),'storage-successor-historical-capacity-shortfall');
 need(review.kind==='independent-original-storage-recovery-outcome-review'&&review.status==='passed'&&review.independentReview===true&&same(review.recoveryResult,marker.result)
  &&same(review.nativeCompletion,s.result)&&same(review.batchInput,plan.batchInput)&&review.originalDeadline===plan.originalDeadline&&review.releaseDispatched===false&&review.noSuccessorBatch===true
  &&review.completedOriginalStorageVerified===true&&review.noReleaseAdmission===true&&review.originalBatchOnly===true,'storage-successor-independent-outcome-review-required');
 const closure=json(review.lockedOwnerClosure),ownerInput=json(closure.input),waiter=json(closure.waitingLauncher);
 need(closure.kind==='exact-original-caller-closure-observation'&&closure.status==='passed'&&closure.closed===true&&closure.readOnly===true&&closure.releaseAdmission===false
  &&closure.releaseOperationId===id&&closure.stopOrKillCalls===0&&closure.remoteHostCalls===0&&closure.censusPasses===2&&closure.snapshots?.length===2
  &&closure.snapshots.every(v=>v.closed===true&&v.descendantCandidates?.length===0&&v.identityConflicts?.length===0&&v.taskProcessConflicts?.length===0)
  &&same(closure.source,fixed.ownerObserver)&&same(closure.input,fixed.ownerObserverInput)&&same(ownerInput.originalRoots,{owner:waiter.owner,worker:waiter.worker})&&waiter.operationId===id,'storage-successor-locked-owner-closure-required');
 readEvidenceFile(closure.source);for(const r of Object.values(closure.sources??{}))readEvidenceFile(ref.parse(r),{maximum:128*1024**2});
 if(observeOwners){assertAbsent(waiter.owner);assertAbsent(waiter.worker);}
 const planReview=json(result.review),intent=json(result.intent);
 readEvidenceFile(ref.parse(plan.source));
 need(planReview.status==='passed'&&planReview.independentReview===true&&same(planReview.source,plan.source)&&same(planReview.plan,result.plan)&&same(intent.plan,result.plan)&&same(intent.review,result.review)
  &&intent.automaticRetry===false,'storage-successor-recovery-intent-changed');
 return marker;
}
function verifyStorageSuccessorPredecessor(journal,id,successor,{now,assertAbsent=absentOwner,observeOwners=false}={}){
 const previous=journal.deliveryOriginalOperatorContinuation?.(id);
 need(previous&&previous.sha256===successor.predecessorGrantSha256&&previous.proof.kind==='nova-expired-publication-continuation'&&!previous.proof.successor,'publication-storage-successor-predecessor-changed');
 verifyStoredContinuationGrant(journal,id,previous,{now,effect:false});
 verifyCompletedOriginalStorage(journal,id,successor.completedOriginalStorage,{predecessor:previous,now,assertAbsent,observeOwners});return previous;
}


/** The completed admission belongs to the expired predecessor, never the new clock. */
export function verifyBrowserWindowRecoveryPredecessor(journal,id,raw,{now=Date.now(),assertAbsent=absentOwner,observeOwners=false}={}){
 const marker=browserWindowRecoverySchema.parse(raw),previous=journal.deliveryStorageSuccessorContinuation(id);
 need(previous?.proof.successor&&!previous.proof.browserWindowRecovery&&previous.sha256===marker.predecessorGrantSha256,'browser-window-recovery-predecessor-changed');
 verifyStoredContinuationGrant(journal,id,previous,{now,effect:false,assertAbsent});
 const admitted=journal.deliveryPublicationContinuationAdmission(id);
 need(admitted&&admitted.admission.grantSha256===previous.sha256&&same(marker.storageAdmission,{eventId:admitted.eventId,sha256:admitted.sha256,session:admitted.admission.session,dispatch:admitted.admission.dispatch}),'browser-window-recovery-historical-admission-changed');
 if(observeOwners)verifyStorageSuccessorPredecessor(journal,id,previous.proof.successor,{now,assertAbsent,observeOwners:true});
 return previous;
}
function browserWindowRecoveryOwners(journal,id,request,previous,now,assertAbsent){
 const previousRequest=publicationContinuationRequestSchema.parse(json(previous.proof.request)),original=json(request.owner.request),root=resolve(request.owner.request.path,'..');
 need(same(request.owner.request,previousRequest.owner.request)&&request.owner.attempts.length>previousRequest.owner.attempts.length
  &&same(request.owner.attempts.slice(0,previousRequest.owner.attempts.length),previousRequest.owner.attempts),'browser-window-recovery-owner-history-changed');
 const dirs=[],ownerPids=[];
 for(const [index,a]of request.owner.attempts.entries()){
  const launcher=json(a.launcher),intent=json(a.intent),closed=json(a.childResult),exit=json(a.exit),status=json(a.stdout),dir=resolve(a.intent.path,'..'),name=relative(join(root,'observations'),dir);dirs.push(dir);
  need(/^observation-[0-9]{4,}$/.test(name)&&a.intent.path===join(dir,'intent.json')&&a.exit.path===join(dir,'exit.json')&&a.childResult.path===join(dir,'default-child-result.json')&&a.stdout.path===join(dir,'stdout.json'),'continuation-original-observation-path-changed');
  const retained=index<previousRequest.owner.attempts.length,expectedEntry=retained?original.deliveryEntry:reference(join(previous.proof.operator.sources.private.root,'edition3/scripts/release-deliver.mjs'));
  need(launcher.kind==='verified-waiting-release-launcher'&&launcher.dispatchAuthority===false&&launcher.operationId===id&&['start','resume'].includes(launcher.mode)
   &&same(launcher.node,original.node)&&same(launcher.entry,expectedEntry)&&same(launcher.start,original.releaseInput)&&same(launcher.budget,original.storageBudget)
   &&resolve(launcher.cwd)===resolve(retained?request.historical.root:join(previous.proof.operator.sources.private.root,'edition3'))&&launcher.worker.parentPid===launcher.owner.pid,'continuation-original-owner-identity-changed');
  for(const r of [launcher.node,launcher.entry,launcher.runner,launcher.config])readEvidenceFile(r,{maximum:128*1024**2});
  const tail=launcher.mode==='resume'?id:join(resolve(journal.directory,'..'),'request-'+id,'descriptor.json');
  need(same(intent.request,request.owner.request)&&intent.sameReleaseOperation===true&&same(intent.argv,[launcher.node.path,launcher.entry.path,launcher.mode,journal.directory,tail]),'continuation-original-child-argv-changed');
  need(closed.originalChildClosed===true&&closed.logBoundExceeded===false&&closed.automaticNewOperationPermitted===false&&closed.returnCode===exit.returnCode
   &&Number.isSafeInteger(exit.finishedAtMilliseconds)&&exit.finishedAtMilliseconds<=now,'continuation-original-owner-not-closed');
  if(retained||exit.returnCode===2){need(exit.returnCode===2&&status.operationId===id&&status.complete===false&&status.closed===false,'continuation-original-result-changed');}
  else need(exit.returnCode===1&&status.kind==='nova-release-delivery-error'&&typeof status.reason==='string'&&status.reason.length>0&&status.automaticReplayPermitted===false,'browser-window-recovery-closed-error-required');
  if(!retained){
   const session=json(reference(join(root,'session-'+name+'.json'))),config=json(launcher.config),graph=json(session.sourceGraph);
   need(session.kind==='nova-storage-default-session'&&session.mode==='resume'&&session.operationId===id&&same(session.request,request.owner.request)
    &&Number.isSafeInteger(session.issuedAtMilliseconds)&&session.issuedAtMilliseconds>=previous.proof.issuedAtMs&&session.issuedAtMilliseconds<=exit.finishedAtMilliseconds
    &&same(session.config,launcher.config)&&same(session.continuationDispatch,request.browserWindowRecovery.storageAdmission.dispatch)
    &&session.operatorContinuation?.grantSha256===previous.sha256&&session.adapterIdentity===previous.proof.operator.adapterIdentity&&graph.adapterIdentity===previous.proof.operator.adapterIdentity
    &&config.operatorContinuation?.operationId===id&&resolve(config.operatorContinuation.journalDirectory)===resolve(journal.directory)&&same(config.operatorContinuation.originalRequest,request.owner.request),'browser-window-recovery-closed-session-changed');
  }
  for(const p of [launcher.owner,launcher.worker]){need(Number(p.created.match(/^\/Date\(([0-9]+)\)\/$/)?.[1])<=exit.finishedAtMilliseconds,'continuation-original-owner-time-changed');assertAbsent(p);ownerPids.push(p.pid);}
 }
 const actual=readdirSync(join(root,'observations')).filter(n=>/^observation-[0-9]{4,}$/.test(n)).map(n=>join(root,'observations',n));
 need(new Set(dirs).size===dirs.length&&same([...dirs].sort(),actual.sort()),'continuation-unclassified-original-owner');
 return ownerPids;
}

export function publicationContinuationSnapshot(journal,id,now,{assertAbsent=absentOwner,request=null}={}){
 need(request,'publication-continuation-request-required');request=publicationContinuationRequestSchema.parse(request);
 if(request.successor){
  const previous=verifyStorageSuccessorPredecessor(journal,id,request.successor,{now,assertAbsent,observeOwners:true});
  need(journal.deliveryOperatorContinuation(id)?.sha256===previous.sha256&&now>=previous.proof.expiresAtMs,'publication-storage-successor-not-expired-or-already-granted');
  const previousRequest=publicationContinuationRequestSchema.parse(json(previous.proof.request));
  need(same(request.historical,previousRequest.historical)&&same(request.owner,previousRequest.owner)&&same(request.publication,previous.proof.publication)&&same(request.browser,previous.proof.browser),'publication-storage-successor-original-scope-changed');
  need(!journal.deliveryPublicationContinuationAdmission(id),'publication-storage-successor-already-admitted');
 }
 let recoveryPrevious=null;
 if(request.browserWindowRecovery){
  recoveryPrevious=verifyBrowserWindowRecoveryPredecessor(journal,id,request.browserWindowRecovery,{now,assertAbsent,observeOwners:true});
  need(journal.deliveryOperatorContinuation(id)?.sha256===recoveryPrevious.sha256&&now>=recoveryPrevious.proof.expiresAtMs,'browser-window-recovery-not-expired-or-already-granted');
  const previousRequest=publicationContinuationRequestSchema.parse(json(recoveryPrevious.proof.request));
  need(same(request.historical,previousRequest.historical)&&same(request.publication,recoveryPrevious.proof.publication)&&same(request.browser,recoveryPrevious.proof.browser),'browser-window-recovery-original-scope-changed');
  need(request.durationMs>=1800000,'browser-window-recovery-full-window-required');
  assertBrowserWindowRecoveryUnmaterialized(journal,request.browser.successorSessionId);
 }
 const retained=journal.loadDelivery(id),d=retained.descriptor;
 need(retained.state==='active'&&!journal.deliveryDisposition(id),'continuation-original-active-operation-required');
 need(Number.isSafeInteger(now)&&now>retained.created_at+d.observationBudgetMs,'continuation-original-budget-not-expired');
 const names=journal.db.prepare('SELECT phase FROM delivery_phases WHERE operation_id=? ORDER BY phase').all(id).map(x=>x.phase);
 need(same(names,[...PUBLICATION_CONTINUATION_PREREQUISITES,...PUBLICATION_PACKAGE_SUBSTEPS,'publication'].sort()),'publication-continuation-downstream-reservation-present');
 const phases=PUBLICATION_CONTINUATION_PREREQUISITES.map(n=>journal.deliveryPhase(id,n)),publication=journal.deliveryPhase(id,'publication');
 need(phases.every(p=>p?.state==='completed'&&p.validation?.state!=='failed'),'continuation-prerequisites-not-complete');
 need(phases.find(p=>p.phase==='route').current.output?.route==='full','continuation-full-route-required');
 const parent=phases.find(p=>p.phase==='package'),substeps=PUBLICATION_PACKAGE_SUBSTEPS.map(n=>journal.deliveryPhase(id,n));
 need(substeps.every(p=>p?.state==='completed'&&p.validation?.state!=='failed'&&p.input.parentKey===parent.key&&p.input.parentInputSha256===parent.inputSha256),'publication-continuation-package-substeps-changed');
 need(publication&&['gap','uncertain'].includes(publication.state)&&publication.validation?.state!=='failed','publication-continuation-original-gap-required');
 need(!journal.db.prepare('SELECT id FROM operations WHERE id=?').get(id)&&!journal.intent(id),'continuation-coordinator-effect-present');
 need(!journal.db.prepare("SELECT id FROM delivery_events WHERE operation_id=? AND kind='rejected-producer-observation'").get(id),'continuation-rejected-effect-history');
 const reservation={key:publication.key,inputSha256:publication.inputSha256,observationSha256:sha256(canonical(publication.current))};
 need(same(reservation,request.publication),'publication-continuation-reservation-changed');
 let ownerPids=recoveryPrevious?browserWindowRecoveryOwners(journal,id,request,recoveryPrevious,now,assertAbsent):[];
 if(request&&!recoveryPrevious){
  need(request.operationId===id,'continuation-request-operation-changed');verifyOriginalContinuationGraph(request,d);
  const original=json(request.owner.request),root=resolve(request.owner.request.path,'..'),target=json(d.target),dirs=[];
  need(original.operationId===id&&same(original.node,target.artifactTools.node),'continuation-original-storage-request-changed');
  for(const a of request.owner.attempts){
   const launcher=json(a.launcher),intent=json(a.intent),closed=json(a.childResult),exit=json(a.exit),status=json(a.stdout),dir=resolve(a.intent.path,'..');dirs.push(dir);
   need(/^observation-[0-9]{4,}$/.test(relative(join(root,'observations'),dir))&&a.intent.path===join(dir,'intent.json')&&a.exit.path===join(dir,'exit.json')&&a.childResult.path===join(dir,'default-child-result.json')&&a.stdout.path===join(dir,'stdout.json'),'continuation-original-observation-path-changed');
   need(launcher.kind==='verified-waiting-release-launcher'&&launcher.dispatchAuthority===false&&launcher.operationId===id&&['start','resume'].includes(launcher.mode)
    &&same(launcher.node,original.node)&&same(launcher.entry,original.deliveryEntry)&&same(launcher.start,original.releaseInput)&&same(launcher.budget,original.storageBudget)
    &&resolve(launcher.cwd)===resolve(request.historical.root)&&launcher.worker.parentPid===launcher.owner.pid,'continuation-original-owner-identity-changed');
   for(const r of [launcher.node,launcher.entry,launcher.runner,launcher.config])readEvidenceFile(r,{maximum:128*1024**2});
   const tail=launcher.mode==='resume'?id:join(resolve(journal.directory,'..'),'request-'+id,'descriptor.json');
   need(same(intent.request,request.owner.request)&&intent.sameReleaseOperation===true&&same(intent.argv,[launcher.node.path,launcher.entry.path,launcher.mode,journal.directory,tail]),'continuation-original-child-argv-changed');
   need(closed.originalChildClosed===true&&closed.returnCode===2&&closed.logBoundExceeded===false&&closed.automaticNewOperationPermitted===false&&exit.returnCode===2
    &&Number.isSafeInteger(exit.finishedAtMilliseconds)&&exit.finishedAtMilliseconds<=now,'continuation-original-owner-not-closed');
   need(status.operationId===id&&status.complete===false&&status.closed===false,'continuation-original-result-changed');
   for(const p of [launcher.owner,launcher.worker]){need(Number(p.created.match(/^\/Date\(([0-9]+)\)\/$/)?.[1])<=exit.finishedAtMilliseconds,'continuation-original-owner-time-changed');assertAbsent(p);ownerPids.push(p.pid);}
  }
  const actual=readdirSync(join(root,'observations')).filter(n=>/^observation-[0-9]{4,}$/.test(n)).map(n=>join(root,'observations',n));
  need(new Set(dirs).size===dirs.length&&same([...dirs].sort(),actual.sort()),'continuation-unclassified-original-owner');
  const latest=request.owner.attempts.find(a=>resolve(a.intent.path,'..')===[...dirs].sort().at(-1)),status=json(latest.stdout);
  need(status.phases.some(p=>p.phase==='publication'&&['gap','uncertain'].includes(p.state)&&p.key===request.publication.key),'continuation-original-publication-result-required');
  const states=rows=>rows.map(({phase,state,key,externalId,reason})=>({phase,state,key,externalId,reason}));
  need(same(states(status.phases),states(journal.deliveryStatus(id,now).phases)),'continuation-original-owner-result-changed');
 }
 return {descriptorSha256:retained.descriptor_hash,targetIdentity:d.targetIdentity,originalAdapterIdentity:d.adapterIdentity,
  originalTimelineSha256:sha256(canonical(d.timeline)),originalBudgetMs:d.observationBudgetMs,originalCreatedAtMs:retained.created_at,...history(journal,id),
  snapshotSha256:sha256(canonical([...phases,...substeps,publication])),publication:reservation,browser:request.browser,...(request.successor?{successor:request.successor}:{}),...(request.browserWindowRecovery?{browserWindowRecovery:request.browserWindowRecovery}:{}),
  packageSubsteps:substeps.map(p=>({phase:p.phase,key:p.key,inputSha256:p.inputSha256,observationSha256:sha256(canonical(p.current)),parentKey:p.input.parentKey,parentInputSha256:p.input.parentInputSha256})),
  prerequisites:phases.map(p=>({phase:p.phase,key:p.key,inputSha256:p.inputSha256,observationSha256:sha256(canonical(p.current))})),ownerPids};
}

function save(journal,name,value){
 const dir=join(journal.directory,'delivery-continuation-evidence');mkdirSync(dir,{recursive:true,mode:0o700});
 const b=Buffer.from(canonical(value)+'\n'),p=join(dir,name+'-'+sha256(b)+'.json');
 if(existsSync(p))need(readFileSync(p).equals(b),'continuation-existing-evidence-changed');else{const fd=openSync(p,'wx',0o600);try{writeFileSync(fd,b);fsyncSync(fd);}finally{closeSync(fd);}}
 return reference(p);
}
const WORKFLOW='.github/workflows/operator-continuation-quality.yml';
export function verifyOperatorCi(value,source){
 const run=value.run,jobs=value.jobs;
 need(run?.head_sha===source.commit&&run.head_branch===source.branch&&run.event==='push'&&run.path===WORKFLOW&&run.name==='Operator continuation quality'
  &&Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0&&value.requestedAttempt===run.run_attempt&&run.status==='completed'&&run.conclusion==='success'&&run.repository?.full_name===source.repository,'continuation-operator-ci-run-changed');
 need(jobs?.total_count===1&&jobs.jobs?.length===1,'continuation-operator-ci-jobs-changed');
 const job=jobs.jobs[0];need(Number.isSafeInteger(job.id)&&job.id>0&&job.run_id===run.id&&(job.run_attempt===undefined||job.run_attempt===run.run_attempt)&&job.head_sha===source.commit&&job.name==='quality'&&job.status==='completed'&&job.conclusion==='success','continuation-operator-quality-not-passed');
 for(const name of ['Run npm run quality','Verify Linux update recovery'])need(job.steps.filter(s=>s.name===name&&s.status==='completed'&&s.conclusion==='success').length===1,'continuation-operator-quality-step-missing');
 return value;
}
export async function qualifyOperatorSources(request,descriptor,{command,adapterFiles,adapterIdentity}={}){
 const A=await import('./release-delivery-adapters.mjs');command??=A.fixedCommand;adapterFiles??=A.deliveryAdapterSourceFiles;adapterIdentity??=A.deliveryAdapterIdentity;
 const target=json(descriptor.target);A.validateSourceTools(target.sourceTools);const names=adapterFiles();
 const rows=names.map(name=>({name,sha256:sha256(readFileSync(new URL(name,import.meta.url)))}));
 need(names.length===new Set(names).size&&sha256(canonical(rows))===adapterIdentity(),'continuation-current-graph-invalid');
 for(const side of ['private','public']){
  const s=request.operatorSources[side],repository=side==='private'?'HatimTheDream/Nova-Dream':'HatimTheDream/Nova-Dream-Public',prefix=side==='private'?'edition3/':'';
  need(s.repository===repository&&s.commit!==descriptor.sources[side].commit&&resolve(s.root)!==resolve(descriptor.sources[side].root),'continuation-distinct-current-operator-source-required');
  const git=args=>command(target.sourceTools.git.path,['-C',s.root,...args],{gitExecPath:target.sourceTools.gitExecPath});
  need((await git(['branch','--show-current'])).trim()===s.branch&&(await git(['rev-parse','HEAD'])).trim()===s.commit&&(await git(['status','--porcelain','--untracked-files=no'])).trim()==='','continuation-current-operator-checkout-changed');
  need([`https://github.com/${repository}.git`,`https://github.com/${repository}`,`git@github.com:${repository}.git`].includes((await git(['remote','get-url','--push','origin'])).trim()),'continuation-operator-remote-changed');
  need((await git(['ls-remote','--exit-code','origin','refs/heads/'+s.branch])).trim()===s.commit+'\trefs/heads/'+s.branch,'continuation-operator-publication-required');
  await git(['merge-base','--is-ancestor',descriptor.sources[side].commit,s.commit]);
  const blob=b=>createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
  const expected=new Map(names.map(n=>[(prefix+'scripts/'+n).replace(/scripts\/\.\.\//,'').replaceAll('\\','/'),blob(readFileSync(new URL(n,import.meta.url)))]));
  const workflow=readFileSync(join(s.root,WORKFLOW));expected.set(WORKFLOW,blob(workflow));
  const found=(await git(['ls-tree','-r','--format=%(objectname)%x09%(path)',s.commit,'--',...expected.keys()])).trim().split(/\r?\n/).map(x=>x.split('\t'));
  need(found.length===expected.size&&new Set(found.map(x=>x[1])).size===found.length&&found.every(([oid,p])=>expected.get(p)===oid),'continuation-operator-committed-graph-changed');
  const original=verifyOriginalContinuationGraph(request,descriptor),old=descriptor.sources[side];
  const oldExpected=new Map(original.map(row=>[(prefix+'scripts/'+row.name).replace(/scripts\/\.\.\//,''),blob(readEvidenceFile({path:resolve(request.historical.root,'scripts',row.name),sha256:row.sha256},{maximum:8*1024**2}))]));
  const oldFound=(await command(target.sourceTools.git.path,['-C',old.root,'ls-tree','-r','--format=%(objectname)%x09%(path)',old.commit,'--',...oldExpected.keys()],{gitExecPath:target.sourceTools.gitExecPath})).trim().split(/\r?\n/).map(x=>x.split('\t'));
  need(oldFound.length===oldExpected.size&&new Set(oldFound.map(x=>x[1])).size===oldFound.length&&oldFound.every(([oid,p])=>oldExpected.get(p)===oid),'continuation-original-committed-graph-changed');
 }
 need([resolve(request.operatorSources.private.root,'edition3/scripts/release-delivery-continuation.mjs'),resolve(request.operatorSources.public.root,'scripts/release-delivery-continuation.mjs')].includes(fileURLToPath(import.meta.url)),'continuation-current-entry-source-required');
 return {adapterIdentity:adapterIdentity(),sources:request.operatorSources,sourceFiles:rows};
}
export async function reconcileExpiredPrepackage(journal,id,requestRef,{clock=Date.now,assertAbsent,command,registry}={}){
 const request=prepackageRequestSchema.parse(json(requestRef)),old=journal.deliveryOperatorContinuation(id);
 if(old){need(same(old.proof.request,requestRef),'continuation-already-granted');await verifyContinuationStorageAuthority({journal,operationId:id});return old;}
 const before=continuationSnapshot(journal,id,clock(),{request,assertAbsent}),d=journal.loadDelivery(id).descriptor;
 const A=await import('./release-delivery-adapters.mjs');command??=A.fixedCommand;registry??=A.createDeliveryRegistry({command,clock});
 const operator=await qualifyOperatorSources(request,d,{command});operator.ci={};
 const target=json(d.target);
 for(const side of ['private','public']){
  const s=operator.sources[side],runId=request.ciRuns[side];
  const input=save(journal,'operator-ci-request-'+side,{format:1,source:s,runId,tools:target.sourceTools});
  const result=JSON.parse(await command(target.sourceTools.python.path,[fileURLToPath(new URL('release-operator-ci.py',import.meta.url)),'--request',input.path,'--request-sha256',input.sha256],{maximum:8*1024**2,timeoutMs:180000}));
  need(result.run.id===runId,'continuation-operator-ci-id-changed');operator.ci[side]=save(journal,'operator-ci-'+side,verifyOperatorCi(result,s));
 }
 const prior=Object.fromEntries(PREWRITE_PREREQUISITES.map(p=>[p,journal.deliveryPhase(id,p).current.output]));
 await withVerificationPass({},async scope=>{for(const phase of PREWRITE_PREREQUISITES){const intent=journal.deliveryPhase(id,phase),adapter=registry.adapter(phase,d,prior),context={...scope,journal,descriptor:d,prior,intent,input:intent.input};need(adapter,'continuation-current-verifier-missing');await adapter.validate(context);await adapter.verify(intent.current,context);}},{readOnly:true});
 const startup=request.kind===startupCorrectionRequest;
 let startupProof,verifiedStartup;
 const context={journal,dependencyCorrection:request.correction};
 if(startup)context.onStartupObservation=record=>{
  need(!startupProof,'startup-correction-duplicate-read');
  startupProof=save(journal,'startup-proof',record);
  verifiedStartup=verifyCorrectedStartupProof({journal,descriptor:d,target,prior,reference:startupProof,since:before.originalCreatedAtMs,now:clock()});
 };
 need((await registry.phasePreflight('package',d,prior,context)).length===0,'continuation-package-prerequisite-unavailable');
 if(startup)need(verifiedStartup,'startup-correction-current-observation-required');
 const facts=await registry.continuationFacts(d,{journal,verifiedStartup});const hostFacts=save(journal,'current-idle-host',facts);
 const at=clock(),after=continuationSnapshot(journal,id,at,{request,assertAbsent});need(same(before,after),'continuation-original-history-changed');
 const correction=request.kind===correctionRequestKind;
 const proof=prepackageGrantSchema.parse({format:1,kind:startup?startupCorrectionGrant:correction?correctionGrantKind:'nova-expired-prepackage-continuation',operationId:id,...after,request:requestRef,operator,hostFacts,
  ...(startup?{startupFailure:request.startupFailure,startupProof}:{}),...(correction?{correction:request.correction}:{}),...(request.browserWindowPolicy?{browserWindowPolicy:request.browserWindowPolicy}:{}),
  issuedAtMs:at,expiresAtMs:(startup||correction)?after.originalCreatedAtMs+after.originalBudgetMs:at+request.durationMs,
  automaticRenewal:false,originalHistoryPreserved:true});
 return journal.recordOperatorContinuation(id,proof,at,{assertAbsent});
}

/** A reviewed read-only plan and a separate finite grant intent are mandatory. */
export function verifyPublicationContinuationAdmission(request,operator,snapshot,now){
 const a=publicationAdmission.parse(request.admission),plan=json(a.plan),review=json(a.review),intent=json(a.intent);
 need(plan.format===1&&plan.kind==='nova-publication-continuation-plan'&&plan.operationId===request.operationId
  &&plan.readOnly===true&&plan.hostEffects===false&&plan.journalWrites===false&&Number.isSafeInteger(plan.plannedAtMs)
  &&now>=plan.plannedAtMs&&now-plan.plannedAtMs<=900000,'publication-continuation-plan-stale');
 const plannedRequest=publicationContinuationRequestSchema.parse(json(plan.request)),{admission,...core}=request;
 need(!plannedRequest.admission&&same(core,plannedRequest)&&same(snapshot,plan.snapshot),'publication-continuation-plan-binding-changed');
 need(same(operator.sources,plan.operator.sources)&&operator.adapterIdentity===plan.operator.adapterIdentity
  &&same(operator.sourceFiles,plan.operator.sourceFiles)&&same(operator.ci,plan.operator.ci),'publication-continuation-planned-operator-changed');
 need(review.format===1&&review.kind==='nova-publication-continuation-plan-review'&&review.status==='passed'&&review.independentReview===true
  &&same(review.plan,a.plan)&&review.operatorAdapterIdentity===operator.adapterIdentity,'publication-continuation-plan-review-required');
 need(intent.format===1&&intent.kind==='nova-publication-continuation-grant-intent'&&intent.operationId===request.operationId
  &&intent.action===(request.browserWindowRecovery?'grant-original-publication-browser-window-recovery':request.successor?'grant-original-publication-storage-successor':'grant-original-publication-continuation')&&same(intent.request,plan.request)&&same(intent.plan,a.plan)&&same(intent.review,a.review)
  &&Number.isSafeInteger(intent.notBeforeMs)&&Number.isSafeInteger(intent.notAfterMs)&&intent.notBeforeMs>=plan.plannedAtMs
  &&now>=intent.notBeforeMs&&now<intent.notAfterMs&&intent.notAfterMs<=plan.plannedAtMs+900000
  &&intent.automaticRenewal===false,'publication-continuation-separate-intent-required');
 return plan;
}
export async function reconcileExpiredPublication(journal,id,requestRef,{clock=Date.now,assertAbsent,command,registry,planOnly=false}={}){
 const request=publicationContinuationRequestSchema.parse(json(requestRef)),old=journal.deliveryOperatorContinuation(id);
 if(old&&(request.browserWindowRecovery?Boolean(old.proof.browserWindowRecovery):(!request.successor||old.proof.successor))){
  need(!planOnly&&same(old.proof.request,requestRef),'continuation-already-granted');await verifyContinuationStorageAuthority({journal,operationId:id,now:clock()});
  if(old.proof.browserWindowRecovery){
   verifyContinuationGrant(journal,id,{now:clock(),effect:true,assertAbsent});
   const A=await import('./release-delivery-adapters.mjs');registry??=A.createDeliveryRegistry({command,clock});
   const prior=Object.fromEntries(PUBLICATION_CONTINUATION_PREREQUISITES.map(p=>[p,journal.deliveryPhase(id,p).current.output])),intent=journal.deliveryPhase(id,'publication');
   need(typeof registry.prepareBrowserWindowRecovery==='function','browser-window-recovery-preparation-unavailable');
   await registry.prepareBrowserWindowRecovery({journal,descriptor:journal.loadDelivery(id).descriptor,prior,intent,input:intent.input});
  }
  return old;
 }
 need(Boolean(request.successor||request.browserWindowRecovery)===Boolean(old),'publication-storage-successor-original-grant-required');
 need(planOnly?!request.admission:Boolean(request.admission),'publication-continuation-plan-or-intent-required');
 const before=publicationContinuationSnapshot(journal,id,clock(),{request,assertAbsent}),d=journal.loadDelivery(id).descriptor;
 verifyPublicationBrowserContinuation(request.browser,{descriptor:d,journal,now:clock()});
 const A=await import('./release-delivery-adapters.mjs');command??=A.fixedCommand;registry??=A.createDeliveryRegistry({command,clock});
 const operator=await qualifyOperatorSources(request,d,{command});operator.ci={};
 const target=json(d.target);
 if(planOnly){for(const side of ['private','public']){
  const s=operator.sources[side],runId=request.ciRuns[side],input=save(journal,'publication-operator-ci-request-'+side,{format:1,source:s,runId,tools:target.sourceTools});
  const result=JSON.parse(await command(target.sourceTools.python.path,[fileURLToPath(new URL('release-operator-ci.py',import.meta.url)),'--request',input.path,'--request-sha256',input.sha256],{maximum:8*1024**2,timeoutMs:180000}));
  need(result.run.id===runId,'continuation-operator-ci-id-changed');operator.ci[side]=save(journal,'publication-operator-ci-'+side,verifyOperatorCi(result,s));
 }}else{
  const plan=json(request.admission.plan);operator.ci=plan.operator?.ci;
  verifyPublicationContinuationAdmission(request,operator,before,clock());
  for(const side of ['private','public']){const ci=verifyOperatorCi(json(operator.ci[side]),operator.sources[side]);need(ci.run.id===request.ciRuns[side],'continuation-request-ci-changed');}
 }
 const all=Object.fromEntries(PUBLICATION_CONTINUATION_PREREQUISITES.map(p=>[p,journal.deliveryPhase(id,p).current.output]));
 for(const phase of PUBLICATION_CONTINUATION_PREREQUISITES){
  const prior=Object.fromEntries(Object.entries(all).filter(([p])=>p!==phase));
  need((await registry.phasePreflight(phase,d,prior,{journal})).length===0,'publication-continuation-prerequisite-unavailable');
  const intent=journal.deliveryPhase(id,phase),adapter=registry.adapter(phase,d,prior);
  need(adapter,'continuation-current-verifier-missing');
  await withVerificationPass({journal,descriptor:d,prior,intent,input:intent.input},async context=>{await adapter.validate(context);await adapter.verify(intent.current,context);},{readOnly:true});
 }
 need((await registry.phasePreflight('publication',d,all,{journal})).length===0,'publication-continuation-prerequisite-unavailable');
 const publication=journal.deliveryPhase(id,'publication'),adapter=registry.adapter('publication',d,all);need(adapter,'continuation-current-verifier-missing');
 await withVerificationPass({journal,descriptor:d,prior:all,intent:publication,input:publication.input},context=>adapter.validate(context),{readOnly:true});
 let prestagePlan,prestageVerification;
 await withVerificationPass({journal,descriptor:d,prior:all,intent:publication,input:publication.input},async context=>{
  if(planOnly){need(typeof registry.publicationContinuationPlan==='function','publication-continuation-host-plan-unavailable');prestagePlan=ref.parse(await registry.publicationContinuationPlan(context));}
  else{prestagePlan=ref.parse(json(request.admission.plan).prestagePlan);need(typeof registry.verifyPublicationContinuationPlan==='function','publication-continuation-host-plan-verifier-unavailable');prestageVerification=ref.parse(await registry.verifyPublicationContinuationPlan(prestagePlan,context));readEvidenceFile(prestageVerification);}
  readEvidenceFile(prestagePlan);
 },{readOnly:true});
 let browserWindowReadiness,storageWindowReadiness;
 if(request.browserWindowRecovery){
  need(typeof registry.browserWindowRecoveryReadiness==='function'&&typeof registry.prepareBrowserWindowRecovery==='function','browser-window-recovery-readiness-unavailable');
  browserWindowReadiness=ref.parse(await registry.browserWindowRecoveryReadiness({journal,descriptor:d,prior:all,intent:publication,input:publication.input,request}));
  verifyBrowserWindowRecoveryReadiness(browserWindowReadiness,{descriptor:d,journal,request,now:clock(),requireUnmaterialized:true});
  storageWindowReadiness=configuredBrowserWindowRecoveryStorageReadiness({journal,operationId:id,requestRef,request,operator,now:clock()});
 }
 const facts=await registry.continuationFacts(d,{journal}),hostFacts=save(journal,'publication-current-idle-host',facts);
 const at=clock(),after=publicationContinuationSnapshot(journal,id,at,{request,assertAbsent});need(same(before,after),'continuation-original-history-changed');
 verifyPublicationBrowserContinuation(request.browser,{descriptor:d,journal,now:at});
 if(planOnly){const value={format:1,kind:'nova-publication-continuation-plan',operationId:id,request:requestRef,snapshot:after,operator,hostFacts,prestagePlan,
  ...(request.browserWindowRecovery?{browserWindowReadiness,storageWindowReadiness}:{}),plannedAtMs:at,readOnly:true,hostEffects:false,journalWrites:false};return {plan:save(journal,'publication-continuation-plan',value),value};}
 verifyPublicationContinuationAdmission(request,operator,after,at);
 const proof=publicationContinuationGrantSchema.parse({format:1,kind:'nova-expired-publication-continuation',operationId:id,...after,request:requestRef,
  admission:request.admission,prestageVerification,operator,hostFacts,issuedAtMs:at,expiresAtMs:at+request.durationMs,
  ...(request.browserWindowRecovery?{browserWindowReadiness,storageWindowReadiness,browserReservation:{sessionId:request.browser.successorSessionId,startedAtMs:at,deadlineAtMs:at+1800000}}:{}),automaticRenewal:false,originalHistoryPreserved:true});
 const saved=request.browserWindowRecovery?journal.recordBrowserWindowRecovery(id,proof,at,{assertAbsent}):request.successor?journal.recordPublicationStorageSuccessor(id,proof,at,{assertAbsent}):journal.recordOperatorContinuation(id,proof,at,{assertAbsent});
 if(request.browserWindowRecovery){need(typeof registry.prepareBrowserWindowRecovery==='function','browser-window-recovery-preparation-unavailable');await registry.prepareBrowserWindowRecovery({journal,descriptor:d,prior:all,intent:publication,input:publication.input});}
 return saved;
}

/** The grant admits only the already elapsed baseline; later misses retain the
 * maintained review and changed-approach rules without resetting any history. */
export function verifyContinuationTimeline(journal,id,baseline,now){
 const {timeline,eta}=journal.deliveryTimeline(id,now);
 const later=eta.deadlineAssessments.filter(e=>e.deadlineAtMs>baseline),ids=new Set(later.map(e=>e.deadlineId));
 need(!eta.dueReviews.some(e=>ids.has(e.deadlineId)),'continuation-later-overrun-review-required');
 const groups={'private-ci':['private-ci'],'public-ci':['public-ci'],package:['package','sign'],capacity:['capacity'],recovery:['recovery'],publication:['publication'],installation:['installation'],acceptance:['assistant','browser']};
 const passed=names=>names.every(name=>{const p=journal.deliveryPhase(id,name);return p?.state==='completed'&&p.validation?.state!=='failed';});
 for(const step of new Set(later.map(e=>e.step))){
  const missed=later.filter(e=>e.step===step&&e.state==='missed');if(missed.length<2||passed(step==='total'?Object.values(groups).flat():groups[step]))continue;
  const latest=Math.max(...missed.map(e=>e.deadlineAtMs));
  need(timeline.reviews.some((r,index)=>r.action==='change-approach'&&missed.some(e=>e.deadlineId===r.deadlineId)&&r.reviewedAtMs>=latest
   &&!timeline.reviews.slice(0,index).some(old=>old.action==='change-approach'&&old.evidenceSha256===r.evidenceSha256)),'continuation-later-change-approach-required');
 }
}
export function verifyContinuationGrant(journal,id,{now=Date.now(),effect=false,assertAbsent=absentOwner}={}){
 const saved=journal.deliveryOperatorContinuation(id);need(saved,'continuation-grant-required');
 return verifyStoredContinuationGrant(journal,id,saved,{now,effect,assertAbsent});
}
function verifyStoredContinuationGrant(journal,id,saved,{now,effect,assertAbsent=absentOwner}){
 if(saved.proof.kind==='nova-pre-journal-dispatch-reconciliation'){
  const {proof:p}=verifyPreJournalProof(saved.proof,{now}),d=journal.loadDelivery(id);
  need(p.operationId===id&&p.descriptorSha256===d.descriptor_hash&&p.originalAdapterIdentity===d.descriptor.adapterIdentity
   &&p.targetIdentity===d.descriptor.targetIdentity&&p.originalBudgetMs===d.descriptor.observationBudgetMs
   &&p.originalTimelineSha256===sha256(canonical(d.descriptor.timeline))&&saved.recordedAtMs===d.created_at,'prejournal-native-initialization-changed');
  need(!effect||(now>=d.created_at&&now<d.created_at+d.descriptor.observationBudgetMs),'continuation-window-expired');
  if(effect)verifyContinuationTimeline(journal,id,saved.recordedAtMs,now);return saved;
 }
 const publicationGrant=saved.proof.kind==='nova-expired-publication-continuation';
 const p=(publicationGrant?publicationContinuationGrantSchema:prepackageGrantSchema).parse(saved.proof),d=journal.loadDelivery(id);
 need(p.descriptorSha256===d.descriptor_hash&&p.originalAdapterIdentity===d.descriptor.adapterIdentity&&p.targetIdentity===d.descriptor.targetIdentity
  &&p.originalCreatedAtMs===d.created_at&&p.originalBudgetMs===d.descriptor.observationBudgetMs
  &&p.originalTimelineSha256===sha256(canonical(d.descriptor.timeline))&&same(history(journal,id,p.eventHighWaterMark),{eventHighWaterMark:p.eventHighWaterMark,historySha256:p.historySha256}),'continuation-original-descriptor-changed');
 const request=(publicationGrant?publicationContinuationRequestSchema:prepackageRequestSchema).parse(json(p.request));const originalGraph=verifyOriginalContinuationGraph(request,d.descriptor);
 if(publicationGrant){
  const phase=journal.deliveryPhase(id,'publication');need(phase?.key===p.publication.key&&phase.inputSha256===p.publication.inputSha256,'publication-continuation-reservation-changed');
  need(same(p.admission,request.admission)&&same(p.browser,request.browser)&&same(p.publication,request.publication)&&same(p.successor,request.successor)&&same(p.browserWindowRecovery,request.browserWindowRecovery),'publication-continuation-request-changed');
  if(p.successor){const previous=verifyStorageSuccessorPredecessor(journal,id,p.successor,{now,assertAbsent,observeOwners:effect});need(p.issuedAtMs>=previous.proof.expiresAtMs,'publication-storage-successor-predecessor-not-expired');}
  if(p.browserWindowRecovery){
   const previous=verifyBrowserWindowRecoveryPredecessor(journal,id,p.browserWindowRecovery,{now,assertAbsent,observeOwners:effect});
   need(p.issuedAtMs>=previous.proof.expiresAtMs,'browser-window-recovery-predecessor-not-expired');
   verifyBrowserWindowRecoveryReadiness(p.browserWindowReadiness,{descriptor:d.descriptor,journal,request,now:p.issuedAtMs});
   verifyBrowserWindowRecoveryStorageReadiness(p.storageWindowReadiness,{journal,operationId:id,requestRef:p.request,request,operator:p.operator,now:p.issuedAtMs});
  }
  const packageParent=journal.deliveryPhase(id,'package');
  need(same(p.packageSubsteps.map(row=>row.phase),PUBLICATION_PACKAGE_SUBSTEPS),'publication-continuation-package-substeps-changed');
  for(const row of p.packageSubsteps){const original=journal.deliveryPhase(id,row.phase);need(original?.state==='completed'&&original.validation?.state!=='failed'&&original.key===row.key&&original.inputSha256===row.inputSha256&&sha256(canonical(original.current))===row.observationSha256&&original.input.parentKey===row.parentKey&&original.input.parentInputSha256===row.parentInputSha256&&row.parentKey===packageParent.key&&row.parentInputSha256===packageParent.inputSha256,'publication-continuation-package-substeps-changed');}
  const plan=json(p.admission.plan);readEvidenceFile(ref.parse(plan.prestagePlan));readEvidenceFile(p.prestageVerification);
  for(const key of Object.keys(plan.snapshot??{}))need(same(p[key],plan.snapshot[key]),'publication-continuation-plan-binding-changed');
  verifyPublicationContinuationAdmission(request,p.operator,plan.snapshot,p.issuedAtMs);
  verifyPublicationBrowserContinuation(p.browser,{descriptor:d.descriptor,journal,now:p.issuedAtMs});
 }
 need(request.operationId===id&&same(p.operator.sources,request.operatorSources),'continuation-request-authority-changed');
 if(p.kind===correctionGrantKind){
  need(request.kind===correctionRequestKind&&same(p.correction,request.correction)&&same(p.browserWindowPolicy,request.browserWindowPolicy)&&p.expiresAtMs===d.created_at+d.descriptor.observationBudgetMs,
   'dependency-correction-original-authority-changed');
  const original=request.owner.attempts[0];requireCorrectionExit(json(original.stdout),json(original.exit),json(original.childResult),p.issuedAtMs);
 }else if(p.kind===startupCorrectionGrant){
  need(request.kind===startupCorrectionRequest&&same(p.startupFailure,request.startupFailure)&&request.owner.attempts.length===1,'startup-correction-original-authority-changed');
  const original=request.owner.attempts[0],target=json(d.descriptor.target);
  const failure=originalStartupFailure({journal,descriptor:d.descriptor,target,failure:p.startupFailure,status:json(original.stdout),
   exit:json(original.exit),closed:json(original.childResult),createdAt:d.created_at,now:p.issuedAtMs});
  verifyOriginalStartupProgram(originalGraph,request.historical.root,target.full.dependencyTransport.startupQualification,failure,d.descriptor);
  const prior=Object.fromEntries(['route','artifacts'].map(phase=>[phase,journal.deliveryPhase(id,phase).current.output]));
  verifyCorrectedStartupProof({journal,descriptor:d.descriptor,target,prior,reference:p.startupProof,since:failure.receivedAtMilliseconds,now:p.issuedAtMs});
 }else need(p.expiresAtMs-p.issuedAtMs===request.durationMs,'continuation-request-authority-changed');
 for(const row of p.prerequisites){const original=journal.deliveryPhase(id,row.phase);need(original?.state==='completed'&&original.validation?.state!=='failed'&&original.key===row.key&&original.inputSha256===row.inputSha256&&sha256(canonical(original.current))===row.observationSha256,'continuation-original-prerequisite-changed');}
 for(const side of ['private','public']){const ci=verifyOperatorCi(json(p.operator.ci[side]),p.operator.sources[side]);need(ci.run.id===request.ciRuns[side],'continuation-request-ci-changed');}
 const host=json(p.hostFacts),target=json(d.descriptor.target),bytes=Buffer.from(host.stdoutRawBase64??'','base64');
 need(host.hostWrites===false&&bytes.length<=131072&&bytes.toString('base64')===host.stdoutRawBase64&&sha256(bytes)===host.stdoutSha256&&same(JSON.parse(bytes),host.facts),'continuation-original-host-observation-changed');
 const spec=fullFactsSpec(d.descriptor,target.full.host,id,null,host.spec.applicationTransition??host.spec.sameSchemaQualification??null,host.spec.helperHashes);
 need(same(host.spec,spec),'continuation-original-host-spec-changed');verifyFullFacts(host.facts,spec,p.issuedAtMs,true);
 need(!effect||(now>=p.issuedAtMs&&now<p.expiresAtMs),'continuation-window-expired');
 if(effect)verifyContinuationTimeline(journal,id,saved.recordedAtMs,now);return saved;
}

/** Recorded only after the maintained native storage verifier has completed. */
export const publicationStorageAdmissionSchema=z.object({format:z.literal(1),kind:z.literal('nova-publication-continuation-storage-admission'),
 operationId:z.uuid(),grantSha256:hash,dispatch:ref,session:ref,verifiedAtMs:z.number().int().nonnegative()}).strict();
export function verifyPublicationStorageAdmission(journal,id,raw){
 const admission=publicationStorageAdmissionSchema.parse(raw),saved=journal.deliveryOperatorContinuationBySha256(id,admission.grantSha256);
 need(saved?.proof.kind==='nova-expired-publication-continuation'&&admission.operationId===id&&admission.grantSha256===saved.sha256,'publication-storage-admission-grant-changed');
 const p=saved.proof,request=publicationContinuationRequestSchema.parse(json(p.request)),session=json(admission.session),dispatch=json(admission.dispatch),root=resolve(request.owner.request.path,'..');
 need(/^session-observation-[0-9]{4,}\.json$/.test(relative(root,admission.session.path))
  &&/^admission-[0-9]{4,}[\\/]release-dispatch\.json$/.test(relative(join(root,'continuations',saved.sha256),admission.dispatch.path)),'publication-storage-admission-path-changed');
 need(session.format===1&&session.kind==='nova-storage-default-session'&&session.mode==='resume'&&session.operationId===id
  &&same(session.request,request.owner.request)&&same(session.continuationDispatch,admission.dispatch)
  &&session.operatorContinuation?.grantSha256===saved.sha256&&session.operatorContinuation.continuationStarted===false
  &&session.operatorContinuation.newEffectsAllowed===true&&session.operatorContinuation.operatorAdapterIdentity===p.operator.adapterIdentity
  &&session.operatorContinuation.descriptorSha256===p.descriptorSha256,'publication-storage-admission-session-changed');
 need(dispatch.format===1&&dispatch.grantSha256===saved.sha256&&same(dispatch.request,session.request)&&same(dispatch.originalDispatch,session.dispatch)
  &&dispatch.automaticNewOperationPermitted===false&&dispatch.storageResult?.state==='ready'&&dispatch.storageResult.historical!==true,
  'publication-storage-admission-dispatch-changed');
 if(p.successor){
  const maintenance=dispatch.storageMaintenanceResult,marker=p.successor.completedOriginalStorage;
  need(same(session.operatorContinuation.completedOriginalStorage,marker)&&same(dispatch.completedOriginalStorage,marker)
   &&same(dispatch.storageMaintenanceInput,dispatch.storageInput)&&maintenance?.state==='ready'&&maintenance.historical===false&&maintenance.cleanupPerformed===false
   &&dispatch.storageResult.cleanupPerformed===false&&dispatch.storageResult.scope==='fresh-capacity-admission-check-only'&&same(maintenance.result,dispatch.storageResult.result),'publication-storage-successor-readonly-admission-required');
  const observed=json(maintenance.result);
  need(observed.kind==='private-storage-preflight'&&observed.state==='ready'&&observed.cleanupPerformed===false&&observed.assessment?.fits===true&&observed.assessment.releaseAdmission===false,'publication-storage-successor-readonly-proof-required');
 }
 const descriptor=json(session.descriptor),graph=json(session.sourceGraph);
 need(sha256(canonical(descriptor))===p.descriptorSha256&&graph.format===1&&graph.adapterIdentity===p.operator.adapterIdentity,
  'publication-storage-admission-source-changed');
 need(Number.isSafeInteger(session.issuedAtMilliseconds)&&session.issuedAtMilliseconds<=admission.verifiedAtMs+5000
  &&admission.verifiedAtMs-session.issuedAtMilliseconds<=300000&&Number.isSafeInteger(dispatch.startedAtMilliseconds)
  &&dispatch.startedAtMilliseconds<=admission.verifiedAtMs&&Number.isSafeInteger(dispatch.storageResult.observationExpiresAtMilliseconds)
  &&admission.verifiedAtMs<=dispatch.storageResult.observationExpiresAtMilliseconds&&admission.verifiedAtMs>=p.issuedAtMs
  &&admission.verifiedAtMs<p.expiresAtMs,'publication-storage-admission-expired');
 return admission;
}

export async function verifyContinuationStorageAuthority({journal,operationId,entry=null,now=Date.now(),effect=false}){
 const saved=verifyContinuationGrant(journal,operationId,{now,effect}),p=saved.proof,A=await import('./release-delivery-adapters.mjs');
 const current=A.deliveryAdapterSourceFiles().map(name=>({name,sha256:sha256(readFileSync(new URL(name,import.meta.url)))}));
 need(A.deliveryAdapterIdentity()===p.operator.adapterIdentity&&same(current,p.operator.sourceFiles),'continuation-current-operator-graph-changed');
 const roots=[join(p.operator.sources.private.root,'edition3'),p.operator.sources.public.root],actual=join(roots[0],'scripts/release-deliver.mjs');
 need(entry===null||resolve(entry)===resolve(actual),'continuation-current-operator-entry-changed');
 need([join(roots[0],'scripts/release-deliver.mjs'),join(roots[1],'scripts/release-deliver.mjs')].map(p=>resolve(p)).includes(fileURLToPath(new URL('release-deliver.mjs',import.meta.url))),'continuation-current-module-root-changed');
 const initialized=p.kind==='nova-pre-journal-dispatch-reconciliation',d=initialized?journal.loadDelivery(operationId):null;
 const browserRecovery=p.browserWindowRecovery?verifyBrowserWindowRecoveryPredecessor(journal,operationId,p.browserWindowRecovery,{now}):null;
 const expires=initialized?d.created_at+d.descriptor.observationBudgetMs:p.expiresAtMs,issued=initialized?d.created_at:p.issuedAtMs;
 return {grantSha256:saved.sha256,operatorAdapterIdentity:p.operator.adapterIdentity,operatorEntry:reference(actual),operatorRoots:roots,operatorSources:p.operator.sources,
  expiresAtMs:expires,originalAdapterIdentity:p.originalAdapterIdentity,descriptorSha256:p.descriptorSha256,...(p.successor?{completedOriginalStorage:p.successor.completedOriginalStorage}:browserRecovery?{completedOriginalStorage:browserRecovery.proof.successor.completedOriginalStorage,browserWindowRecovery:p.browserWindowRecovery,browserReservation:p.browserReservation,historicalStorageAdmission:journal.deliveryPublicationContinuationAdmission(operationId)}:{}),
  newEffectsAllowed:now>=issued&&now<expires,continuationStarted:p.kind==='nova-expired-publication-continuation'
   ?Boolean(journal.deliveryPublicationContinuationAdmission(operationId)):initialized||Boolean(journal.deliveryPhase(operationId,'package'))};
}
export async function assertDeliveryOperator(journal,id,registry,{clock=Date.now,effect=false}={}){
 const d=journal.loadDelivery(id).descriptor,current=await registry.identity(d);
 if(!journal.deliveryOperatorContinuation(id)){need(current===d.adapterIdentity,'delivery-adapter-changed');return null;}
 const authority=await verifyContinuationStorageAuthority({journal,operationId:id,now:clock(),effect});need(current===authority.operatorAdapterIdentity,'delivery-continuation-adapter-changed');return authority;
}
export function operatorObservationDeadline(journal,id){
 const grant=journal.deliveryOperatorContinuation(id),d=journal.loadDelivery(id);
 return grant&&grant.proof.kind!=='nova-pre-journal-dispatch-reconciliation'?grant.proof.expiresAtMs:d.created_at+d.descriptor.observationBudgetMs;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [mode,directory,id,entry]=process.argv.slice(2);need(mode==='storage-authority'&&entry,'continuation-exact-readonly-command-required');
 const {ReleaseJournal}=await import('./release-coordinate.mjs');const journal=new ReleaseJournal(directory,{create:false,readOnly:true});
 try{process.stdout.write(JSON.stringify(await verifyContinuationStorageAuthority({journal,operationId:id,entry}))+'\n');}finally{journal.close();}
}
