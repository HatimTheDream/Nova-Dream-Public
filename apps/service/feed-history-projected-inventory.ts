import {z} from 'zod';
import {canonical} from '../../packages/domain/contracts.js';
import {assertHistoryUtf8Key,compareHistoryKeys} from '../../packages/domain/news-feed-history-keys.js';
import type {HistoryObjectKind,HistoryStoredObject} from '../../packages/domain/news-feed-history-storage.js';
import type {SemanticReceipt,SemanticRow} from '../../packages/domain/news-feed-semantic-journal.js';
import type {HistoryInventoryAccess} from './feed-history-inventory.js';
import {historyJsonBytes} from './feed-history-bounds.js';

const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const mutationPlanLimitsSchema=z.object({qualification:z.literal('unqualified'),entries:positive,bytes:positive,queries:positive}).strict();
export type MutationPlanLimits=z.infer<typeof mutationPlanLimitsSchema>;
export function mutationNeed(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

/** Cumulative logical copy/work bound only; not a heap or disk qualification. */
export class MutationPlanBudget{
 readonly limits:MutationPlanLimits;private failed=false;private failure:unknown;private entryCount=0;private byteCount=0;private queryCount=0;
 constructor(raw:MutationPlanLimits){historyJsonBytes(raw,1024);this.limits=Object.freeze(mutationPlanLimitsSchema.parse(raw));mutationNeed(equal(raw,this.limits),'Strict mutation plan limits required');}
 fail(error:unknown):never{if(!this.failed){this.failed=true;this.failure=error;}throw this.failure;}
 checked<T>(work:()=>T):T{if(this.failed)throw this.failure;try{return work();}catch(error){return this.fail(error);}}
 entry(){this.checked(()=>{mutationNeed(this.entryCount<this.limits.entries,'Mutation plan entry bound');this.entryCount++;});}
 query(){this.checked(()=>{mutationNeed(this.queryCount<this.limits.queries,'Mutation plan query bound');this.queryCount++;});}
 reserveBytes(size:number){this.checked(()=>{mutationNeed(Number.isSafeInteger(size)&&size>=0&&Number.isSafeInteger(this.byteCount+size)&&this.byteCount+size<=this.limits.bytes,'Mutation plan byte bound');this.byteCount+=size;});}
 bytes(value:unknown){return this.checked(()=>{const size=historyJsonBytes(value,this.limits.bytes-this.byteCount);this.reserveBytes(size);return size;});}
 copy<T>(value:T):T{return this.checked(()=>{this.entry();const size=this.bytes(value);this.reserveBytes(size);
  // Reserve the serialized text and parsed copy separately, and every nested
  // object before JSON.parse allocates any of them. The traversal array is
  // reused for freezing the already preflighted copy.
  this.entry();const pending:object[]=[];
  if(value!==null&&typeof value==='object'){this.entry();pending.push(value);}
  while(pending.length){const item=pending.pop()!;for(const key in item)if(Object.hasOwn(item,key)){const child=(item as any)[key];if(child!==null&&typeof child==='object'){this.entry();pending.push(child);}}}
  const copied=JSON.parse(JSON.stringify(value));
  // Preserve ordinary JSON insertion order. Canonical-copy reordering changes
  // existing capture.brief prompt validation and must never be used here.
  if(copied!==null&&typeof copied==='object')pending.push(copied);
  while(pending.length){const item=pending.pop()!;for(const key in item)if(Object.hasOwn(item,key)){const child=(item as any)[key];if(child!==null&&typeof child==='object')pending.push(child);}Object.freeze(item);}
  return copied;});}
 stats(){return Object.freeze({entries:this.entryCount,bytes:this.byteCount,queries:this.queryCount,qualification:'unqualified' as const});}
}
export type HistoryObjectChange=Readonly<{before?:HistoryStoredObject;after:HistoryStoredObject}>;
export type HistoryRowChange=Readonly<{before?:SemanticRow;after:SemanticRow}>;
export type HistoryProjectionDelta=Readonly<{row?:HistoryRowChange;objects:readonly HistoryObjectChange[];pending?:SemanticReceipt}>;

/** Private data adapter only. It does not verify a graph or confer authority.
 * Complete verification belongs to the planner. Every lookup/iterator expires;
 * originals are copied before exposure and only the small delta is retained. */
export function withHistoryProjectedInventory<T>(source:HistoryInventoryAccess,delta:HistoryProjectionDelta,budget:MutationPlanBudget,
 consume:(access:HistoryInventoryAccess)=>T):T{
 const token=source.token();let alive=true;
 const current=()=>budget.checked(()=>{budget.query();mutationNeed(source.token()===token,'Mutation projection source changed');});
 const guard=()=>budget.checked(()=>{mutationNeed(alive,'Mutation projection ended');current();});
 const read=<V>(fn:()=>V):V=>budget.checked(()=>{guard();const value=fn();guard();return value;});
 budget.entry();const changes=new Map<string,HistoryObjectChange>();
 const identity=(kind:HistoryObjectKind,key:string)=>{assertHistoryUtf8Key(key);budget.entry();budget.bytes(kind);budget.bytes(key);return kind+':'+key;};
 for(const raw of delta.objects){guard();const change=budget.copy(raw),key=identity(change.after.kind,change.after.key);mutationNeed(!changes.has(key),'Duplicate projected object');
  mutationNeed(equal(source.object(change.after.kind,change.after.key),change.before),'Projected object predecessor changed');budget.entry();changes.set(key,change);}
 const row=delta.row?budget.copy(delta.row):undefined,pending=delta.pending?budget.copy(delta.pending):undefined;
 if(row)mutationNeed(equal(source.activeRow(row.after.id),row.before),'Projected active predecessor changed');
 if(pending){assertHistoryUtf8Key(pending.requestId);mutationNeed(!source.receipt(pending.requestId),'Private pending receipt is already actual');}
 const objectCompare=(a:HistoryStoredObject,b:HistoryStoredObject)=>compareHistoryKeys(a.kind,b.kind)||compareHistoryKeys(a.key,b.key);
 budget.entry();budget.reserveBytes(2);const additions:HistoryStoredObject[]=[];
 for(const change of changes.values()){budget.entry();budget.bytes(change.after);additions.push(change.after);}additions.sort(objectCompare);
 budget.entry();budget.reserveBytes(2);const rowItems:SemanticRow[]=[];if(row){budget.entry();budget.bytes(row.after);rowItems.push(row.after);}
 budget.entry();budget.reserveBytes(2);const pendingItems:SemanticReceipt[]=[];if(pending){budget.entry();budget.bytes(pending);pendingItems.push(pending);}
 function selected(kind:HistoryObjectKind,target?:string){budget.entry();budget.reserveBytes(2);const list:HistoryStoredObject[]=[];
  for(const value of additions)if(value.kind===kind&&(target===undefined||value.rangeKey===target)){budget.entry();budget.bytes(value);list.push(value);}return list;}
 function copied<V>(value:V|undefined):V|undefined{return value===undefined?undefined:budget.copy(value);}
 function reserveResults(){
  // Source iteration, the merge generator and our returned wrapper can each
  // allocate a result. Reserve all three before advancing/closing an iterator,
  // even when it is already done. Payload copies are charged separately.
  for(let i=0;i<3;i++)budget.entry();budget.reserveBytes(3*Buffer.byteLength('{"done":false,"value":}'));
 }
 function result<V>(done:true):IteratorResult<V>;function result<V>(done:false,value:V):IteratorResult<V>;
 function result<V>(done:boolean,value?:V):IteratorResult<V>{
  if(done)return Object.freeze({done:true,value:undefined as any});
  budget.bytes(value);return Object.freeze({done:false,value:value!});}
 function sequence<V>(produce:()=>Iterator<V>):IterableIterator<V>{guard();for(let i=0;i<3;i++)budget.entry();const iterator=produce();
  const wrapper:IterableIterator<V>={next:()=>read(()=>{reserveResults();const item=iterator.next();return item.done?result<V>(true):result(false,budget.copy(item.value));}),
   return:()=>read(()=>{reserveResults();if(iterator.return)iterator.return();return result<V>(true);}),[Symbol.iterator](){guard();return this;}};
  return Object.freeze(wrapper);}
 function* merge<V>(base:Iterable<V>,extra:readonly V[],compare:(a:V,b:V)=>number,expected:(value:V)=>V|undefined){
  let i=0,prior:V|undefined;
  for(const value of base){guard();if(prior!==undefined)mutationNeed(compare(prior,value)<0,'Projected base inventory order/duplicate');prior=value;
   while(i<extra.length&&compare(extra[i]!,value)<0){const next=extra[i++]!;mutationNeed(expected(next)===undefined,'Projected predecessor omitted from inventory');yield next;}
   if(i<extra.length&&compare(extra[i]!,value)===0){const next=extra[i++]!;mutationNeed(equal(value,expected(next)),'Projected predecessor inventory mismatch');yield next;}else yield value;
  }
  while(i<extra.length){const next=extra[i++]!;mutationNeed(expected(next)===undefined,'Projected predecessor omitted at inventory end');yield next;}
 }
 budget.entry();const port:HistoryInventoryAccess=Object.freeze({schema:source.schema,token:()=>{guard();return token;},
  object:(kind:HistoryObjectKind,key:string)=>read(()=>copied(changes.get(identity(kind,key))?.after??source.object(kind,key))),
  objects:(kind?:HistoryObjectKind)=>sequence(()=>merge(source.objects(kind),kind===undefined?additions:selected(kind),objectCompare,x=>changes.get(identity(x.kind,x.key))?.before)),
  stops:(target:string)=>sequence(()=>{assertHistoryUtf8Key(target);return merge(source.stops(target),selected('stop',target),(a,b)=>compareHistoryKeys(a.key,b.key),x=>changes.get(identity(x.kind,x.key))?.before);}),
  activeRow:(id:string)=>read(()=>{assertHistoryUtf8Key(id);return copied(row?.after.id===id?row.after:source.activeRow(id));}),
  activeRows:()=>sequence(()=>merge(source.activeRows(),rowItems,(a,b)=>compareHistoryKeys(a.id,b.id),()=>row?.before)),
  receipt:(id:string)=>read(()=>{assertHistoryUtf8Key(id);return copied(pending?.requestId===id?pending:source.receipt(id));}),
  receipts:()=>sequence(()=>merge(source.receipts(),pendingItems,(a,b)=>compareHistoryKeys(a.requestId,b.requestId),()=>undefined)),
 });
 try{guard();const result=consume(port);alive=false;
  const then=result!==null&&(typeof result==='object'||typeof result==='function')?(result as any).then:undefined;
  if(typeof then==='function'){
   void new Promise((resolve,reject)=>{try{Reflect.apply(then,result,[resolve,reject]);}catch(error){reject(error);}}).then(()=>undefined,()=>undefined);
   throw Error('Mutation projection callback must be synchronous');
  }
  current();return result;
 }catch(error){return budget.fail(error);}finally{alive=false;}
}
