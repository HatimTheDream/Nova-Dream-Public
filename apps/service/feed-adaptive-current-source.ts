import {z} from 'zod';
import {types} from 'node:util';
import type {Store} from './store.js';
import type {NewsFeed} from './news-feed.js';
import type {FeedAdaptiveOwner} from './feed-adaptive-authority.js';
import {workerInputHash as hash} from './worker-plugin/identity.js';
import {canonical} from '../../packages/domain/contracts.js';
import {feedCommandSchema,emptyFeedSettings,emptyFeedLearningControl,type FeedStory} from '../../packages/domain/news-feed.js';
import type {FeedReadGraph} from '../../packages/domain/news-feed-read-graph.js';
import {preferenceCheckpointSchema,type AdaptiveAuthority,type PreferenceCheckpoint} from '../../packages/domain/news-feed-adaptive-capture.js';
import type {SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';
import {projectFeedAdaptiveCurrent} from './feed-adaptive-current-projection.js';
export {projectFeedAdaptiveCurrent} from './feed-adaptive-current-projection.js';
import {adaptiveWrittenCurrent,type AdaptiveWrittenBasis} from '../../packages/domain/news-feed-adaptive.js';
import {feedStartPreparationSchema,type FeedStartPreparation} from '../../packages/domain/news-feed-semantic-protocol.js';
import {MutationPlanBudget} from './feed-history-projected-inventory.js';
import {SelectionWork,producerSelectionLimits} from './feed-adaptive-selection-budget.js';
import {selectFeedProducerCandidate,withFeedProducerProjection,hashFeedProducerPreferences} from './feed-adaptive-producer-selection.js';
import {ProducerWork,producerSlotBytes} from './feed-automatic-producer-state.js';
import type {ProducerCoordinatorCurrent,ProducerCoordinatorRequest} from './feed-automatic-producer-coordinator.js';
import {withPreparedFeedSource,preparedFeedBasis,preparedFeedLearningEligibility,preparedFeedProducerHash} from './feed-adaptive-owned-source.js';

export type FeedCurrentPermissions={read:boolean;write:boolean};
/** Must be bound to the original authenticated token/session/route and current
 * service policy. A device ID or caller-supplied role is never authorization. */
export type FeedCurrentPermissionResolver=(owner:FeedAdaptiveOwner)=>FeedCurrentPermissions;
export type FeedAdaptiveCurrent=Pick<AdaptiveAuthority,'authorized'|'writeAuthorized'|'deviceId'|'epoch'|'writing'|'source'>;
const ownerId=z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/),uuid=z.string().uuid(),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const permissionsSchema=z.object({read:z.boolean(),write:z.boolean()}).strict();
const receiptSchema=z.object({format:z.literal(1),requestId:uuid,epoch:uuid,command:feedCommandSchema,at:z.string().datetime({offset:true}),
 state:z.literal('saved'),revision:positive,profileRevision:positive}).strict();
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function need(yes:unknown,message:string):asserts yes{if(!yes)throw new Error(message);}

/** The successful API is synchronous. An invalid port's original work remains
 * represented by the returned failure Promise, after the read scope unwinds.
 * The coordinator already refuses and owns this branch through final checks. */
class ProducerCurrentAsyncFailure extends Error{
 constructor(private readonly original:unknown){super('Producer current authorization and permissions must be synchronous');}
 observe():Promise<never>{return Promise.resolve().then(()=>this.original).then(()=>{throw this;},()=>{throw this;});}
}
function producerSynchronous<T>(value:T):T{
 if(types.isPromise(value)||value!==null&&(typeof value==='object'||typeof value==='function')&&'then'in value)throw new ProducerCurrentAsyncFailure(value);
 return value;
}
type Preferences=ReturnType<NewsFeed['internalAdaptivePreferencesSnapshot']>;

/** Exact current saved receipt, across all devices. Revision is the maintained
 * saved-state order; wall clock and the requesting device do not choose a winner.
 * This joins current state, not a newly invented historical baseline. */
export function currentFeedPreferences(snapshot:Preferences,graph:FeedReadGraph):PreferenceCheckpoint{
 const candidates:SemanticReceipt[]=[];
 if(snapshot.savedRevision===1)need(same(snapshot.profile,{format:1,revision:1,updatedAt:new Date(0).toISOString(),settings:emptyFeedSettings()})&&
  same(snapshot.control,emptyFeedLearningControl()),'Initial Feed preferences have no original saved command');
 for(const receipt of graph.receipts.values()){
  const raw=receipt.value as any;
  if(raw?.format!==1||raw.state!=='saved'||raw.epoch!==snapshot.epoch)continue;
  const parsedCommand=feedCommandSchema.safeParse(raw.command);
  // The actual receipt table holds all modules. Only this exact maintained
  // intent namespace can select a Feed receipt; a shared action word cannot.
  if(!parsedCommand.success||!same(parsedCommand.data,raw.command)||receipt.digest!==hash(canonical({type:'news.command',command:parsedCommand.data})))continue;
  need(Number.isSafeInteger(raw.revision)&&raw.revision<=snapshot.savedRevision,'Saved Feed revision trails its actual command history');
  if(snapshot.savedRevision===1){need(raw.revision<2,'Saved Feed revision lost its actual command history');continue;}
  if(raw.revision!==snapshot.savedRevision)continue;
  const parsed=receiptSchema.parse(raw),command=parsed.command;
  need(same(parsed,raw)&&receipt.requestId===parsed.requestId&&command.requestId===parsed.requestId&&command.epoch===snapshot.epoch&&
   typeof receipt.deviceId==='string'&&receipt.deviceId.length>0&&receipt.deviceId.length<=200&&receipt.digest===hash(canonical({type:'news.command',command}))&&
   command.expectedRevision===snapshot.savedRevision-1&&parsed.profileRevision===snapshot.profile.revision,'Current Feed receipt identity changed');
  if(['settings','interest','learning-reset'].includes(command.type))need(parsed.at===snapshot.profile.updatedAt,'Current profile timestamp differs from original command');
  if(command.type==='settings')need(same(command.settings,snapshot.profile.settings),'Current settings differ from original command');
  candidates.push(receipt);
 }
 need(snapshot.savedRevision===1?candidates.length===0:candidates.length===1,'Exact current Feed receipt is missing or ambiguous');
 const value:PreferenceCheckpoint={format:1,kind:'authenticated-current-state',savedRevision:snapshot.savedRevision,profile:snapshot.profile,control:snapshot.control,
  ...(candidates[0]?{latestMutation:structuredClone(candidates[0])}:{})};
 need(same(preferenceCheckpointSchema.parse(value),value),'Current preference checkpoint changed');return structuredClone(value);
}

/** Synchronous read composition only. No model/readiness requirement, cache,
 * command, timer or network action. Graph failure is never caught as an optional
 * raw-source hold. Every outward result rechecks the original request owner. */
export class FeedAdaptiveCurrentSource{
 constructor(private store:Store,private news:Pick<NewsFeed,'internalAdaptivePreferencesSnapshot'|'internalAdaptiveSourceSnapshot'|'internalAdaptiveStorySnapshot'>,
  private resolvePermissions:FeedCurrentPermissionResolver){
  need(typeof resolvePermissions==='function','Original request permission resolver required');
 }
 private owner(input:FeedAdaptiveOwner):FeedAdaptiveOwner{
  need(typeof input?.authorize==='function','Original authenticated request required');
  return Object.freeze({deviceId:ownerId.parse(input.deviceId),epoch:uuid.parse(input.epoch),authorize:input.authorize.bind(input)});
 }
 private guard(owner:FeedAdaptiveOwner):FeedCurrentPermissions{
  const authorized:unknown=owner.authorize();
  if(authorized!==undefined){void Promise.resolve(authorized).catch(()=>undefined);throw new Error('Original authorization must be synchronous');}
  need(owner.epoch===this.store.epoch,'Original workspace changed');
  const raw:unknown=this.resolvePermissions(owner);
  if(raw!==null&&(typeof raw==='object'||typeof raw==='function')&&typeof (raw as any).then==='function'){
   void Promise.resolve(raw).catch(()=>undefined);throw new Error('Original permissions must be synchronous');
  }
  const value=permissionsSchema.parse(raw);need(same(value,raw)&&value.read,'Original Feed read access unavailable');
  return {read:true,write:value.write&&!this.store.recoveryEffectsPaused&&!this.store.updateMaintenanceHeld};
 }
 permissions(input:FeedAdaptiveOwner):FeedCurrentPermissions{const owner=this.owner(input);this.guard(owner);return this.guard(owner);}
 private snapshot<T>(input:FeedAdaptiveOwner,read:(owner:FeedAdaptiveOwner,graph:FeedReadGraph,preferences:PreferenceCheckpoint)=>T):{value:T;permissions:FeedCurrentPermissions}{
  const owner=this.owner(input);this.guard(owner);
  try{const result=this.store.internalWithFeedReadGraph(graph=>{
   this.guard(owner);
   const saved=this.news.internalAdaptivePreferencesSnapshot();need(saved.epoch===owner.epoch,'Current writing workspace changed');
   const preferences=currentFeedPreferences(saved,graph),value=read(owner,graph,preferences);this.guard(owner);return value;
  });return {value:result,permissions:this.guard(owner)};}finally{this.guard(owner);}
 }
 current(input:FeedAdaptiveOwner):FeedAdaptiveCurrent{
  const result=this.snapshot(input,(owner,graph,preferences)=>{
   return projectFeedAdaptiveCurrent(owner,graph,preferences,this.news.internalAdaptiveSourceSnapshot(owner.deviceId));
  });return {authorized:true,writeAuthorized:result.permissions.write,...result.value};
 }
 /** Current data only; no owner resolver, effects or native readiness. The
  * request is a copied planning hint from the kernel's exact Store read, never
  * a proof or permission. Every new operation shares one selector allowance. */
 producerCurrent(input:FeedAdaptiveOwner,request:ProducerCoordinatorRequest):ProducerCoordinatorCurrent|Promise<never>{
  const budget=new MutationPlanBudget(producerSelectionLimits),proof=new ProducerWork(budget);
  // Prepay fixed closures, owner/permission/token wrappers and failure-Promise
  // observation before invoking any supplied authorization or permission port.
  proof.slots(64,8192);
  let alive=true,expectedToken:string|undefined,requireWrite=false;
  try{return budget.checked(()=>{
   need(typeof input?.authorize==='function','Original authenticated producer request required');
   const owner=Object.freeze({deviceId:uuid.parse(input.deviceId),epoch:uuid.parse(input.epoch),authorize:input.authorize.bind(input)});
   const token=()=>{proof.slots(8,1024);budget.query();budget.query();return canonical(this.store.internalFeedCacheToken());};
   const guard=():FeedCurrentPermissions=>budget.checked(()=>{
    need(alive,'Producer current read ended');proof.slots(12,1024);budget.query();
    const authorized:unknown=producerSynchronous(owner.authorize());need(authorized===undefined,'Original producer authorization must return undefined');
    need(owner.epoch===this.store.epoch,'Original producer workspace changed');
    const raw:unknown=producerSynchronous(this.resolvePermissions(owner));
    need(raw!==null&&typeof raw==='object'&&!Array.isArray(raw),'Current producer permissions unavailable');
    const keys=Reflect.ownKeys(raw),read=Object.getOwnPropertyDescriptor(raw,'read'),write=Object.getOwnPropertyDescriptor(raw,'write');
    need(keys.length===2&&keys.includes('read')&&keys.includes('write')&&read&&'value'in read&&write&&'value'in write&&
     typeof read.value==='boolean'&&typeof write.value==='boolean','Exact producer permissions required');
    need(read.value,'Original producer read access unavailable');
    const writable=write.value&&!this.store.recoveryHeld&&!this.store.recoveryEffectsPaused&&!this.store.updateMaintenanceHeld;
    need(!requireWrite||writable,'Current producer write access changed');
    if(expectedToken!==undefined)need(token()===expectedToken,'Current producer snapshot changed');
    return {read:true,write:writable};
   });
   const work=new SelectionWork(budget,()=>{guard();});
   const held=():ProducerCoordinatorCurrent=>work.result({kind:'held' as const});
   if(!guard().write)return held();
   requireWrite=true;expectedToken=token();work.guard();
   const requestSize=work.measure(request);need(requestSize.bytes<=producerSlotBytes,'Producer current request bound');
   const query=budget.copy(request);let keys=0;for(const key in query)if(Object.hasOwn(query,key))keys++;
   need(query.kind==='claim'?keys===1:keys===2&&Object.hasOwn(query,'job')&&(query.kind==='prepare'||query.kind==='start'||query.kind==='apply'),'Exact producer current request required');
   let descriptor:Extract<FeedStartPreparation,{kind:'learn'}>|undefined;
   if(query.kind!=='claim'){
    need(query.job.deviceId===owner.deviceId&&query.job.epoch===owner.epoch,'Producer current job owner changed');
    const parsed=proof.child(query.job.descriptor,()=>feedStartPreparationSchema.parse(query.job.descriptor));
    need(work.same(parsed,query.job.descriptor)&&parsed.requestId===query.job.jobId&&parsed.epoch===owner.epoch&&parsed.kind===query.job.kind,'Producer current descriptor changed');
    if(parsed.kind!=='learn')return held();descriptor=parsed;
   }
   const result=this.store.internalWithFeedReadGraph(graph=>{
    work.guard();const saved=this.news.internalAdaptivePreferencesSnapshot();
    need(saved.epoch===owner.epoch,'Current producer preferences workspace changed');
    const preferences=currentFeedPreferences(saved,graph);work.guard();
    const raw=this.news.internalAdaptiveSourceSnapshot(owner.deviceId);work.guard();
    proof.slots(2,128); // Both lexical consumer closures, before construction.
    return withPreparedFeedSource(owner,graph,preferences,raw,work,prepared=>{
    if(!prepared||!raw.usable)return held();
    return withFeedProducerProjection(graph,prepared,budget,source=>{
    const at=raw.snapshot.at;
    need(Number.isSafeInteger(at)&&at>0,'Current producer source time invalid');
    proof.slots(5,256);const empty:AdaptiveWrittenBasis={kind:'empty'};
    const currentBasis=(basis:AdaptiveWrittenBasis):AdaptiveWrittenBasis|undefined=>{
     const prepared=preparedFeedBasis(work,graph,source,basis);if(prepared!==undefined)return prepared??undefined;
     return work.child(source.context,[source.context.profile,basis],hash=>adaptiveWrittenCurrent(source.context,basis,hash),'basis')?basis:undefined;
    };
    let basis:AdaptiveWrittenBasis|undefined;
    if(descriptor){
     if(descriptor.basis.kind==='empty-written')basis=currentBasis(empty);
     else{const review=work.get(graph.adaptiveReviews,descriptor.basis.reviewId);if(review)basis=currentBasis(review.source);}
    }else{basis=currentBasis(empty);if(!basis){
     let count=0;work.scan(graph.adaptiveReviews,review=>{const current=currentBasis(review.source);if(current){count++;basis=current;if(count>1)return false;}});
     if(count!==1)basis=undefined;
    }}
    if(!basis)return held();
    proof.slots(5,256);
    const selected=selectFeedProducerCandidate({graph,source,owner,candidate:{kind:'learn',basis},at,snapshotToken:expectedToken!,guard:()=>{guard();}},budget);
    work.guard();proof.slots(2,128);
    const currentDescriptor:Extract<FeedStartPreparation,{kind:'learn'}>['basis']=basis.kind==='empty'
     ?{kind:'empty-written',preferenceProofSha256:hashFeedProducerPreferences(work,graph,source,owner,selected)}
     :{kind:'accepted',reviewId:basis.approval.reviewRequestId,originalProofSha256:selected.basisSha256};
    if(descriptor&&!work.same(descriptor.basis,currentDescriptor))return held();
    let eligible=selected.state==='eligible';
    // An exact retained original consumes selection but may still owe its one
    // application. Test current capture eligibility without granting new work.
    if(query.kind==='apply'){
     eligible=false;
     if(selected.state==='consumed'&&selected.reason==='retained-learning-original'&&selected.originalIds.length===1&&selected.originalIds[0]===query.job.jobId){
      const prepared=preparedFeedLearningEligibility(work,graph,source,basis,query.job.jobId,at);
      if(prepared)eligible=prepared.ok;else work.withLearningCaptures(source.context,basis,capture=>{eligible=capture(query.job.jobId,at).ok;});
     }
    }
    work.guard();const sourceProofSha256=preparedFeedProducerHash(work,proof,graph,source);work.guard();proof.slots(3,256);
    return work.result({kind:'current' as const,eligible,deviceId:owner.deviceId,epoch:owner.epoch,selectionState:selected.state,
     candidate:{inputSha256:selected.inputSha256,sourceSha256:selected.sourceSha256,contextSha256:selected.contextSha256,basisSha256:selected.basisSha256},
     basis:currentDescriptor,sourceProofSha256});
    });
    });
   });
   work.guard();return result;
  });}catch(error){
   // No graph/budget callback or new guard executes after the first refusal.
   // Returning this one Promise preserves invalid original work for its caller.
   alive=false;if(error instanceof ProducerCurrentAsyncFailure)return error.observe();throw error;
  }finally{alive=false;}
 }
 source(input:FeedAdaptiveOwner):Pick<AdaptiveAuthority,'writing'|'source'>{const value=this.current(input);return {writing:value.writing,source:value.source};}
 story(input:FeedAdaptiveOwner,id:string):{story:FeedStory;hidden:string[]}|undefined{
  need(/^[a-f0-9]{64}$/.test(id),'Exact current story ID required');
  return this.snapshot(input,()=>structuredClone(this.news.internalAdaptiveStorySnapshot(id))).value;
 }
}
