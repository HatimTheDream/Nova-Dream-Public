import {z} from 'zod';
import {canonical} from '../../packages/domain/contracts.js';
import {assertHistoryUtf8Key} from '../../packages/domain/news-feed-history-keys.js';
import type {HistoryStoreLimits} from '../../packages/domain/news-feed-history-storage.js';
import type {WorkerIdentity} from '../../packages/domain/worker.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import {verifyHistoryInventory,type HistoryInventoryAccess} from './feed-history-inventory.js';

const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const limitsSchema=z.object({qualification:z.literal('unqualified'),entries:positive,bytes:positive,queries:positive}).strict();
export type HistoryReceiptClosureLimits=z.infer<typeof limitsSchema>;
type Native=(worker:WorkerIdentity)=>{runId:string;sessionKey:string};
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
function exactKey(value:unknown):asserts value is string{
 need(typeof value==='string'&&value.length<=8192&&Buffer.byteLength(value,'utf8')<=8192,'Historical receipt key exceeds its exact SQL bound');
 assertHistoryUtf8Key(value);
}

/** Private, complete-snapshot data projection. False is not reusable removal
 * authority. The caller must own the actual Store transaction and all later
 * mutation guards. No mutable set, iterator, SQL port or historical row escapes.
 * These logical bounds do not measure heap, disk or production performance. */
export function withHistoryProtectedReceipts<T>(access:HistoryInventoryAccess,storeLimits:HistoryStoreLimits,native:Native,
 rawLimits:HistoryReceiptClosureLimits,consume:(protectedReceipt:(requestId:string)=>boolean)=>T):T{
 historyJsonBytes(rawLimits,1024);
 const limits=limitsSchema.parse(rawLimits);need(canonical(limits)===canonical(rawLimits),'Exact historical receipt closure limits required');
 const token=access.token();let alive=true,failed=false,entries=0,bytes=0,queries=0;
 const checked=<V>(work:()=>V):V=>{need(!failed,'Historical receipt closure previously failed');try{return work();}catch(error){failed=true;throw error;}};
 const guard=()=>checked(()=>need(alive&&access.token()===token,'Historical receipt closure snapshot ended or changed'));
 const charge=(value:string)=>checked(()=>{
  need(entries<limits.entries,'Historical receipt closure entry bound');
  const size=historyJsonBytes(value,limits.bytes-bytes);
  need(Number.isSafeInteger(bytes+size)&&bytes+size<=limits.bytes,'Historical receipt closure byte bound');
  entries++;bytes+=size;
 });
 try{
  verifyHistoryInventory(access,storeLimits,native);guard();
  charge('$membership-set');charge('$membership-predicate');
  const ids=new Set<string>();
  const keep=(id:string)=>{guard();exactKey(id);if(ids.has(id))return;charge(id);
   need(access.receipt(id),'Historical protected receipt is absent');ids.add(id);guard();};
  for(const object of access.objects()){
   guard();
   if(object.kind==='request'&&object.value.status==='admitted')keep(object.value.requestId);
   else if(object.kind==='row'){for(const edge of object.value.edges)if(edge.kind==='receipt')keep(edge.requestId);}
   else if(object.kind==='revision')keep(object.value.requestId);
   else if(object.kind==='intent'&&!access.object('outcome',object.key))for(const receipt of object.value.protection.receipts)keep(receipt.id);
  }
  const predicate=Object.freeze((requestId:string)=>checked(()=>{
   guard();need(queries<limits.queries,'Historical receipt closure query bound');queries++;
   exactKey(requestId);return ids.has(requestId);
  }));
  guard();const result=consume(predicate);
  const then=result!==null&&(typeof result==='object'||typeof result==='function')?(result as {then?:unknown}).then:undefined;
  if(typeof then==='function'){
   // Expire lexical access before observing this exact captured method. A
   // second getter read could observe a different or missing original method.
   alive=false;
   void new Promise((resolve,reject)=>{try{Reflect.apply(then,result,[resolve,reject]);}catch(error){reject(error);}})
    .then(()=>undefined,()=>undefined);
   throw Error('Historical receipt closure callback must be synchronous');
  }
  guard();return result;
 }finally{alive=false;}
}
