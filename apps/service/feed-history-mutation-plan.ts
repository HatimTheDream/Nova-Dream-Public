import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonical} from '../../packages/domain/contracts.js';
import {describeHistoryRow,historyOwnerKey,historyParentKey,historyStopKey,historySpanId,historyRevisionKey} from '../../packages/domain/news-feed-history-graph.js';
import {compareHistoryKeys} from '../../packages/domain/news-feed-history-keys.js';
import {historyStoreLimitsSchema,type HistoryStoreLimits,type HistoryStoredObject,type HistoryObjectKind} from '../../packages/domain/news-feed-history-storage.js';
import {readSavedControlStep} from '../../packages/domain/news-feed-adaptive-controls.js';
import {adaptiveLearningPrefix,adaptiveControlPrefix} from '../../packages/domain/news-feed-adaptive-graph.js';
import type {SemanticReceipt,SemanticRow} from '../../packages/domain/news-feed-semantic-journal.js';
import type {WorkerIdentity} from '../../packages/domain/worker.js';
import {verifyHistoryInventory,verifyHistoryObject,type HistoryInventoryAccess} from './feed-history-inventory.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import {assertFeedStoreTransition} from './feed-store-protection.js';
import {MutationPlanBudget,withHistoryProjectedInventory,mutationNeed as need,type MutationPlanLimits,type HistoryObjectChange,type HistoryRowChange} from './feed-history-projected-inventory.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const receipt=z.object({requestId:z.string(),deviceId:z.string(),digest:z.string().regex(/^[0-9a-f]{64}$/),value:z.unknown()}).strict();
const inputSchema=z.object({phase:z.discriminatedUnion('kind',[z.object({kind:z.literal('actual')}).strict(),z.object({kind:z.literal('private-admission'),pending:receipt}).strict()]),
 next:z.object({id:z.string(),revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),value:z.unknown()}).strict(),pending:receipt.optional()}).strict();
export type HistoryMutationInput={phase:{kind:'actual'}|{kind:'private-admission';pending:SemanticReceipt};next:SemanticRow;pending?:SemanticReceipt};
export type ReadonlyMutationPlan=Readonly<{
 format:1;qualification:'unqualified';phase:'actual'|'private-admission';row:HistoryRowChange;objects:readonly HistoryObjectChange[];
 pending?:SemanticReceipt;accounting:Readonly<{newActiveRows:number;newCatalogueObjects:number;replacementCatalogueObjects:number;pendingReceipts:number;
  outgoingWrapperBytes:number;outgoingPayloadBytes:number;outgoingCiphertextBytes:number;originalRowJsonSha256:string;logicalOnly:true}>;
 beforeProof:ReturnType<typeof verifyHistoryInventory>;projectedProof:ReturnType<typeof verifyHistoryInventory>;
}>;
type NativeIdentity=(worker:WorkerIdentity)=>{runId:string;sessionKey:string};

/** Pure exact logical delta. No Store connection, ciphertext predicate, runtime
 * qualification, write capability or cross-invocation proof ticket escapes. */
export function withHistoryMutationPlan<T>(source:HistoryInventoryAccess,rawStoreLimits:HistoryStoreLimits,rawPlannerLimits:MutationPlanLimits,
 native:NativeIdentity,raw:HistoryMutationInput,consume:(plan:ReadonlyMutationPlan,projected:HistoryInventoryAccess)=>T):T{
 const budget=new MutationPlanBudget(rawPlannerLimits);
 const storeLimits=budget.copy(rawStoreLimits);historyStoreLimitsSchema.parse(storeLimits);
 // Validate plain own JSON data before any caller property is read.
 historyJsonBytes(raw,budget.limits.bytes);
 // Bound supplied outgoing wrappers before allocating their preserved copies.
 historyJsonBytes(raw.next,storeLimits.objectBytes);
 if(raw.pending)historyJsonBytes(raw.pending,storeLimits.objectBytes);
 if(raw.phase.kind==='private-admission')historyJsonBytes(raw.phase.pending,storeLimits.objectBytes);
 const input=budget.copy(raw);inputSchema.parse(input);
 function verifyLogicalInventory(access:HistoryInventoryAccess){
  // Mirror the SQL reader's complete logical inventory boundary. The ordinary
  // graph verifier's persisted count covers catalogue objects only. This adds
  // active wrappers and every actual/private receipt without retaining them.
  // Serialized wrapper bytes are not actual ciphertext or physical heap size.
  let count=0,inputBytes=0;
  function scan(values:Iterable<unknown>){for(const value of values){count++;inputBytes+=historyJsonBytes(value,storeLimits.objectBytes);
   need(Number.isSafeInteger(count)&&Number.isSafeInteger(inputBytes)&&count<=storeLimits.objects&&inputBytes<=storeLimits.inputBytes,'Mutation aggregate logical inventory bound');}}
  scan(access.objects());scan(access.activeRows());scan(access.receipts());
  return verifyHistoryInventory(access,storeLimits,native);
 }
 if(input.phase.kind==='private-admission')need(input.pending&&same(input.pending,input.phase.pending),'Private original pending receipt changed');
 return withHistoryProjectedInventory(source,{objects:[],...(input.phase.kind==='private-admission'?{pending:input.phase.pending}:{})},budget,before=>{
  const beforeProof=verifyLogicalInventory(before),next=input.next;
  const priorIndex=before.object('row',next.id),prior=before.activeRow(next.id);
  if(priorIndex){need(priorIndex.kind==='row'&&priorIndex.value.custody.kind==='active','Archived Feed original cannot be overwritten or recreated');need(prior,'Active predecessor is missing');}
  else need(!prior,'Active original is absent from the complete catalogue');
  assertFeedStoreTransition(prior,next);
  const value=next.value as any;
  const mutationKind=next.id.startsWith(adaptiveLearningPrefix)||next.id.startsWith(adaptiveControlPrefix);
  let ancestry:{parentId:string|null;rootId:string;depth:number}|undefined;
  let head:HistoryStoredObject|undefined;
  if(mutationKind){const parentId=value.before?.learningHead;need(parentId===null||typeof parentId==='string','Mutation parent is not exact');
   const owner=value.deviceId,epoch=value.command?.epoch,key=historyOwnerKey(owner,epoch,hash);head=before.object('head',key);
   if(parentId===null){need(!head,'Mutation root already has a current head');ancestry={parentId:null,rootId:value.id,depth:1};}
   else{const request=before.object('request',parentId);need(request?.kind==='request'&&request.value.status==='admitted'&&['apply-learning','control'].includes(request.value.kind),'Mutation parent original is missing');
    const parent=before.object('row',request.value.rowId);need(parent?.kind==='row'&&parent.value.mutation&&['learning','control'].includes(parent.value.kind)&&parent.value.owner===owner&&parent.value.epoch===epoch,'Mutation parent identity changed');
    need(head?.kind==='head'&&head.value.rowId===parent.key&&head.value.owner===owner&&head.value.epoch===epoch,'Mutation parent is not the current head');
    const depth=parent.value.mutation.depth+1;need(Number.isSafeInteger(depth)&&depth<=storeLimits.graph.logicalRows,'Mutation depth bound');ancestry={parentId,rootId:parent.value.mutation.rootId,depth};}
  }
  const description=describeHistoryRow(next,{kind:'active'},hash,ancestry);
  if(input.pending)need(description.expected.some(expected=>same(expected,input.pending)),'Private pending receipt is not this row original');
  need((description.row.kind==='learning'||description.row.kind==='control')===!!ancestry,'Mutation namespace differs from descriptor');
  budget.entry();const changes:HistoryObjectChange[]=[];
  function put(kind:HistoryObjectKind,body:any,replace=false){
   budget.bytes(body);const key=kind==='request'?body.requestId:['row','span'].includes(kind)?body.id:body.key;
   const previous=before.object(kind,key);
   if(previous&&same(previous.value,body))return previous;
   need(!previous||replace,'Existing history catalogue cannot be replaced');
   const revision=previous?previous.revision+1:1;need(Number.isSafeInteger(revision),'Catalogue revision exhausted');
   const after=budget.copy({format:1,kind,key,rangeKey:kind==='stop'?body.targetId:null,revision,value:body}) as HistoryStoredObject;
   verifyHistoryObject(after,storeLimits,source.schema as 61|62);
   need(!changes.some(x=>x.after.kind===kind&&x.after.key===key),'Duplicate derived catalogue delta');
   budget.entry();changes.push(budget.copy({...(previous?{before:previous}:{}),after}));return after;
  }
  put('row',description.row,true);
  for(const candidate of description.requests){const old=before.object('request',candidate.requestId);
   const ack=old?.kind==='request'&&old.value.status==='pending-close'&&candidate.status==='admitted'&&value.kind==='close-ack'&&candidate.kind==='close'&&
    old.value.owner===candidate.owner&&old.value.epoch===candidate.epoch&&old.value.requestSha256===candidate.requestSha256;
   put('request',candidate,ack);
  }
  if(ancestry){const owner=description.row.owner,epoch=description.row.epoch;
   put('child',{key:historyParentKey(owner,epoch,ancestry.parentId,hash),rowId:next.id,parentId:ancestry.parentId,owner,epoch});
   put('head',{key:historyOwnerKey(owner,epoch,hash),rowId:next.id,owner,epoch},!!head);
  }
  if(value.kind==='stop-no-effect-terminal')put('stop',{key:historyStopKey(value.target.id,next.id,hash),rowId:next.id,targetId:value.target.id});
  const captured=value.before??(value.capture?.kind==='interpret'?undefined:value.capture?.source);
  if(captured?.controlProof){const proof=captured.controlProof,owner=description.row.owner,epoch=description.row.epoch,id=historySpanId(owner,epoch,proof,hash);
   const oldSpan=before.object('span',id);
   if(oldSpan)need(oldSpan.kind==='span'&&oldSpan.value.owner===owner&&oldSpan.value.epoch===epoch&&same(oldSpan.value.proof,proof),'Existing control span changed');
   else put('span',{id,firstOwnerRowId:next.id,owner,epoch,proof});
   budget.entry();const needed=new Map<number,{requestId:string;receiptSha256:string}>();
   for(const actual of before.receipts()){const step=readSavedControlStep(actual,epoch,proof.fromRevision,proof.toRevision,hash);if(!step)continue;
    need(!needed.has(step.revision),'Control interval has duplicate saved revisions');budget.entry();needed.set(step.revision,budget.copy({requestId:actual.requestId,receiptSha256:hash(canonical(actual))}));}
   const count=proof.toRevision-proof.fromRevision;need(Number.isSafeInteger(count)&&count>=0&&count<=storeLimits.graph.controlSteps,'Control interval work bound');
   for(let revision=proof.fromRevision+1;revision<=proof.toRevision;revision++){
    const original=needed.get(revision);need(original,'Control interval has a missing saved revision');
    const key=historyRevisionKey(epoch,revision,hash),old=before.object('revision',key);
    if(old)need(old.kind==='revision'&&old.value.epoch===epoch&&old.value.revision===revision&&old.value.requestId===original.requestId&&old.value.receiptSha256===original.receiptSha256,'Existing control revision changed');
    else put('revision',{key,epoch,revision,requestId:original.requestId,receiptSha256:original.receiptSha256,coveringSpan:id});
   }
  }
  changes.sort((a,b)=>compareHistoryKeys(a.after.kind,b.after.kind)||compareHistoryKeys(a.after.key,b.after.key));
  const row=budget.copy({...(prior?{before:prior}:{}),after:next});
  const pending=input.pending;
  return withHistoryProjectedInventory(source,{row,objects:changes,...(pending?{pending}:{})},budget,projected=>{
   const projectedProof=verifyLogicalInventory(projected);
   let outgoingWrapperBytes=historyJsonBytes(next,storeLimits.objectBytes),outgoingPayloadBytes=historyJsonBytes(next.value,storeLimits.objectBytes),count=1;
   const add=(a:number,b:number)=>{const sum=a+b;need(Number.isSafeInteger(sum),'Mutation outgoing byte count overflow');return sum;};
   for(const item of changes){const size=historyJsonBytes(item.after,storeLimits.objectBytes);outgoingWrapperBytes=add(outgoingWrapperBytes,size);outgoingPayloadBytes=add(outgoingPayloadBytes,size);count++;}
   if(pending){outgoingWrapperBytes=add(outgoingWrapperBytes,historyJsonBytes(pending,storeLimits.objectBytes));outgoingPayloadBytes=add(outgoingPayloadBytes,historyJsonBytes(pending.value,storeLimits.objectBytes));count++;}
   const accounting={newActiveRows:prior?0:1,newCatalogueObjects:changes.filter(x=>!x.before).length,replacementCatalogueObjects:changes.filter(x=>!!x.before).length,
    pendingReceipts:pending?1:0,outgoingWrapperBytes,outgoingPayloadBytes,outgoingCiphertextBytes:add(outgoingPayloadBytes,count*28),originalRowJsonSha256:hash(JSON.stringify(next)),logicalOnly:true as const};
   need(outgoingWrapperBytes<=storeLimits.inputBytes&&accounting.outgoingCiphertextBytes<=storeLimits.encryptedBytes,'Mutation outgoing logical bound');
   const plan=budget.copy({format:1 as const,qualification:'unqualified' as const,phase:input.phase.kind,row,objects:changes,...(pending?{pending}:{}),accounting,beforeProof,projectedProof});
   return consume(plan,projected);
  });
 });
}
