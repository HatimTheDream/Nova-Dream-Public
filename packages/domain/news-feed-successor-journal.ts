import {z} from 'zod';
import {verifyAdaptiveRecords} from './news-feed-adaptive-graph.js';
import {feedWorkerReceipt as adaptiveWorkerReceipt} from './news-feed-adaptive-worker.js';
import {adaptiveWorkerBounds} from './news-feed-adaptive-capture.js';
import {canonical} from './contracts.js';
import {feedCloseOriginalSchema,feedRecoverableStartSchema,feedRecoverableStopSchema,feedLocalAdmissionSchema,
 feedProtocolLimits,type FeedProtocolRequest,type FeedCloseOriginal,type FeedLocalAdmission} from './news-feed-semantic-protocol.js';
import {verifyFeedSemanticRecords,feedReviewIntent,type SemanticRow,type SemanticReceipt} from './news-feed-semantic-journal.js';
import {feedWorkerIntent,feedStopIntent,feedWorkerReceipt,feedWorkerLimits,size,same} from './news-feed-worker.js';
import type {WorkerIdentity} from './worker.js';
import type {FeedReadGraph} from './news-feed-read-graph.js';

export const feedLocalPrefix='news:semantic-local:';
const terminal=(value:{state:string})=>['completed','failed','cancelled','withdrawn','rejected'].includes(value.state);
const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),instant=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const preparationObservationSchema=z.object({expectedRevision:instant,captureSha256:sha,modelInputSha256:sha,nativePolicySha256:sha,
 newStartReady:z.boolean()}).strict();
export type PreparationObservation=z.infer<typeof preparationObservationSchema>;
const common={format:z.literal(3),revision:z.literal(1),id:uuid,deviceId:z.string().min(1).max(200),epoch:uuid,at:instant,effect:z.literal('none')};
const start=z.object({kind:z.literal('start'),command:feedRecoverableStartSchema}).strict(),stop=z.object({kind:z.literal('stop'),command:feedRecoverableStopSchema}).strict();
export const feedLocalRecordSchema=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('closed-before-admission'),request:start,close:feedCloseOriginalSchema}).strict(),
 z.object({...common,kind:z.literal('refused-before-admission'),request:start,
  reason:z.enum(['legacy-unbound','invalid-time','expired','capture-changed','policy-changed','not-ready']),observation:preparationObservationSchema.optional()}).strict(),
 z.object({...common,kind:z.literal('stop-no-effect-terminal'),request:stop,target:z.object({id:uuid,originalSha256:sha,terminalSha256:sha}).strict()}).strict(),
 z.object({...common,kind:z.literal('close-ack'),request:z.object({kind:z.literal('close'),command:feedCloseOriginalSchema}).strict(),
  outcome:z.enum(['closed-before-admission','already-refused','already-admitted']),originalReceiptSha256:sha}).strict(),
]);
export type FeedLocalRecord=z.infer<typeof feedLocalRecordSchema>;
export const digest=(value:unknown,hash:(text:string)=>string)=>hash(canonical(value));
export function protocolIntent(request:any):unknown{
 switch(request.kind){
  case 'start':return feedWorkerIntent(request.command as Parameters<typeof feedWorkerIntent>[0]);
  case 'stop':return feedStopIntent(request.command);
  case 'accept':return feedReviewIntent(request.command);
  case 'apply-learning':return {type:'feed-semantic-learning',command:request.command};
  case 'control':return {type:'news.command',command:request.command};
  case 'close':return {type:'feed-semantic-close',command:request.command};
 }
}
export function localReceipt(value:FeedLocalRecord,hash:(text:string)=>string):FeedLocalAdmission{
 const common={type:'feed-semantic-local' as const,format:3 as const,id:value.id,epoch:value.epoch,recordSha256:digest(value,hash),requestSha256:digest(value.request,hash)};
 if(value.kind==='close-ack')return {...common,kind:value.kind,outcome:value.outcome,originalRequestId:value.request.command.original.requestId,
  originalRequestSha256:digest({kind:'start',command:value.request.command.original},hash),originalReceiptSha256:value.originalReceiptSha256};
 if(value.kind==='stop-no-effect-terminal')return {...common,kind:value.kind,targetId:value.target.id,terminalSha256:value.target.terminalSha256};
 return {...common,kind:value.kind};
}
export function localOriginalReceipt(value:FeedLocalRecord,hash:(text:string)=>string):SemanticReceipt{
 return {requestId:value.id,deviceId:value.deviceId,digest:digest(protocolIntent(value.request),hash),value:localReceipt(value,hash)};
}
export function knownStartRefusal(command:Extract<FeedProtocolRequest,{kind:'start'}>['command'],at:number,current?:PreparationObservation){
 if(!('format' in command))return 'legacy-unbound' as const;
 const expectation=command.expectation;
 if(expectation.deadlineAt-expectation.preparedAt!==feedProtocolLimits.deadlineMs||expectation.preparedAt>at)return 'invalid-time' as const;
 if(at>=expectation.deadlineAt||at-expectation.preparedAt>feedProtocolLimits.preparationAgeMs)return 'expired' as const;
 if(!current)return undefined;
 if(current.expectedRevision!==command.expectedRevision||current.captureSha256!==expectation.captureSha256||current.modelInputSha256!==expectation.modelInputSha256)
  return 'capture-changed' as const;
 if(current.nativePolicySha256!==expectation.nativePolicySha256)return 'policy-changed' as const;
 if(!current.newStartReady)return 'not-ready' as const;
 return undefined;
}
const need=(yes:unknown,message:string)=>{if(!yes)throw new Error(message);};
export type Ledger={schema:number;rows:SemanticRow[];receipts:SemanticReceipt[]};
export type NativeIdentity=(identity:WorkerIdentity)=>{runId:string;sessionKey:string};
export type OriginalRequest={request:any;deviceId:string;at:number;receipt:SemanticReceipt};
type PendingClose={request:Extract<FeedProtocolRequest,{kind:'close'}>;deviceId:string;at:number};
export type FeedLocalGraph=ReturnType<typeof verifyAdaptiveRecords>&{locals:Map<string,FeedLocalRecord>;originalRequests:Map<string,OriginalRequest>;
 reservedCloseCommands:Map<string,PendingClose>;receipts:Map<string,SemanticReceipt>;bytes:number;rowCount:number};
export function validateFeedLocalRow(row:SemanticRow,receipt:SemanticReceipt|undefined,hash:(text:string)=>string){
 const record=feedLocalRecordSchema.parse(row.value);
 need(same(record,row.value)&&row.id===feedLocalPrefix+record.id&&row.revision===1&&record.id===record.request.command.requestId&&record.epoch===record.request.command.epoch,
  'Local original identity changed');need(size(record)<=feedProtocolLimits.localRecordBytes,'Local original record bound exceeded');
 const expected=localOriginalReceipt(record,hash);need(size(expected)<=feedProtocolLimits.localReceiptBytes,'Local receipt bound exceeded');
 need(same(receipt,expected),'Local original receipt missing or changed');
 if(record.kind==='closed-before-admission')need(record.close.epoch===record.epoch&&same(record.close.original,record.request.command),'Close fence original changed');
 if(record.kind==='refused-before-admission')need(knownStartRefusal(record.request.command,record.at,record.observation)===record.reason,'Local refusal has no exact observation basis');
 return record;
}
export function validateFeedLocalStop(record:Extract<FeedLocalRecord,{kind:'stop-no-effect-terminal'}>,worker:any,hash:(text:string)=>string){
 need(worker&&terminal(worker)&&worker.terminal,'Local Stop needs a verified terminal original');
 need(record.request.command.id===worker.id&&record.epoch===worker.command.epoch&&record.deviceId===worker.deviceId&&record.at>=worker.terminal.at,
  'Local Stop has a foreign terminal original');
 need(record.target.originalSha256===(worker.format===3?adaptiveWorkerReceipt(worker,hash):feedWorkerReceipt(worker,hash)).originalSha256&&record.target.terminalSha256===digest(worker.terminal,hash),
  'Local Stop terminal proof changed');
}
export function validateFeedLocalClose(record:Extract<FeedLocalRecord,{kind:'close-ack'}>,original:OriginalRequest|undefined,target:FeedLocalRecord|undefined,hash:(text:string)=>string){
 need(original&&original.deviceId===record.deviceId&&original.request.kind==='start'&&same(original.request.command,record.request.command.original)&&original.at<=record.at,
  'Close acknowledgement original missing or foreign');
 need(record.originalReceiptSha256===digest(original!.receipt,hash),'Close acknowledgement receipt changed');
 const outcome=target?.kind==='closed-before-admission'?'closed-before-admission':target?.kind==='refused-before-admission'?'already-refused':'already-admitted';
 need(record.outcome===outcome,'Close acknowledgement invented its effect');
}
export function verifyFeedLocalGraph(ledger:Ledger,hash:(text:string)=>string,nativeIdentity:NativeIdentity):FeedLocalGraph{
 const localRows=ledger.rows.filter(row=>row.id.startsWith(feedLocalPrefix));
 const localReceipts=ledger.receipts.filter(row=>(row.value as {type?:string})?.type==='feed-semantic-local');
 const legacy=verifyAdaptiveRecords(ledger.schema,ledger.rows.filter(row=>!row.id.startsWith(feedLocalPrefix)),
  ledger.receipts.filter(row=>(row.value as {type?:string})?.type!=='feed-semantic-local'),hash,nativeIdentity);
 if(localRows.length||localReceipts.length)need(ledger.schema>=60,'Feed local authority needs the reviewed future schema');
 const allKeys=new Set(ledger.rows.map(row=>row.id));need(allKeys.size===ledger.rows.length,'Feed row key duplicated');
 const receipts=new Map(ledger.receipts.map(row=>[row.requestId,row]));need(receipts.size===ledger.receipts.length,'Original receipt identity duplicated');
 const locals=new Map<string,FeedLocalRecord>();
 for(const row of localRows){const record=validateFeedLocalRow(row,receipts.get((row.value as any)?.id),hash);
  need(!legacy.workers.has(record.id)&&!legacy.reviews.has(record.id),'Original reused across legacy/local records');
  locals.set(record.id,record);
 }
 for(const receipt of localReceipts){feedLocalAdmissionSchema.parse(receipt.value);need(locals.has(receipt.requestId),'Local receipt has no original record');}
 const originalRequests=new Map<string,OriginalRequest>();
 const add=(request:any,deviceId:string,at:number)=>{
  need(!originalRequests.has(request.command.requestId),'Original command identity appears more than once');
  const receipt=receipts.get(request.command.requestId);need(receipt,'Missing original receipt');
  originalRequests.set(request.command.requestId,{request,deviceId,at,receipt:receipt!});
 };
 for(const worker of legacy.workers.values()){
  add({kind:'start',command:worker.command},worker.deviceId,worker.createdAt);
  for(const owner of worker.ownerStops)add({kind:'stop',command:owner.command},owner.deviceId,owner.at);
 }
 for(const review of legacy.reviews.values())add({kind:'accept',command:review.record.command},review.record.deviceId,review.record.at);
 for(const record of legacy.learning.values())add({kind:'apply-learning',command:record.command},record.deviceId,record.at);
 for(const record of legacy.controls.values())add({kind:'control',command:record.command},record.deviceId,record.at);
 for(const record of locals.values())add(record.request,record.deviceId,record.at);
 const reservedCloseCommands=new Map<string,PendingClose>();
 for(const record of locals.values())if(record.kind==='closed-before-admission'){
  const request={kind:'close' as const,command:record.close},admitted=originalRequests.get(record.close.requestId);
  need(!reservedCloseCommands.has(record.close.requestId),'Pending close identity duplicated');
  if(admitted)need(admitted.deviceId===record.deviceId&&same(admitted.request,request),'Pending close identity reused for different work');
  else {need(!receipts.has(record.close.requestId),'Pending close receipt belongs to unrelated retained work');
   reservedCloseCommands.set(record.close.requestId,{request,deviceId:record.deviceId,at:record.at});}
 }
 const stopCount=new Map<string,number>();
 for(const record of locals.values()){
  if(record.kind==='stop-no-effect-terminal'){
   const worker=legacy.workers.get(record.target.id);validateFeedLocalStop(record,worker,hash);
   stopCount.set(worker!.id,(stopCount.get(worker!.id)??worker!.ownerStops.length)+1);
  }
  if(record.kind==='close-ack'){
   const original=originalRequests.get(record.request.command.original.requestId);
   validateFeedLocalClose(record,original,original?locals.get(original.request.command.requestId):undefined,hash);
  }
 }
 for(const count of stopCount.values())need(count<=feedProtocolLimits.maxOwnerStops,'Owner Stop bound exceeded');
 const relevantRows=ledger.rows.filter(row=>row.id.startsWith('news:semantic-'));
 const relevantReceipts=ledger.receipts.filter(row=>legacy.controls.has(row.requestId)||typeof (row.value as {type?:unknown})?.type==='string'&&(row.value as {type:string}).type.startsWith('feed-semantic-'));
 const bytes=relevantRows.reduce((n,row)=>n+size(row.value),0)+relevantReceipts.reduce((n,row)=>n+size(row),0);
 need(relevantRows.length<=feedProtocolLimits.records&&bytes<=feedProtocolLimits.bytes,'Feed storage bound exceeded');
 const graph={...legacy,locals,originalRequests,reservedCloseCommands,receipts,bytes,rowCount:relevantRows.length};
 const pending=pendingCloseObligations(graph,hash);
 need(graph.bytes+pending.bytes<=feedProtocolLimits.bytes&&graph.rowCount+pending.rows<=feedProtocolLimits.records,'Retained close acknowledgement reservation exceeds capacity');
 requireLocalCapacity(graph,hash);
 return graph;
}
export function closeAcknowledgement(original:SemanticReceipt,command:FeedCloseOriginal,deviceId:string,at:number,graph:Pick<FeedReadGraph,'locals'>,hash:(text:string)=>string):FeedLocalRecord{
 const local=graph.locals.get(command.original.requestId);
 return {format:3,revision:1,id:command.requestId,deviceId,epoch:command.epoch,at,effect:'none',kind:'close-ack',request:{kind:'close',command},
  outcome:local?.kind==='closed-before-admission'?'closed-before-admission':local?.kind==='refused-before-admission'?'already-refused':'already-admitted',originalReceiptSha256:digest(original,hash)};
}
/** New local writes preserve existing unresolved worker headroom. Optional
 * future terminal actions need their own fresh capacity-checked admission.
 * A fence reserves its exact next
 * close acknowledgement even across a crash between the two transactions. */
function pendingCloseObligations(graph:Pick<FeedLocalGraph,'locals'|'originalRequests'>,hash:(text:string)=>string){
 let bytes=0,rows=0;
 for(const record of graph.locals.values())if(record.kind==='closed-before-admission'&&!graph.originalRequests.has(record.close.requestId)){
  const next=closeAcknowledgement(localOriginalReceipt(record,hash),record.close,record.deviceId,Number.MAX_SAFE_INTEGER,graph,hash);
  bytes+=size(next)+size(localOriginalReceipt(next,hash));rows++;
 }
 return {bytes,rows};
}
export function remainingLocalObligations(graph:FeedLocalGraph,hash:(text:string)=>string){
 let {bytes,rows}=pendingCloseObligations(graph,hash);
 for(const worker of graph.workers.values()){
  if(worker.format===3){
   if(terminal(worker))continue;
   const localStops=[...graph.locals.values()].filter(row=>row.kind==='stop-no-effect-terminal'&&row.target.id===worker.id).length;
   const remaining=Math.max(0,16-worker.ownerStops.length-localStops),hasClose=[...graph.locals.values()].some(row=>row.kind==='close-ack'&&row.request.command.original.requestId===worker.id);
   bytes+=(!terminal(worker)?adaptiveWorkerBounds.terminalGrowthBytes:0)+remaining*3072+(hasClose?0:8192);rows+=remaining+(hasClose?0:1);continue;
  }
  if(terminal(worker))continue;
  const remaining=Math.max(0,feedProtocolLimits.maxOwnerStops-worker.ownerStops.length);
  bytes+=feedWorkerLimits.reservedResultBytes+remaining*(feedProtocolLimits.localRecordBytes+feedProtocolLimits.localReceiptBytes);
  rows+=remaining;
 }
 return {bytes,rows};
}
export function requireLocalCapacity(graph:FeedLocalGraph,hash:(text:string)=>string){
 const reserved=remainingLocalObligations(graph,hash);
 need(graph.bytes+reserved.bytes<=feedProtocolLimits.bytes&&graph.rowCount+reserved.rows<=feedProtocolLimits.records,'Feed remaining-obligation capacity hold');
 return {...reserved,totalBytes:graph.bytes+reserved.bytes,totalRows:graph.rowCount+reserved.rows};
}
