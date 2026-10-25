import {createHash} from 'node:crypto';
import {canonical} from '../../packages/domain/contracts.js';
import {compareHistoryKeys} from '../../packages/domain/news-feed-history-keys.js';
import {decodeHistorySegment} from '../../packages/domain/news-feed-history-segment.js';
import type {HistorySealIntent} from '../../packages/domain/news-feed-history-seal.js';
import type {HistoryInventoryAccess} from './feed-history-inventory.js';
import type {HistoryStoreLimits,HistoryStoredObject} from '../../packages/domain/news-feed-history-storage.js';
import type {SemanticRow} from '../../packages/domain/news-feed-semantic-journal.js';
import {deriveSealCandidate,deriveSealReservation} from './feed-history-seal-candidate.js';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
export const rowCommitment=(row:SemanticRow)=>({id:row.id,revision:row.revision,rowSha256:hash(canonical(row)),jsonSha256:hash(JSON.stringify(row))});
/** Complete inventory verification is a caller prerequisite. These lookups are
 * data projection only and cannot issue authorization or a reusable proof. */
export function historyLogicalRow(access:HistoryInventoryAccess,id:string):SemanticRow{
 const entry=access.object('row',id);need(entry?.kind==='row','Logical row catalogue missing');const descriptor=entry.value;
 let row:SemanticRow|undefined;
 if(descriptor.custody.kind==='active')row=access.activeRow(id);
 else{const segment=access.object('segment',descriptor.custody.segmentId);need(segment?.kind==='segment','Logical segment missing');
  const receipts=segment.value.receiptIds.map(id=>{const r=access.receipt(id);need(r,'Logical receipt missing');return r;});
  row=decodeHistorySegment(segment.value.wire,{receipts}).rows[descriptor.custody.ordinal];}
 need(row&&row.id===id&&row.revision===descriptor.revision&&hash(canonical(row))===descriptor.rowSha256,'Logical row custody mismatch');return row;
}
export function sealProtection(access:HistoryInventoryAccess,selected:string[],limits:HistoryStoreLimits):HistorySealIntent['protection']{
 const pending=[...selected],rows=new Map<string,ReturnType<typeof rowCommitment>>(),receipts=new Map<string,{id:string;sha256:string}>(),objects=new Map<string,{kind:'span'|'revision';key:string;sha256:string}>();
 const receipt=(id:string)=>{if(receipts.has(id))return;need(receipts.size<limits.objects,'Seal receipt closure bound');const value=access.receipt(id);need(value,'Seal protected receipt missing');receipts.set(id,{id,sha256:hash(canonical(value))});};
 while(pending.length){const id=pending.pop()!;if(rows.has(id))continue;need(rows.size<limits.graph.logicalRows,'Seal dependency closure bound');
  const row=historyLogicalRow(access,id),raw=access.object('row',id);need(raw?.kind==='row','Seal row descriptor missing');rows.set(id,rowCommitment(row));
  for(const request of raw.value.requests){const item=access.object('request',request);need(item?.kind==='request','Seal request descriptor missing');if(item.value.status==='admitted')receipt(request);}
  for(const edge of raw.value.edges){
   if(edge.kind==='row')pending.push(edge.rowId);
   else if(edge.kind==='original'){const item=access.object('request',edge.requestId);need(item?.kind==='request','Seal dependency original missing');pending.push(item.value.rowId);}
   else if(edge.kind==='receipt')receipt(edge.requestId);
   else{const span=access.object('span',edge.spanId);need(span?.kind==='span','Seal control span missing');objects.set('span:'+span.key,{kind:'span',key:span.key,sha256:hash(canonical(span))});
    for(const rev of access.objects('revision'))if(rev.kind==='revision'&&rev.value.epoch===span.value.epoch&&rev.value.revision>span.value.proof.fromRevision&&rev.value.revision<=span.value.proof.toRevision){
     need(objects.size<limits.objects,'Seal interval descriptor bound');objects.set('revision:'+rev.key,{kind:'revision',key:rev.key,sha256:hash(canonical(rev))});receipt(rev.value.requestId);}
   }
  }
 }
 return {rows:[...rows.values()].sort((a,b)=>compareHistoryKeys(a.id,b.id)),receipts:[...receipts.values()].sort((a,b)=>compareHistoryKeys(a.id,b.id)),
  objects:[...objects.values()].sort((a,b)=>compareHistoryKeys(a.kind,b.kind)||compareHistoryKeys(a.key,b.key))};
}
/** Every intent/outcome is independently enumerated. All completed originals
 * keep four-way custody; pending source/dependency closure is exact and durable. */
export function verifySealRecords(access:HistoryInventoryAccess,limits:HistoryStoreLimits){
 let pending=0,intents=0,outcomes=0;
 for(const object of access.objects('intent')){
  need(object.kind==='intent','Wrong seal intent inventory');intents++;const intent=object.value;
  need(intent.deadlineAt>intent.createdAt,'Seal original deadline invalid');
  const ids=intent.rows.map(r=>r.id);need(new Set(ids).size===ids.length,'Seal selected identities duplicated');
  for(const row of intent.rows){
   need(row.descriptor.id===row.id&&row.descriptor.revision===row.revision&&row.descriptor.rowSha256===row.rowSha256&&row.descriptor.custody.kind==='active','Seal original active descriptor changed');}
  const outcome=access.object('outcome',intent.id),operation=access.object('operation',intent.id),segment=access.object('segment',intent.segmentId);
  if(outcome){need(outcome.kind==='outcome'&&outcome.value.intentSha256===hash(canonical(intent))&&outcome.value.at>=intent.createdAt,'Seal outcome differs from original');outcomes++;
   if(outcome.value.state==='completed'){
    need(outcome.value.at<=intent.deadlineAt,'Completed seal exceeds its original deadline');
    need(segment?.kind==='segment'&&operation?.kind==='operation','Completed seal actual custody missing');
    need('intentSha256'in operation.value&&operation.value.intentSha256===hash(canonical(intent)),'Completed seal operation intent differs');
    need(outcome.value.segmentId===intent.segmentId&&outcome.value.wireSha256===intent.wireSha256&&outcome.value.catalogueSha256===intent.catalogueSha256,'Completed seal outcome target differs');
    need(segment.value.operationId===intent.id&&segment.value.wireSha256===intent.wireSha256&&operation.value.segmentId===intent.segmentId&&operation.value.catalogueSha256===intent.catalogueSha256,'Seal four-way custody differs');
    need(operation.value.rows.length===intent.rows.length,'Completed seal selected set differs');
    for(let i=0;i<intent.rows.length;i++){const selected=intent.rows[i]!,row=historyLogicalRow(access,selected.id),expected={...selected.descriptor,custody:{kind:'segment',segmentId:intent.segmentId,ordinal:i}};
     need(same(rowCommitment(row),{id:selected.id,revision:selected.revision,rowSha256:selected.rowSha256,jsonSha256:selected.jsonSha256})&&same(operation.value.rows[i],expected),'Completed exact selected row changed');
     need(!access.activeRow(selected.id),'Completed seal keeps duplicate active source');}
   }else {need(!segment&&!operation,'Not-performed seal has committed custody');
    need(outcome.value.reason===(outcome.value.at>intent.deadlineAt?'expired':'explicit-close'),'Not-performed seal reason contradicts its original deadline');}
  }else{
   need(++pending<=1&&!operation&&!segment,'Pending seal is duplicated or partially committed');
   for(const selected of intent.rows){const row=access.activeRow(selected.id);need(row&&same(rowCommitment(row),{id:selected.id,revision:selected.revision,rowSha256:selected.rowSha256,jsonSha256:selected.jsonSha256})&&same(access.object('row',selected.id)?.value,selected.descriptor),'Pending exact active source changed');}
   need(same(sealProtection(access,ids,limits),intent.protection),'Pending complete dependency/receipt closure changed');
   const candidate=deriveSealCandidate(access,ids,intent.segmentId,intent.id);
   need(candidate.segment.wireSha256===intent.wireSha256&&candidate.operation.catalogueSha256===intent.catalogueSha256,'Pending deterministic target correspondence changed');
   need(same(deriveSealReservation(access,intent,candidate,limits),intent.reservation),'Pending exact reservation changed');
  }
 }
 let observed=0;for(const raw of access.objects('outcome')){need(raw.kind==='outcome'&&access.object('intent',raw.key)?.kind==='intent','Orphan seal outcome');observed++;}
 need(observed===outcomes,'Seal outcome inventory mismatch');
 for(const op of access.objects('operation'))if(op.kind==='operation'&&'intentSha256'in op.value)need(access.object('intent',op.key)?.kind==='intent','Orphan new sealing operation');
 return {intents,outcomes,pending};
}
export {sealObject} from '../../packages/domain/news-feed-history-storage.js';
