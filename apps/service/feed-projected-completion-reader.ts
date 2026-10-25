import type {CompletionReader,CompletionRowDescriptor} from './feed-completion-reader.js';
import type {CompletionAmount} from './feed-completion-contract.js';
import type {HistoryObjectKind,HistoryStoredObject} from '../../packages/domain/news-feed-history-storage.js';
import type {SemanticRow,SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';
import {compareHistoryKeys} from '../../packages/domain/news-feed-history-keys.js';
import {MutationPlanBudget} from './feed-history-projected-inventory.js';
import {assertSelectedOriginalState,readSelectedOriginal,type SelectedOriginalProof} from './feed-selected-original-proof.js';

export type PreparedCompletionChange=Readonly<{kind:'row';after:SemanticRow;ciphertextBytes:number}>|
 Readonly<{kind:'object';after:HistoryStoredObject;ciphertextBytes:number}>;
export type PreparedCompletionReceipt=Readonly<{receipt:SemanticReceipt;ciphertextBytes:number}>;

/** Internal adapter invoked only after complete final projected graph proof.
 * Unchanged reads preserve actual-reader reference provenance. Prepared facts
 * are exact encrypted successors owned by B; no public caller supplies lengths. */
export function withProjectedCompletionReader<T>(actual:CompletionReader,changes:readonly PreparedCompletionChange[],
 pending:PreparedCompletionReceipt|undefined,current:CompletionAmount,budget:MutationPlanBudget,consume:(reader:CompletionReader)=>T,selected?:SelectedOriginalProof):T{
 return budget.checked(()=>{actual.assertBudget(budget);let alive=true;
 const guard=()=>budget.checked(()=>{if(!alive)throw Error('Projected completion reader expired');actual.guard();});
 const read=<V>(fn:()=>V):V=>budget.checked(()=>{guard();const result=fn();guard();return result;});
 budget.entry();budget.entry();budget.reserveBytes(128);const rows=new Map<string,Extract<PreparedCompletionChange,{kind:'row'}>>(),objects=new Map<string,Extract<PreparedCompletionChange,{kind:'object'}>>();
 const objectKey=(kind:HistoryObjectKind,id:string)=>{budget.entry();budget.reserveBytes(kind.length+id.length*6+8);return kind+':'+id;};
 budget.entry();budget.reserveBytes(2);const retained:PreparedCompletionChange[]=[];
 for(let ci=0;ci<changes.length;ci++){const change=changes[ci]!;guard();if(!Number.isSafeInteger(change.ciphertextBytes)||change.ciphertextBytes<28)throw Error('Prepared completion ciphertext length');
  if(!Object.isFrozen(change.after))throw Error('Prepared value must be immutable');budget.entry();budget.entry();budget.entry();budget.reserveBytes(128);
  const kept=Object.freeze({...change});retained.push(kept);
  if(kept.kind==='row'){budget.bytes(kept.after.id);rows.set(kept.after.id,kept);}else objects.set(objectKey(kept.after.kind,kept.after.key),kept);}
 const originalPending=pending;if(originalPending){if(!Object.isFrozen(originalPending.receipt))throw Error('Prepared receipt must be immutable');budget.entry();budget.reserveBytes(96);pending=Object.freeze({receipt:originalPending.receipt,ciphertextBytes:originalPending.ciphertextBytes});}
 const compare=(a:string,b:string)=>{budget.entry();budget.reserveBytes((a.length+b.length)*8+32);return compareHistoryKeys(a,b);};
 function keys(produce:()=>IterableIterator<string>,kind?:HistoryObjectKind):IterableIterator<string>{return read(()=>{
  budget.entry();budget.reserveBytes(2);const extra:string[]=[];
  for(let ri=0;ri<retained.length;ri++){const c=retained[ri]!;if(kind===undefined&&c.kind==='row'){budget.entry();budget.bytes(c.after.id);extra.push(c.after.id);}else if(c.kind==='object'&&c.after.kind===kind){budget.entry();budget.bytes(c.after.key);extra.push(c.after.key);}}
  extra.sort(compare);budget.entry();budget.reserveBytes(128);const base=produce();let item:IteratorResult<string>|undefined,index=0,done=false;
  const reserve=()=>{budget.entry();budget.reserveBytes(32);};
  budget.entry();const iterator:IterableIterator<string>={next:()=>read(()=>{reserve();if(done)return {done:true,value:undefined};
   if(item===undefined)item=base.next();
   let value:string;
   if(item.done){if(index>=extra.length){done=true;return {done:true,value:undefined};}value=extra[index++]!;}
   else if(index<extra.length){const order=compare(extra[index]!,item.value);if(order<=0){value=extra[index++]!;if(order===0)item=undefined;}else{value=item.value;item=undefined;}}
   else{value=item.value;item=undefined;}budget.bytes(value);return {done:false,value};}),
   return:()=>read(()=>{reserve();done=true;base.return?.();return {done:true,value:undefined};}),[Symbol.iterator](){guard();return this;}};
  return Object.freeze(iterator);
 });}
 const changedObject=(object:HistoryStoredObject)=>objects.get(objectKey(object.kind,object.key));
 for(let i=0;i<18;i++)budget.entry();budget.reserveBytes(512);const reader:CompletionReader=Object.freeze({schema:actual.schema,originalToken:actual.originalToken,guard,
  assertBudget:(value:MutationPlanBudget)=>read(()=>{if(value!==budget)throw Error('Projected reader budget identity changed');actual.assertBudget(value);}),
  current:()=>read(()=>{budget.entry();budget.reserveBytes(96);return Object.freeze({...current});}),
  rowKeys:()=>keys(()=>actual.rowKeys()),objectKeys:(kind:HistoryObjectKind)=>keys(()=>actual.objectKeys(kind),kind),
  activeRow:(id:string)=>read(()=>rows.get(id)?.after??actual.activeRow(id)),
  object:(kind:HistoryObjectKind,id:string)=>read(()=>objects.get(objectKey(kind,id))?.after??actual.object(kind,id)),
  receipt:(id:string)=>read(()=>pending?.receipt.requestId===id?pending.receipt:actual.receipt(id)),
  rowFact:(row:SemanticRow)=>read(()=>{const changed=rows.get(row.id);if(!changed)return actual.rowFact(row);if(changed.after!==row)throw Error('Prepared row provenance changed');
   budget.entry();budget.reserveBytes(96);return Object.freeze({row,ciphertextBytes:changed.ciphertextBytes});}),
  objectFact:(object:HistoryStoredObject)=>read(()=>{const changed=changedObject(object);if(!changed)return actual.objectFact(object);if(changed.after!==object)throw Error('Prepared object provenance changed');
   budget.entry();budget.reserveBytes(96);return Object.freeze({object,ciphertextBytes:changed.ciphertextBytes});}),
  receiptFact:(receipt:SemanticReceipt)=>read(()=>{if(receipt.requestId!==pending?.receipt.requestId)return actual.receiptFact(receipt);if(pending.receipt!==receipt)throw Error('Prepared receipt provenance changed');
   budget.entry();budget.reserveBytes(96);return Object.freeze({receipt,ciphertextBytes:pending.ciphertextBytes});}),
  archivedRow:(descriptor:CompletionRowDescriptor)=>read(()=>{if(changedObject(descriptor))throw Error('Prepared archival custody is unavailable');return actual.archivedRow(descriptor);}),
  ...(selected?{
   selectedState:(state:object|undefined)=>read(()=>assertSelectedOriginalState(selected,reader,budget,state)),
   selectedOriginal:(state:object|undefined,slot:0|1)=>read(()=>readSelectedOriginal(selected,reader,budget,state,slot)),
  }:{}),
 });
 try{guard();const result=consume(reader);alive=false;
  const then=result!==null&&(typeof result==='object'||typeof result==='function')?(result as any).then:undefined;
  if(typeof then==='function'){if(result instanceof Promise)Promise.prototype.then.call(result,undefined,()=>undefined);throw Error('Projected completion callback must remain synchronous');}
  actual.guard();budget.checked(()=>undefined);return result;
 }catch(error){return budget.fail(error);}finally{alive=false;}
 });
}
