import {withHistoryPendingInventory} from './feed-history-pending-inventory.js';
import type {ProjectedCapacityTransaction} from './feed-projected-capacity.js';
import type {ProducerCompletionPorts} from './feed-history-completion-reader.js';
import type {PreparedCompletionChange,PreparedCompletionReceipt} from './feed-projected-completion-reader.js';
import type {CompletionSequenceFootprint} from './feed-projected-capacity.js';
import {capacitySum} from './feed-projected-capacity-policy.js';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonical} from '../../packages/domain/contracts.js';
import type {SemanticRow,SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';
import type {FeedReadGraph,FeedReadProjectionLimits} from '../../packages/domain/news-feed-read-graph.js';
import {historyStorageAad,type HistoryStoreLimits,type HistoryStoredObject} from '../../packages/domain/news-feed-history-storage.js';
import {assertHistorySqlKey} from '../../packages/domain/news-feed-history-keys.js';
import {workerNativeIdentity} from './worker-plugin/identity.js';
import {readSqlHistory} from './feed-history-sql.js';
import {verifyHistoryInventory,type HistoryInventoryAccess} from './feed-history-inventory.js';
import {withHistoryFeedReadGraph} from './feed-history-read-lens.js';
import {withHistoryMutationPlan,type ReadonlyMutationPlan} from './feed-history-mutation-plan.js';
import {MutationPlanBudget,withHistoryProjectedInventory,type MutationPlanLimits,type HistoryRowChange,type HistoryObjectChange} from './feed-history-projected-inventory.js';
import {historyJsonBytes} from './feed-history-bounds.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
export type HistorySequenceLimits={qualification:'unqualified';rowSteps:2;entries:number;logicalBytes:number;predecessorCipherBytes:number;outgoingCipherBytes:number;queries:number;copies:number};
type Ports={db:DatabaseSync;schema:61|62;limits:HistoryStoreLimits;sequence:HistorySequenceLimits;projection:FeedReadProjectionLimits;
 open:(aad:string,payload:Uint8Array)=>any;seal:(aad:string,value:unknown)=>Buffer;token:()=>string;beforeQuery?:()=>void;completion?:ProjectedCapacityTransaction;owner?:ProducerCompletionPorts};
type CipherChange={kind:'row';after:SemanticRow;before?:SemanticRow;previous?:Uint8Array;payload:Buffer}|
 {kind:'object';after:HistoryStoredObject;before?:HistoryStoredObject;previous?:Uint8Array;payload:Buffer};
declare const recipeBrand:unique symbol;
export type HistoryCompletionRecipe=Readonly<{readonly [recipeBrand]:never;rows:readonly HistoryRowChange[];objects:readonly HistoryObjectChange[];
 prepared:readonly PreparedCompletionChange[];pending:PreparedCompletionReceipt|undefined;footprint:CompletionSequenceFootprint}>;
type SelectedSequenceOwner={owner:ProducerCompletionPorts;budget:MutationPlanBudget;guard:()=>void;graph:()=>FeedReadProjectionLimits;
 checked:<T>(run:()=>T)=>T;recipe?:HistoryCompletionRecipe;recipeUsed:boolean};
declare const pendingReceiptBrand:unique symbol;
export type OwnedPendingReceipt=SemanticReceipt&Readonly<{readonly [pendingReceiptBrand]:never}>;
const pendingReceipts=new WeakMap<object,HistoryWriteSequence>();
const selectedSequences=new WeakMap<object,SelectedSequenceOwner>();
function selectedSequence(sequence:HistoryWriteSequence,owner:ProducerCompletionPorts){
 const value=selectedSequences.get(sequence);need(value,'Producer sequence is not registered');
 return value.checked(()=>{need(value.owner===owner,'Producer sequence owner changed');value.guard();return value;});
}
export function producerSequenceFootprint(sequence:HistoryWriteSequence,owner:ProducerCompletionPorts,recipe:HistoryCompletionRecipe){
 const value=selectedSequence(sequence,owner);return value.checked(()=>{need(value.recipe===recipe&&!value.recipeUsed,'Producer final recipe is foreign, expired or consumed');return value.recipe.footprint;});
}
export function producerSequenceProjection(sequence:HistoryWriteSequence,owner:ProducerCompletionPorts,recipe:HistoryCompletionRecipe){
 const value=selectedSequence(sequence,owner);return value.checked(()=>value.budget.checked(()=>{
  need(value.recipe===recipe&&!value.recipeUsed,'Producer final recipe is foreign, expired or consumed');value.recipeUsed=true;
  value.budget.entry();value.budget.reserveBytes(64);return {budget:value.budget,guard:value.guard};
 }));
}
export function producerSequenceGraph(sequence:HistoryWriteSequence,owner:ProducerCompletionPorts,pending:SemanticReceipt){
 const value=selectedSequence(sequence,owner);return value.checked(()=>value.budget.checked(()=>{
  need(pendingReceipts.get(pending)===sequence,'Pending receipt is not owned by this original sequence');
  const projection=value.graph();value.guard();value.budget.entry();value.budget.reserveBytes(96);return {budget:value.budget,guard:value.guard,projection};
 }));
}

/** Private Store-owned transaction context. No inventory, SQL connection or
 * reusable proof is returned by a public Store callback. */
export class HistoryWriteSequence{
 readonly budget:MutationPlanBudget;private readonly plannerLimits:MutationPlanLimits;
 private alive=true;private failed=false;private failure:unknown;private predecessorBytes=0;private outgoingBytes=0;
 private graphCalls=0;private planned:'none'|'pending'|'semantic'|'startup'='none';private readonly physical=new Map<string,{logical:unknown;payload:Uint8Array}>();
 constructor(private p:Ports){
  need(p.db.isTransaction,'Historical sequence requires its owned transaction');
  // Two disjoint planner upper bounds consume at most half the whole allowance.
  // The one remaining shared budget covers copies, all overlays, SQL metadata
  // and final receipt proof; no phase resets its allowance.
  this.plannerLimits={qualification:'unqualified',entries:Math.floor(Math.min(p.sequence.entries,p.sequence.copies)/4),bytes:Math.floor(p.sequence.logicalBytes/4),queries:Math.floor(p.sequence.queries/4)};
  need(this.plannerLimits.entries>0&&this.plannerLimits.bytes>0&&this.plannerLimits.queries>0,'Sequence cannot reserve its planner allowances');
  this.budget=new MutationPlanBudget({qualification:'unqualified',entries:Math.min(p.sequence.entries,p.sequence.copies)-2*this.plannerLimits.entries,
   bytes:p.sequence.logicalBytes-2*this.plannerLimits.bytes,queries:p.sequence.queries-2*this.plannerLimits.queries});
  if(p.owner){need(p.owner.db===p.db&&p.owner.open===p.open&&p.owner.token===p.token&&p.owner.limits===p.limits&&p.owner.sequence===p.sequence,'Sequence Store owner mismatch');
   // Registry slot, owner record and its three closures are paid from the
   // original shared sequence allowance before allocation.
   for(let i=0;i<6;i++)this.budget.entry();this.budget.reserveBytes(384);
   selectedSequences.set(this,{owner:p.owner,budget:this.budget,guard:()=>this.checked(()=>this.budget.checked(()=>undefined)),
    graph:()=>this.claimGraph(),checked:run=>this.checked(run),recipeUsed:false});}
 }
 private guard(){need(this.alive&&this.p.db.isTransaction,'Historical sequence has ended');if(this.failed)throw this.failure;}
 checked<T>(work:()=>T):T{this.guard();try{return work();}catch(error){this.fail(error);}}
 fail(error:unknown):never{if(!this.failed){this.failed=true;this.failure=error;}throw this.failure;}
 close(){this.alive=false;this.physical.clear();selectedSequences.delete(this);}
 /** One original-owner receiptless startup scope. No plan, database or cipher
  * leaves its fixed internal consumer; copied owners/sealers confer no access. */
 withFocusStartup(owner:ProducerCompletionPorts,seal:Ports['seal'],consume:(budget:MutationPlanBudget,guard:()=>void)=>void):void{return this.checked(()=>this.budget.checked(()=>{
  const selected=selectedSequence(this,owner);
  need(selected.budget===this.budget&&seal===this.p.seal&&this.planned==='none'&&this.graphCalls===0,'Focus startup sequence is foreign, selected or consumed');
  this.planned='startup';for(let i=0;i<4;i++)this.budget.entry();this.budget.reserveBytes(256);
  let alive=true;const guard=()=>this.checked(()=>{
   need(alive&&this.budget===selected.budget&&this.p.seal===seal&&this.p.db===owner.db&&this.p.open===owner.open&&this.p.token===owner.token&&this.p.limits===owner.limits&&this.p.sequence===owner.sequence,'Focus startup scope ended or owner changed');
   selected.budget.checked(()=>undefined);
  });
  try{const returned:unknown=consume(this.budget,guard);guard();need(returned===undefined,'Focus startup consumer must be synchronous and return no value');}
  finally{alive=false;}
 }));}
 private read<T>(consume:(access:HistoryInventoryAccess)=>T){this.guard();return readSqlHistory(this.p.db,this.p.open,this.p.limits,this.p.token,consume,this.p.schema,this.p.beforeQuery);}
 private claimGraph(){return this.checked(()=>{
  need(this.planned!=='startup','Focus startup cannot open a command graph');
  need(++this.graphCalls<=3,'Historical original graph-phase bound');
  const entries=Math.min(this.p.projection.entries,Math.floor(Math.min(this.p.sequence.entries,this.p.sequence.copies)/24));
  const bytes=Math.min(this.p.projection.bytes,Math.floor(this.p.sequence.logicalBytes/24));
  const projection={qualification:'unqualified' as const,entries,bytes,copies:Math.min(this.p.projection.copies,entries),copyBytes:Math.min(this.p.projection.copyBytes,bytes)};
  // Each of the three defined graph phases owns disjoint maxima, including
  // projection retention and copied outputs; unused allowance is not reset.
  for(let i=0;i<projection.entries+projection.copies;i++)this.budget.entry();this.budget.reserveBytes(projection.bytes+projection.copyBytes);this.budget.query();
  return projection;
 });}
 withGraph<T>(pending:SemanticReceipt|undefined,consume:(graph:FeedReadGraph)=>T):T{return this.checked(()=>{
  const projection=this.claimGraph();
  return this.read(access=>pending?this.withActualPending(access,pending,'graph',projection,consume):
   withHistoryFeedReadGraph(access,this.p.limits,hash,workerNativeIdentity,consume,projection));
 });}
 /** Move the Store's existing bounded pending copy here; only this constructor
  * can register a deeply immutable receipt for the scoped selected graph. */
 preparePending(raw:SemanticReceipt):OwnedPendingReceipt{return this.checked(()=>this.budget.checked(()=>{
  need(this.planned!=='startup','Focus startup cannot prepare a command receipt');if(this.planned==='none')this.planned='pending';
  const pending=this.budget.copy(raw) as OwnedPendingReceipt;this.budget.entry();this.budget.reserveBytes(32);pendingReceipts.set(pending,this);return pending;
 }));}
 reserveOrdinaryReceipt(){return this.checked(()=>{need(this.planned!=='startup','Focus startup cannot reserve a command receipt');const totals=this.actualTotals();
  need(Number.isSafeInteger(totals.bytes+this.p.sequence.outgoingCipherBytes)&&totals.bytes+this.p.sequence.outgoingCipherBytes<=this.p.limits.encryptedBytes,'Ordinary receipt pre-effect ciphertext reservation');
  need(totals.entries+1<=this.p.limits.objects,'Ordinary receipt pre-effect object reservation');
 });}
 private query(sql:string){this.budget.query();this.p.beforeQuery?.();return this.p.db.prepare(sql);}
 private actualTotals(){
  const row=this.query("SELECT (SELECT COALESCE(SUM(length(payload)),0) FROM feed_history_objects)+(SELECT COALESCE(SUM(length(payload)),0) FROM receipts)+(SELECT COALESCE(SUM(length(payload)),0) FROM service_records WHERE substr(id,1,14)='news:semantic-') AS bytes, (SELECT count(*) FROM feed_history_objects)+(SELECT count(*) FROM receipts)+(SELECT count(*) FROM service_records WHERE substr(id,1,14)='news:semantic-') AS entries").get() as {bytes:number;entries:number};
  need(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&Number.isSafeInteger(row.entries)&&row.entries>=0,'Historical ciphertext totals unavailable');return row;
 }
 private predecessor(kind:'row'|'object',after:SemanticRow|HistoryStoredObject,before:unknown):Uint8Array|undefined{
  const key=kind==='row'?'row:'+ (after as SemanticRow).id:'object:'+(after as HistoryStoredObject).kind+':'+(after as HistoryStoredObject).key;
  this.budget.entry();this.budget.bytes(key);const earlier=this.physical.get(key);
  if(earlier){need(same(earlier.logical,before),'Historical sequence logical predecessor changed');return earlier.payload;}
  const db=this.p.db,o=after as HistoryStoredObject,r=after as SemanticRow;
  const length=kind==='row'?this.query('SELECT length(payload) AS bytes FROM service_records WHERE id=?').get(r.id):
   this.query('SELECT length(payload) AS bytes FROM feed_history_objects WHERE kind=? AND object_key=?').get(o.kind,o.key);
  if(!length){need(before===undefined,'Historical SQL predecessor missing');return undefined;}
  need(before!==undefined,'Historical SQL expected absence changed');const bytes=(length as {bytes:number}).bytes;
  need(Number.isSafeInteger(bytes)&&bytes>=28&&Number.isSafeInteger(this.predecessorBytes+bytes)&&this.predecessorBytes+bytes<=this.p.sequence.predecessorCipherBytes,'Historical predecessor ciphertext bound');this.predecessorBytes+=bytes;
  this.budget.entry();
  if(kind==='row'){
   const actual=this.query('SELECT id,CAST(id AS BLOB) AS raw_id,revision,payload FROM service_records WHERE id=?').get(r.id) as {id:string;raw_id:Uint8Array;revision:number;payload:Uint8Array};
   assertHistorySqlKey(actual.id,actual.raw_id);need(actual.id===r.id&&actual.payload.byteLength===bytes,'Historical row SQL identity changed');
   need(same({id:actual.id,revision:actual.revision,value:this.p.open('service:'+actual.id,actual.payload)},before),'Historical row logical predecessor changed');return actual.payload;
  }
  const actual=this.query('SELECT kind,CAST(kind AS BLOB) AS raw_kind,object_key,CAST(object_key AS BLOB) AS raw_key,range_key,CAST(range_key AS BLOB) AS raw_range,revision,payload FROM feed_history_objects WHERE kind=? AND object_key=?').get(o.kind,o.key) as any;
  assertHistorySqlKey(actual.kind,actual.raw_kind);assertHistorySqlKey(actual.object_key,actual.raw_key);if(actual.range_key!==null)assertHistorySqlKey(actual.range_key,actual.raw_range);
  const prior=before as HistoryStoredObject;need(actual.kind===prior.kind&&actual.object_key===prior.key&&actual.range_key===prior.rangeKey&&actual.revision===prior.revision&&actual.payload.byteLength===bytes,'Historical catalogue SQL metadata changed');
  need(same(this.p.open(historyStorageAad(prior.kind,prior.key),actual.payload),prior),'Historical catalogue logical predecessor changed');return actual.payload;
 }
 private encrypted(aad:string,value:unknown){
  const bytes=historyJsonBytes(value,this.p.limits.objectBytes)+28;
  need(Number.isSafeInteger(bytes)&&Number.isSafeInteger(this.outgoingBytes+bytes)&&this.outgoingBytes+bytes<=this.p.sequence.outgoingCipherBytes,'Historical outgoing ciphertext bound');
  this.outgoingBytes+=bytes;this.budget.bytes(aad);this.budget.bytes(value);const payload=this.p.seal(aad,value);need(payload.byteLength===bytes,'Historical encrypted length changed');return payload;
 }
 /** Only the unchanged complete verifier or bounded graph builder consumes this private receipt view.
  * Actual rows/objects remain the bounded SQL reader's values, exactly as in
  * the no-pending proof. No callback, reusable port or copied-value cache. */
 private verifyActualStage(access:HistoryInventoryAccess,pending:SemanticReceipt){return this.withActualPending(access,pending,'proof');}
 private withActualPending(access:HistoryInventoryAccess,pending:SemanticReceipt,mode:'proof'):ReturnType<typeof verifyHistoryInventory>;
 private withActualPending<T>(access:HistoryInventoryAccess,pending:SemanticReceipt,mode:'graph',projection:FeedReadProjectionLimits,consume:(graph:FeedReadGraph)=>T):T;
 private withActualPending<T>(access:HistoryInventoryAccess,pending:SemanticReceipt,mode:'proof'|'graph',projection?:FeedReadProjectionLimits,consume?:(graph:FeedReadGraph)=>T):T|ReturnType<typeof verifyHistoryInventory>{return this.budget.checked(()=>{
  return withHistoryPendingInventory(access,pending,this.budget,()=>this.guard(),actual=>{
   if(mode==='proof')return verifyHistoryInventory(actual,this.p.limits,workerNativeIdentity);
   need(mode==='graph'&&projection&&consume,'Exact private receipt proof sink required');
   return withHistoryFeedReadGraph(actual,this.p.limits,hash,workerNativeIdentity,consume,projection);
  });
 });}

 /** The fixed receipt is reserved/encrypted before the first row effect. */
 apply(rawWrites:readonly SemanticRow[],pending?:SemanticReceipt):Buffer|undefined{return this.checked(()=>{
  need(this.planned==='none'||this.planned==='pending','Historical sequence may run only once');this.planned='semantic';
  need(Array.isArray(rawWrites)&&rawWrites.length<=this.p.sequence.rowSteps,'Historical sequence row-step bound');
  const writes=this.budget.copy(rawWrites),original=pending?this.budget.copy(pending):undefined;
  this.budget.entry();this.budget.reserveBytes(2);const plans:ReadonlyMutationPlan[]=[];
  this.read(access=>{
   verifyHistoryInventory(access,this.p.limits,workerNativeIdentity);
   const next=(index:number,source:HistoryInventoryAccess):void=>{
    if(index>=writes.length)return;
    withHistoryMutationPlan(source,this.p.limits,this.plannerLimits,workerNativeIdentity,
     {phase:index&&original?{kind:'private-admission',pending:original}:{kind:'actual'},next:writes[index]!,...(original?{pending:original}:{})},plan=>{
      this.budget.entry();plans.push(plan);
      if(index+1<writes.length)withHistoryProjectedInventory(source,{row:plan.row,objects:plan.objects},this.budget,working=>next(index+1,working));
     });
   };next(0,access);
  });
  this.budget.entry();this.budget.reserveBytes(2);const stages:CipherChange[][]=[];let newEntries=original?1:0;
  const completed=this.p.completion?(this.budget.entry(),this.budget.reserveBytes(64),new Map<string,{first:number;before?:SemanticRow|HistoryStoredObject;change:CipherChange}>()):undefined;
  for(const plan of plans){this.budget.entry();this.budget.reserveBytes(2);const stage:CipherChange[]=[];
   const prepare=(change:CipherChange)=>{this.budget.entry();stage.push(change);this.budget.entry();const key=change.kind==='row'?'row:'+change.after.id:'object:'+change.after.kind+':'+change.after.key;
    this.budget.bytes(key);this.physical.set(key,{logical:change.after,payload:change.payload});
    if(completed){this.budget.entry();this.budget.entry();this.budget.reserveBytes(128);const prior=completed.get(key);
     // A missing first predecessor stays missing even when a later stage has one.
     const first=prior?prior.first:(change.previous?.byteLength??0),before=prior?prior.before:change.before;completed.set(key,{first,before,change});}if(!change.before)newEntries++;};
   const row=plan.row;const previous=this.predecessor('row',row.after,row.before);prepare({kind:'row',...row,previous,payload:this.encrypted('service:'+row.after.id,row.after.value)});
   for(const object of plan.objects){const prior=this.predecessor('object',object.after,object.before);prepare({kind:'object',...object,previous:prior,payload:this.encrypted(historyStorageAad(object.after.kind,object.after.key),object.after)});}
   stages.push(stage);
  }
  const receiptPayload=original?this.encrypted('receipt:'+original.requestId,original.value):undefined;
  const totals=this.actualTotals();need(Number.isSafeInteger(totals.bytes+this.outgoingBytes)&&totals.bytes+this.outgoingBytes<=this.p.limits.encryptedBytes,'Historical whole-sequence encrypted overlap bound');
  need(Number.isSafeInteger(totals.entries+newEntries)&&totals.entries+newEntries<=this.p.limits.objects,'Historical whole-sequence object bound');
  if(this.p.completion){
   for(let i=0;i<4;i++)this.budget.entry();this.budget.reserveBytes(8);
   const prepared:PreparedCompletionChange[]=[],finalRows:HistoryRowChange[]=[],finalObjects:HistoryObjectChange[]=[];
   let first=0,last=receiptPayload?.byteLength??0;
   this.budget.entry();this.budget.reserveBytes(64);const completedIterator=completed!.values();
   for(;;){this.budget.entry();this.budget.reserveBytes(32);const step=completedIterator.next();if(step.done)break;const item=step.value;
    this.budget.entry();this.budget.entry();this.budget.reserveBytes(96);first=capacitySum(first,item.first);last=capacitySum(last,item.change.payload.byteLength);
    const c=item.change;prepared.push(Object.freeze(c.kind==='row'?{kind:'row',after:c.after,ciphertextBytes:c.payload.byteLength}:{kind:'object',after:c.after,ciphertextBytes:c.payload.byteLength}));
    this.budget.entry();this.budget.entry();this.budget.reserveBytes(96);
    if(c.kind==='row'){const delta:{before?:SemanticRow;after:SemanticRow}={after:c.after};if(item.before!==undefined)delta.before=item.before as SemanticRow;finalRows.push(Object.freeze(delta));}
    else{const delta:{before?:HistoryStoredObject;after:HistoryStoredObject}={after:c.after};if(item.before!==undefined)delta.before=item.before as HistoryStoredObject;finalObjects.push(Object.freeze(delta));}
   }
   need(finalRows.length<=this.p.sequence.rowSteps,'Final projected distinct-row bound');
   this.budget.entry();this.budget.reserveBytes(192);const footprint=Object.freeze({firstCiphertextBytes:first,lastCiphertextBytes:last,newEntries,outgoingCiphertextBytes:this.outgoingBytes});
   if(original&&receiptPayload){this.budget.entry();this.budget.reserveBytes(96);}
   const pending=original&&receiptPayload?Object.freeze({receipt:original,ciphertextBytes:receiptPayload.byteLength}):undefined;
   // Each original plan was already fully checked. Coalesce ONLY this final
   // logical projection: first actual before, last after, pending once last.
   // Actual SQL stages, all intermediate ciphertext and their proofs stay below.
   this.budget.entry();this.budget.reserveBytes(192);
   const recipe=Object.freeze({rows:Object.freeze(finalRows),objects:Object.freeze(finalObjects),prepared:Object.freeze(prepared),pending,footprint}) as HistoryCompletionRecipe;
   const owner=selectedSequences.get(this);need(owner&&!owner.recipe&&!owner.recipeUsed,'Original sequence final recipe is unavailable');owner.recipe=recipe;
   try{this.p.completion.beforeEffects(recipe,this);this.p.completion.assertEffectsReady();need(owner.recipeUsed,'Final sequence recipe was not consumed');}
   finally{owner.recipe=undefined;}
  }
  for(const stage of stages){
   for(const c of stage){let changes:number|bigint;
    if(c.kind==='row')changes=c.before?this.query('UPDATE service_records SET revision=?,payload=? WHERE id=? AND revision=? AND payload=?').run(c.after.revision,c.payload,c.after.id,c.before.revision,c.previous!).changes:
      this.query('INSERT INTO service_records(id,revision,payload) VALUES (?,?,?)').run(c.after.id,c.after.revision,c.payload).changes;
    else changes=c.before?this.query('UPDATE feed_history_objects SET range_key=?,revision=?,payload=? WHERE kind=? AND object_key=? AND range_key IS ? AND revision=? AND payload=?').run(c.after.rangeKey,c.after.revision,c.payload,c.before.kind,c.before.key,c.before.rangeKey,c.before.revision,c.previous!).changes:
      this.query('INSERT INTO feed_history_objects(kind,object_key,range_key,revision,payload) VALUES (?,?,?,?,?)').run(c.after.kind,c.after.key,c.after.rangeKey,c.after.revision,c.payload).changes;
    need(changes===1,'Historical exact ciphertext predecessor did not match');
   }
   this.read(access=>original?this.verifyActualStage(access,original):verifyHistoryInventory(access,this.p.limits,workerNativeIdentity));
  }
  return receiptPayload;
 });}
}
