import {z} from 'zod';
import {canonical} from './contracts.js';
import {adaptiveHash,readAdaptiveWrittenPlan,captureAdaptiveApproval,readAdaptiveLearning,applyAdaptiveLearning,stopAdaptiveInterest,allowAdaptiveInterest,resetAdaptiveLearning,
 type AdaptiveWrittenBasis,type AdaptiveLearningState} from './news-feed-adaptive.js';
import {feedCommandSchema,feedTopicKey,type FeedCommand} from './news-feed.js';
import {adaptiveReviewCommandSchema,adaptiveApplyCommandSchema,adaptiveAdmissionSchema,adaptiveReviewIntent,adaptiveApplyIntent,
 type AdaptiveReviewCommand,type AdaptiveApplyCommand} from './news-feed-adaptive-commands.js';
import {validateAdaptiveSource,preferenceCheckpointSchema,adaptiveWorkerBounds,type AdaptiveSource,type PreferenceCheckpoint} from './news-feed-adaptive-capture.js';
import {feedWorkerPrefix,feedWorkerIntent,feedWorkerReceipt,feedStopIntent,feedStopReceipt,validateFeedWorkerRecord,
 type FeedWorkerSaved,terminal,same,size,unwrap} from './news-feed-adaptive-worker.js';
import {verifyFeedSemanticRecords,type SemanticRow,type SemanticReceipt} from './news-feed-semantic-journal.js';
import type {FeedWorkerSaved as LegacyWorker} from './news-feed-worker.js';
import type {WorkerIdentity} from './worker.js';
import {resolveControlBaseline,foldControlProof,type ControlBaseline,type ControlProjection} from './news-feed-adaptive-controls.js';

export const adaptiveReviewPrefix='news:semantic-adaptive-review:',adaptiveLearningPrefix='news:semantic-adaptive-learning:',adaptiveControlPrefix='news:semantic-adaptive-control:';
export const adaptivePrefixes=[feedWorkerPrefix,adaptiveReviewPrefix,adaptiveLearningPrefix,adaptiveControlPrefix];
const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),label=z.string().min(1).max(200);
const base={format:z.literal(3),revision:z.literal(1),id:uuid,deviceId:label,at:positive};
export const reviewSchema=z.object({...base,command:adaptiveReviewCommandSchema,preferences:preferenceCheckpointSchema,workerTerminalSha256:sha}).strict();
export type AdaptiveReviewSaved=z.infer<typeof reviewSchema>;
export const learningSchema=z.object({...base,command:adaptiveApplyCommandSchema,before:z.unknown(),after:z.unknown()}).strict();
export type AdaptiveLearningSaved=Omit<z.infer<typeof learningSchema>,'before'|'after'>&{before:AdaptiveSource;after:AdaptiveLearningState};
export const controlSchema=z.object({...base,command:feedCommandSchema,before:z.unknown(),preferencesAfter:preferenceCheckpointSchema,after:z.unknown()}).strict();
export type AdaptiveControlSaved=Omit<z.infer<typeof controlSchema>,'before'|'after'|'preferencesAfter'>&{before:AdaptiveSource;after:AdaptiveLearningState;preferencesAfter:PreferenceCheckpoint};
export const adaptiveReviewReceipt=(record:AdaptiveReviewSaved,hash:(text:string)=>string)=>({type:'feed-semantic-review' as const,format:3 as const,id:record.id,epoch:record.command.epoch,
 requestSha256:adaptiveHash({kind:'accept',command:record.command},hash),operationId:record.command.operationId,planSha256:record.command.planSha256,recordSha256:adaptiveHash(record,hash)});
export const adaptiveLearningReceipt=(record:AdaptiveLearningSaved,hash:(text:string)=>string)=>({type:'feed-semantic-learning' as const,format:3 as const,id:record.id,epoch:record.command.epoch,
 requestSha256:adaptiveHash({kind:'apply-learning',command:record.command},hash),operationId:record.command.operationId,learningRevision:record.after.revision,recordSha256:adaptiveHash(record,hash)});
export const genericReceipt=(id:string,deviceId:string,intent:unknown,value:unknown,hash:(text:string)=>string):SemanticReceipt=>({requestId:id,deviceId,digest:hash(canonical(intent)),value});
export function adaptiveWorkerReceipts(record:FeedWorkerSaved,hash:(text:string)=>string){return [genericReceipt(record.id,record.deviceId,feedWorkerIntent(record.command),feedWorkerReceipt(record,hash),hash),
 ...record.ownerStops.map(stop=>genericReceipt(stop.command.requestId,stop.deviceId,feedStopIntent(stop.command),feedStopReceipt(stop.command,stop.at,hash),hash))];}
function need(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
type SourceGraph={mutations:ReadonlyMap<string,AdaptiveLearningSaved|AdaptiveControlSaved>;receipts:ReadonlyMap<string,SemanticReceipt>};
export function validateAdaptiveSourceParent(source:AdaptiveSource,at:number,prior:AdaptiveLearningSaved|AdaptiveControlSaved|undefined){
 if(source.learningHead===null)need(same(source.context.learning,{revision:1,interests:[],suppressed:[]}),'Initial learning state invented');
 else{need(prior&&prior.deviceId===source.context.deviceId&&prior.command.epoch===source.context.epoch&&prior.at<=at&&same(prior.after,source.context.learning),'Learning state has no original mutation graph');
  const preferences='preferencesAfter' in prior?prior.preferencesAfter:prior.before.preferences;
  need(same(preferences.profile,source.preferences.profile)&&same(preferences.control,source.preferences.control),'Control changes need their original semantic mirror');}
}
export function validateAdaptiveControlProjection(source:AdaptiveSource,at:number,baseline:ControlBaseline,projection:Pick<ControlProjection,'preferences'|'learning'>){
 need(baseline.at<=at,'Control baseline postdates capture');
 need(same(projection.preferences,source.preferences)&&same(projection.learning,source.context.learning),'Captured controls do not match original proof');
}
/** Historical capture validation is limited to its original saved interval.
 * Newer unrelated controls never invalidate an already retained capture. */
export function verifyAdaptiveSourceGraph(graph:SourceGraph,source:AdaptiveSource,at:number,hash:(text:string)=>string){
 const protectedReceiptIds=new Set<string>(),receipt=source.preferences.latestMutation;
 if(receipt){need(same(graph.receipts.get(receipt.requestId),receipt),'Preference checkpoint receipt is missing/changed');protectedReceiptIds.add(receipt.requestId);}
 if(Object.prototype.hasOwnProperty.call(source,'controlProof')){
  need(source.learningHead!==null&&source.controlProof,'Control proof has no original learning head');
  const baseline=resolveControlBaseline(graph,source.context.deviceId,source.context.epoch,source.learningHead,hash);
  const projection=foldControlProof(baseline,source.controlProof,[...graph.receipts.values()],hash);
  validateAdaptiveControlProjection(source,at,baseline,projection);
  for(const id of projection.protectedReceiptIds)protectedReceiptIds.add(id);
 }else validateAdaptiveSourceParent(source,at,source.learningHead===null?undefined:graph.mutations.get(source.learningHead));
 return protectedReceiptIds;
}
/** Current application/start uses the latest owner head, in addition to the
 * captured interval proof. This is not caller or model authorization. */
export function requireCurrentAdaptiveSource(graph:SourceGraph,source:AdaptiveSource,owner:string,epoch:string,at:number,hash:(text:string)=>string){
 need(source.context.deviceId===owner&&source.context.epoch===epoch,'Current adaptive source owner changed');validateAdaptiveSource(source,at,hash);
 const mutations=[...graph.mutations.values()].filter(row=>row.deviceId===owner&&row.command.epoch===epoch),parents=new Set(mutations.map(row=>row.before.learningHead)),heads=mutations.filter(row=>!parents.has(row.id));
 need(heads.length<=1&&source.learningHead===(heads[0]?.id??null),'Current adaptive learning head changed');
 verifyAdaptiveSourceGraph(graph,source,at,hash);return source;
}
export function validateAdaptiveReview(raw:unknown,worker:FeedWorkerSaved,hash:(text:string)=>string){
 const record=reviewSchema.parse(raw),c=record.command;
 need(same(raw,record)&&record.id===c.requestId&&record.deviceId===worker.deviceId&&c.epoch===worker.command.epoch&&c.operationId===worker.id,'Foreign adaptive review');
 need(worker.state==='completed'&&worker.capture.kind==='interpret'&&worker.output?.text&&worker.terminal?.kind==='reply'&&record.at>=worker.terminal.at,'Adaptive review needs a completed interpretation');
 const parsed=unwrap(readAdaptiveWrittenPlan(worker.output.text,worker.capture.brief,hash));
 need(record.workerTerminalSha256===adaptiveHash(worker.terminal,hash)&&c.terminalSha256===record.workerTerminalSha256&&c.expectedRevision===record.preferences.profile.revision&&
  c.briefSha256===worker.capture.brief.briefSha256&&c.planSha256===parsed.planSha256,'Adaptive review target changed');
 const approval=unwrap(captureAdaptiveApproval({epoch:c.epoch,deviceId:record.deviceId,profile:record.preferences.profile},worker.capture.brief,parsed.plan,record.id,record.at,hash));
 return {record,source:{kind:'accepted',capture:worker.capture.brief,plan:parsed.plan,approval} satisfies AdaptiveWrittenBasis};
}
export function deriveAdaptiveControl(before:AdaptiveSource,command:FeedCommand,at:number,hash:(text:string)=>string){
 if(command.expectedRevision!==before.preferences.savedRevision||command.epoch!==before.context.epoch)throw new Error('Original control revision changed');
 let profile=structuredClone(before.context.profile),control=structuredClone(before.context.control),learning=structuredClone(before.context.learning);
 const context=before.context,stamp=new Date(at).toISOString();
 if(command.type==='settings')profile.settings=structuredClone(command.settings);
 else if(command.type==='learning-reset'){const next=unwrap(resetAdaptiveLearning(context,stamp));profile=next.profile;control=next.control;learning=next.learning;}
 else if(command.type==='interest'){
  const key=feedTopicKey(command.topic),interest=learning.interests.find(row=>feedTopicKey(row.label)===key),suppression=learning.suppressed.find(row=>feedTopicKey(row.label)===key);
  if(command.action==='stop'&&interest){const next=unwrap(stopAdaptiveInterest(context,interest.id,at,hash));learning=next.learning;}
  if(command.action==='allow'&&suppression){const next=unwrap(allowAdaptiveInterest(context,suppression.interestId));learning=next.learning;}
  const without=(rows:string[])=>rows.filter(topic=>feedTopicKey(topic)!==key);
  if(command.action==='keep'){control.kept=[...without(control.kept),command.topic];control.stopped=without(control.stopped);}
  else if(command.action==='stop'){control.stopped=[...without(control.stopped),command.topic];control.kept=without(control.kept);}
  else control.stopped=without(control.stopped);
 }else throw new Error('Command does not change adaptive preferences');
 if(learning.revision===context.learning.revision)learning.revision++;
 profile.revision++;profile.updatedAt=stamp;
 return {profile,control,learning};
}
/** Shared strict local rules; caller must separately prove graph/receipt closure. */
export function validateAdaptiveWorkerRow(row:SemanticRow,hash:(text:string)=>string,nativeIdentity:(value:WorkerIdentity)=>{runId:string;sessionKey:string}){
 const value=validateFeedWorkerRecord(row.value as FeedWorkerSaved,hash,nativeIdentity);
 need(row.id===feedWorkerPrefix+value.id&&row.revision===value.revision,'Adaptive worker key changed');return value;
}
export function validateAdaptiveReviewRow(row:SemanticRow,worker:FeedWorkerSaved,hash:(text:string)=>string){
 const value=validateAdaptiveReview(row.value,worker,hash);need(row.id===adaptiveReviewPrefix+value.record.id&&row.revision===1,'Adaptive review key changed');return value;
}
export function validateAdaptiveMutationRow(row:SemanticRow,worker:FeedWorkerSaved|undefined,receipt:SemanticReceipt|undefined,hash:(text:string)=>string){
 const isLearning=row.id.startsWith(adaptiveLearningPrefix),record=(isLearning?learningSchema:controlSchema).parse(row.value) as AdaptiveLearningSaved|AdaptiveControlSaved;
 need(same(record,row.value)&&row.id===(isLearning?adaptiveLearningPrefix:adaptiveControlPrefix)+record.id&&row.revision===1&&record.id===record.command.requestId&&
  record.deviceId===record.before.context.deviceId&&record.command.epoch===record.before.context.epoch&&size(record)<=adaptiveWorkerBounds.mutationBytes,'Adaptive mutation identity/bound changed');
 validateAdaptiveSource(record.before,record.at,hash);
 if(isLearning){const value=record as AdaptiveLearningSaved,c=value.command;
  need(worker?.state==='completed'&&worker.capture.kind==='learn'&&worker.output?.text&&worker.terminal&&record.at>=worker.terminal.at,'Learning application needs completed original');
  need(worker.deviceId===record.deviceId&&worker.command.epoch===c.epoch&&c.terminalSha256===adaptiveHash(worker.terminal,hash)&&c.captureSha256===worker.capture.learning.captureSha256&&
   c.expectedLearningRevision===record.before.context.learning.revision&&same(record.before,worker.capture.source),'Learning application target/current capture changed');
  const parsed=unwrap(readAdaptiveLearning(worker.output.text,worker.capture.learning,hash));
  const after=unwrap(applyAdaptiveLearning(record.before.context,worker.capture.learning,parsed.result,record.at,hash));need(same(after,record.after),'Learning application invented state');
 }else{const value=record as AdaptiveControlSaved,after=deriveAdaptiveControl(value.before,value.command,value.at,hash),result=receipt?.value as any;
  need(receipt&&receipt.deviceId===value.deviceId&&receipt.digest===hash(canonical({type:'news.command',command:value.command}))&&result?.format===1&&result.state==='saved'&&
   same(result.command,value.command)&&result.requestId===value.id&&result.epoch===value.command.epoch&&Date.parse(result.at)===value.at&&result.revision===value.before.preferences.savedRevision+1&&
   result.profileRevision===after.profile.revision,'Control mirror lacks exact original news.command receipt');
  need(same(value.after,after.learning)&&same(value.preferencesAfter,{format:1,kind:'authenticated-current-state',savedRevision:result.revision,profile:after.profile,control:after.control,latestMutation:receipt}),
   'Control mirror differs from original saved mutation');
 }
 return record;
}
export function validateAdaptiveAcceptedBasis(worker:FeedWorkerSaved,review:ReturnType<typeof validateAdaptiveReview>|undefined){
 if(worker.capture.basis?.kind==='accepted')need(review&&review.record.at<=worker.createdAt&&same(review.source,worker.capture.basis),'Worker lacks original accepted writing');
}
export function verifyAdaptiveRecords(schema:number,rows:SemanticRow[],receipts:SemanticReceipt[],hash:(text:string)=>string,nativeIdentity:(value:WorkerIdentity)=>{runId:string;sessionKey:string}){
 const ownedRows=rows.filter(row=>adaptivePrefixes.some(prefix=>row.id.startsWith(prefix)));
 const ownedReceipts=receipts.filter(row=>(row.value as any)?.format===3&&(row.value as any)?.type?.startsWith('feed-semantic-'));
 const legacy=verifyFeedSemanticRecords(schema,rows.filter(row=>!adaptivePrefixes.some(prefix=>row.id.startsWith(prefix))),receipts.filter(row=>!ownedReceipts.includes(row)),hash,nativeIdentity);
 const receiptMap=new Map(receipts.map(row=>[row.requestId,row]));need(receiptMap.size===receipts.length,'Duplicate original receipt');
 if(ownedRows.length||ownedReceipts.length)need(schema>=60,'Adaptive authority requires reviewed future schema');
 const adaptiveWorkers=new Map<string,FeedWorkerSaved>(),adaptiveReviews=new Map<string,ReturnType<typeof validateAdaptiveReview>>(),learning=new Map<string,AdaptiveLearningSaved>(),controls=new Map<string,AdaptiveControlSaved>();
 const identities=new Set<string>();
 for(const row of ownedRows){need(!identities.has(row.id),'Duplicate adaptive row');identities.add(row.id);
  if(row.id.startsWith(feedWorkerPrefix)){const value=validateAdaptiveWorkerRow(row,hash,nativeIdentity);adaptiveWorkers.set(value.id,value);}
 }
 for(const row of ownedRows)if(row.id.startsWith(adaptiveReviewPrefix)){const raw=reviewSchema.parse(row.value),worker=adaptiveWorkers.get(raw.command.operationId);need(worker,'Adaptive review original missing');
  const value=validateAdaptiveReviewRow(row,worker,hash);adaptiveReviews.set(value.record.id,value);}
 for(const row of ownedRows)if(row.id.startsWith(adaptiveLearningPrefix)||row.id.startsWith(adaptiveControlPrefix)){
  const isLearning=row.id.startsWith(adaptiveLearningPrefix),raw=(isLearning?learningSchema:controlSchema).parse(row.value);
  const record=validateAdaptiveMutationRow(row,isLearning?adaptiveWorkers.get((raw.command as AdaptiveApplyCommand).operationId):undefined,receiptMap.get(raw.id),hash);
  if(isLearning)learning.set(record.id,record as AdaptiveLearningSaved);else controls.set(record.id,record as AdaptiveControlSaved);
 }
 const mutations=new Map<string,AdaptiveLearningSaved|AdaptiveControlSaved>([...learning,...controls]),expected=new Map<string,SemanticReceipt>();
 const add=(receipt:SemanticReceipt)=>{need(!expected.has(receipt.requestId)&&!legacy.workers.has(receipt.requestId)&&!legacy.reviews.has(receipt.requestId),'Adaptive original ID reused');
  need(same(receiptMap.get(receipt.requestId),receipt),'Adaptive original receipt missing or changed');expected.set(receipt.requestId,receipt);};
 for(const value of adaptiveWorkers.values())for(const receipt of adaptiveWorkerReceipts(value,hash))add(receipt);
 for(const {record} of adaptiveReviews.values())add(genericReceipt(record.id,record.deviceId,adaptiveReviewIntent(record.command),adaptiveReviewReceipt(record,hash),hash));
 for(const record of learning.values())add(genericReceipt(record.id,record.deviceId,adaptiveApplyIntent(record.command),adaptiveLearningReceipt(record,hash),hash));
 for(const record of controls.values())add(receiptMap.get(record.id)!);
 for(const receipt of ownedReceipts){adaptiveAdmissionSchema.parse(receipt.value);need(expected.has(receipt.requestId),'Adaptive receipt has no original record');}
 const protectedControlReceiptIds=new Set<string>();
 const sourceCheck=(source:AdaptiveSource,at:number)=>{for(const id of verifyAdaptiveSourceGraph({mutations,receipts:receiptMap},source,at,hash))protectedControlReceiptIds.add(id);};
 const child=new Map<string,string>();
 for(const record of mutations.values()){sourceCheck(record.before,record.at);const parent=record.before.learningHead??record.command.epoch+':'+record.deviceId;
  need(!child.has(parent),'Adaptive learning mutation graph forked');child.set(parent,record.id);
  need(record.after.revision===record.before.context.learning.revision+1,'Learning revision skipped');
  const seen=new Set<string>([record.id]);let prior=record.before.learningHead;while(prior){need(!seen.has(prior),'Adaptive mutation graph cycles');seen.add(prior);prior=mutations.get(prior)?.before.learningHead??null;}
 }
 for(const worker of adaptiveWorkers.values()){
  if(worker.capture.kind!=='interpret')sourceCheck(worker.capture.source,worker.createdAt);
  else {const receipt=worker.capture.source.preferences.latestMutation;if(receipt){need(same(receiptMap.get(receipt.requestId),receipt),'Writing checkpoint receipt changed');protectedControlReceiptIds.add(receipt.requestId);}}
  if(worker.capture.basis?.kind==='accepted')validateAdaptiveAcceptedBasis(worker,adaptiveReviews.get(worker.capture.basis.approval.reviewRequestId));
 }
 for(const {record} of adaptiveReviews.values()){const receipt=record.preferences.latestMutation as SemanticReceipt|undefined;if(receipt){need(same(receiptMap.get(receipt.requestId),receipt),'Review current preference receipt changed');protectedControlReceiptIds.add(receipt.requestId);}}
 for(const record of controls.values()){const receipt=record.preferencesAfter.latestMutation;if(receipt)protectedControlReceiptIds.add(receipt.requestId);}
 const workers=new Map<string,LegacyWorker|FeedWorkerSaved>([...legacy.workers,...adaptiveWorkers]);
 type LegacyReview=ReturnType<typeof verifyFeedSemanticRecords>['reviews'] extends Map<string,infer T>?T:never;
 const reviews=new Map<string,LegacyReview|ReturnType<typeof validateAdaptiveReview>>([...legacy.reviews,...adaptiveReviews]);
 need([...workers.values()].filter(value=>!['completed','failed','cancelled','withdrawn','rejected'].includes(value.state)).length<=1,'More than one unresolved Feed original');
 const relevantRows=rows.filter(row=>row.id.startsWith('news:semantic-')),relevantReceipts=receipts.filter(row=>expected.has(row.requestId)||(row.value as any)?.type?.startsWith('feed-semantic-'));
 need(relevantRows.length<=adaptiveWorkerBounds.records&&relevantRows.reduce((n,row)=>n+size(row.value),0)+relevantReceipts.reduce((n,row)=>n+size(row),0)<=adaptiveWorkerBounds.bytes,'Adaptive storage cap exceeded');
 return {...legacy,workers,reviews,adaptiveWorkers,adaptiveReviews,learning,controls,mutations,expected,protectedControlReceiptIds};
}
