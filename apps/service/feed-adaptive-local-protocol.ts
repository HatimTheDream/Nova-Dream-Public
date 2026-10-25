import {z} from 'zod';
import {adaptiveReviewCommandSchema,adaptiveApplyCommandSchema} from '../../packages/domain/news-feed-adaptive-commands.js';
import {feedCommandSchema} from '../../packages/domain/news-feed.js';
import {feedWorkerReceipt as adaptiveWorkerReceipt} from '../../packages/domain/news-feed-adaptive-worker.js';
import type {Store} from './store.js';
import type {FeedReadGraph} from '../../packages/domain/news-feed-read-graph.js';
import {feedProtocolRequestSchema as legacyProtocolRequestSchema,feedCloseOriginalSchema,feedRecoverableStopSchema,feedProtocolLimits,feedStartPreparationSchema,feedStartV3Schema,
 type FeedProtocolRequest,type FeedStartPreparation,type FeedStartV3} from '../../packages/domain/news-feed-semantic-protocol.js';
import {protocolIntent,localReceipt,feedLocalPrefix,knownStartRefusal,preparationObservationSchema,
 closeAcknowledgement,digest,type Ledger,type NativeIdentity,type FeedLocalRecord,type PreparationObservation} from '../../packages/domain/news-feed-successor-journal.js';
import {same,size,feedWorkerReceipt} from '../../packages/domain/news-feed-worker.js';

const feedProtocolRequestSchema=z.union([legacyProtocolRequestSchema,z.object({kind:z.literal('accept'),command:adaptiveReviewCommandSchema}).strict(),z.object({kind:z.literal('apply-learning'),command:adaptiveApplyCommandSchema}).strict(),z.object({kind:z.literal('control'),command:feedCommandSchema}).strict()]);
type LocalRequest=z.infer<typeof feedProtocolRequestSchema>;
export type FeedAdaptiveProtocolReadback={state:'unknown';request:LocalRequest}|{state:'confirmed';request:LocalRequest;admission:unknown;historical:boolean};
type FeedProtocolReadback=FeedAdaptiveProtocolReadback;
const terminal=(value:{state:string})=>['completed','failed','cancelled','withdrawn','rejected'].includes(value.state);
type LocalStore=Pick<Store,'epoch'|'recoveryEffectsPaused'|'assertUpdateAdmission'|'internalAdmitFeed'|'internalWithFeedReadGraph'>;
export type FeedLocalCaller={deviceId:string;epoch:string;current:()=>{deviceId:string;epoch:string;read:boolean;write:boolean}};
/** Retained constructor type for existing callers. This local protocol now
 * binds complete passive reads and protected derivation through its Store. */
export type FeedLedgerReader=()=>Ledger;
class EligibleUnadmitted extends Error{}
class NeedsOriginalWorker extends Error{}
const uuid=z.string().uuid();
export class FeedAdaptiveLocalProtocol{
 constructor(private store:LocalStore,_ledger:FeedLedgerReader,private hash:(text:string)=>string,_nativeIdentity:NativeIdentity,
  private now:()=>number=Date.now){}
 private captureCaller(caller:FeedLocalCaller):FeedLocalCaller{
  const deviceId=z.string().min(1).max(200).parse(caller.deviceId),epoch=uuid.parse(caller.epoch),current=caller.current;
  return Object.freeze({deviceId,epoch,current});
 }
 private authority(caller:FeedLocalCaller,write=false){
  const current=caller.current();
  if(!current.read||write&&!current.write||current.deviceId!==caller.deviceId||current.epoch!==caller.epoch||current.epoch!==this.store.epoch)
   throw new Error('Current Feed caller authority changed');
  return {deviceId:caller.deviceId,epoch:caller.epoch};
 }
 private mutation(caller:FeedLocalCaller,epoch:string){
  this.authority(caller,true);if(epoch!==this.store.epoch)throw new Error('Historical original is read-only');
  this.store.assertUpdateAdmission();if(this.store.recoveryEffectsPaused)throw new Error('Feed local admission is recovery-held');
 }
 /** Passive preparation: the trusted port must derive all hashes from one
  * complete current capture, including basis/story and native policy. Hashes
  * supplied by an HTTP client are not a preparation port. No record is admitted. */
 prepareStart(caller:FeedLocalCaller,raw:unknown,capture:(descriptor:FeedStartPreparation,at:number)=>PreparationObservation):FeedStartV3{
  caller=this.captureCaller(caller);this.authority(caller,true);const descriptor=feedStartPreparationSchema.parse(raw);
  if(descriptor.epoch!==this.store.epoch)throw new Error('Historical original is read-only');
  return this.store.internalWithFeedReadGraph(graph=>{const capacity={totalRows:graph.active.rows+graph.active.reserved.rows,totalBytes:graph.active.bytes+graph.active.reserved.bytes};
   if(graph.receipts.has(descriptor.requestId)||graph.reservedCloseCommands.has(descriptor.requestId))throw new Error('Original already exists; read its exact retained command');
   if(capacity.totalBytes+2*(feedProtocolLimits.localRecordBytes+feedProtocolLimits.localReceiptBytes)>feedProtocolLimits.bytes||
    capacity.totalRows+2>feedProtocolLimits.records)throw new Error('Prepared original has no local close/refusal capacity');
   const at=this.now(),observation=preparationObservationSchema.parse(capture(descriptor,at));
   if(!observation.newStartReady)throw new Error('New Feed work is not ready');
   const value=feedStartV3Schema.parse({...descriptor,expectedRevision:observation.expectedRevision,expectation:{preparedAt:at,
    deadlineAt:at+feedProtocolLimits.deadlineMs,contractVersion:'adaptive-2',captureSha256:observation.captureSha256,
    modelInputSha256:observation.modelInputSha256,nativePolicySha256:observation.nativePolicySha256}});
   this.authority(caller,true);if(this.now()>=value.expectation.deadlineAt)throw new Error('Passive preparation expired before it completed');return value;
  });
 }
 private project(caller:FeedLocalCaller,request:any,graph:Pick<FeedReadGraph,'originalRequests'|'receipts'|'reservedCloseCommands'>):FeedProtocolReadback{
  const original=graph.originalRequests.get(request.command.requestId);
  if(!original){if(graph.receipts.has(request.command.requestId))throw new Error('Original identity belongs to unrelated retained work');
   const pending=graph.reservedCloseCommands.get(request.command.requestId);
   if(pending&&(pending.deviceId!==caller.deviceId||!same(pending.request,request)))throw new Error('Pending close identity is reserved for its exact original');
   return {state:'unknown',request};}
  if(original.deviceId!==caller.deviceId||!same(original.request,request)||original.receipt.digest!==digest(protocolIntent(request),this.hash))
   throw new Error('Original Feed request identity changed');
  return {state:'confirmed',request,admission:original.receipt.value,historical:request.command.epoch!==this.store.epoch};
 }
 /** Passive original receipt lookup may include archived custody. The complete
  * lexical Store read grants no mutation or native authority. */
 readOriginal(caller:FeedLocalCaller,raw:unknown):FeedProtocolReadback{
  caller=this.captureCaller(caller);this.authority(caller);const request=feedProtocolRequestSchema.parse(raw);
  try{return this.store.internalWithFeedReadGraph(graph=>{const value=this.project(caller,request,graph);this.authority(caller);return value;});}
  finally{this.authority(caller);}
 }
 history(caller:FeedLocalCaller,raw:unknown={}){
  caller=this.captureCaller(caller);
  this.authority(caller);const input=z.object({after:uuid.optional(),limit:z.number().int().min(1).max(feedProtocolLimits.historyRows).default(feedProtocolLimits.historyRows)}).strict().parse(raw);
  try{return this.store.internalWithFeedReadGraph(graph=>{const originals=[...graph.originalRequests.values(),...graph.reservedCloseCommands.values()]
   .filter(value=>value.deviceId===caller.deviceId&&(!input.after||value.request.command.requestId>input.after))
   .sort((a,b)=>a.request.command.requestId<b.request.command.requestId?-1:a.request.command.requestId>b.request.command.requestId?1:0);
   const entries:unknown[]=[];let last:string|undefined;
   for(const original of originals){
    if(entries.length>=input.limit)break;
    const request=original.request,worker=request.kind==='start'?graph.workers.get(request.command.requestId):undefined;
    const local=graph.locals.get(request.command.requestId);
    const entry={request,...('receipt' in original?{admission:original.receipt.value}:{}),at:original.at,historical:request.command.epoch!==this.store.epoch,
     state:'receipt' in original?local?.kind??worker?.state??'admitted':'unadmitted-close'};
    const next={entries:[...entries,entry],next:request.command.requestId};
    if(size(next)>feedProtocolLimits.historyBytes)break;
    entries.push(entry);last=request.command.requestId;
   }
   if(originals.length&&!entries.length)throw new Error('Feed history entry exceeds response bound');
   const value={entries,...(entries.length<originals.length&&last?{next:last}:{})};this.authority(caller);return value;
  });}finally{this.authority(caller);}
 }
 /** Derivation data only. The Store plans all rows and the fixed original
  * receipt, reserves capacity, then commits and proves the actual inventory. */
 private save(caller:FeedLocalCaller,record:FeedLocalRecord){
  this.mutation(caller,record.epoch);
  return {writes:[{id:feedLocalPrefix+record.id,revision:record.revision,value:record}],receiptValue:localReceipt(record,this.hash)};
 }
 /** A valid result is explicitly unadmitted. Slice B must atomically repeat its
  * currentness/ownership checks while admitting the actual worker, rather than
  * treating this helper's return as dispatch authority. No raw request exists. */
 refuseKnownStart(caller:FeedLocalCaller,raw:unknown,observe:()=>PreparationObservation):FeedProtocolReadback|{state:'eligible-unadmitted';request:FeedProtocolRequest}{
  caller=this.captureCaller(caller);
  this.authority(caller);const request=feedProtocolRequestSchema.parse(raw);if(request.kind!=='start')throw new Error('Expected original start');
  const existing=this.readOriginal(caller,request);if(existing.state==='confirmed')return existing;
  this.mutation(caller,request.command.epoch);
  try{this.store.internalAdmitFeed(caller.deviceId,request.command,protocolIntent(request),_graph=>{
   this.mutation(caller,request.command.epoch);let at=this.now();
   const early=knownStartRefusal(request.command,at),observation=early?undefined:preparationObservationSchema.parse(observe());
   this.mutation(caller,request.command.epoch);at=this.now();
   const reason=knownStartRefusal(request.command,at,observation);if(!reason)throw new EligibleUnadmitted();
   return this.save(caller,{format:3,revision:1,id:request.command.requestId,deviceId:caller.deviceId,epoch:request.command.epoch,at,effect:'none',
    kind:'refused-before-admission',request,reason,...(observation?{observation}:{})});
  });}catch(error){if(error instanceof EligibleUnadmitted){this.authority(caller);return {state:'eligible-unadmitted',request};}throw error;}
  return this.readOriginal(caller,request);
 }
 closeOriginal(caller:FeedLocalCaller,raw:unknown):FeedProtocolReadback{
  caller=this.captureCaller(caller);
  this.authority(caller);const command=feedCloseOriginalSchema.parse(raw),request:FeedProtocolRequest={kind:'close',command};
  const existing=this.readOriginal(caller,request);if(existing.state==='confirmed')return existing;
  this.mutation(caller,command.epoch);
  const start:FeedProtocolRequest={kind:'start',command:command.original};
  // One complete original fence and receipt first. A crash before transaction2
  // leaves that complete fence; no promise or close acknowledgement is invented.
  this.store.internalAdmitFeed(caller.deviceId,command.original,protocolIntent(start),_graph=>{
   this.mutation(caller,command.epoch);
   return this.save(caller,{format:3,revision:1,id:command.original.requestId,deviceId:caller.deviceId,epoch:command.epoch,at:this.now(),effect:'none',
    kind:'closed-before-admission',request:start,close:command});
  });
  // The original may have won the first transaction. Only its verified receipt
  // determines whether this separate close acknowledgement did anything.
  this.store.internalAdmitFeed(caller.deviceId,command,protocolIntent(request),graph=>{
   this.mutation(caller,command.epoch);const original=graph.originalRequests.get(command.original.requestId);
   if(!original||original.deviceId!==caller.deviceId||!same(original.request,start))throw new Error('Close original identity changed');
   return this.save(caller,closeAcknowledgement(original.receipt,command,caller.deviceId,this.now(),graph,this.hash));
  });
  return this.readOriginal(caller,request);
 }
 terminalStop(caller:FeedLocalCaller,raw:unknown):FeedProtocolReadback|{state:'needs-original-worker';request:FeedProtocolRequest}{
  caller=this.captureCaller(caller);
  this.authority(caller);const command=feedRecoverableStopSchema.parse(raw),request:FeedProtocolRequest={kind:'stop',command};
  const existing=this.readOriginal(caller,request);if(existing.state==='confirmed')return existing;
  this.mutation(caller,command.epoch);
  try{this.store.internalAdmitFeed(caller.deviceId,command,protocolIntent(request),graph=>{
   this.mutation(caller,command.epoch);const worker=graph.workers.get(command.id);
   if(!worker)throw new Error('Original absent; Stop cannot fence an unadmitted start');
   if(worker.deviceId!==caller.deviceId||worker.command.epoch!==command.epoch)throw new Error('Foreign original Stop');
   if(!terminal(worker))throw new NeedsOriginalWorker();
   return this.save(caller,{format:3,revision:1,id:command.requestId,deviceId:caller.deviceId,epoch:command.epoch,at:this.now(),effect:'none',
    kind:'stop-no-effect-terminal',request,target:{id:worker.id,originalSha256:(worker.format===3?adaptiveWorkerReceipt(worker as any,this.hash):feedWorkerReceipt(worker as any,this.hash)).originalSha256,terminalSha256:digest(worker.terminal,this.hash)}});
  });}catch(error){if(error instanceof NeedsOriginalWorker){this.authority(caller);return {state:'needs-original-worker',request};}throw error;}
  return this.readOriginal(caller,request);
 }
}
