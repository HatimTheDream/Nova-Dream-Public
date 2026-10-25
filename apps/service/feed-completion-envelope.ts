import {createHash} from 'node:crypto';
import type {z} from 'zod';
import {canonical} from '../../packages/domain/contracts.js';
import * as legacy from '../../packages/domain/news-feed-worker.js';
import * as adaptive from '../../packages/domain/news-feed-adaptive-worker.js';
import * as local from '../../packages/domain/news-feed-successor-journal.js';
import * as legacyRows from '../../packages/domain/news-feed-semantic-journal.js';
import * as adaptiveRows from '../../packages/domain/news-feed-adaptive-graph.js';
import {describeHistoryRow,type HistoryRowIndex} from '../../packages/domain/news-feed-history-graph.js';
import {sealObject,type HistoryStoredObject} from '../../packages/domain/news-feed-history-storage.js';
import {assertHistoryUtf8Key,compareHistoryKeys} from '../../packages/domain/news-feed-history-keys.js';
import type {SemanticRow,SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';
import {workerNativeIdentity} from './worker-plugin/identity.js';
import {MutationPlanBudget,mutationNeed as need} from './feed-history-projected-inventory.js';
import {completionChild} from './feed-completion-allocation.js';
import {deriveSealCandidate} from './feed-history-seal-candidate.js';
import type {HistoryInventoryAccess} from './feed-history-inventory.js';
import {completionFactsSchema,completionResultSchema,type CompletionFacts,type CompletionResult,type CompletionAmount,
 type CompletionIdentity,type CompletionUnsupportedReason,type CompletionObligationSize,type CompletionWorkerFact,type CompletionCloseFact,
 type CompletionSealFact,type CompletionObjectFact,type CompletionRowFact,type CompletionReceiptFact} from './feed-completion-contract.js';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const MAX=Number.MAX_SAFE_INTEGER,U=38,H=66,I=16,N=32,GCM=28;
type Worker=legacy.FeedWorkerSaved|adaptive.FeedWorkerSaved;
const workerTerminal=(value:Worker)=>value.format===3?adaptive.terminal(value):legacy.terminal(value);
function receiptShape(value:unknown):value is SemanticReceipt{
 return value!==null&&typeof value==='object'&&'requestId'in value&&typeof value.requestId==='string'&&
  'deviceId'in value&&typeof value.deviceId==='string'&&'digest'in value&&typeof value.digest==='string'&&'value'in value;
}
type Blocker={identity:CompletionIdentity;reason:CompletionUnsupportedReason};
const reasons:CompletionUnsupportedReason[]=['worker-events-exhausted','worker-revision-exhausted','row-descriptor-revision-exhausted',
 'request-descriptor-revision-exhausted','seal-row-descriptor-revision-exhausted'];

/** Pure unqualified arithmetic only. Actual snapshot completeness, authenticated
 * lengths, all-writer reservation and native/physical eligibility are not proved
 * by data passed here. No callback, clock, database or filesystem is consulted. */
export function deriveFeedCompletionEnvelope(input:CompletionFacts,budget:MutationPlanBudget):CompletionResult{
 return budget.checked(()=>{
  // Strict JSON preflight and cumulative reservation precede every parser/copy.
  const raw=budget.copy(input);
  function reserveTree(value:unknown){
   budget.entry();const stack:unknown[]=[value];
   while(stack.length){const current=stack.pop();budget.entry();
    if(current!==null&&typeof current==='object')for(const key in current)if(Object.hasOwn(current,key)){
     // Reserve every copied field. Only containers require a traversal slot;
     // primitives are already validated by strict JSON preflight and do not
     // need an allocated stack entry or a second visit.
     budget.entry();const child=(current as Record<string,unknown>)[key];
     if(child!==null&&typeof child==='object')stack.push(child);
    }
   }
  }
  function parse<T>(schema:z.ZodType<T>,value:unknown):T{budget.bytes(value);reserveTree(value);return schema.parse(value);}
  const facts=parse(completionFactsSchema,raw);
  // Inputs/derived values have already passed strict JSON validation. Compare
  // their semantic fields without allocating two canonical copies/strings.
  // Every field visit remains charged; exact row JSON commitments use json().
  function same(a:unknown,b:unknown):boolean{
   budget.entry();if(a===b)return true;if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
   if(Array.isArray(a)!==Array.isArray(b)||Array.isArray(a)&&a.length!==(b as unknown[]).length)return false;
   let left=0,right=0;for(const k in a)if(Object.hasOwn(a,k)){budget.entry();left++;if(!Object.hasOwn(b,k)||!same((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]))return false;}
   for(const k in b)if(Object.hasOwn(b,k)){budget.entry();right++;}return left===right;
  }
  function add(...values:number[]){budget.entry();let result=0;for(const value of values){budget.entry();need(Number.isSafeInteger(value)&&value>=0&&Number.isSafeInteger(result+value),'Completion arithmetic overflow');result+=value;}return result;}
  function mul(a:number,b:number){budget.entry();need(Number.isSafeInteger(a)&&a>=0&&Number.isSafeInteger(b)&&b>=0&&Number.isSafeInteger(a*b),'Completion arithmetic overflow');return a*b;}
  function sub(a:number,b:number){budget.entry();need(Number.isSafeInteger(a)&&Number.isSafeInteger(b)&&a>=b&&b>=0,'Completion arithmetic subtraction');return a-b;}
  const growth=(future:number,current:number)=>future>current?sub(future,current):0;
  const J=(value:unknown)=>budget.bytes(value);
  const S=(length:number)=>add(2,mul(6,length));
  function O(members:Record<string,number>){budget.entry();let result=2,count=0;for(const key in members){budget.entry();result=add(result,J(key),1,members[key]!,count++?1:0);}return result;}
  function A(items:readonly number[]){budget.entry();let result=2;for(let i=0;i<items.length;i++){budget.entry();result=add(result,items[i]!,i?1:0);}return result;}
  function repeated(existing:readonly unknown[],count:number,item:number){budget.entry();let result=2,n=0;for(const value of existing){budget.entry();result=add(result,J(value),n++?1:0);}for(let i=0;i<count;i++){budget.entry();result=add(result,item,n++?1:0);}return result;}
  function E(values:readonly string[]){budget.entry();let largest=0;for(const value of values){budget.entry();largest=Math.max(largest,J(value));}return largest;}
  function wrapper(kind:string,key:string,rangeKey:string|null,revision:number,value:number){return O({format:1,kind:J(kind),key:J(key),rangeKey:J(rangeKey),revision,value});}
  const cipher=(value:unknown)=>add(J(value),GCM);
  const amount=(entries:number,ciphertextBytes:number):CompletionAmount=>{budget.entry();budget.reserveBytes(96);add(entries);add(ciphertextBytes);return {entries,ciphertextBytes};};
  const maximum=(a:CompletionAmount,b:CompletionAmount)=>amount(Math.max(a.entries,b.entries),Math.max(a.ciphertextBytes,b.ciphertextBytes));
  budget.entry();const occupied=new Map<string,{bytes:number;json:string}>();
  budget.entry();const obligations:CompletionObligationSize[]=[];
  budget.entry();const blockers:Blocker[]=[];
  budget.entry();const originals=new Set<string>();
  function key(value:string,nonempty=false){need(!nonempty||value.length>0,'Completion semantic identity empty');const bytes=Buffer.byteLength(value);need(bytes<=8192,'Completion key byte bound');budget.reserveBytes(mul(3,bytes));assertHistoryUtf8Key(value);}
  function keyCompare(a:string,b:string){budget.reserveBytes(mul(3,add(Buffer.byteLength(a),Buffer.byteLength(b))));return compareHistoryKeys(a,b);}
  function json(value:unknown){J(value);return JSON.stringify(value);}
  function register(namespace:string,id:string,value:unknown,bytes:number){
   key(id,namespace!=='receipt');need(Number.isSafeInteger(bytes)&&bytes>GCM,'Completion ciphertext fact is invalid');
   budget.entry();budget.bytes(namespace);budget.bytes(id);const identity=namespace+':'+id,serialized=json(value),prior=occupied.get(identity);
   if(prior)need(prior.bytes===bytes&&prior.json===serialized,'Conflicting repeated completion fact');
   else{budget.entry();occupied.set(identity,{bytes,json:serialized});}
  }
  function row(fact:CompletionRowFact){key(fact.row.id,true);need(fact.row.id.startsWith('news:semantic-'),'Completion row is not semantic');register('row',fact.row.id,fact.row,fact.ciphertextBytes);}
  function object(fact:CompletionObjectFact){const o=fact.object;key(o.key,true);if(o.rangeKey!==null)key(o.rangeKey,true);
   need(o.key===(o.kind==='request'?o.value.requestId:['row','segment','operation','span','intent','outcome'].includes(o.kind)?('id'in o.value?o.value.id:undefined):'key'in o.value?o.value.key:undefined),'Completion catalogue key differs');
   need(o.rangeKey===(o.kind==='stop'?o.value.targetId:null),'Completion catalogue range differs');
   if(['segment','operation','intent','outcome'].includes(o.kind))need(o.revision===1,'Completion immutable catalogue revision');
   register('object:'+o.kind,o.key,o,fact.ciphertextBytes);
  }
  function receipt(fact:CompletionReceiptFact){key(fact.receipt.requestId);key(fact.receipt.deviceId);register('receipt',fact.receipt.requestId,fact.receipt,fact.ciphertextBytes);}
  function descriptor(r:SemanticRow,fact:CompletionObjectFact,active:boolean){object(fact);need(fact.object.kind==='row','Completion row descriptor kind');
   const d=fact.object.value;need(!active||d.custody.kind==='active','Completion active obligation is archived');
   need((d.kind==='learning'||d.kind==='control')===!!d.mutation,'Completion descriptor mutation metadata differs from kind');
   budget.entry();budget.reserveBytes(16);const inputs=[r,d.custody,d.mutation??null];
   const described=completionChild(budget,'descriptor',inputs,()=>describeHistoryRow(r,d.custody,hash,d.mutation));
   need(same(d,described.row),'Completion descriptor differs from exact row');return described;
  }
  function identity(kind:CompletionIdentity['kind'],id:string):CompletionIdentity{key(id,true);budget.entry();const name=kind+':'+id;budget.bytes(name);need(!originals.has(name),'Duplicate completion original');budget.entry();originals.add(name);return {kind,id};}
  function block(id:CompletionIdentity,reason:CompletionUnsupportedReason){budget.entry();blockers.push({identity:id,reason});}
  function revision(id:CompletionIdentity,current:number,count:number,reason:CompletionUnsupportedReason){need(Number.isSafeInteger(current)&&current>0,'Invalid completion revision');if(current>MAX-count)block(id,reason);}
  function validateWorker(r:SemanticRow):Worker{
   budget.bytes(r.value);reserveTree(r.value);
   const v=r.id.startsWith(adaptive.feedWorkerPrefix)?adaptive.validateFeedWorkerRecord(r.value as adaptive.FeedWorkerSaved,hash,workerNativeIdentity):legacy.validateFeedWorkerRecord(r.value as legacy.FeedWorkerSaved,hash,workerNativeIdentity);
   need(r.id===(v.format===3?adaptive.feedWorkerPrefix:legacy.feedWorkerPrefix)+v.id&&r.revision===v.revision,'Completion worker row identity differs');return v;
  }
  function closeTemplate(original:SemanticReceipt,command:Parameters<typeof local.closeAcknowledgement>[1],owner:string,target:local.FeedLocalRecord|undefined){
   // Reserve the input tuple before constructing it, then the whole child before
   // any ACK/map/descriptor/receipt producer. All original content is charged.
   budget.entry();budget.reserveBytes(8);const inputs=[original,command,target??null];
   return completionChild(budget,'close',inputs,()=>{
    const locals=new Map<string,local.FeedLocalRecord>();if(target)locals.set(target.id,target);
    const next=local.closeAcknowledgement(original,command,owner,MAX,{locals},hash),r={id:local.feedLocalPrefix+next.id,revision:1,value:next};
    const d=describeHistoryRow(r,{kind:'active'},hash),receiptValue=local.localOriginalReceipt(next,hash);
    return {row:next,descriptor:d.row,request:d.requests[0]!,receipt:receiptValue.value};
   });
  }
  function closeAmounts(template:ReturnType<typeof closeTemplate>,requestRevision:number){
   const rowCipherMax=cipher(template.row),rowDescriptorCipherMax=cipher(sealObject('row',template.descriptor));
   const requestDescriptorCipherMax=add(wrapper('request',template.request.requestId,null,requestRevision,J(template.request)),GCM),receiptCipherMax=cipher(template.receipt);
   return {rowCipherMax,rowDescriptorCipherMax,requestDescriptorCipherMax,receiptCipherMax,total:add(rowCipherMax,rowDescriptorCipherMax,requestDescriptorCipherMax,receiptCipherMax)};
  }
  let unresolved=0;
  function worker(fact:CompletionWorkerFact){
   row(fact.row);receipt(fact.originalReceipt);const v=completionChild(budget,'descriptor',fact.row.row,()=>validateWorker(fact.row.row)),d=descriptor(fact.row.row,fact.descriptor,!workerTerminal(v)),id=identity('worker',v.id);
   need(same(fact.originalReceipt.receipt,d.expected[0]),'Completion worker original receipt differs');
   if(fact.closeAcknowledgement){const ack=fact.closeAcknowledgement;receipt(ack.receipt);descriptor(ack.row,ack.descriptor,false);
    budget.entry();budget.reserveBytes(8);const inputs=[ack.row,ack.receipt.receipt];
    const a=completionChild(budget,'descriptor',inputs,()=>local.validateFeedLocalRow(ack.row,ack.receipt.receipt,hash));need(a.kind==='close-ack','Completion ACK has wrong kind');
    completionChild(budget,'close',fact,()=>{local.validateFeedLocalClose(a,{request:{kind:'start',command:v.command},deviceId:v.deviceId,at:v.createdAt,receipt:fact.originalReceipt.receipt},undefined,hash);return true;});
   }
   need(!d.row.mutation,'Worker descriptor cannot carry mutation metadata');
   if(workerTerminal(v))return;
   need(++unresolved<=1,'More than one unresolved completion worker');
   const remaining=16-v.ownerStops.length;
   if(v.events.length===32)block(id,'worker-events-exhausted');
   const steps=remaining>0?2:1;revision(id,v.revision,steps,'worker-revision-exhausted');revision(id,fact.descriptor.object.revision,steps,'row-descriptor-revision-exhausted');
   // All remaining fixed formula objects/enum arrays/member wrappers for one
   // worker are bounded by source structure,17 requests and32 events. Reserve
   // their frame before O({...}) arguments are constructed. Concrete values and
   // arithmetic still consume the shared counters below.
   budget.reserveBytes(32768);for(let n=0;n<512;n++)budget.entry();
   const stop=O({reason:E(['owner','deadline','context']),requestId:U,requestedAt:N,attemptedAt:N,state:E(['requested','dispatching','acknowledged','unknown']),
    abort:O({attemptedAt:N,state:E(['dispatching','acknowledged','unknown'])})});
   const stopCommand=O({...(v.format===3?{format:1}:{}),requestId:U,epoch:J(v.command.epoch),id:J(v.id)});
   const ownerStop=O({command:stopCommand,deviceId:J(v.deviceId),at:N}),event=O({kind:50,at:N});
   budget.entry();const original=v.format===3?adaptive.feedWorkerOriginal(v):legacy.feedWorkerOriginal(v);budget.entry();const immutable:Record<string,number>={};
   for(const name in original){budget.entry();immutable[name]=J(original[name as keyof typeof original]);}
   let workerPayloadMax=O({...immutable,format:J(v.format),revision:I,state:E(['prepared','dispatching','running','unknown','completed','failed','cancelled','withdrawn','rejected']),
    reason:S(200),originalReceipt:v.originalReceipt?J(v.originalReceipt):4096,latestReceipt:4096,hostId:U,runId:U,runtimeVersion:S(200),sessionKey:S(200),dispatchAt:N,stop,
    ownerStops:repeated(v.ownerStops,remaining,ownerStop),events:repeated(v.events,32-v.events.length,event),output:65536,
    terminal:O({kind:E(['not-sent','barrier','error','reply']),at:N,basisSha256:H,basis:v.format===3?458752:196608})});
   if(v.format===3)workerPayloadMax=Math.min(workerPayloadMax,1310720);
   const workerCipherMax=add(workerPayloadMax,GCM),index=d.row;
   const descriptorValue=O({format:1,id:J(index.id),revision:I,kind:J(index.kind),owner:J(index.owner),epoch:J(index.epoch),rowSha256:H,custody:J(index.custody),
    requests:repeated(index.requests,remaining,U),edges:J(index.edges)});
   const rowDescriptorCipherMax=add(wrapper('row',index.id,null,I,descriptorValue),GCM);
   const request=O({format:1,requestId:U,rowId:J(index.id),kind:J('stop'),owner:J(v.deviceId),epoch:J(v.command.epoch),at:I,requestSha256:H,status:J('admitted'),receiptSha256:H});
   const eachStopRequestCipherMax=add(O({format:1,kind:J('request'),key:U,rangeKey:4,revision:1,value:request}),GCM);
   const stopReceipt=v.format===3?O({type:J('feed-semantic-stop'),format:1,id:U,epoch:J(v.command.epoch),operationId:J(v.id),at:I,requestSha256:H}):
    O({type:J('feed-semantic-stop'),format:1,requestId:U,epoch:J(v.command.epoch),id:J(v.id),at:I});
   const eachStopReceiptCipherMax=add(stopReceipt,GCM);
   let closeHeadroom=amount(0,0);
   if(v.format===3&&!fact.closeAcknowledgement){const placeholder=v.id==='00000000-0000-4000-8000-000000000001'?'00000000-0000-4000-8000-000000000002':'00000000-0000-4000-8000-000000000001';
    const template=closeTemplate(fact.originalReceipt.receipt,{format:3,requestId:placeholder,epoch:v.command.epoch,original:v.command},v.deviceId,undefined);
    closeHeadroom=amount(4,closeAmounts(template,1).total);
   }
   const added=add(mul(remaining,2),closeHeadroom.entries),bytes=add(growth(workerCipherMax,fact.row.ciphertextBytes),growth(rowDescriptorCipherMax,fact.descriptor.ciphertextBytes),
    mul(remaining,add(eachStopRequestCipherMax,eachStopReceiptCipherMax)),closeHeadroom.ciphertextBytes);
   const terminalOverlap=amount(0,add(workerCipherMax,rowDescriptorCipherMax));
   const stopOverlap=remaining?amount(2,add(mul(2,workerCipherMax),mul(2,rowDescriptorCipherMax),eachStopRequestCipherMax,eachStopReceiptCipherMax)):terminalOverlap;
   budget.entry();obligations.push({kind:'worker',identity:id,workerPayloadMax,workerCipherMax,rowDescriptorCipherMax,remainingOwnerStops:remaining,eachStopRequestCipherMax,
    eachStopReceiptCipherMax,closeHeadroom,growth:amount(added,bytes),overlap:maximum(maximum(terminalOverlap,stopOverlap),closeHeadroom)});
  }
  function pendingClose(fact:CompletionCloseFact){
   row(fact.fence);receipt(fact.originalReceipt);const d=descriptor(fact.fence.row,fact.descriptor,true);
   budget.entry();budget.reserveBytes(8);const inputs=[fact.fence.row,fact.originalReceipt.receipt];
   const v=completionChild(budget,'descriptor',inputs,()=>local.validateFeedLocalRow(fact.fence.row,fact.originalReceipt.receipt,hash));
   need(v.kind==='closed-before-admission','Completion pending Close has no fence');const id=identity('pending-close',v.close.requestId);object(fact.pendingRequest);
   need(!d.row.mutation,'Local descriptor cannot carry mutation metadata');
   need(fact.pendingRequest.object.kind==='request'&&same(fact.pendingRequest.object.value,d.requests.find(r=>r.status==='pending-close')),'Completion pending request differs');
   revision(id,fact.pendingRequest.object.revision,1,'request-descriptor-revision-exhausted');
   const template=closeTemplate(fact.originalReceipt.receipt,v.close,v.deviceId,v),s=closeAmounts(template,I);
   budget.entry();obligations.push({kind:'pending-close',identity:id,rowCipherMax:s.rowCipherMax,rowDescriptorCipherMax:s.rowDescriptorCipherMax,
    requestDescriptorCipherMax:s.requestDescriptorCipherMax,receiptCipherMax:s.receiptCipherMax,
    growth:amount(3,add(s.rowCipherMax,s.rowDescriptorCipherMax,s.receiptCipherMax,growth(s.requestDescriptorCipherMax,fact.pendingRequest.ciphertextBytes))),overlap:amount(3,s.total)});
  }
  function pendingSeal(fact:CompletionSealFact){
   need(facts.schema===62,'Completion seal needs schema62');object(fact.intent);need(fact.intent.object.kind==='intent','Completion seal intent kind');
   const intent=fact.intent.object.value,id=identity('pending-seal',intent.id);need(intent.deadlineAt>intent.createdAt,'Completion seal original deadline');
   need(fact.selected.length===intent.rows.length,'Completion seal selected inventory differs');budget.entry();const objects=new Map<string,HistoryStoredObject>();budget.entry();const rows=new Map<string,SemanticRow>();budget.entry();const receipts=new Map<string,SemanticReceipt>();
   let blocked=false;
   for(let i=0;i<fact.selected.length;i++){budget.entry();const selected=fact.selected[i]!,r=selected.row.row,commit=intent.rows[i]!;row(selected.row);const described=descriptor(r,selected.descriptor,true);
    budget.reserveBytes(128);need(r.id===commit.id&&r.revision===commit.revision&&described.row.rowSha256===commit.rowSha256&&hash(json(r))===commit.jsonSha256&&same(selected.descriptor.object.value,commit.descriptor),'Completion seal exact source changed');
    need(!rows.has(r.id),'Duplicate completion seal selected row');budget.entry();rows.set(r.id,r);budget.entry();objects.set('row:'+r.id,selected.descriptor.object);
    if(selected.descriptor.object.revision===MAX){block(id,'seal-row-descriptor-revision-exhausted');blocked=true;}
   }
   for(const request of fact.requests){budget.entry();object(request);need(request.object.kind==='request','Completion seal request kind');const k='request:'+request.object.key;need(!objects.has(k),'Duplicate completion seal request');budget.entry();objects.set(k,request.object);}
   for(const item of fact.receipts){budget.entry();receipt(item);need(!receipts.has(item.receipt.requestId),'Duplicate completion seal receipt');budget.entry();receipts.set(item.receipt.requestId,item.receipt);}
   // The exact protected logical closure supplies only the dependencies needed
   // by existing per-kind validators. No active ciphertext is invented for an
   // archived dependency, and this does not recreate graph/control ancestry.
   budget.entry();const protectedRows=new Map<string,SemanticRow>();
   for(const [k,r] of rows){budget.entry();protectedRows.set(k,r);}
   for(const r of fact.dependencies){budget.entry();key(r.id,true);need(!protectedRows.has(r.id),'Duplicate completion protected dependency');budget.entry();protectedRows.set(r.id,r);}
   need(protectedRows.size===intent.protection.rows.length,'Completion protected dependency inventory differs');
   budget.entry();const protectedIds=new Set<string>();
   for(const expected of intent.protection.rows){budget.entry();need(!protectedIds.has(expected.id),'Duplicate completion protected commitment');budget.entry();protectedIds.add(expected.id);
    const r=protectedRows.get(expected.id);need(r&&r.revision===expected.revision,'Completion protected dependency changed or missing');
    const selected=intent.rows.find(item=>item.id===r.id);
    if(selected)need(selected.rowSha256===expected.rowSha256&&selected.jsonSha256===expected.jsonSha256,'Completion protected selected commitment differs');
    else{const actual=completionChild(budget,'descriptor',r,()=>({rowSha256:hash(canonical(r)),jsonSha256:hash(JSON.stringify(r))}));
     need(actual.rowSha256===expected.rowSha256&&actual.jsonSha256===expected.jsonSha256,'Completion protected dependency changed or missing');}
   }
   validateProtected(protectedRows,receipts);
   const read=<T>(fn:()=>T)=>budget.checked(()=>{budget.query();return fn();});
   const unused=():never=>{throw Error('Unexpected completion seal inventory operation');};
   budget.entry();const access:HistoryInventoryAccess={schema:62,token:()=>facts.originalToken,object:(kind,k)=>read(()=>objects.get(kind+':'+k)),activeRow:k=>read(()=>rows.get(k)),receipt:k=>read(()=>receipts.get(k)),
    objects:unused,activeRows:unused,receipts:unused,stops:unused};
   budget.entry();const ids:string[]=[];for(const selected of fact.selected){budget.entry();ids.push(selected.row.row.id);}
   // Existing bounded selected codec performs the correspondence calculation.
   // This is not full history validation or a SQL inventory port.
   // The codec reads only these selected inputs. Protected dependencies and the
   // intent's duplicate commitments were already validated above; neither is
   // read by this child, so they do not multiply its temporary-copy allowance.
   budget.entry();budget.reserveBytes(32);const codecInputs=[fact.selected,fact.requests,fact.receipts,intent.segmentId,intent.id];
   const candidate=completionChild(budget,'codec',codecInputs,()=>deriveSealCandidate(access,ids,intent.segmentId,intent.id));
   need(candidate.segment.wireSha256===intent.wireSha256&&candidate.operation.catalogueSha256===intent.catalogueSha256,'Completion seal target correspondence changed');
   need(candidate.operation.requests.length===fact.requests.length,'Completion seal request inventory is incomplete or extra');
   need(candidate.segment.receiptIds.length===fact.receipts.length&&candidate.segment.receiptIds.every(k=>receipts.has(k)),'Completion seal receipt inventory is incomplete or extra');
   for(const request of candidate.operation.requests)need(same(objects.get('request:'+request.requestId)?.value,request),'Completion seal request differs');
   budget.reserveBytes(8192);for(let n=0;n<128;n++)budget.entry();
   const normalizedIntent=sealObject('intent',intent),outcome={format:1,id:intent.id,intentSha256:'0'.repeat(64),state:'completed',at:intent.deadlineAt,segmentId:intent.segmentId,wireSha256:intent.wireSha256,catalogueSha256:intent.catalogueSha256};
   budget.entry();const additional:HistoryStoredObject[]=[normalizedIntent,sealObject('segment',candidate.segment),sealObject('operation',candidate.operation),sealObject('outcome',outcome)];
   let encoded=0,encrypted=0;for(const item of additional){budget.entry();const bytes=J(item);encoded=add(encoded,bytes);encrypted=add(encrypted,bytes,GCM);}
   for(const d of candidate.descriptors){budget.entry();const old=objects.get('row:'+d.id)!;
    // MAX+1 is encoded only as a checked decimal width, never an unsafe number
    // or purported valid successor object. Reservation corruption still fails
    // before an exhausted-revision result can be returned.
    const digits=(BigInt(old.revision)+1n).toString().length,bytes=wrapper(old.kind,old.key,old.rangeKey,digits,J(d));
    encoded=add(encoded,bytes);encrypted=add(encrypted,bytes,GCM);
   }
   need(same(intent.reservation,{addedObjects:4,encodedBytes:encoded,encryptedBytes:encrypted}),'Completion seal normalized reservation differs');
   if(blocked)return;
   const normalizedIntentCipherBytes=cipher(normalizedIntent),commit=amount(3,sub(encrypted,normalizedIntentCipherBytes));
   const notPerformedValue={format:1,id:intent.id,intentSha256:'0'.repeat(64),state:'not-performed',at:MAX,reason:'explicit-close'};
   const notPerformed=amount(1,cipher(sealObject('outcome',notPerformedValue))),owed=maximum(commit,notPerformed);
   budget.entry();obligations.push({kind:'pending-seal',identity:id,normalizedIntentCipherBytes,commit,notPerformed,growth:owed,overlap:owed});
  }
  function validateProtected(rows:Map<string,SemanticRow>,receipts:Map<string,SemanticReceipt>){
   budget.entry();const workers=new Map<string,Worker>();budget.entry();const locals=new Map<string,local.FeedLocalRecord>();
   budget.entry();const legacyReviews=new Map<string,ReturnType<typeof legacyRows.validateLegacyReviewRow>>();budget.entry();const adaptiveReviews=new Map<string,ReturnType<typeof adaptiveRows.validateAdaptiveReviewRow>>();
   for(const r of rows.values())if(r.id.startsWith(legacy.feedWorkerPrefix)||r.id.startsWith(adaptive.feedWorkerPrefix)){
    const v=completionChild(budget,'descriptor',r,()=>validateWorker(r));need(!workers.has(v.id),'Duplicate protected worker original');budget.entry();workers.set(v.id,v);
   }
   for(const r of rows.values()){
    budget.entry();if(r.id.startsWith(legacy.feedWorkerPrefix)||r.id.startsWith(adaptive.feedWorkerPrefix))continue;
    if(r.id.startsWith(legacyRows.feedReviewPrefix)){
     const raw=parse(legacyRows.reviewSchema,r.value),w=workers.get(raw.command.operationId);need(w?.format===2,'Missing exact protected legacy review worker');
     budget.entry();budget.reserveBytes(8);const inputs=[r,w];
     const reviewed=completionChild(budget,'descriptor',inputs,()=>legacyRows.validateLegacyReviewRow(r,w,hash));budget.entry();legacyReviews.set(reviewed.record.id,reviewed);
    }else if(r.id.startsWith(adaptiveRows.adaptiveReviewPrefix)){
     const raw=parse(adaptiveRows.reviewSchema,r.value),w=workers.get(raw.command.operationId);need(w?.format===3,'Missing exact protected adaptive review worker');
     budget.entry();budget.reserveBytes(8);const inputs=[r,w];
     const reviewed=completionChild(budget,'descriptor',inputs,()=>adaptiveRows.validateAdaptiveReviewRow(r,w,hash));budget.entry();adaptiveReviews.set(reviewed.record.id,reviewed);
    }else if(r.id.startsWith(adaptiveRows.adaptiveLearningPrefix)){
     const raw=parse(adaptiveRows.learningSchema,r.value),w=workers.get(raw.command.operationId);need(w?.format===3,'Missing exact protected learning worker');
     budget.entry();budget.reserveBytes(16);const inputs=[r,w,receipts.get(raw.id)??null];
     completionChild(budget,'descriptor',inputs,()=>adaptiveRows.validateAdaptiveMutationRow(r,w,receipts.get(raw.id),hash));
    }else if(r.id.startsWith(adaptiveRows.adaptiveControlPrefix)){
     const raw=parse(adaptiveRows.controlSchema,r.value);
     // A dependency's embedded checkpoint receipt validates local derivation;
     // actual receipt custody/control ancestry remains the adapter's full proof.
     const expected=receipts.get(raw.id)??raw.preferencesAfter.latestMutation;
     need(expected===undefined||receiptShape(expected),'Protected control receipt shape changed');
     budget.entry();budget.reserveBytes(8);const inputs=[r,expected];
     completionChild(budget,'descriptor',inputs,()=>adaptiveRows.validateAdaptiveMutationRow(r,undefined,expected,hash));
    }else if(r.id.startsWith(local.feedLocalPrefix)){
     const raw=parse(local.feedLocalRecordSchema,r.value);
     budget.entry();budget.reserveBytes(8);const inputs=[r,receipts.get(raw.id)??null];
     const value=completionChild(budget,'descriptor',inputs,()=>local.validateFeedLocalRow(r,receipts.get(raw.id)??local.localOriginalReceipt(raw,hash),hash));
     budget.entry();locals.set(value.id,value);
    }else throw Error('Unsupported protected semantic row kind');
   }
   for(const v of workers.values()){
    budget.entry();const review=v.format===2?(v.capture.kind==='classify'?legacyReviews.get(v.capture.review.reviewRequestId):undefined):(v.capture.basis?.kind==='accepted'?adaptiveReviews.get(v.capture.basis.approval.reviewRequestId):undefined);
    budget.entry();budget.reserveBytes(8);const inputs=[v,review??null];
    completionChild(budget,'descriptor',inputs,()=>{if(v.format===2)legacyRows.validateLegacyClassificationBasis(v,review as ReturnType<typeof legacyRows.validateLegacyReviewRow>|undefined);
     else adaptiveRows.validateAdaptiveAcceptedBasis(v,review as ReturnType<typeof adaptiveRows.validateAdaptiveReviewRow>|undefined);return true;});
   }
   for(const value of locals.values()){
    budget.entry();if(value.kind==='stop-no-effect-terminal'){
     budget.entry();budget.reserveBytes(8);const inputs=[value,workers.get(value.target.id)??null];
     completionChild(budget,'descriptor',inputs,()=>{local.validateFeedLocalStop(value,workers.get(value.target.id),hash);return true;});
    }
    if(value.kind==='close-ack'){
     const originalId=value.request.command.original.requestId,w=workers.get(originalId),l=locals.get(originalId);let original:local.OriginalRequest|undefined;
     budget.entry();budget.reserveBytes(16);const inputs=[value,w??null,l??null];
     completionChild(budget,'close',inputs,()=>{
      if(w){const expected=w.format===3?adaptiveRows.adaptiveWorkerReceipts(w,hash)[0]!:legacyRows.expectedReceipts(w,hash)[0]!;
       original={request:{kind:'start',command:w.command},deviceId:w.deviceId,at:w.createdAt,receipt:expected};
      }else if(l&&(l.kind==='closed-before-admission'||l.kind==='refused-before-admission'))original={request:l.request,deviceId:l.deviceId,at:l.at,receipt:local.localOriginalReceipt(l,hash)};
      local.validateFeedLocalClose(value,original,l,hash);return true;
     });
    }
   }
  }
  need(facts.pendingSeals.length<=1,'More than one pending completion seal');
  for(const fact of facts.workers){budget.entry();worker(fact);}
  for(const fact of facts.pendingCloses){budget.entry();pendingClose(fact);}
  for(const fact of facts.pendingSeals){budget.entry();pendingSeal(fact);}
  let knownBytes=0;for(const value of occupied.values()){budget.entry();knownBytes=add(knownBytes,value.bytes);}
  need(facts.current.entries>=occupied.size&&facts.current.ciphertextBytes>=knownBytes,'Completion current occupancy omits provided facts');
  if(blockers.length){blockers.sort((a,b)=>keyCompare(a.identity.id,b.identity.id)||keyCompare(a.identity.kind,b.identity.kind)||reasons.indexOf(a.reason)-reasons.indexOf(b.reason));
   const first=blockers[0]!;const result:CompletionResult={kind:'unsupported-completion',qualification:'unqualified',originalToken:facts.originalToken,reason:first.reason,identity:first.identity};
   parse(completionResultSchema,result);return budget.copy(result);
  }
  obligations.sort((a,b)=>keyCompare(a.identity.id,b.identity.id)||keyCompare(a.kind,b.kind));
  let remainingGrowth=amount(0,0),maximumSingleTransitionOverlap=amount(0,0);
  for(const item of obligations){budget.entry();remainingGrowth=amount(add(remainingGrowth.entries,item.growth.entries),add(remainingGrowth.ciphertextBytes,item.growth.ciphertextBytes));maximumSingleTransitionOverlap=maximum(maximumSingleTransitionOverlap,item.overlap);}
  const result:CompletionResult={kind:'sized',qualification:'unqualified',originalToken:facts.originalToken,occupancyScope:'history-objects+semantic-service-records+all-receipts',
   current:facts.current,obligations,remainingGrowth,maximumSingleTransitionOverlap,liveness:'not-qualified'};
  parse(completionResultSchema,result);return budget.copy(result);
 });
}
