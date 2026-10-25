import type {SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';
import {assertHistoryUtf8Key,compareHistoryKeys} from '../../packages/domain/news-feed-history-keys.js';
import type {HistoryInventoryAccess} from './feed-history-inventory.js';
import type {MutationPlanBudget} from './feed-history-projected-inventory.js';
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}

/** Data-only factor of the maintained sequence receipt overlay. It cannot
 * issue selected facts, bind readers or authorize effects. */
export function withHistoryPendingInventory<T>(access:HistoryInventoryAccess,pending:SemanticReceipt,budget:MutationPlanBudget,
 ownerGuard:()=>void,consume:(access:HistoryInventoryAccess)=>T):T{return budget.checked(()=>{
  budget.query();const sourceToken=access.token(),original=budget.copy(pending);let alive=true;
  for(let i=0;i<6;i++)budget.entry();budget.reserveBytes(384);
  const guard=()=>{ownerGuard();budget.query();need(alive&&access.token()===sourceToken,'Private receipt proof ended or changed');};
  const read=<T>(fn:()=>T):T=>budget.checked(()=>{guard();const value=fn();guard();return value;});
  const key=(value:string)=>{need(typeof value==='string'&&value.length<=8192,'Private receipt key bound');
   budget.entry();budget.entry();budget.reserveBytes(32+value.length*12);assertHistoryUtf8Key(value);};
  const compare=(a:string,b:string)=>{key(a);key(b);return compareHistoryKeys(a,b);};
  key(original.requestId);need(!read(()=>access.receipt(original.requestId)),'Private pending receipt is already actual');
  
  function* receiptInventory():Generator<SemanticReceipt>{
   // Base iterable/iterator and prepaid return-result cleanup are owned before
   // opening the cursor; cleanup never consults an already failed budget.
   for(let i=0;i<3;i++)budget.entry();budget.reserveBytes(128);
   const iterator=access.receipts()[Symbol.iterator]();let inserted=false,previous:string|undefined;
   try{for(;;){guard();for(let i=0;i<3;i++)budget.entry();budget.reserveBytes(96);
    const step=iterator.next();guard();if(step.done)break;const value=step.value;
    if(previous!==undefined)need(compare(previous,value.requestId)<0,'Private receipt actual order/duplicate');previous=value.requestId;
    const order=compare(original.requestId,value.requestId);need(order!==0,'Private pending receipt is already actual');
    if(!inserted&&order<0){budget.entry();budget.reserveBytes(32);inserted=true;yield original;guard();}
    yield value;
   }
   if(!inserted){guard();budget.entry();budget.reserveBytes(32);yield original;guard();}
   }catch(error){budget.fail(error);}finally{try{iterator.return?.();}catch(error){budget.fail(error);}}
  }
  // Port plus exact method closures; no wrapper retains application data.
  for(let i=0;i<10;i++)budget.entry();budget.reserveBytes(640);
  const actual:HistoryInventoryAccess={schema:access.schema,token:()=>read(()=>sourceToken),
   object:(kind,id)=>read(()=>access.object(kind,id)),objects:kind=>read(()=>access.objects(kind)),stops:id=>read(()=>access.stops(id)),
   activeRow:id=>read(()=>access.activeRow(id)),activeRows:()=>read(()=>access.activeRows()),
   receipt:id=>read(()=>id===original.requestId?original:access.receipt(id)),
   receipts:()=>read(()=>{budget.entry();budget.reserveBytes(96);return receiptInventory();})};
  try{const result=consume(actual);guard();return result;}finally{alive=false;}
 });}
