import type {DatabaseSync} from 'node:sqlite';
import type {SemanticReceipt,SemanticRow} from '../../packages/domain/news-feed-semantic-journal.js';
import {feedLocalPrefix,protocolIntent} from '../../packages/domain/news-feed-successor-journal.js';
import {feedWorkerPrefix} from '../../packages/domain/news-feed-adaptive-worker.js';
import {adaptiveLearningPrefix} from '../../packages/domain/news-feed-adaptive-graph.js';
import type {CompletionReader} from './feed-completion-reader.js';
import type {CompletionRowDescriptor} from './feed-completion-reader.js';
import type {HistoryStoredObject,HistoryObjectKind} from '../../packages/domain/news-feed-history-storage.js';
import type {HistorySequenceLimits} from './feed-history-write-sequence.js';
import type {SelectedWorkerOriginal,SelectedLocalOriginal,SelectedOriginalFact} from '../../packages/domain/news-feed-selected-originals.js';
import type {MutationPlanBudget} from './feed-history-projected-inventory.js';
import {DraftCapacityContext} from './feed-draft-capacity.js';
import {isSelectedOriginalReader} from './feed-selected-original-proof.js';
import {ProducerWork,producerKey,producerSlotBytes,producerReceiptBytes,producerReceiptSchema,transitionId,remainingTransitions,
 type ProducerState,type ProducerJob,type ProducerTransition,type ProducerTransitionKind,type ProducerAdmission,type ProducerRelease} from './feed-automatic-producer-state.js';

export type ProducerStored={state:ProducerState;ciphertextBytes:number;raw:{revision:number;payload:Uint8Array}};
export type ProducerOverride=Readonly<{state:ProducerState;ciphertextBytes:number}>;
export type ProducerFacts=Readonly<{state?:ProducerState;ciphertextBytes:number;remainingGrowth:Readonly<{entries:number;ciphertextBytes:number}>;
 maximumSingleTransitionOverlap:Readonly<{entries:number;ciphertextBytes:number}>}>;
export type ProducerCurrentFacts=ProducerFacts&Readonly<{currentJob:ProducerCurrentJob}>;
export type ProducerSqlPorts={db:DatabaseSync;openText:(aad:string,payload:Uint8Array)=>string;sequence:HistorySequenceLimits};
type ProducerOriginal=SelectedWorkerOriginal|SelectedLocalOriginal;

type ProducerCurrentJobIdentity=Readonly<{scope:'pending'|'checkpoint';jobId:string;jobKind:ProducerJob['kind'];phase:ProducerJob['phase']}>;
export type ProducerCurrentApplication=Readonly<{requestId:string;epoch:string;operationId:string;expectedLearningRevision:number;terminalSha256:string;captureSha256:string;sourceProofSha256:string}>;
/** Copied historical evidence only. No field conveys current eligibility or an
 * effect permit; released checkpoints never publish an application proposal. */
export type ProducerCurrentJob=Readonly<{kind:'none'}>|ProducerCurrentJobIdentity&(
 Readonly<{kind:'unprepared'}>|Readonly<{kind:'original-absent'}>|
 Readonly<{kind:'local-disposition';originalId:string;disposition:SelectedLocalOriginal['disposition'];receiptSha256:string}>|
 Readonly<{kind:'active-worker'|'terminal-worker';originalId:string;workerState:string;captureKind:string;receiptSha256:string;
  terminalSha256?:string;sourceProofSha256?:string;application?:ProducerCurrentApplication}>);


/** Lexical retention of the exact deeply frozen reader members. Construct only
 * inside the existing actual/projected callback. Each access still checks its
 * owner/token and budget; fact methods keep original reference provenance.
 * No cache is shared between actual and projected readers or phase budgets. */
export function producerMemoReader(source:CompletionReader,budget:MutationPlanBudget):CompletionReader{
 source.assertBudget(budget);const work:ProducerWork=new ProducerWork(budget);work.slots(25,1536);
 const registered=isSelectedOriginalReader(source,budget);
 const rows=new Map<string,SemanticRow|undefined>(),receipts=new Map<string,SemanticReceipt|undefined>(),objects=new Map<string,HistoryStoredObject|undefined>(),archives=new Map<CompletionRowDescriptor,SemanticRow>();
 // Exact maintained sources have immutable lexical budget identity. Unknown
 // structural ports retain their original assertion on every access.
 const guard=()=>budget.checked(()=>{if(!registered)source.assertBudget(budget);source.guard();});
 const cached=<K,V>(map:Map<K,V>,key:K,kind:'row'|'receipt'|'object'|'archive',objectKind?:HistoryObjectKind,id?:string):V=>budget.checked(()=>{
  guard();budget.query();if(map.has(key)){const value=map.get(key)!;guard();return value;}
  // Entry and retained key/reference pair precede both lookup work and set.
  work.slots(2,96);const value=(kind==='row'?source.activeRow(key as string):kind==='receipt'?source.receipt(key as string):kind==='object'?source.object(objectKind!,id!):source.archivedRow(key as CompletionRowDescriptor)) as V;guard();if(value!==undefined)work.need(Object.isFrozen(value),'Producer memo member must be owned immutable data');map.set(key,value);return value;
 });
 const objectKey=(kind:HistoryObjectKind,id:string)=>{guard();work.need(typeof kind==='string'&&kind.length<=32&&typeof id==='string'&&id.length<=8192,'Producer memo key bound');work.slots(1,(kind.length+id.length)*6+64);return kind+':'+id;};
 return Object.freeze({schema:source.schema,originalToken:source.originalToken,guard,assertBudget:(candidate:MutationPlanBudget)=>{guard();if(candidate!==budget)budget.fail(Error('Producer memo budget changed'));},
  current:()=>{guard();return source.current();},rowKeys:()=>{guard();return source.rowKeys();},objectKeys:(kind:HistoryObjectKind)=>{guard();return source.objectKeys(kind);},
  activeRow:(id:string)=>{guard();work.slots(1,32);return cached(rows,id,'row');},receipt:(id:string)=>{guard();work.slots(1,32);return cached(receipts,id,'receipt');},
  object:(kind:HistoryObjectKind,id:string)=>{guard();work.slots(1,32);return cached(objects,objectKey(kind,id),'object',kind,id);},
  archivedRow:(descriptor:CompletionRowDescriptor)=>{guard();work.slots(1,32);return cached(archives,descriptor,'archive');},
  rowFact:(row:SemanticRow)=>{guard();return source.rowFact(row);},receiptFact:(receipt:SemanticReceipt)=>{guard();return source.receiptFact(receipt);},objectFact:(object:HistoryStoredObject)=>{guard();return source.objectFact(object);},
  ...(source.selectedState&&source.selectedOriginal?{
   selectedState:(state:object|undefined)=>{guard();source.selectedState!(state);},
   selectedOriginal:(state:object|undefined,slot:0|1)=>{guard();return source.selectedOriginal!(state,slot);},
  }:{}),});
}

/** Reuses the maintained bounded raw reader. The slot's fixed key is the only
 * additional SQL payload. Every other original is supplied by the verified,
 * synchronous CompletionReader under the same N1 budget. */
export function readProducerSlot(p:ProducerSqlPorts,budget:MutationPlanBudget,guard:()=>void):ProducerStored|undefined{
 const context:DraftCapacityContext=new DraftCapacityContext({db:p.db,budget,limits:p.sequence,recordBytes:producerSlotBytes,guard,openText:p.openText,
  seal:()=>{throw Error('Producer proof cannot encrypt');}});
 try{
  // SQLite TEXT equality alone misses a byte-identical BLOB key. This fixed
  // scalar census precedes any payload read and refuses shadow identities.
  const identity=context.scalar("SELECT count(*) AS count,coalesce(sum(CASE WHEN typeof(id)='text' THEN 0 ELSE 1 END),0) AS bad FROM service_records WHERE id=? OR id=CAST(? AS BLOB)",[producerKey,producerKey]);
  context.need(Number.isSafeInteger(identity.count)&&identity.count>=0&&identity.count<=1&&identity.bad===0,'Producer slot key type or identity changed');
  const row=context.row('service_records',producerKey);context.need(Boolean(row)===(identity.count===1),'Producer slot census changed');if(!row)return;
  const work:ProducerWork=new ProducerWork(budget),state=work.state(row.value);work.need(state.revision===row.raw.revision,'Producer outer revision changed');
  work.slots(2,128);return {state,ciphertextBytes:row.raw.payload.byteLength,raw:{revision:row.raw.revision,payload:row.raw.payload}};
 }finally{context.close();}
}

export class ProducerProof{
 readonly work:ProducerWork;
 private transitionJob?:ProducerJob;
 constructor(private reader:CompletionReader,readonly budget:MutationPlanBudget,private readonly state:ProducerState|undefined){
  this.work=new ProducerWork(budget);reader.assertBudget(budget);reader.guard();
  this.work.need(reader.selectedState&&reader.selectedOriginal,'Producer selected proof is required');reader.selectedState!(state);
 }
 private selected(j:ProducerJob,slot:0|1):SelectedOriginalFact{
  const w:ProducerWork=this.work,root=this.state?.pending??this.state?.checkpoint?.job;
  w.need(j===root||j===this.transitionJob,'Producer job is not owned by this proof');
  const fact=this.reader.selectedOriginal!(this.state,slot);
  w.need(fact&&fact.requestId===(slot===0?j.jobId:j.applicationId)&&fact.expectedKind===(slot===0?'start':'apply-learning'),'Producer selected original identity changed');return fact!;
 }
 original(j:ProducerJob):ProducerOriginal|undefined{
  const w:ProducerWork=this.work;w.need(j.command,'Producer original needs saved command');
  const selected=this.selected(j,0);if(!selected.receiptPresent)return;
  w.slots(2,64);const request={kind:'start',command:j.command};
  const original=selected.original;
  w.need(selected.requestIndex==='admitted'&&selected.requestKind==='start'&&original&&(original.kind==='worker'||original.kind==='local-disposition'),'Producer original disposition unsupported');
  const value=original as ProducerOriginal;
  w.need(value.requestId===j.jobId&&value.deviceId===j.deviceId&&value.protocolDigest===w.hash(protocolIntent(request)),'Producer original receipt owner or intent');
  w.need(value.format===3&&(value.kind==='worker'?value.workerId:value.originalId)===j.jobId&&value.epoch===j.epoch&&
   value.rowId===(value.kind==='worker'?feedWorkerPrefix:feedLocalPrefix)+j.jobId,'Producer original row owner');
  w.need(value.requestSha256===w.hash(request),'Producer original command changed');
  // Complete upstream verification already ran the maintained worker/local
  // validators, original receipt, refusal observation and Close correspondence.
  return value;
 }
 admission(j:ProducerJob):ProducerAdmission|undefined{return this.admissionFrom(j,this.original(j));}
 private admissionFrom(j:ProducerJob,original:ProducerOriginal|undefined):ProducerAdmission|undefined{if(!original)return;this.work.slots(1,128);
  return {kind:original.kind,requestId:j.jobId,receiptSha256:original.receiptSha256};
 }
 release(j:ProducerJob):ProducerRelease|undefined{
  return this.releaseFrom(j,this.original(j));
 }
 private releaseFrom(j:ProducerJob,original:ProducerOriginal|undefined):ProducerRelease|undefined{
  const w:ProducerWork=this.work;if(!original)return;
  const receiptSha=original.receiptSha256;w.slots(1,256);
  if(original.kind==='local-disposition'){
   if(j.phase==='applying')return;
   return {kind:'local-disposition',disposition:original.disposition,originalId:j.jobId,requestSha256:original.localRequestSha256,recordSha256:original.localRecordSha256,receiptSha256:receiptSha};
  }
  if(!original.terminalSha256)return;
  const terminalSha256=original.terminalSha256;
  if(j.phase!=='applying'){
   // A completed learning result remains held until its exact application is
   // proved. Changed current eligibility cannot discard that known result.
   if(j.kind==='learn'&&original.state==='completed')return;
   return {kind:'worker-terminal',originalId:j.jobId,originalReceiptSha256:receiptSha,terminalSha256};
  }
  w.need(j.kind==='learn'&&j.application,'Producer application missing');
  const selected=this.selected(j,1);if(!selected.receiptPresent)return;
  w.slots(2,128);const request={kind:'apply-learning',command:j.application};
  const applied=selected.original;w.need(selected.requestIndex==='admitted'&&selected.requestKind==='apply-learning'&&applied?.kind==='applied-learning','Producer application row missing');
  w.need(applied!.requestId===j.applicationId&&applied!.deviceId===j.deviceId&&applied!.protocolDigest===w.hash(protocolIntent(request)),'Producer application receipt identity');
  w.need(applied!.kind==='applied-learning','Producer application kind changed');
  w.need(applied!.applicationId===j.applicationId&&applied!.rowId===adaptiveLearningPrefix+j.applicationId&&applied!.epoch===j.epoch&&
   applied!.requestSha256===w.hash(request)&&applied!.operationId===j.jobId&&j.application.terminalSha256===terminalSha256,'Producer application command changed');
  // Its complete maintained graph proves terminal/capture and before→after
  // application lineage, independently of later source eligibility changes.
  return {kind:'applied-learning',originalId:j.jobId,originalReceiptSha256:receiptSha,terminalSha256,applicationId:j.applicationId!,applicationReceiptSha256:applied!.receiptSha256,beforeSha256:applied!.beforeSha256,afterSha256:applied!.afterSha256};
 }
 /** Consume only this proof's exact selected job; no caller ID or copied state
  * can choose another original. The enclosing Store scope closes before return. */
 currentJob():ProducerCurrentJob{return this.budget.checked(()=>{
  const w:ProducerWork=this.work;this.reader.assertBudget(this.budget);this.reader.guard();
  // Public projection cannot rely on the caller having verified this capsule.
  // Reconstruct this exact owned state before publishing any non-absent facts.
  if(this.state)this.verify(this.state);
  const j=this.state?.pending??this.state?.checkpoint?.job;
  w.slots(32,2048);
  if(!j)return this.budget.copy({kind:'none' as const});
  const identity={scope:this.state!.pending?'pending' as const:'checkpoint' as const,jobId:j.jobId,jobKind:j.kind,phase:j.phase};
  if(!j.command)return this.budget.copy({...identity,kind:'unprepared' as const});
  const original=this.original(j);
  if(!original)return this.budget.copy({...identity,kind:'original-absent' as const});
  if(original.kind==='local-disposition')return this.budget.copy({...identity,kind:'local-disposition' as const,
   originalId:original.originalId,disposition:original.disposition,receiptSha256:original.receiptSha256});
  let application:ProducerCurrentApplication|undefined;
  if(this.state!.pending&&(j.phase==='admitted'||j.phase==='applying')&&j.kind==='learn'&&original.state==='completed'){
   w.need(j.applicationId&&original.captureKind==='learn'&&original.terminalSha256&&original.learningCapture&&original.sourceProofSha256,
    'Completed learning projection commitments unavailable');
   w.slots(8,512);application={requestId:j.applicationId!,epoch:j.epoch,operationId:j.jobId,
    expectedLearningRevision:original.learningCapture!.expectedLearningRevision,terminalSha256:original.terminalSha256!,
    captureSha256:original.learningCapture!.captureSha256,sourceProofSha256:original.sourceProofSha256!};
  }
  return this.budget.copy({...identity,kind:original.terminalSha256?'terminal-worker' as const:'active-worker' as const,
   originalId:original.workerId,workerState:original.state,captureKind:original.captureKind,receiptSha256:original.receiptSha256,
   ...(original.terminalSha256?{terminalSha256:original.terminalSha256}:{}),...(original.sourceProofSha256?{sourceProofSha256:original.sourceProofSha256}:{}),
   ...(application?{application}:{})});
 });}
 validateApply(j:ProducerJob){this.validateApplyFrom(j,this.original(j));}
 private validateApplyFrom(j:ProducerJob,original:ProducerOriginal|undefined){const w:ProducerWork=this.work;
  w.need(original?.kind==='worker'&&j.kind==='learn'&&original.state==='completed'&&original.captureKind==='learn'&&original.terminalSha256&&original.learningCapture&&j.application,
   'Producer application requires completed learning original');
  w.need(original?.kind==='worker','Producer application worker kind changed');
  w.need(j.application!.terminalSha256===original!.terminalSha256&&j.application!.captureSha256===original!.learningCapture!.captureSha256&&
   j.application!.expectedLearningRevision===original!.learningCapture!.expectedLearningRevision,'Producer application commitments changed');
 }
 collision(seed:ProducerJob){const w:ProducerWork=this.work;w.slots(8,320);const ids=[seed.jobId,seed.transitionIds.claim,seed.transitionIds.savePreparation,seed.transitionIds.intentStart,seed.transitionIds.saveAdmission,seed.transitionIds.intentApply,seed.transitionIds.release];
  if(seed.applicationId){w.slots(1,40);ids.push(seed.applicationId);}
  for(let i=0;i<ids.length;i++)w.need(!this.reader.receipt(ids[i]!)&&!this.reader.object('request',ids[i]!),'Producer reserved identity occupied');
 }
 /** The only new state/job reference admitted to this initial proof is the
  * immutable result of its own maintained reducer. Public custody copies are
  * never accepted by equality or IDs. The caller retains this exact after. */
 prepareTransition(c:ProducerTransition,owner:string):ProducerState{return this.budget.checked(()=>{
  this.work.need(!this.transitionJob,'Producer transition proof reentry');this.reader.selectedState!(this.state);
  const after=this.budget.copy(this.work.reduce(this.state,c,owner));
  this.transitionJob=after.pending??after.checkpoint!.job;
  try{this.verifyTransition(this.state,after,c);return after;}finally{this.transitionJob=undefined;}
 });}
 private verifyTransition(before:ProducerState|undefined,after:ProducerState,c:ProducerTransition){
  const j=after.pending??after.checkpoint!.job,w:ProducerWork=this.work;
  if(c.kind==='claim')this.collision(j);
  if(c.kind==='save-admission')w.need(w.equal(this.admission(j)??null,c.admission),'Producer admission has no retained original');
  if(c.kind==='intent-apply')this.validateApply(j);
  if(c.kind==='release')w.need(w.equal(this.release(j)??null,c.releaseProof),'Producer release has no positive original proof');
 }
 /** Reconstruct exact permitted commands, not merely adjacent row hashes.
  * The predecessor before claim is the explicit bounded admission boundary. */
 verify(state:ProducerState){const w:ProducerWork=this.work,j=state.pending??state.checkpoint!.job;
  w.need(state===this.state,'Producer capsule is not owned by this proof');this.reader.selectedState!(state);
  w.job(j);w.slots(10,512);const phases:ProducerTransitionKind[]=['claim'];
  if(j.phase!=='preparing')phases.push('save-preparation');
  if(j.phase==='starting'||j.phase==='admitted'||j.phase==='applying')phases.push('intent-start');
  if(j.phase==='admitted'||j.phase==='applying')phases.push('save-admission');
  if(j.phase==='applying')phases.push('intent-apply');
  if(state.checkpoint)phases.push('release');
  w.need(j.baseRevision<=Number.MAX_SAFE_INTEGER-phases.length&&j.baseRevision+phases.length===state.revision,'Producer reconstructed revision exhausted or changed');
  const seed=w.seedOf(j);let previous:ProducerState|undefined,priorHash=j.claimPriorStateSha256;
  for(let i=0;i<phases.length;i++){
   const kind=phases[i]!,expectedRevision=j.baseRevision+i;w.need(Number.isSafeInteger(expectedRevision)&&expectedRevision<Number.MAX_SAFE_INTEGER,'Producer history revision overflow');w.slots(6,512);
   const base={format:1 as const,requestId:transitionId(j,kind),epoch:j.epoch,expectedRevision,expectedSha256:priorHash};
   let command:ProducerTransition;
   if(kind==='claim')command={...base,kind,seed};
   else if(kind==='save-preparation'||kind==='intent-start')command={...base,kind,command:j.command!};
   else if(kind==='save-admission')command={...base,kind,command:j.command!,admission:j.admission!};
   else if(kind==='intent-apply')command={...base,kind,application:j.application!};
   else command={...base,kind,releaseFromPhase:j.phase,releaseProof:state.checkpoint!.releaseProof};
   // The complete current job was checked once above. Reconstruct its finite
   // phase projections directly; repeating the mutation reducer would rehash
   // an already-computed predecessor and revalidate this identical descriptor.
   // Actual transition admission continues to use the full reducer.
   w.slots(8,1024);const nextPhase=kind==='claim'?'preparing':kind==='save-preparation'?'prepared':kind==='intent-start'?'starting':kind==='save-admission'?'admitted':'applying';
   let next:ProducerState;
   if(kind==='release')next={format:1,revision:expectedRevision+1,pending:null,checkpoint:{job:previous!.pending!,releaseFromPhase:j.phase,releaseProof:state.checkpoint!.releaseProof},lastTransition:{requestId:command.requestId,jobId:j.jobId,kind}};
   else{
    const projected:ProducerJob={...seed,baseRevision:j.baseRevision,claimPriorStateSha256:j.claimPriorStateSha256,phase:nextPhase};
    if(nextPhase!=='preparing')projected.command=j.command!;
    if(nextPhase==='admitted'||nextPhase==='applying')projected.admission=j.admission!;
    if(nextPhase==='applying')projected.application=j.application!;
    next={format:1,revision:expectedRevision+1,pending:projected,checkpoint:null,lastTransition:{requestId:command.requestId,jobId:j.jobId,kind}};
   }
   const receipt=this.reader.receipt(command.requestId);w.need(receipt,'Producer transition receipt missing');
   const expected=w.receipt(previous,next,command);
   w.need(receipt!.requestId===command.requestId&&receipt!.deviceId===j.deviceId&&receipt!.digest===w.hash(w.intent(command))&&w.equal(receipt!.value,expected),'Producer transition intent or semantic path changed');
   previous=next;priorHash=expected.afterSha256;
  }
  w.need(priorHash===w.hash(state),'Producer current capsule does not reconstruct');
  // Released unused IDs can now hold unrelated originals. Only another
  // same-job transition claims membership in this capsule's path.
  w.slots(7,256);const all:ProducerTransitionKind[]=['claim','save-preparation','intent-start','save-admission','intent-apply','release'];
  for(let i=0;i<all.length;i++){const kind=all[i]!;if(phases.includes(kind))continue;const r=this.reader.receipt(transitionId(j,kind));
   w.need(!r||!state.pending&&((r.value as any)?.type!=='feed-automatic-transition'||(r.value as any)?.jobId!==j.jobId),'Producer extra conflicting transition');}
  // One invocation owns one reader and immutable job. Reuse this exact proof
  // only within the current stack, not in another call/phase or after return.
  const original=j.command?this.original(j):undefined;
  if(j.admission)w.need(w.equal(this.admissionFrom(j,original)??null,j.admission),'Producer retained admission changed');
  if(state.pending){
   const start=this.selected(j,0),application=j.applicationId?this.selected(j,1):undefined;
   if(j.phase==='preparing')w.need(!start.receiptPresent&&start.requestIndex==='absent','Producer original predates saved preparation');
   else if(start.receiptPresent)w.need(original&&(j.phase!=='prepared'||original.kind==='local-disposition'),'Producer original predates start intent');
   if(j.phase!=='applying')w.need(!application||(application.receiptPresent===false&&application.requestIndex==='absent'),'Producer application predates apply intent');
   else if(application?.receiptPresent)w.need(this.releaseFrom(j,original)?.kind==='applied-learning','Producer application original changed');
  }
  if(j.application)this.validateApplyFrom(j,original);
  if(state.checkpoint)w.need(w.equal(this.releaseFrom(j,original)??null,state.checkpoint.releaseProof),'Producer retained release proof changed');
  this.reader.guard();
 }
}

function verifiedProducerFacts(reader:CompletionReader,budget:MutationPlanBudget,stored:ProducerOverride|undefined,currentJob:boolean):ProducerFacts|ProducerCurrentFacts{
 const proof=new ProducerProof(reader,budget,stored?.state),w:ProducerWork=proof.work;
 if(stored){w.need(Number.isSafeInteger(stored.ciphertextBytes)&&stored.ciphertextBytes>=28&&stored.ciphertextBytes<=producerSlotBytes+28,'Producer ciphertext length');if(!currentJob)proof.verify(stored.state);}
 const n=stored?.state.pending?remainingTransitions(stored.state.pending.phase):0;w.slots(3,256);
 const facts={...(stored?{state:budget.copy(stored.state)}:{}),ciphertextBytes:stored?.ciphertextBytes??0,
  remainingGrowth:Object.freeze({entries:n,ciphertextBytes:n?Math.max(0,producerSlotBytes+28-stored!.ciphertextBytes)+n*(producerReceiptBytes+28):0}),
  maximumSingleTransitionOverlap:Object.freeze({entries:n?1:0,ciphertextBytes:n?producerSlotBytes+producerReceiptBytes+56:0})};
 if(currentJob){w.slots(8,512);return Object.freeze({...facts,currentJob:proof.currentJob()});}
 return Object.freeze(facts);
}
/** Preserve the ordinary capacity/state-read result and its original proof. */
export function producerFacts(reader:CompletionReader,budget:MutationPlanBudget,stored:ProducerOverride|undefined):ProducerFacts{
 return verifiedProducerFacts(reader,budget,stored,false);
}
/** The current-job branch reuses that same verified proof and its metered Work. */
export function producerCurrentFacts(reader:CompletionReader,budget:MutationPlanBudget,stored:ProducerOverride|undefined):ProducerCurrentFacts{
 return verifiedProducerFacts(reader,budget,stored,true) as ProducerCurrentFacts;
}

/** No caller can turn this check into a writer. Current transaction owns facts. */
export function checkProducerReservation(facts:ProducerFacts|undefined,requestId:string,digest:string,device:string,work:ProducerWork){
 const j=facts?.state?.pending;if(!j)return;
 const keys=j.transitionIds;
 if(requestId===keys.claim||requestId===keys.savePreparation||requestId===keys.intentStart||requestId===keys.saveAdmission||requestId===keys.intentApply||requestId===keys.release)
  work.need(false,'Request identity reserved for producer transition');
 if(requestId!==j.jobId&&requestId!==j.applicationId)return;
 const command=requestId===j.jobId&&j.phase==='starting'?j.command:requestId===j.applicationId&&j.phase==='applying'?j.application:undefined;
 work.need(command&&device===j.deviceId,'Request identity reserved for exact producer original');
 work.slots(2,128);const request={kind:requestId===j.jobId?'start':'apply-learning',command};
 work.need(digest===work.hash(protocolIntent(request)),'Producer reserved original intent changed');
}
