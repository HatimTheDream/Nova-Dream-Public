import {z} from 'zod';
import {canonical} from '../../packages/domain/contracts.js';
import {assertHistoryUtf8Key} from '../../packages/domain/news-feed-history-keys.js';
import type {HistoryStoreLimits} from '../../packages/domain/news-feed-history-storage.js';
import type {WorkerIdentity} from '../../packages/domain/worker.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import type {HistoryInventoryAccess} from './feed-history-inventory.js';
import type {HistoryReceiptClosureLimits} from './feed-history-receipt-protection.js';
import {planHistoryReceiptRedaction,type HistoryRedactionPlanLimits,type HistoryReceiptRedaction} from './feed-history-redaction-plan.js';

const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const limitsSchema=z.object({qualification:z.literal('unqualified'),contextBytes:positive,contextEntries:positive,
 outputBytes:positive,outputEntries:positive,
 closure:z.object({qualification:z.literal('unqualified'),entries:positive,bytes:positive,queries:positive}).strict(),
 plan:z.object({qualification:z.literal('unqualified'),visited:positive,candidates:positive,receiptBytes:positive,bytes:positive,entries:positive}).strict(),
}).strict();
export type HistoryRemovalCompositionLimits=z.infer<typeof limitsSchema>;
export type HistoryRemovalSelection=Readonly<{draftIds:readonly string[];dictationIds:readonly string[];
 ownedReceiptIds:readonly string[];conversationId?:string}>;
type Native=(worker:WorkerIdentity)=>{runId:string;sessionKey:string};
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}

/** Logical candidates only. Selection data must come from separately authorized
 * Store inventory. No SQL, eligibility, native removal or reusable proof is
 * supplied here. Two child scans share one snapshot and disjoint whole bounds. */
export function planHistoryRemovalReceipts(access:HistoryInventoryAccess,storeLimits:HistoryStoreLimits,native:Native,
 rawLimits:HistoryRemovalCompositionLimits,selection:HistoryRemovalSelection):readonly HistoryReceiptRedaction[]{
 historyJsonBytes(rawLimits,4096);
 const limits=limitsSchema.parse(rawLimits);
 need(canonical(limits)===canonical(rawLimits),'Exact removal composition limits required');
 const token=access.token();let failed=false;
 const guard=()=>{if(failed)throw Error('Removal composition previously failed');if(access.token()!==token){failed=true;throw Error('Removal composition snapshot changed');}};
 try{
  guard();const inputSize=historyJsonBytes(selection,limits.contextBytes);
  need(selection!==null&&typeof selection==='object'&&!Array.isArray(selection),'Exact removal selection required');
  let contextEntries=0,contextBytes=inputSize,outputEntries=0,outputBytes=0;
  const entry=(count:number)=>{need(Number.isSafeInteger(contextEntries+count)&&contextEntries+count<=limits.contextEntries,'Removal context entry bound');contextEntries+=count;};
  const contextCharge=(size:number)=>{need(Number.isSafeInteger(contextBytes+size)&&contextBytes+size<=limits.contextBytes,'Removal context copy byte bound');contextBytes+=size;};
  const outEntry=(count:number)=>{need(Number.isSafeInteger(outputEntries+count)&&outputEntries+count<=limits.outputEntries,'Removal output entry bound');outputEntries+=count;};
  const outCharge=(value:unknown)=>{const size=historyJsonBytes(value,limits.outputBytes-outputBytes);outputBytes+=size;};
  entry(1);
  for(const key in selection)if(Object.hasOwn(selection,key))need(['draftIds','dictationIds','ownedReceiptIds','conversationId'].includes(key),'Exact removal selection fields required');
  const own=(key:string,required=true):unknown=>{
   const descriptor=Object.getOwnPropertyDescriptor(selection,key);
   if(!descriptor){need(!required,'Required removal selection field');return undefined;}
   need(descriptor.enumerable&&'value'in descriptor,'Removal selection accessor unsupported');return descriptor.value;
  };
  const keys=(value:unknown):ReadonlySet<string>=>{
   need(Array.isArray(value),'Removal selection IDs must be arrays');entry(2);const result=new Set<string>();
   for(const id of value){
    need(typeof id==='string'&&id.length<=8192&&Buffer.byteLength(id,'utf8')<=8192,'Exact removal ID bound');assertHistoryUtf8Key(id);
    entry(1);contextCharge(historyJsonBytes(id,limits.contextBytes-contextBytes));
    need(!result.has(id),'Duplicate removal selection ID');result.add(id);
   }return result;
  };
  const drafts=keys(own('draftIds')),dictation=keys(own('dictationIds')),owned=keys(own('ownedReceiptIds'));
  const conversation=own('conversationId',false);
  if(conversation!==undefined){need(typeof conversation==='string'&&conversation.length<=8192&&Buffer.byteLength(conversation,'utf8')<=8192,'Exact removal conversation ID bound');assertHistoryUtf8Key(conversation);}
  else need(owned.size===0,'Conversation receipt IDs require their conversation');
  const hasDraft=drafts.size>0||dictation.size>0;
  need(hasDraft||conversation!==undefined,'Removal selection is empty');
  const scans=hasDraft&&conversation!==undefined?2:1;
  const share=(value:number)=>{const part=Math.floor(value/scans);need(part>0,'Removal shared allowance is too small');return part;};
  // Reserve both complete declared allowances before starting either scan.
  entry(3);
  const closure:HistoryReceiptClosureLimits={qualification:'unqualified',entries:share(limits.closure.entries),bytes:share(limits.closure.bytes),queries:share(limits.closure.queries)};
  const plan:HistoryRedactionPlanLimits={qualification:'unqualified',visited:share(limits.plan.visited),candidates:share(limits.plan.candidates),
   receiptBytes:limits.plan.receiptBytes,bytes:share(limits.plan.bytes),entries:share(limits.plan.entries)};
  const draftMatches=(value:any)=>!!(drafts.has(value?.id)&&value.value!==undefined||value?.id&&dictation.has(value.id));
  const conversationMatches=(value:any)=>!!(value?.id===conversation&&value.nativeKey||value?.conversationId===conversation&&(owned.has(value.id)||owned.has(value.requestId))||value?.target?.conversation?.id===conversation);
  guard();
  const draftPlan=hasDraft?planHistoryReceiptRedaction(access,storeLimits,native,closure,plan,'draft',draftMatches):undefined;
  guard();
  const conversationPlan=conversation!==undefined?planHistoryReceiptRedaction(access,storeLimits,native,closure,plan,'conversation',value=>!draftMatches(value)&&conversationMatches(value)):undefined;
  guard();outEntry(2);
  // Reserve the result array punctuation even when both plans are empty.
  need(limits.outputBytes>=2,'Removal output byte bound');outputBytes=2;
  const result:HistoryReceiptRedaction[]=[],seen=new Set<string>();
  const append=(values:readonly HistoryReceiptRedaction[]|undefined)=>{
   if(!values)return;outEntry(1);
   for(const value of values){guard();need(!seen.has(value.requestId),'Duplicate removal receipt candidate');
    outEntry(2);if(result.length){need(outputBytes<limits.outputBytes,'Removal output byte bound');outputBytes++;}
    outCharge(value);outCharge(value.requestId);seen.add(value.requestId);result.push(value);
   }
  };
  append(draftPlan);append(conversationPlan);guard();return Object.freeze(result);
 }catch(error){failed=true;throw error;}
}
