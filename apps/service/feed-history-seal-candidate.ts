import {createHash} from 'node:crypto';
import {canonical} from '../../packages/domain/contracts.js';
import {projectSelectedHistoryRows,encodeHistorySegment} from '../../packages/domain/news-feed-history-segment.js';
import {compareHistoryKeys} from '../../packages/domain/news-feed-history-keys.js';
import {sealObject,type HistoryStoredObject,type HistoryStoreLimits} from '../../packages/domain/news-feed-history-storage.js';
import type {HistorySealIntent} from '../../packages/domain/news-feed-history-seal.js';
import type {HistoryInventoryAccess} from './feed-history-inventory.js';
import {historyJsonBytes} from './feed-history-bounds.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
/** Bounded correspondence derivation only. Call after complete actual graph
 * verification in one lexical snapshot; it does not grant mutation authority. */
export function deriveSealCandidate(a:HistoryInventoryAccess,ids:string[],segmentId:string,operationId:string){
  const rows=ids.map(id=>{const row=a.activeRow(id),descriptor=a.object('row',id);need(row&&descriptor?.kind==='row'&&descriptor.value.custody.kind==='active','Selected original is not active');return row;});
  const receiptIds=new Set<string>();for(const id of ids){const d=a.object('row',id);need(d?.kind==='row','Selected descriptor missing');
   for(const request of d.value.requests){const r=a.object('request',request);need(r?.kind==='request','Selected request missing');if(r.value.status==='admitted')receiptIds.add(request);}
   for(const edge of d.value.edges)if(edge.kind==='receipt')receiptIds.add(edge.requestId);}
  const receipts=[...receiptIds].sort(compareHistoryKeys).map(id=>{const r=a.receipt(id);need(r,'Selected actual receipt missing');return r;});
  const projection=projectSelectedHistoryRows({rows,receipts}),wire=encodeHistorySegment(projection,{receipts});
  const descriptors=ids.map((id,ordinal)=>{const item=a.object('row',id);need(item?.kind==='row','Selected row catalogue missing');return {...item.value,custody:{kind:'segment' as const,segmentId,ordinal}};});
  const requestKeys=new Set(descriptors.flatMap(r=>r.requests));const requests=[...requestKeys].sort(compareHistoryKeys).map(id=>{const item=a.object('request',id);need(item?.kind==='request','Selected original catalogue missing');return item.value;});
  const operation={format:1 as const,id:operationId,segmentId,wireSha256:hash(wire),rows:descriptors,requests,catalogueSha256:hash(canonical({rows:descriptors,requests})),intentSha256:'0'.repeat(64)};
  const segment={format:1 as const,id:segmentId,operationId,wire,wireSha256:hash(wire),receiptIds:projection.receipts.map(r=>r.requestId).sort(compareHistoryKeys)};
  return {rows,operation,segment,descriptors};
 }
export function deriveSealReservation(a:HistoryInventoryAccess,intent:HistorySealIntent,candidate:ReturnType<typeof deriveSealCandidate>,limits:HistoryStoreLimits){
  const outcome={format:1,id:intent.id,intentSha256:'0'.repeat(64),state:'completed',at:intent.deadlineAt,segmentId:intent.segmentId,wireSha256:intent.wireSha256,catalogueSha256:intent.catalogueSha256};
  const additional=[sealObject('intent',intent),sealObject('segment',candidate.segment),sealObject('operation',candidate.operation),sealObject('outcome',outcome),
   ...candidate.descriptors.map(d=>{const old=a.object('row',d.id)!;return {...old,revision:old.revision+1,value:d} as HistoryStoredObject;})];
  let input=0,encrypted=0;for(const object of additional){input+=historyJsonBytes(object,limits.objectBytes);encrypted+=Buffer.byteLength(JSON.stringify(object))+28;}
  return {addedObjects:4,encodedBytes:input,encryptedBytes:encrypted};
 }
