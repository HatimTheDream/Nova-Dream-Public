import {types} from 'node:util';
import type {NewsFeed} from './news-feed.js';
import type {FeedAdaptiveOwner} from './feed-adaptive-authority.js';
import type {FeedReadGraph} from '../../packages/domain/news-feed-read-graph.js';
import type {AdaptiveSource,PreferenceCheckpoint} from '../../packages/domain/news-feed-adaptive-capture.js';
import {adaptiveLimits,adaptiveEmptyWritingCurrent,adaptiveWrittenCurrent,checkAdaptiveContextOriginals,adaptiveLearningDecision,
 type AdaptiveWrittenBasis,type AdaptiveResult} from '../../packages/domain/news-feed-adaptive.js';
import {MutationPlanBudget,mutationNeed as need} from './feed-history-projected-inventory.js';
import {SelectionWork} from './feed-adaptive-selection-budget.js';
import {ProducerWork} from './feed-automatic-producer-state.js';
import {withOwnedFeedSourceBytes,type StrictCanonicalView} from './feed-adaptive-owned-codec.js';
import {projectFeedAdaptiveCurrent} from './feed-adaptive-current-projection.js';

type Basis={current:boolean;hash?:string;bytes?:number};
type Scope={graph:FeedReadGraph;source:AdaptiveSource;budget:MutationPlanBudget;alive:boolean;view?:StrictCanonicalView;
 bases:WeakMap<object,Basis>;contextValid?:boolean};
const sources=new WeakMap<object,Scope>(),activeBudgets=new WeakSet<MutationPlanBudget>();
const bodyFixed='{"format":2,"requestId":,"at":,"context":,"basis":,"contextSha256":""}'.length+64;
function reserve(budget:MutationPlanBudget,n:number,bytes:number){budget.reserveBytes(bytes);for(let i=0;i<n;i++)budget.entry();}
/** Read-only custody check for the codec, never a registration or capability.
 * Only this module's fresh copy can be present before its byte view is set.
 * No consumer sees that identity until the view has already been assigned. */
export function isOwnedFeedSourceBeforeView(value:unknown,budget:MutationPlanBudget):boolean{
 // Query frame, checked callback and private lookup record, before allocation.
 reserve(budget,3,192);
 return budget.checked(()=>{
  budget.query();if(value===null||typeof value!=='object')return false;
  const scope=sources.get(value);
  return !!scope&&scope.source===value&&scope.budget===budget&&scope.alive&&activeBudgets.has(budget)&&scope.view===undefined;
 });
}
function own(source:AdaptiveSource,graph:FeedReadGraph,budget:MutationPlanBudget):Scope|undefined{
 const scope=sources.get(source);if(!scope){budget.reserveBytes(0);return undefined;}
 if(scope.budget!==budget){let first:unknown;try{reserve(scope.budget,4,256);scope.budget.fail(Error('Prepared current source budget changed'));}catch(error){first=error;}
  try{budget.fail(first);}catch{/* The genuine first refusal wins. */}throw first;}
 reserve(budget,4,256);return budget.checked(()=>{need(scope.alive&&scope.graph===graph&&scope.source===source&&scope.view,'Prepared current source changed or ended');return scope;});
}
/** Creates its own source with the maintained complete projection; it never
 * adopts a caller source, digest, context or prepared-basis proof. Authority
 * remains the enclosing Store read and its original per-operation guard. */
export function withPreparedFeedSource<T>(owner:Pick<FeedAdaptiveOwner,'deviceId'|'epoch'>,graph:FeedReadGraph,preferences:PreferenceCheckpoint,
 raw:ReturnType<NewsFeed['internalAdaptiveSourceSnapshot']>,work:SelectionWork,consume:(source:AdaptiveSource|null)=>T):T{
 work.reserve(80,6144);
 return work.budget.checked(()=>{
  need(!activeBudgets.has(work.budget),'Prepared source scope reentered');activeBudgets.add(work.budget);
  try{
  const synchronous=(value:T):T=>{
   if(types.isPromise(value)||value!==null&&(typeof value==='object'||typeof value==='function')&&'then'in value){
    if(types.isPromise(value))Promise.prototype.then.call(value,undefined,()=>undefined);
    throw Error('Prepared source consumer must return synchronously');
   }return value;
  };
  const projected=projectFeedAdaptiveCurrent(owner,graph,preferences,raw);work.guard();
  if(!projected.source||!raw.usable)return synchronous(consume(null));
  const source=work.budget.copy(projected.source),scope:Scope={graph,source,budget:work.budget,alive:true,bases:new WeakMap()};
  sources.set(source,scope);let result:T|undefined;
  try{withOwnedFeedSourceBytes(source,work.budget,()=>{need(scope.alive,'Prepared source byte scope ended');},view=>{
    scope.view=view;result=synchronous(consume(source));
   });return result as T;
  }finally{scope.alive=false;}
  }finally{activeBudgets.delete(work.budget);}
 });
}
/** A source already privately owned by this scope needs no second full copy. */
export function isPreparedFeedSource(source:AdaptiveSource,graph:FeedReadGraph,budget:MutationPlanBudget):boolean{return !!own(source,graph,budget);}
export function preparedFeedBasis(work:SelectionWork,graph:FeedReadGraph,source:AdaptiveSource,basis:AdaptiveWrittenBasis):AdaptiveWrittenBasis|null|undefined{
 const scope=own(source,graph,work.budget);if(!scope)return undefined;
 return work.budget.checked(()=>{
  work.guard();work.budget.query();const existing=scope.bases.get(basis);if(existing){work.guard();return basis;}
  work.reserve(8,256+4*source.context.profile.settings.directions.length);
  // Validate only this private immutable copy. Caller identities never become
  // reusable basis proofs, and a later mutation cannot alter this selection.
  const owned=work.budget.copy(basis);
  let current:boolean;
  if(owned.kind==='empty'){
   // Preserve writtenContext()'s independent byte bound. The larger full-source
   // bound is not a proof that this exact writing projection fits it.
   work.reserve(1,64);const writing={epoch:source.context.epoch,deviceId:source.context.deviceId,profile:source.context.profile};
   current=work.measure(writing).bytes<=adaptiveLimits.inputBytes&&work.same(owned,{kind:'empty'})&&adaptiveEmptyWritingCurrent(source.context.profile);
  }else current=work.child(source.context,[source.context.profile,owned],hash=>adaptiveWrittenCurrent(source.context,owned,hash),'basis');
  work.guard();if(!current)return null;scope.bases.set(owned,{current:true});return owned;
 });
}
export function preparedFeedHash(work:SelectionWork,graph:FeedReadGraph,source:AdaptiveSource,part:'source'|'context'):string|undefined{
 const scope=own(source,graph,work.budget);if(!scope)return undefined;
 return work.budget.checked(()=>{work.budget.query();work.guard();const digest=scope.view!.sha256(part);need(digest,'Prepared canonical range missing');work.guard();return digest;});
}
export function preparedFeedBasisHash(work:SelectionWork,graph:FeedReadGraph,source:AdaptiveSource,basis:AdaptiveWrittenBasis):string|undefined{
 const scope=own(source,graph,work.budget);if(!scope)return undefined;
 return work.budget.checked(()=>{const prepared=scope.bases.get(basis);need(prepared?.current,'Prepared current basis missing');
  if(prepared.hash!==undefined){work.budget.query();work.guard();const digest=prepared.hash;work.guard();return digest;}
  const digest=work.hash(basis);prepared.hash=digest;return digest;
 });
}
/** Pure eligibility composition. The exact public capture and historical local
 * envelope reconstruction remain on their full original path. */
export function preparedFeedLearningEligibility(work:SelectionWork,graph:FeedReadGraph,source:AdaptiveSource,basis:AdaptiveWrittenBasis,
 requestId:string,at:number):AdaptiveResult<true>|undefined{
 const scope=own(source,graph,work.budget);if(!scope)return undefined;
 return work.budget.checked(()=>{
  work.guard();work.budget.query();const prepared=scope.bases.get(basis);need(prepared?.current,'Prepared learning basis missing');
  const context=source.context,R=context.activity.length,I=context.learning.interests.length,M=context.learning.suppressed.length;
  // Data was strictly parsed/equal-compared by the unchanged complete source
  // projection. These are context()'s remaining bound and original-ID checks.
  if(scope.contextValid===undefined){
   let labels=0;for(let i=0;i<I;i++)labels+=context.learning.interests[i]!.label.length;
   work.reserve(16+2*R+8*I+2*M,1024+64*(R+I+M)+864*labels);
   const range=scope.view!.contextRange;need(range,'Prepared context range missing');
   try{need(range.end-range.start<=adaptiveLimits.inputBytes,'Input bound');checkAdaptiveContextOriginals(context);scope.contextValid=true;}
   catch{work.budget.reserveBytes(0);scope.contextValid=false;}
  }
  if(!scope.contextValid){work.reserve(1,64);work.guard();return {ok:false,reason:'invalid-learning-context'};}
  // Fixed Zod scalar parses/callbacks/maps/iterators/results; per-row filter
  // refs, source-key strings, two map slots, iteration results, sorted refs.
  // Suppression callbacks retain their exact all-support search.
  let identityUnits=0,supports=0;for(let i=0;i<R;i++)identityUnits+=context.activity[i]!.source.length+context.activity[i]!.sourceId.length+1;
  for(let i=0;i<M;i++)supports+=context.learning.suppressed[i]!.supports.length;
  work.reserve(64+11*R+R*M,4096+256*R+8*identityUnits+32*R*supports);
  // One owned accounting closure, then each callback frame/native collation
  // record before the unchanged timestamp/ID comparison actually executes.
  work.reserve(1,64);const beforeCompare=(left:string,right:string)=>work.reserve(2,128+8*(left.length+right.length));
  let refusal:string|undefined;
  try{refusal=adaptiveLearningDecision(context,requestId,at,beforeCompare);}catch{work.budget.reserveBytes(0);refusal='invalid-learning-context';}
  if(refusal){work.reserve(1,64);work.guard();return {ok:false,reason:refusal};}
  if(prepared.bytes===undefined)prepared.bytes=work.measure(basis).bytes;
  const id=work.measure(requestId),time=work.measure(at),range=scope.view!.contextRange!;
  const bytes=bodyFixed+range.end-range.start+prepared.bytes+id.bytes+time.bytes;
  work.reserve(2,128);work.guard();return bytes<=adaptiveLimits.inputBytes?{ok:true,value:true}:{ok:false,reason:'input-limit'};
 });
}
/** Producer and adaptive bytes are interchangeable only after the tested codec
 * proves every key sequence, stable locale tie and primitive encoding equal. */
export function preparedFeedProducerHash(work:SelectionWork,producer:ProducerWork,graph:FeedReadGraph,source:AdaptiveSource):string{
 const scope=own(source,graph,work.budget);if(!scope)return producer.hash(source);
 if(producer.budget!==work.budget){let first:unknown;try{work.budget.fail(Error('Prepared producer budget changed'));}catch(error){first=error;}
  try{producer.budget.fail(first);}catch{/* Genuine first refusal wins. */}throw first;}
 return work.budget.checked(()=>{work.budget.query();const digest=scope.view!.producerSha256();return digest??producer.hash(source);});
}
