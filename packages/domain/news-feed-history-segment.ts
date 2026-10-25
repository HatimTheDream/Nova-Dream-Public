import {createHash} from 'node:crypto';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {types} from 'node:util';
import {canonical} from './contracts.js';
import {verifyFeedLocalGraph,protocolIntent,type Ledger,type NativeIdentity} from './news-feed-successor-journal.js';
import {adaptiveProtocolRequestSchema} from './news-feed-adaptive-commands.js';
import {feedCommandSchema} from './news-feed.js';
import type {SemanticRow,SemanticReceipt} from './news-feed-semantic-journal.js';

/** Plain data correspondence only. This is not a Store custody, sealing,
 * authorization, complete logical-history or incremental-validation proof. */
export const historySegmentLimits=Object.freeze({rows:50,requests:850,receiptRefs:1050,receipts:1000,
 decodedBytes:4*1024*1024,storedBytes:6*1024*1024,depth:64,nodes:300000,projectionInputBytes:16*1024*1024});
export type ReceiptCommitment={requestId:string;deviceId:string;intentSha256:string;receiptSha256:string};
export type RequestLocator={requestId:string;rowId:string;ordinal:number;kind:string;deviceId:string;epoch:string;at:number;
 requestSha256:string;status:'admitted'|'pending-close';receiptSha256?:string};
export type RowLocator={rowId:string;ordinal:number;revision:number;rowSha256:string;requestIds:string[]};
export type ReceiptReference={rowId:string;requestId:string;role:'admission'|'preference'|'close-reference'};
export type HistoryProjection={format:1;sourceContract:'feed-history-correspondence-1';schema:60;rows:SemanticRow[];
 catalogue:{rows:RowLocator[];requests:RequestLocator[]};receipts:ReceiptCommitment[];receiptRefs:ReceiptReference[]};
/** The complete ledger must come from one authenticated Store snapshot. The
 * factory verifies its actual maintained graph; neither this type nor its return
 * value is an authorization brand. All unrelated receipt rows remain visible. */
export type HistoryProjectionInput={ledger:Ledger;selectedRowIds:string[]};
export type ReceiptProjection={receipts:SemanticReceipt[]};
type Envelope={format:1;sourceContract:'feed-history-correspondence-1';codec:'identity-json-v1'|'deflate-raw-v1';
 decodedBytes:number;decodedSha256:string;payloadBytes:number;payloadSha256:string;storedBytes:number;payload:HistoryProjection|string};
/** The manifest commits semantic values; each row's separate JSON commitment
 * preserves the original serialization consumed by retained prompt validation.
 * This is correspondence only, not authenticated Store custody or graph proof. */
type ExactRowsPayload={format:2;sourceContract:'feed-history-correspondence-2';
 manifest:Omit<HistoryProjection,'rows'>;manifestSha256:string;rows:{json:string;jsonSha256:string}[]};
type ExactEnvelope={format:2;sourceContract:'feed-history-correspondence-2';codec:'identity-json-v2'|'deflate-raw-v2';
 decodedBytes:number;decodedSha256:string;payloadBytes:number;payloadSha256:string;storedBytes:number;payload:ExactRowsPayload|string};
const hash=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
function need(yes:unknown,message:string):asserts yes{if(!yes)throw new Error(message);}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha=/^[a-f0-9]{64}$/;
const positive=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const bytes=(value:unknown)=>Buffer.byteLength(canonical(value),'utf8');
const closed=(value:unknown,keys:string[])=>{need(value!==null&&typeof value==='object'&&!Array.isArray(value),'Expected object');
 need(equal(Object.keys(value).sort(),[...keys].sort()),'Unexpected object fields');};

/** Reject representations that JSON/canonical would silently discard/coerce.
 * Count before canonicalization, including symbols/accessors/array extra keys.
 * No getter or toJSON is called. Shared references are permitted; cycles are not. */
function checkData(value:unknown,maxBytes:number,maxDepth:number):void{
 let nodes=0,roughBytes=0;const active=new Set<object>();
 const visit=(v:unknown,depth:number)=>{
  need(++nodes<=historySegmentLimits.nodes&&depth<=maxDepth,'History node/depth bound');
  if(v===null||typeof v==='boolean'){roughBytes+=5;return;}
  if(typeof v==='string'){roughBytes+=Buffer.byteLength(v,'utf8');need(roughBytes<=maxBytes,'History input byte bound');return;}
  if(typeof v==='number'){need(Number.isFinite(v)&&(!Number.isInteger(v)||Number.isSafeInteger(v))&&!Object.is(v,-0),'History number is not lossless');roughBytes+=24;return;}
  need(typeof v==='object'&&v!==null,'Unsupported history value');
  const object=v as object;need(!types.isProxy(object),'History proxy object');need(!active.has(object),'History cycle');active.add(object);
  const proto=Object.getPrototypeOf(object);need(proto===(Array.isArray(object)?Array.prototype:Object.prototype)||!Array.isArray(object)&&proto===null,'Unsupported history prototype');
  const descriptors=Object.getOwnPropertyDescriptors(object),keys=Reflect.ownKeys(descriptors);
  need(keys.every(key=>typeof key==='string'),'History symbol property');
  if(Array.isArray(object)){
   need(object.length<=historySegmentLimits.nodes&&keys.length===object.length+1&&keys.includes('length'),'Sparse/extended history array');
   for(let i=0;i<object.length;i++){const d=descriptors[String(i)];need(d&&'value' in d&&d.enumerable,'History array accessor');visit(d.value,depth+1);}
  }else for(const key of keys as string[]){const d=descriptors[key]!;need('value' in d&&d.enumerable,'History hidden/accessor property');
   roughBytes+=Buffer.byteLength(key,'utf8');need(roughBytes<=maxBytes,'History input byte bound');visit(d.value,depth+1);}
  active.delete(object);
 };
 visit(value,0);need(bytes(value)<=maxBytes,'History canonical byte bound');
}
export function assertHistoryData(value:unknown,maxBytes=historySegmentLimits.decodedBytes):void{checkData(value,maxBytes,historySegmentLimits.depth);}
const stableCopy=<T>(value:T):T=>JSON.parse(canonical(value));
// Call only after assertHistoryData: no accessors, proxies, toJSON or lossy data.
const exactCopy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
/** Bound structural allocation before JSON.parse. Syntax is still checked by
 * JSON.parse; this scanner only rejects excessive depth/token counts, ignoring
 * punctuation inside strings. Keys count too, so 2*nodes is conservative. */
function parseBounded(text:string,maxDepth:number):unknown{
 let depth=0,tokens=0;
 for(let i=0;i<text.length;i++){
  const c=text[i]!;
  if(c==='"'){need(++tokens<=historySegmentLimits.nodes*2,'History parse token bound');
   for(i++;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]==='"')break;}continue;}
  if(c==='{'||c==='['){need(++depth<=maxDepth+1&&++tokens<=historySegmentLimits.nodes*2,'History parse depth/token bound');continue;}
  if(c==='}'||c===']'){depth--;continue;}
  if(c===','||c===':'||/\s/.test(c))continue;
  need(++tokens<=historySegmentLimits.nodes*2,'History parse token bound');
  while(i+1<text.length&&!/[\s,\]}]/.test(text[i+1]!))i++;
 }
 return JSON.parse(text);
}
const commitment=(receipt:SemanticReceipt):ReceiptCommitment=>({requestId:receipt.requestId,deviceId:receipt.deviceId,
 intentSha256:receipt.digest,receiptSha256:hash(canonical(receipt))});
function receiptMap(input:ReceiptProjection){
 assertHistoryData(input,historySegmentLimits.projectionInputBytes);closed(input,['receipts']);
 need(Array.isArray(input.receipts)&&input.receipts.length<=historySegmentLimits.receipts,'Receipt projection bound');
 const map=new Map<string,SemanticReceipt>();for(const r of input.receipts){closed(r,['requestId','deviceId','digest','value']);
  need(uuid.test(r.requestId)&&typeof r.deviceId==='string'&&r.deviceId.length>0&&r.deviceId.length<=200&&sha.test(r.digest),'Invalid actual receipt identity');
  need(!map.has(r.requestId),'Duplicate actual receipt');map.set(r.requestId,r);}
 return map;
}
type RowRequest={request:any;deviceId:string;at:number};
function rowRequests(row:SemanticRow):{own:RowRequest[];close?:any;preferences:SemanticReceipt[]}{
 closed(row,['id','revision','value']);need(typeof row.id==='string'&&positive(row.revision),'Invalid row identity');
 const v=row.value as any;need(v&&typeof v==='object'&&uuid.test(v.id)&&row.revision===v.revision&&typeof v.deviceId==='string'&&v.deviceId.length>0&&v.deviceId.length<=200,'Invalid row owner');
 const own:RowRequest[]=[],preferences:SemanticReceipt[]=[];
 const add=(request:any,deviceId:string,at:number)=>{need(positive(at),'Invalid request time');
  const parsed=request.kind==='control'?{kind:'control',command:feedCommandSchema.parse(request.command)}:adaptiveProtocolRequestSchema.parse(request);
  need(equal(parsed,request)&&uuid.test(request.command.requestId)&&uuid.test(request.command.epoch),'Changed request shape');own.push({request,deviceId,at});};
 const preference=(value:any)=>{if(value?.latestMutation!==undefined)preferences.push(value.latestMutation);};
 if(row.id==='news:semantic-worker:'+v.id||row.id==='news:semantic-adaptive-worker:'+v.id){
  need(['completed','failed','cancelled','withdrawn','rejected'].includes(v.state)&&v.terminal,'History worker is not terminal');
  need(Array.isArray(v.ownerStops)&&v.ownerStops.length<=16,'Owner Stop bound');add({kind:'start',command:v.command},v.deviceId,v.createdAt);
  for(const stop of v.ownerStops){need(stop.deviceId===v.deviceId&&stop.command.id===v.id&&stop.command.epoch===v.command.epoch,'Foreign owner Stop');add({kind:'stop',command:stop.command},stop.deviceId,stop.at);}
  if(v.format===3)preference(v.capture?.source?.preferences);
 }else if(row.id==='news:semantic-review:'+v.id||row.id==='news:semantic-adaptive-review:'+v.id){add({kind:'accept',command:v.command},v.deviceId,v.at);if(v.format===3)preference(v.preferences);}
 else if(row.id==='news:semantic-adaptive-learning:'+v.id||row.id==='news:semantic-adaptive-control:'+v.id){
  add({kind:row.id.startsWith('news:semantic-adaptive-learning:')?'apply-learning':'control',command:v.command},v.deviceId,v.at);
  preference(v.before?.preferences);preference(v.preferencesAfter);
 }else if(row.id==='news:semantic-local:'+v.id){
  need(['closed-before-admission','refused-before-admission','stop-no-effect-terminal','close-ack'].includes(v.kind),'Unsupported local row');
  add(v.request,v.deviceId,v.at);
  if(v.kind==='closed-before-admission'){const close={kind:'close',command:v.close};adaptiveProtocolRequestSchema.parse(close);
   need(own[0]?.request.command.requestId===v.id&&equal(v.close.original,v.request.command)&&v.close.epoch===v.request.command.epoch,'Close reference original changed');return {own,close,preferences};}
 }else throw new Error('Unsupported history row namespace');
 need(own[0]?.request.command.requestId===v.id,'Primary row request changed');return {own,preferences};
}
function derive(rows:SemanticRow[],actual:ReceiptProjection):Omit<HistoryProjection,'format'|'sourceContract'|'schema'|'rows'>{
 need(Array.isArray(rows)&&rows.length>0&&rows.length<=historySegmentLimits.rows,'History row count bound');
 const receipts=receiptMap(actual),rowKeys=new Set<string>(),requests:RequestLocator[]=[],rowLocators:RowLocator[]=[],refs:ReceiptReference[]=[],used=new Map<string,ReceiptCommitment>();
 const owned=new Map<string,RequestLocator>(),analyses=rows.map(row=>rowRequests(row));
 const use=(rowId:string,id:string,role:ReceiptReference['role'],expected?:SemanticReceipt)=>{
  const r=receipts.get(id);need(r,'Missing actual receipt');if(expected)need(equal(r,expected),'Embedded receipt differs from actual receipt');
  used.set(id,commitment(r));const ref={rowId,requestId:id,role};if(!refs.some(existing=>equal(existing,ref)))refs.push(ref);return r;
 };
 rows.forEach((row,ordinal)=>{need(!rowKeys.has(row.id),'Duplicate history row');rowKeys.add(row.id);
  const locator:RowLocator={rowId:row.id,ordinal,revision:row.revision,rowSha256:hash(canonical(row)),requestIds:[]};rowLocators.push(locator);
  for(const source of analyses[ordinal]!.own){const request=source.request,id=request.command.requestId;
   need(!owned.has(id),'Duplicate history request');const receipt=use(row.id,id,'admission');
   need(receipt.deviceId===source.deviceId&&receipt.digest===hash(canonical(protocolIntent(request))),'Foreign actual receipt owner/intent');
   const target:RequestLocator={requestId:id,rowId:row.id,ordinal,kind:request.kind,deviceId:source.deviceId,epoch:request.command.epoch,at:source.at,
    requestSha256:hash(canonical(request)),status:'admitted',receiptSha256:hash(canonical(receipt))};requests.push(target);owned.set(id,target);locator.requestIds.push(id);
  }
  for(const receipt of analyses[ordinal]!.preferences)use(row.id,receipt.requestId,'preference',receipt);
 });
 rows.forEach((row,ordinal)=>{const close=analyses[ordinal]!.close;if(!close)return;
  const v=row.value as any,id=close.command.requestId,existing=owned.get(id);
  if(existing){need(existing.kind==='close'&&existing.deviceId===v.deviceId&&existing.requestSha256===hash(canonical(close)),'Foreign close acknowledgement');use(row.id,id,'close-reference');}
  else {need(!receipts.has(id),'Close acknowledgement row must join selected segment');
   const target:RequestLocator={requestId:id,rowId:row.id,ordinal,kind:'close',deviceId:v.deviceId,epoch:close.command.epoch,at:v.at,requestSha256:hash(canonical(close)),status:'pending-close'};
   need(!requests.some(r=>r.requestId===id),'Duplicate pending close');requests.push(target);rowLocators[ordinal]!.requestIds.push(id);}
 });
 need(requests.length<=historySegmentLimits.requests&&refs.length<=historySegmentLimits.receiptRefs&&used.size<=historySegmentLimits.receipts,'History catalogue bound');
 return {catalogue:{rows:rowLocators,requests},receipts:[...used.values()].sort((a,b)=>a.requestId.localeCompare(b.requestId)),receiptRefs:refs};
}
export function projectHistorySegment(input:HistoryProjectionInput,nativeIdentity:NativeIdentity):HistoryProjection{
 assertHistoryData(input,historySegmentLimits.projectionInputBytes);closed(input,['ledger','selectedRowIds']);
 closed(input.ledger,['schema','rows','receipts']);need(input.ledger.schema===60,'Unsupported projection source schema');
 need(Array.isArray(input.selectedRowIds)&&input.selectedRowIds.length>0&&input.selectedRowIds.length<=historySegmentLimits.rows&&new Set(input.selectedRowIds).size===input.selectedRowIds.length,'Invalid selected history rows');
 const graph=verifyFeedLocalGraph(input.ledger,hash,nativeIdentity),map=new Map(input.ledger.rows.map(row=>[row.id,row]));
 const rows=input.selectedRowIds.map(id=>{const row=map.get(id);need(row,'Selected history row missing');return row;});
 // Include only exact receipts needed by selected rows; all global collisions
 // and dependency edges were checked against the complete ledger immediately above.
 const relevant=new Set<string>();for(const row of rows){const r=rowRequests(row);for(const own of r.own)relevant.add(own.request.command.requestId);
  for(const receipt of r.preferences)relevant.add(receipt.requestId);if(r.close&&graph.originalRequests.has(r.close.command.requestId))relevant.add(r.close.command.requestId);}
 const actual={receipts:input.ledger.receipts.filter(r=>relevant.has(r.requestId))};
 const projection:HistoryProjection={format:1,sourceContract:'feed-history-correspondence-1',schema:60,rows,...derive(rows,actual)};
 assertHistoryData(projection);return exactCopy(projection);
}
export function verifyHistoryProjection(projection:HistoryProjection,actual:ReceiptProjection):HistoryProjection{
 assertHistoryData(projection);closed(projection,['format','sourceContract','schema','rows','catalogue','receipts','receiptRefs']);
 need(projection.format===1&&projection.sourceContract==='feed-history-correspondence-1'&&projection.schema===60,'Unsupported history projection');
 const expected={format:1,sourceContract:'feed-history-correspondence-1',schema:60,rows:projection.rows,...derive(projection.rows,actual)};
 need(equal(projection,expected),'History catalogue/receipt commitment mismatch');return exactCopy(projection);
}
/** Selected correspondence only, after the Store's complete actual history
 * proof in the same lexical snapshot. No schema relabel, graph or authority
 * claim is made by this helper; the legacy full-ledger projector is unchanged. */
export function projectSelectedHistoryRows(input:{rows:SemanticRow[];receipts:SemanticReceipt[]}):HistoryProjection{
 assertHistoryData(input,historySegmentLimits.projectionInputBytes);closed(input,['rows','receipts']);
 const projection:HistoryProjection={format:1,sourceContract:'feed-history-correspondence-1',schema:60,
  rows:input.rows,...derive(input.rows,{receipts:input.receipts})};
 need(projection.catalogue.requests.every(r=>r.status==='admitted'),'Pending Close cannot leave active custody');
 assertHistoryData(projection);return exactCopy(projection);
}
// Legacy format1 decoding keeps its original canonical-copy behavior.
function verifyLegacyHistoryProjection(projection:HistoryProjection,actual:ReceiptProjection):HistoryProjection{
 assertHistoryData(projection);closed(projection,['format','sourceContract','schema','rows','catalogue','receipts','receiptRefs']);
 need(projection.format===1&&projection.sourceContract==='feed-history-correspondence-1'&&projection.schema===60,'Unsupported history projection');
 const expected={format:1,sourceContract:'feed-history-correspondence-1',schema:60,rows:projection.rows,...derive(projection.rows,actual)};
 need(equal(projection,expected),'History catalogue/receipt commitment mismatch');return stableCopy(projection);
}
function finish<T extends {storedBytes:number}>(envelope:T):T{
 // Fixed point: storedBytes counts the complete canonical envelope, including
 // this field's own decimal digits. Monotone digit growth converges in <=8 steps.
 for(let n=0;n<8;n++){const length=bytes(envelope);if(length===envelope.storedBytes)return envelope;envelope.storedBytes=length;}
 throw new Error('History envelope size did not converge');
}
export function encodeHistorySegment(projection:HistoryProjection,actual:ReceiptProjection):string{
 const value=verifyHistoryProjection(projection,actual),{rows,...manifest}=value;
 const payload:ExactRowsPayload={format:2,sourceContract:'feed-history-correspondence-2',manifest,manifestSha256:hash(canonical(manifest)),
  rows:rows.map(row=>{const json=JSON.stringify(row);return {json,jsonSha256:hash(json)};})};
 // Escaping row JSON is real decoded payload allocation, never a discounted
 // estimate. Reject the whole segment when it no longer fits the unchanged cap.
 assertHistoryData(payload);const plain=Buffer.from(canonical(payload),'utf8');
 const common={format:2 as const,sourceContract:'feed-history-correspondence-2' as const,decodedBytes:plain.length,decodedSha256:hash(plain),storedBytes:0};
 const identity=finish<ExactEnvelope>({...common,codec:'identity-json-v2',payload,payloadBytes:plain.length,payloadSha256:hash(plain)});
 const compressed=deflateRawSync(plain,{level:6}),packed=finish<ExactEnvelope>({...common,codec:'deflate-raw-v2',payload:compressed.toString('base64'),payloadBytes:compressed.length,payloadSha256:hash(compressed)});
 const chosen=packed.storedBytes<identity.storedBytes?packed:identity;
 need(chosen.storedBytes<=historySegmentLimits.storedBytes,'History stored byte bound');return canonical(chosen);
}
function decodeLegacyHistorySegment(wire:string,actual:ReceiptProjection):HistoryProjection{
 need(typeof wire==='string'&&Buffer.byteLength(wire,'utf8')<=historySegmentLimits.storedBytes,'History stored byte bound');
 const e=parseBounded(wire,historySegmentLimits.depth+1) as Envelope;checkData(e,historySegmentLimits.storedBytes,historySegmentLimits.depth+1);
 closed(e,['format','sourceContract','codec','decodedBytes','decodedSha256','payloadBytes','payloadSha256','storedBytes','payload']);
 need(canonical(e)===wire&&e.format===1&&e.sourceContract==='feed-history-correspondence-1','Noncanonical/unsupported history envelope');
 need(e.storedBytes===Buffer.byteLength(wire,'utf8')&&positive(e.decodedBytes)&&e.decodedBytes<=historySegmentLimits.decodedBytes&&positive(e.payloadBytes)&&e.payloadBytes<=historySegmentLimits.storedBytes&&sha.test(e.decodedSha256)&&sha.test(e.payloadSha256),'Invalid history size/hash metadata');
 let plain:Buffer;
 if(e.codec==='identity-json-v1'){need(typeof e.payload==='object'&&e.payload!==null,'Invalid identity payload');plain=Buffer.from(canonical(e.payload),'utf8');
  need(plain.length===e.payloadBytes&&hash(plain)===e.payloadSha256,'Identity payload commitment mismatch');
 }else if(e.codec==='deflate-raw-v1'){
  need(typeof e.payload==='string'&&e.payload.length===4*Math.ceil(e.payloadBytes/3)&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.payload),'Invalid canonical base64');
  const packed=Buffer.from(e.payload,'base64');need(packed.length===e.payloadBytes&&packed.toString('base64')===e.payload&&hash(packed)===e.payloadSha256,'Compressed payload commitment mismatch');
  const inflated=inflateRawSync(packed,{info:true,maxOutputLength:e.decodedBytes}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
  need(inflated.engine.bytesWritten===packed.length,'Trailing compressed input');plain=inflated.buffer;
 }else throw new Error('Unsupported history codec');
 need(plain.length===e.decodedBytes&&hash(plain)===e.decodedSha256,'Decoded payload commitment mismatch');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(plain),projection=parseBounded(text,historySegmentLimits.depth) as HistoryProjection;
 assertHistoryData(projection);need(canonical(projection)===text,'Noncanonical decoded history');return verifyLegacyHistoryProjection(projection,actual);
}
export function decodeHistorySegment(wire:string,actual:ReceiptProjection):HistoryProjection{
 need(typeof wire==='string'&&Buffer.byteLength(wire,'utf8')<=historySegmentLimits.storedBytes,'History stored byte bound');
 const e=parseBounded(wire,historySegmentLimits.depth+1) as ExactEnvelope|Envelope;
 // Dispatch only after the same finite parser guard; format1 retains its own
 // exact parser/shape/hash/codec checks and canonical return representation.
 if(e&&e.format===1)return decodeLegacyHistorySegment(wire,actual);
 checkData(e,historySegmentLimits.storedBytes,historySegmentLimits.depth+1);
 closed(e,['format','sourceContract','codec','decodedBytes','decodedSha256','payloadBytes','payloadSha256','storedBytes','payload']);
 need(canonical(e)===wire&&e.format===2&&e.sourceContract==='feed-history-correspondence-2','Noncanonical/unsupported history envelope');
 need(e.storedBytes===Buffer.byteLength(wire,'utf8')&&positive(e.decodedBytes)&&e.decodedBytes<=historySegmentLimits.decodedBytes&&positive(e.payloadBytes)&&e.payloadBytes<=historySegmentLimits.storedBytes&&sha.test(e.decodedSha256)&&sha.test(e.payloadSha256),'Invalid history size/hash metadata');
 let plain:Buffer;
 if(e.codec==='identity-json-v2'){need(typeof e.payload==='object'&&e.payload!==null,'Invalid identity payload');plain=Buffer.from(canonical(e.payload),'utf8');
  need(plain.length===e.payloadBytes&&hash(plain)===e.payloadSha256,'Identity payload commitment mismatch');
 }else if(e.codec==='deflate-raw-v2'){
  need(typeof e.payload==='string'&&e.payload.length===4*Math.ceil(e.payloadBytes/3)&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.payload),'Invalid canonical base64');
  const packed=Buffer.from(e.payload,'base64');need(packed.length===e.payloadBytes&&packed.toString('base64')===e.payload&&hash(packed)===e.payloadSha256,'Compressed payload commitment mismatch');
  const inflated=inflateRawSync(packed,{info:true,maxOutputLength:e.decodedBytes}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
  need(inflated.engine.bytesWritten===packed.length,'Trailing compressed input');plain=inflated.buffer;
 }else throw new Error('Unsupported history codec');
 need(plain.length===e.decodedBytes&&hash(plain)===e.decodedSha256,'Decoded payload commitment mismatch');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(plain),payload=parseBounded(text,historySegmentLimits.depth) as ExactRowsPayload;
 assertHistoryData(payload);need(canonical(payload)===text,'Noncanonical decoded history');
 closed(payload,['format','sourceContract','manifest','manifestSha256','rows']);
 need(payload.format===2&&payload.sourceContract==='feed-history-correspondence-2','Unsupported exact history payload');
 closed(payload.manifest,['format','sourceContract','schema','catalogue','receipts','receiptRefs']);
 need(sha.test(payload.manifestSha256)&&hash(canonical(payload.manifest))===payload.manifestSha256,'History manifest commitment mismatch');
 need(Array.isArray(payload.rows)&&payload.rows.length>0&&payload.rows.length<=historySegmentLimits.rows,'History row count bound');
 const rows=payload.rows.map(item=>{closed(item,['json','jsonSha256']);
  need(typeof item.json==='string'&&Buffer.byteLength(item.json,'utf8')<=historySegmentLimits.decodedBytes&&sha.test(item.jsonSha256)&&hash(item.json)===item.jsonSha256,'History exact row commitment mismatch');
  const row=parseBounded(item.json,historySegmentLimits.depth) as SemanticRow;assertHistoryData(row);
  need(JSON.stringify(row)===item.json,'History row JSON is not exact');return row;});
 // Recheck combined decoded rows and rederive every catalogue/receipt binding.
 // Original prompt/native and cross-row graph validation belongs to the caller.
 return verifyHistoryProjection({...payload.manifest,rows},actual);
}
