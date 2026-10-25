import {validateFeedWorkerRecord,same,type FeedWorkerSources} from '../../packages/domain/news-feed-worker.js';
import {feedReviewPrefix,feedReviewCommandSchema,feedReviewIntent,feedReviewReceipt,validateFeedReview,type FeedReviewSaved} from '../../packages/domain/news-feed-semantic-journal.js';
import {evidenceDigest} from '../../packages/domain/news-feed-worker-evidence.js';
import type {Store} from './store.js';
import type {WorkerIdentity} from '../../packages/domain/worker.js';
type NativeIdentity=(value:WorkerIdentity)=>{runId:string;sessionKey:string};

export function resolveFeedReview(store:Store,id:string,hash:(text:string)=>string,nativeIdentity:NativeIdentity){
 return store.internalWithFeedReadGraph(graph=>{
  const reviewed=graph.reviews.get(id);if(!reviewed)return;
  if(reviewed.record.format!==2||reviewed.record.id!==id)throw Error('Original legacy Feed review key changed');
  const worker=graph.workers.get(reviewed.record.command.operationId);
  if(!worker||worker.format!==2)throw Error('Original legacy interpreted writing is unavailable');
  return validateFeedReview(reviewed.record,validateFeedWorkerRecord(worker,hash,nativeIdentity),hash).source;
 });
}
/** Explicit review only. No automatic acceptance, provider effects or startup wiring. */
export class FeedSemanticReviews{
 constructor(private store:Store,private sources:FeedWorkerSources,private hash:(text:string)=>string,private nativeIdentity:NativeIdentity,private now=Date.now){}
 accept(deviceId:string,raw:unknown){const command=feedReviewCommandSchema.parse(raw),intent=feedReviewIntent(command);
  const replay=this.store.replayAdmission<ReturnType<typeof feedReviewReceipt>>(deviceId,command,intent);
  const current=this.sources.current(deviceId);
  if(!current.authorized||current.context.deviceId!==deviceId||current.context.epoch!==this.store.epoch||this.store.recoveryEffectsPaused)throw new Error('Current Feed review authority unavailable');
  if(replay!==undefined){const source=resolveFeedReview(this.store,command.requestId,this.hash,this.nativeIdentity);if(!source)throw new Error('Original review is unavailable');return source;}
  this.store.assertUpdateAdmission();
  this.store.internalAdmitFeed(deviceId,command,intent,graph=>{
   if(graph.reviews.has(command.requestId))throw new Error('An original Feed review has no matching admission receipt');
   const value=graph.workers.get(command.operationId);if(!value||value.format!==2)throw new Error('Original interpretation is unavailable');
   const worker=validateFeedWorkerRecord(value,this.hash,this.nativeIdentity),latest=this.sources.current(deviceId);
   if(!latest.authorized||latest.context.deviceId!==deviceId||latest.context.epoch!==command.epoch||!same(latest,current)||this.store.recoveryEffectsPaused)throw Error('Current Feed review authority changed');
   if(!same(current.route,worker.route))throw new Error('Current Feed review account policy changed');
   const row:FeedReviewSaved={format:2,revision:1,id:command.requestId,deviceId,at:this.now(),command,currentContext:structuredClone(current.context),workerTerminalSha256:evidenceDigest(worker.terminal,this.hash)};
   validateFeedReview(row,worker,this.hash);
   if([...graph.workers.values()].some(value=>!['completed','failed','cancelled','withdrawn','rejected'].includes(value.state)))throw new Error('An original Feed worker is still unresolved');
   const result=feedReviewReceipt(row,this.hash);this.store.assertUpdateAdmission();
   const final=this.sources.current(deviceId);if(!final.authorized||!same(final,latest))throw Error('Current Feed review authority changed');
   return {writes:[{id:feedReviewPrefix+row.id,revision:row.revision,value:row}],receiptValue:result};
  });
  return resolveFeedReview(this.store,command.requestId,this.hash,this.nativeIdentity)!;
 }
}
