import type {Store,FeedMutationReadView} from './store.js';
import type {FeedLedgerReader} from './feed-adaptive-local-protocol.js';
import {FeedAdaptiveLocalProtocol} from './feed-adaptive-local-protocol.js';
import {adaptiveReviewCommandSchema,adaptiveApplyCommandSchema,adaptiveReviewIntent,adaptiveApplyIntent} from '../../packages/domain/news-feed-adaptive-commands.js';
import {adaptiveReviewPrefix,adaptiveLearningPrefix,adaptiveControlPrefix,adaptiveReviewReceipt,adaptiveLearningReceipt,deriveAdaptiveControl,requireCurrentAdaptiveSource,
 type AdaptiveReviewSaved,type AdaptiveLearningSaved,type AdaptiveControlSaved} from '../../packages/domain/news-feed-adaptive-graph.js';
import {adaptiveHash,readAdaptiveLearning,applyAdaptiveLearning,adaptiveEligibility} from '../../packages/domain/news-feed-adaptive.js';
import {readAdaptiveOutput,type AdaptiveAuthority} from '../../packages/domain/news-feed-adaptive-capture.js';
import {same,unwrap} from '../../packages/domain/news-feed-worker.js';
import {feedCommandSchema,type FeedStory} from '../../packages/domain/news-feed.js';
import {workerInputHash,workerNativeIdentity} from './worker-plugin/identity.js';
import type {SemanticReceipt} from '../../packages/domain/news-feed-semantic-journal.js';

/** Source-only synchronous local actions. The protected Store integration must
 * independently bind each projected receipt to its actual active admission. */
export type FeedAdaptiveActionAuthority=Pick<AdaptiveAuthority,'authorized'|'writeAuthorized'|'deviceId'|'epoch'|'writing'|'source'>;
export class FeedAdaptiveActions{
 constructor(private store:Store,private ledger:FeedLedgerReader,private current:(deviceId:string)=>FeedAdaptiveActionAuthority,
  private story:(id:string)=>{story:FeedStory;hidden:readonly string[]}|undefined,private now=Date.now){}
 private authority(deviceId:string,epoch:string,write=false){const value=this.current(deviceId);
  if(!value.authorized||write&&!value.writeAuthorized||value.deviceId!==deviceId||value.epoch!==this.store.epoch||write&&epoch!==this.store.epoch)throw new Error('Current adaptive action authority changed');
  if(write){this.store.assertUpdateAdmission();if(this.store.recoveryEffectsPaused)throw new Error('Adaptive action recovery-held');}return value;
 }
 private local(deviceId:string){return new FeedAdaptiveLocalProtocol(this.store,this.ledger,workerInputHash,workerNativeIdentity,this.now);}
 private caller(deviceId:string){return {deviceId,epoch:this.store.epoch,current:()=>{const value=this.current(deviceId);return {deviceId:value.deviceId,epoch:value.epoch,read:value.authorized,write:value.authorized&&value.writeAuthorized};}};}
 private save(prefix:string,record:AdaptiveReviewSaved|AdaptiveLearningSaved|AdaptiveControlSaved,receiptValue:unknown){
  return {writes:[{id:prefix+record.id,revision:record.revision,value:record}],receiptValue};
 }
 accept(deviceId:string,raw:unknown){const command=adaptiveReviewCommandSchema.parse(raw),request={kind:'accept' as const,command};
  const local=this.local(deviceId),prior=local.readOriginal(this.caller(deviceId),request);if(prior.state==='confirmed')return prior;
  this.authority(deviceId,command.epoch,true);
  this.store.internalAdmitFeed(deviceId,command,adaptiveReviewIntent(command),graph=>{const current=this.authority(deviceId,command.epoch,true),worker=graph.adaptiveWorkers.get(command.operationId);
   if(!worker||!current.writing)throw new Error('Current interpretation review unavailable');
   const record:AdaptiveReviewSaved={format:3,revision:1,id:command.requestId,deviceId,at:this.now(),command,preferences:structuredClone(current.writing.preferences),workerTerminalSha256:adaptiveHash(worker.terminal,workerInputHash)};
   const receipt=adaptiveReviewReceipt(record,workerInputHash);this.authority(deviceId,command.epoch,true);
   return this.save(adaptiveReviewPrefix,record,receipt);
  });return local.readOriginal(this.caller(deviceId),request);
 }
 applyLearning(deviceId:string,raw:unknown){const command=adaptiveApplyCommandSchema.parse(raw),request={kind:'apply-learning' as const,command};
  const local=this.local(deviceId),prior=local.readOriginal(this.caller(deviceId),request);if(prior.state==='confirmed')return prior;
  this.authority(deviceId,command.epoch,true);
  this.store.internalAdmitFeed(deviceId,command,adaptiveApplyIntent(command),graph=>{const current=this.authority(deviceId,command.epoch,true),worker=graph.adaptiveWorkers.get(command.operationId);
   if(!worker||worker.state!=='completed'||worker.capture.kind!=='learn'||!worker.output?.text||!current.source)throw new Error('Completed current learning original required');
   requireCurrentAdaptiveSource(graph,current.source,deviceId,command.epoch,this.now(),workerInputHash);
   if(!same(current.source,worker.capture.source))throw new Error('Learning capture changed before application');
   const parsed=unwrap(readAdaptiveLearning(worker.output.text,worker.capture.learning,workerInputHash)),at=this.now();
   const after=unwrap(applyAdaptiveLearning(current.source.context,worker.capture.learning,parsed.result,at,workerInputHash));
   const record:AdaptiveLearningSaved={format:3,revision:1,id:command.requestId,deviceId,at,command,before:structuredClone(current.source),after};
   const receipt=adaptiveLearningReceipt(record,workerInputHash);this.authority(deviceId,command.epoch,true);
   return this.save(adaptiveLearningPrefix,record,receipt);
  });return local.readOriginal(this.caller(deviceId),request);
 }
 /** Historical full-mirror compatibility only. Core NewsFeed.command MUST NOT
  * call this method: new controls commit under their existing receipt policy,
  * independently of raw activity, proof availability or semantic capacity. */
 mirrorControl(deviceId:string,raw:unknown,pending:SemanticReceipt,graph:FeedMutationReadView){const command=feedCommandSchema.parse(raw),current=this.authority(deviceId,command.epoch,true);
  if(!current.source)throw new Error('Current adaptive control checkpoint unavailable');
  if(!graph.mutations.size)return {state:'no-semantic-state' as const,writes:[],receiptValue:pending.value};
  const result=pending.value as any,at=Date.parse(result?.at);if(!Number.isSafeInteger(at)||result?.state!=='saved')throw new Error('Original saved control outcome required');
  const derived=deriveAdaptiveControl(current.source,command,at,workerInputHash),record:AdaptiveControlSaved={format:3,revision:1,id:command.requestId,deviceId,at,command,
   before:structuredClone(current.source),after:derived.learning,preferencesAfter:{format:1,kind:'authenticated-current-state',savedRevision:result.revision,profile:derived.profile,control:derived.control,latestMutation:pending}};
  this.authority(deviceId,command.epoch,true);return {...this.save(adaptiveControlPrefix,record,pending.value),state:'mirrored' as const,learningHead:record.id};
 }
 classification(deviceId:string,id:string,options:{following?:boolean}={}){try{return this.store.internalWithFeedReadGraph(graph=>{
  const current=this.authority(deviceId,this.store.epoch),worker=graph.adaptiveWorkers.get(id);
  if(!worker||worker.deviceId!==deviceId||worker.command.epoch!==this.store.epoch||worker.state!=='completed'||worker.capture.kind!=='classify'||!worker.output?.text||!current.source)
   return {eligible:false as const,reason:'original-classification-unavailable'};
  try{requireCurrentAdaptiveSource(graph,current.source,deviceId,this.store.epoch,this.now(),workerInputHash);}catch{return {eligible:false as const,reason:'current-control-projection-unavailable'};}
  const original=this.story(worker.capture.preview.story.id);if(!original)return {eligible:false as const,reason:'current-story-unavailable'};
  const parsed=readAdaptiveOutput(worker.output.text,worker.capture,workerInputHash);if(!parsed.ok)return {eligible:false as const,reason:'original-result-refused'};
  const value=adaptiveEligibility(current.source.context,original.story,worker.capture.preview,parsed.value as any,this.now(),workerInputHash,{following:options.following,hidden:original.hidden});
  this.authority(deviceId,this.store.epoch);return value;
 });}finally{this.authority(deviceId,this.store.epoch);}}
}
