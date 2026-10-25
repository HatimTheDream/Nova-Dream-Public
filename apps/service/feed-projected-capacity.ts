import {DraftCapacityContext} from './feed-draft-capacity.js';
import {bootstrapTaskCatalogue,consumeTaskCatalogueEffect,type TaskCatalogueCustody,type TaskCatalogueEffect} from './task-relation-catalogue.js';
import {types as nodeTypes} from 'node:util';
import {ProducerWork,type ProducerTransition,type ProducerState} from './feed-automatic-producer-state.js';
import {producerFacts,producerMemoReader,ProducerProof,checkProducerReservation,type ProducerFacts,type ProducerStored,type ProducerOverride} from './feed-automatic-producer-store.js';
import {producerSequenceFootprint,type HistorySequenceLimits,type HistoryWriteSequence,type HistoryCompletionRecipe} from './feed-history-write-sequence.js';
import type {CompletionReader} from './feed-completion-reader.js';
import type {NativeIdentity} from '../../packages/domain/news-feed-successor-journal.js';
import type {DatabaseSync} from 'node:sqlite';
import type {HistoryStoreLimits} from '../../packages/domain/news-feed-history-storage.js';
import type {CompletionAmount,CompletionResult} from './feed-completion-contract.js';
import {completionFixtureLimits} from './feed-completion-contract.js';
import {MutationPlanBudget} from './feed-history-projected-inventory.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import {withActualCompletionReader,withActualProducerCompletionContext,withProjectedProducerCompletion,withPendingProducerGraph,withPendingCompletionReader,
 type ProducerCompletionPorts,type ProducerActualContext,type ProducerPendingView} from './feed-history-completion-reader.js';
import type {SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';
import type {FeedReadGraph} from '../../packages/domain/news-feed-read-graph.js';
import {assembleCompletionEnvelope} from './feed-completion-assembler.js';
import {withProjectedCompletionReader,type PreparedCompletionReceipt} from './feed-projected-completion-reader.js';
import {assertProjectedCapacity,capacitySum,capacityReplace,combineProducerCompletion,type ProjectedCapacityPolicy} from './feed-projected-capacity-policy.js';
import {settleTaskFocusStartup} from './feed-task-focus-capacity.js';

type Ports={db:DatabaseSync;openText:(aad:string,payload:Uint8Array)=>string;sequence:HistorySequenceLimits;open:(aad:string,payload:Uint8Array)=>any;limits:HistoryStoreLimits;native:NativeIdentity;token:()=>string;policy:ProjectedCapacityPolicy;seal?:(aad:string,value:unknown)=>Buffer};
declare const planBrand:unique symbol;
export type ProducerPreparedPlan=Readonly<{readonly [planBrand]:never;before:ProducerStored|undefined;after:ProducerState;value:ReturnType<ProducerWork['receipt']>;digest:string}>;
// Only prepareProducer registers a reducer-derived plan. This registry has no
// adoption API; a structural copy cannot acquire a phase-one selector.
type ProducerPlanOwner={select:(owner:ProducerCompletionPorts,budget:MutationPlanBudget)=>ProducerState};
const producerPlans=new WeakMap<object,ProducerPlanOwner>();
export function selectProducerPreparedState(plan:ProducerPreparedPlan,owner:ProducerCompletionPorts,budget:MutationPlanBudget):ProducerState{
 const registered=producerPlans.get(plan);if(!registered)return budget.fail(Error('Producer transition plan is not registered'));
 return registered.select(owner,budget);
}
type PendingRoute='draft'|'content'|'producer'|'task'|'focus';
type PendingInvocation={route:PendingRoute;pending:SemanticReceipt;current:CompletionAmount;status:'opening'|'callback'|'consuming'|'consumed'|'closing'|'closed-success'|'closed-failure';
 actual?:ProducerActualContext;view?:ProducerPendingView;plan?:ProducerPreparedPlan};
export type CompletionSequenceFootprint=Readonly<{firstCiphertextBytes:number;lastCiphertextBytes:number;newEntries:number;outgoingCiphertextBytes:number}>;
export type DraftCapacityFootprint=Readonly<{previousEntityBytes:number;entityBytes:number;historyBytes:number;receiptBytes:number;
 baseNewEntries:number;previousReferences:number;nextReferences:number;newReferenceEntries:number}>;
export type TaskCapacityFootprint=Readonly<{taskId:string;taskRevision:number;previousEntityBytes:number;entityBytes:number;historyBytes:number;receiptBytes:number;
 baseNewEntries:number;services:readonly Readonly<{role:'credit'|'event'|'focus'|'notification'|'old-reminder'|'new-reminder'|'mapping';key:string;previousBytes:number;nextBytes:number;absent:boolean}>[]}>;
export type TaskFocusCapacityFootprint=Readonly<{taskId:string;key:string;previousBytes:number;focusBytes:number;receiptBytes:number;absent:boolean}>;
const payloadTables=['entities','history','receipts','service_records','blobs','feed_history_objects'] as const;
// Every application table is counted. SQLite's internal indexes/sequences and
// metadata text are not encrypted payloads; their physical allocation is held.
const totalsSql="SELECT SUM(n) AS entries,SUM(bytes) AS bytes,SUM(bad)+(SELECT count(*) FROM main.sqlite_master WHERE type='trigger' OR (type='table' AND name NOT IN ('entities','history','receipts','service_records','blobs','feed_history_objects','meta','sessions','blob_refs','sqlite_sequence'))) AS bad FROM ("+
 payloadTables.map(table=>`SELECT count(*) AS n,COALESCE(SUM(length(payload)),0) AS bytes,COALESCE(SUM(CASE WHEN typeof(payload)='blob' AND length(payload)>=28 THEN 0 ELSE 1 END),0) AS bad FROM ${table}`).join(' UNION ALL ')+
 " UNION ALL SELECT count(*),0,0 FROM meta UNION ALL SELECT count(*),0,0 FROM sessions UNION ALL SELECT count(*),0,0 FROM blob_refs)";

/** Store-owned source-only context. The three phase maxima and scalar budget
 * are allocated exactly once. Unused replay phases are never repurposed. */
export class ProjectedCapacityTransaction{
 private readonly phases=[new MutationPlanBudget(completionFixtureLimits),new MutationPlanBudget(completionFixtureLimits),new MutationPlanBudget(completionFixtureLimits)] as const;
 private readonly metadata=new MutationPlanBudget({qualification:'unqualified',entries:128,bytes:16384,queries:128});
 private state:'unselected'|'replay'|'initial'|'projected'|'final'|'closed'='unselected';
 private producer?:ProducerFacts;
 private taskRequest?:Readonly<{requestId:string;digest:string;device:string;reserved:boolean;budget:MutationPlanBudget}>;private taskRequestConsumed=false;
 private failed=false;private failure:unknown;private initialTotals?:CompletionAmount;private projectedTotals?:CompletionAmount;
 private plan?:ProducerPreparedPlan;private planUsed=false;private planSelected=false;private invocation?:PendingInvocation;private projectedReady=false;
 private startupNoEffectToken?:string;
 constructor(private p:Ports,private readonly owner:ProducerCompletionPorts=p){if(!p.db.isTransaction)throw Error('Capacity requires original Store transaction');
  if(owner.db!==p.db||owner.open!==p.open||owner.openText!==p.openText||owner.sequence!==p.sequence||owner.token!==p.token||owner.limits!==p.limits||owner.native!==p.native)throw Error('Capacity Store owner changed');}
 checked<T>(fn:()=>T):T{if(this.failed)throw this.failure;
  try{if(this.state==='closed'||!this.p.db.isTransaction)throw Error('Capacity transaction ended');return fn();}catch(error){if(!this.failed){this.failed=true;this.failure=error;}throw this.failure;}}
 private totals():CompletionAmount{return this.metadata.checked(()=>{
  // Four fixed slots cover the scalar SQL result, returned amount, and the
  // caller projected amount/footprint wrappers. They are reserved before SQL.
  for(let i=0;i<4;i++)this.metadata.entry();this.metadata.reserveBytes(512);this.metadata.query();
  const row=this.p.db.prepare(totalsSql).get() as {entries:number;bytes:number;bad:number};
  if(row.bad!==0||!Number.isSafeInteger(row.entries)||row.entries<0||!Number.isSafeInteger(row.bytes)||row.bytes<0)throw Error('Complete application totals unavailable');
  return Object.freeze({entries:row.entries,ciphertextBytes:row.bytes});
 });}
 private combined(reader:CompletionReader,budget:MutationPlanBudget,stored:ProducerOverride|undefined){
  const semantic=assembleCompletionEnvelope(reader,budget),producer=producerFacts(reader,budget,stored);
  budget.entry();budget.reserveBytes(64);return {result:combineProducerCompletion(semantic,producer,budget),producer};
 }
 private actual(index:0|2,selection?:{requestId:string;reserved:boolean}):CompletionResult{return withActualProducerCompletionContext(this.owner,this.phases[index],{kind:'stored-slot'},context=>{
  const budget=this.phases[index],reader=producerMemoReader(context.reader,budget),combined=this.combined(reader,budget,context.stored);if(index===0)this.producer=combined.producer;
  if(selection){if(index!==0)throw Error('Task reservation selection requires initial proof');
   if(combined.result.kind==='sized')for(let i=0;i<combined.result.obligations.length;i++){
    budget.entry();const item=combined.result.obligations[i]!;
    if(item.kind==='pending-close'&&item.identity.id===selection.requestId)selection.reserved=true;
   }
  }return combined.result;
 });}
 checkReceipt(requestId:string,digest:string,device:string,budget:MutationPlanBudget){return this.checked(()=>{if(this.state!=='initial'&&this.state!=='projected')throw Error('Producer reservations require initial proof');checkProducerReservation(this.producer,requestId,digest,device,new ProducerWork(budget));});}
 prepareProducer(owner:string,command:ProducerTransition){return this.checked(()=>{
  if(this.state!=='unselected')throw Error('Producer initial phase repeated');this.state='initial';this.initialTotals=this.totals();const budget=this.phases[0];
  return withActualProducerCompletionContext(this.owner,budget,{kind:'stored-slot'},context=>{
   const reader=producerMemoReader(context.reader,budget),before=context.stored,combined=this.combined(reader,budget,before);this.producer=combined.producer;
   assertProjectedCapacity(this.p.policy,{current:this.initialTotals!,projected:this.initialTotals!,newEntries:0,outgoingCiphertextBytes:0},combined.result,this.metadata);
   const proof=new ProducerProof(reader,budget,context.state),work=proof.work,after=proof.prepareTransition(command,owner);
   const value=work.receipt(before?.state,after,command),digest=work.hash(work.intent(command));work.slots(4,320);
   const plan=Object.freeze({before,after,value:budget.copy(value),digest}) as ProducerPreparedPlan;this.plan=plan;
   producerPlans.set(plan,{select:(candidate,phase)=>this.checked(()=>{
    if(candidate!==this.owner||phase!==this.phases[1]||this.state!=='projected'||this.plan!==plan||!this.planUsed||this.planSelected||
     this.invocation?.plan!==plan||this.invocation.status!=='opening')throw Error('Producer transition plan selection is foreign, expired or repeated');
    this.planSelected=true;return after;
   })});return plan;
  });
 });}
 withPendingEffects(route:PendingRoute,pending:SemanticReceipt,sequence:HistoryWriteSequence,consume:(graph:FeedReadGraph)=>void,plan?:ProducerPreparedPlan):void{return this.checked(()=>{
  if(this.state!=='initial'||!this.initialTotals||this.invocation||this.projectedReady)throw Error('Pending projected phase is not current');
  if(route!=='draft'&&route!=='content'&&route!=='producer'&&route!=='task'&&route!=='focus')throw Error('Unknown pending capacity route');
  if(route==='producer'?(plan!==this.plan||!plan||this.planUsed):plan!==undefined)throw Error('Producer transition plan provenance changed');
  if(this.taskRequest){const selected=this.taskRequest;
   if(route!=='task'||selected.reserved||this.taskRequestConsumed||sequence.budget!==selected.budget||pending.requestId!==selected.requestId||pending.digest!==selected.digest||pending.deviceId!==selected.device)throw Error('Task reservation selection is foreign, reserved or consumed');
   this.taskRequestConsumed=true;
  }
  this.state='projected';if(plan)this.planUsed=true;
  const current=this.totals();if(current.entries!==this.initialTotals.entries||current.ciphertextBytes!==this.initialTotals.ciphertextBytes)throw Error('Capacity current occupancy changed before pending effects');
  const budget=this.phases[1];budget.entry();budget.reserveBytes(256);
  const invocation:PendingInvocation={route,pending,current,status:'opening',plan};this.invocation=invocation;
  let success=false,rejectedReturn:unknown;
  try{
   withActualProducerCompletionContext(this.owner,budget,plan?{kind:'producer-plan',plan}:{kind:'stored-slot'},actual=>{
    invocation.actual=actual;
    withPendingProducerGraph(actual,sequence,pending,budget,(graph,view)=>{
     this.checked(()=>{if(invocation.status!=='opening'||this.invocation!==invocation)throw Error('Pending invocation changed');invocation.view=view;invocation.status='callback';});
     const result=consume(graph);if(result!==undefined)rejectedReturn=result;
     // Close the consumer window before inspecting callback outcome. A caught
     // duplicate/inner failure remains latched in this transaction.
     const consumed=(invocation.status as PendingInvocation['status'])==='consumed';invocation.status='closing';
     this.checked(()=>{if(result!==undefined||!consumed||this.invocation!==invocation)throw Error('Pending capacity callback did not consume exactly once');budget.checked(()=>undefined);});
    });
   });
   this.checked(()=>{if(this.invocation!==invocation||invocation.status!=='closing')throw Error('Pending capacity scopes did not close');budget.checked(()=>undefined);});
   invocation.status='closed-success';this.projectedReady=true;success=true;
  }finally{
   invocation.actual=undefined;invocation.view=undefined;if(!success)invocation.status='closed-failure';
   if(plan)producerPlans.delete(plan);
   // Both proof scopes and the invocation have ended before observing a real
   // Promise rejection. Never read or invoke an arbitrary callback thenable.
   try{if(nodeTypes.isPromise(rejectedReturn))Promise.prototype.then.call(rejectedReturn,undefined,()=>undefined);}catch{/* Preserve the original refusal. */}
  }
 });}
 private consumePending(route:PendingRoute,pending:PreparedCompletionReceipt):PendingInvocation{
  const invocation=this.invocation;
  if(this.state!=='projected'||!invocation||invocation.route!==route||invocation.status!=='callback'||!invocation.actual||!invocation.view||pending.receipt!==invocation.pending)throw Error('Pending capacity consumer is foreign, expired or duplicated');
  invocation.status='consuming';return invocation;
 }
 beforeProducerEffects(pending:PreparedCompletionReceipt,after:ProducerOverride,previousBytes:number){return this.checked(()=>{
  const invocation=this.consumePending('producer',pending),current=invocation.current,plan=invocation.plan;
  if(!plan||after.state!==plan.after||previousBytes!==(this.producer?.ciphertextBytes??0)||previousBytes!==(plan.before?.ciphertextBytes??0))throw Error('Producer prepared state or occupancy changed');
  const newEntries=previousBytes===0?2:1,outgoing=capacitySum(after.ciphertextBytes,pending.ciphertextBytes);
  const projected=Object.freeze({entries:capacitySum(current.entries,newEntries),ciphertextBytes:capacityReplace(current.ciphertextBytes,previousBytes,outgoing)});this.projectedTotals=projected;
  const budget=this.phases[1],before=invocation.actual!.reader.current();budget.entry();budget.reserveBytes(128);
  const narrow=Object.freeze({entries:capacitySum(before.entries,1),ciphertextBytes:capacitySum(before.ciphertextBytes,pending.ciphertextBytes)});
  const result=withPendingCompletionReader(invocation.view!,pending,narrow,budget,raw=>this.combined(producerMemoReader(raw,budget),budget,after).result);
  assertProjectedCapacity(this.p.policy,{current,projected,newEntries,outgoingCiphertextBytes:outgoing},result,this.metadata);
  invocation.status='consumed';
 });}
 replay(){return this.checked(()=>{if(this.state!=='unselected')throw Error('Capacity replay cannot replace fresh work');this.state='replay';});}
 initial(){return this.checked(()=>{if(this.state!=='unselected')throw Error('Capacity initial phase repeated');this.state='initial';
  this.initialTotals=this.totals();const result=this.actual(0);
  assertProjectedCapacity(this.p.policy,{current:this.initialTotals,projected:this.initialTotals,newEntries:0,outgoingCiphertextBytes:0},result,this.metadata);
 });}
 /** Receiptless Focus restart: semantic/producer debt is unchanged. Keep the
  * original actual result private through preparation, then prove actual saved
  * state again in finish(). No pending command phase or reusable proof exists. */
 settleFocusStartup(sequence:HistoryWriteSequence):void{return this.checked(()=>{
  if(this.state!=='unselected'||!this.p.seal)throw Error('Focus startup capacity is unavailable or selected');
  for(let i=0;i<8;i++)this.metadata.entry();this.metadata.reserveBytes(512);
  this.state='initial';this.initialTotals=this.totals();const result=this.actual(0);
  settleTaskFocusStartup(this.owner,sequence,this.p.seal,footprint=>this.checked(()=>{
   if(this.state!=='initial'||this.projectedReady)throw Error('Focus startup projection is repeated');
   const current=this.totals();if(current.entries!==this.initialTotals!.entries||current.ciphertextBytes!==this.initialTotals!.ciphertextBytes)throw Error('Focus startup occupancy changed before effects');
   const budget=sequence.budget;for(let i=0;i<4;i++)budget.entry();budget.reserveBytes(128);budget.query();budget.query();
   const token=this.owner.token();if(typeof token!=='string'||historyJsonBytes(token,4096)>4096||token!==result.originalToken)throw Error('Focus startup source changed before effects');budget.bytes(token);
   const projected=Object.freeze({entries:current.entries,ciphertextBytes:capacityReplace(current.ciphertextBytes,footprint.previousBytes,footprint.nextBytes)});
   if(footprint.records===0){
    if(footprint.previousBytes!==0||footprint.nextBytes!==0)throw Error('Focus startup empty plan has a ciphertext effect');
    // A complete identity transition does not need new-write headroom. Keep
    // read/replay access to valid retained debt, but prove no effect at finish.
    this.startupNoEffectToken=token;
   }else{
    assertProjectedCapacity(this.p.policy,{current:this.initialTotals!,projected:this.initialTotals!,newEntries:0,outgoingCiphertextBytes:0},result,this.metadata);
    assertProjectedCapacity(this.p.policy,{current,projected,newEntries:0,outgoingCiphertextBytes:footprint.nextBytes},result,this.metadata);
   }
   this.projectedTotals=projected;this.state='projected';this.projectedReady=true;
  }));
  this.assertEffectsReady();
 });}
 /** Held complete Task catalogue derivation; no synthetic pending receipt. */
 settleTaskCatalogueStartup(sequence:HistoryWriteSequence):TaskCatalogueCustody{return this.checked(()=>{
  if(this.state!=='unselected'||!this.p.seal)throw Error('Task catalogue startup unavailable');
  this.state='initial';this.initialTotals=this.totals();const original=this.actual(0),budget=sequence.budget;
  const context:DraftCapacityContext=new DraftCapacityContext({db:this.owner.db,budget,limits:this.p.sequence,recordBytes:this.p.limits.objectBytes,
   guard:()=>sequence.checked(()=>undefined),openText:this.owner.openText,seal:this.p.seal});
  try{
   const epoch=context.meta('epoch');context.need(typeof epoch==='string','Task catalogue epoch missing');
   return bootstrapTaskCatalogue({db:this.owner.db,limits:this.p.limits,context,budget,epoch,openText:this.owner.openText,guard:()=>sequence.checked(()=>undefined)},amount=>this.checked(()=>{
    if(this.state!=='initial'||this.projectedReady)throw Error('Task catalogue startup admission repeated');
    const current=this.totals();if(current.entries!==this.initialTotals!.entries||current.ciphertextBytes!==this.initialTotals!.ciphertextBytes)throw Error('Task catalogue startup occupancy changed');
    const projected=Object.freeze({entries:capacitySum(current.entries,amount.absent?1:0),ciphertextBytes:capacityReplace(current.ciphertextBytes,amount.previousBytes,amount.nextBytes)});
    if(amount.absent)assertProjectedCapacity(this.p.policy,{current,projected,newEntries:1,outgoingCiphertextBytes:amount.nextBytes},original,this.metadata);
    else this.startupNoEffectToken=original.originalToken;
    this.projectedTotals=projected;this.state='projected';this.projectedReady=true;
   }));
  }finally{context.close();}
 });}
 /** Select one exact Close reservation from the complete initial proof. The
  * private result is usable only by this request's composed Task pending scope. */
 initialTaskRequest(requestId:string,digest:string,device:string,sharedBudget:MutationPlanBudget):boolean{return this.checked(()=>this.phases[0].checked(()=>{
  if(this.state!=='unselected')throw Error('Capacity Task initial phase repeated');this.state='initial';const budget=this.phases[0];
  // Two fixed wrappers and their fields/references are prepaid before creation.
  // Inputs are already captured primitive command fields, never copied payloads.
  for(let i=0;i<12;i++)budget.entry();budget.reserveBytes(512);
  if(typeof requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)||
   typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||typeof device!=='string'||device.length>8192)throw Error('Task reservation identity is invalid');
  const selected={requestId,reserved:false};this.initialTotals=this.totals();const result=this.actual(0,selected);
  assertProjectedCapacity(this.p.policy,{current:this.initialTotals,projected:this.initialTotals,newEntries:0,outgoingCiphertextBytes:0},result,this.metadata);
  this.checkReceipt(requestId,digest,device,sharedBudget);
  // The actual reader and selected-original scopes have closed before this
  // final maintained token check. No bit survives a late source change.
  budget.query();budget.query();for(let i=0;i<4;i++)budget.entry();budget.reserveBytes(128);
  const token=this.owner.token();if(typeof token!=='string'||historyJsonBytes(token,4096)>4096||token!==result.originalToken)throw Error('Task reservation source changed before publication');
  return budget.checked(()=>this.checked(()=>{
   if(this.state!=='initial'||this.taskRequest)throw Error('Task reservation initial scope ended');sharedBudget.checked(()=>undefined);
   this.taskRequest=Object.freeze({requestId,digest,device,reserved:selected.reserved,budget:sharedBudget});return selected.reserved;
  }));
 }));}
 /** Own the existing final coalesced proof, using the original sequence owner. */
 beforeEffects(recipe:HistoryCompletionRecipe,sequence:HistoryWriteSequence){return this.checked(()=>{
  if(this.taskRequest)throw Error('Task reservation selection requires its pending Task consumer');
  const footprint=producerSequenceFootprint(sequence,this.owner,recipe);
  if(this.state!=='initial'||!this.initialTotals)throw Error('Capacity projected phase is not current');this.state='projected';
  const current=this.totals();if(current.entries!==this.initialTotals.entries||current.ciphertextBytes!==this.initialTotals.ciphertextBytes)throw Error('Capacity current occupancy changed before effects');
  const projected=Object.freeze({entries:capacitySum(current.entries,footprint.newEntries),ciphertextBytes:capacityReplace(current.ciphertextBytes,footprint.firstCiphertextBytes,footprint.lastCiphertextBytes)});
  this.projectedTotals=projected;
  const budget=this.phases[1];const result=withActualProducerCompletionContext(this.owner,budget,{kind:'stored-slot'},actual=>{
   const prior=actual.reader.current();budget.entry();budget.reserveBytes(128);
   const narrow=Object.freeze({entries:capacitySum(prior.entries,footprint.newEntries),ciphertextBytes:capacityReplace(prior.ciphertextBytes,footprint.firstCiphertextBytes,footprint.lastCiphertextBytes)});
   budget.entry();budget.reserveBytes(192);
   return withProjectedProducerCompletion(actual,recipe,narrow,sequence,budget,raw=>this.combined(producerMemoReader(raw,budget),budget,actual.stored).result);
  });
  assertProjectedCapacity(this.p.policy,{current,projected,newEntries:footprint.newEntries,outgoingCiphertextBytes:footprint.outgoingCiphertextBytes},result,this.metadata);
  this.projectedReady=true;
 });}
 /** Closed draft sink: only its generic receipt enters the N1 inventory. */
 beforeDraftEffects(pending:PreparedCompletionReceipt,f:DraftCapacityFootprint){return this.beforeEntityEffects('draft',pending,f);}
 /** Closed saved Content sink, with the identical actual row/cipher footprint. */
 beforeContentEffects(pending:PreparedCompletionReceipt,f:DraftCapacityFootprint){return this.beforeEntityEffects('content',pending,f);}
 /** Task owns only seven fixed service roles; all of them remain outside N1. */
 beforeTaskEffects(pending:PreparedCompletionReceipt,f:TaskCapacityFootprint){return this.checked(()=>{
  if(this.taskRequest)throw Error('Task reservation selection requires its pending Task consumer');
  if(this.state!=='initial'||!this.initialTotals)throw Error('Capacity Task projected phase is not current');this.state='projected';
  if(pending.ciphertextBytes!==f.receiptBytes||f.services.length>7||typeof f.taskId!=='string'||f.taskId.length>100||!f.taskId.startsWith('task:')||!Number.isSafeInteger(f.taskRevision)||f.taskRevision<1)throw Error('Task footprint identity changed');
  this.metadata.entry();this.metadata.reserveBytes(4096);
  const roles=new Set<string>(),keys=new Set<string>();let previousServiceBytes=0,serviceBytes=0,newServiceEntries=0;
  for(const row of f.services){
   this.metadata.entry();this.metadata.entry();
   const expected=row.role==='credit'?'tasks:credit:'+f.taskId:row.role==='event'?'tasks:event:'+f.taskId+':'+f.taskRevision:row.role==='focus'?'tasks:focus:'+f.taskId:row.role==='mapping'?'reminders:task:'+f.taskId:undefined;
   const valid=expected!==undefined?row.key===expected:row.role==='notification'?row.key.startsWith('reminders:attempt:'):row.role==='old-reminder'||row.role==='new-reminder'?row.key.startsWith('reminders:item:'):false;
   if(!valid||roles.has(row.role)||keys.has(row.key)||typeof row.absent!=='boolean'||row.absent&&row.previousBytes!==0||!row.absent&&row.previousBytes<28||row.nextBytes<28)throw Error('Task service footprint invalid');
   roles.add(row.role);keys.add(row.key);previousServiceBytes=capacitySum(previousServiceBytes,row.previousBytes);serviceBytes=capacitySum(serviceBytes,row.nextBytes);if(row.absent)newServiceEntries++;
  }
  const current=this.totals();if(current.entries!==this.initialTotals.entries||current.ciphertextBytes!==this.initialTotals.ciphertextBytes)throw Error('Capacity current occupancy changed before Task effects');
  const outgoing=capacitySum(f.entityBytes,f.historyBytes,f.receiptBytes,serviceBytes),newEntries=capacitySum(f.baseNewEntries,newServiceEntries);
  const projected=Object.freeze({entries:capacitySum(current.entries,newEntries),ciphertextBytes:capacityReplace(current.ciphertextBytes,capacitySum(f.previousEntityBytes,previousServiceBytes),outgoing)});this.projectedTotals=projected;
  const budget=this.phases[1],result=withActualCompletionReader(this.p.db,this.p.open,this.p.limits,this.p.native,this.p.token,budget,actual=>{
   const before=actual.current();budget.entry();budget.reserveBytes(128);
   const narrow=Object.freeze({entries:capacitySum(before.entries,1),ciphertextBytes:capacitySum(before.ciphertextBytes,f.receiptBytes)});
   budget.entry();budget.reserveBytes(2);return withProjectedCompletionReader(actual,[],pending,narrow,budget,reader=>assembleCompletionEnvelope(reader,budget));
  });
  assertProjectedCapacity(this.p.policy,{current,projected,newEntries,outgoingCiphertextBytes:outgoing},result,this.metadata);
  this.projectedReady=true;
 });}
 /** Task composition consumes the existing pending proof and producer debt. */
 beforeComposedTaskEffects(pending:PreparedCompletionReceipt,f:TaskCapacityFootprint,catalogue?:TaskCatalogueEffect){return this.checked(()=>{
  const invocation=this.consumePending('task',pending),current=invocation.current;
  if(pending.ciphertextBytes!==f.receiptBytes||f.services.length>7||typeof f.taskId!=='string'||f.taskId.length>100||!f.taskId.startsWith('task:')||!Number.isSafeInteger(f.taskRevision)||f.taskRevision<1)throw Error('Task footprint identity changed');
  this.metadata.entry();this.metadata.reserveBytes(4096);
  const roles=new Set<string>(),keys=new Set<string>();let previousServiceBytes=0,serviceBytes=0,newServiceEntries=0;
  for(const row of f.services){
   this.metadata.entry();this.metadata.entry();
   const expected=row.role==='credit'?'tasks:credit:'+f.taskId:row.role==='event'?'tasks:event:'+f.taskId+':'+f.taskRevision:row.role==='focus'?'tasks:focus:'+f.taskId:row.role==='mapping'?'reminders:task:'+f.taskId:undefined;
   const valid=expected!==undefined?row.key===expected:row.role==='notification'?row.key.startsWith('reminders:attempt:'):row.role==='old-reminder'||row.role==='new-reminder'?row.key.startsWith('reminders:item:'):false;
   if(!valid||roles.has(row.role)||keys.has(row.key)||typeof row.absent!=='boolean'||row.absent&&row.previousBytes!==0||!row.absent&&row.previousBytes<28||row.nextBytes<28)throw Error('Task service footprint invalid');
   roles.add(row.role);keys.add(row.key);previousServiceBytes=capacitySum(previousServiceBytes,row.previousBytes);serviceBytes=capacitySum(serviceBytes,row.nextBytes);if(row.absent)newServiceEntries++;
  }
  // Derived catalogue occupancy is separate from all seven fixed service roles.
  this.metadata.entry();this.metadata.reserveBytes(128);
  const derived=catalogue?consumeTaskCatalogueEffect(catalogue,this.owner.db,this.taskRequest!.budget):undefined;
  const outgoing=capacitySum(f.entityBytes,f.historyBytes,f.receiptBytes,serviceBytes,derived?.nextBytes??0),newEntries=capacitySum(f.baseNewEntries,newServiceEntries,derived?.absent?1:0);
  const projected=Object.freeze({entries:capacitySum(current.entries,newEntries),ciphertextBytes:capacityReplace(current.ciphertextBytes,capacitySum(f.previousEntityBytes,previousServiceBytes,derived?.previousBytes??0),outgoing)});this.projectedTotals=projected;
  const budget=this.phases[1],before=invocation.actual!.reader.current();budget.entry();budget.reserveBytes(128);
  const narrow=Object.freeze({entries:capacitySum(before.entries,1),ciphertextBytes:capacitySum(before.ciphertextBytes,f.receiptBytes)});
  const result=withPendingCompletionReader(invocation.view!,pending,narrow,budget,raw=>this.combined(producerMemoReader(raw,budget),budget,invocation.actual!.stored).result);
  assertProjectedCapacity(this.p.policy,{current,projected,newEntries,outgoingCiphertextBytes:outgoing},result,this.metadata);
  invocation.status='consumed';
 });}
 /** Fixed Focus row and original receipt, under the existing pending proof. */
 beforeTaskFocusEffects(pending:PreparedCompletionReceipt,f:TaskFocusCapacityFootprint){return this.checked(()=>{
  const invocation=this.consumePending('focus',pending),current=invocation.current;
  this.metadata.entry();this.metadata.reserveBytes(512);
  if(typeof f.taskId!=='string'||f.taskId.length>100||f.key!=='tasks:focus:'+f.taskId||typeof f.absent!=='boolean'||
    (f.absent?f.previousBytes!==0:f.previousBytes<28)||f.focusBytes<28||pending.ciphertextBytes!==f.receiptBytes)throw Error('Focus footprint identity changed');
  const outgoing=capacitySum(f.focusBytes,f.receiptBytes),newEntries=f.absent?2:1;
  const projected=Object.freeze({entries:capacitySum(current.entries,newEntries),ciphertextBytes:capacityReplace(current.ciphertextBytes,f.previousBytes,outgoing)});this.projectedTotals=projected;
  const budget=this.phases[1],before=invocation.actual!.reader.current();budget.entry();budget.reserveBytes(128);
  const narrow=Object.freeze({entries:capacitySum(before.entries,1),ciphertextBytes:capacitySum(before.ciphertextBytes,f.receiptBytes)});
  const result=withPendingCompletionReader(invocation.view!,pending,narrow,budget,raw=>this.combined(producerMemoReader(raw,budget),budget,invocation.actual!.stored).result);
  assertProjectedCapacity(this.p.policy,{current,projected,newEntries,outgoingCiphertextBytes:outgoing},result,this.metadata);
  invocation.status='consumed';
 });}
 private beforeEntityEffects(route:'draft'|'content',pending:PreparedCompletionReceipt,f:DraftCapacityFootprint){return this.checked(()=>{
  const invocation=this.consumePending(route,pending),current=invocation.current;
  if(pending.ciphertextBytes!==f.receiptBytes)throw Error('Draft receipt ciphertext footprint changed');
  const outgoing=capacitySum(f.entityBytes,f.historyBytes,f.receiptBytes),newEntries=capacitySum(f.baseNewEntries,f.newReferenceEntries);
  const projected=Object.freeze({entries:capacityReplace(capacitySum(current.entries,f.baseNewEntries),f.previousReferences,f.nextReferences),
   ciphertextBytes:capacityReplace(current.ciphertextBytes,f.previousEntityBytes,outgoing)});this.projectedTotals=projected;
  const budget=this.phases[1],before=invocation.actual!.reader.current();budget.entry();budget.reserveBytes(128);
   const narrow=Object.freeze({entries:capacitySum(before.entries,1),ciphertextBytes:capacitySum(before.ciphertextBytes,f.receiptBytes)});
  const result=withPendingCompletionReader(invocation.view!,pending,narrow,budget,raw=>this.combined(producerMemoReader(raw,budget),budget,invocation.actual!.stored).result);
  assertProjectedCapacity(this.p.policy,{current,projected,newEntries,outgoingCiphertextBytes:outgoing},result,this.metadata);
  invocation.status='consumed';
 });}
 assertEffectsReady(){return this.checked(()=>{if(this.state!=='projected'||!this.projectedReady)throw Error('Capacity effect scopes have not closed');});}
 finish(){return this.checked(()=>{if(this.state==='replay')return;if(this.state!=='projected'||!this.projectedTotals||!this.projectedReady)throw Error('Capacity fresh phases incomplete');
  const current=this.totals();if(current.entries!==this.projectedTotals.entries||current.ciphertextBytes!==this.projectedTotals.ciphertextBytes)throw Error('Actual saved capacity differs from prepared final footprint');
  const result=this.actual(2);
  if(this.startupNoEffectToken!==undefined){if(result.originalToken!==this.startupNoEffectToken)throw Error('Focus startup identity transition changed saved state');}
  else assertProjectedCapacity(this.p.policy,{current,projected:current,newEntries:0,outgoingCiphertextBytes:0},result,this.metadata);this.state='final';
 });}
 close(){this.state='closed';this.taskRequest=undefined;this.startupNoEffectToken=undefined;if(this.plan)producerPlans.delete(this.plan);}
}
