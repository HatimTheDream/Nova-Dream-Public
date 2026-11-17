/** One finite post-install browser observation. Never resumes delivery producers. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { qualifyOperatorSources, verifyOperatorCi, verifyOriginalOwnerAbsent } from './release-delivery-continuation.mjs';
import { verifyPostinstallBrowserRecovery } from './release-delivery-postinstall-browser.mjs';
const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=z.string().regex(/^[a-f0-9]{64}$/),ref=z.object({path:z.string().refine(isAbsolute),sha256:hash}).strict();
const json=r=>JSON.parse(readEvidenceFile(ref.parse(r),{maximum:8*1024**2}));
const pair=s=>z.object({private:s,public:s}).strict();
const source=z.object({root:z.string().refine(isAbsolute),repository:z.string(),branch:z.literal('operator/browser-postinstall-recovery-r1'),commit:z.string().regex(/^[a-f0-9]{40}$/)}).strict();
export const POSTINSTALL_SCOPE='current-installed-browser-crash-recovery';
export const POSTINSTALL_GAPS=Object.freeze(['old-document-retained','original-old-client-fence','actual-transition-observation']);
export const postinstallCoverageSchema=z.object({acceptanceScope:z.literal(POSTINSTALL_SCOPE),originalTransitionCoverage:z.literal('unverified'),transitionCoverageGaps:z.tuple([z.literal(POSTINSTALL_GAPS[0]),z.literal(POSTINSTALL_GAPS[1]),z.literal(POSTINSTALL_GAPS[2])])}).strict();
export const postinstallRequestSchema=z.object({format:z.literal(1),kind:z.literal('nova-postinstall-browser-recovery-request'),operationId:z.uuid(),
 historical:z.object({root:z.string().refine(isAbsolute),manifest:ref}).strict(),operatorSources:pair(source),ciRuns:pair(z.number().int().positive()),
 sessionId:z.uuid(),durationMs:z.number().int().min(60000).max(1800000),capacity:z.object({diskReserveBytes:z.number().int().min(2147483648),workingAllowanceBytes:z.number().int().min(536870912)}).strict(),
 owner:z.object({session:ref,launcher:ref,intent:ref,exit:ref,childResult:ref,stdout:ref}).strict(),
 failure:z.object({failed:ref,closed:ref,memory:ref}).strict(),admission:z.object({plan:ref,review:ref,intent:ref}).strict().optional()}).strict();
const binding=z.object({descriptorSha256:hash,targetIdentity:hash,previousGrantSha256:hash,browserKey:z.uuid(),browserInputSha256:hash,
 browserObservationSha256:hash,prerequisitesSha256:hash,coordinatorSha256:hash,eventHighWaterMark:z.number().int().nonnegative(),historySha256:hash}).strict();
const operatorSchema=z.object({adapterIdentity:hash,sources:pair(source),sourceFiles:z.array(z.object({name:z.string(),sha256:hash}).strict()).min(1).max(512),ci:pair(ref)}).strict();
export const postinstallAuthoritySchema=z.object({format:z.literal(1),kind:z.literal('nova-postinstall-browser-observation-authority'),operationId:z.uuid(),
 sessionId:z.uuid(),startedAtMs:z.number().int().nonnegative(),deadlineAtMs:z.number().int().positive(),request:ref,plan:ref,browserReadiness:ref,
 browserKey:z.uuid(),browserInputSha256:hash,snapshot:binding,operator:operatorSchema,
 acceptanceScope:z.literal(POSTINSTALL_SCOPE),originalTransitionCoverage:z.literal('unverified'),transitionCoverageGaps:postinstallCoverageSchema.shape.transitionCoverageGaps,
 automaticRenewal:z.literal(false),installationPermitted:z.literal(false),assistantDispatchPermitted:z.literal(false)}).strict().refine(v=>v.deadlineAtMs>v.startedAtMs&&v.deadlineAtMs-v.startedAtMs<=1800000,'finite-postinstall-browser-window-required');
export function postinstallCoverage(output){
 if(output?.acceptanceScope===undefined){need(output?.kind!=='nova-postinstall-browser-recovery-acceptance','postinstall-coverage-required');return {};}
 return postinstallCoverageSchema.parse({acceptanceScope:output.acceptanceScope,originalTransitionCoverage:output.originalTransitionCoverage,transitionCoverageGaps:output.transitionCoverageGaps});
}
export function verifyScopedBrowserAcceptance(output,input){postinstallCoverage(output);verifyPostinstallBrowserRecovery(output,input);}
function save(journal,name,value){
 const dir=join(journal.directory,'delivery-postinstall-evidence');mkdirSync(dir,{recursive:true,mode:0o700});
 const bytes=Buffer.from(canonical(value)+'\n'),path=join(dir,name+'-'+sha256(bytes)+'.json');
 if(existsSync(path))need(readFileSync(path).equals(bytes),'postinstall-existing-evidence-changed');else{const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
 return {path,sha256:sha256(bytes)};
}
function history(journal,id,through=Number.MAX_SAFE_INTEGER){const rows=journal.db.prepare('SELECT id,at_ms,kind,payload_hash FROM delivery_events WHERE operation_id=? AND id<=? ORDER BY id').all(id,through);return {eventHighWaterMark:rows.at(-1)?.id??0,historySha256:sha256(canonical(rows))};}
export function postinstallSnapshot(journal,id,raw,{now=Date.now(),assertAbsent=verifyOriginalOwnerAbsent,allowAccepted=false}={}){
 const request=postinstallRequestSchema.parse(raw),retained=journal.loadDelivery(id),d=retained.descriptor;
 need(request.operationId===id&&['active','completed'].includes(retained.state)&&!journal.deliveryDisposition(id),'postinstall-original-operation-required');readEvidenceFile(d.target);
 const browser=journal.deliveryPhase(id,'browser'),grant=journal.deliveryOperatorContinuation(id);
 need(browser&&browser.validation?.state!=='failed'&&(browser.state==='gap'&&browser.current?.reason==='browser-dom-or-transport-check-failed'||allowAccepted&&browser.state==='completed'),'postinstall-demonstrated-browser-gap-required');
 need(grant?.proof.browserWindowRecovery&&grant.proof.browserReservation,'postinstall-original-fixed-browser-required');
 const input=browser.input,original=json(input.original),prepared=json(input.prepared),old=grant.proof.browserReservation;
 need(input.operationId===id&&original.binding.operationId===id&&original.startedAtMs===old.startedAtMs&&original.deadlineAtMs===old.deadlineAtMs
  &&old.sessionId!==request.sessionId&&now>=original.deadlineAtMs,'postinstall-original-window-not-closed');
 need(prepared.bindingSha256===sha256(canonical(original.binding)),'postinstall-original-preparation-changed');
 for(const [name,file]of Object.entries({failed:'failed.json',closed:'closed.json',memory:'memory-browser-closed.json'}))need(resolve(request.failure[name].path)===resolve(dirname(input.original.path),file),'postinstall-original-failure-path-changed');
 const failed=json(request.failure.failed),closed=json(request.failure.closed),memory=json(request.failure.memory);
 need(failed.operationId===id&&failed.reason==='browser-dom-or-transport-check-failed'&&closed.operationId===id&&closed.browserClosed===true&&closed.tunnelClosed===true
  &&memory.operationId===id&&/^oom_kill [1-9][0-9]*$/m.test(memory.events??'')&&failed.atMs<=memory.atMs&&memory.atMs<=closed.atMs,'postinstall-closed-oom-evidence-required');
 const names=['private-source','public-source','private-ci','public-ci','artifacts','route','package','sign','capacity','recovery','publication','installation','assistant'];
 const phases=names.map(n=>journal.deliveryPhase(id,n));need(phases.every(p=>p?.state==='completed'&&p.validation?.state!=='failed'&&p.current?.output),'postinstall-prerequisites-not-completed');
 const installation=phases.at(-2),assistant=phases.at(-1),coordinator=journal.intent(id);
 need(coordinator?.state==='completed'&&coordinator.externalJobId===installation.externalId&&input.installed?.operationId===id
  &&same(input.assistant,assistant.current.output)&&assistant.current.receipt&&same(json(assistant.current.receipt),input.assistant)
  &&input.assistant.savedReplyAccepted===true&&input.assistant.browserUiVerified===false,'postinstall-installation-or-saved-reply-changed');
 const session=json(request.owner.session),launcher=json(request.owner.launcher),intent=json(request.owner.intent),exit=json(request.owner.exit),child=json(request.owner.childResult),stdout=json(request.owner.stdout);
 need(session.kind==='nova-storage-default-session'&&session.operationId===id&&session.mode==='resume'&&same(session.observationIntent,request.owner.intent)
  &&session.operatorContinuation?.grantSha256===grant.sha256&&same(session.operatorContinuation.browserReservation,old)&&same(json(session.descriptor),d)&&session.adapterIdentity===grant.proof.operator.adapterIdentity&&same(session.argv,intent.argv)&&same(session.request,intent.request)&&intent.sameReleaseOperation===true
  &&same(session.argv,[json(d.target).artifactTools.node.path,session.operatorContinuation.operatorEntry.path,'resume',journal.directory,id]),'postinstall-original-owner-session-changed');
 need(exit.returnCode===2&&child.returnCode===2&&child.originalChildClosed===true&&child.automaticNewOperationPermitted===false&&child.logBoundExceeded===false
  &&Number.isSafeInteger(exit.finishedAtMilliseconds)&&exit.finishedAtMilliseconds>=session.issuedAtMilliseconds&&exit.finishedAtMilliseconds<=now
  &&stdout.operationId===id&&stdout.complete===false&&stdout.phases?.some(p=>p.phase==='browser'&&p.key===browser.key&&p.state==='gap'&&p.reason==='browser-dom-or-transport-check-failed'),'postinstall-original-owner-closure-required');
 need(launcher.operationId===id&&launcher.kind==='verified-waiting-release-launcher'&&launcher.mode==='resume'&&same(launcher.entry,session.operatorContinuation.operatorEntry)
  &&same(launcher.config,session.config)&&same(launcher.node,json(d.target).artifactTools.node)&&same(launcher.start,json(session.request).releaseInput)&&same(launcher.budget,json(session.request).storageBudget)
  &&launcher.worker.parentPid===launcher.owner.pid,'postinstall-original-owner-launcher-changed');
 for(const owner of [launcher.owner,launcher.worker])assertAbsent(owner);
 const dir=dirname(request.owner.intent.path),root=dirname(dirname(dir));need(resolve(request.owner.session.path)===resolve(root,'session-'+pathBasename(dir)+'.json'),'postinstall-original-session-location-changed');
 need(resolve(dirname(request.owner.launcher.path))===resolve(root)&&readdirSync(join(root,'observations')).filter(n=>/^observation-[0-9]{4,}$/.test(n)).sort().at(-1)===pathBasename(dir),'postinstall-unclassified-owner-attempt');
 for(const [key,name]of Object.entries({exit:'exit.json',childResult:'default-child-result.json',stdout:'stdout.json'}))need(resolve(request.owner[key].path)===resolve(dir,name),'postinstall-original-observation-path-changed');
 return {descriptorSha256:retained.descriptor_hash,targetIdentity:d.targetIdentity,previousGrantSha256:grant.sha256,browserKey:browser.key,browserInputSha256:browser.inputSha256,
  browserObservationSha256:sha256(canonical(browser.current)),prerequisitesSha256:sha256(canonical(phases)),coordinatorSha256:sha256(canonical(coordinator)),...history(journal,id)};
}
function pathBasename(p){return p.replaceAll('\\','/').split('/').at(-1);}
export function verifyPostinstallAdmission(request,plan,snapshot,operator,now){
 const {admission,...core}=request;need(admission,'postinstall-separate-execution-intent-required');
 need(plan.kind==='nova-postinstall-browser-recovery-plan'&&same(plan.request,core)&&same(plan.snapshot,snapshot)&&same(plan.operator,operator)
  &&plan.readOnly===true&&plan.hostEffects===false&&plan.journalWrites===false&&plan.plannedAtMs<=now&&now-plan.plannedAtMs<=900000,'postinstall-plan-binding-changed');
 const review=json(admission.review),intent=json(admission.intent);
 need(review.kind==='nova-postinstall-browser-plan-review'&&review.status==='passed'&&review.independentReview===true&&same(review.plan,admission.plan)
  &&review.operationId===request.operationId&&review.operatorAdapterIdentity===operator.adapterIdentity,'postinstall-independent-plan-review-required');
 need(intent.kind==='nova-postinstall-browser-execution-intent'&&intent.operationId===request.operationId&&same(intent.plan,admission.plan)&&same(intent.review,admission.review)
  &&intent.sessionId===request.sessionId&&intent.browserOnly===true&&intent.automaticReplayPermitted===false&&Number.isSafeInteger(intent.issuedAtMs)&&intent.issuedAtMs>=plan.plannedAtMs
  &&intent.issuedAtMs<=now&&Number.isSafeInteger(intent.expiresAtMs)&&now<intent.expiresAtMs&&intent.expiresAtMs-intent.issuedAtMs<=900000,'postinstall-finite-execution-intent-required');
}
export function verifyPostinstallAuthority(journal,id,{now=Date.now(),effect=false}={}){
 const saved=journal.deliveryPostinstallRecovery(id);need(saved,'postinstall-browser-authority-required');const p=postinstallAuthoritySchema.parse(saved.proof),request=postinstallRequestSchema.parse(json(p.request));
 need(p.operationId===id&&request.operationId===id&&same(p.operator.sources,request.operatorSources)&&p.sessionId===request.sessionId&&p.deadlineAtMs-p.startedAtMs===request.durationMs,'postinstall-authority-binding-changed');
 const original=history(journal,id,p.snapshot.eventHighWaterMark);need(same(original,{eventHighWaterMark:p.snapshot.eventHighWaterMark,historySha256:p.snapshot.historySha256}),'postinstall-original-history-changed');
 const browser=journal.deliveryPhase(id,'browser');need(browser?.key===p.browserKey&&browser.inputSha256===p.browserInputSha256,'postinstall-original-browser-changed');
 const phases=['private-source','public-source','private-ci','public-ci','artifacts','route','package','sign','capacity','recovery','publication','installation','assistant'].map(n=>journal.deliveryPhase(id,n));
 need(sha256(canonical(phases))===p.snapshot.prerequisitesSha256&&sha256(canonical(journal.intent(id)))===p.snapshot.coordinatorSha256,'postinstall-completed-history-changed');
 for(const phase of phases)if(phase.current.receipt)readEvidenceFile(phase.current.receipt);readEvidenceFile(journal.loadDelivery(id).descriptor.target);
 for(const r of [browser.input.original,browser.input.prepared,...Object.values(request.failure),...Object.values(request.owner)])readEvidenceFile(r);
 for(const side of ['private','public']){const ci=verifyOperatorCi(json(p.operator.ci[side]),p.operator.sources[side]);need(ci.run.id===request.ciRuns[side],'postinstall-exact-ci-changed');}
 const rows=p.operator.sourceFiles;need(sha256(canonical(rows))===p.operator.adapterIdentity,'postinstall-operator-graph-changed');
 for(const row of rows){readEvidenceFile({path:fileURLToPath(new URL(row.name,import.meta.url)),sha256:row.sha256},{maximum:8*1024**2});for(const side of ['private','public'])readEvidenceFile({path:resolve(p.operator.sources[side].root,side==='private'?'edition3/scripts':'scripts',row.name),sha256:row.sha256},{maximum:8*1024**2});}
 need(!effect||now>=p.startedAtMs&&now<p.deadlineAtMs,'postinstall-browser-authority-expired');return saved;
}
export async function reconcilePostinstallBrowser(journal,id,requestRef,{planOnly=false,clock=Date.now,assertAbsent,command,qualify=qualifyOperatorSources,browserApi}={}){
 const request=postinstallRequestSchema.parse(json(requestRef));need(request.operationId===id,'postinstall-request-operation-changed');
 browserApi??=await import('./release-delivery-postinstall-browser.mjs');
 let saved=journal.deliveryPostinstallRecovery(id);
 if(saved){need(!planOnly&&same(saved.proof.request,requestRef),'postinstall-second-or-conflicting-recovery');verifyPostinstallAuthority(journal,id,{now:clock()});}
 else{
  const before=postinstallSnapshot(journal,id,request,{now:clock(),assertAbsent}),descriptor=journal.loadDelivery(id).descriptor;
  const A=await import('./release-delivery-adapters.mjs');command??=A.fixedCommand;
  const operator=await qualify(request,descriptor,{command});operator.ci={};
  if(planOnly){
   const target=json(descriptor.target);
   for(const side of ['private','public']){const source=operator.sources[side],runId=request.ciRuns[side],r=save(journal,'operator-ci-request-'+side,{format:1,source,runId,tools:target.sourceTools});
    const value=JSON.parse(await command(target.sourceTools.python.path,[fileURLToPath(new URL('release-operator-ci.py',import.meta.url)),'--request',r.path,'--request-sha256',r.sha256],{maximum:8*1024**2,timeoutMs:180000}));need(value.run.id===runId,'postinstall-ci-run-changed');operator.ci[side]=save(journal,'operator-ci-'+side,verifyOperatorCi(value,source));}
  }else{operator.ci=json(request.admission?.plan).operator?.ci;for(const side of ['private','public'])need(verifyOperatorCi(json(operator.ci[side]),operator.sources[side]).run.id===request.ciRuns[side],'postinstall-ci-run-changed');}
  const context={journal,descriptor,request,browserInput:journal.deliveryPhase(id,'browser').input};
  if(planOnly){need(!request.admission,'postinstall-plan-must-not-contain-intent');const browserReadiness=await browserApi.planPostinstallBrowserRecovery(context);ref.parse(browserReadiness);
   const snapshot=postinstallSnapshot(journal,id,request,{now:clock(),assertAbsent});need(same(before,snapshot),'postinstall-original-state-changed-during-plan');
   const value={format:1,kind:'nova-postinstall-browser-recovery-plan',operationId:id,request,snapshot,operator,browserReadiness,plannedAtMs:clock(),readOnly:true,hostEffects:false,journalWrites:false};return {plan:save(journal,'plan',value),value};}
  const plan=json(request.admission?.plan);verifyPostinstallAdmission(request,plan,before,operator,clock());
  const browserReadiness=await browserApi.verifyPostinstallBrowserRecoveryPlan(plan.browserReadiness,context);ref.parse(browserReadiness);
  const at=clock(),after=postinstallSnapshot(journal,id,request,{now:at,assertAbsent});need(same(before,after),'postinstall-original-state-changed-before-reservation');
  verifyPostinstallAdmission(request,plan,after,operator,at);
  const proof=postinstallAuthoritySchema.parse({format:1,kind:'nova-postinstall-browser-observation-authority',operationId:id,sessionId:request.sessionId,startedAtMs:at,deadlineAtMs:at+request.durationMs,
   request:requestRef,plan:request.admission.plan,browserReadiness,browserKey:after.browserKey,browserInputSha256:after.browserInputSha256,snapshot:after,operator,
   acceptanceScope:POSTINSTALL_SCOPE,originalTransitionCoverage:'unverified',transitionCoverageGaps:[...POSTINSTALL_GAPS],automaticRenewal:false,installationPermitted:false,assistantDispatchPermitted:false});
  saved=journal.recordPostinstallRecovery(id,proof,at,{assertAbsent});
 }
 const authority=saved.proof,authorityRef=save(journal,'authority',authority),browser=journal.deliveryPhase(id,'browser');
 if(browser.state!=='completed'){
  const result=await browserApi.observePostinstallBrowserRecovery({journal,descriptor:journal.loadDelivery(id).descriptor,request,browserInput:browser.input,authority,authorityRef,
   beforeNewEffect:()=>verifyPostinstallAuthority(journal,id,{now:clock(),effect:true})});
  if(result.state==='completed'){verifyScopedBrowserAcceptance(result.output,browser.input);need(same(result.output.authority,authorityRef)&&result.receipt&&same(json(result.receipt),result.output),'postinstall-result-authority-or-receipt-changed');}
  journal.recordDeliveryObservation(id,'browser',{...result,key:browser.key},clock());
 }
 const status=journal.deliveryStatus(id,clock());if(status.complete&&journal.loadDelivery(id).state!=='completed')journal.completeDelivery(id,clock());
 const {exportSuccessorProfile}=await import('./release-delivery-initialize.mjs');
 let successor;try{successor=await exportSuccessorProfile(journal,id);}catch(error){successor={gap:/^[a-z][a-z0-9-]{1,99}$/.test(error.message)?error.message:'successor-profile-evidence-unavailable'};}
 return {...journal.deliveryStatus(id,clock()),postinstallAuthority:authorityRef,successor};
}
