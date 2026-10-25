import {z} from 'zod';
import {canonical} from '../../../packages/domain/contracts';
import {feedSemanticRequestSchema,feedSemanticReceiptSchema} from '../../../packages/domain/news-feed-semantic-commands';
import {feedProtocolRequestSchema,feedLocalReadbackSchema} from '../../../packages/domain/news-feed-semantic-protocol';
import {adaptiveProtocolRequestSchema,adaptiveAdmissionSchema,type AdaptiveProtocolRequest} from '../../../packages/domain/news-feed-adaptive-commands';
import {checkedFeedProtocolReceipt} from './feed-protocol-request-journal';
import {RetainedBook} from './content-library-recovery';

const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const legacyReceiptSchema=z.union([feedLocalReadbackSchema,feedSemanticReceiptSchema,
 feedSemanticReceiptSchema.options[1].extend({historical:z.boolean().optional()}).strict()]);
const receiptSchema=z.union([legacyReceiptSchema,
 z.object({state:z.literal('unknown'),request:adaptiveProtocolRequestSchema}).strict(),
 z.object({state:z.literal('confirmed'),request:adaptiveProtocolRequestSchema,admission:adaptiveAdmissionSchema,historical:z.boolean()}).strict()]);
export type FeedAdaptiveReceipt=z.infer<typeof receiptSchema>;
type Digest=(value:string)=>Promise<string>;
const sha256:Digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema=z.object({deviceId:z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/),epoch:z.string().uuid()}).strict();
type Scope=z.infer<typeof scopeSchema>;
const legacySlot=z.object({request:feedProtocolRequestSchema,receipt:legacyReceiptSchema.optional()}).strict();
const legacyBook=z.object({format:z.literal(1),request:feedSemanticRequestSchema.optional(),receipt:feedSemanticReceiptSchema.optional(),
 stop:z.object({request:feedSemanticRequestSchema.options[1],receipt:feedSemanticReceiptSchema.optional()}).strict().optional()}).strict();
const protocolBook=z.object({format:z.literal(2),request:feedProtocolRequestSchema.optional(),receipt:legacyReceiptSchema.optional(),
 stop:legacySlot.optional(),close:legacySlot.optional()}).strict();
const slotSchema=z.object({request:adaptiveProtocolRequestSchema,receipt:receiptSchema.optional()}).strict();
const adaptiveBook=z.object({format:z.literal(3),request:adaptiveProtocolRequestSchema.optional(),receipt:receiptSchema.optional(),
 stop:slotSchema.optional(),close:slotSchema.optional()}).strict();
// Old formats retain their exact old envelope; construction never upgrades it.
const bookSchema=adaptiveBook.extend({format:z.union([z.literal(1),z.literal(2),z.literal(3)])})
 .refine(value=>value.format===3||(value.format===1?legacyBook:protocolBook).safeParse(value).success,'Earlier Feed recovery keeps its exact original format.');
type Book={format:1|2|3;request?:AdaptiveProtocolRequest;receipt?:FeedAdaptiveReceipt;stop?:Slot;close?:Slot};
type Slot={request:AdaptiveProtocolRequest;receipt?:FeedAdaptiveReceipt};

/** These checks bind an authenticated service admission to a complete original.
 * A client hash cannot authenticate the private Store graph, terminal evidence,
 * accepted rules, current permissions, or the resulting saved learning record. */
export async function checkedFeedAdaptiveReceipt(original:AdaptiveProtocolRequest,raw:unknown,digest:Digest=sha256):Promise<FeedAdaptiveReceipt>{
 const request=adaptiveProtocolRequestSchema.parse(original),receipt=receiptSchema.parse(raw);
 if(!same(request,receipt.request))throw Error('The response does not belong to this original Feed request.');
 if(receipt.state==='unknown')return receipt;
 const admission=receipt.admission;
 if(admission.format!==3||admission.type==='feed-semantic-local'){
  await checkedFeedProtocolReceipt(feedProtocolRequestSchema.parse(request),receipt,digest);return receipt;
 }
 if(!('format' in request.command)||request.command.format!==3||admission.id!==request.command.requestId||admission.epoch!==request.command.epoch||
  admission.requestSha256!==hashSchema.parse(await digest(canonical(request))))throw Error('The Feed admission does not confirm the complete original request.');
 if(request.kind==='start'){
  if(admission.type!=='feed-semantic-worker'||!('expectation' in request.command)||admission.inputHash!==request.command.expectation.modelInputSha256)throw Error('The worker admission does not retain the original prepared input.');
 }else if(request.kind==='stop'){
  if(admission.type!=='feed-semantic-stop'||admission.operationId!==request.command.id)throw Error('The Stop admission targets a different original.');
 }else if(request.kind==='accept'){
  if(admission.type!=='feed-semantic-review'||admission.operationId!==request.command.operationId||admission.planSha256!==request.command.planSha256)throw Error('The acceptance does not retain the original plan.');
 }else if(request.kind==='apply-learning'){
  if(admission.type!=='feed-semantic-learning'||admission.operationId!==request.command.operationId||admission.learningRevision!==request.command.expectedLearningRevision+1)throw Error('The learning admission does not confirm the expected saved revision.');
 }else throw Error('Close requires its exact local acknowledgement.');
 return receipt;
}

/** Owns local request custody only. No effect, auto-resend, native Check or
 * migration write occurs on construction/reload. ready must settle before any
 * mutation. Compare/readback is not an atomic cross-window admission lock. */
export class FeedAdaptiveRequestJournal extends RetainedBook<Book>{
 readonly scope:Readonly<Scope>;
 readonly ready:Promise<boolean>;
 constructor(storage:Pick<Storage,'getItem'|'setItem'>,scope:Scope,private current:()=>boolean,private digest:Digest=sha256){
  const owned=Object.freeze(scopeSchema.parse(scope));
  super(storage,`e3:feed-semantic-request:${owned.deviceId}:${owned.epoch}`,bookSchema,{format:3});this.scope=owned;
  this.ready=this.validateInitial();
 }
 private fail(error:unknown){this.error=error instanceof Error?error.message:'The original Feed requests remain kept.';return false;}
 private slot(kind:AdaptiveProtocolRequest['kind']):Slot|undefined{
  return kind==='stop'?this.value.stop:kind==='close'?this.value.close:this.value.request?{request:this.value.request,receipt:this.value.receipt}:undefined;
 }
 private async validateInitial(){
  if(this.invalid)return false;
  try{
   const book=bookSchema.parse(this.value),slots=[book.request?{request:book.request,receipt:book.receipt}:undefined,book.stop,book.close].filter(Boolean) as Slot[];
   if(book.receipt&&!book.request||book.request&&['stop','close'].includes(book.request.kind)||book.stop&&book.stop.request.kind!=='stop'||book.close&&book.close.request.kind!=='close')
    throw Error('The kept Feed requests do not match their original slots.');
   if(new Set(slots.map(slot=>slot.request.command.requestId)).size!==slots.length||slots.some(slot=>slot.request.command.epoch!==this.scope.epoch))throw Error('The original request or workspace identity changed.');
   if(book.stop&&book.stop.receipt?.state!=='confirmed'&&book.close&&book.close.receipt?.state!=='confirmed')throw Error('The original Stop and close requests overlap. Keep both records and check their history.');
   for(const slot of slots){
    const request=slot.request;
    if(request.kind==='stop'&&request.command.id===request.command.requestId)throw Error('Stop must retain a distinct request identity.');
    if(slot.receipt)await checkedFeedAdaptiveReceipt(request,slot.receipt,this.digest);
   }
   const pending=book.request&&book.receipt?.state!=='confirmed'?book.request:undefined;
   if(pending&&book.stop&&(pending.kind!=='start'||book.stop.request.kind!=='stop'||book.stop.request.command.id!==pending.command.requestId))throw Error('Stop no longer targets the original pending start.');
   if(pending&&book.close&&(pending.kind!=='start'||book.close.request.kind!=='close'||!same(book.close.request.command.original,pending.command)))throw Error('Close no longer retains the original pending start.');
   if(!same(this.value,book))throw Error('The kept Feed requests changed during verification.');
   return true;
  }catch(error){this.invalid=true;return this.fail(error);}
 }
 get pending(){return this.value.request&&this.value.receipt?.state!=='confirmed'?structuredClone(this.value.request):undefined;}
 get pendingStop(){return this.value.stop&&this.value.stop.receipt?.state!=='confirmed'?structuredClone(this.value.stop.request):undefined;}
 get pendingClose(){return this.value.close&&this.value.close.receipt?.state!=='confirmed'?structuredClone(this.value.close.request):undefined;}
 async begin(raw:unknown){
  if(!await this.ready||!this.current()||this.invalid)return false;
  try{
   const request=adaptiveProtocolRequestSchema.parse(raw);
   if(request.command.epoch!==this.scope.epoch)throw Error('This request belongs to another workspace.');
   if([this.value.request,this.value.stop?.request,this.value.close?.request].some(kept=>kept?.command.requestId===request.command.requestId))
    throw Error('This request identity is already kept. Check its original receipt before another request.');
   if(request.kind==='stop'||request.kind==='close'){
    const primary=this.value.request,other=request.kind==='stop'?this.value.close:this.value.stop;
    if(request.command.requestId===primary?.command.requestId||request.command.requestId===other?.request.command.requestId)throw Error('Each request must keep its own identity.');
    if(request.kind==='stop'){
     if(this.pendingStop||this.pendingClose)throw Error('Check the original Stop or close request first.');
     if(request.command.requestId===request.command.id||this.pending&&(this.pending.kind!=='start'||request.command.id!==this.pending.command.requestId))throw Error('Stop must target the original pending start.');
     return this.keep({...this.value,format:3,stop:{request}});
    }
    if(this.pendingClose||this.pendingStop)throw Error('Check the original close or Stop request first.');
    if(this.pending&&(this.pending.kind!=='start'||!same(request.command.original,this.pending.command)))throw Error('Close must retain the complete original pending start.');
    return this.keep({...this.value,format:3,close:{request}});
   }
   if(this.pending||this.pendingStop||this.pendingClose)throw Error('Check the original Feed requests before starting another.');
   return this.keep({format:3,request});
  }catch(error){return this.fail(error);}
 }
 async acknowledge(original:AdaptiveProtocolRequest,raw:unknown){
  if(!await this.ready||!this.current()||this.invalid)return false;
  try{
   const request=adaptiveProtocolRequestSchema.parse(original),before=this.slot(request.kind);
   if(!before||!same(request,before.request))throw Error('The original Feed request changed.');
   const receipt=await checkedFeedAdaptiveReceipt(request,raw,this.digest);
   if(!this.current()||this.invalid)throw Error('This Feed owner is no longer current.');
   const slot=this.slot(request.kind);
   if(!slot||!same(request,slot.request))throw Error('The original Feed request changed during verification.');
   if(slot.receipt?.state==='confirmed'&&!same(receipt,slot.receipt))throw Error('The confirmed original receipt cannot be replaced.');
   const updated={...this.value,format:3 as const};
   if(request.kind==='stop')updated.stop={request,receipt};else if(request.kind==='close')updated.close={request,receipt};else updated.receipt=receipt;
   return this.keep(updated);
  }catch(error){return this.fail(error);}
 }
}
