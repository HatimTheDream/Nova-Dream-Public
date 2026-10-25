import {z} from 'zod';
import {adaptiveContextSchema,adaptiveHash,adaptiveCanonical,type AdaptiveLearningState} from './news-feed-adaptive.js';
import {feedCommandSchema,feedProfileSchema,feedLearningControlSchema,feedTopicKey,type FeedCommand,type FeedProfile,type FeedLearningControl} from './news-feed.js';
import type {PreferenceCheckpoint} from './news-feed-adaptive-capture.js';
import type {SemanticReceipt} from './news-feed-semantic-journal.js';

const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),sha=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
export const feedControlProofSchema=z.object({format:z.literal(1),baseline:z.object({learningHead:uuid,recordSha256:sha,preferencesSha256:sha,learningSha256:sha}).strict(),
 fromRevision:positive,toRevision:positive,chainSha256:sha}).strict();
export type FeedControlProof=z.infer<typeof feedControlProofSchema>;
type Hash=(text:string)=>string;
type Reduced={profile:FeedProfile;control:FeedLearningControl;learning:AdaptiveLearningState};
export type ControlMutation={id:string;deviceId:string;command:{epoch:string};at:number;before:{preferences:PreferenceCheckpoint};after:AdaptiveLearningState;preferencesAfter?:PreferenceCheckpoint};
export type ControlBaseline={epoch:string;deviceId:string;head:string;recordSha256:string;preferences:PreferenceCheckpoint;learning:AdaptiveLearningState;at:number};
export type ControlProjection={preferences:PreferenceCheckpoint;learning:AdaptiveLearningState;protectedReceiptIds:Set<string>};
const equal=(a:unknown,b:unknown)=>adaptiveCanonical(a)===adaptiveCanonical(b);
function need(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
const instant=z.string().datetime({offset:true});
const savedSchema=z.object({format:z.literal(1),requestId:uuid,epoch:uuid,command:feedCommandSchema,at:instant,state:z.literal('saved'),revision:positive,profileRevision:positive}).strict();
const outerSchema=z.object({requestId:uuid,deviceId:z.string().min(1).max(200),digest:sha,value:z.unknown()}).strict();

/** Projects already admitted controls only. It does not collect activity or
 * decide whether an old reading action would be eligible today. */
export function reduceAdaptiveControl(input:Reduced,commandInput:FeedCommand,at:string,hash:Hash):Reduced{
 const command=feedCommandSchema.parse(commandInput);need(equal(command,commandInput),'Control command changed');instant.parse(at);
 const profile=feedProfileSchema.parse(structuredClone(input.profile)),control=feedLearningControlSchema.parse(structuredClone(input.control));
 const learning=adaptiveContextSchema.shape.learning.parse(structuredClone(input.learning));
 if(!['settings','interest','learning-reset'].includes(command.type))return {profile,control,learning};
 if(command.type==='settings')profile.settings=structuredClone(command.settings);
 else if(command.type==='learning-reset'){profile.settings.learning.paused=true;control.resetAt=at;learning.interests=[];}
 else if(command.type==='interest'){
  const key=feedTopicKey(command.topic),interest=learning.interests.find(row=>feedTopicKey(row.label)===key),suppression=learning.suppressed.find(row=>feedTopicKey(row.label)===key);
  const without=(rows:string[])=>rows.filter(topic=>feedTopicKey(topic)!==key);
  if(command.action==='stop'&&interest){const {id,...body}=interest;need(adaptiveHash(body,hash)===id,'Stopped interest proof changed');
   learning.interests=learning.interests.filter(row=>row.id!==id);learning.suppressed=[...learning.suppressed.filter(row=>row.interestId!==id),
    {interestId:id,label:interest.label,at:Date.parse(at),supports:interest.supports.map(({eventId,source,sourceId})=>({eventId,source,sourceId}))}];}
  if(command.action==='allow'&&suppression)learning.suppressed=learning.suppressed.filter(row=>row.interestId!==suppression.interestId);
  if(command.action==='keep'){control.kept=[...without(control.kept),command.topic];control.stopped=without(control.stopped);}
  else if(command.action==='stop'){control.stopped=[...without(control.stopped),command.topic];control.kept=without(control.kept);}
  else control.stopped=without(control.stopped);
 }
 learning.revision++;profile.revision++;profile.updatedAt=at;
 return {profile:feedProfileSchema.parse(profile),control:feedLearningControlSchema.parse(control),learning:adaptiveContextSchema.shape.learning.parse(learning)};
}

/** graph must already be fully verified, from the same authenticated snapshot. */
export function resolveControlBaseline(graph:{mutations:ReadonlyMap<string,ControlMutation>},owner:string,epoch:string,head:string,hash:Hash):ControlBaseline{
 const row=graph.mutations.get(head);need(row&&row.id===head&&row.deviceId===owner&&row.command.epoch===epoch,'Control baseline owner/head changed');
 const preferences=row.preferencesAfter??row.before.preferences;
 return {epoch,deviceId:owner,head,recordSha256:adaptiveHash(row,hash),preferences:structuredClone(preferences),learning:structuredClone(row.after),at:row.at};
}
function baselineIdentity(base:ControlBaseline,hash:Hash){return {learningHead:base.head,recordSha256:base.recordSha256,
 preferencesSha256:adaptiveHash(base.preferences,hash),learningSha256:adaptiveHash(base.learning,hash)};}

/** Shared exact candidate parser. A missing candidate still leaves a required
 * saved-revision gap; unrelated/rejected receipts are never silently steps. */
export function readSavedControlStep(receipt:SemanticReceipt,epoch:string,from:number,to:number,hash:Hash){
 const raw=receipt.value as any;
 if(raw?.format!==1||raw.state!=='saved'||raw.epoch!==epoch||!Number.isSafeInteger(raw.revision)||raw.revision<=from||raw.revision>to)return undefined;
 const command=feedCommandSchema.safeParse(raw.command);if(!command.success)return undefined;
 const value=savedSchema.parse(raw);outerSchema.parse(receipt);
 need(equal(value,raw)&&equal(command.data,raw.command)&&receipt.requestId===value.requestId&&value.requestId===value.command.requestId&&
  value.epoch===value.command.epoch&&receipt.digest===adaptiveHash({type:'news.command',command:value.command},hash),'Original control envelope changed');
 return value;
}
function reduceControlSequence(base:ControlBaseline,to:number,steps:Iterable<SemanticReceipt>,receipt:(id:string)=>SemanticReceipt|undefined,
 hash:Hash,visit:(value:SemanticReceipt)=>void){
 positive.parse(to);need(to>=base.preferences.savedRevision,'Control target revision precedes baseline');
 let preferences=structuredClone(base.preferences),learning=structuredClone(base.learning);
 if(preferences.latestMutation){const old=preferences.latestMutation;need(equal(receipt(old.requestId),old),'Baseline preference receipt missing');visit(old);}
 for(const original of steps){const value=readSavedControlStep(original,base.epoch,base.preferences.savedRevision,to,hash);
  need(value&&value.revision===preferences.savedRevision+1&&value.command.expectedRevision===preferences.savedRevision,'Control revision chain forked or skipped');
  const reduced=reduceAdaptiveControl({profile:preferences.profile,control:preferences.control,learning},value.command,value.at,hash);
  need(value.profileRevision===reduced.profile.revision,'Original control profile revision changed');learning=reduced.learning;
  preferences={format:1,kind:'authenticated-current-state',savedRevision:value.revision,profile:reduced.profile,control:reduced.control,latestMutation:structuredClone(original)};visit(original);
 }
 need(preferences.savedRevision===to,'Complete control revision interval is unavailable');return {preferences,learning};
}
/** Complete actual receipts are required. Existing bounded callers retain the
 * same duplicate/global selection checks and array hash representation. */
function interval(base:ControlBaseline,to:number,receipts:readonly SemanticReceipt[],hash:Hash){
 positive.parse(to);need(to>=base.preferences.savedRevision,'Control target revision precedes baseline');
 const selected:{receipt:SemanticReceipt;value:z.infer<typeof savedSchema>}[]=[],ids=new Set<string>();
 for(const receipt of receipts){need(!ids.has(receipt.requestId),'Duplicate original control receipt key');ids.add(receipt.requestId);
  const value=readSavedControlStep(receipt,base.epoch,base.preferences.savedRevision,to,hash);if(value)selected.push({receipt,value});}
 selected.sort((a,b)=>a.value.revision-b.value.revision);need(selected.length===to-base.preferences.savedRevision,'Complete control revision interval is unavailable');
 const protectedReceiptIds=new Set<string>(),chain=selected.map(row=>row.receipt);
 const projection=reduceControlSequence(base,to,chain,id=>receipts.find(row=>row.requestId===id),hash,row=>protectedReceiptIds.add(row.requestId));
 return {...projection,protectedReceiptIds,chain};
}
export function validateControlProofDescriptor(base:ControlBaseline,raw:FeedControlProof,hash:Hash){
 const proof=feedControlProofSchema.parse(raw);need(equal(raw,proof)&&new TextEncoder().encode(adaptiveCanonical(raw)).byteLength<=4096,'Control proof descriptor changed');
 need(equal(proof.baseline,baselineIdentity(base,hash))&&proof.fromRevision===base.preferences.savedRevision,'Original control baseline changed');return proof;
}
export type ControlReceiptIndex={receipt:(id:string)=>SemanticReceipt|undefined;revision:(epoch:string,revision:number)=>SemanticReceipt|undefined};
export type ControlHashStream=()=>{update:(part:string)=>void;digest:()=>string};
/** Pure indexed counterpart. Complete snapshot verification must separately
 * prove the revision index bidirectionally against every actual receipt.
 * No array of receipt bodies or protected IDs is retained by this function. */
export function foldControlProofIndexed(base:ControlBaseline,raw:FeedControlProof,index:ControlReceiptIndex,hash:Hash,
 stream:ControlHashStream,visit:(value:SemanticReceipt)=>void){
 const proof=validateControlProofDescriptor(base,raw,hash),writer=stream();let first=true;
 writer.update('[');
 function* steps(){for(let revision=proof.fromRevision+1;revision<=proof.toRevision;revision++){
  const receipt=index.revision(base.epoch,revision);need(receipt,'Complete control revision interval is unavailable');
  if(!first)writer.update(',');first=false;writer.update(adaptiveCanonical(receipt));yield receipt;
 }}
 const projection=reduceControlSequence(base,proof.toRevision,steps(),index.receipt,hash,visit);writer.update(']');
 need(writer.digest()===proof.chainSha256,'Original control interval changed');return projection;
}
export function foldControlProof(base:ControlBaseline,raw:FeedControlProof,receipts:readonly SemanticReceipt[],hash:Hash):ControlProjection{
 const proof=validateControlProofDescriptor(base,raw,hash);
 const {chain,...projection}=interval(base,proof.toRevision,receipts,hash);need(adaptiveHash(chain,hash)===proof.chainSha256,'Original control interval changed');return projection;
}
export function makeControlProof(base:ControlBaseline,current:PreferenceCheckpoint,receipts:readonly SemanticReceipt[],hash:Hash){
 const {chain,...projection}=interval(base,current.savedRevision,receipts,hash);need(equal(projection.preferences,current),'Current preferences do not match complete saved controls');
 const proof:FeedControlProof={format:1,baseline:baselineIdentity(base,hash),fromRevision:base.preferences.savedRevision,toRevision:current.savedRevision,chainSha256:adaptiveHash(chain,hash)};
 feedControlProofSchema.parse(proof);return {proof,projection};
}
