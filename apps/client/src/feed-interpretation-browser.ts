import {z} from 'zod';
import {adaptiveProtocolRequestSchema,type AdaptiveProtocolRequest} from '../../../packages/domain/news-feed-adaptive-commands';
import {checkedFeedAdaptiveReceipt,type FeedAdaptiveReceipt} from './feed-adaptive-request-journal';
import {FeedInterpretationSession,type FeedInterpretationPort,type FeedInterpretationCapabilities} from './feed-interpretation-session';

const uuid=z.string().uuid();
export const feedInterpretationAccessSchema=z.object({format:z.literal(3),epoch:uuid,deviceId:uuid,
 permissions:z.object({read:z.literal(true),write:z.boolean()}).strict(),
 native:z.object({prepare:z.boolean(),observe:z.boolean(),reason:z.enum(['available','held','unavailable'])}).strict()}).strict();
export type FeedInterpretationAccess=z.infer<typeof feedInterpretationAccessSchema>;
const historyEntrySchema=z.object({request:adaptiveProtocolRequestSchema,admission:z.unknown().optional(),at:z.number().int().positive().max(8640000000000000),historical:z.boolean(),state:z.string().min(1).max(100)}).strict();
const historySchema=z.object({entries:z.array(historyEntrySchema).max(50),next:uuid.optional()}).strict();
export type FeedInterpretationHistory=z.infer<typeof historySchema>;
export type FeedSemanticRequest=(path:string,data?:unknown)=>Promise<unknown>;
const prefix='home/news/semantic/';
/** Uses the maintained authenticated request function. No fallback, retry,
 * conditional change of command or automatic native observation is added. */
export function feedInterpretationHttpPort(send:FeedSemanticRequest,changed:()=>void=()=>{}){
 const call=async(path:string,data?:unknown)=>{changed();try{return await send(prefix+path,data===undefined?undefined:structuredClone(data));}finally{changed();}};
 const port:FeedInterpretationPort={
  prepare:value=>call('prepare',value),submitNew:value=>call('command',value),readOriginal:value=>call('original/receipt',value),
  continueClose:value=>call('command',value),observe:value=>call('observe',value),
  interpretation:async id=>await call('interpretation?id='+encodeURIComponent(uuid.parse(id))) as Awaited<ReturnType<FeedInterpretationPort['interpretation']>>,
  acceptance:async command=>await call('acceptance/receipt',command) as Awaited<ReturnType<FeedInterpretationPort['acceptance']>>,
 };
 return {port,access:async()=>feedInterpretationAccessSchema.parse(await call('view')),
  history:async(after?:string)=>{
   const raw=await call('history?limit=20'+(after?'&after='+encodeURIComponent(uuid.parse(after)):''));
   if(new TextEncoder().encode(JSON.stringify(raw)).byteLength>131072)throw Error('Saved request history exceeds its response limit.');
   const value=historySchema.parse(raw);let prior=after;
   for(const row of value.entries){const id=row.request.command.requestId;if(prior&&id<=prior)throw Error('Saved request history order changed.');prior=id;
    if(row.admission!==undefined)await checkedFeedAdaptiveReceipt(row.request,{state:'confirmed',request:row.request,admission:row.admission,historical:row.historical});
    else if(row.state!=='unadmitted-close'||row.request.kind!=='close')throw Error('Saved request history is missing its original admission.');
   }
   if(value.next&&(!value.entries.length||value.next!==prior))throw Error('Saved request history cursor changed.');return value;
  }};
}
export type FeedInterpretationBrowserPort=ReturnType<typeof feedInterpretationHttpPort>;
const noWrite:FeedInterpretationCapabilities={read:true,prepare:false,observe:false,stop:false,accept:false,close:false};
const message=(error:unknown)=>error instanceof Error?error.message:'The saved Feed request is kept. Check it again when the connection is available.';

/** One mounted workspace owner. Reload reads advisory state and a bounded
 * history page only. All original receipt and effect actions stay explicit. */
export class FeedInterpretationBrowser{
 readonly session:FeedInterpretationSession;
 private disposed=false;
 private denied=false;
 private generation=0;
 private historyGeneration=0;
 private receiptGeneration=0;
 private tasks=new Set<Promise<unknown>>();
 private accessValue:FeedInterpretationAccess|null=null;
 private historyValue:FeedInterpretationHistory={entries:[]};
 private receiptValue:{request:AdaptiveProtocolRequest;receipt:FeedAdaptiveReceipt}|null=null;
 private pendingReads=0;
 error='';
 constructor(storage:Pick<Storage,'getItem'|'setItem'>,readonly scope:Readonly<{deviceId:string;epoch:string}>,private owner:()=>boolean,
  readonly port:FeedInterpretationBrowserPort,private changed:()=>void=()=>{}){
  this.scope=Object.freeze({...scope});
  // Observe authorization before session/actions convert failures into visible results.
  // The original promise remains awaited by the session; no retry or cancellation.
  const guarded=async<T>(run:()=>Promise<T>):Promise<T>=>{try{return await run();}catch(error){
   if(this.owns()&&((error as {status?:number})?.status===401||(error as {status?:number})?.status===403)){
    this.failure(error);this.notify();
   }throw error;
  }};
  const sessionPort:FeedInterpretationPort={
   prepare:value=>guarded(()=>port.port.prepare(value)),submitNew:value=>guarded(()=>port.port.submitNew(value)),
   readOriginal:value=>guarded(()=>port.port.readOriginal(value)),continueClose:value=>guarded(()=>port.port.continueClose(value)),
   observe:value=>guarded(()=>port.port.observe(value)),interpretation:id=>guarded(()=>port.port.interpretation(id)),
   acceptance:command=>guarded(()=>port.port.acceptance(command)),
  };
  this.session=new FeedInterpretationSession(storage,this.scope,()=>this.current(),()=>this.capabilities,sessionPort,()=>this.notify());
 }
 private owns(){if(this.disposed)return false;try{const answer:unknown=this.owner();if(answer===true)return true;
  if(answer&&typeof (answer as PromiseLike<unknown>).then==='function')void Promise.resolve(answer).catch(()=>{});
  }catch{/* An unavailable owner cannot expose saved content. */}return false;}
 private notify(){if(this.owns())this.changed();}
 current(){return this.owns()&&!this.denied;}
 get access(){return this.current()&&this.accessValue?structuredClone(this.accessValue):null;}
 get history(){return this.current()?structuredClone(this.historyValue):{entries:[]};}
 get receipt(){return this.current()&&this.receiptValue?structuredClone(this.receiptValue):null;}
 get loading(){return this.pendingReads>0;}
 get capabilities(){const a=this.current()?this.accessValue:null;return a?{read:true,prepare:a.permissions.write&&a.native.prepare,observe:a.native.observe,
  stop:a.permissions.write,accept:a.permissions.write,close:a.permissions.write}:{...noWrite,read:this.current()};}
 private own<T>(run:()=>Promise<T>){const task=Promise.resolve().then(run);this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return task;}
 private failure(error:unknown){if((error as {status?:number})?.status===401||(error as {status?:number})?.status===403)this.denied=true;this.error=message(error);}
 refresh(){const generation=++this.generation;return this.own(async()=>{
  if(!this.owns())return;this.pendingReads++;this.notify();
  try{const access=await this.port.access();if(!this.owns()||generation!==this.generation)return;
   if(access.epoch!==this.scope.epoch||access.deviceId!==this.scope.deviceId){this.denied=true;throw Error('The Feed workspace changed. Reopen the current workspace.');}
   this.denied=false;this.accessValue=access;this.error='';await this.loadHistory();
  }catch(error){if(this.owns()&&generation===this.generation)this.failure(error);}
  finally{this.pendingReads--;this.notify();}
 });}
 loadHistory(after?:string){const generation=++this.historyGeneration;this.receiptGeneration++;return this.own(async()=>{
  if(!this.current())return;this.pendingReads++;this.notify();
  try{const page=await this.port.history(after);if(this.current()&&generation===this.historyGeneration){this.historyValue=page;this.receiptValue=null;this.error='';}}
  catch(error){if(this.owns()&&generation===this.historyGeneration)this.failure(error);}
  finally{this.pendingReads--;this.notify();}
 });}
 checkHistory(request:AdaptiveProtocolRequest){const original=structuredClone(request),generation=this.historyGeneration,receiptGeneration=++this.receiptGeneration;
  return this.own(async()=>{if(!this.current())return;this.pendingReads++;this.notify();
   try{const raw=await this.port.port.readOriginal(original),receipt=await checkedFeedAdaptiveReceipt(original,raw);
    if(this.current()&&generation===this.historyGeneration&&receiptGeneration===this.receiptGeneration){this.receiptValue={request:original,receipt};this.error='';}}
   catch(error){if(this.owns()&&generation===this.historyGeneration&&receiptGeneration===this.receiptGeneration)this.failure(error);}
   finally{this.pendingReads--;this.notify();}
  });
 }
 dispose(){this.disposed=true;this.generation++;this.historyGeneration++;this.accessValue=null;this.historyValue={entries:[]};this.receiptValue=null;this.session.dispose();}
 async settled(){while(this.tasks.size)await Promise.allSettled([...this.tasks]);await this.session.settled();}
}
