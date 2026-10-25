import {z} from 'zod';
import {canonical} from '../../packages/domain/contracts.js';
import type {FeedReadGraph,FeedReadProjectionLimits} from '../../packages/domain/news-feed-read-graph.js';
import {feedReadProjectionLimits} from '../../packages/domain/news-feed-read-graph.js';
import {remainingLocalObligations,type FeedLocalGraph,type Ledger,type NativeIdentity,verifyFeedLocalGraph,validateFeedLocalRow} from '../../packages/domain/news-feed-successor-journal.js';
import * as legacy from '../../packages/domain/news-feed-semantic-journal.js';
import * as adaptive from '../../packages/domain/news-feed-adaptive-graph.js';
import {feedWorkerPrefix as legacyWorkerPrefix} from '../../packages/domain/news-feed-worker.js';
import {feedWorkerPrefix as adaptiveWorkerPrefix} from '../../packages/domain/news-feed-adaptive-worker.js';
import type {HistoryStoreLimits} from '../../packages/domain/news-feed-history-storage.js';
import {historyLogicalRow} from './feed-history-seal-records.js';
import {verifyHistoryInventory,type HistoryInventoryAccess} from './feed-history-inventory.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import type {MutationPlanBudget} from './feed-history-projected-inventory.js';
import type {SelectedOriginalCollector,SelectedOriginalFacts} from '../../packages/domain/news-feed-selected-originals.js';
import type {FeedWorkerSaved} from '../../packages/domain/news-feed-adaptive-worker.js';

const number=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const limitSchema=z.object({qualification:z.literal('unqualified'),entries:number,bytes:number,copies:number,copyBytes:number}).strict();
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
type Maps={ [K in Exclude<keyof FeedReadGraph,'active'>]:FeedLocalGraph[K] };
type Budget={check:()=>void;retain:(key:string,value:unknown)=>void;wrapper:(kind:string,count?:number)=>void;copy:<T>(value:T)=>T};
function budget(raw:FeedReadProjectionLimits):Budget{
 const limits=limitSchema.parse(raw);need(canonical(limits)===canonical(raw),'Exact read projection limits required');
 let entries=0,bytes=0,copies=0,copyBytes=0,failed=false;
 const checked=<T>(run:()=>T):T=>{need(!failed,'Complete Feed read projection previously failed');try{return run();}catch(error){failed=true;throw error;}};
 const add=(current:number,delta:number,maximum:number)=>{need(Number.isSafeInteger(delta)&&delta>=0&&Number.isSafeInteger(current+delta)&&current+delta<=maximum,'Complete Feed read projection bound exceeded');return current+delta;};
 const retain=(key:string,value:unknown)=>checked(()=>{entries=add(entries,1,limits.entries);const amount=historyJsonBytes([key,value],limits.bytes-bytes);bytes=add(bytes,amount,limits.bytes);});
 return {check:()=>need(!failed,'Complete Feed read projection previously failed'),retain,wrapper(kind,count=1){for(let index=0;index<count;index++)retain('$wrapper',{kind,index});},
  copy<T>(value:T):T{return checked(()=>{copies=add(copies,1,limits.copies);copyBytes=add(copyBytes,historyJsonBytes(value,limits.copyBytes-copyBytes),limits.copyBytes);return structuredClone(value);});}};
}
/** No Map casts: every required ReadonlyMap operation is implemented. Iterators
 * check scope on next/return/throw, including after exhaustion. */
function readMap<K,V>(map:Map<K,V>,guard:()=>void,retention:Budget):ReadonlyMap<K,V>{
 retention.wrapper('read-map');const copy=retention.copy;
 let result:ReadonlyMap<K,V>;
 function iterator<T>(source:Iterator<T>):MapIterator<T>{
  const value:MapIterator<T>&{[Symbol.dispose]():void}={next(){guard();retention.wrapper('iterator-result',2);const item=source.next();guard();return item.done?{done:true,value:undefined}:{done:false,value:copy(item.value)};},
   return(){guard();retention.wrapper('iterator-return-result',2);source.return?.();return {done:true,value:undefined};},throw(error?:unknown){guard();source.throw?.(error);throw error;},[Symbol.iterator](){guard();return this;},[Symbol.dispose](){guard();source.return?.();}};
  return value;
 }
 result=Object.freeze({get size(){guard();return map.size;},has(key:K){guard();return map.has(key);},get(key:K){guard();const value=map.get(key);return value===undefined?undefined:copy(value);},
  keys(){guard();retention.wrapper('iterator',2);return iterator(map.keys());},values(){guard();retention.wrapper('iterator',2);return iterator(map.values());},entries(){guard();retention.wrapper('iterator',2);return iterator(map.entries());},
  forEach(callback:(value:V,key:K,map:ReadonlyMap<K,V>)=>void,thisArg?:unknown){guard();retention.wrapper('forEach-callback');map.forEach((value,key)=>{guard();callback.call(thisArg,copy(value),copy(key),result);guard();});},
  [Symbol.iterator](){guard();retention.wrapper('iterator',2);return iterator(map.entries());}});
 return result;
}
declare const applicationBrand:unique symbol;
/** Private proof data only. Callers cannot register a graph, record or digest. */
export type HistoryLearningApplication=Readonly<{readonly [applicationBrand]:never;record:adaptive.AdaptiveLearningSaved}>;
type ApplicationOwner={guard:()=>void;learning:Maps['learning'];mutations:Maps['mutations'];workers:Maps['adaptiveWorkers'];receipts:Maps['receipts'];retention:Budget};
type ApplicationOwned={owner:ApplicationOwner;graph:FeedReadGraph;record:adaptive.AdaptiveLearningSaved;budget:MutationPlanBudget;digest:string;used:boolean;
 headUsed:boolean;worker?:FeedWorkerSaved;terminalUsed:boolean;sourceUsed:boolean;preferenceUsed:boolean};
const applicationOwners=new WeakMap<FeedReadGraph,ApplicationOwner>(),applications=new WeakMap<object,ApplicationOwned>();
function applicationReserve(budget:MutationPlanBudget,entries:number,bytes:number){budget.reserveBytes(bytes);for(let i=0;i<entries;i++)budget.entry();}
/** Unknown graphs keep the original hash path; known empty scopes return null.
 * Only a complete current schema61/62 read can issue an immutable record. */
export function issueHistoryLearningApplication(graph:FeedReadGraph,id:string,budget:MutationPlanBudget):HistoryLearningApplication|null|undefined{
 // This one lookup/callback slot is charged even for fallback or absence.
 applicationReserve(budget,1,32);
 return budget.checked(()=>{
  const owner=applicationOwners.get(graph);if(!owner)return undefined;
  owner.guard();const original=owner.learning.get(id);if(!original)return null;
  // Together with the lookup and one digest use, this prepays64/4096.
  applicationReserve(budget,59,3936);
  const raw=owner.retention.copy(original),record=budget.copy(raw),receipt=owner.receipts.get(id),admission=receipt?.value as any;
  need(receipt&&receipt.requestId===id&&receipt.deviceId===record.deviceId&&admission?.type==='feed-semantic-learning'&&admission.id===id&&
   admission.epoch===record.command.epoch&&admission.operationId===record.command.operationId&&typeof admission.recordSha256==='string'&&/^[a-f0-9]{64}$/.test(admission.recordSha256),
   'Verified learning application receipt changed');
  const proof=Object.freeze({record}) as HistoryLearningApplication;
  applicationReserve(budget,8,512);
  applications.set(proof,{owner,graph,record,budget,digest:admission.recordSha256,used:false,headUsed:false,terminalUsed:false,sourceUsed:false,preferenceUsed:false});return proof;
 });
}
/** The exact frozen record and original allowance consume this data ticket once.
 * No copied ticket, changed graph, foreign budget or ended read can adopt it. */
export function readHistoryLearningApplicationDigest(proof:HistoryLearningApplication,graph:FeedReadGraph,record:adaptive.AdaptiveLearningSaved,budget:MutationPlanBudget):string{
 const original=applications.get(proof),charged=original?.budget??budget;
 if(original&&original.budget!==budget){
  let first:unknown;try{applicationReserve(charged,4,128);original.budget.fail(Error('Learning application budget provenance changed'));}catch(error){first=error;}
  try{budget.fail(first);}catch{/* The genuine owner's first refusal wins. */}throw first;
 }
 applicationReserve(charged,4,128);
 return budget.checked(()=>{
  need(original&&original.budget===budget&&original.graph===graph&&original.record===record&&proof.record===record&&!original.used,
   'Learning application proof is foreign, changed or consumed');
  original.used=true;
  // The maintained Store token consists of two SQL reads. This is additional
  // to the selector's unchanged hash query and current authorization guards.
  budget.query();budget.query();original.owner.guard();return original.digest;
 });
}
/** Availability is only a data-route decision. It never registers caller data,
 * a digest, permission or result as proved. Unknown graphs keep their fallback. */
export function historyLearningProjectionAvailable(graph:FeedReadGraph,budget:MutationPlanBudget):boolean{
 // An absent owner allocates no wrapper/callback. Still honor first failure.
 budget.reserveBytes(0);const owner=applicationOwners.get(graph);if(!owner)return false;
 // Match the current-source token frame: eight slots/1024 bytes for its two
 // SQL result wrappers and exact small canonical token, plus this lookup.
 applicationReserve(budget,12,1280);
 return budget.checked(()=>{budget.query();budget.query();owner.guard();return true;});
}
function applicationAccess(proof:HistoryLearningApplication,graph:FeedReadGraph,record:adaptive.AdaptiveLearningSaved,budget:MutationPlanBudget):ApplicationOwned{
 const original=applications.get(proof),charged=original?.budget??budget;
 if(original&&original.budget!==budget){
  let first:unknown;try{applicationReserve(charged,12,1152);charged.fail(Error('Learning application budget provenance changed'));}catch(error){first=error;}
  try{budget.fail(first);}catch{/* Preserve the genuine first refusal. */}throw first;
 }
 applicationReserve(charged,12,1152);
 return charged.checked(()=>{need(original&&original.budget===budget&&original.graph===graph&&original.record===record&&proof.record===record,
  'Learning application projection is foreign or changed');
  budget.query();budget.query();original.owner.guard();return original;});
}
/** Return the already issued record only for its identical fully proved head.
 * The selector still performs its original guarded get/equality positions. */
export function readHistoryLearningApplicationHead(proof:HistoryLearningApplication,graph:FeedReadGraph,record:adaptive.AdaptiveLearningSaved,id:string,budget:MutationPlanBudget){
 const original=applicationAccess(proof,graph,record,budget);applicationReserve(budget,4,128);
 return budget.checked(()=>{need(!original.headUsed&&id===record.id&&original.owner.mutations.get(id)===original.owner.learning.get(id),
  'Learning application head changed or was consumed');original.headUsed=true;return record;});
}
/** Replaces exactly one lens get-copy, then owns a deep frozen budget copy. */
export function issueHistoryLearningApplicationWorker(proof:HistoryLearningApplication,graph:FeedReadGraph,record:adaptive.AdaptiveLearningSaved,id:string,budget:MutationPlanBudget):FeedWorkerSaved{
 const original=applicationAccess(proof,graph,record,budget);applicationReserve(budget,8,512);
 return budget.checked(()=>{need(original.headUsed&&!original.worker&&id===record.command.operationId,'Learning application worker stage changed');
  const worker=original.owner.workers.get(id);need(worker&&worker.id===id&&worker.capture.kind==='learn','Learning application worker changed');
  const value=budget.copy(original.owner.retention.copy(worker));original.worker=value;return value;});
}
export function readHistoryLearningApplicationTerminal(proof:HistoryLearningApplication,graph:FeedReadGraph,record:adaptive.AdaptiveLearningSaved,worker:FeedWorkerSaved,terminal:unknown,budget:MutationPlanBudget):string{
 const original=applicationAccess(proof,graph,record,budget);applicationReserve(budget,4,128);
 return budget.checked(()=>{need(original.used&&original.worker===worker&&terminal===worker.terminal&&!original.terminalUsed,'Learning application terminal changed or was consumed');
  original.terminalUsed=true;return record.command.terminalSha256;});
}
export function readHistoryLearningApplicationSource(proof:HistoryLearningApplication,graph:FeedReadGraph,record:adaptive.AdaptiveLearningSaved,worker:FeedWorkerSaved,before:unknown,source:unknown,budget:MutationPlanBudget):boolean{
 const original=applicationAccess(proof,graph,record,budget);applicationReserve(budget,4,128);
 return budget.checked(()=>{need(original.terminalUsed&&!original.sourceUsed&&original.worker===worker&&before===record.before&&source===worker.capture.source,
  'Learning application source changed or was consumed');original.sourceUsed=true;return true;});
}
/** Historical tuple digest only. The selector privately establishes current
 * correspondence; this function does not accept a current source or result. */
export function readHistoryLearningApplicationPreference(proof:HistoryLearningApplication,graph:FeedReadGraph,record:adaptive.AdaptiveLearningSaved,worker:FeedWorkerSaved,budget:MutationPlanBudget):string{
 const original=applicationAccess(proof,graph,record,budget);applicationReserve(budget,4,128);
 return budget.checked(()=>{need(original.sourceUsed&&!original.preferenceUsed&&original.worker===worker&&worker.command.kind==='learn'&&worker.command.basis.kind==='empty-written',
  'Learning application preference changed or was consumed');original.preferenceUsed=true;return worker.command.basis.preferenceProofSha256;});
}
function lexical<T>(maps:Maps,active:FeedReadGraph['active'],retention:Budget,token:()=>string,initial:string,consume:(graph:FeedReadGraph)=>T,verifiedLearning=false):T{
 let alive=true;const guard=()=>{need(alive&&token()===initial,'Complete Feed read lens is no longer current');retention.check();};
 retention.retain('$graph-active',active);retention.wrapper('read-graph');
 // The existing read-projection allowance owns this private owner registration.
 if(verifiedLearning)retention.wrapper('verified-learning-owner',16);
 const wrap=<K,V>(map:Map<K,V>)=>readMap(map,guard,retention);
 const graph:FeedReadGraph=Object.freeze({workers:wrap(maps.workers),reviews:wrap(maps.reviews),adaptiveWorkers:wrap(maps.adaptiveWorkers),adaptiveReviews:wrap(maps.adaptiveReviews),
  learning:wrap(maps.learning),controls:wrap(maps.controls),mutations:wrap(maps.mutations),locals:wrap(maps.locals),originalRequests:wrap(maps.originalRequests),reservedCloseCommands:wrap(maps.reservedCloseCommands),receipts:wrap(maps.receipts),
  get active(){guard();return retention.copy(active);}});
 if(verifiedLearning)applicationOwners.set(graph,{guard,learning:maps.learning,mutations:maps.mutations,workers:maps.adaptiveWorkers,receipts:maps.receipts,retention});
 try{guard();const value=consume(graph),then=value!==null&&(typeof value==='object'||typeof value==='function')?(value as {then?:unknown}).then:undefined;
  if(typeof then==='function'){
   // No read authority remains when the captured original method is observed.
   alive=false;
   void new Promise((resolve,reject)=>{try{Reflect.apply(then,value,[resolve,reject]);}catch(error){reject(error);}})
    .then(()=>undefined,()=>undefined);
   throw Error('Complete Feed read projection must remain synchronous');}
  guard();return value;
 }finally{alive=false;}
}
function chargeMaps(maps:Maps,retention:Budget){for(const map of Object.values(maps))for(const [key,value]of map)retention.retain(key,value);}
export function withLegacyFeedReadGraph<T>(ledger:Ledger,hash:(text:string)=>string,native:NativeIdentity,token:()=>string,consume:(graph:FeedReadGraph)=>T,limits=feedReadProjectionLimits):T{
 const initial=token();need(ledger.schema===60,'Exact schema60 complete reader required');const graph=verifyFeedLocalGraph(ledger,hash,native),retention=budget(limits);
 // The original full schema60 verifier and its materialization are unchanged.
 // These additional counters bound the semantic read wrapper and copied output.
 const maps:Maps={workers:graph.workers,reviews:graph.reviews,adaptiveWorkers:graph.adaptiveWorkers,adaptiveReviews:graph.adaptiveReviews,learning:graph.learning,controls:graph.controls,mutations:graph.mutations,
  locals:graph.locals,originalRequests:graph.originalRequests,reservedCloseCommands:graph.reservedCloseCommands,receipts:graph.receipts};chargeMaps(maps,retention);
 return lexical(maps,{rows:graph.rowCount,bytes:graph.bytes,reserved:remainingLocalObligations(graph,hash)},retention,token,initial,consume);
}
/** Complete actual graph proof precedes semantic materialization. The private
 * access object never crosses this module boundary. There is no legacy ledger. */
export function withHistoryFeedReadGraph<T>(access:HistoryInventoryAccess,storeLimits:HistoryStoreLimits,hash:(text:string)=>string,native:NativeIdentity,
 consume:(graph:FeedReadGraph,selected?:SelectedOriginalFacts)=>T,limits=feedReadProjectionLimits,selected?:SelectedOriginalCollector):T{
 const initial=access.token(),proof=verifyHistoryInventory(access,storeLimits,native,selected),retention=budget(limits);
 const maps:Maps={workers:new Map(),reviews:new Map(),adaptiveWorkers:new Map(),adaptiveReviews:new Map(),learning:new Map(),controls:new Map(),mutations:new Map(),locals:new Map(),originalRequests:new Map(),reservedCloseCommands:new Map(),receipts:new Map()};
 const guard=()=>need(access.token()===initial,'Complete Feed history changed during semantic projection');
 const put=<V>(map:Map<string,V>,key:string,value:V)=>{guard();need(!map.has(key),'Duplicate semantic read identity');retention.retain(key,value);map.set(key,value);};
 for(const receipt of access.receipts())put(maps.receipts,receipt.requestId,receipt);
 function* rows(){for(const object of access.objects('row')){guard();need(object.kind==='row','Unexpected semantic row catalogue');yield historyLogicalRow(access,object.key);}}
 // Resolve workers first so every review/mutation uses its original validator.
 for(const row of rows()){
  if(row.id.startsWith(adaptiveWorkerPrefix)){const worker=adaptive.validateAdaptiveWorkerRow(row,hash,native);put(maps.adaptiveWorkers,worker.id,worker);put(maps.workers,worker.id,worker);}
  else if(row.id.startsWith(legacyWorkerPrefix)){const worker=legacy.validateLegacyWorkerRow(row,hash,native);put(maps.workers,worker.id,worker);}
 }
 for(const row of rows()){
  if(row.id.startsWith(adaptive.adaptiveReviewPrefix)){const raw=adaptive.reviewSchema.parse(row.value),worker=maps.adaptiveWorkers.get(raw.command.operationId);need(worker,'Read review worker missing');
   const review=adaptive.validateAdaptiveReviewRow(row,worker,hash);put(maps.adaptiveReviews,review.record.id,review);put(maps.reviews,review.record.id,review);}
  else if(row.id.startsWith(legacy.feedReviewPrefix)){const raw=legacy.reviewSchema.parse(row.value),worker=maps.workers.get(raw.command.operationId);need(worker&&worker.format!==3,'Read legacy review worker missing');
   put(maps.reviews,raw.id,legacy.validateLegacyReviewRow(row,worker,hash));}
  else if(row.id.startsWith(adaptive.adaptiveLearningPrefix)||row.id.startsWith(adaptive.adaptiveControlPrefix)){
   const learning=row.id.startsWith(adaptive.adaptiveLearningPrefix),raw=(learning?adaptive.learningSchema:adaptive.controlSchema).parse(row.value),operation='operationId'in raw.command?raw.command.operationId:undefined;
   const record=adaptive.validateAdaptiveMutationRow(row,operation?maps.adaptiveWorkers.get(operation):undefined,maps.receipts.get(raw.id),hash);
   if(learning){const value=record as adaptive.AdaptiveLearningSaved;put(maps.learning,value.id,value);}else{const value=record as adaptive.AdaptiveControlSaved;put(maps.controls,value.id,value);}
   put(maps.mutations,record.id,record);
  }else if(row.id.startsWith('news:semantic-local:')){const raw=row.value as {id:string};const value=validateFeedLocalRow(row,maps.receipts.get(raw.id),hash);put(maps.locals,value.id,value);}
 }
 const add=(request:FeedLocalGraph['originalRequests'] extends Map<string,infer V>?V extends {request:infer R}?R:never:never,deviceId:string,at:number)=>{
  const receipt=maps.receipts.get(request.command.requestId);need(receipt,'Complete original receipt missing');put(maps.originalRequests,request.command.requestId,{request,deviceId,at,receipt});};
 for(const worker of maps.workers.values()){add({kind:'start',command:worker.command},worker.deviceId,worker.createdAt);for(const stop of worker.ownerStops)add({kind:'stop',command:stop.command},stop.deviceId,stop.at);}
 for(const review of maps.reviews.values())add({kind:'accept',command:review.record.command},review.record.deviceId,review.record.at);
 for(const row of maps.learning.values())add({kind:'apply-learning',command:row.command},row.deviceId,row.at);
 for(const row of maps.controls.values())add({kind:'control',command:row.command},row.deviceId,row.at);
 for(const row of maps.locals.values())add(row.request,row.deviceId,row.at);
 for(const row of maps.locals.values())if(row.kind==='closed-before-admission'&&!maps.originalRequests.has(row.close.requestId))put(maps.reservedCloseCommands,row.close.requestId,{request:{kind:'close',command:row.close},deviceId:row.deviceId,at:row.at});
 if(selected)retention.wrapper('selected-complete-callback');
 guard();return lexical(maps,proof.active,retention,access.token,initial,graph=>consume(graph,proof.selectedOriginals),true);
}
