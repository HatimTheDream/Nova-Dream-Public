import {z} from 'zod';
import {types} from 'node:util';
import {canonical} from '../../packages/domain/contracts.js';
import {feedAdaptiveBasisSchema,feedStartPreparationSchema,feedStartV3Schema,type FeedStartPreparation,type FeedStartV3} from '../../packages/domain/news-feed-semantic-protocol.js';
import {adaptiveApplyCommandSchema} from '../../packages/domain/news-feed-adaptive-commands.js';
import type {FeedAdaptiveOwner} from './feed-adaptive-authority.js';
import type {ProducerCurrentJob} from './feed-automatic-producer-store.js';
import {producerReceiptSchema,producerReceiptBytes,producerSlotBytes,transitionId,type ProducerJob,type ProducerState,type ProducerSeed,type ProducerTransition,type ProducerReceipt} from './feed-automatic-producer-state.js';
import {historyJsonBytes} from './feed-history-bounds.js';

const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const idsSchema=z.object({jobId:uuid,applicationId:uuid,transitionIds:z.object({claim:uuid,savePreparation:uuid,intentStart:uuid,saveAdmission:uuid,intentApply:uuid,release:uuid}).strict()}).strict();
const candidateSchema=z.object({inputSha256:sha,sourceSha256:sha,contextSha256:sha,basisSha256:sha}).strict();
const currentSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('held')}).strict(),
 z.object({kind:z.literal('current'),eligible:z.boolean(),deviceId:uuid,epoch:uuid,selectionState:z.enum(['eligible','consumed','held']),
  candidate:candidateSchema,basis:feedAdaptiveBasisSchema,sourceProofSha256:sha}).strict(),
]);
export type ProducerCoordinatorCurrent=z.infer<typeof currentSchema>;
export type ProducerCoordinatorIds=z.infer<typeof idsSchema>;
export type ProducerCoordinatorRequest=Readonly<{kind:'claim'}>|Readonly<{kind:'prepare'|'start'|'apply';job:ProducerJob}>;
export type ProducerCoordinatorSnapshot=Readonly<{format:1;state:ProducerState|null;stateSha256:string;remainingGrowth:Readonly<{entries:number;ciphertextBytes:number}>;maximumSingleTransitionOverlap:Readonly<{entries:number;ciphertextBytes:number}>;currentJob:ProducerCurrentJob}>;
type TransitionResult={fresh:boolean;value:ProducerReceipt};
type ReconcileInput=Readonly<{format:1;requestId:string;epoch:string;expectedRevision:number;expectedSha256:string;kind:'save-admission'|'release'}>;
export type ProducerHeldReason='closing'|'no-owner'|'current-ineligible'|'preparation-unknown'|'replayed-transition'|'obsolete-job'|'active-original-observation-held'|'classification-held'|'original-unknown'|'application-ineligible'|'application-unavailable'|'release-unproven';
export type ProducerStepResult=Readonly<{state:'held';reason:ProducerHeldReason;jobId?:string}>|Readonly<{state:'advanced';action:'prepared'|'started'|'applied'|'reconciled';jobId:string}>;
export type ProducerCloseResult=Readonly<{stepSettled:boolean;localSettled:boolean}>;

/** Required internal controlled ports. This interface is not background access.
 * Production composition must bind current authentication, read/write permission,
 * recovery/maintenance and the maintained bounded current-source/selector ports.
 * current.candidate uses the selector protocol; sourceProofSha256 uses the
 * producer protocol. Neither a copied hash nor the current-job facts are permits.
 * Synchronous ports must perform no detached work. Invalid asynchronous returns
 * are refused and their exact work remains observed before the step settles. */
export interface FeedAutomaticProducerPorts{
 resolveOwner():FeedAdaptiveOwner|undefined;
 internalOwnProducerStep<T>(owner:FeedAdaptiveOwner,run:(captured:FeedAdaptiveOwner)=>Promise<T>):Promise<T>;
 authorizeCurrent(owner:FeedAdaptiveOwner):void;
 current(owner:FeedAdaptiveOwner,request:ProducerCoordinatorRequest):ProducerCoordinatorCurrent;
 allocateIds():ProducerCoordinatorIds;
 store:{
  internalReadFeedProducerCurrentJob(owner:string,input:{format:1;epoch:string}):ProducerCoordinatorSnapshot;
  internalTransitionFeedProducer(owner:string,input:ProducerTransition):TransitionResult;
  internalReconcileFeedProducer(owner:string,input:ReconcileInput):TransitionResult|{state:'unknown'};
 };
 controller:{
  prepare(owner:FeedAdaptiveOwner,descriptor:FeedStartPreparation):Promise<FeedStartV3>;
  start(owner:FeedAdaptiveOwner,command:FeedStartV3):Promise<unknown>;
  applyLearning(owner:FeedAdaptiveOwner,command:z.infer<typeof adaptiveApplyCommandSchema>):unknown;
 };
 /** Observation only, including maintained raw work. Must not start a drain. */
 observeOwnedWork():boolean;
}

class AsynchronousPort extends Error{
 private observation?:Promise<void>;
 constructor(private readonly original:unknown){super('Automatic producer synchronous port returned asynchronous work');}
 settle():Promise<void>{
  // The inner owned callback and outer resolver boundary may see this same
  // error. They must share one assimilation of the original thenable.
  return this.observation??=Promise.resolve().then(()=>this.original).then(()=>undefined,()=>undefined);
 }
}
function synchronous<T>(value:T):T{
 // `in` never reads the then getter. Assimilation happens once, only in the
 // retained failure path. Native Promises are recognized without prototype traps.
 if(types.isPromise(value)||value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw new AsynchronousPort(value);
 return value;
}
async function retainInvalid<T>(run:()=>T|Promise<T>):Promise<T>{
 try{return await run();}catch(error){
  if(error instanceof AsynchronousPort)await error.settle();
  throw error;
 }
}
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
function json<T>(value:unknown,schema:z.ZodType<T>,bytes:number):T{historyJsonBytes(value,bytes);return schema.parse(value);}
function held(reason:ProducerHeldReason,jobId?:string):ProducerStepResult{return Object.freeze(jobId?{state:'held',reason,jobId}:{state:'held',reason});}
function advanced(action:'prepared'|'started'|'applied'|'reconciled',jobId:string):ProducerStepResult{return Object.freeze({state:'advanced',action,jobId});}

/** Learn-only, one-effect kernel. No constructor effect, timer or activation.
 * All custody transitions go through the original Store. Unknown outcomes never
 * repeat preparation/start/application; automatic native observation is held. */
export class FeedAutomaticProducerCoordinator{
 private running?:Readonly<{promise:Promise<ProducerStepResult>}>;
 private closing=false;
 private closeOperation?:Promise<ProducerCloseResult>;
 private invalidCloseObservation?:{error:AsynchronousPort;work:Promise<void>;settled:boolean};
 constructor(private readonly ports:FeedAutomaticProducerPorts){}
 step():Promise<ProducerStepResult>{
  if(this.running)return this.running.promise;
  if(this.closing)return Promise.resolve(held('closing'));
  let resolve!:(value:ProducerStepResult)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<ProducerStepResult>((yes,no)=>{resolve=yes;reject=no;});
  const invocation=Object.freeze({promise});this.running=invocation;
  // Publish before resolving any supplied method/getter or invoking a port.
  void Promise.resolve().then(()=>retainInvalid(()=>this.dispatch())).then(value=>{
   if(this.running===invocation)this.running=undefined;resolve(value);
  },error=>{if(this.running===invocation)this.running=undefined;reject(error);});
  return promise;
 }
 private async dispatch():Promise<ProducerStepResult>{
  if(this.closing)return held('closing');
  const owner=synchronous(this.ports.resolveOwner());if(owner===undefined)return held('no-owner');
  // The maintained adapter captures identity and encloses final authorization.
  // It is deliberately separate from native readiness jobs.
  let callbackFailure:{error:unknown}|undefined;
  try{return await this.ports.internalOwnProducerStep(owner,captured=>retainInvalid(async()=>{
   this.check(captured);let value:ProducerStepResult|undefined,failure:{error:unknown}|undefined;
   // Settle a nonconforming body return before a later authorization failure
   // could replace it. Both invalid works stay owned; the first refusal wins.
   try{value=await retainInvalid(()=>this.advance(captured));}catch(error){failure={error};}
   try{await retainInvalid(()=>this.check(captured));}catch(error){failure??={error};}
   if(failure)throw failure.error;return value!;
  }).catch(error=>{callbackFailure??={error};throw error;}));}
  catch(error){
   // The maintained owner may also refuse its final authorization. Await that
   // entire lifetime above, then preserve an earlier callback failure if any.
   throw callbackFailure?callbackFailure.error:error;
  }
 }
 private check(owner:FeedAdaptiveOwner){
  const authorization=synchronous(owner.authorize());need(authorization===undefined,'Original authorization must be synchronous');
  const current=synchronous(this.ports.authorizeCurrent(owner));need(current===undefined,'Current producer authorization must be synchronous');
 }
 private read(owner:FeedAdaptiveOwner):ProducerCoordinatorSnapshot{
  this.check(owner);const value=synchronous(this.ports.store.internalReadFeedProducerCurrentJob(owner.deviceId,{format:1,epoch:owner.epoch}));this.check(owner);
  // Store owns the bounded complete proof and copied state. Do not recreate a
  // graph or hash protocol here; inspect only its fixed custody envelope.
  need(value?.format===1&&typeof value.stateSha256==='string'&&/^[a-f0-9]{64}$/.test(value.stateSha256),'Producer read envelope changed');
  const job=value.state?.pending??value.state?.checkpoint?.job;
  need(!job||job.deviceId===owner.deviceId&&job.epoch===owner.epoch,'Producer read owner changed');return value;
 }
 private current(owner:FeedAdaptiveOwner,request:ProducerCoordinatorRequest){
  this.check(owner);const raw=synchronous(this.ports.current(owner,Object.freeze(request)));this.check(owner);
  const value=json(raw,currentSchema,producerSlotBytes);
  if(value.kind==='held'||!value.eligible)return undefined;
  Object.freeze(value.candidate);Object.freeze(value.basis);Object.freeze(value);
  need(value.deviceId===owner.deviceId&&value.epoch===owner.epoch,'Current producer source owner changed');
  if(request.kind==='claim')return value.selectionState==='eligible'?value:undefined;
  if(request.kind!=='apply'){
   const job=request.job;
   // Equality only, not a digest conversion: candidate hashes retain the
   // adaptive selector protocol and the exact saved descriptor basis.
   if(canonical(value.candidate)!==canonical(job.candidate)||canonical(value.basis)!==canonical((job.descriptor as Extract<FeedStartPreparation,{kind:'learn'}>).basis))return undefined;
  }
  return value;
 }
 private receipt(owner:FeedAdaptiveOwner,input:ProducerTransition,raw:TransitionResult):TransitionResult{
  historyJsonBytes(raw,producerSlotBytes);
  need(raw!==null&&typeof raw==='object'&&typeof raw.fresh==='boolean','Producer transition result changed');
  const fresh=raw.fresh,value=json(raw.value,producerReceiptSchema,producerReceiptBytes);
  const jobId=input.kind==='claim'?input.seed.jobId:'command'in input?input.command.requestId:input.kind==='intent-apply'?input.application.operationId:input.releaseProof.originalId;
  need(value.requestId===input.requestId&&value.jobId===jobId&&value.originalId===jobId&&value.deviceId===owner.deviceId&&value.epoch===owner.epoch&&value.kind===input.kind&&value.fromRevision===input.expectedRevision&&value.toRevision===input.expectedRevision+1&&value.beforeSha256===input.expectedSha256&&value.fromPhase===(input.kind==='claim'?'idle':input.kind==='save-preparation'?'preparing':input.kind==='intent-start'?'prepared':input.kind==='save-admission'?'starting':input.kind==='intent-apply'?'admitted':input.releaseFromPhase)&&value.toPhase===(input.kind==='claim'?'preparing':input.kind==='save-preparation'?'prepared':input.kind==='intent-start'?'starting':input.kind==='save-admission'?'admitted':input.kind==='intent-apply'?'applying':'idle'),'Producer acknowledgement identity changed');
  return {fresh,value};
 }
 private transition(owner:FeedAdaptiveOwner,input:ProducerTransition):TransitionResult{
  this.check(owner);const raw=synchronous(this.ports.store.internalTransitionFeedProducer(owner.deviceId,input));this.check(owner);return this.receipt(owner,input,raw);
 }
 private expected(owner:FeedAdaptiveOwner,receipt:ProducerReceipt):ProducerCoordinatorSnapshot|undefined{
  const next=this.read(owner);return next.state?.revision===receipt.toRevision&&next.stateSha256===receipt.afterSha256&&next.state.pending?.jobId===receipt.jobId?next:undefined;
 }
 private reconcile(owner:FeedAdaptiveOwner,snapshot:ProducerCoordinatorSnapshot,kind:'save-admission'|'release'):ProducerStepResult{
  const job=snapshot.state!.pending!;this.check(owner);
  const input:ReconcileInput={format:1,requestId:transitionId(job,kind),epoch:owner.epoch,expectedRevision:snapshot.state!.revision,expectedSha256:snapshot.stateSha256,kind};
  const value=synchronous(this.ports.store.internalReconcileFeedProducer(owner.deviceId,input));this.check(owner);
  historyJsonBytes(value,producerSlotBytes);
  if('state'in value){need(value.state==='unknown','Producer reconciliation result changed');return held(kind==='release'?'release-unproven':'original-unknown',job.jobId);}
  const receipt=json(value.value,producerReceiptSchema,producerReceiptBytes);
  need(typeof value.fresh==='boolean'&&receipt.kind===kind&&receipt.jobId===job.jobId&&receipt.requestId===input.requestId&&receipt.deviceId===owner.deviceId&&receipt.epoch===owner.epoch&&receipt.fromRevision===input.expectedRevision&&receipt.beforeSha256===input.expectedSha256&&receipt.toRevision===input.expectedRevision+1&&receipt.originalId===job.jobId&&receipt.fromPhase===job.phase&&receipt.toPhase===(kind==='save-admission'?'admitted':'idle'),'Producer reconciliation identity changed');
  return value.fresh?advanced('reconciled',job.jobId):held('replayed-transition',job.jobId);
 }
 private async advance(owner:FeedAdaptiveOwner):Promise<ProducerStepResult>{
  const snapshot=this.read(owner),job=snapshot.state?.pending;let used=false;
  const consume=(kind:'prepare'|'start'|'apply',ack:TransitionResult)=>{
   need(!used&&ack.fresh&&ack.value.kind===(kind==='prepare'?'claim':kind==='start'?'intent-start':'intent-apply'),'Fresh producer effect permit unavailable');
   // Never restore this bit after transferring control, even on sync throw.
   used=true;this.check(owner);
  };
  if(!job){
   const current=this.current(owner,{kind:'claim'});if(!current)return held('current-ineligible');
   const ids=json(synchronous(this.ports.allocateIds()),idsSchema,producerReceiptBytes);this.check(owner);
   Object.freeze(ids.transitionIds);Object.freeze(ids);
   const all=[ids.jobId,ids.applicationId,...Object.values(ids.transitionIds)];need(new Set(all).size===8,'Producer allocated IDs must be distinct');
   const descriptor=feedStartPreparationSchema.parse({format:3,kind:'learn',requestId:ids.jobId,epoch:owner.epoch,basis:current.basis});
   if(descriptor.kind==='learn')Object.freeze(descriptor.basis);Object.freeze(descriptor);
   const seed:ProducerSeed={jobId:ids.jobId,deviceId:owner.deviceId,epoch:owner.epoch,kind:'learn',candidate:current.candidate,descriptor,transitionIds:ids.transitionIds,applicationId:ids.applicationId};
   const input:ProducerTransition={format:1,requestId:ids.transitionIds.claim,epoch:owner.epoch,expectedRevision:snapshot.state?.revision??0,expectedSha256:snapshot.stateSha256,kind:'claim',seed};
   const ack=this.transition(owner,input);if(!ack.fresh)return held('replayed-transition',ids.jobId);
   const claimed=this.expected(owner,ack.value);if(!claimed)return held('obsolete-job',ids.jobId);
   const claimedJob=claimed.state!.pending!;
   if(!this.current(owner,{kind:'prepare',job:claimedJob}))return held('current-ineligible',ids.jobId);
   if(!this.expected(owner,ack.value))return held('obsolete-job',ids.jobId);
   consume('prepare',ack);const response=await this.ports.controller.prepare(owner,descriptor);this.check(owner);
   const next=this.expected(owner,ack.value);if(!next)return held('obsolete-job',ids.jobId);
   if(!this.current(owner,{kind:'prepare',job:next.state!.pending!}))return held('current-ineligible',ids.jobId);
   const command=json(response,feedStartV3Schema,producerSlotBytes),{expectedRevision,expectation,...preparedDescriptor}=command;
   need(canonical(preparedDescriptor)===canonical(descriptor),'Prepared producer descriptor changed');
   const save:ProducerTransition={format:1,requestId:ids.transitionIds.savePreparation,epoch:owner.epoch,expectedRevision:next.state!.revision,expectedSha256:next.stateSha256,kind:'save-preparation',command};
   const saved=this.transition(owner,save);return saved.fresh?advanced('prepared',ids.jobId):held('replayed-transition',ids.jobId);
  }
  if(job.phase==='preparing')return held(job.kind==='learn'?'preparation-unknown':'classification-held',job.jobId);
  if(job.kind==='classify'){
   if(job.phase==='starting')return this.reconcile(owner,snapshot,'save-admission');
   if(job.phase==='admitted')return this.reconcile(owner,snapshot,'release');
   return held('classification-held',job.jobId);
  }
  if(job.phase==='prepared'){
   if(!this.current(owner,{kind:'start',job}))return held('current-ineligible',job.jobId);
   const input:ProducerTransition={format:1,requestId:job.transitionIds.intentStart,epoch:owner.epoch,expectedRevision:snapshot.state!.revision,expectedSha256:snapshot.stateSha256,kind:'intent-start',command:job.command!};
   const ack=this.transition(owner,input);if(!ack.fresh)return held('replayed-transition',job.jobId);
   const next=this.expected(owner,ack.value);if(!next)return held('obsolete-job',job.jobId);
   if(!this.current(owner,{kind:'start',job:next.state!.pending!}))return held('current-ineligible',job.jobId);
   if(!this.expected(owner,ack.value))return held('obsolete-job',job.jobId);
   consume('start',ack);await this.ports.controller.start(owner,job.command!);this.check(owner);
   const saved=this.expected(owner,ack.value);if(!saved)return held('obsolete-job',job.jobId);
   const result=this.reconcile(owner,saved,'save-admission');return result.state==='advanced'?advanced('started',job.jobId):result;
  }
  if(job.phase==='starting')return this.reconcile(owner,snapshot,'save-admission');
  if(job.phase==='applying')return this.reconcile(owner,snapshot,'release');
  const original=snapshot.currentJob;
  if(original.kind==='active-worker')return held('active-original-observation-held',job.jobId);
  if(original.kind==='original-absent'||original.kind==='unprepared'||original.kind==='none')return held('original-unknown',job.jobId);
  if(original.kind==='local-disposition'||original.kind==='terminal-worker'&&original.workerState!=='completed')return this.reconcile(owner,snapshot,'release');
  need(original.kind==='terminal-worker','Producer current-job union changed');
  if(!original.application)return held('application-unavailable',job.jobId);
  const current=this.current(owner,{kind:'apply',job});
  if(!current||current.sourceProofSha256!==original.application.sourceProofSha256)return held('application-ineligible',job.jobId);
  const {sourceProofSha256,...facts}=original.application,application=adaptiveApplyCommandSchema.parse({format:3,...facts});
  const input:ProducerTransition={format:1,requestId:job.transitionIds.intentApply,epoch:owner.epoch,expectedRevision:snapshot.state!.revision,expectedSha256:snapshot.stateSha256,kind:'intent-apply',application};
  const ack=this.transition(owner,input);if(!ack.fresh)return held('replayed-transition',job.jobId);
  const next=this.expected(owner,ack.value);if(!next)return held('obsolete-job',job.jobId);
  const latest=this.current(owner,{kind:'apply',job:next.state!.pending!});
  if(!latest||latest.sourceProofSha256!==sourceProofSha256)return held('application-ineligible',job.jobId);
  if(!this.expected(owner,ack.value))return held('obsolete-job',job.jobId);
  consume('apply',ack);await this.ports.controller.applyLearning(owner,application);this.check(owner);
  const saved=this.expected(owner,ack.value);if(!saved)return held('obsolete-job',job.jobId);
  const result=this.reconcile(owner,saved,'release');return result.state==='advanced'?advanced('applied',job.jobId):result;
 }
 close(waitMs:number):Promise<ProducerCloseResult>{
  if(!Number.isInteger(waitMs)||waitMs<1||waitMs>90000)throw Error('Invalid finite producer close bound');
  this.closing=true;if(this.closeOperation)return this.closeOperation;
  // One deadline covers the whole observation. Invalid observer work remains
  // owned by this closed coordinator after a timeout and is never invoked again.
  const operation=Promise.resolve().then(async()=>{
   let timer:ReturnType<typeof setTimeout>|undefined,expired=false;
   const deadline=new Promise<void>(resolve=>{timer=setTimeout(()=>{expired=true;resolve();},waitMs);});
   try{
    const original=this.running?.promise;
    if(original)await Promise.race([original.then(()=>undefined,()=>undefined),deadline]);
    const stepSettled=!this.running;
    if(!stepSettled||expired)return Object.freeze({stepSettled,localSettled:false});
    let invalid=this.invalidCloseObservation;
    if(!invalid){
     let owned:boolean|undefined;
     try{owned=synchronous(this.ports.observeOwnedWork());}
     catch(error){
      if(!(error instanceof AsynchronousPort))throw error;
      const record={error,work:error.settle(),settled:false};
      this.invalidCloseObservation=record;invalid=record;
      void record.work.then(()=>{record.settled=true;});
     }
     if(!invalid){need(typeof owned!=='undefined'&&typeof owned==='boolean','Producer close observation changed');return Object.freeze({stepSettled:true,localSettled:owned});}
    }
    await Promise.race([invalid.work,deadline]);
    if(!invalid.settled)return Object.freeze({stepSettled:true,localSettled:false});
    throw invalid.error;
   }finally{if(timer)clearTimeout(timer);}
  });
  this.closeOperation=operation;
  void operation.then(result=>{if(!result.localSettled&&this.closeOperation===operation)this.closeOperation=undefined;},()=>{if(this.closeOperation===operation)this.closeOperation=undefined;});
  return operation;
 }
}
