/** Successor observation for one already returned, automatically rehearsed workspace. */
import {readdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {normalizedDeliveryDescriptor} from './release-delivery-journal.mjs';
import {readEvidenceFile,readReleaseInputFile,sha256} from './release-plan.mjs';
import {fullHostIdentity,fullHostImplementation,buildFullHostProgram} from './release-delivery-full-host.mjs';
import {buildReturnedCompletionProgram,returnedRosterSchema,verifyReturnedCompletion} from './release-same-schema-returned-proof.mjs';

export const completionRequestKind='nova-same-schema-returned-rehearsal-request';
export const completionGrantKind='nova-same-schema-returned-rehearsal-grant';
export const completionEventKind='recovery-completion-reader-granted';
export const completionBranch='operator/same-schema-returned-rehearsal';
export const completionPrerequisites=['private-source','public-source','private-ci','public-ci','artifacts','route','package','sign','capacity'];
const children=['dependency-stage','dependency-plan','dependency-intent','dependency-execute','dependency-retrieval','pair','bundle'].map(x=>'package/'+x);
const need=(v,msg)=>{if(!v)throw Error(msg);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const json=r=>JSON.parse(readEvidenceFile(r,{maximum:2*1024*1024}));
const sum=v=>sha256(canonical(v));
const hostDigest=v=>sha256(canonical(v).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))+'\n');
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export function completionSchemas({ref,source,continuationRequestSchema,continuationGrantSchema}){
 const sources=z.object({private:source.extend({branch:z.literal(completionBranch)}),public:source.extend({branch:z.literal(completionBranch)})}).strict();
 const owner=continuationRequestSchema.shape.owner;
 const request=continuationRequestSchema.omit({durationMs:true}).extend({kind:z.literal(completionRequestKind),operatorSources:sources,
  owner:owner.extend({attempts:owner.shape.attempts.length(2),resumeSession:ref}),diagnostic:ref,remainingBudget:ref,remainingBudgetReview:ref,roster:returnedRosterSchema});
 const phase=z.object({phase:z.string(),key:z.uuid(),inputSha256:digest,observationSha256:digest}).strict();
 const recovery=z.object({key:z.uuid(),inputSha256:digest,observationSha256:digest,observationId:z.number().int().positive(),dispatch:ref,launch:ref}).strict();
 const {hostFacts,...fields}=continuationGrantSchema.shape;
 const grant=z.object({...fields,kind:z.literal(completionGrantKind),
  prerequisites:z.array(phase).length(completionPrerequisites.length),packageSubsteps:z.array(phase).length(children.length),recovery,
  diagnostic:ref,storageAdmission:z.object({session:ref,dispatch:ref,remainingBudget:ref}).strict(),completionResponse:ref,normalizedCompletion:ref,
  operator:continuationGrantSchema.shape.operator.extend({sources})}).strict().refine(p=>p.issuedAtMs>=p.originalCreatedAtMs
   &&p.issuedAtMs<p.expiresAtMs&&p.expiresAtMs===p.originalCreatedAtMs+p.originalBudgetMs,'completion-original-window-required');
 return {request,grant};
}

export function completionValues(journal,id){
 const recovery=journal.deliveryPhase(id,'recovery'),capacity=journal.deliveryPhase(id,'capacity');
 need(recovery&&capacity?.state==='completed'&&recovery.input.implementationSha256===fullHostImplementation()
  &&capacity.input.implementationSha256===fullHostImplementation()&&same(recovery.input.capacity,capacity.current.output)
  &&same(recovery.input.signed,journal.deliveryPhase(id,'sign').current.output),'completion-original-host-implementation-changed');
 const c=recovery.input.capacity;
 return {...c.values,planUnit:c.values.unit,planLogSha256:c.plan.logSha256,executionId:fullHostIdentity(recovery.key,'execute'),
  executionUnit:'nova-current-rehearsal-'+fullHostIdentity(recovery.key,'execute')};
}

function stored(journal,key,name){
 const path=join(journal.directory,'delivery-evidence',key+'-'+name);
 return {path,sha256:sha256(readReleaseInputFile(path))};
}
function checkOwner(journal,id,owner,now,assertAbsent) {
 const root=dirname(owner.request.path),original=json(owner.request),d=journal.loadDelivery(id).descriptor;
 const attempts=['observation-0001','observation-0002'];
 need(original.operationId===id && owner.request.path===join(root,'request.json') && same(readdirSync(join(root,'observations')).filter(n=>/^observation-\d+$/.test(n)).sort(),attempts),'completion-classified-original-observers-required');
 const pids=[],sessions=[];
 for(const [index,a] of owner.attempts.entries()){
  const dir=join(root,'observations',attempts[index]),mode=index?'resume':'start';
  for(const [role,name] of Object.entries({exit:'exit.json',intent:'intent.json',childResult:'default-child-result.json',stdout:'stdout.json'}))
   need(a[role].path===join(dir,name),'completion-original-observer-path-changed');
  const launcher=json(a.launcher),intent=json(a.intent),exit=json(a.exit),closed=json(a.childResult);
  const sessionPath=join(root,'session-'+attempts[index]+'.json'),s=JSON.parse(readReleaseInputFile(sessionPath));
  const entry=original.deliveryEntry,init=json(s.initialization);
  const expected=[original.node.path,entry.path,mode,journal.directory,index?id:init.descriptor.reference.path];
  need(s.kind==='nova-storage-default-session'&&s.mode===mode&&s.operationId===id&&!s.operatorContinuation&&!s.continuationDispatch
   &&same(s.observationIntent,a.intent)&&same(s.request,owner.request)&&same(s.argv,expected)&&same(intent,{request:owner.request,argv:expected,sameReleaseOperation:true})
   &&s.adapterIdentity===d.adapterIdentity&&same(s.descriptor,init.descriptor.reference)&&same(normalizedDeliveryDescriptor(json(s.descriptor),s.descriptor.path),d)
   &&s.dispatch.path===join(root,'release-dispatch.json')&&same(json(s.dispatch).request,owner.request)
   &&json(s.dispatch).storageMaintenanceResult?.protectedRolesVerified===true,'completion-original-storage-resume-changed');
  need(dirname(a.launcher.path)===root&&a.launcher.path.startsWith(join(root,'waiting-launcher-'))&&launcher.kind==='verified-waiting-release-launcher'
   &&launcher.mode===mode&&launcher.operationId===id&&launcher.dispatchAuthority===false&&same(launcher.entry,entry)&&same(launcher.config,s.config)
   &&same(launcher.node,original.node)&&same(launcher.start,original.releaseInput)&&same(launcher.budget,original.storageBudget)
   &&launcher.worker.parentPid===launcher.owner.pid&&resolve(launcher.cwd)===resolve(d.sources.private.root,'edition3'),'completion-original-observer-owner-changed');
  for(const r of [launcher.node,launcher.entry,launcher.runner,launcher.config,s.sourceGraph])readEvidenceFile(r,{maximum:128*1024**2});
  need(closed.originalChildClosed===true&&closed.logBoundExceeded===false&&closed.automaticNewOperationPermitted===false&&closed.returnCode===exit.returnCode
   &&Number.isSafeInteger(exit.finishedAtMilliseconds)&&s.issuedAtMilliseconds<=exit.finishedAtMilliseconds&&exit.finishedAtMilliseconds<=now,'completion-original-observer-closure-required');
  if(index===0)need(exit.returnCode===1&&same(json(a.stdout),{kind:'nova-release-delivery-error',reason:'delivery-input-or-producer-rejected',automaticReplayPermitted:false}),'completion-first-observer-refusal-changed');
  else need(exit.returnCode===4294967295&&readEvidenceFile(a.stdout,{maximum:1}).length===0,'completion-original-readonly-observer-not-closed');
  for(const pid of [launcher.worker,launcher.owner]){
   need(Number(pid.created.match(/^\/Date\((\d+)\)\/$/)?.[1])<=s.issuedAtMilliseconds,'completion-original-owner-time-changed');assertAbsent(pid);pids.push(pid.pid);
  }
  sessions.push({session:s,closedAt:exit.finishedAtMilliseconds});
 }
 const last=sessions[1];need(sessions[0].closedAt<=last.session.issuedAtMilliseconds&&same(sessions[0].session.dispatch,last.session.dispatch)
  &&owner.resumeSession.path===join(root,'session-observation-0002.json')&&same(json(owner.resumeSession),last.session),'completion-original-observer-sequence-changed');
 return {pids,closedAt:last.closedAt,storageAdmission:{session:owner.resumeSession,dispatch:last.session.dispatch}};
}
function checkTerminalFailure(journal,id,phase,key,diagnostic){
 need(phase.key===key&&phase.state==='uncertain'&&phase.externalId===id&&phase.reason==='full-original-completion-unavailable'
  &&phase.receipt===null&&same(phase.output,{diagnostic}),'completion-original-reserved-refusal-required');
 need(diagnostic.path===join(journal.directory,'delivery-evidence',key+'-full-host-failure-'+diagnostic.sha256+'.json'),'completion-original-diagnostic-location');
 const v=json(diagnostic);
 need(v.format===1&&v.kind==='private-full-host-failure'&&v.operationId===id&&v.key===key&&v.program==='collect-completion-template.py'
  &&v.exitCode===2&&v.uncertain===false&&v.stderr===''&&same(JSON.parse(v.stdout),{state:'uncertain',reason:'full-host-original-result-unavailable',
   privateDiagnostic:{type:'ValueError',message:'Returned startup roster is incomplete.'}}),'completion-original-collector-refusal-changed');
}
const phaseRef=p=>({phase:p.phase,key:p.key,inputSha256:p.inputSha256,observationSha256:sum(p.current)});
export function completionSnapshot(journal,id,now,request,previous,assertAbsent,history){
 const retained=journal.loadDelivery(id),d=retained.descriptor,end=retained.created_at+d.observationBudgetMs;
 need(!previous&&request.operationId===id&&retained.state==='active'&&!journal.deliveryDisposition(id)&&Number.isSafeInteger(now)
  &&now>=retained.created_at&&now<end,'completion-active-original-window-required');
 const declared=journal.db.prepare('SELECT phase FROM delivery_phases WHERE operation_id=? ORDER BY phase').all(id).map(r=>r.phase);
 need(same(declared,[...completionPrerequisites,...children,'recovery'].sort())&&!journal.intent(id)
  &&!journal.db.prepare('SELECT id FROM operations WHERE id=?').get(id)
  &&!journal.db.prepare("SELECT id FROM delivery_events WHERE operation_id=? AND kind='rejected-producer-observation'").get(id),'completion-original-phase-boundary-changed');
 const phases=completionPrerequisites.map(n=>journal.deliveryPhase(id,n)),packageRow=journal.deliveryPhase(id,'package');
 const substeps=children.map(n=>journal.deliveryPhase(id,n));
 need([...phases,...substeps].every(p=>p.state==='completed'&&p.validation?.state!=='failed')
  &&substeps.every(p=>p.input.parentKey===packageRow.key&&p.input.parentInputSha256===packageRow.inputSha256),'completion-original-prerequisites-changed');
 const r=journal.deliveryPhase(id,'recovery'),v=completionValues(journal,id);
 need(r.validation?.state!=='failed'&&r.state==='uncertain'&&v.candidateId===d.operation.priorCandidateId&&v.workspaceEpoch===d.operation.workspaceEpoch,
  'completion-original-recovery-changed');
 const owner=checkOwner(journal,id,request.owner,now,assertAbsent);
 const row=journal.db.prepare("SELECT id,at_ms,observation_json,observation_hash FROM delivery_observations WHERE operation_id=? AND phase='recovery' ORDER BY id DESC LIMIT 1").get(id);
 need(row&&row.at_ms<=owner.closedAt&&sha256(row.observation_json)===row.observation_hash
  &&same({...JSON.parse(row.observation_json),observedAtMs:row.at_ms},r.current),'completion-original-observer-boundary-changed');
 checkTerminalFailure(journal,id,r.current,r.key,request.diagnostic);
 const dispatch=stored(journal,r.key,'full-rehearsal-dispatch.json'),launch=stored(journal,r.key,'full-rehearsal-launch.json');
 verifyDispatch(v,dispatch,launch);
 return {descriptorSha256:retained.descriptor_hash,originalAdapterIdentity:d.adapterIdentity,targetIdentity:d.targetIdentity,
  originalCreatedAtMs:retained.created_at,originalBudgetMs:d.observationBudgetMs,originalTimelineSha256:sum(d.timeline),
  ...history(journal,id),snapshotSha256:sum([...phases,...substeps,r]),prerequisites:phases.map(phaseRef),packageSubsteps:substeps.map(phaseRef),ownerPids:owner.pids,
  recovery:{key:r.key,inputSha256:r.inputSha256,observationSha256:row.observation_hash,observationId:row.id,dispatch,launch},storageAdmission:{...owner.storageAdmission,remainingBudget:request.remainingBudget}};
}
export function verifyReturnedReservation(context){
 const {journal,descriptor,intent}=context,id=descriptor.operation.id,p=journal.deliveryOperatorContinuation(id)?.proof;
 need(p?.kind===completionGrantKind&&intent.key===p.recovery.key&&intent.inputSha256===p.recovery.inputSha256,'completion-original-reservation-changed');
 const dispatch=stored(journal,intent.key,'full-rehearsal-dispatch.json'),launch=stored(journal,intent.key,'full-rehearsal-launch.json');
 need(same(dispatch,p.recovery.dispatch)&&same(launch,p.recovery.launch),'completion-original-rehearsal-references-changed');
 verifyDispatch(completionValues(journal,id),dispatch,launch);
}
function verifyDispatch(v,dispatch,launch){
 const sent=json(dispatch),started=json(launch);
 need(sent.executionId===v.executionId&&sent.unit===v.executionUnit&&sent.valuesSha256===hostDigest(v)
  &&sent.readinessSha256===hostDigest(sent.readiness)&&sent.readiness.leaseId===v.leaseId
  &&started.format===1&&started.launched===true&&started.actualRehearsalCompletionStillRequired===true
  &&started.executionId===v.executionId&&started.unit===v.executionUnit&&started.leaseId===v.leaseId,'completion-original-rehearsal-dispatch-changed');
}
export function verifyCompletionHistory(journal,id,p,req,previous,history){
 const retained=journal.loadDelivery(id),d=retained.descriptor,r=journal.deliveryPhase(id,'recovery');
 need(!previous&&req.operationId===id&&p.operationId===id&&p.expiresAtMs===retained.created_at+d.observationBudgetMs
  &&p.descriptorSha256===retained.descriptor_hash&&p.originalAdapterIdentity===d.adapterIdentity
  &&p.targetIdentity===d.targetIdentity&&p.originalCreatedAtMs===retained.created_at&&p.originalBudgetMs===d.observationBudgetMs
  &&p.originalTimelineSha256===sum(d.timeline)&&same(history(journal,id,p.eventHighWaterMark),{eventHighWaterMark:p.eventHighWaterMark,historySha256:p.historySha256})
  &&same(p.operator.sources,req.operatorSources)&&same(p.diagnostic,req.diagnostic)&&r.key===p.recovery.key&&r.inputSha256===p.recovery.inputSha256
  &&same(p.storageAdmission.remainingBudget,req.remainingBudget)&&same(p.storageAdmission.session,req.owner.resumeSession)&&same(p.storageAdmission.dispatch,json(req.owner.resumeSession).dispatch),
  'completion-original-history-changed');
 const expected=[...completionPrerequisites,...children],bound=[...p.prerequisites,...p.packageSubsteps];
 need(same(bound.map(x=>x.phase),expected)&&bound.every(x=>{const old=journal.deliveryPhase(id,x.phase);
  return old?.state==='completed'&&old.validation?.state!=='failed'&&same(phaseRef(old),x);}), 'completion-original-phase-proof-changed');
 const row=journal.db.prepare("SELECT observation_json,observation_hash FROM delivery_observations WHERE operation_id=? AND phase='recovery' AND id=?").get(id,p.recovery.observationId);
 need(row&&row.observation_hash===p.recovery.observationSha256&&sha256(row.observation_json)===row.observation_hash,'completion-original-refusal-record-changed');
 checkTerminalFailure(journal,id,JSON.parse(row.observation_json),r.key,p.diagnostic);
 need(same(stored(journal,r.key,'full-rehearsal-dispatch.json'),p.recovery.dispatch)&&same(stored(journal,r.key,'full-rehearsal-launch.json'),p.recovery.launch),
  'completion-original-rehearsal-references-changed');
 verifyDispatch(completionValues(journal,id),p.recovery.dispatch,p.recovery.launch);
}

export async function collectReturnedResponse({run,transport,transportRef,descriptor,values,roster,clock}){
 const program=buildReturnedCompletionProgram(values,roster),started=clock(),raw=await run(transport,program,{captureDiagnostics:true});
 const received=clock(),bytes=Buffer.from(raw.stdout??'');
 need(!raw.uncertain&&raw.exitCode===0&&!raw.stderr&&!raw.diagnosticsTruncated&&bytes.length>0&&bytes.length<=131072,'completion-exact-original-read-unavailable');
 const value=JSON.parse(bytes);verifyReturnedCompletion(value,values,roster);
 need(Number.isSafeInteger(value.observedAtMilliseconds)&&value.observedAtMilliseconds>=started-30000&&value.observedAtMilliseconds<=received+30000,
  'completion-current-reader-time-changed');
 return {value,response:{format:1,kind:'original-returned-completion-read',operationId:descriptor.operation.id,transport:transportRef,programSha256:sha256(program),
  beforeMs:started,receivedMs:received,stdoutSha256:sha256(bytes),stdoutRawBase64:bytes.toString('base64')}};
}
export function readCompletion(journal,id,p,request){
 const v=completionValues(journal,id),n=p.normalizedCompletion,r=p.completionResponse;
 for(const [label,ref] of [['returned-completion',n],['returned-completion-response',r]])need(ref.path===join(journal.directory,'delivery-continuation-evidence',label+'-'+ref.sha256+'.json'),'completion-original-proof-location-changed');
 const saved=json(r),target=json(journal.loadDelivery(id).descriptor.target),raw=Buffer.from(saved.stdoutRawBase64,'base64'),value=json(n);
 need(saved.kind==='original-returned-completion-read'&&saved.format===1&&saved.operationId===id&&same(saved.transport,target.transport)
  &&saved.programSha256===sha256(buildReturnedCompletionProgram(v,request.roster))&&raw.length<=131072&&raw.toString('base64')===saved.stdoutRawBase64
  &&sha256(raw)===saved.stdoutSha256&&same(JSON.parse(raw),value)&&Number.isSafeInteger(saved.beforeMs)&&Number.isSafeInteger(saved.receivedMs)
  &&saved.beforeMs>=json(request.owner.attempts[1].exit).finishedAtMilliseconds&&saved.beforeMs<=saved.receivedMs&&saved.receivedMs<=p.issuedAtMs
  &&value.observedAtMilliseconds>=saved.beforeMs-30000&&value.observedAtMilliseconds<=saved.receivedMs+30000,'completion-original-proof-changed');
 verifyReturnedCompletion(value,v,request.roster);return {value,raw};
}

/** Receipts from the original launch fix all data paths. During recovery only
 * its read-only status and the bound completion reader may cross this transport. */
export function completedRehearsalTransport({journal,descriptor,run,transportRef,clock,recoveryOnly=false}){
 const id=descriptor.operation.id,p=journal?.deliveryOperatorContinuation?.(id)?.proof;
 if(p?.kind!==completionGrantKind)return run;
 const req=json(p.request),values=completionValues(journal,id),original=buildFullHostProgram('collect-completion-template.py',{values});
 const status=buildFullHostProgram('observe-execute-template.py',{values});
 // Once stored, the journal emits a canonical key order for the same values.
 const recorded=journal.deliveryPhase(id,'recovery')?.current?.output?.values;
 if(recorded)need(same(recorded,values),'completion-original-saved-values-changed');
 const storedProgram=recorded&&buildFullHostProgram('collect-completion-template.py',{values:recorded});
 return async (transport,program,options)=>{
  if(program!==original&&program!==storedProgram){
   need(!recoveryOnly||program===status,'completion-new-rehearsal-effect-denied');
   return run(transport,program,options);
  }
  const {value,raw}=readCompletion(journal,id,p,req);
  const ageMs=clock()-value.observedAtMilliseconds;
  if(ageMs>=-5000&&ageMs<120000)
   return {exitCode:0,stdout:raw.toString('utf8'),stderr:'',diagnosticsTruncated:false};
  const current=await collectReturnedResponse({run,transport,transportRef,descriptor,values,roster:req.roster,clock});
  need(current.value.completedProof.proofSha256===value.completedProof.proofSha256&&current.value.rehearsalEvidenceSha256===value.rehearsalEvidenceSha256
   &&current.value.completedProof.finalPhaseSha256===value.completedProof.finalPhaseSha256,'completion-original-reobservation-changed');
  return {exitCode:0,stdout:Buffer.from(current.response.stdoutRawBase64,'base64').toString('utf8'),stderr:'',diagnosticsTruncated:false};
 };
}

/** Only the already consumed rehearsal snapshot allocation can be replaced.
 * Every other allocation and the device reserve still admit the actual installer. */
export function remainingRecoveryBudget(marker,owner,completion,reviewRef,launch){
 const request=json(owner),original=json(request.storageBudget),rest=json(marker.remainingBudget);
 const index=original.allocations.findIndex(row=>row.id==='recovery-lifecycle-peak');
 need(index>=0&&original.allocations.length===10&&rest.allocations?.length===10&&rest.format===original.format
  &&rest.reserveBytes===original.reserveBytes&&original.allocations.every((row,i)=>i===index||same(row,rest.allocations[i])),
  'returned-budget-original-roles-changed');
 const prior=original.allocations[index],next=rest.allocations[index];
 const before=json(prior.measurement),now=json(next.measurement),native=json(now.snapshotAllocation),terminal=json(now.snapshotTerminal);
 const reviewed=json(now.originalSizingReview),a=before.calculation,b=now.calculation;
 need(Object.keys(rest).sort().join(',')===Object.keys(original).sort().join(',')&&typeof rest.basis==='string'&&rest.basis.length>0
  &&same({...next,bytes:prior.bytes,measurement:prior.measurement},prior)&&same(now.originalBudget,request.storageBudget)
  &&now.allocationId===prior.id&&now.class===prior.class&&now.path===prior.path&&prior.path==='/var/lib/nova-update-recovery'
  &&same(now.originalMeasurement,prior.measurement)&&now.operationId===request.operationId&&now.reclaimCreditBytes===0
  &&now.kind==='measured-storage-allocation'&&typeof now.basis==='string'&&now.basis.length>0&&now.scope==='same-operation-returned-rehearsal-recovery-allocation'&&now.format===1&&before.kind==='measured-storage-allocation'
  &&reviewed.status==='passed'&&reviewed.independentReview===true&&reviewed.allTenRowsAndRoleReceiptsRecomputed===true
  &&reviewed.budget.sha256===request.storageBudget.sha256&&resolve(reviewed.budget.path)===resolve(request.storageBudget.path),
  'returned-budget-previous-measurement-changed');
 need([a.S,a.I,a.M].every(x=>Number.isSafeInteger(x)&&x>0)&&a.formula==='2*S+I+2*M'&&a.installationPeakBytes===2*a.S+a.I+2*a.M
  &&before.bytes===prior.bytes&&prior.bytes===a.installationPeakBytes&&b.formula==='S+I+M'&&b.S===a.S&&b.I===a.I&&b.M===a.M
  &&b.materializedBytesChargedInOriginalBudget===a.S+a.M&&b.originalBytes===prior.bytes&&b.remainingBytes===a.S+a.I+a.M
  &&next.bytes===now.bytes&&next.bytes===b.remainingBytes,'returned-budget-apportioned-bytes-changed');
 const originalProof=completion.completedProof,detail=JSON.parse(Buffer.from(completion.evidenceRawBase64,'base64'));
 need(terminal.code===0&&terminal.readOnly===true&&terminal.responseSha256===now.snapshotAllocation.sha256
  &&native.kind==='original-returned-rehearsal-allocation'&&native.readOnly===true&&native.reclaimCreditBytes===0
  &&native.leaseId===originalProof.proof.leaseId&&native.candidateId===originalProof.proof.candidateId&&native.workspaceEpoch===originalProof.proof.workspaceEpoch
  &&native.manifest.sha256===originalProof.snapshotManifestSha256&&native.acceptance.sha256===originalProof.proofSha256
  &&native.detail.sha256===completion.rehearsalEvidenceSha256&&same(native.returnedRootIdentity,detail.returnedRootIdentity)
  &&native.retainedSnapshot==='/var/lib/nova-update-recovery/operator-rehearsal-'+native.leaseId
  &&native.retainedWorkspace.device===native.geometry.recovery.device&&Number.isSafeInteger(native.retainedWorkspace.inode)&&native.retainedWorkspace.inode>0
  &&native.unit.ActiveState==='active'&&native.unit.SubState==='exited'&&native.unit.Result==='success'&&native.unit.ExecMainStatus==='0'
  &&native.unit.MainPID==='0'&&native.unit.ControlPID==='0','returned-budget-original-snapshot-unverified');
 const separated=json(now.reviewedAllocation);
 const {scope,reviewedAllocation,basis,...metric}=now;
 need(same({...metric,kind:scope},separated),'returned-budget-stock-wrapper-changed');
 const adapterReview=json(reviewRef),stockPlan=json(adapterReview.plan),approval=json(stockPlan.independentMathematicalReview);
 const mathematicalBudget=json(approval.budget);
 need(adapterReview.passed===true&&adapterReview.independentReview===true&&same(adapterReview.independentMathematicalReview,stockPlan.independentMathematicalReview)
  &&same(adapterReview.budget,marker.remainingBudget)&&same(adapterReview.originalBudget,request.storageBudget)&&same(stockPlan.budget,marker.remainingBudget)&&stockPlan.freshAdmissionRequired===true
  &&same(stockPlan.originalBudget,request.storageBudget)&&same(stockPlan.currentSnapshot,now.snapshotAllocation)
  &&stockPlan.frozenConsumerResultAtOriginalMeasurement?.fits===true&&same(mathematicalBudget.allocations[index].measurement,reviewedAllocation)
  &&same({...rest,allocations:rest.allocations.map((row,i)=>i===index?{...row,measurement:reviewedAllocation}:row)},mathematicalBudget),
  'returned-budget-reviewed-stock-consumer-required');
 need(approval.passed===true&&approval.independentReview===true&&approval.stageEffects===false&&approval.freshAdmissionRequired===true
  &&approval.originalSnapshotAlreadyMaterialized===true&&same(approval.originalBudget,request.storageBudget)
  &&same(approval.currentSnapshot,now.snapshotAllocation)&&same(approval.realLaunch,launch)
  &&same(approval.futureComponents,{snapshot:a.S,independentRestore:a.I,metadata:a.M}),'returned-budget-independent-lineage-required');
 return rest;
}
