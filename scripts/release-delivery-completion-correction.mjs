/** Successor observation for one already returned, automatically rehearsed workspace. */
import {readdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {readEvidenceFile,readReleaseInputFile,sha256} from './release-plan.mjs';
import {fullHostIdentity,fullHostImplementation,buildFullHostProgram} from './release-delivery-full-host.mjs';
import {buildReturnedCompletionProgram,returnedRosterSchema,verifyReturnedCompletion} from './release-returned-completion-proof.mjs';

export const completionRequestKind='nova-recovery-completion-request';
export const completionGrantKind='nova-recovery-completion-continuation';
export const completionEventKind='recovery-completion-reader-granted';
export const completionBranch='operator/recovery-completion-reader';
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
  owner:owner.extend({attempts:owner.shape.attempts.length(2),resumeSession:ref}),predecessorGrantSha256:digest,diagnostic:ref,publicationLedger:ref,roster:returnedRosterSchema});
 const phase=z.object({phase:z.string(),key:z.uuid(),inputSha256:digest,observationSha256:digest}).strict();
 const recovery=z.object({key:z.uuid(),inputSha256:digest,observationSha256:digest,observationId:z.number().int().positive(),dispatch:ref,launch:ref}).strict();
 const {hostFacts,...fields}=continuationGrantSchema.shape;
 const grant=z.object({...fields,kind:z.literal(completionGrantKind),predecessorGrantSha256:digest,
  prerequisites:z.array(phase).length(completionPrerequisites.length),packageSubsteps:z.array(phase).length(children.length),recovery,
  diagnostic:ref,publicationLedger:ref,storageAdmission:z.object({session:ref,dispatch:ref}).strict(),completionResponse:ref,normalizedCompletion:ref,
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
function checkOwner(journal,id,owner,previous,now,assertAbsent){
 const old=json(previous.proof.request),root=dirname(old.owner.request.path),obs=join(root,'observations','observation-0002');
 need(same(owner.request,old.owner.request)&&same(owner.attempts[0],old.owner.attempts[0])
  &&same(readdirSync(join(root,'observations')).filter(x=>/^observation-\d+$/.test(x)).sort(),['observation-0001','observation-0002']),
 'completion-classified-original-observers-required');
 const second=owner.attempts[1];for(const [k,name] of Object.entries({exit:'exit.json',intent:'intent.json',childResult:'default-child-result.json',stdout:'stdout.json'}))
  need(second[k].path===join(obs,name),'completion-original-observer-path-changed');
 const launch=json(second.launcher),intent=json(second.intent),exit=json(second.exit),closed=json(second.childResult),session=json(owner.resumeSession),original=json(owner.request);
 const entry=join(previous.proof.operator.sources.private.root,'edition3','scripts','release-deliver.mjs');
 need(owner.resumeSession.path===join(root,'session-observation-0002.json')&&session.kind==='nova-storage-default-session'&&session.operationId===id
  &&session.mode==='resume'&&same(session.request,owner.request)&&same(session.observationIntent,second.intent)
  &&same(session.argv,[original.node.path,entry,'resume',journal.directory,id])
  &&same(intent.argv,session.argv)&&same(intent.request,owner.request)&&intent.sameReleaseOperation===true
  &&session.operatorContinuation?.grantSha256===previous.sha256&&session.operatorContinuation.operatorAdapterIdentity===previous.proof.operator.adapterIdentity
  &&session.operatorContinuation.descriptorSha256===previous.proof.descriptorSha256&&session.operatorContinuation.newEffectsAllowed===true,
  'completion-original-storage-resume-changed');
 const dispatch=json(session.continuationDispatch);
 need(session.continuationDispatch.path===join(root,'continuations',previous.sha256,'admission-0001','release-dispatch.json')
  &&dispatch.grantSha256===previous.sha256&&same(dispatch.request,owner.request)&&same(dispatch.originalDispatch,session.dispatch)
  &&dispatch.automaticNewOperationPermitted===false&&dispatch.storageResult.state==='ready','completion-original-storage-admission-changed');
 need(second.launcher.path.startsWith(join(root,'waiting-launcher-'))&&dirname(second.launcher.path)===root
  &&launch.kind==='verified-waiting-release-launcher'&&launch.mode==='resume'&&launch.operationId===id&&launch.dispatchAuthority===false
  &&resolve(launch.cwd)===resolve(previous.proof.operator.sources.private.root,'edition3')&&same(launch.node,original.node)
  &&same(launch.entry,session.operatorContinuation.operatorEntry)&&same(launch.config,session.config)
  &&same(launch.start,original.releaseInput)&&same(launch.budget,original.storageBudget)&&launch.worker.parentPid===launch.owner.pid,
  'completion-original-observer-owner-changed');
 for(const r of [launch.node,launch.entry,launch.runner,launch.config,session.sourceGraph])readEvidenceFile(r,{maximum:128*1024**2});
 need(closed.originalChildClosed===true&&closed.returnCode===4294967295&&closed.logBoundExceeded===false&&closed.automaticNewOperationPermitted===false
  &&exit.returnCode===closed.returnCode&&Number.isSafeInteger(exit.finishedAtMilliseconds)&&exit.finishedAtMilliseconds<=now
  &&readEvidenceFile(second.stdout,{maximum:1}).length===0,'completion-original-observer-closure-required');
 for(const p of [launch.worker,launch.owner]){
  need(Number(p.created.match(/^\/Date\((\d+)\)\/$/)?.[1])<=exit.finishedAtMilliseconds,'completion-original-observer-time-changed');assertAbsent(p);
 }
 return {closedAt:exit.finishedAtMilliseconds,pids:[launch.owner.pid,launch.worker.pid],storageAdmission:{session:owner.resumeSession,dispatch:session.continuationDispatch}};
}

function checkTerminalFailure(journal,id,phase,key,diagnostic){
 need(phase.key===key&&phase.state==='uncertain'&&phase.externalId===id&&phase.reason==='full-original-completion-unavailable'
  &&phase.receipt===null&&same(phase.output,{diagnostic}),'completion-original-reserved-refusal-required');
 need(diagnostic.path===join(journal.directory,'delivery-evidence',key+'-full-host-failure-'+diagnostic.sha256+'.json'),'completion-original-diagnostic-location');
 const v=json(diagnostic);
 need(v.format===1&&v.kind==='private-full-host-failure'&&v.operationId===id&&v.key===key&&v.program==='collect-completion-template.py'
  &&v.exitCode===2&&v.uncertain===false&&v.stderr===''&&same(JSON.parse(v.stdout),{state:'uncertain',reason:'full-host-original-result-unavailable',
   privateDiagnostic:{type:'RuntimeError',message:'Bounded startup receipt required.'}}),'completion-original-collector-refusal-changed');
}
const phaseRef=p=>({phase:p.phase,key:p.key,inputSha256:p.inputSha256,observationSha256:sum(p.current)});
export function completionSnapshot(journal,id,now,request,previous,assertAbsent,history){
 const retained=journal.loadDelivery(id),d=retained.descriptor,base=previous?.proof;
 need(base?.kind==='nova-prepackage-startup-proof-correction'&&previous.sha256===request.predecessorGrantSha256
  &&request.operationId===id&&same(request.historical,json(base.request).historical)&&retained.state==='active'&&!journal.deliveryDisposition(id)
  &&Number.isSafeInteger(now)&&now>=previous.recordedAtMs&&now<base.expiresAtMs,'completion-active-predecessor-window-required');
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
 const owner=checkOwner(journal,id,request.owner,previous,now,assertAbsent);
 const row=journal.db.prepare("SELECT id,at_ms,observation_json,observation_hash FROM delivery_observations WHERE operation_id=? AND phase='recovery' ORDER BY id DESC LIMIT 1").get(id);
 need(row&&row.at_ms<=owner.closedAt&&sha256(row.observation_json)===row.observation_hash
  &&same({...JSON.parse(row.observation_json),observedAtMs:row.at_ms},r.current),'completion-original-observer-boundary-changed');
 checkTerminalFailure(journal,id,r.current,r.key,request.diagnostic);
 const dispatch=stored(journal,r.key,'full-rehearsal-dispatch.json'),launch=stored(journal,r.key,'full-rehearsal-launch.json');
 verifyDispatch(v,dispatch,launch);
 return {descriptorSha256:retained.descriptor_hash,originalAdapterIdentity:d.adapterIdentity,targetIdentity:d.targetIdentity,
  originalCreatedAtMs:retained.created_at,originalBudgetMs:d.observationBudgetMs,originalTimelineSha256:sum(d.timeline),
  ...history(journal,id),snapshotSha256:sum([...phases,...substeps,r]),prerequisites:phases.map(phaseRef),packageSubsteps:substeps.map(phaseRef),ownerPids:owner.pids,
  recovery:{key:r.key,inputSha256:r.inputSha256,observationSha256:row.observation_hash,observationId:row.id,dispatch,launch},storageAdmission:owner.storageAdmission};
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
 need(previous?.sha256===p.predecessorGrantSha256&&previous.proof.kind==='nova-prepackage-startup-proof-correction'
  &&req.operationId===id&&p.operationId===id&&req.predecessorGrantSha256===previous.sha256&&same(req.historical,json(previous.proof.request).historical)
  &&p.expiresAtMs===previous.proof.expiresAtMs&&p.descriptorSha256===retained.descriptor_hash&&p.originalAdapterIdentity===d.adapterIdentity
  &&p.targetIdentity===d.targetIdentity&&p.originalCreatedAtMs===retained.created_at&&p.originalBudgetMs===d.observationBudgetMs
  &&p.originalTimelineSha256===sum(d.timeline)&&same(history(journal,id,p.eventHighWaterMark),{eventHighWaterMark:p.eventHighWaterMark,historySha256:p.historySha256})
  &&same(p.operator.sources,req.operatorSources)&&same(p.diagnostic,req.diagnostic)&&same(p.publicationLedger,req.publicationLedger)&&r.key===p.recovery.key&&r.inputSha256===p.recovery.inputSha256
  &&same(p.storageAdmission.session,req.owner.resumeSession)&&same(p.storageAdmission.dispatch,json(req.owner.resumeSession).continuationDispatch),
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
