import {createHash} from 'node:crypto';
import {canonical} from '../../packages/domain/contracts.js';
import {verifyFeedHistorySnapshot,type FeedHistorySnapshot,type HistorySegmentSource} from '../../packages/domain/news-feed-history-graph.js';
import {decodeHistorySegment} from '../../packages/domain/news-feed-history-segment.js';
import {historyStoredObjectSchema,historyStoredObject62Schema,historyStoreLimitsSchema,type HistoryStoredObject,type HistoryObjectKind,type HistoryStoreLimits} from '../../packages/domain/news-feed-history-storage.js';
import {verifySealRecords} from './feed-history-seal-records.js';
import {assertHistoryUtf8Key,compareHistoryKeys} from '../../packages/domain/news-feed-history-keys.js';
import type {SemanticRow,SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';
import type {WorkerIdentity} from '../../packages/domain/worker.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import type {SelectedOriginalCollector} from '../../packages/domain/news-feed-selected-originals.js';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function need(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
const bytes=(value:unknown,limit:number)=>historyJsonBytes(value,limit);
/** Private Store/backup source contract, not serializable authority. The Store
 * binds its concrete SQL inventory/decryption closures under one snapshot. */
export type HistoryInventoryAccess={
 schema:number;token():string;
 objects(kind?:HistoryObjectKind):Iterable<HistoryStoredObject>;
 object(kind:HistoryObjectKind,key:string):HistoryStoredObject|undefined;
 stops(targetId:string):Iterable<HistoryStoredObject>;
 activeRows():Iterable<SemanticRow>;activeRow(id:string):SemanticRow|undefined;
 receipts():Iterable<SemanticReceipt>;receipt(id:string):SemanticReceipt|undefined;
};
const valueKey=(object:HistoryStoredObject):string=>object.kind==='row'?object.value.id:object.kind==='request'?object.value.requestId:
 ['segment','span','operation','intent','outcome'].includes(object.kind)?(object.value as {id:string}).id:(object.value as {key:string}).key;
export function verifyHistoryObject(input:unknown,limits:HistoryStoreLimits,schema:61|62=61):HistoryStoredObject{
 need(bytes(input,limits.objectBytes)<=limits.objectBytes,'History object input bound');
 const object=(schema===62?historyStoredObject62Schema:historyStoredObjectSchema).parse(input);need(equal(object,input),'History object changed during strict parsing');
 assertHistoryUtf8Key(object.key);if(object.rangeKey!==null)assertHistoryUtf8Key(object.rangeKey);
 need(object.key===valueKey(object),'History object key differs from decrypted descriptor');
 need(object.rangeKey===(object.kind==='stop'?object.value.targetId:null),'History range key differs from descriptor');
 if(['segment','operation','intent','outcome'].includes(object.kind))need(object.revision===1,'Immutable history object revision changed');
 return object;
}
/** Complete persisted correspondence plus the complete pure graph. No write,
 * cache, authorization or production capacity acceptance follows. */
export function verifyHistoryInventory(access:HistoryInventoryAccess,rawLimits:HistoryStoreLimits,native:(value:WorkerIdentity)=>{runId:string;sessionKey:string},selected?:SelectedOriginalCollector){
 const limits=historyStoreLimitsSchema.parse(rawLimits);need(equal(limits,rawLimits),'History input limits changed');
 need(access.schema===61||access.schema===62,'Persisted Feed history requires exact supported schema');
 const initial=access.token();let alive=true,objectCount=0,inputBytes=0,segments=0,operations=0;
 const active=()=>need(alive&&access.token()===initial,'History read snapshot is no longer current');
 function get(kind:HistoryObjectKind,key:string){active();assertHistoryUtf8Key(key);const input=access.object(kind,key);if(!input)return;
  const object=verifyHistoryObject(input,limits,access.schema as 61|62);need(object.kind===kind&&object.key===key,'History exact object lookup changed');return object;}
 function* inventory(kind:HistoryObjectKind){active();let previous:string|undefined;
  for(const input of access.objects(kind)){const object=verifyHistoryObject(input,limits,access.schema as 61|62);need(object.kind===kind,'History partition contains another kind');
   need(previous===undefined||compareHistoryKeys(previous,object.key)<0,'History partition order/duplicate');previous=object.key;
   need(equal(get(kind,object.key),object),'History inventory differs from exact lookup');yield object;}}
 function receipt(id:string){active();assertHistoryUtf8Key(id);const value=access.receipt(id);if(value)need(value.requestId===id,'Actual receipt lookup key changed');return value;}
 function segment(key:string):HistorySegmentSource|undefined{
  const object=get('segment',key);if(!object||object.kind!=='segment')return;
  const entry=object.value;need(hash(entry.wire)===entry.wireSha256,'Stored segment wire commitment changed');
  let previous:string|undefined;
  const receipts=entry.receiptIds.map(id=>{assertHistoryUtf8Key(id);need(previous===undefined||compareHistoryKeys(previous,id)<0,'Segment receipt IDs must be exact unique sorted keys');previous=id;
   const found=receipt(id);need(found,'Actual segment receipt missing');return found;});
  const decoded=decodeHistorySegment(entry.wire,{receipts});need((JSON.parse(entry.wire) as {format?:number}).format===2,'New persisted history requires exact-row format2');
  const expected=decoded.receipts.map(r=>r.requestId).sort(compareHistoryKeys);need(equal(expected,entry.receiptIds),'Stored segment receipt set is not exact');
  const operation=get('operation',entry.operationId);need(operation?.kind==='operation','Stored segment operation missing');
  const seal=operation.value;need(seal.segmentId===entry.id&&seal.wireSha256===entry.wireSha256,'Segment/operation commitment changed');
  need(seal.rows.length===decoded.rows.length,'Operation selected row inventory changed');
  const ids=new Set<string>();
  seal.rows.forEach((row,ordinal)=>{const actual=decoded.rows[ordinal];need(actual&&row.id===actual.id&&row.revision===actual.revision&&row.rowSha256===hash(canonical(actual)), 'Operation source row commitment changed');
   need(row.custody.kind==='segment'&&row.custody.segmentId===entry.id&&row.custody.ordinal===ordinal,'Operation selected custody changed');
   need(equal(get('row',row.id)?.value,row),'Current selected row catalogue differs from immutable custody');
   for(const id of row.requests)ids.add(id);});
  const requests=[...ids].sort(compareHistoryKeys).map(id=>{const item=get('request',id);need(item?.kind==='request','Operation original request missing');return item.value;});
  need(equal(requests,seal.requests),'Operation immutable original catalogue changed');
  need(hash(canonical({rows:seal.rows,requests:seal.requests}))===seal.catalogueSha256,'Operation catalogue commitment changed');
  return {id:entry.id,wire:entry.wire,receipts};
 }
 try{
  // Independent complete actual inventory, including unsupported/unused kinds.
  let previous:HistoryStoredObject|undefined;
  for(const input of access.objects()){
   const object=verifyHistoryObject(input,limits,access.schema as 61|62);
   need(!previous||compareHistoryKeys(previous.kind,object.kind)<0||previous.kind===object.kind&&compareHistoryKeys(previous.key,object.key)<0,'Complete history object inventory order/duplicate');
   previous=object;objectCount++;inputBytes+=bytes(object,limits.objectBytes);
   need(Number.isSafeInteger(inputBytes)&&objectCount<=limits.objects&&inputBytes<=limits.inputBytes,'Complete history object input bound');
   need(equal(get(object.kind,object.key),object),'Actual history object lookup mismatch');
   if(object.kind==='segment'){need(segment(object.key),'Actual segment missing');segments++;}
   if(object.kind==='operation'){const paired=get('segment',object.value.segmentId);need(paired?.kind==='segment'&&paired.value.operationId===object.key,'Orphan or shared sealing operation');operations++;}
  }
  need(segments===operations,'Segment/operation inventory does not close');
  const port:FeedHistorySnapshot={schema:access.schema,snapshotToken:()=>{active();return initial;},
   activeRows:()=>{active();return access.activeRows();},activeRow:id=>{active();assertHistoryUtf8Key(id);const row=access.activeRow(id);if(row)need(row.id===id,'Active row lookup key changed');return row;},
   segments:function*(){for(const object of inventory('segment'))yield segment(object.key)!;},segment,
   receipts:()=>{active();return access.receipts();},receipt,
   rowIndexes:function*(){for(const x of inventory('row'))yield x.value as any;},rowIndex:id=>get('row',id)?.value as any,
   requestIndexes:function*(){for(const x of inventory('request'))yield x.value as any;},requestIndex:id=>get('request',id)?.value as any,
   children:function*(){for(const x of inventory('child'))yield x.value as any;},child:id=>get('child',id)?.value as any,
   heads:function*(){for(const x of inventory('head'))yield x.value as any;},head:id=>get('head',id)?.value as any,
   stopIndexes:function*(){for(const x of inventory('stop'))yield x.value as any;},stopIndex:id=>get('stop',id)?.value as any,
   terminalStops:function*(target){active();for(const raw of access.stops(target)){const x=verifyHistoryObject(raw,limits,access.schema as 61|62);need(x.kind==='stop'&&x.rangeKey===target,'Terminal Stop range lookup changed');yield x.value;}},
   controlSpans:function*(){for(const x of inventory('span'))yield x.value as any;},controlSpan:id=>get('span',id)?.value as any,
   controlRevisions:function*(){for(const x of inventory('revision'))yield x.value as any;},controlRevision:id=>get('revision',id)?.value as any};
  const proof=verifyFeedHistorySnapshot(port,limits.graph,hash,native,()=>{const stream=createHash('sha256');return {update:(text:string)=>{stream.update(text);},digest:()=>stream.digest('hex')};},selected);
  const sealing=access.schema===62?verifySealRecords(access,limits):undefined;
  active();return {...proof,persisted:{objects:objectCount,inputBytes,segments,operations},...(sealing?{sealing}:{})};
 }finally{alive=false;}
}
