import {randomUUID} from 'node:crypto';
import {Fault,type Store} from './store.js';
import type {NewsFeed} from './news-feed.js';
import type {FeedAdaptiveAuthority,FeedAdaptiveOwner} from './feed-adaptive-authority.js';
import type {FeedAdaptiveController} from './feed-adaptive-controller.js';
import type {FeedAdaptiveCurrentSource} from './feed-adaptive-current-source.js';
import {currentFeedPreferences,projectFeedAdaptiveCurrent} from './feed-adaptive-current-source.js';
import {adaptiveHash,adaptiveWrittenCurrent,captureAdaptiveLearning,captureAdaptivePreview,readAdaptiveLearning,applyAdaptiveLearning,type AdaptiveWrittenBasis} from '../../packages/domain/news-feed-adaptive.js';
import {preferenceProof,captureAdaptiveOriginal,type AdaptiveSource} from '../../packages/domain/news-feed-adaptive-capture.js';
import {feedHardFilter,type FeedStory} from '../../packages/domain/news-feed.js';
import {feedProtocolLimits,type FeedStartPreparation,type FeedStartV3,type FeedCloseOriginal} from '../../packages/domain/news-feed-semantic-protocol.js';
import type {AdaptiveApplyCommand,AdaptiveProtocolRequest} from '../../packages/domain/news-feed-adaptive-commands.js';
import {canonical} from '../../packages/domain/contracts.js';
import {workerInputHash as hash} from './worker-plugin/identity.js';

type Controller=Pick<FeedAdaptiveController,'nativeCapabilities'|'prepare'|'start'|'observe'|'readOriginal'|'applyLearning'|'closeOriginal'>;
type Source=Pick<FeedAdaptiveCurrentSource,'permissions'>;
type News=Pick<NewsFeed,'internalAdaptivePreferencesSnapshot'|'internalAdaptiveSourceSnapshot'|'internalAdaptiveStoryInventory'>;
export type FeedAutomaticResult={state:'idle'|'held'|'started'|'observed'|'applied';id?:string};
type Choice={kind:'idle'}|{kind:'held'}|{kind:'observe';id:string;final:boolean}|{kind:'apply';command:AdaptiveApplyCommand}|{
 kind:'start';descriptor:FeedStartPreparation;key:string};
type Pending={owner:FeedAdaptiveOwner;request:Extract<AdaptiveProtocolRequest,{kind:'start'|'apply-learning'}>;
 close?:{kind:'close';command:FeedCloseOriginal}};
const terminal=(state:string)=>['completed','failed','cancelled','withdrawn','rejected'].includes(state);
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

/** A semantic-input key is scheduling data, never execution authority. The
 * current full source is still captured and verified by the existing protocol.
 * Learning excludes only its own derived interests/revision; an application
 * must not schedule the same evidence again. Settings, controls, suppression,
 * exact permitted activity and accepted basis remain part of its identity. */
function inputKey(kind:'learn'|'classify',source:AdaptiveSource,basis:AdaptiveWrittenBasis,story?:FeedStory){
 const context=kind==='learn'?{...source.context,learning:{suppressed:source.context.learning.suppressed}}:source.context;
 return adaptiveHash({kind,context,basis,...(story?{story}:{})},hash);
}

/** Ordinary schema60 composition. The protected adaptive originals are the
 * durable queue: no producer slot, alternate history engine or new worker.
 * An authenticated visible-Feed POST advances at most one original. There is
 * no timer or service principal; every effect retains its captured session.
 * The native owner's existing close/maintenance buckets own the whole step,
 * including preparations and any underlying work surviving an HTTP timeout. */
export class FeedAutomaticLocal{
 #advancing=false;
 #pending?:Pending;
 #failedPreparations=new Set<string>();
 #finalObservations=new Set<string>();
 constructor(private store:Store,private news:News,private controller:Controller,private source:Source,
  private lifetime:Pick<FeedAdaptiveAuthority,'internalOwnProducerStep'>,private now=Date.now){}

 private guard(owner:FeedAdaptiveOwner){
  const permissions=this.source.permissions(owner);
  if(owner.epoch!==this.store.epoch||!permissions.read||!permissions.write||this.store.recoveryHeld||
   this.store.recoveryEffectsPaused||this.store.updateMaintenanceHeld)throw Error('Automatic Feed access is held');
 }
 private choose(owner:FeedAdaptiveOwner):Choice{
  this.guard(owner);
  try{return this.store.internalWithFeedReadGraph(graph=>{
   this.guard(owner);
   // Unfinished work holds all new admission, including a different device or
   // a manually started interpretation. Only its original owner may observe.
   for(const worker of graph.workers.values())if(!terminal(worker.state)){
    const original=graph.adaptiveWorkers.get(worker.id);
    if(!original||original.deviceId!==owner.deviceId||original.command.epoch!==owner.epoch)return {kind:'held'};
    const final=this.now()>=original.deadlineAt;
    if(final&&(this.#finalObservations.has(original.id)||this.#finalObservations.size>=feedProtocolLimits.records))return {kind:'held'};
    return {kind:'observe',id:original.id,final};
   }
   const saved=this.news.internalAdaptivePreferencesSnapshot();
   if(saved.epoch!==owner.epoch)throw Error('Current Feed workspace changed');
   const preferences=currentFeedPreferences(saved,graph),raw=this.news.internalAdaptiveSourceSnapshot(owner.deviceId);
   const current=projectFeedAdaptiveCurrent(owner,graph,preferences,raw),source=current.source;
   if(!source)return {kind:'held'};
   const at=this.now(),bases:AdaptiveWrittenBasis[]=[];
   if(adaptiveWrittenCurrent(source.context,{kind:'empty'},hash))bases.push({kind:'empty'});
   else for(const review of graph.adaptiveReviews.values())if(adaptiveWrittenCurrent(source.context,review.source,hash))bases.push(review.source);
   // Ambiguous accepted writing is a hold, never an arbitrary latest result.
   if(bases.length!==1)return {kind:'held'};
   const basis=bases[0]!,basisDescriptor=basis.kind==='empty'
    ?{kind:'empty-written' as const,preferenceProofSha256:preferenceProof(source,hash)}
    :{kind:'accepted' as const,reviewId:basis.approval.reviewRequestId,originalProofSha256:adaptiveHash(basis,hash)};
   const applied=new Set<string>();for(const record of graph.learning.values())applied.add(record.command.operationId);
   const consumed=new Set<string>();
   for(const worker of graph.adaptiveWorkers.values()){
    if(worker.deviceId!==owner.deviceId||worker.command.epoch!==owner.epoch||worker.capture.kind==='interpret')continue;
    const capture=worker.capture;
    consumed.add(inputKey(capture.kind,capture.source,capture.basis,capture.kind==='classify'?capture.preview.story:undefined));
    // Complete graph verification proves the saved result and application
    // receipts. Reapply neither a committed result nor a changed source.
    if(capture.kind==='learn'&&worker.state==='completed'&&worker.terminal&&worker.output?.text&&!applied.has(worker.id)&&
     same(source,capture.source)&&adaptiveWrittenCurrent(source.context,capture.basis,hash)){
     const parsed=readAdaptiveLearning(worker.output.text,capture.learning,hash);
     if(parsed.ok&&applyAdaptiveLearning(source.context,capture.learning,parsed.value.result,at,hash).ok){
      return {kind:'apply',command:{format:3,requestId:randomUUID(),epoch:owner.epoch,operationId:worker.id,
       expectedLearningRevision:source.context.learning.revision,terminalSha256:adaptiveHash(worker.terminal,hash),captureSha256:capture.learning.captureSha256}};
     }
    }
   }
   // A retained pre-admission refusal/closure consumes the exact current
   // descriptor. Its complete original remains immutable, including errors.
   const locallyConsumed=(descriptor:FeedStartPreparation,story?:FeedStory)=>{
    for(const row of graph.locals.values()){
     if(row.deviceId!==owner.deviceId||row.epoch!==owner.epoch||(row.kind!=='closed-before-admission'&&row.kind!=='refused-before-admission'))continue;
     const command=row.request.command;
     if(!('format'in command)||command.kind!==descriptor.kind||command.kind==='interpret'||descriptor.kind==='interpret')continue;
     if(command.expectedRevision!==source.context.profile.revision||!same(command.basis,descriptor.basis)||
      command.kind==='classify'&&(descriptor.kind!=='classify'||!same(command.story,descriptor.story)))continue;
     try{
      const capture=captureAdaptiveOriginal(command,source,basis,story,command.expectation.preparedAt,hash);
      if(adaptiveHash(capture,hash)===command.expectation.captureSha256)return true;
     }catch{/* Changed evidence can no longer reproduce this no-effect original. */}
    }
    return false;
   };
   const id=randomUUID(),common={format:3 as const,requestId:id,epoch:owner.epoch,basis:basisDescriptor};
   // Learn first when genuinely new permitted evidence exists. The next step
   // applies its result before classifications use the resulting context.
   const learningKey=inputKey('learn',source,basis),learn={...common,kind:'learn' as const};
   if(!consumed.has(learningKey)&&!locallyConsumed(learn)&&captureAdaptiveLearning(source.context,basis,id,at,hash).ok)
    return {kind:'start',descriptor:learn,key:learningKey};
   const inventory=this.news.internalAdaptiveStoryInventory();if(!inventory)return {kind:'held'};
   for(const {story,hidden} of inventory.values()){
    if(feedHardFilter(source.context.profile,story,{hidden}))continue;
    const key=inputKey('classify',source,basis,story);
    if(consumed.has(key))continue;
    const descriptor={...common,kind:'classify' as const,story:{id:story.id,revision:story.revision,sourceId:story.sourceId,sourceDigest:story.sourceDigest}};
    if(!locallyConsumed(descriptor,story)&&captureAdaptivePreview(source.context,basis,story,id,at,hash).ok)return {kind:'start',descriptor,key};
   }
   return {kind:'idle'};
  });}finally{this.guard(owner);}
 }

 advance(input:FeedAdaptiveOwner):Promise<FeedAutomaticResult>{
  try{this.guard(input);}catch(error){return Promise.reject(error);}
  if(this.#pending&&(this.#pending.owner.deviceId!==input.deviceId||this.#pending.owner.epoch!==input.epoch))return Promise.resolve({state:'held'});
  if(this.#advancing)return Promise.resolve({state:'held'});
  this.#advancing=true;
  try{
   // Pending uncertain writes retain the exact previous owner and bytes; a
   // new session cannot replace authority while their disposition is unknown.
   const work=this.lifetime.internalOwnProducerStep(input,async currentOwner=>{
    this.guard(currentOwner);
    const owner=this.#pending?.owner??currentOwner;this.guard(owner);
    if(this.#pending){
     const pending=this.#pending;
     if(pending.close){
      // Read first. If a local transaction never committed, one exact same
      // Close may complete its idempotent fence/ack on this visible advance.
      // It can never issue native work or acquire another Close identity.
      let closed=this.controller.readOriginal(owner,pending.close);this.guard(owner);
      if(closed.state!=='confirmed'){
       this.controller.closeOriginal(owner,pending.close.command);
       closed=this.controller.readOriginal(owner,pending.close);this.guard(owner);
      }
      if(closed.state!=='confirmed')throw new Fault(503,'feed_automatic_persistence','Automatic Feed matching is paused because its saved Close could not be confirmed. The same request is kept.');
     }
     let result=this.controller.readOriginal(owner,pending.request);this.guard(owner);
     if(result.state!=='confirmed'&&pending.request.kind==='apply-learning'){
      // The existing protected application is one atomic local transaction.
      // Its same command revalidates current source and replays a committed
      // receipt; it cannot apply twice or produce native work.
      this.controller.applyLearning(owner,pending.request.command);
      result=this.controller.readOriginal(owner,pending.request);this.guard(owner);
     }
     if(result.state!=='confirmed'){
      if(pending.request.kind!=='start'||pending.close)throw new Fault(503,'feed_automatic_persistence','Automatic Feed matching is paused because its saved result could not be confirmed. The same request is kept.');
      // This original Start call has fully settled (#advancing stayed set).
      // Complete readback proves no saved admission. The maintained local
      // Close fences absence or acknowledges a winning original; neither
      // branch dispatches/reissues Start. Retain its identity BEFORE calling.
      const command:FeedCloseOriginal={format:3,requestId:randomUUID(),epoch:owner.epoch,original:pending.request.command};
      pending.close={kind:'close',command};
      this.controller.closeOriginal(owner,command);
      const closed=this.controller.readOriginal(owner,pending.close),original=this.controller.readOriginal(owner,pending.request);this.guard(owner);
      if(closed.state!=='confirmed'||original.state!=='confirmed')throw new Fault(503,'feed_automatic_persistence','Automatic Feed matching is paused because its saved Close could not be confirmed. The same request is kept.');
     }
     this.#pending=undefined;
     return {state:'observed' as const,id:pending.request.command.requestId};
    }
    const choice=this.choose(owner);
    if(choice.kind==='idle'||choice.kind==='held')return {state:choice.kind};
    if(choice.kind==='observe'){
     if(!this.controller.nativeCapabilities(owner).observe)return {state:'held' as const,id:choice.id};
     // One final deadline observation may confirm native expiry/Stop. A still
     // unknown original then stays held for explicit Check; no infinite poll.
     if(choice.final)this.#finalObservations.add(choice.id);
     await this.controller.observe(owner,choice.id);this.guard(owner);
     return {state:'observed' as const,id:choice.id};
    }
    if(choice.kind==='apply'){
     const request={kind:'apply-learning' as const,command:choice.command};
     this.#pending={owner,request};
     this.controller.applyLearning(owner,choice.command);
     const saved=this.controller.readOriginal(owner,request);this.guard(owner);
     if(saved.state!=='confirmed')throw new Fault(503,'feed_automatic_persistence','Automatic Feed matching is paused because its saved learning result could not be confirmed. The same request is kept.');
     this.#pending=undefined;return {state:'applied' as const,id:choice.command.operationId};
    }
    if(!this.controller.nativeCapabilities(owner).prepare)return {state:'held' as const};
    // A failed preparation never becomes a repeated automatic provider probe.
    // The bounded in-memory hold grants no authority and creates no original.
    if(this.#failedPreparations.has(choice.key)||this.#failedPreparations.size>=feedProtocolLimits.records)return {state:'held' as const};
    let command:FeedStartV3;
    try{command=await this.controller.prepare(owner,choice.descriptor);}
    catch(error){this.#failedPreparations.add(choice.key);throw error;}
    this.guard(owner);
    // Preparation can await native observations. Recheck the whole current
    // selection and durable history before admitting this exact command.
    const after=this.choose(owner);
    if(after.kind!=='start'||after.key!==choice.key)return {state:'held' as const};
    const request={kind:'start' as const,command};
    this.#pending={owner,request};
    await this.controller.start(owner,command);
    const saved=this.controller.readOriginal(owner,request);this.guard(owner);
    if(saved.state!=='confirmed')return {state:'held' as const,id:command.requestId};
    this.#pending=undefined;return {state:'started' as const,id:command.requestId};
   });
   return work.finally(()=>{this.#advancing=false;});
  }catch(error){this.#advancing=false;return Promise.reject(error);}
 }
}
