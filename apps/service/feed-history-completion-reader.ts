import {types as nodeTypes} from 'node:util';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {historyStorageAad,type HistoryStoreLimits,type HistoryStoredObject,type HistoryObjectKind} from '../../packages/domain/news-feed-history-storage.js';
import type {SemanticRow,SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';
import type {NativeIdentity} from '../../packages/domain/news-feed-successor-journal.js';
import {assertHistorySqlKey,assertHistoryUtf8Key} from '../../packages/domain/news-feed-history-keys.js';
import {historySegmentLimits} from '../../packages/domain/news-feed-history-segment.js';
import {readSqlHistory} from './feed-history-sql.js';
import {verifyHistoryInventory} from './feed-history-inventory.js';
import {withHistoryProjectedInventory,type MutationPlanBudget,type HistoryRowChange,type HistoryObjectChange} from './feed-history-projected-inventory.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import type {CompletionRowFact,CompletionObjectFact,CompletionReceiptFact} from './feed-completion-contract.js';
import type {CompletionReader,CompletionRowDescriptor} from './feed-completion-reader.js';
import {readProducerSlot,type ProducerSqlPorts,type ProducerStored} from './feed-automatic-producer-store.js';
import {ProducerWork,type ProducerState} from './feed-automatic-producer-state.js';
import {SelectedOriginalCollector,type SelectedOriginalRequest,type SelectedOriginalFact,type SelectedOriginalFacts,type SelectedOriginalWork} from '../../packages/domain/news-feed-selected-originals.js';
import {withProjectedCompletionReader,type PreparedCompletionChange,type PreparedCompletionReceipt} from './feed-projected-completion-reader.js';
import type {CompletionAmount} from './feed-completion-contract.js';
import {producerSequenceGraph,producerSequenceProjection,type HistoryWriteSequence,type HistoryCompletionRecipe} from './feed-history-write-sequence.js';
import {withHistoryPendingInventory} from './feed-history-pending-inventory.js';
import {selectProducerPreparedState,type ProducerPreparedPlan} from './feed-projected-capacity.js';
import {withHistoryFeedReadGraph} from './feed-history-read-lens.js';
import type {FeedReadGraph} from '../../packages/domain/news-feed-read-graph.js';
import type {HistoryInventoryAccess} from './feed-history-inventory.js';

type Open=(aad:string,payload:Uint8Array)=>unknown;
function need(condition:unknown,message:string):asserts condition{if(!condition)throw Error(message);}
/** A known capability owns the first-failure latch even if a caller supplies
 * another allowance. A forged unknown object cannot select any other owner. */
function ownedBudget<T>(original:MutationPlanBudget|undefined,candidate:MutationPlanBudget,work:()=>T):T{
 if(original&&original!==candidate){
  let first:unknown;try{original.fail(Error('Selected capability budget provenance changed'));}catch(error){first=error;}
  // Preserve each allowance's existing latch, while the genuine owner remains
  // authoritative for this refusal and cannot be revived by a caught attempt.
  try{candidate.fail(first);}catch{/* Original owner failure is returned below. */}
  throw first;
 }
 return candidate.checked(work);
}

declare const proofBrand:unique symbol;
/** Data proof issued only inside this maintained source/reader owner. */
export type SelectedOriginalProof=Readonly<{readonly [proofBrand]:never}>;
type ProofOwned={budget:MutationPlanBudget;state:ProducerState|undefined;facts:SelectedOriginalFacts;guard:()=>void;alive:boolean;reader?:CompletionReader};
const proofs=new WeakMap<object,ProofOwned>();
const selectedReaders=new WeakMap<CompletionReader,ProofOwned>();
function proofOwned(proof:SelectedOriginalProof,budget:MutationPlanBudget):ProofOwned{
 return ownedBudget(proofs.get(proof)?.budget,budget,()=>{const value=proofs.get(proof);need(value&&value.budget===budget&&value.alive,'Selected original proof is foreign or expired');value.guard();return value;});
}
function selections(state:ProducerState|undefined,work:ProducerWork):readonly SelectedOriginalRequest[]{
 work.slots(2,96);const result:SelectedOriginalRequest[]=[];
 if(state){
  work.need(Object.isFrozen(state),'Selected producer state must be owned immutable data');
  const job=state.pending??state.checkpoint?.job;work.need(job&&Object.isFrozen(job),'Selected producer job is unavailable');
  work.slots(3,192);result.push({requestId:job.jobId,kind:'start'});
  if(job.applicationId){work.slots(3,192);result.push({requestId:job.applicationId,kind:'apply-learning'});}
 }
 return Object.freeze(result);
}
/** Private: neither a source nor a fabricated view can be supplied to an
 * exported issuer. Every call below is constructed by this actual owner. */
function withSelectedOriginalProof<T>(source:HistoryInventoryAccess,limits:HistoryStoreLimits,native:NativeIdentity,
 state:ProducerState|undefined,budget:MutationPlanBudget,ownerGuard:()=>void,consume:(proof:SelectedOriginalProof)=>T):T{
 let entry:ProofOwned|undefined;
 try{return budget.checked(()=>{
  ownerGuard();const work:ProducerWork=new ProducerWork(budget);work.slots(12,768);
  const chosen=selections(state,work),collector=new SelectedOriginalCollector(chosen,{checked:fn=>budget.checked(fn),slots:(n,b)=>work.slots(n,b),
   copy:value=>budget.copy(value),hash:value=>work.hash(value),fail:error=>budget.fail(error)});
  // A SQL inventory token forwards the maintained Store token's two queries.
  // Projected wrappers charge their own guards in addition to these two.
  const readToken=()=>{budget.query();budget.query();return source.token();};
  const token=readToken();ownerGuard();const verified=verifyHistoryInventory(source,limits,native,collector);
  ownerGuard();work.need(readToken()===token,'Selected original source changed after complete proof');
  work.need(verified.selectedOriginals!==undefined,'Complete selected original proof missing');
  const guard=()=>budget.checked(()=>{ownerGuard();work.need(readToken()===token,'Selected original view ended or changed');});
  work.slots(3,192);const proof=Object.freeze({}) as SelectedOriginalProof;
  entry={budget,state,facts:verified.selectedOriginals,guard,alive:true};proofs.set(proof,entry);
  const result=consume(proof);entry.alive=false;
  const then=result!==null&&(typeof result==='object'||typeof result==='function')?(result as {then?:unknown}).then:undefined;
  if(typeof then==='function'){entry.alive=false;if(result instanceof Promise)Promise.prototype.then.call(result,undefined,()=>undefined);throw Error('Selected original proof callback must remain synchronous');}
  guard();budget.checked(()=>undefined);return result;
 });}catch(error){return budget.fail(error);}finally{if(entry)entry.alive=false;}
}
function bindSelectedOriginalReader(proof:SelectedOriginalProof,reader:CompletionReader,budget:MutationPlanBudget){
 return budget.checked(()=>{const value=proofOwned(proof,budget);reader.assertBudget(budget);reader.guard();
  need(!value.reader,'Selected original proof reader already bound');budget.entry();budget.reserveBytes(32);value.reader=reader;
  // Only this private binder sees the exact frozen reader constructed by the
  // maintained actual/projected callback. A structural wrapper cannot enroll.
  budget.entry();budget.reserveBytes(32);selectedReaders.set(reader,value);
 });
}
/** Identity query only: no supplied reader can register or adopt an owner.
 * A memo may bind this immutable source/budget once, but every access must still
 * call source.guard(); its actual/projected lifetime closes before this proof. */
export function isSelectedOriginalReader(reader:CompletionReader,budget:MutationPlanBudget):boolean{
 const value=selectedReaders.get(reader);
 return ownedBudget(value?.budget,budget,()=>{budget.entry();if(!value)return false;
  need(value.alive&&value.reader===reader,'Selected original reader is expired or changed');value.guard();return true;
 });
}
export function assertSelectedOriginalState(proof:SelectedOriginalProof,reader:CompletionReader,budget:MutationPlanBudget,state:object|undefined){
 return ownedBudget(proofs.get(proof)?.budget,budget,()=>{const value=proofOwned(proof,budget);need(value.reader===reader&&value.state===state,'Selected original state or reader provenance changed');reader.assertBudget(budget);});
}
export function readSelectedOriginal(proof:SelectedOriginalProof,reader:CompletionReader,budget:MutationPlanBudget,state:object|undefined,slot:0|1):SelectedOriginalFact|undefined{
 return ownedBudget(proofs.get(proof)?.budget,budget,()=>{assertSelectedOriginalState(proof,reader,budget,state);need(slot===0||slot===1,'Selected original slot bound');budget.entry();budget.reserveBytes(16);return proofOwned(proof,budget).facts[slot];});
}

declare const contextBrand:unique symbol;
export type ProducerActualContext=Readonly<{readonly [contextBrand]:never;reader:CompletionReader;stored:ProducerStored|undefined;state:ProducerState|undefined}>;
export type ProducerCompletionPorts=ProducerSqlPorts&{open:Open;limits:HistoryStoreLimits;native:NativeIdentity;token:()=>string};
export type ProducerSelectionMode={kind:'stored-slot'}|{kind:'producer-plan';plan:ProducerPreparedPlan};
type ActualOwned={source:HistoryInventoryAccess;budget:MutationPlanBudget;guard:()=>void;ports:ProducerCompletionPorts;limits:HistoryStoreLimits;native:NativeIdentity;state:ProducerState|undefined;selected:SelectedOriginalProof};
const actualContexts=new WeakMap<object,ActualOwned>();
export type ProducerFinalRecipe=HistoryCompletionRecipe;

/** Closed actual-owner projection. The same checked replacements construct
 * both the verified inventory and the completion reader, including replacement
 * of an existing selected ID. No source or reader can be substituted by callers. */
export function withProjectedProducerCompletion<T>(context:ProducerActualContext,recipe:ProducerFinalRecipe,currentAmount:CompletionAmount,
 sequence:HistoryWriteSequence,budget:MutationPlanBudget,consume:(reader:CompletionReader)=>T):T{
 return ownedBudget(actualContexts.get(context)?.budget,budget,()=>{
  const owner=actualContexts.get(context);need(owner&&owner.budget===budget,'Actual producer context provenance changed');owner.guard();
  const sequenceOwner=producerSequenceProjection(sequence,owner.ports,recipe),projectionBudget=sequenceOwner.budget;
  const work:ProducerWork=new ProducerWork(budget);work.slots(8,512);
  need(Array.isArray(recipe.rows)&&recipe.rows.length<=2&&Array.isArray(recipe.objects)&&Array.isArray(recipe.prepared),'Final selected recipe shape');
  need(recipe.objects.length<=projectionBudget.limits.entries&&recipe.prepared.length===recipe.rows.length+recipe.objects.length,'Final selected recipe membership bound');
  // Retain reference identities, charging every wrapper/slot before allocation.
  work.slots(4,128);const rows:HistoryRowChange[]=[],objects:HistoryObjectChange[]=[],prepared:PreparedCompletionChange[]=[],empty:HistoryObjectChange[]=[];
  const rawPending=recipe.pending;work.slots(1,64);
  const pending=rawPending?Object.freeze({receipt:rawPending.receipt,ciphertextBytes:rawPending.ciphertextBytes}):undefined,current=budget.copy(currentAmount);
  work.slots(4,256);const identities=new Set<string>(),byAfter=new Map<object,'row'|'object'>(),represented=new Set<object>();
  const identity=(kind:string,id:string)=>{work.slots(1,32+kind.length*2+id.length*2);return kind+':'+id;};
  for(let i=0;i<recipe.prepared.length;i++){
   work.slots(1,0);const item=recipe.prepared[i]!;need((item.kind==='row'||item.kind==='object')&&Object.isFrozen(item.after),'Final prepared successor must be immutable');
   const id=item.kind==='row'?identity('semantic-row',item.after.id):identity('object-'+item.after.kind,item.after.key);
   need(!identities.has(id),'Final selected recipe duplicate replacement');work.slots(1,32);identities.add(id);
   need(!byAfter.has(item.after),'Final selected recipe duplicate successor');work.slots(5,192);byAfter.set(item.after,item.kind);
   prepared.push(Object.freeze({...item}));
  }
  for(let i=0;i<recipe.rows.length;i++){
   work.slots(1,0);const item=recipe.rows[i]!;need(byAfter.get(item.after)==='row'&&!represented.has(item.after),'Final selected row provenance changed');
   work.slots(5,192);represented.add(item.after);const delta:{before?:SemanticRow;after:SemanticRow}={after:item.after};if(item.before!==undefined)delta.before=item.before;rows.push(Object.freeze(delta));
  }
  for(let i=0;i<recipe.objects.length;i++){
   work.slots(1,0);const item=recipe.objects[i]!;need(byAfter.get(item.after)==='object'&&!represented.has(item.after),'Final selected object provenance changed');
   work.slots(5,192);represented.add(item.after);const delta:{before?:HistoryStoredObject;after:HistoryStoredObject}={after:item.after};if(item.before!==undefined)delta.before=item.before;objects.push(Object.freeze(delta));
  }
  need(represented.size===prepared.length,'Final selected recipe membership changed');
  const project=(index:number,source:HistoryInventoryAccess):T=>{
   owner.guard();sequenceOwner.guard();projectionBudget.entry();projectionBudget.reserveBytes(128);
   const last=index+1>=rows.length,delta={objects:index===0?objects:empty,...(rows[index]?{row:rows[index]}:{}),...(last&&pending?{pending:pending.receipt}:{})};
   return withHistoryProjectedInventory(source,delta,projectionBudget,next=>{
    if(!last)return project(index+1,next);
    return withSelectedOriginalProof(next,owner.limits,owner.native,owner.state,budget,owner.guard,proof=>
     withProjectedCompletionReader(context.reader,prepared,pending,current,budget,reader=>{
      bindSelectedOriginalReader(proof,reader,budget);return consume(reader);
     },proof));
   });
  };
  const result=project(0,owner.source);owner.guard();sequenceOwner.guard();return result;
 });
}

declare const pendingBrand:unique symbol;
export type ProducerPendingView=Readonly<{readonly [pendingBrand]:never}>;
type PendingOwned={context:ProducerActualContext;pending:SemanticReceipt;proof:SelectedOriginalProof;budget:MutationPlanBudget;alive:boolean;used:boolean};
const pendingViews=new WeakMap<object,PendingOwned>();

/** Uses one original finite sequence graph phase. Full inventory/seal proof
 * and bounded graph construction finish before the scoped ticket is visible. */
export function withPendingProducerGraph(context:ProducerActualContext,sequence:HistoryWriteSequence,pending:SemanticReceipt,
 budget:MutationPlanBudget,consume:(graph:FeedReadGraph,view:ProducerPendingView)=>void):void{
 let rejectedReturn:unknown;
 try{return ownedBudget(actualContexts.get(context)?.budget,budget,()=>{
  const owner=actualContexts.get(context);need(owner&&owner.budget===budget,'Pending producer context provenance changed');owner.guard();
  const scope=producerSequenceGraph(sequence,owner.ports,pending),work:ProducerWork=new ProducerWork(budget);work.slots(12,768);
  // Only this receipt-only overlay can reuse the actual collector's immutable
  // digest data. Both complete inventory proofs still validate every row. The
  // full common tuple is independently derived by the second proof; no public
  // fact, changed row, other phase or final replacement can enroll for reuse.
  work.slots(8,512);let reuseAlive=true;
  const hashSelected:NonNullable<SelectedOriginalWork['hashSelected']>=(common,kind,role,value)=>budget.checked(()=>{
   need(reuseAlive,'Pending selected digest scope ended');owner.guard();scope.guard();
   const actual=proofOwned(owner.selected,budget);
   need(actual.state===owner.state&&actual.reader===context.reader&&actual.facts.length<=2,'Pending selected digest owner changed');
   work.slots(6,128);let digest:string|undefined;
   for(const fact of actual.facts){
    work.slots(20,256);const original=fact.original;
    if(!original||original.kind!==kind||fact.requestId!==common.requestId||fact.expectedKind!==common.requestKind)continue;
    const a=original.custody,b=common.custody;
    if(original.requestId!==common.requestId||original.requestKind!==common.requestKind||original.deviceId!==common.deviceId||original.epoch!==common.epoch||
     original.rowId!==common.rowId||original.rowRevision!==common.rowRevision||a.kind!==b.kind||a.kind==='segment'&&(b.kind!=='segment'||a.segmentId!==b.segmentId||a.ordinal!==b.ordinal)||
     original.requestSha256!==common.requestSha256||original.receiptSha256!==common.receiptSha256||original.protocolDigest!==common.protocolDigest||original.rowSha256!==common.rowSha256)continue;
    if(original.kind==='worker')digest=role==='terminal'?original.terminalSha256:role==='source'?original.sourceProofSha256:undefined;
    else if(original.kind==='applied-learning')digest=role==='before'?original.beforeSha256:role==='after'?original.afterSha256:undefined;
    if(digest!==undefined)break;
   }
   // A missing or different commitment takes the unchanged metered hash path.
   const result=digest??work.hash(value);owner.guard();scope.guard();actual.guard();return result;
  });
  try{
  const collector=new SelectedOriginalCollector(selections(owner.state,work),{checked:fn=>budget.checked(fn),slots:(n,b)=>work.slots(n,b),copy:value=>budget.copy(value),hash:value=>work.hash(value),hashSelected,fail:error=>budget.fail(error)});
  withHistoryPendingInventory(owner.source,pending,scope.budget,scope.guard,source=>{
   const readToken=()=>{budget.query();budget.query();return source.token();};const token=readToken();
   withHistoryFeedReadGraph(source,owner.limits,text=>createHash('sha256').update(text).digest('hex'),owner.native,(graph,facts)=>{
    need(facts,'Complete pending selected proof missing');owner.guard();scope.guard();need(readToken()===token,'Pending selected source changed');
    const guard=()=>budget.checked(()=>{owner.guard();scope.guard();need(readToken()===token,'Pending selected source ended or changed');});
    work.slots(6,384);const proof=Object.freeze({}) as SelectedOriginalProof,view=Object.freeze({}) as ProducerPendingView;
    const entry:ProofOwned={budget,state:owner.state,facts,guard,alive:true},ticket:PendingOwned={context,pending,proof,budget,alive:true,used:false};
    proofs.set(proof,entry);pendingViews.set(view,ticket);
    try{
     const result=consume(graph,view);ticket.alive=false;entry.alive=false;pendingViews.delete(view);if(result!==undefined)rejectedReturn=result;
     // Reject every non-undefined result without observing its then property.
     // No callback-result object can reopen a pending proof invocation.
     need(result===undefined,'Pending producer callback must return undefined');need(ticket.used,'Pending producer view was not consumed');guard();budget.checked(()=>undefined);
    }finally{ticket.alive=false;entry.alive=false;pendingViews.delete(view);}
   },scope.projection,collector);
  });
  owner.guard();scope.guard();budget.checked(()=>undefined);
  }finally{reuseAlive=false;}
 });}finally{
  // The graph/view have closed and a refused return has poisoned the original
  // budget before intrinsic Promise handling can observe any subclass hooks.
  try{if(nodeTypes.isPromise(rejectedReturn))Promise.prototype.then.call(rejectedReturn,undefined,()=>undefined);}catch{/* Keep the original refusal. */}
 }
}
/** A prepared receipt consumes the exact pending view once, inside its graph
 * callback. Encryption lengths remain data until the unchanged capacity gate. */
export function withPendingCompletionReader<T>(view:ProducerPendingView,pending:PreparedCompletionReceipt,current:CompletionAmount,
 budget:MutationPlanBudget,consume:(reader:CompletionReader)=>T):T{
 return ownedBudget(pendingViews.get(view)?.budget,budget,()=>{
  const ticket=pendingViews.get(view);need(ticket&&ticket.alive&&ticket.budget===budget&&!ticket.used,'Pending producer view is foreign, expired or consumed');
  ticket.used=true;need(pending.receipt===ticket.pending,'Prepared pending receipt reference changed');
  const owner=actualContexts.get(ticket.context);need(owner&&owner.budget===budget,'Pending actual owner ended');owner.guard();
  budget.entry();budget.reserveBytes(2);return withProjectedCompletionReader(ticket.context.reader,[],pending,current,budget,reader=>{
   bindSelectedOriginalReader(ticket.proof,reader,budget);return consume(reader);
  },ticket.proof);
 });
}

export function withActualCompletionReader<T>(db:DatabaseSync,open:Open,storeLimits:HistoryStoreLimits,native:NativeIdentity,
 token:()=>string,budget:MutationPlanBudget,consume:(reader:CompletionReader)=>T):T{
 return withActualCompletionScope(db,open,storeLimits,native,token,budget,reader=>consume(reader));
}
export function withActualProducerCompletionContext<T>(ports:ProducerCompletionPorts,budget:MutationPlanBudget,
 selection:ProducerSelectionMode,consume:(context:ProducerActualContext)=>T):T{
 return withActualCompletionScope(ports.db,ports.open,ports.limits,ports.native,ports.token,budget,
  (_reader,context)=>{need(context,'Producer actual context missing');return consume(context);},selection,ports);
}

/** Internal lexical reader over a completely verified, already-owned Store
 * transaction. The maintained Store.open/token closures are required. New N1
 * work shares the supplied budget; inherited proof retains its own allowance.
 * No reader/cursor/native permission survives the synchronous callback. */
function withActualCompletionScope<T>(db:DatabaseSync,open:Open,storeLimits:HistoryStoreLimits,native:NativeIdentity,
 token:()=>string,budget:MutationPlanBudget,consume:(reader:CompletionReader,context?:ProducerActualContext)=>T,
 selection?:ProducerSelectionMode,producerPorts?:ProducerCompletionPorts):T{
 let alive=true,originalToken='';
 const slots=(count=1,bytes=0)=>{for(let i=0;i<count;i++)budget.entry();budget.reserveBytes(bytes);};
 const readToken=()=>{
  // The maintained Store token performs total_changes and data_version reads.
  // Reserve both before observing it; this is conservative for synthetic ports.
  budget.query();budget.query();slots(4,128);const value=token();
  need(typeof value==='string'&&historyJsonBytes(value,4096)<=4096,'Completion snapshot token must be bounded synchronous text');return value;
 };
 const guard=()=>budget.checked(()=>{need(alive&&db.isTransaction,'Completion snapshot has ended');need(readToken()===originalToken,'Completion snapshot token changed');});
 const scalar=(sql:string,args:SQLInputValue[]=[])=>budget.checked(()=>{
  guard();slots(16,256);budget.query();const result=db.prepare(sql).get(...args);guard();return result;
 });
 const key=(value:string)=>{need(typeof value==='string','Completion raw key type');const bytes=Buffer.byteLength(value,'utf8');need(bytes<=8192,'Completion raw key bound');slots(2,bytes*2);budget.bytes(value);assertHistoryUtf8Key(value);return bytes;};
 const length=(value:unknown)=>{need(typeof value==='number'&&Number.isSafeInteger(value)&&value>=28,'Completion ciphertext length missing or malformed');return value;};
 try{return budget.checked(()=>{
  need(db.isTransaction,'Completion requires an already-open Store transaction');originalToken=budget.copy(readToken());
  const schema=scalar('PRAGMA user_version')?.user_version;need(schema===61||schema===62,'Completion requires exact schema61 or62');
  let newWork=false;
  return readSqlHistory(db,open,storeLimits,token,source=>{
   need(!selection||producerPorts&&producerPorts.db===db&&producerPorts.open===open&&producerPorts.token===token&&producerPorts.limits===storeLimits&&producerPorts.native===native,'Producer Store owner changed');
   need(!selection||selection.kind==='stored-slot'||selection.kind==='producer-plan','Unknown producer selection mode');
   const stored=selection?.kind==='stored-slot'?readProducerSlot(producerPorts!,budget,guard):undefined;
   const selectedState=selection?.kind==='producer-plan'?selectProducerPreparedState(selection.plan,producerPorts!,budget):stored?.state;
   const consumeVerified=(selected?:SelectedOriginalProof):T=>{newWork=true;guard();
   // The inherited proof authenticates every object, semantic row and receipt,
   // including all generic empty/Unicode receipt keys. No active-only fallback.
   const raw=scalar("SELECT (SELECT count(*) FROM feed_history_objects)+(SELECT count(*) FROM service_records WHERE substr(id,1,14)='news:semantic-')+(SELECT count(*) FROM receipts) AS entries,(SELECT coalesce(sum(length(payload)),0) FROM feed_history_objects)+(SELECT coalesce(sum(length(payload)),0) FROM service_records WHERE substr(id,1,14)='news:semantic-')+(SELECT coalesce(sum(length(payload)),0) FROM receipts) AS ciphertextBytes");
   need(raw&&typeof raw.entries==='number'&&Number.isSafeInteger(raw.entries)&&raw.entries>=0&&typeof raw.ciphertextBytes==='number'&&Number.isSafeInteger(raw.ciphertextBytes)&&raw.ciphertextBytes>=0,'Completion actual totals malformed');
   const current=budget.copy({entries:raw.entries,ciphertextBytes:raw.ciphertextBytes});

   // Also prepay final cursor-set iteration/exhaustion and failure bookkeeping.
   slots(8,128);const ownedRows=new WeakSet<object>(),ownedObjects=new WeakSet<object>(),ownedReceipts=new WeakSet<object>(),cursors=new Set<()=>void>();
   const remember=<V extends object>(set:WeakSet<object>,value:V):V=>{slots(1,16);const copied=budget.copy(value);set.add(copied);return copied;};
   let readerAlive=true;
   const live=<V>(read:()=>V):V=>budget.checked(()=>{need(alive&&readerAlive,'Completion reader has ended');return read();});
   // Additional N1 reads use the concrete maintained Store.open only. An
   // arbitrary decoding callback is not an allocation guarantee. The complete
   // proof above established shapes; these reads rejoin exact authenticated
   // metadata under the unchanged token without another Zod/canonical copy.
   const opened=(aad:string,payload:Uint8Array)=>{guard();slots(12,Buffer.byteLength(aad)*2+128);let value:unknown;
    if(producerPorts){const text=producerPorts.openText(aad,payload);guard();value=parse(text);}
    else value=open(aad,payload);
    guard();return value;
   };
   const reservePayload=(bytes:number)=>{
    const plain=length(bytes)-28;
    // JSON's densest sequence is one-byte primitive plus a comma. Empty
    // containers cost two bytes; object key/value slots cost more. This bounds
    // parsed nodes/slots before generic Store.open's JSON.parse. The concrete
    // producer text path instead prepays its exact lexical tokens in parse().
    // Both retain fixed slots and all ciphertext/decrypt/text/logical bytes
    // before ciphertext fetch or decryption; parse() adds its own byte bound.
    slots((producerPorts?0:Math.ceil(plain/2))+2,bytes*2+plain*4);
   };
   const keyLength=(value:unknown)=>{need(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=8192,'Completion actual key length malformed');return value;};
   const object=(kind:HistoryObjectKind,id:string):HistoryStoredObject|undefined=>budget.checked(()=>{
    key(kind);key(id);slots(2,32);budget.query();
    const meta=scalar('SELECT typeof(payload) AS type,length(payload) AS bytes,length(CAST(kind AS BLOB)) AS kb,length(CAST(object_key AS BLOB)) AS ib,length(CAST(range_key AS BLOB)) AS rb FROM feed_history_objects WHERE kind=? AND object_key=?',[kind,id]);
    if(!meta)return;need(meta.type==='blob','Completion object payload type changed');slots(12,4*(keyLength(meta.kb)+keyLength(meta.ib)+(meta.rb===null?0:keyLength(meta.rb)))+256);reservePayload(length(meta.bytes));
    const raw=scalar('SELECT kind,CAST(kind AS BLOB) AS raw_kind,object_key,CAST(object_key AS BLOB) AS raw_key,range_key,CAST(range_key AS BLOB) AS raw_range,revision,payload FROM feed_history_objects WHERE kind=? AND object_key=?',[kind,id]);
    need(raw&&raw.kind===kind&&raw.object_key===id&&(raw.payload as Uint8Array).byteLength===meta.bytes,'Completion object fetch changed');
    assertHistorySqlKey(raw.kind as string,raw.raw_kind as Uint8Array);assertHistorySqlKey(raw.object_key as string,raw.raw_key as Uint8Array);
    if(raw.range_key===null)need(raw.raw_range===null,'Completion NULL range changed');else assertHistorySqlKey(raw.range_key as string,raw.raw_range as Uint8Array);
    const value=opened(historyStorageAad(kind,id),raw.payload as Uint8Array) as HistoryStoredObject;
    need(value.kind===kind&&value.key===id&&value.rangeKey===raw.range_key&&value.revision===raw.revision,'Completion authenticated object identity changed');return remember(ownedObjects,value);
   });
   const activeRow=(id:string):SemanticRow|undefined=>budget.checked(()=>{
    key(id);slots(2,32);budget.query();need(id.startsWith('news:semantic-'),'Completion active namespace changed');
    const meta=scalar('SELECT typeof(payload) AS type,length(payload) AS bytes,length(CAST(id AS BLOB)) AS ib FROM service_records WHERE id=?',[id]);if(!meta)return;
    need(meta.type==='blob','Completion row payload type changed');slots(8,keyLength(meta.ib)*4+128);reservePayload(length(meta.bytes));
    const raw=scalar('SELECT id,CAST(id AS BLOB) AS raw_id,revision,payload FROM service_records WHERE id=?',[id]);need(raw&&raw.id===id&&(raw.payload as Uint8Array).byteLength===meta.bytes,'Completion row fetch changed');assertHistorySqlKey(raw.id as string,raw.raw_id as Uint8Array);
    const value=opened('service:'+id,raw.payload as Uint8Array);slots(3,48);return remember(ownedRows,{id,revision:raw.revision as number,value});
   });
   const receipt=(id:string):SemanticReceipt|undefined=>budget.checked(()=>{
    key(id);slots(2,32);budget.query();
    const meta=scalar('SELECT typeof(payload) AS type,length(payload) AS bytes,length(CAST(request_id AS BLOB)) AS ib,length(CAST(device_id AS BLOB)) AS db FROM receipts WHERE request_id=?',[id]);if(!meta)return;
    need(meta.type==='blob','Completion receipt payload type changed');slots(12,(keyLength(meta.ib)+keyLength(meta.db))*4+256);reservePayload(length(meta.bytes));
    const raw=scalar('SELECT request_id,CAST(request_id AS BLOB) AS raw_id,device_id,CAST(device_id AS BLOB) AS raw_device,digest,payload FROM receipts WHERE request_id=?',[id]);need(raw&&raw.request_id===id&&(raw.payload as Uint8Array).byteLength===meta.bytes,'Completion receipt fetch changed');
    assertHistorySqlKey(raw.request_id as string,raw.raw_id as Uint8Array);assertHistorySqlKey(raw.device_id as string,raw.raw_device as Uint8Array);
    const value=opened('receipt:'+id,raw.payload as Uint8Array);slots(4,64);return remember(ownedReceipts,{requestId:id,deviceId:raw.device_id as string,digest:raw.digest as string,value});
   });
   function keys(table:'feed_history_objects'|'service_records',kind?:HistoryObjectKind):IterableIterator<string>{
    slots(5,96);
    const column=table==='feed_history_objects'?'object_key':'id',where=kind?' WHERE kind=?':" WHERE substr(id,1,14)='news:semantic-'",args=kind?[kind]:[];
    const meta=scalar('SELECT coalesce(max(length(CAST('+column+' AS BLOB))),0) AS bytes FROM '+table+where,args),maximum=keyLength(meta?.bytes);
    guard();slots(17,304);budget.query();budget.query(); // cursor/wrapper, registry entry, final iteration and reserved return results
    const iterator=db.prepare('SELECT '+column+' AS id,CAST('+column+' AS BLOB) AS raw_id FROM '+table+where+' ORDER BY '+column+' COLLATE BINARY').iterate(...args);
    const done=Object.freeze({done:true as const,value:undefined});
    let closed=false;
    const close=()=>{if(!closed){closed=true;cursors.delete(close);try{iterator.return?.();}catch(error){budget.fail(error);}}};
    cursors.add(close);
    const wrapper:IterableIterator<string>={next:()=>{try{return budget.checked(()=>{
     guard();need(!closed,'Completion cursor ended');slots(6,maximum*4+112);budget.query();const next=iterator.next();guard();
     if(next.done){closed=true;cursors.delete(close);return done;}
     need(typeof next.value.id==='string'&&Buffer.byteLength(next.value.id)<=maximum,'Completion key cursor changed');assertHistorySqlKey(next.value.id,next.value.raw_id as Uint8Array);
     return Object.freeze({done:false as const,value:next.value.id});
    });}catch(error){try{close();}catch{/* Preserve the first latched failure. */}return budget.fail(error);}},return:()=>{close();return done;},[Symbol.iterator](){guard();return this;}};
    return Object.freeze(wrapper);
   }
   const rowFact=(row:SemanticRow):CompletionRowFact=>{
    need(ownedRows.has(row),'Completion row fact requires its actual reader value');
    const bytes=key(row.id);slots(8,bytes*4+128);
    const actual=scalar('SELECT id,CAST(id AS BLOB) AS raw_id,revision,typeof(payload) AS type,length(payload) AS bytes FROM service_records WHERE id=?',[row.id]);
    need(actual&&actual.type==='blob'&&actual.id===row.id&&actual.revision===row.revision,'Completion semantic ciphertext identity changed');assertHistorySqlKey(actual.id as string,actual.raw_id as Uint8Array);
    slots(2,48);return {row,ciphertextBytes:length(actual.bytes)};
   };
   const objectFact=(value:HistoryStoredObject):CompletionObjectFact=>{
    need(ownedObjects.has(value),'Completion object fact requires its actual reader value');
    const bytes=key(value.kind)+key(value.key)+(value.rangeKey===null?0:key(value.rangeKey));slots(10,bytes*4+128);
    const actual=scalar('SELECT kind,CAST(kind AS BLOB) AS raw_kind,object_key,CAST(object_key AS BLOB) AS raw_key,range_key,CAST(range_key AS BLOB) AS raw_range,revision,typeof(payload) AS type,length(payload) AS bytes FROM feed_history_objects WHERE kind=? AND object_key=?',[value.kind,value.key]);
    need(actual&&actual.type==='blob'&&actual.kind===value.kind&&actual.object_key===value.key&&actual.range_key===value.rangeKey&&actual.revision===value.revision,'Completion object ciphertext identity changed');
    assertHistorySqlKey(actual.kind as string,actual.raw_kind as Uint8Array);assertHistorySqlKey(actual.object_key as string,actual.raw_key as Uint8Array);
    if(value.rangeKey===null)need(actual.raw_range===null,'Completion NULL range changed');else assertHistorySqlKey(actual.range_key as string,actual.raw_range as Uint8Array);
    slots(2,48);return {object:value,ciphertextBytes:length(actual.bytes)};
   };
   const receiptFact=(value:SemanticReceipt):CompletionReceiptFact=>{
    need(ownedReceipts.has(value),'Completion receipt fact requires its actual reader value');
    const bytes=key(value.requestId)+key(value.deviceId);slots(9,bytes*4+256);
    const actual=scalar('SELECT request_id,CAST(request_id AS BLOB) AS raw_id,device_id,CAST(device_id AS BLOB) AS raw_device,digest,typeof(payload) AS type,length(payload) AS bytes FROM receipts WHERE request_id=?',[value.requestId]);
    need(actual&&actual.type==='blob'&&actual.request_id===value.requestId&&actual.device_id===value.deviceId&&actual.digest===value.digest,'Completion receipt ciphertext identity changed');
    assertHistorySqlKey(actual.request_id as string,actual.raw_id as Uint8Array);assertHistorySqlKey(actual.device_id as string,actual.raw_device as Uint8Array);
    slots(2,48);return {receipt:value,ciphertextBytes:length(actual.bytes)};
   };
   // Only called after the complete verifier authenticates this exact wire and
   // its operation/catalogue/receipt closure. Reserve every parse token before
   // parsing, and declared expansion before inflation. Do not run the full
   // decoder again: it makes additional unmetered projection and row copies.
   const parse=(text:string):any=>{
    budget.reserveBytes(Buffer.byteLength(text,'utf8')*2);
    for(let i=0;i<text.length;i++){
     const code=text.charCodeAt(i);
     if(code===34){slots();for(i++;i<text.length;i++){if(text.charCodeAt(i)===92){i++;continue;}if(text.charCodeAt(i)===34)break;}continue;}
     if(code===123||code===91){slots();continue;}
     if(code===125||code===93||code===44||code===58||code===32||code===10||code===13||code===9)continue;
     slots();while(i+1<text.length){const next=text.charCodeAt(i+1);if(next===44||next===93||next===125||next===32||next===10||next===13||next===9)break;i++;}
    }
    return JSON.parse(text);
   };
   const decodeArchivedRow=(wire:string,ordinal:number):SemanticRow=>{
    guard();const envelope=parse(wire);need(envelope.format===2&&Number.isSafeInteger(envelope.decodedBytes)&&envelope.decodedBytes>0&&envelope.decodedBytes<=historySegmentLimits.decodedBytes,'Completion exact segment expansion metadata changed');
    let payload:any;
    if(envelope.codec==='identity-json-v2')payload=envelope.payload;
    else{
     need(envelope.codec==='deflate-raw-v2'&&typeof envelope.payload==='string'&&Number.isSafeInteger(envelope.payloadBytes)&&envelope.payloadBytes>0,'Completion exact segment codec changed');
     // Packed buffer, inflated buffer and decoded UTF8 string all precede parse.
     slots(5,envelope.payloadBytes+envelope.decodedBytes*2);
     const packed=Buffer.from(envelope.payload,'base64');need(packed.length===envelope.payloadBytes,'Completion packed length changed');
     const plain=inflateRawSync(packed,{maxOutputLength:envelope.decodedBytes});need(plain.length===envelope.decodedBytes,'Completion inflated length changed');
     payload=parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
    }
    const selected=payload?.rows?.[ordinal];need(payload?.format===2&&selected&&typeof selected.json==='string','Completion archived ordinal missing');
    slots(2,128);need(createHash('sha256').update(selected.json).digest('hex')===selected.jsonSha256,'Completion archived exact row hash changed');
    const row=parse(selected.json) as SemanticRow;guard();return row;
   };
   const archivedRow=(descriptor:CompletionRowDescriptor):SemanticRow=>{
    need(ownedObjects.has(descriptor)&&descriptor.kind==='row'&&descriptor.value.custody.kind!=='active','Completion archive requires its actual reader descriptor');
    const custody=descriptor.value.custody,segment=object('segment',custody.segmentId);need(segment?.kind==='segment','Completion archived segment missing');
    const row=decodeArchivedRow(segment.value.wire,custody.ordinal);
    need(row.id===descriptor.key&&row.revision===descriptor.value.revision,'Completion archived custody changed');return budget.copy(row);
   };
   // Reserve the private port and wrappers before exposing them. Actual fact
   // inputs carry identity by frozen object reference, not a caller length.
   slots(18,320);
   const reader:CompletionReader=Object.freeze({schema,originalToken,guard:()=>live(guard),
    assertBudget:(candidate:MutationPlanBudget)=>live(()=>{need(candidate===budget,'Completion reader budget changed');guard();}),
    current:()=>live(()=>{guard();return current;}),
    rowKeys:()=>live(()=>keys('service_records')),
    objectKeys:(kind:HistoryObjectKind)=>live(()=>keys('feed_history_objects',kind)),
    object:(kind:HistoryObjectKind,id:string)=>live(()=>object(kind,id)),activeRow:(id:string)=>live(()=>activeRow(id)),receipt:(id:string)=>live(()=>receipt(id)),
    rowFact:(row:SemanticRow)=>live(()=>rowFact(row)),objectFact:(value:HistoryStoredObject)=>live(()=>objectFact(value)),receiptFact:(value:SemanticReceipt)=>live(()=>receiptFact(value)),
    archivedRow:(descriptor:CompletionRowDescriptor)=>live(()=>archivedRow(descriptor)),
    ...(selected?{
     selectedState:(state:object|undefined)=>live(()=>assertSelectedOriginalState(selected,reader,budget,state)),
     selectedOriginal:(state:object|undefined,slot:0|1)=>live(()=>readSelectedOriginal(selected,reader,budget,state,slot)),
    }:{}),
   });
   let context:ProducerActualContext|undefined;
   if(selected){
    bindSelectedOriginalReader(selected,reader,budget);slots(5,288);
    context=Object.freeze({reader,stored,state:selectedState}) as ProducerActualContext;
    actualContexts.set(context,{source,budget,guard:()=>live(guard),ports:producerPorts!,limits:storeLimits,native,state:selectedState,selected});
   }
   try{
    guard();const result=consume(reader,context);readerAlive=false;if(context)actualContexts.delete(context);
    const then=result!==null&&(typeof result==='object'||typeof result==='function')?(result as any).then:undefined;
    if(typeof then==='function'){
     // Do not invoke an arbitrary thenable after rejecting the synchronous
     // contract. A genuine Promise only receives a rejection handler.
     if(result instanceof Promise)Promise.prototype.then.call(result,undefined,()=>undefined);
     throw Error('Completion reader callback must be synchronous');
    }
    guard();return result;
   }catch(error){return budget.fail(error);}finally{
    readerAlive=false;
    // The enclosing complete selected-proof wrapper still performs its final
    // token guard. Context access ends here; the reader owner expires in the
    // outermost finally immediately after that guard returns.
    if(context)actualContexts.delete(context);
    // Cursor return work was prepaid at creation and cannot be stranded by a
    // swallowed callback failure or a now-exhausted budget.
    let cleanupFailed=false,cleanupError:unknown;
    for(const close of cursors)try{close();}catch(error){cleanupFailed=true;cleanupError=error;}
    if(cleanupFailed)budget.fail(cleanupError);
   }
   };
   if(selection)return withSelectedOriginalProof(source,storeLimits,native,selectedState,budget,guard,consumeVerified);
   verifyHistoryInventory(source,storeLimits,native);return consumeVerified();
  },schema,()=>{if(newWork)budget.query();});
 });}catch(error){return budget.fail(error);}finally{alive=false;}
}
