import {z} from 'zod';
import {assertHistoryUtf8Key,compareHistoryKeys} from './news-feed-history-keys.js';
import {canonical} from './contracts.js';
import * as legacy from './news-feed-semantic-journal.js';
import * as worker from './news-feed-worker.js';
import * as adaptive from './news-feed-adaptive-graph.js';
import * as adaptiveWorker from './news-feed-adaptive-worker.js';
import type {AdaptiveSource} from './news-feed-adaptive-capture.js';
import {resolveControlBaseline,foldControlProofIndexed,readSavedControlStep,feedControlProofSchema,type ControlHashStream} from './news-feed-adaptive-controls.js';
import * as local from './news-feed-successor-journal.js';
import {feedProtocolLimits,feedLocalAdmissionSchema} from './news-feed-semantic-protocol.js';
import {adaptiveAdmissionSchema} from './news-feed-adaptive-commands.js';
import {decodeHistorySegment,type HistoryProjection} from './news-feed-history-segment.js';
import type {WorkerIdentity} from './worker.js';
import type {SelectedOriginalCollector} from './news-feed-selected-originals.js';

type Row=legacy.SemanticRow;type Receipt=legacy.SemanticReceipt;type Hash=(text:string)=>string;
type Native=(value:WorkerIdentity)=>{runId:string;sessionKey:string};
const sha=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid(),id=z.string().min(1).max(300),owner=z.string().min(1).max(200);
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),positive=integer.positive();
const kinds=['legacy-worker','legacy-review','adaptive-worker','adaptive-review','learning','control','local'] as const;
export const historyCustodySchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('active')}).strict(),z.object({kind:z.literal('segment'),segmentId:uuid,ordinal:integer.max(49)}).strict()]);
export type HistoryCustody=z.infer<typeof historyCustodySchema>;
export const historyEdgeSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('row'),role:z.enum(['review-worker','apply-worker','accepted-review']),rowId:id}).strict(),
 z.object({kind:z.literal('original'),role:z.enum(['close-original','learning-parent','terminal-stop']),requestId:uuid}).strict(),
 z.object({kind:z.literal('receipt'),role:z.enum(['preference','preferences-after']),requestId:uuid,sha256:sha}).strict(),
 z.object({kind:z.literal('control-span'),spanId:sha}).strict()]);
export type HistoryEdge=z.infer<typeof historyEdgeSchema>;
export const historyMutationSchema=z.object({parentId:uuid.nullable(),rootId:uuid,depth:positive}).strict();
export const historyRowIndexSchema=z.object({format:z.literal(1),id,revision:positive,kind:z.enum(kinds),owner,epoch:uuid,rowSha256:sha,
 custody:historyCustodySchema,requests:z.array(uuid).max(17),edges:z.array(historyEdgeSchema).max(8),mutation:historyMutationSchema.optional()}).strict();
export type HistoryRowIndex=z.infer<typeof historyRowIndexSchema>;
export const historyRequestIndexSchema=z.object({format:z.literal(1),requestId:uuid,rowId:id,kind:z.enum(['start','stop','accept','apply-learning','control','close']),
 owner,epoch:uuid,at:positive,requestSha256:sha,status:z.enum(['admitted','pending-close']),receiptSha256:sha.optional()}).strict();
export type HistoryRequestIndex=z.infer<typeof historyRequestIndexSchema>;
export const historyChildIndexSchema=z.object({key:sha,rowId:id,parentId:uuid.nullable(),owner,epoch:uuid}).strict();
export const historyHeadIndexSchema=z.object({key:sha,rowId:id,owner,epoch:uuid}).strict();
export const historyStopIndexSchema=z.object({key:sha,rowId:id,targetId:uuid}).strict();
export const historyControlSpanSchema=z.object({id:sha,firstOwnerRowId:id,owner,epoch:uuid,proof:feedControlProofSchema}).strict();
export type HistoryControlSpan=z.infer<typeof historyControlSpanSchema>;
export const historyControlRevisionSchema=z.object({key:sha,epoch:uuid,revision:positive,requestId:uuid,receiptSha256:sha,coveringSpan:sha}).strict();
export type HistoryControlRevision=z.infer<typeof historyControlRevisionSchema>;
/** Explicit unqualified input bounds, supplied by fixtures in this source-only
 * slice. These numbers are not production storage policy or schema authority. */
export const historyVerificationLimitsSchema=z.object({qualification:z.literal('unqualified'),logicalRows:positive,decodedBytes:positive,indexBytes:positive,
 receiptBytes:positive,controlSteps:positive}).strict();
export type HistoryVerificationLimits=z.infer<typeof historyVerificationLimitsSchema>;
export type HistorySegmentSource={id:string;wire:string;receipts:Receipt[]};
/** Internal authenticated storage port, never a browser payload. Inventories
 * must enumerate the complete actual namespace, independently of lookup
 * indexes, in exact SQLite UTF-8 BINARY key order. The Store adapter must qualify
 * that contract; this pure function cannot authenticate its caller. */
export interface FeedHistorySnapshot {
 schema:number;
 snapshotToken():string;
 activeRows():Iterable<Row>;activeRow(id:string):Row|undefined;
 segments():Iterable<HistorySegmentSource>;segment(id:string):HistorySegmentSource|undefined;
 rowIndexes():Iterable<HistoryRowIndex>;rowIndex(id:string):HistoryRowIndex|undefined;
 requestIndexes():Iterable<HistoryRequestIndex>;requestIndex(id:string):HistoryRequestIndex|undefined;
 receipts():Iterable<Receipt>;receipt(id:string):Receipt|undefined;
 children():Iterable<z.infer<typeof historyChildIndexSchema>>;child(key:string):z.infer<typeof historyChildIndexSchema>|undefined;
 heads():Iterable<z.infer<typeof historyHeadIndexSchema>>;head(key:string):z.infer<typeof historyHeadIndexSchema>|undefined;
 stopIndexes():Iterable<z.infer<typeof historyStopIndexSchema>>;stopIndex(key:string):z.infer<typeof historyStopIndexSchema>|undefined;
 terminalStops(targetId:string):Iterable<z.infer<typeof historyStopIndexSchema>>;
 controlSpans():Iterable<HistoryControlSpan>;controlSpan(id:string):HistoryControlSpan|undefined;
 controlRevisions():Iterable<HistoryControlRevision>;controlRevision(key:string):HistoryControlRevision|undefined;
}
function need(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
const same=worker.same,size=worker.size;
const terminal=(value:worker.FeedWorkerSaved|adaptiveWorker.FeedWorkerSaved)=>value.format===3?adaptiveWorker.terminal(value):worker.terminal(value);
export const historyOwnerKey=(deviceId:string,epoch:string,hash:Hash)=>hash(canonical({deviceId,epoch}));
export const historyParentKey=(deviceId:string,epoch:string,parentId:string|null,hash:Hash)=>hash(canonical({deviceId,epoch,parentId}));
export const historyRevisionKey=(epoch:string,revision:number,hash:Hash)=>hash(canonical({epoch,revision}));
export const historyStopKey=(targetId:string,rowId:string,hash:Hash)=>hash(canonical({targetId,rowId}));
export const historySpanId=(deviceId:string,epoch:string,proof:unknown,hash:Hash)=>hash(canonical({deviceId,epoch,proof}));
function exact<T>(schema:z.ZodType<T>,raw:unknown):T{const parsed=schema.parse(raw);need(same(parsed,raw),'History descriptor changed or has unsupported fields');return parsed;}
function* sorted<T>(values:Iterable<T>,key:(value:T)=>string){let previous:string|undefined;for(const value of values){const current=key(value);assertHistoryUtf8Key(current);
 need(previous===undefined||compareHistoryKeys(previous,current)<0,'History inventory must have strict unique sorted keys');previous=current;yield value;}}
function add(total:number,delta:number,limit:number,label:string){need(Number.isSafeInteger(delta)&&delta>=0&&Number.isSafeInteger(total+delta)&&total+delta<=limit,label);return total+delta;}
function rowKind(row:Row):HistoryRowIndex['kind']{
 if(row.id.startsWith(adaptiveWorker.feedWorkerPrefix))return 'adaptive-worker';
 if(row.id.startsWith(worker.feedWorkerPrefix))return 'legacy-worker';
 if(row.id.startsWith(adaptive.adaptiveReviewPrefix))return 'adaptive-review';
 if(row.id.startsWith(legacy.feedReviewPrefix))return 'legacy-review';
 if(row.id.startsWith(adaptive.adaptiveLearningPrefix))return 'learning';
 if(row.id.startsWith(adaptive.adaptiveControlPrefix))return 'control';
 if(row.id.startsWith(local.feedLocalPrefix))return 'local';
 throw new Error('Unsupported history semantic namespace');
}

/** Exact row/request/edge descriptions only. The complete verifier below must
 * still validate all values and dependencies. This function is no authority. */
export function describeHistoryRow(row:Row,custody:HistoryCustody,hash:Hash,mutation?:z.infer<typeof historyMutationSchema>){
 const kind=rowKind(row),value=row.value as any,epoch=value.command?.epoch??value.epoch,edges:HistoryEdge[]=[],requests:HistoryRequestIndex[]=[];
 const expected:Receipt[]=[];
 function request(command:any,k:HistoryRequestIndex['kind'],deviceId:string,at:number,receipt?:Receipt){requests.push({format:1,requestId:command.requestId,rowId:row.id,kind:k,owner:deviceId,epoch:command.epoch,at,
  requestSha256:hash(canonical({kind:k,command})),status:receipt?'admitted':'pending-close',...(receipt?{receiptSha256:hash(canonical(receipt))}:{})});if(receipt)expected.push(receipt);}
 function preference(preferences:any,role:'preference'|'preferences-after'='preference'){const receipt=preferences?.latestMutation;if(receipt)edges.push({kind:'receipt',role,requestId:receipt.requestId,sha256:hash(canonical(receipt))});}
 function source(source:AdaptiveSource){preference(source.preferences);if(source.learningHead)edges.push({kind:'original',role:'learning-parent',requestId:source.learningHead});
  if(source.controlProof)edges.push({kind:'control-span',spanId:historySpanId(source.context.deviceId,source.context.epoch,source.controlProof,hash)});}
 if(kind==='legacy-worker'||kind==='adaptive-worker'){
  const list=kind==='legacy-worker'?legacy.expectedReceipts(value,hash):adaptive.adaptiveWorkerReceipts(value,hash);
  request(value.command,'start',value.deviceId,value.createdAt,list[0]);value.ownerStops.forEach((s:any,i:number)=>request(s.command,'stop',s.deviceId,s.at,list[i+1]));
  if(kind==='legacy-worker'&&value.capture.kind==='classify')edges.push({kind:'row',role:'accepted-review',rowId:legacy.feedReviewPrefix+value.capture.review.reviewRequestId});
  if(kind==='adaptive-worker'){
   if(value.capture.kind==='interpret')preference(value.capture.source.preferences);else source(value.capture.source);
   if(value.capture.basis?.kind==='accepted')edges.push({kind:'row',role:'accepted-review',rowId:adaptive.adaptiveReviewPrefix+value.capture.basis.approval.reviewRequestId});
  }
 }else if(kind==='legacy-review'||kind==='adaptive-review'){
  const receipt=kind==='legacy-review'?legacy.expectedReceipts(value,hash)[0]:adaptive.genericReceipt(value.id,value.deviceId,{type:'feed-semantic-review',command:value.command},adaptive.adaptiveReviewReceipt(value,hash),hash);
  request(value.command,'accept',value.deviceId,value.at,receipt);edges.push({kind:'row',role:'review-worker',rowId:(kind==='legacy-review'?worker.feedWorkerPrefix:adaptiveWorker.feedWorkerPrefix)+value.command.operationId});
  if(kind==='adaptive-review')preference(value.preferences);
 }else if(kind==='learning'||kind==='control'){
  source(value.before);if(kind==='learning'){
   request(value.command,'apply-learning',value.deviceId,value.at,adaptive.genericReceipt(value.id,value.deviceId,{type:'feed-semantic-learning',command:value.command},adaptive.adaptiveLearningReceipt(value,hash),hash));
   edges.push({kind:'row',role:'apply-worker',rowId:adaptiveWorker.feedWorkerPrefix+value.command.operationId});
  }else{const receipt=value.preferencesAfter.latestMutation;request(value.command,'control',value.deviceId,value.at,receipt);preference(value.preferencesAfter,'preferences-after');}
 }else{
  request(value.request.command,value.request.kind,value.deviceId,value.at,local.localOriginalReceipt(value,hash));
  if(value.kind==='closed-before-admission')request(value.close,'close',value.deviceId,value.at);
  if(value.kind==='stop-no-effect-terminal')edges.push({kind:'original',role:'terminal-stop',requestId:value.target.id});
  if(value.kind==='close-ack')edges.push({kind:'original',role:'close-original',requestId:value.request.command.original.requestId});
 }
 const descriptor={format:1 as const,id:row.id,revision:row.revision,kind,owner:value.deviceId,epoch,rowSha256:hash(canonical(row)),custody,
  requests:requests.map(r=>r.requestId),edges,...(mutation?{mutation}:{})};
 return {row:exact(historyRowIndexSchema,descriptor),requests:requests.map(r=>exact(historyRequestIndexSchema,r)),expected};
}

export function verifyFeedHistorySnapshot(snapshot:FeedHistorySnapshot,limitsInput:HistoryVerificationLimits,hash:Hash,native:Native,stream:ControlHashStream,selected?:SelectedOriginalCollector){
 const limits=exact(historyVerificationLimitsSchema,limitsInput);need(Number.isSafeInteger(snapshot.schema)&&snapshot.schema>=60,'History graph requires semantic schema');
 const token=snapshot.snapshotToken();need(typeof token==='string'&&token.length>0&&token.length<=1000,'Snapshot token is missing');
 let decodedBytes=0,indexBytes=0,receiptBytes=0,rowCount=0,requestCount=0,mutationCount=0,leafCount=0,unresolved=0,controlSteps=0,activeBytes=0,localStops=0;
 const activeRows:Row[]=[],activeWorkers=new Map<string,any>(),activeLocals=new Map<string,local.FeedLocalRecord>(),activeOriginals=new Map<string,local.OriginalRequest>();
 // Only one decoded segment is retained here. Current/dependency row objects
 // may coexist; actual peak memory and production quotas remain unqualified.
 let cache:{id:string;wire:string;projection:HistoryProjection}|undefined;
 function projection(segment:HistorySegmentSource){uuid.parse(segment.id);if(cache?.id===segment.id){need(cache.wire===segment.wire,'Segment bytes changed inside snapshot');return cache.projection;}
  for(const receipt of segment.receipts)need(same(snapshot.receipt(receipt.requestId),receipt),'Segment receipt projection is not the actual snapshot');
  const value=decodeHistorySegment(segment.wire,{receipts:segment.receipts});cache={id:segment.id,wire:segment.wire,projection:value};return value;
 }
 function index(id:string){const raw=snapshot.rowIndex(id);need(raw,'History row has no indexed custody');const result=exact(historyRowIndexSchema,raw);need(result.id===id,'History row index key changed');return result;}
 function resolve(id:string):Row{const item=index(id);let row:Row|undefined;
  if(item.custody.kind==='active')row=snapshot.activeRow(id);
  else{const segment=snapshot.segment(item.custody.segmentId);need(segment&&segment.id===item.custody.segmentId,'History segment is absent');row=projection(segment).rows[item.custody.ordinal];}
  need(row&&row.id===id&&row.revision===item.revision&&hash(canonical(row))===item.rowSha256,'Indexed row differs from actual custody');return row;
 }
 function original(requestId:string):local.OriginalRequest|undefined{
  const entry=snapshot.requestIndex(requestId);if(!entry)return undefined;const item=exact(historyRequestIndexSchema,entry);need(item.requestId===requestId,'Original index key changed');
  if(item.status!=='admitted')return undefined;
  const row=resolve(item.rowId),description=describeHistoryRow(row,index(row.id).custody,hash,index(row.id).mutation);
  // Admitted Close belongs to its ACK, not to the fence's reserved reference.
  const value=row.value as any;let request:any;
  if(item.kind==='start')request={kind:'start',command:value.command??value.request?.command};
  else if((item.kind==='stop')&&value.ownerStops)request={kind:'stop',command:value.ownerStops.find((s:any)=>s.command.requestId===requestId)?.command};
  else if(value.request)request=value.request;else request={kind:item.kind,command:value.command};
  const receipt=snapshot.receipt(requestId);need(receipt&&hash(canonical(receipt))===item.receiptSha256&&hash(canonical(request))===item.requestSha256,'Original full command or receipt changed');
  need(description.requests.some(r=>r.requestId===requestId&&r.status==='admitted'),'Original index has no row-owned admission');
  return {request,deviceId:item.owner,at:item.at,receipt};
 }
 function workerRow(operationId:string){const originalValue=original(operationId);need(originalValue?.request.kind==='start','Worker original missing');const locator=snapshot.requestIndex(operationId)!;
  const row=resolve(locator.rowId);need(['legacy-worker','adaptive-worker'].includes(rowKind(row)),'Expected worker original');return row;
 }
 function mutationRow(operationId:string){const entry=snapshot.requestIndex(operationId);need(entry&&['apply-learning','control'].includes(entry.kind),'Learning parent original missing');
  const row=resolve(entry.rowId);need(['learning','control'].includes(rowKind(row)),'Learning parent row missing');return row;
 }
 function validateWorker(row:Row){return rowKind(row)==='adaptive-worker'?adaptive.validateAdaptiveWorkerRow(row,hash,native):legacy.validateLegacyWorkerRow(row,hash,native);}
 function actualReceipt(id:string,expected?:Receipt){const value=snapshot.receipt(id);need(value&&(!expected||same(value,expected)),'Original receipt missing or changed');return value;}
 function source(source:AdaptiveSource,at:number){
  const checkpoint=source.preferences.latestMutation;if(checkpoint)actualReceipt(checkpoint.requestId,checkpoint);
  const parent=source.learningHead?mutationRow(source.learningHead).value as any:undefined;
  if(Object.prototype.hasOwnProperty.call(source,'controlProof')){
   need(source.learningHead&&source.controlProof,'Control proof has no learning head');
   const base=resolveControlBaseline({mutations:{get:(key:string)=>key===source.learningHead?parent:undefined} as any},source.context.deviceId,source.context.epoch,source.learningHead,hash);
   const spanId=historySpanId(source.context.deviceId,source.context.epoch,source.controlProof,hash),span=exact(historyControlSpanSchema,snapshot.controlSpan(spanId));
   need(span.id===spanId&&span.owner===source.context.deviceId&&span.epoch===source.context.epoch&&same(span.proof,source.controlProof),'Control span descriptor changed');
   controlSteps=add(controlSteps,source.controlProof.toRevision-source.controlProof.fromRevision,limits.controlSteps,'Control proof work bound exceeded');
   const result=foldControlProofIndexed(base,source.controlProof,{receipt:id=>snapshot.receipt(id),revision:(epoch,revision)=>{
    const entry=exact(historyControlRevisionSchema,snapshot.controlRevision(historyRevisionKey(epoch,revision,hash)));
    need(entry.epoch===epoch&&entry.revision===revision&&entry.key===historyRevisionKey(epoch,revision,hash),'Control revision index changed');
    const receipt=actualReceipt(entry.requestId);need(hash(canonical(receipt))===entry.receiptSha256,'Indexed control receipt changed');return receipt;
   }},hash,stream,r=>actualReceipt(r.requestId,r));adaptive.validateAdaptiveControlProjection(source,at,base,result);
  }else adaptive.validateAdaptiveSourceParent(source,at,parent);
 }
 function requests(row:Row,description:ReturnType<typeof describeHistoryRow>){const value=row.value as any;
  for(const candidate of description.requests){
   if(candidate.status==='pending-close'){
    const admitted=snapshot.requestIndex(candidate.requestId);
    if(admitted?.status==='admitted'){
     const ack=original(candidate.requestId);need(ack&&ack.deviceId===candidate.owner&&same(ack.request,{kind:'close',command:value.close}),'Pending Close identity used by different work');
     const ackIndex=index(admitted.rowId);if(description.row.custody.kind==='segment')need(ackIndex.custody.kind==='segment'&&ackIndex.custody.segmentId===description.row.custody.segmentId,'Historical fence and ACK custody split');
     continue;
    }
    need(description.row.custody.kind==='active','Pending Close may not enter historical custody');need(!snapshot.receipt(candidate.requestId),'Pending Close collides with an actual receipt');
   }
   need(same(snapshot.requestIndex(candidate.requestId),candidate),'Row/request ownership is missing or changed');requestCount++;
  }
  for(const expected of description.expected){actualReceipt(expected.requestId,expected);if(description.row.custody.kind==='active')activeBytes+=size(expected);}
 }
 function validate(row:Row,custody:HistoryCustody){const item=index(row.id),kind=rowKind(row),value=row.value as any;
  const description=describeHistoryRow(row,custody,hash,item.mutation);need(same(item,description.row),'Row catalogue does not exactly describe actual row');
  if(kind==='legacy-worker'||kind==='adaptive-worker'){
   const checked=validateWorker(row);if(!terminal(checked)){unresolved++;need(custody.kind==='active','Unresolved worker cannot be historical');}
   if(kind==='legacy-worker'&&value.capture.kind==='classify'){
    const reviewRow=resolve(legacy.feedReviewPrefix+value.capture.review.reviewRequestId),target=workerRow((reviewRow.value as any).command.operationId);
    const review=legacy.validateLegacyReviewRow(reviewRow,legacy.validateLegacyWorkerRow(target,hash,native),hash);legacy.validateLegacyClassificationBasis(value,review);
   }
   if(kind==='adaptive-worker'){
    if(value.capture.kind==='interpret'){const receipt=value.capture.source.preferences.latestMutation;if(receipt)actualReceipt(receipt.requestId,receipt);}else source(value.capture.source,value.createdAt);
    if(value.capture.basis?.kind==='accepted'){
     const reviewRow=resolve(adaptive.adaptiveReviewPrefix+value.capture.basis.approval.reviewRequestId),target=workerRow((reviewRow.value as any).command.operationId);
     adaptive.validateAdaptiveAcceptedBasis(value,adaptive.validateAdaptiveReviewRow(reviewRow,adaptive.validateAdaptiveWorkerRow(target,hash,native),hash));
    }
   }
   if(custody.kind==='active')activeWorkers.set(value.id,checked);
  }else if(kind==='legacy-review')legacy.validateLegacyReviewRow(row,legacy.validateLegacyWorkerRow(workerRow(value.command.operationId),hash,native),hash);
  else if(kind==='adaptive-review'){
   adaptive.validateAdaptiveReviewRow(row,adaptive.validateAdaptiveWorkerRow(workerRow(value.command.operationId),hash,native),hash);
   const receipt=value.preferences.latestMutation;if(receipt)actualReceipt(receipt.requestId,receipt);
  }else if(kind==='learning'||kind==='control'){
   adaptive.validateAdaptiveMutationRow(row,kind==='learning'?adaptive.validateAdaptiveWorkerRow(workerRow(value.command.operationId),hash,native):undefined,snapshot.receipt(value.id),hash);
   source(value.before,value.at);need(value.after.revision===value.before.context.learning.revision+1,'Learning revision skipped');
   need(item.mutation,'Mutation catalogue missing');mutationCount++;
   const parentId=value.before.learningHead??null;need(item.mutation.parentId===parentId,'Mutation parent changed');
   const childKey=historyParentKey(value.deviceId,value.command.epoch,parentId,hash),child=exact(historyChildIndexSchema,snapshot.child(childKey));
   need(child.key===childKey&&child.rowId===row.id&&child.parentId===parentId&&child.owner===value.deviceId&&child.epoch===value.command.epoch,'Learning graph forked or child index changed');
   if(parentId){const parentRow=mutationRow(parentId),parent=index(parentRow.id);need(parent.mutation&&parent.owner===item.owner&&parent.epoch===item.epoch&&
    item.mutation.rootId===parent.mutation.rootId&&item.mutation.depth===parent.mutation.depth+1,'Mutation cycle/root/depth changed');}
   else need(item.mutation.depth===1&&item.mutation.rootId===value.id,'Mutation root changed');
   need(item.mutation.depth<=limits.logicalRows,'Mutation depth exceeds finite input bound');
   if(!snapshot.child(historyParentKey(value.deviceId,value.command.epoch,value.id,hash))){leafCount++;const key=historyOwnerKey(value.deviceId,value.command.epoch,hash),head=exact(historyHeadIndexSchema,snapshot.head(key));
    need(head.key===key&&head.rowId===row.id&&head.owner===value.deviceId&&head.epoch===value.command.epoch,'Current mutation leaf/head changed');}
  }else{
   const record=local.validateFeedLocalRow(row,snapshot.receipt(value.id),hash);
   if(record.kind==='stop-no-effect-terminal'){
    local.validateFeedLocalStop(record,validateWorker(workerRow(record.target.id)),hash);localStops++;
    const key=historyStopKey(record.target.id,row.id,hash),entry=exact(historyStopIndexSchema,snapshot.stopIndex(key));
    need(entry.key===key&&entry.rowId===row.id&&entry.targetId===record.target.id,'Terminal Stop index changed');
   }
   if(record.kind==='close-ack'){const originalValue=original(record.request.command.original.requestId),targetIndex=snapshot.requestIndex(record.request.command.original.requestId);
    const target=targetIndex?resolve(targetIndex.rowId):undefined;
    local.validateFeedLocalClose(record,originalValue,target&&rowKind(target)==='local'?target.value as local.FeedLocalRecord:undefined,hash);}
   if(custody.kind==='active')activeLocals.set(record.id,record);
  }
  need((kind==='learning'||kind==='control')===!!item.mutation,'Unexpected mutation metadata');requests(row,description);
  selected?.row(row,description);
  if(custody.kind==='active'){activeRows.push(row);activeBytes+=size(row.value);need(activeRows.length<=feedProtocolLimits.records&&activeBytes<=feedProtocolLimits.bytes,'Active Feed storage bound exceeded');}
 }
 // Actual custody -> exact index. Duplicate occurrences cannot share a locator.
 for(const row of sorted(snapshot.activeRows(),r=>r.id)){need(same(snapshot.activeRow(row.id),row),'Active inventory/read mismatch');rowCount=add(rowCount,1,limits.logicalRows,'Logical row bound exceeded');
  decodedBytes=add(decodedBytes,size(row),limits.decodedBytes,'Logical decoded byte bound exceeded');validate(row,{kind:'active'});}
 for(const segment of sorted(snapshot.segments(),s=>s.id)){need(same(snapshot.segment(segment.id),segment),'Segment inventory/read mismatch');const decoded=projection(segment);
  for(let ordinal=0;ordinal<decoded.rows.length;ordinal++){const row=decoded.rows[ordinal]!;rowCount=add(rowCount,1,limits.logicalRows,'Logical row bound exceeded');decodedBytes=add(decodedBytes,size(row),limits.decodedBytes,'Logical decoded byte bound exceeded');validate(row,{kind:'segment',segmentId:segment.id,ordinal});}}
 need(unresolved<=1,'More than one unresolved Feed original');
 let indexedRows=0,indexedRequests=0,children=0,heads=0;
 for(const raw of sorted(snapshot.rowIndexes(),r=>r.id)){const item=exact(historyRowIndexSchema,raw);need(same(snapshot.rowIndex(item.id),item),'Row index inventory/read mismatch');resolve(item.id);indexedRows++;
  indexBytes=add(indexBytes,size(item),limits.indexBytes,'History index byte bound exceeded');}
 need(indexedRows===rowCount,'Orphan or omitted row catalogue');
 for(const raw of sorted(snapshot.requestIndexes(),r=>r.requestId)){const entry=exact(historyRequestIndexSchema,raw);need(same(snapshot.requestIndex(entry.requestId),entry),'Request index inventory/read mismatch');
  const row=resolve(entry.rowId),description=describeHistoryRow(row,index(row.id).custody,hash,index(row.id).mutation);
  need(description.requests.some(r=>same(r,entry)),'Request catalogue has no exact owning row');indexedRequests++;indexBytes=add(indexBytes,size(entry),limits.indexBytes,'History index byte bound exceeded');selected?.request(entry);}
 need(indexedRequests===requestCount,'Orphan or omitted request catalogue');
 for(const raw of sorted(snapshot.children(),r=>r.key)){const child=exact(historyChildIndexSchema,raw),row=resolve(child.rowId),item=index(row.id),value=row.value as any;
  need(item.mutation&&child.key===historyParentKey(item.owner,item.epoch,item.mutation.parentId,hash)&&same(snapshot.child(child.key),child)&&child.parentId===value.before.learningHead&&child.owner===item.owner&&child.epoch===item.epoch,'Orphan mutation child index');children++;
  indexBytes=add(indexBytes,size(child),limits.indexBytes,'History index byte bound exceeded');}
 need(children===mutationCount,'Mutation child closure changed');
 for(const raw of sorted(snapshot.heads(),r=>r.key)){const head=exact(historyHeadIndexSchema,raw),row=resolve(head.rowId),item=index(row.id),value=row.value as any;
  need(item.mutation&&head.key===historyOwnerKey(item.owner,item.epoch,hash)&&same(snapshot.head(head.key),head)&&head.owner===item.owner&&head.epoch===item.epoch&&
   !snapshot.child(historyParentKey(item.owner,item.epoch,value.id,hash)),'Orphan or non-leaf current head');heads++;indexBytes=add(indexBytes,size(head),limits.indexBytes,'History index byte bound exceeded');}
 need(heads===leafCount,'Current head closure changed');
 // All separate Stops have a bidirectional indexed edge. A full history scan
 // per worker is unnecessary; malformed range queries still refuse below.
 for(const entry of sorted(snapshot.requestIndexes(),r=>r.requestId))if(entry.kind==='start'&&entry.status==='admitted'){
  const row=resolve(entry.rowId);if(!['legacy-worker','adaptive-worker'].includes(rowKind(row)))continue;
  let stops=(row.value as any).ownerStops.length;
  for(const raw of sorted(snapshot.terminalStops((row.value as any).id),r=>r.key)){const stop=exact(historyStopIndexSchema,raw);
   need(stop.targetId===(row.value as any).id&&same(snapshot.stopIndex(stop.key),stop)&&stop.key===historyStopKey(stop.targetId,stop.rowId,hash),'Terminal Stop range changed');
   const target=resolve(stop.rowId);need(rowKind(target)==='local'&&(target.value as any).kind==='stop-no-effect-terminal'&&(target.value as any).target.id===stop.targetId,'Orphan terminal Stop index');stops++;
  }
  need(stops<=feedProtocolLimits.maxOwnerStops,'Owner Stop bound exceeded');
 }
 let stopEdges=0;
 for(const raw of sorted(snapshot.stopIndexes(),r=>r.key)){const stop=exact(historyStopIndexSchema,raw),row=resolve(stop.rowId),value=row.value as any;
  need(stop.key===historyStopKey(stop.targetId,stop.rowId,hash)&&same(snapshot.stopIndex(stop.key),stop)&&rowKind(row)==='local'&&value.kind==='stop-no-effect-terminal'&&value.target.id===stop.targetId,'Orphan terminal Stop catalogue');
  let included=0;for(const found of sorted(snapshot.terminalStops(stop.targetId),r=>r.key))if(same(found,stop))included++;
  need(included===1,'Terminal Stop range omitted an actual edge');stopEdges++;indexBytes=add(indexBytes,size(stop),limits.indexBytes,'History index byte bound exceeded');}
 need(stopEdges===localStops,'Terminal Stop edge closure changed');
 for(const raw of sorted(snapshot.controlSpans(),r=>r.id)){const span=exact(historyControlSpanSchema,raw);need(span.id===historySpanId(span.owner,span.epoch,span.proof,hash)&&same(snapshot.controlSpan(span.id),span),'Control span index changed');
  const row=resolve(span.firstOwnerRowId),entry=index(row.id);need(entry.owner===span.owner&&entry.epoch===span.epoch&&entry.edges.some(e=>e.kind==='control-span'&&e.spanId===span.id),'Orphan control span');
  indexBytes=add(indexBytes,size(span),limits.indexBytes,'History index byte bound exceeded');}
 for(const raw of sorted(snapshot.controlRevisions(),r=>r.key)){const entry=exact(historyControlRevisionSchema,raw),span=exact(historyControlSpanSchema,snapshot.controlSpan(entry.coveringSpan));
  need(entry.key===historyRevisionKey(entry.epoch,entry.revision,hash)&&same(snapshot.controlRevision(entry.key),entry)&&span.epoch===entry.epoch&&entry.revision>span.proof.fromRevision&&entry.revision<=span.proof.toRevision,'Orphan control revision');
  const receipt=actualReceipt(entry.requestId);need(hash(canonical(receipt))===entry.receiptSha256&&readSavedControlStep(receipt,entry.epoch,entry.revision-1,entry.revision,hash)?.revision===entry.revision,'Control revision receipt changed');
  indexBytes=add(indexBytes,size(entry),limits.indexBytes,'History index byte bound exceeded');}
 for(const receipt of sorted(snapshot.receipts(),r=>r.requestId)){need(same(snapshot.receipt(receipt.requestId),receipt),'Receipt inventory/read mismatch');receiptBytes=add(receiptBytes,size(receipt),limits.receiptBytes,'Receipt input bound exceeded');
  if(legacy.hasFeedSemanticReceipt(receipt.value)){const request=snapshot.requestIndex(receipt.requestId);need(request?.status==='admitted'&&request.receiptSha256===hash(canonical(receipt)),'Semantic receipt has no exact retained admission');
   const value=receipt.value as any;if(value.type==='feed-semantic-local')feedLocalAdmissionSchema.parse(value);else if(value.format===3)adaptiveAdmissionSchema.parse(value);}
  const raw=receipt.value as any;if(raw?.format===1&&raw.state==='saved'&&typeof raw.epoch==='string'&&Number.isSafeInteger(raw.revision)){
   const entry=snapshot.controlRevision(historyRevisionKey(raw.epoch,raw.revision,hash));
   if(entry&&readSavedControlStep(receipt,raw.epoch,raw.revision-1,raw.revision,hash))need(entry.requestId===receipt.requestId&&entry.receiptSha256===hash(canonical(receipt)),'Retained control revision forked');
  }
  selected?.receipt(receipt);
 }
 // Active-only admission accounting is separate from the complete logical
 // proof. No old whole-graph validator is called with a truncated ledger.
 for(const row of activeRows){const value=row.value as any;for(const requestId of describeHistoryRow(row,{kind:'active'},hash,index(row.id).mutation).row.requests){const saved=original(requestId);if(saved)activeOriginals.set(requestId,saved);}
  if(rowKind(row)==='local'&&value.kind==='closed-before-admission'){const ack=original(value.close.requestId);if(ack)activeOriginals.set(value.close.requestId,ack);}}
 const reserved=local.remainingLocalObligations({workers:activeWorkers,locals:activeLocals,originalRequests:activeOriginals} as local.FeedLocalGraph,hash);
 need(activeRows.length+reserved.rows<=feedProtocolLimits.records&&activeBytes+reserved.bytes<=feedProtocolLimits.bytes,'Active remaining-obligation capacity hold');
 need(snapshot.snapshotToken()===token,'Snapshot changed during complete history proof');
 return {kind:'complete-pure-history-proof' as const,qualification:'unqualified' as const,rowCount,requestCount,decodedBytes,indexBytes,receiptBytes,controlSteps,
  active:{rows:activeRows.length,bytes:activeBytes,reserved},historicalRows:rowCount-activeRows.length,mutationCount,heads,unresolved,
  ...(selected?{selectedOriginals:selected.finish()}:{})};
}
