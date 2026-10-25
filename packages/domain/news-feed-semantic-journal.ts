import {z} from 'zod';
import {canonical} from './contracts.js';
import {captureFeedBrief,readFeedInterpretation,type FeedSemanticContext} from './news-feed-interpretation.js';
import {feedWorkerPrefix,feedWorkerLimits,feedWorkerIntent,feedWorkerReceipt,feedStopIntent,feedStopReceipt,validateFeedWorkerRecord,
 same,size,terminal,type FeedWorkerSaved,type FeedReviewedSource} from './news-feed-worker.js';
import {evidenceDigest} from './news-feed-worker-evidence.js';
import type {WorkerIdentity} from './worker.js';

export const feedSemanticPrefix='news:semantic-',feedReviewPrefix='news:semantic-review:';
const uuid=z.string().uuid(),hashSchema=z.string().regex(/^[a-f0-9]{64}$/),label=z.string().min(1).max(200);
export const feedReviewCommandSchema=z.object({requestId:uuid,epoch:uuid,operationId:uuid,expectedRevision:z.number().int().positive(),
 briefSha256:hashSchema,planSha256:hashSchema}).strict();
export type FeedReviewCommand=z.infer<typeof feedReviewCommandSchema>;
export const reviewSchema=z.object({format:z.literal(2),revision:z.literal(1),id:uuid,deviceId:label,at:z.number().int().positive(),command:feedReviewCommandSchema,
 currentContext:z.unknown(),workerTerminalSha256:hashSchema}).strict();
export type FeedReviewSaved=z.infer<typeof reviewSchema>&{currentContext:FeedSemanticContext};
export const feedReviewIntent=(command:FeedReviewCommand)=>({type:'feed-semantic-review',command});
export const feedReviewReceipt=(value:FeedReviewSaved,hash:(text:string)=>string)=>({type:'feed-semantic-review' as const,format:2 as const,id:value.id,epoch:value.command.epoch,
 operationId:value.command.operationId,planSha256:value.command.planSha256,recordSha256:evidenceDigest(value,hash)});
export type SemanticRow={id:string;revision:number;value:unknown};
export type SemanticReceipt={requestId:string;deviceId:string;digest:string;value:unknown};
export const hasFeedSemanticReceipt=(value:unknown)=>!!value&&typeof value==='object'&&'type' in value&&typeof value.type==='string'&&value.type.startsWith('feed-semantic-');
function need(yes:unknown,message:string):asserts yes{if(!yes)throw new Error(message);}

export function validateFeedReview(raw:unknown,worker:FeedWorkerSaved,hash:(text:string)=>string):{record:FeedReviewSaved;source:FeedReviewedSource}{
 const record=reviewSchema.parse(raw) as FeedReviewSaved,command=record.command;
 need(same(raw,record)&&record.id===command.requestId&&record.deviceId===worker.deviceId&&command.epoch===worker.command.epoch&&command.operationId===worker.id,
  'The accepted review has a foreign original identity');
 need(worker.state==='completed'&&worker.capture.kind==='interpret'&&worker.output?.text&&worker.terminal?.kind==='reply'&&record.at>=worker.terminal.at,
  'The accepted review needs a completed original interpretation');
 need(record.workerTerminalSha256===evidenceDigest(worker.terminal,hash),'The accepted review terminal basis changed');
 const brief=captureFeedBrief(record.currentContext,worker.capture.brief.requestId,hash),parsed=readFeedInterpretation(worker.output.text,worker.capture.brief,hash);
 need(brief.ok&&brief.value.briefSha256===worker.capture.brief.briefSha256&&parsed.ok&&parsed.value.status==='reviewable'&&
  command.expectedRevision===worker.capture.brief.profile.revision&&command.briefSha256===worker.capture.brief.briefSha256&&command.planSha256===parsed.value.planSha256,
  'The accepted review differs from the exact current writing or reviewable plan');
 const source:FeedReviewedSource={brief:worker.capture.brief,plan:parsed.value.plan,review:{format:1,state:'accepted',reviewRequestId:record.id,
  binding:worker.capture.brief.binding,briefSha256:command.briefSha256,planSha256:command.planSha256}};
 return {record,source};
}

export function expectedReceipts(value:FeedWorkerSaved|FeedReviewSaved,hash:(text:string)=>string):SemanticReceipt[]{
 const receipt=(requestId:string,deviceId:string,intent:unknown,result:unknown)=>({requestId,deviceId,digest:hash(canonical(intent)),value:result});
 if('capture' in value)return [receipt(value.id,value.deviceId,feedWorkerIntent(value.command),feedWorkerReceipt(value,hash)),
  ...value.ownerStops.map(stop=>receipt(stop.command.requestId,stop.deviceId,feedStopIntent(stop.command),feedStopReceipt(stop.command,stop.at)))];
 return [receipt(value.id,value.deviceId,feedReviewIntent(value.command),feedReviewReceipt(value,hash))];
}
/** Includes the exact encrypted-receipt plaintext representation for these rows,
 * not only service values. Digest length is fixed; callers can use the maintained hash. */
export function feedSemanticStorageBytes(values:(FeedWorkerSaved|FeedReviewSaved)[],hash:(text:string)=>string){
 return values.reduce((total,value)=>total+size(value)+expectedReceipts(value,hash).reduce((n,receipt)=>n+size(receipt),0),0);
}

/** Shared exact local rules. Neither function grants whole-graph validity. */
export function validateLegacyWorkerRow(row:SemanticRow,hash:(text:string)=>string,nativeIdentity:(value:WorkerIdentity)=>{runId:string;sessionKey:string}){
 const value=validateFeedWorkerRecord(row.value as FeedWorkerSaved,hash,nativeIdentity);
 need(row.id===feedWorkerPrefix+value.id&&row.revision===value.revision,'Original worker key/revision changed');return value;
}
export function validateLegacyReviewRow(row:SemanticRow,worker:FeedWorkerSaved,hash:(text:string)=>string){
 const reviewed=validateFeedReview(row.value,worker,hash);need(row.id===feedReviewPrefix+reviewed.record.id&&row.revision===1,'Accepted review key/revision changed');return reviewed;
}
export function validateLegacyClassificationBasis(value:FeedWorkerSaved,reviewed:ReturnType<typeof validateFeedReview>|undefined){
 if(value.capture.kind!=='classify')return;
 need(reviewed&&reviewed.record.command.epoch===value.command.epoch&&reviewed.record.deviceId===value.deviceId&&
  reviewed.record.at<=value.createdAt&&same(reviewed.source,{brief:value.capture.brief,plan:value.capture.plan,review:value.capture.review}),
  'Classification has no exact original accepted review');
}

/** Pure graph only. Caller must authenticate/decrypt rows and receipts before
 * invoking this BEFORE any startup/import write. A recovered old epoch is kept
 * structurally intact; this verifier grants no current dispatch authority. */
export function verifyFeedSemanticRecords(schema:number,rows:SemanticRow[],receipts:SemanticReceipt[],hash:(text:string)=>string,
 nativeIdentity:(value:WorkerIdentity)=>{runId:string;sessionKey:string}){
 const relevant=rows.filter(row=>row.id.startsWith(feedSemanticPrefix)),originals=receipts.filter(row=>hasFeedSemanticReceipt(row.value));
 const workers=new Map<string,FeedWorkerSaved>(),reviews=new Map<string,{record:FeedReviewSaved;source:FeedReviewedSource}>();
 if(!relevant.length&&!originals.length)return {workers,reviews};
 need(schema>=60,'Semantic Feed authority requires schema60');need(relevant.length<=feedWorkerLimits.records,'Semantic Feed record bound exceeded');
 const receiptMap=new Map(receipts.map(row=>[row.requestId,row]));need(receiptMap.size===receipts.length,'Original receipt identity duplicated');
 const keys=new Set<string>(),reviewRows:SemanticRow[]=[];
 for(const row of relevant){need(!keys.has(row.id),'Semantic Feed record key duplicated');keys.add(row.id);
  if(row.id.startsWith(feedWorkerPrefix)){const value=validateLegacyWorkerRow(row,hash,nativeIdentity);workers.set(value.id,value);
  }else if(row.id.startsWith(feedReviewPrefix))reviewRows.push(row);
  else throw new Error('Unsupported Semantic Feed namespace record');
 }
 for(const row of reviewRows){const raw=reviewSchema.parse(row.value),worker=workers.get(raw.command.operationId);need(worker,'Accepted review original is missing');
  const reviewed=validateLegacyReviewRow(row,worker,hash);
  reviews.set(reviewed.record.id,reviewed);
 }
 need([...workers.values()].filter(value=>!terminal(value)).length<=1,'More than one unresolved original Feed worker');
 const values=[...workers.values(),...reviews.values()].map(value=>'record' in value?value.record:value),expected=new Map<string,SemanticReceipt>();
 need(feedSemanticStorageBytes(values,hash)<=feedWorkerLimits.bytes,'Semantic Feed storage byte bound exceeded');
 for(const value of values)for(const receipt of expectedReceipts(value,hash)){
  need(!expected.has(receipt.requestId),'Feed admission identity used more than once');expected.set(receipt.requestId,receipt);
  need(same(receiptMap.get(receipt.requestId),receipt),'Original Feed admission receipt is missing or changed');
 }
 for(const receipt of originals)need(expected.has(receipt.requestId),'Original Feed receipt has no retained record');
 for(const value of workers.values())if(value.capture.kind==='classify'){
  validateLegacyClassificationBasis(value,reviews.get(value.capture.review.reviewRequestId));
 }
 return {workers,reviews};
}
