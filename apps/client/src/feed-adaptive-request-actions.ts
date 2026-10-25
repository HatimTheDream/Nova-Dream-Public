import {canonical} from '../../../packages/domain/contracts';
import {adaptiveProtocolRequestSchema,type AdaptiveProtocolRequest} from '../../../packages/domain/news-feed-adaptive-commands';
import {FeedAdaptiveRequestJournal,type FeedAdaptiveReceipt} from './feed-adaptive-request-journal';

type CloseRequest=Extract<AdaptiveProtocolRequest,{kind:'close'}>;
export type FeedAdaptiveRequestPort={
 submitNew(request:AdaptiveProtocolRequest):Promise<unknown>;
 readOriginal(request:AdaptiveProtocolRequest):Promise<unknown>;
 /** Dedicated local two-transaction close endpoint. Never start/dispatch/check native work. */
 continueClose(request:CloseRequest):Promise<unknown>;
};
export type FeedAdaptiveActionResult={ok:true;receipt:FeedAdaptiveReceipt}|{ok:false;message:string};
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const blocked=(message:string):FeedAdaptiveActionResult=>({ok:false,message});
function allowed(check:()=>boolean){
 try{const value:unknown=check();if(value!==true){if(value&&typeof (value as PromiseLike<unknown>).then==='function')void Promise.resolve(value).catch(()=>{});return false;}return true;}
 catch{return false;}
}

/** Explicit UI actions only. Construction/reload performs no network request.
 * A failed POST remains kept; this object has no start resend or timeout retry.
 * Disposal revokes responses without pretending to cancel an owned raw request. */
export class FeedAdaptiveRequestActions{
 readonly journal:FeedAdaptiveRequestJournal;
 private disposed=false;
 private effect:string|null=null;
 private reads=new Map<string,Promise<FeedAdaptiveActionResult>>();
 private active=new Set<Promise<FeedAdaptiveActionResult>>();
 private port:Readonly<FeedAdaptiveRequestPort>;
 constructor(storage:Pick<Storage,'getItem'|'setItem'>,scope:{deviceId:string;epoch:string},
  private owner:()=>boolean,private canSubmit:(request:AdaptiveProtocolRequest)=>boolean,port:FeedAdaptiveRequestPort){
  this.port=Object.freeze({submitNew:port.submitNew.bind(port),readOriginal:port.readOriginal.bind(port),continueClose:port.continueClose.bind(port)});
  this.journal=new FeedAdaptiveRequestJournal(storage,scope,()=>this.current());
 }
 private current(){return !this.disposed&&allowed(this.owner);}
 private writable(request:AdaptiveProtocolRequest){return this.current()&&allowed(()=>this.canSubmit(structuredClone(request)));}
 get busy(){return this.effect!==null;}
 get pendingReads(){return this.reads.size;}
 dispose(){this.disposed=true;}
 async settled(){while(this.active.size)await Promise.all([...this.active]);}
 private own(work:()=>Promise<FeedAdaptiveActionResult>,done:()=>void=()=>{}){
  const result=Promise.resolve().then(work).catch(error=>blocked(error instanceof Error?error.message:'The original Feed request remains kept.'));
  this.active.add(result);void result.then(()=>{this.active.delete(result);done();});return result;
 }
 private kept(request:AdaptiveProtocolRequest){
  const book=this.journal.value,kept=request.kind==='stop'?book.stop?.request:request.kind==='close'?book.close?.request:book.request;
  return !!kept&&same(kept,request);
 }
 private async confirm(request:AdaptiveProtocolRequest,raw:unknown):Promise<FeedAdaptiveActionResult>{
  if(!this.current())return blocked('This Feed workspace is no longer current. The original request remains kept.');
  if(!await this.journal.acknowledge(request,raw))return blocked(this.journal.error||'The original receipt could not be kept.');
  if(!this.current()||!this.kept(request))return blocked('The original receipt is kept, but this workspace or selected request changed.');
  const book=this.journal.value,receipt=request.kind==='stop'?book.stop?.receipt:request.kind==='close'?book.close?.receipt:book.receipt;
  return receipt&&same(receipt.request,request)?{ok:true,receipt:structuredClone(receipt)}:blocked('The original receipt is unavailable.');
 }
 submitNew(raw:unknown):Promise<FeedAdaptiveActionResult>{
  let request:AdaptiveProtocolRequest;try{request=adaptiveProtocolRequestSchema.parse(raw);}catch{return Promise.resolve(blocked('The Feed request is invalid.'));}
  if(request.kind==='start'&&(!('format' in request.command)||request.command.format!==3))return Promise.resolve(blocked('Prepare a current Feed request before starting new work. The earlier original remains available to check.'));
  if(this.busy||!this.writable(request))return Promise.resolve(blocked('New Feed work is unavailable. Keep and check the original request.'));
  const key=canonical(request);this.effect=key;
  return this.own(async()=>{
   if(!this.writable(request))return blocked('New Feed work is unavailable.');
   if(!await this.journal.begin(request))return blocked(this.journal.error||'The original request could not be retained.');
   if(!this.writable(request)||!this.kept(request))return blocked('The original request is kept but was not sent.');
   return this.confirm(request,await this.port.submitNew(structuredClone(request)));
  },()=>{if(this.effect===key)this.effect=null;});
 }
 checkOriginal(raw:unknown):Promise<FeedAdaptiveActionResult>{
  let request:AdaptiveProtocolRequest;try{request=adaptiveProtocolRequestSchema.parse(raw);}catch{return Promise.resolve(blocked('The original Feed request is invalid.'));}
  if(!this.current())return Promise.resolve(blocked('This Feed workspace is no longer current.'));
  const key=canonical(request),existing=this.reads.get(key);if(existing)return existing;
  const result=this.own(async()=>{
   if(!await this.journal.ready||!this.current()||!this.kept(request))return blocked('This exact original request is not available in the current workspace.');
   return this.confirm(request,await this.port.readOriginal(structuredClone(request)));
  },()=>this.reads.delete(key));this.reads.set(key,result);return result;
 }
 /** Explicit continuation of a retained local close only, after original receipt
  * readback. An absent start or an HTTP error never authorizes native resending. */
 continueClose(raw:unknown):Promise<FeedAdaptiveActionResult>{
  let request:CloseRequest;try{const parsed=adaptiveProtocolRequestSchema.parse(raw);if(parsed.kind!=='close')throw Error();request=parsed;}catch{return Promise.resolve(blocked('Only the exact original local close can continue.'));}
  if(this.busy||!this.writable(request))return Promise.resolve(blocked('The original local close is unavailable.'));
  const key=canonical(request);this.effect=key;
  return this.own(async()=>{
   if(!await this.journal.ready||!this.writable(request)||!same(this.journal.pendingClose,request))return blocked('Check the exact kept local close first.');
   const observed=await this.checkOriginal(request);
   if(!observed.ok||observed.receipt.state==='confirmed')return observed;
   if(!this.writable(request)||!same(this.journal.pendingClose,request))return blocked('The original local close remains kept.');
   return this.confirm(request,await this.port.continueClose(structuredClone(request)));
  },()=>{if(this.effect===key)this.effect=null;});
 }
}
