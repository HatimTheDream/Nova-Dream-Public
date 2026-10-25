import type {SemanticRow,SemanticReceipt} from './news-feed-semantic-journal.js';
import type {HistoryRowIndex,HistoryRequestIndex,HistoryCustody} from './news-feed-history-graph.js';

/** Fixed, untrusted lookup hints. They never filter the complete history proof. */
export type SelectedOriginalRequest=Readonly<{requestId:string;kind:'start'|'apply-learning'}>;
export type SelectedOriginalWork=Readonly<{
 checked:<T>(fn:()=>T)=>T;
 slots:(count:number,bytes:number)=>void;
 copy:<T>(value:T)=>T;
 hash:(value:unknown)=>string;
 /** Optional data-only reuse after this collector's independent row validation.
  * Only its service owner can authenticate the prior commitment and lifetime. */
 hashSelected?:(common:Common,kind:'worker'|'applied-learning',role:'terminal'|'source'|'before'|'after',value:unknown)=>string;
 fail:(error:unknown)=>never;
}>;
type Common=Readonly<{requestId:string;requestKind:'start'|'apply-learning';deviceId:string;epoch:string;
 rowId:string;rowRevision:number;custody:HistoryCustody;requestSha256:string;receiptSha256:string;
 protocolDigest:string;rowSha256:string}>;
export type SelectedWorkerOriginal=Common&Readonly<{kind:'worker';format:3;workerId:string;state:string;captureKind:string;
 terminalSha256?:string;sourceProofSha256?:string;learningCapture?:Readonly<{captureSha256:string;expectedLearningRevision:number}>}>;
export type SelectedLocalOriginal=Common&Readonly<{kind:'local-disposition';format:3;originalId:string;
 disposition:'closed-before-admission'|'refused-before-admission';localRequestSha256:string;localRecordSha256:string}>;
export type SelectedLearningOriginal=Common&Readonly<{kind:'applied-learning';applicationId:string;operationId:string;
 terminalSha256:string;captureSha256:string;expectedLearningRevision:number;beforeSha256:string;afterSha256:string}>;
export type SelectedOriginal=SelectedWorkerOriginal|SelectedLocalOriginal|SelectedLearningOriginal;
export type SelectedOriginalFact=Readonly<{requestId:string;expectedKind:'start'|'apply-learning';receiptPresent:boolean;
 requestIndex:'absent'|'pending-close'|'admitted';requestKind?:HistoryRequestIndex['kind'];original?:SelectedOriginal}>;
export type SelectedOriginalFacts=readonly SelectedOriginalFact[];
type Description={row:HistoryRowIndex;requests:HistoryRequestIndex[];expected:SemanticReceipt[]};
type Slot={selection:SelectedOriginalRequest;index?:Readonly<{status:HistoryRequestIndex['status'];kind:HistoryRequestIndex['kind']}>;
 receiptPresent:boolean;original?:SelectedOriginal};

/** Staging only. This pure collector cannot authenticate a Store source or issue
 * a capability. Complete graph closure AND the service's seal/token closure
 * must succeed before its returned data can become a reader-owned fact. */
export class SelectedOriginalCollector{
 private readonly slots:Slot[];
 private finished=false;
 constructor(selections:readonly SelectedOriginalRequest[],private readonly work:SelectedOriginalWork){
  this.slots=work.checked(()=>{
   this.need(Array.isArray(selections)&&selections.length<=2,'Selected original count exceeds two');
   work.slots(2+selections.length*3,128+selections.length*192);const slots:Slot[]=[];
   for(let i=0;i<selections.length;i++){
    const item=selections[i]!;
    this.need(item&&typeof item.requestId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.requestId)&&
     (i===0?item.kind==='start':item.kind==='apply-learning'),'Selected original hint is malformed');
    this.need(i===0||item.requestId!==selections[0]!.requestId,'Selected original IDs overlap');
    slots.push({selection:work.copy({requestId:item.requestId,kind:item.kind}),receiptPresent:false});
   }
   return slots;
  });
 }
 private need(value:unknown,message:string):asserts value{if(!value)this.work.fail(Error(message));}
 private active(){this.need(!this.finished,'Selected original collector has ended');}
 private hashSelected(common:Common,kind:'worker'|'applied-learning',role:'terminal'|'source'|'before'|'after',value:unknown){
  return this.work.hashSelected?this.work.hashSelected(common,kind,role,value):this.work.hash(value);
 }
 /** Invoked only after the maintained row validators and requests() joins. */
 row(row:SemanticRow,description:Description){return this.work.checked(()=>{
  this.active();this.work.slots(1,0);
  for(const slot of this.slots){
   let request:HistoryRequestIndex|undefined;
   for(const candidate of description.requests){this.work.slots(1,0);if(candidate.requestId===slot.selection.requestId){this.need(!request,'Duplicate selected row request');request=candidate;}}
   if(!request||request.status!=='admitted'||request.kind!==slot.selection.kind)continue;
   let receipt:SemanticReceipt|undefined;
   for(const candidate of description.expected){this.work.slots(1,0);if(candidate.requestId===request.requestId){this.need(!receipt,'Duplicate selected expected receipt');receipt=candidate;}}
   this.need(receipt&&request.receiptSha256,'Selected admitted request has no exact receipt');
   this.need(request.rowId===row.id&&description.row.id===row.id&&description.row.revision===row.revision&&
    receipt.requestId===request.requestId&&receipt.deviceId===request.owner,'Selected request/row/receipt identity changed');
   const value=row.value as any;
   // The owning row can contain Stops or Close requests. Exact descriptor kind
   // above, and the matching original command below, are both indispensable.
   const worker=request.kind==='start'&&description.row.kind==='adaptive-worker'&&value.format===3&&value.command.requestId===request.requestId;
   const local=request.kind==='start'&&description.row.kind==='local'&&value.format===3&&value.request.kind==='start'&&value.request.command.requestId===request.requestId&&
    (value.kind==='closed-before-admission'||value.kind==='refused-before-admission');
   const learning=request.kind==='apply-learning'&&description.row.kind==='learning'&&value.command.requestId===request.requestId;
   if(!worker&&!local&&!learning)continue;
   this.need(!slot.original,'Selected original staged more than once');
   // Fixed fields and wrapper/key references are reserved before construction;
   // copy() separately charges their complete JSON and immutable owned copy.
   this.work.slots(36,2304);
   const common:Common={requestId:request.requestId,requestKind:request.kind as Common['requestKind'],deviceId:request.owner,epoch:request.epoch,
    rowId:row.id,rowRevision:row.revision,custody:description.row.custody,requestSha256:request.requestSha256,
    receiptSha256:request.receiptSha256!,protocolDigest:receipt.digest,rowSha256:description.row.rowSha256};
   if(worker){
    const terminalSha256=value.terminal?this.hashSelected(common,'worker','terminal',value.terminal):undefined;
    this.work.slots(14,896);
    const learningCapture=value.capture.kind==='learn'?{captureSha256:value.capture.learning.captureSha256,expectedLearningRevision:value.capture.source.context.learning.revision}:undefined;
    // Internal producer-proof protocol, not the selector's adaptive digest.
    // The full maintained worker proof already validated this exact source.
    // Prepay the new conditional field wrapper even for an absent digest.
    this.work.slots(2,160);
    const sourceProofSha256=value.state==='completed'&&value.capture.kind==='learn'?this.hashSelected(common,'worker','source',value.capture.source):undefined;
    slot.original=this.work.copy({...common,kind:'worker' as const,format:3 as const,workerId:value.id,state:value.state,captureKind:value.capture.kind,
     ...(terminalSha256?{terminalSha256}:{}),...(sourceProofSha256?{sourceProofSha256}:{}),...(learningCapture?{learningCapture}:{})});
   }else if(local){
    this.work.slots(10,640);
    const admission=receipt.value as any;
    slot.original=this.work.copy({...common,kind:'local-disposition' as const,format:3 as const,originalId:value.id,disposition:value.kind,
     localRequestSha256:admission.requestSha256,localRecordSha256:admission.recordSha256});
   }else{
    const beforeSha256=this.hashSelected(common,'applied-learning','before',value.before),afterSha256=this.hashSelected(common,'applied-learning','after',value.after);this.work.slots(14,896);
    slot.original=this.work.copy({...common,kind:'applied-learning' as const,applicationId:value.id,operationId:value.command.operationId,
     terminalSha256:value.command.terminalSha256,captureSha256:value.command.captureSha256,expectedLearningRevision:value.command.expectedLearningRevision,
     beforeSha256,afterSha256});
   }
  }
 });}
 /** The COMPLETE request inventory, not a row's pending Close reference. */
 request(request:HistoryRequestIndex){return this.work.checked(()=>{
  this.active();this.work.slots(1,0);
  for(const slot of this.slots)if(slot.selection.requestId===request.requestId){
   this.need(!slot.index,'Selected request appears twice in complete inventory');this.work.slots(3,192);
   slot.index=this.work.copy({status:request.status,kind:request.kind});
  }
 });}
 /** Includes generic receipts, which must remain collisions rather than absent. */
 receipt(receipt:SemanticReceipt){return this.work.checked(()=>{
  this.active();this.work.slots(1,0);
  for(const slot of this.slots)if(slot.selection.requestId===receipt.requestId){this.need(!slot.receiptPresent,'Selected receipt appears twice');slot.receiptPresent=true;}
 });}
 finish():SelectedOriginalFacts{return this.work.checked(()=>{
  this.active();this.finished=true;this.work.slots(1,32);const facts:SelectedOriginalFact[]=[];
  for(const slot of this.slots){
   if(slot.original)this.need(slot.receiptPresent&&slot.index?.status==='admitted'&&slot.index.kind===slot.selection.kind,'Selected original inventory does not close');
   this.work.slots(9,576);facts.push(this.work.copy({requestId:slot.selection.requestId,expectedKind:slot.selection.kind,receiptPresent:slot.receiptPresent,
    requestIndex:slot.index?.status??'absent',...(slot.index?{requestKind:slot.index.kind}:{}),...(slot.original?{original:slot.original}:{})}));
  }
  return Object.freeze(facts);
 });}
}
