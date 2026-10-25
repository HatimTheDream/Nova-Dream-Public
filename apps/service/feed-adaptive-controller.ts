import {z} from 'zod';
import type {Store} from './store.js';
import {FeedAdaptiveActions} from './feed-adaptive-actions.js';
import type {FeedAdaptiveAuthority,FeedAdaptiveOwner} from './feed-adaptive-authority.js';
import type {AdaptiveAuthority} from '../../packages/domain/news-feed-adaptive-capture.js';
import type {FeedStory} from '../../packages/domain/news-feed.js';
import {feedStopV3Schema,adaptiveReviewCommandSchema} from '../../packages/domain/news-feed-adaptive-commands.js';
import {canonical} from '../../packages/domain/contracts.js';
import {adaptiveHash,captureAdaptiveWriting,readAdaptiveWrittenPlan} from '../../packages/domain/news-feed-adaptive.js';
import {summary} from '../../packages/domain/news-feed-adaptive-worker.js';
import {workerInputHash} from './worker-plugin/identity.js';

type Current=Pick<AdaptiveAuthority,'authorized'|'writeAuthorized'|'deviceId'|'epoch'|'writing'|'source'>;
export type FeedAdaptiveCurrentPort={
 permissions(owner:FeedAdaptiveOwner):{read:boolean;write:boolean};
 current(owner:FeedAdaptiveOwner):Current;
 story(owner:FeedAdaptiveOwner,id:string):{story:FeedStory;hidden:readonly string[]}|undefined;
};
const permissions=z.object({read:z.boolean(),write:z.boolean()}).strict();
const uuid=z.string().uuid();

/** Service composition only. HTTP must capture its original session and route
 * through captureFeedRequestOwner AFTER the normal host/origin/surface guards.
 * No body field, device ID or successful previous request grants authority.
 * Local accepted-result actions never construct a native-readiness substitute. */
export class FeedAdaptiveController{
 private closing=false;
 private closeOperation?:ReturnType<FeedAdaptiveAuthority['close']>;
 constructor(private store:Store,private native:FeedAdaptiveAuthority,private source:FeedAdaptiveCurrentPort,private now=Date.now){
  for(const name of ['permissions','current','story'] as const)if(typeof source?.[name]!=='function')throw new Error('Current authenticated Feed source is required');
 }
 private owner(input:FeedAdaptiveOwner):FeedAdaptiveOwner{
  if(typeof input?.authorize!=='function')throw new Error('Original authenticated Feed request required');
  const owner=Object.freeze({deviceId:uuid.parse(input.deviceId),epoch:uuid.parse(input.epoch),authorize:input.authorize.bind(input)});
  this.check(owner);return owner;
 }
 private check(owner:FeedAdaptiveOwner,write=false){
  const result:unknown=owner.authorize();
  if(result!==undefined){void Promise.resolve(result).catch(()=>undefined);throw new Error('Original authorization must be synchronous');}
  const current=permissions.parse(this.source.permissions(owner));
  if(owner.epoch!==this.store.epoch||!current.read||write&&!current.write)throw new Error('Original Feed permission changed');
 }
 private open(owner:FeedAdaptiveOwner,write=false){if(this.closing)throw new Error('Feed service is closing');this.check(owner,write);}
 private local<T>(input:FeedAdaptiveOwner,write:boolean,run:(actions:FeedAdaptiveActions,owner:FeedAdaptiveOwner)=>T):T{
  const owner=this.owner(input);this.open(owner,write);
  // These closures belong to this one synchronous request. Another caller can
  // never replace the current owner while a provider promise is outstanding.
  const actions=new FeedAdaptiveActions(this.store,()=>this.store.internalFeedLedger(),deviceId=>{
   this.check(owner,write);if(deviceId!==owner.deviceId)throw new Error('Feed action owner changed');
   const current=this.source.current(owner);this.check(owner,write);return current;
  },id=>{this.check(owner,write);const value=this.source.story(owner,id);this.check(owner,write);return value;},this.now);
  try{return run(actions,owner);}finally{this.check(owner,write);}
 }
 private async active<T>(input:FeedAdaptiveOwner,write:boolean,run:(owner:FeedAdaptiveOwner)=>Promise<T>):Promise<T>{
  const owner=this.owner(input);this.open(owner,write);
  try{return await run(owner);}finally{this.check(owner,write);}
 }
 private passive<T>(input:FeedAdaptiveOwner,run:(owner:FeedAdaptiveOwner)=>T):T{
  const owner=this.owner(input);try{return run(owner);}finally{this.check(owner);}
 }
 nativeCapabilities(input:FeedAdaptiveOwner){return this.passive(input,owner=>this.native.nativeCapabilities(owner));}
 prepare(input:FeedAdaptiveOwner,descriptor:unknown){return this.active(input,true,owner=>this.native.prepare(owner,descriptor));}
 start(input:FeedAdaptiveOwner,command:unknown){return this.active(input,true,owner=>this.native.start(owner,command));}
 observe(input:FeedAdaptiveOwner,id:string){uuid.parse(id);return this.active(input,false,owner=>this.native.observe(owner,id));}
 stop(input:FeedAdaptiveOwner,raw:unknown){const command=feedStopV3Schema.parse(raw);
  return this.active(input,true,async owner=>{await this.native.stop(owner,command);
   // The browser journal acknowledges the exact Stop admission, independently
   // of whether the original native attempt has confirmed it stopped yet.
   return this.native.readOriginal(owner,{kind:'stop',command});});}
 readOriginal(input:FeedAdaptiveOwner,request:unknown){return this.passive(input,owner=>this.native.readOriginal(owner,request));}
 readRetained(input:FeedAdaptiveOwner,id:string){uuid.parse(id);return this.passive(input,owner=>this.native.readRetained(owner,id));}
 history(input:FeedAdaptiveOwner,query:unknown={}){return this.passive(input,owner=>this.native.history(owner,query));}
 /** Passive proof of this exact saved acceptance. A completed interpretation,
  * current writing or a different later approval cannot substitute for it. */
 acceptance(input:FeedAdaptiveOwner,raw:unknown){const command=adaptiveReviewCommandSchema.parse(raw);
  return this.passive(input,owner=>this.store.internalWithFeedReadGraph(graph=>{
   this.check(owner);
   const original=graph.originalRequests.get(command.requestId),request={kind:'accept' as const,command};
   if(!original){
    if(graph.receipts.has(command.requestId)||graph.reservedCloseCommands.has(command.requestId))throw new Error('Acceptance identity belongs to other retained work');
    this.check(owner);return {state:'unknown' as const,command};
   }
   if(original.deviceId!==owner.deviceId||canonical(original.request)!==canonical(request))throw new Error('Original acceptance identity changed');
   const review=graph.adaptiveReviews.get(command.requestId);
   if(!review||review.record.deviceId!==owner.deviceId||canonical(review.record.command)!==canonical(command))throw new Error('Original accepted result unavailable');
   const result={state:'accepted' as const,command,approval:structuredClone(review.source.approval)};
   this.check(owner);return result;
  }));}
 /** Presentation input for the already reviewed interpretation panel. Only the
  * exact written capture and validated result leave this projection: no raw
  * activity collection, native routing identity or prompt is returned. */
 interpretation(input:FeedAdaptiveOwner,id:string){uuid.parse(id);return this.passive(input,owner=>this.store.internalWithFeedReadGraph(graph=>{
  this.check(owner);const worker=graph.adaptiveWorkers.get(id);
  if(!worker||worker.deviceId!==owner.deviceId||worker.capture.kind!=='interpret')throw new Error('Original interpretation unavailable');
  const {id:originalId,state,reason,createdAt,deadlineAt}=summary(worker),capture=structuredClone(worker.capture.brief);
  const parsed=worker.output?.text?readAdaptiveWrittenPlan(worker.output.text,capture,workerInputHash):undefined;
  const attempt={id:originalId,state,reason,createdAt,deadlineAt,capture,
   ...(worker.stop?{stop:structuredClone(worker.stop)}:{}),
   ...(parsed?.ok?{result:structuredClone(parsed.value)}:parsed?{resultError:'The original result did not pass interpretation validation.'}:{}),
   ...(worker.terminal?{terminalSha256:adaptiveHash(worker.terminal,workerInputHash)}:{})};
  let currentWriting:Pick<typeof capture,'epoch'|'deviceId'|'profileRevision'|'writing'|'writingSha256'>|null=null;
  // An unavailable current preference projection cannot erase a readable
  // original. The complete historical graph was verified above; access is
  // rechecked after this optional current-state read, including its error path.
  try{const current=this.source.current(owner),value=captureAdaptiveWriting(current.writing.context,id,workerInputHash);
   if(value.ok){const {epoch,deviceId,profileRevision,writing,writingSha256}=value.value;currentWriting={epoch,deviceId,profileRevision,writing,writingSha256};}}
  catch{/* Keep original writing/result available; current approval is unavailable. */}
  this.check(owner);return {attempt,currentWriting};
 }));}
 closeOriginal(input:FeedAdaptiveOwner,command:unknown){const owner=this.owner(input);this.open(owner,true);
  try{return this.native.closeOriginal(owner,command);}finally{this.check(owner,true);}}
 accept(input:FeedAdaptiveOwner,command:unknown){return this.local(input,true,(actions,owner)=>actions.accept(owner.deviceId,command));}
 applyLearning(input:FeedAdaptiveOwner,command:unknown){return this.local(input,true,(actions,owner)=>actions.applyLearning(owner.deviceId,command));}
 classification(input:FeedAdaptiveOwner,id:string,options:{following?:boolean}={}){
  uuid.parse(id);return this.local(input,false,(actions,owner)=>actions.classification(owner.deviceId,id,options));}
 maintenanceBlockers(){return this.native.maintenanceBlockers();}
 close(waitMs?:number){
  if(this.closeOperation)return this.closeOperation;
  // Native authority validates the finite deadline before closing. Invalid
  // caller input must not strand an otherwise usable controller.
  if(waitMs!==undefined&&(!Number.isInteger(waitMs)||waitMs<1||waitMs>90000))throw new Error('Invalid finite close bound');
  this.closing=true;const operation=this.native.close(waitMs);this.closeOperation=operation;
  // An expired wait does not end the original raw work. Keep admission closed,
  // but permit a later bounded observation after that same work really settles.
  void operation.then(result=>{if(!result.localSettled&&this.closeOperation===operation)this.closeOperation=undefined;},
   ()=>{if(this.closeOperation===operation)this.closeOperation=undefined;});
  return operation;
 }
}
