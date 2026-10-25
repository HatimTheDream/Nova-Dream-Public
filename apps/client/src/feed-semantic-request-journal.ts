import {z} from 'zod';
import {canonical} from '../../../packages/domain/contracts';
import {feedSemanticRequestSchema,feedSemanticReceiptSchema,type FeedSemanticRequest,type FeedSemanticReceipt} from '../../../packages/domain/news-feed-semantic-commands';
import {RetainedBook} from './content-library-recovery';

const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const stopSlot=z.object({request:feedSemanticRequestSchema.options[1],receipt:feedSemanticReceiptSchema.optional()}).strict();
const book=z.object({format:z.literal(1),request:feedSemanticRequestSchema.optional(),receipt:feedSemanticReceiptSchema.optional(),stop:stopSlot.optional()}).strict();
type Scope={deviceId:string;epoch:string};
const scopeSchema=z.object({deviceId:z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/),epoch:z.string().uuid()}).strict();
export function checkedFeedSemanticReceipt(original:FeedSemanticRequest,raw:unknown):FeedSemanticReceipt{
 const receipt=feedSemanticReceiptSchema.parse(raw);
 if(!same(original,receipt.request))throw Error('The response does not belong to this original Feed request.');
 if(receipt.state==='confirmed'){
  const a=receipt.admission,c=original.command;
  if(a.epoch!==c.epoch)throw Error('The Feed receipt belongs to another workspace.');
  if(original.kind==='start'&&(a.type!=='feed-semantic-worker'||a.id!==c.requestId)
   ||original.kind==='stop'&&(a.type!=='feed-semantic-stop'||a.requestId!==c.requestId||a.id!==original.command.id)
   ||original.kind==='accept'&&(a.type!=='feed-semantic-review'||a.id!==c.requestId||a.operationId!==original.command.operationId||a.planSha256!==original.command.planSha256))
   throw Error('The receipt does not confirm this exact Feed admission.');
 }
 return receipt;
}

/** A shared primary slot and separate original Stop slot for this workspace.
 * Compare/readback storage is not an atomic cross-window admission mutex; the
 * service's authenticated single-original admission and history remain required.
 * Reading this book
 * never sends, observes native work, or retries. The caller must reauthorize and
 * gate dispatch on successful begin; current() is ownership, not authentication.
 * Original server history remains authoritative after a confirmed intent yields
 * the slot. No acknowledgement is inferred from a timeout, HTTP error or reload. */
export class FeedSemanticRequestJournal extends RetainedBook<z.infer<typeof book>>{
 readonly scope:Readonly<Scope>;
 constructor(storage:Pick<Storage,'getItem'|'setItem'>,scope:Scope,private current:()=>boolean){
  const owned=Object.freeze(scopeSchema.parse(scope));
  super(storage,`e3:feed-semantic-request:${owned.deviceId}:${owned.epoch}`,book,{format:1});
  this.scope=owned;
  try{
   if(this.value.request&&(this.value.request.command.epoch!==owned.epoch||this.value.request.kind==='stop'))throw Error('The kept Feed request belongs to another workspace or slot.');
   if(this.value.receipt){if(!this.value.request)throw Error('The Feed receipt has no original request.');checkedFeedSemanticReceipt(this.value.request,this.value.receipt);}
   const stop=this.value.stop;
   if(stop){
    if(stop.request.command.epoch!==owned.epoch||stop.request.command.requestId===stop.request.command.id||stop.request.command.requestId===this.value.request?.command.requestId)throw Error('The original Stop identity changed.');
    if(this.pending&&(this.pending.kind!=='start'||stop.request.command.id!==this.pending.command.requestId))throw Error('The Stop no longer targets the original pending start.');
    if(stop.receipt)checkedFeedSemanticReceipt(stop.request,stop.receipt);
   }
  }catch(error){this.invalid=true;this.error=error instanceof Error?error.message:'The original Feed request cannot be read.';}
 }
 get pending(){return this.value.request&&this.value.receipt?.state!=='confirmed'?this.value.request:undefined;}
 get pendingStop(){return this.value.stop&&this.value.stop.receipt?.state!=='confirmed'?this.value.stop.request:undefined;}
 begin(raw:unknown){
  if(!this.current()||this.invalid)return false;
  try{
   const request=feedSemanticRequestSchema.parse(raw);
   if(request.command.epoch!==this.scope.epoch)throw Error('This request belongs to another workspace.');
   if(request.kind==='stop'){
    if(this.pendingStop)throw Error('Check the original Stop request before another Stop.');
    if(request.command.requestId===request.command.id||request.command.requestId===this.value.request?.command.requestId)throw Error('The Stop must keep its own request identity.');
    if(this.pending&&(this.pending.kind!=='start'||request.command.id!==this.pending.command.requestId))throw Error('Stop must target the original pending start.');
    return this.keep({...this.value,stop:{request}});
   }
   if(this.pending||this.pendingStop)throw Error('Check the original Feed requests before starting another.');
   // A confirmed older Stop remains in authoritative server history. Keeping it
   // linked to a new primary would invent an association, so yield that local slot.
   return this.keep({format:1,request});
  }catch(error){this.error=error instanceof Error?error.message:'The Feed request could not be kept.';return false;}
 }
 acknowledge(original:FeedSemanticRequest,raw:unknown){
  if(!this.current()||this.invalid)return false;
  try{
   const slot=original.kind==='stop'?this.value.stop:this.value;
   if(!slot||!same(original,slot.request))throw Error('The original Feed request changed.');
   const receipt=checkedFeedSemanticReceipt(original,raw);
   if(slot.receipt?.state==='confirmed'&&!same(receipt,slot.receipt))throw Error('The confirmed original receipt cannot be replaced.');
   return original.kind==='stop'?this.keep({...this.value,stop:{request:original,receipt}}):this.keep({...this.value,receipt});
  }catch(error){this.error=error instanceof Error?error.message:'The original Feed request remains unconfirmed.';return false;}
 }
}
