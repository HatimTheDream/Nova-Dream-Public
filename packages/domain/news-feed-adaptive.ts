import {z} from 'zod';
import {feedProfileSchema,feedLearningControlSchema,feedStorySchema,feedHardFilter,feedContainsTopic,feedTopicKey,interpretFeedProfile,
 type FeedProfile,type FeedStory,type FeedLearningControl} from './news-feed.js';
import {feedBriefSpanSchema,feedPreviewSpanSchema,type FeedBriefSpan,type FeedPreviewSpan} from './news-feed-interpretation.js';
import {feedEvidenceStrength,permittedStrengthEvidence,sameFeedTopic} from './news-feed-learning-strength.js';

/** Versioned pure contracts only. Trusted source/Store admission/native result
 * provenance must be joined by the future service; shape checks grant no access. */
export const adaptiveLimits={inputBytes:131072,resultBytes:32768,activity:128,interests:64,candidates:32,supports:8,rules:32,suppressions:64} as const;
const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/),identity=z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/);
const smallId=z.string().min(1).max(48).regex(/^[a-zA-Z0-9_-]+$/),positive=z.number().int().positive(),instant=z.string().datetime();
const label=z.string().trim().min(1).max(80).refine(v=>!/\p{Cc}/u.test(v));
const span=z.object({start:z.number().int().min(0),end:z.number().int().positive(),quote:z.string().min(1).max(2000)}).strict();
export type AdaptiveDigest=(text:string)=>string;
export type AdaptiveResult<T>={ok:true;value:T}|{ok:false;reason:string};
const fail=(reason:string):AdaptiveResult<never>=>({ok:false,reason});
function unicode(text:string){for(let i=0;i<text.length;i++){const n=text.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(n>=0xdc00&&n<=0xdfff)return false;}return true;}
export function adaptiveCanonical(value:unknown):string{
 if(typeof value==='string'){if(!unicode(value))throw new Error('Invalid Unicode');return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(adaptiveCanonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>adaptiveCanonical(k)+':'+adaptiveCanonical(v)).join(',')+'}';
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);throw new Error('Unsupported value');
}
const same=(a:unknown,b:unknown)=>adaptiveCanonical(a)===adaptiveCanonical(b),bytes=(text:string)=>new TextEncoder().encode(text).byteLength;
export const adaptiveHash=(value:unknown,hash:AdaptiveDigest)=>digest.parse(hash(adaptiveCanonical(value)));
const bounded=(value:unknown,max=adaptiveLimits.inputBytes)=>bytes(adaptiveCanonical(value))<=max;
function exact<T>(schema:z.ZodType<T>,value:unknown):T{const parsed=schema.parse(value);if(!same(parsed,value))throw new Error('Noncanonical value');return parsed;}
function rawJson(text:string){if(!unicode(text)||bytes(text)>adaptiveLimits.resultBytes)throw new Error('Result bound');return JSON.parse(text) as unknown;}
function boundary(text:string,n:number){return n===0||n===text.length||!(text.charCodeAt(n)>=0xdc00&&text.charCodeAt(n)<=0xdfff&&text.charCodeAt(n-1)>=0xd800&&text.charCodeAt(n-1)<=0xdbff);}
function exactSpan(text:string|undefined,part:z.infer<typeof span>){return text!==undefined&&unicode(text)&&part.start<part.end&&part.end<=text.length&&boundary(text,part.start)&&boundary(text,part.end)&&text.slice(part.start,part.end)===part.quote;}
const writingSchema=feedProfileSchema.shape.settings.pick({interests:true,exclusions:true,directions:true});
export type AdaptiveWriting=z.infer<typeof writingSchema>;
const writing=(profile:FeedProfile):AdaptiveWriting=>({interests:profile.settings.interests,exclusions:profile.settings.exclusions,directions:profile.settings.directions});
export const writtenRulesIdentity=(profile:FeedProfile,hash:AdaptiveDigest)=>adaptiveHash(exact(writingSchema,writing(exact(feedProfileSchema,profile))),hash);
const writtenSchema=z.object({format:z.literal(2),requestId:uuid,epoch:uuid,deviceId:identity,profileRevision:positive,writing:writingSchema,writingSha256:digest,briefSha256:digest}).strict();
export type AdaptiveWrittenCapture=z.infer<typeof writtenSchema>;
const ruleSchema=z.object({id:smallId,kind:z.enum(['include','require','exclude']),meaning:z.string().trim().min(1).max(240),sources:z.array(feedBriefSpanSchema).min(1).max(8)}).strict();
const planSchema=z.object({format:z.literal(2),requestId:uuid,briefSha256:digest,rules:z.array(ruleSchema).max(32),unsupported:z.array(feedBriefSpanSchema).max(64)}).strict();
export type AdaptiveWrittenPlan=z.infer<typeof planSchema>;
const approvalSchema=z.object({format:z.literal(2),kind:z.literal('approved-written'),reviewRequestId:uuid,epoch:uuid,deviceId:identity,
 originalRequestId:uuid,briefSha256:digest,planSha256:digest,writingSha256:digest,profileRevisionAtAcceptance:positive,acceptedAt:positive}).strict();
export type AdaptiveWrittenApproval=z.infer<typeof approvalSchema>;
export type AdaptiveWrittenBasis={kind:'accepted';capture:AdaptiveWrittenCapture;plan:AdaptiveWrittenPlan;approval:AdaptiveWrittenApproval}|{kind:'empty'};
const writtenContextSchema=z.object({epoch:uuid,deviceId:identity,profile:feedProfileSchema}).strict();
export type FeedWrittenContext=z.infer<typeof writtenContextSchema>;
// Deliberately project only writing authority. An unrelated oversized activity
// capture must not revoke the ability to interpret or approve exact writing.
function writtenContext(input:FeedWrittenContext){const value=exact(writtenContextSchema,{epoch:input.epoch,deviceId:input.deviceId,profile:input.profile});
 if(!bounded(value))throw new Error('Written input bound');return value;}
const sourceIdentity={id:identity,eventId:identity,source:z.enum(['reading','library','ideas']),sourceId:identity,sourceRevision:positive,contextSha256:digest,
 at:instant,action:z.enum(['open','return','save','pursue']),available:z.boolean(),sourceEntryId:uuid.optional(),sourceOperationId:uuid.optional()};
const ideaIdentity=(value:{source:string;sourceEntryId?:string;sourceOperationId?:string})=>value.source==='ideas'
 ?!!value.sourceEntryId&&!!value.sourceOperationId:!value.sourceEntryId&&!value.sourceOperationId;
export const adaptiveActivitySchema=z.object({...sourceIdentity,text:z.string().min(1).max(12000)}).strict().refine(ideaIdentity,'Exact authored Idea entry and operation required');
export type AdaptiveActivity=z.infer<typeof adaptiveActivitySchema>;
const supportSchema=z.object({...sourceIdentity,span}).strict().refine(ideaIdentity,'Exact authored Idea entry and operation required');
export type AdaptiveSupport=z.infer<typeof supportSchema>;
const anchorSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('written'),ruleId:smallId,supportIds:z.array(identity).min(2).max(8)}).strict(),
 z.object({kind:z.literal('kept'),topic:label,supportIds:z.array(identity).min(2).max(8)}).strict(),
]);
const relationSchema=z.object({kind:z.enum(['within','related','activity-only','unknown']),anchors:z.array(anchorSchema).max(8)}).strict();
const activitySpanSchema=z.object({activityId:identity,...span.shape}).strict();
const constraintJudgmentSchema=z.object({ruleId:smallId,outcome:z.enum(['met','not-met','unknown']),evidence:z.array(activitySpanSchema).max(8)}).strict();
const interestSchema=z.object({format:z.literal(2),id:digest,learningRequestId:uuid,learningCaptureSha256:digest,writingSha256:digest,label,
 supports:z.array(supportSchema).min(2).max(8),relation:relationSchema,constraints:z.array(constraintJudgmentSchema).max(32)}).strict();
export type AdaptiveInterest=z.infer<typeof interestSchema>;
const suppressionSchema=z.object({interestId:digest,label,at:positive,supports:z.array(z.object({eventId:identity,source:z.enum(['reading','library','ideas']),sourceId:identity}).strict()).min(2).max(8)}).strict();
const learningStateSchema=z.object({revision:positive,interests:z.array(interestSchema).max(64),suppressed:z.array(suppressionSchema).max(64)}).strict();
export type AdaptiveLearningState=z.infer<typeof learningStateSchema>;
export const adaptiveContextSchema=z.object({epoch:uuid,deviceId:identity,profile:feedProfileSchema,control:feedLearningControlSchema,
 activity:z.array(adaptiveActivitySchema).max(128),learning:learningStateSchema}).strict();
export type FeedAdaptiveContext=z.infer<typeof adaptiveContextSchema>;
/** Semantic checks only; this pure helper supplies no schema, ownership or execution proof. */
export function checkAdaptiveContextOriginals(value:FeedAdaptiveContext):void{
 if(new Set(value.activity.map(row=>row.id)).size!==value.activity.length||new Set(value.learning.interests.map(row=>row.id)).size!==value.learning.interests.length||
  new Set(value.learning.interests.map(row=>feedTopicKey(row.label))).size!==value.learning.interests.length||new Set(value.learning.suppressed.map(row=>row.interestId)).size!==value.learning.suppressed.length)throw new Error('Duplicate original');
}
function context(input:FeedAdaptiveContext){const value=exact(adaptiveContextSchema,input);if(!bounded(value))throw new Error('Input bound');checkAdaptiveContextOriginals(value);return value;}
/** Exact empty-writing decision after the caller has validated the profile. */
export function adaptiveEmptyWritingCurrent(profile:FeedProfile):boolean{return !profile.settings.interests.length&&!profile.settings.exclusions.length&&!profile.settings.directions.trim();}

function checkedWritten(input:AdaptiveWrittenCapture,hash:AdaptiveDigest){const value=exact(writtenSchema,input),{briefSha256,...body}=value;
 if(!bounded(value)||adaptiveHash(body,hash)!==briefSha256||adaptiveHash(value.writing,hash)!==value.writingSha256)throw new Error('Invalid written capture');return value;}
export function captureAdaptiveWriting(input:FeedWrittenContext,requestId:string,hash:AdaptiveDigest):AdaptiveResult<AdaptiveWrittenCapture>{
 try{const current=writtenContext(input);uuid.parse(requestId);const body={format:2 as const,requestId,epoch:current.epoch,deviceId:current.deviceId,profileRevision:current.profile.revision,
  writing:writing(current.profile),writingSha256:writtenRulesIdentity(current.profile,hash)};return {ok:true,value:{...body,briefSha256:adaptiveHash(body,hash)}};}catch{return fail('invalid-context');}}
const writtenText=(value:AdaptiveWriting,s:FeedBriefSpan)=>s.field==='directions'?value.directions:value[s.field][s.index];
function covered(value:AdaptiveWriting,spans:FeedBriefSpan[]){const fields=[{field:'directions',index:-1,text:value.directions},...value.interests.map((text,index)=>({field:'interests',index,text})),...value.exclusions.map((text,index)=>({field:'exclusions',index,text}))];
 return fields.every(field=>{const mask=new Uint8Array(field.text.length);for(const s of spans)if(s.field===field.field&&(s.field==='directions'||s.index===field.index))mask.fill(1,s.start,s.end);
  for(let i=0;i<field.text.length;i++)if(!mask[i]&&!/\s/u.test(field.text[i]))return false;return true;});}
export function readAdaptiveWrittenPlan(raw:string,input:AdaptiveWrittenCapture,hash:AdaptiveDigest):AdaptiveResult<{plan:AdaptiveWrittenPlan;planSha256:string;status:'reviewable'|'constraints-only'|'empty'|'unsupported'}>{
 try{const capture=checkedWritten(input,hash),plan=exact(planSchema,rawJson(raw));if(plan.requestId!==capture.requestId||plan.briefSha256!==capture.briefSha256)return fail('stale-writing');
  if(new Set(plan.rules.map(r=>r.id)).size!==plan.rules.length)return fail('duplicate-rule');
  for(const rule of plan.rules)for(const s of rule.sources)if(!exactSpan(writtenText(capture.writing,s),s)||s.field==='exclusions'&&rule.kind!=='exclude'||s.field==='interests'&&rule.kind==='exclude')return fail('invalid-written-source');
  if(plan.unsupported.some(s=>!exactSpan(writtenText(capture.writing,s),s))||!covered(capture.writing,[...plan.rules.flatMap(r=>r.sources),...plan.unsupported]))return fail('incomplete-written-coverage');
  return {ok:true,value:{plan,planSha256:adaptiveHash(plan,hash),status:plan.unsupported.length?'unsupported':plan.rules.some(r=>r.kind==='include')?'reviewable':plan.rules.length?'constraints-only':'empty'}};
 }catch{return fail('invalid-plan');}}
export function captureAdaptiveApproval(currentInput:FeedWrittenContext,capture:AdaptiveWrittenCapture,plan:AdaptiveWrittenPlan,reviewRequestId:string,at:number,hash:AdaptiveDigest):AdaptiveResult<AdaptiveWrittenApproval>{
 try{const current=writtenContext(currentInput),original=checkedWritten(capture,hash),parsed=readAdaptiveWrittenPlan(JSON.stringify(plan),original,hash);uuid.parse(reviewRequestId);positive.parse(at);
  if(current.epoch!==original.epoch||current.deviceId!==original.deviceId||current.profile.revision<original.profileRevision||writtenRulesIdentity(current.profile,hash)!==original.writingSha256)return fail('stale-writing');
  if(!parsed.ok||!['reviewable','constraints-only'].includes(parsed.value.status))return fail('review-unavailable');
  return {ok:true,value:{format:2,kind:'approved-written',reviewRequestId,epoch:current.epoch,deviceId:current.deviceId,originalRequestId:original.requestId,
   briefSha256:original.briefSha256,planSha256:parsed.value.planSha256,writingSha256:original.writingSha256,profileRevisionAtAcceptance:current.profile.revision,acceptedAt:at}};
 }catch{return fail('invalid-approval');}}
function checkedBasis(current:FeedWrittenContext,basis:AdaptiveWrittenBasis,hash:AdaptiveDigest):AdaptiveWrittenPlan['rules']{
 if(basis.kind==='empty'){if(!same(basis,{kind:'empty'})||!adaptiveEmptyWritingCurrent(current.profile))throw new Error('Written review required');return [];}
 const capture=checkedWritten(basis.capture,hash),approval=exact(approvalSchema,basis.approval),parsed=readAdaptiveWrittenPlan(JSON.stringify(basis.plan),capture,hash);
 if(!same(basis,{kind:'accepted',capture:basis.capture,plan:basis.plan,approval:basis.approval})||!parsed.ok||!['reviewable','constraints-only'].includes(parsed.value.status)||
  current.epoch!==capture.epoch||current.deviceId!==capture.deviceId||current.profile.revision<approval.profileRevisionAtAcceptance||writtenRulesIdentity(current.profile,hash)!==capture.writingSha256||
  approval.epoch!==capture.epoch||approval.deviceId!==capture.deviceId||approval.originalRequestId!==capture.requestId||approval.briefSha256!==capture.briefSha256||approval.planSha256!==parsed.value.planSha256||
  approval.writingSha256!==capture.writingSha256||approval.profileRevisionAtAcceptance<capture.profileRevision)throw new Error('Written approval changed');return parsed.value.plan.rules;
}
export function adaptiveWrittenCurrent(current:FeedWrittenContext,basis:AdaptiveWrittenBasis,hash:AdaptiveDigest){try{checkedBasis(writtenContext(current),basis,hash);return true;}catch{return false;}}
const supportIdentity=(row:AdaptiveActivity)=>{const {text,...identity}=row;return identity;};
function suppressed(current:FeedAdaptiveContext,row:AdaptiveActivity){return current.learning.suppressed.some(s=>s.supports.some(old=>old.eventId===row.eventId&&old.source===row.source&&old.sourceId===row.sourceId));}
function permittedActivityCapture(current:FeedAdaptiveContext,at:number){return current.activity.every(row=>{const time=Date.parse(row.at);
 return row.available&&current.profile.settings.learning.allowed.includes(row.source)&&time<=at&&at-time<=90*86400000&&(!current.control.resetAt||time>Date.parse(current.control.resetAt));});}
function supportRows(current:FeedAdaptiveContext,supports:AdaptiveSupport[],now:number){return supports.flatMap(s=>{const row=current.activity.find(a=>a.id===s.id);
 return row&&same(supportIdentity(row),(()=>{const {span,...identity}=s;return identity;})())&&exactSpan(row.text,s.span)&&permittedStrengthEvidence(current.profile,current.control,row,now)&&!suppressed(current,row)?[row]:[];});}
function validRelation(current:FeedAdaptiveContext,rules:AdaptiveWrittenPlan['rules'],relation:z.infer<typeof relationSchema>,supports:AdaptiveActivity[]){
 if(['unknown','activity-only'].includes(relation.kind))return relation.anchors.length===0;
 return relation.anchors.length>0&&relation.anchors.every(anchor=>{const rows=supports.filter(s=>anchor.supportIds.includes(s.id));
  return new Set(anchor.supportIds).size===anchor.supportIds.length&&rows.length===anchor.supportIds.length&&new Set(rows.map(s=>s.source+':'+s.sourceId)).size>=2&&
   (anchor.kind==='written'?rules.some(r=>r.id===anchor.ruleId&&r.kind==='include'):current.control.kept.some(t=>sameFeedTopic(t,anchor.topic)));});
}
function relationActive(current:FeedAdaptiveContext,rules:AdaptiveWrittenPlan['rules'],relation:z.infer<typeof relationSchema>){
 const includes=rules.filter(r=>r.kind==='include'),literal=interpretFeedProfile(current.profile);
 if(relation.kind==='unknown')return false;
 if(relation.kind==='activity-only')return relation.anchors.length===0&&includes.length===0&&current.control.kept.length===0&&!literal.only;
 if(!relation.anchors.length||relation.kind==='related'&&(current.profile.settings.learning.scope!=='related'||literal.only))return false;
 return true;
}
export function qualifyAdaptiveInterest(currentInput:FeedAdaptiveContext,basis:AdaptiveWrittenBasis,input:AdaptiveInterest,now:number,hash:AdaptiveDigest):AdaptiveResult<{interest:AdaptiveInterest;score:number;status:'active'|'suggested';supportIds:string[]}>{
 try{const current=context(currentInput),rules=checkedBasis(current,basis,hash),interest=exact(interestSchema,input),{id,...body}=interest;
  if(adaptiveHash(body,hash)!==id||interest.writingSha256!==writtenRulesIdentity(current.profile,hash))return fail('interest-proof');
  const settings=current.profile.settings.learning;if(!settings.enabled||settings.instructionsOnly||current.control.stopped.some(t=>sameFeedTopic(t,interest.label)))return fail('learning-disabled');
  const rows=supportRows(current,interest.supports,now);if(rows.length!==interest.supports.length)return fail('stale-support');
  const strength=feedEvidenceStrength(rows,now);if(!strength)return fail('insufficient-evidence');
  if(new Set(interest.supports.map(s=>s.id)).size!==interest.supports.length||!validRelation(current,rules,interest.relation,strength.evidence))return fail('invalid-relation');
  const constraints=rules.filter(r=>r.kind!=='include');
  if(interest.constraints.length!==constraints.length||new Set(interest.constraints.map(r=>r.ruleId)).size!==constraints.length||interest.constraints.some(r=>!constraints.some(c=>c.id===r.ruleId)))return fail('constraint-coverage');
  for(const judgment of interest.constraints){if(judgment.outcome==='met'&&!judgment.evidence.length||judgment.outcome==='unknown'&&judgment.evidence.length)return fail('invalid-constraint-evidence');
   for(const s of judgment.evidence)if(!exactSpan(rows.find(row=>row.id===s.activityId)?.text,s))return fail('invented-constraint-evidence');
   if(new Set(judgment.evidence.map(adaptiveCanonical)).size!==judgment.evidence.length)return fail('duplicate-constraint-evidence');}
  const constraintsMet=constraints.every(rule=>interest.constraints.find(r=>r.ruleId===rule.id)!.outcome===(rule.kind==='exclude'?'not-met':'met'));
  const literal=interpretFeedProfile(current.profile),excluded=literal.excluded.some(topic=>feedContainsTopic(interest.label,topic)||interest.supports.some(s=>feedContainsTopic(s.span.quote,topic)));
  return {ok:true,value:{interest,score:strength.score,status:!excluded&&constraintsMet&&relationActive(current,rules,interest.relation)?'active':'suggested',supportIds:strength.evidence.map(r=>r.id)}};
 }catch{return fail('invalid-interest');}}
const learningCaptureSchema=z.object({format:z.literal(2),requestId:uuid,at:positive,context:adaptiveContextSchema,basis:z.unknown(),contextSha256:digest,captureSha256:digest}).strict();
export type AdaptiveLearningCapture=Omit<z.infer<typeof learningCaptureSchema>,'basis'>&{basis:AdaptiveWrittenBasis};
const candidateSchema=z.object({id:smallId,label,supports:z.array(activitySpanSchema).min(2).max(8),relation:relationSchema,constraints:z.array(constraintJudgmentSchema).max(32)}).strict();
const learningResultSchema=z.object({format:z.literal(2),requestId:uuid,captureSha256:digest,candidates:z.array(candidateSchema).max(32)}).strict();
export type AdaptiveLearningResult=z.infer<typeof learningResultSchema>;
/** The shared domain decision only. Callers still owe strict current context,
 * exact current basis and complete canonical body-bound validation. */
export function adaptiveLearningDecision(current:FeedAdaptiveContext,requestId:string,at:number,beforeCompare?:(left:string,right:string)=>void):string|undefined{
 uuid.parse(requestId);positive.parse(at);const l=current.profile.settings.learning;
 if(!l.enabled||l.paused||l.instructionsOnly||!l.allowed.length)return 'learning-paused';
 if(!permittedActivityCapture(current,at))return 'unpermitted-activity-capture';
 if(!feedEvidenceStrength(current.activity.filter(row=>!suppressed(current,row)&&permittedStrengthEvidence(current.profile,current.control,row,at)),at,beforeCompare))return 'insufficient-evidence';
}
type LearningBodyDecision=Omit<AdaptiveLearningCapture,'captureSha256'>|string;
// Share the exact decision and body-size check. Returning the body directly
// keeps capture's allocation shape and canonical/hash sequence unchanged.
function learningCaptureBody(current:FeedAdaptiveContext,basis:AdaptiveWrittenBasis,requestId:string,at:number,hash:AdaptiveDigest,contextSha256?:string):LearningBodyDecision{
  const refusal=adaptiveLearningDecision(current,requestId,at);if(refusal)return refusal;
  const body={format:2 as const,requestId,at,context:current,basis,contextSha256:contextSha256??adaptiveHash(current,hash)};
  if(!bounded(body))return 'input-limit';return body;
}
function captureLearningChecked(current:FeedAdaptiveContext,basis:AdaptiveWrittenBasis,requestId:string,at:number,hash:AdaptiveDigest,contextSha256?:string):AdaptiveResult<AdaptiveLearningCapture>{
  const body=learningCaptureBody(current,basis,requestId,at,hash,contextSha256);if(typeof body==='string')return fail(body);
  return {ok:true,value:{...body,captureSha256:adaptiveHash(body,hash)}};
}
function learningEligibilityChecked(current:FeedAdaptiveContext,basis:AdaptiveWrittenBasis,requestId:string,at:number,hash:AdaptiveDigest,contextSha256?:string):AdaptiveResult<true>{
  const body=learningCaptureBody(current,basis,requestId,at,hash,contextSha256);return typeof body==='string'?fail(body):{ok:true,value:true};
}
/** Pure eligibility only: full context/basis validation and the exact capture
 * body bound remain mandatory. This creates no capture or execution authority. */
export function checkAdaptiveLearningEligibility(input:FeedAdaptiveContext,basis:AdaptiveWrittenBasis,requestId:string,at:number,hash:AdaptiveDigest):AdaptiveResult<true>{
 try{const current=context(input);checkedBasis(current,basis,hash);return learningEligibilityChecked(current,basis,requestId,at,hash);
 }catch{return fail('invalid-learning-context');}}
export function captureAdaptiveLearning(input:FeedAdaptiveContext,basis:AdaptiveWrittenBasis,requestId:string,at:number,hash:AdaptiveDigest):AdaptiveResult<AdaptiveLearningCapture>{
 try{const current=context(input);checkedBasis(current,basis,hash);return captureLearningChecked(current,basis,requestId,at,hash);
 }catch{return fail('invalid-learning-context');}}
function freezeLearningOwned(value:unknown):void{
 if(value===null||typeof value!=='object')return;
 if(Array.isArray(value)){for(let i=0;i<value.length;i++){const child=value[i];if(child!==null&&typeof child==='object')freezeLearningOwned(child);}}
 else for(const key in value)if(Object.hasOwn(value,key)){const child=(value as Record<string,unknown>)[key];if(child!==null&&typeof child==='object')freezeLearningOwned(child);}
 Object.freeze(value);
}
function copyLearningOwned(value:unknown,depth=0):unknown{
 if(depth>128)throw Error('Learning basis depth bound');
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(typeof value!=='object')throw Error('Learning basis must be strict JSON');
 const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
 if(prototype!==(array?Array.prototype:Object.prototype)&&prototype!==null||Object.getOwnPropertySymbols(value).length)throw Error('Learning basis must be plain JSON');
 const out:Record<string,unknown>|unknown[]=array?[]:{};let count=0;
 for(const key in value)if(Object.hasOwn(value,key)){
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!descriptor||!('value'in descriptor)||array&&key!==String(count))throw Error('Learning basis accessor or sparse array');
  count++;Object.defineProperty(out,key,{value:copyLearningOwned(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});
 }
 if(array&&count!==(value as unknown[]).length)throw Error('Learning basis sparse array');return out;
}
export type PreparedLearningCaptures=Readonly<{capture(requestId:string,at:number):AdaptiveResult<AdaptiveLearningCapture>;eligible(requestId:string,at:number):AdaptiveResult<true>}>;
/** Internal pure preparation. The service owns preallocation and a guarded,
 * expiring lexical wrapper; this object grants no source or execution authority.
 * Only owned parsed/copied values are frozen, never one-shot caller inputs. */
export function prepareAdaptiveLearningCaptures(input:FeedAdaptiveContext,basis:AdaptiveWrittenBasis,hash:AdaptiveDigest):AdaptiveResult<PreparedLearningCaptures>{
 try{const current=context(input),ownedBasis=copyLearningOwned(basis) as AdaptiveWrittenBasis;
  checkedBasis(current,ownedBasis,hash);freezeLearningOwned(current);freezeLearningOwned(ownedBasis);
  const contextSha256=adaptiveHash(current,hash);
  const capture=(requestId:string,at:number):AdaptiveResult<AdaptiveLearningCapture>=>{
   try{const result=captureLearningChecked(current,ownedBasis,requestId,at,hash,contextSha256);
    if(result.ok)Object.freeze(result.value);return Object.freeze(result);
   }catch{return Object.freeze(fail('invalid-learning-context'));}
  };
  const eligible=(requestId:string,at:number):AdaptiveResult<true>=>{
   try{return Object.freeze(learningEligibilityChecked(current,ownedBasis,requestId,at,hash,contextSha256));}
   catch{return Object.freeze(fail('invalid-learning-context'));}
  };
  return Object.freeze({ok:true,value:Object.freeze({capture,eligible})});
 }catch{return Object.freeze(fail('invalid-learning-context'));}
}
function checkedLearning(input:AdaptiveLearningCapture,hash:AdaptiveDigest){const original=exact(learningCaptureSchema,input) as AdaptiveLearningCapture,{captureSha256,...body}=original;
 if(!bounded(original)||adaptiveHash(body,hash)!==captureSha256||adaptiveHash(original.context,hash)!==original.contextSha256)throw new Error('Learning capture changed');
 const captured=captureAdaptiveLearning(original.context,original.basis,original.requestId,original.at,hash);if(!captured.ok||!same(captured.value,original))throw new Error('Invalid learning capture');return original;}
export function readAdaptiveLearning(raw:string,input:AdaptiveLearningCapture,hash:AdaptiveDigest):AdaptiveResult<{result:AdaptiveLearningResult;interests:AdaptiveInterest[]}>{
 try{const capture=checkedLearning(input,hash),result=exact(learningResultSchema,rawJson(raw));
  if(result.requestId!==capture.requestId||result.captureSha256!==capture.captureSha256)return fail('stale-learning-result');
  if(new Set(result.candidates.map(c=>c.id)).size!==result.candidates.length||new Set(result.candidates.map(c=>feedTopicKey(c.label))).size!==result.candidates.length)return fail('duplicate-candidate');
  const interests:AdaptiveInterest[]=[];
  for(const candidate of result.candidates){if(new Set(candidate.supports.map(s=>s.activityId)).size!==candidate.supports.length)return fail('duplicate-support');
   const supports=candidate.supports.map(s=>{const row=capture.context.activity.find(a=>a.id===s.activityId);if(!row||!exactSpan(row.text,s))throw new Error('Invented support');
    return {...supportIdentity(row),span:{start:s.start,end:s.end,quote:s.quote}};});
   const body={format:2 as const,learningRequestId:capture.requestId,learningCaptureSha256:capture.captureSha256,writingSha256:writtenRulesIdentity(capture.context.profile,hash),label:candidate.label,supports,relation:candidate.relation,constraints:candidate.constraints};
   const interest={...body,id:adaptiveHash(body,hash)},qualified=qualifyAdaptiveInterest(capture.context,capture.basis,interest,capture.at,hash);if(!qualified.ok)return fail(qualified.reason);interests.push(interest);
  }return {ok:true,value:{result,interests}};
 }catch{return fail('invalid-learning-result');}}
export function applyAdaptiveLearning(currentInput:FeedAdaptiveContext,capture:AdaptiveLearningCapture,result:AdaptiveLearningResult,now:number,hash:AdaptiveDigest):AdaptiveResult<AdaptiveLearningState>{
 try{const current=context(currentInput),original=checkedLearning(capture,hash),parsed=readAdaptiveLearning(JSON.stringify(result),original,hash);
  if(!parsed.ok)return fail(parsed.reason);if(now<original.at||!Number.isFinite(now)||adaptiveHash(current,hash)!==original.contextSha256)return fail('stale-learning-context');
  for(const interest of parsed.value.interests)if(!qualifyAdaptiveInterest(current,original.basis,interest,now,hash).ok)return fail('stale-learning-support');
  const byLabel=new Map(current.learning.interests.map(i=>[feedTopicKey(i.label),i]));for(const interest of parsed.value.interests)byLabel.set(feedTopicKey(interest.label),interest);
  const interests=[...byLabel.values()];if(interests.length>adaptiveLimits.interests)return fail('interest-limit');
  const next={...current.learning,revision:current.learning.revision+1,interests};if(!bounded({...current,learning:next}))return fail('input-limit');return {ok:true,value:next};
 }catch{return fail('invalid-learning-application');}}
export function stopAdaptiveInterest(currentInput:FeedAdaptiveContext,id:string,at:number,hash:AdaptiveDigest):AdaptiveResult<{control:FeedLearningControl;learning:AdaptiveLearningState}>{
 try{const current=context(currentInput),interest=current.learning.interests.find(i=>i.id===id);positive.parse(at);if(!interest)return fail('interest-missing');
  const {id:originalId,...body}=interest;if(adaptiveHash(body,hash)!==originalId)return fail('interest-proof');
  const supports=interest.supports.map(s=>({eventId:s.eventId,source:s.source,sourceId:s.sourceId}));
  const learning={revision:current.learning.revision+1,interests:current.learning.interests.filter(i=>i.id!==id),suppressed:[...current.learning.suppressed.filter(s=>s.interestId!==id),{interestId:id,label:interest.label,at,supports}]};
  const control={...current.control,kept:current.control.kept.filter(t=>!sameFeedTopic(t,interest.label)),stopped:[...current.control.stopped.filter(t=>!sameFeedTopic(t,interest.label)),interest.label]};
  exact(learningStateSchema,learning);exact(feedLearningControlSchema,control);if(!bounded({...current,learning,control}))return fail('input-limit');return {ok:true,value:{control,learning}};
 }catch{return fail('invalid-stop');}}
export function allowAdaptiveInterest(currentInput:FeedAdaptiveContext,id:string):AdaptiveResult<{control:FeedLearningControl;learning:AdaptiveLearningState}>{
 try{const current=context(currentInput),stopped=current.learning.suppressed.find(s=>s.interestId===id);if(!stopped)return fail('suppression-missing');
  return {ok:true,value:{control:{...current.control,stopped:current.control.stopped.filter(t=>!sameFeedTopic(t,stopped.label))},learning:{...current.learning,revision:current.learning.revision+1,suppressed:current.learning.suppressed.filter(s=>s.interestId!==id)}}};
 }catch{return fail('invalid-allow');}}
export function resetAdaptiveLearning(currentInput:FeedAdaptiveContext,at:string):AdaptiveResult<{profile:FeedProfile;control:FeedLearningControl;learning:AdaptiveLearningState}>{
 try{const current=context(currentInput);instant.parse(at);return {ok:true,value:{profile:{...current.profile,settings:{...current.profile.settings,learning:{...current.profile.settings.learning,paused:true}}},
  control:{...current.control,resetAt:at},learning:{...current.learning,revision:current.learning.revision+1,interests:[]}}};}catch{return fail('invalid-reset');}}

const candidateSelectionSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('written'),id:smallId,label:z.string().min(1).max(240)}).strict(),
 z.object({kind:z.literal('kept'),id:digest,label}).strict(),
 z.object({kind:z.literal('learned'),id:digest,label,supportIds:z.array(identity).min(2).max(8)}).strict(),
]);
type CandidateSelection=z.infer<typeof candidateSelectionSchema>;
function candidates(current:FeedAdaptiveContext,basis:AdaptiveWrittenBasis,rules:AdaptiveWrittenPlan['rules'],at:number,hash:AdaptiveDigest):CandidateSelection[]{
 const selected:CandidateSelection[]=rules.filter(r=>r.kind==='include').map(r=>({kind:'written',id:r.id,label:r.meaning}));
 for(const topic of current.control.kept)if(!current.control.stopped.some(t=>sameFeedTopic(t,topic)))selected.push({kind:'kept',id:adaptiveHash({kind:'kept',topic},hash),label:topic});
 for(const interest of current.learning.interests){const q=qualifyAdaptiveInterest(current,basis,interest,at,hash);if(q.ok&&q.value.status==='active')selected.push({kind:'learned',id:interest.id,label:interest.label,supportIds:q.value.supportIds});}
 return selected;
}
const previewSchema=z.object({format:z.literal(2),requestId:uuid,at:positive,context:adaptiveContextSchema,basis:z.unknown(),contextSha256:digest,story:feedStorySchema,
 candidates:z.array(candidateSelectionSchema).max(160),previewSha256:digest}).strict();
export type AdaptivePreview=Omit<z.infer<typeof previewSchema>,'basis'>&{basis:AdaptiveWrittenBasis};
export function captureAdaptivePreview(input:FeedAdaptiveContext,basis:AdaptiveWrittenBasis,story:FeedStory,requestId:string,at:number,hash:AdaptiveDigest):AdaptiveResult<AdaptivePreview>{
 try{const current=context(input),rules=checkedBasis(current,basis,hash),source=exact(feedStorySchema,story);uuid.parse(requestId);positive.parse(at);
  if(source.summaryKind!=='publisher-preview'||!source.summary.trim())return fail('insufficient-preview');
  if(!permittedActivityCapture(current,at))return fail('unpermitted-activity-capture');
  const selected=candidates(current,basis,rules,at,hash);if(!selected.length)return fail('no-positive-basis');
  const body={format:2 as const,requestId,at,context:current,basis,contextSha256:adaptiveHash(current,hash),story:source,candidates:selected};
  if(!bounded(body))return fail('input-limit');return {ok:true,value:{...body,previewSha256:adaptiveHash(body,hash)}};
 }catch{return fail('invalid-preview');}}
function checkedPreview(input:AdaptivePreview,hash:AdaptiveDigest){const value=exact(previewSchema,input) as AdaptivePreview,{previewSha256,...body}=value;
 if(!bounded(value)||adaptiveHash(body,hash)!==previewSha256||adaptiveHash(value.context,hash)!==value.contextSha256)throw new Error('Preview changed');
 const captured=captureAdaptivePreview(value.context,value.basis,value.story,value.requestId,value.at,hash);if(!captured.ok||!same(captured.value,value))throw new Error('Preview derivation changed');return value;}
const judgmentSchema=z.object({id:z.string().min(1).max(80),outcome:z.enum(['met','not-met','unknown']),evidence:z.array(feedPreviewSpanSchema).max(8)}).strict();
const storyResultSchema=z.object({format:z.literal(2),requestId:uuid,previewSha256:digest,rules:z.array(judgmentSchema).max(32),candidates:z.array(judgmentSchema).max(160)}).strict();
export type AdaptiveStoryResult=z.infer<typeof storyResultSchema>;
const previewText=(story:FeedStory,s:FeedPreviewSpan)=>s.field==='topics'?story.topics[s.index]:story[s.field];
const candidateKey=(c:CandidateSelection)=>c.kind+':'+c.id;
export function readAdaptiveStoryResult(raw:string,input:AdaptivePreview,hash:AdaptiveDigest):AdaptiveResult<AdaptiveStoryResult>{
 try{const preview=checkedPreview(input,hash),result=exact(storyResultSchema,rawJson(raw)),rules=checkedBasis(preview.context,preview.basis,hash);
  if(result.requestId!==preview.requestId||result.previewSha256!==preview.previewSha256)return fail('stale-result');
  for(const [rows,ids] of [[result.rules,rules.map(r=>r.id)],[result.candidates,preview.candidates.map(candidateKey)]] as const){
   if(rows.length!==ids.length||new Set(rows.map(r=>r.id)).size!==rows.length||rows.some(r=>!ids.includes(r.id)))return fail('judgment-coverage');
   for(const row of rows)if(row.outcome==='met'&&!row.evidence.length||row.outcome==='unknown'&&row.evidence.length||row.evidence.some(s=>!exactSpan(previewText(preview.story,s),s))||new Set(row.evidence.map(adaptiveCanonical)).size!==row.evidence.length)return fail('invalid-preview-evidence');
  }
  for(const candidate of preview.candidates)if(candidate.kind==='written'){
   const rule=result.rules.find(r=>r.id===candidate.id)!,selected=result.candidates.find(r=>r.id===candidateKey(candidate))!;
   if(rule.outcome!==selected.outcome||!same(rule.evidence,selected.evidence))return fail('contradictory-written-match');
  }return {ok:true,value:result};
 }catch{return fail('invalid-result');}}
export type AdaptiveEligibility={eligible:false;reason:string}|{eligible:true;profileRevision:number;storyId:string;storyRevision:number;previewSha256:string;
 reasons:{kind:'written'|'kept'|'learned';id:string;label:string;supportIds:string[];evidence:FeedPreviewSpan[]}[]};
export function adaptiveEligibility(currentInput:FeedAdaptiveContext,story:FeedStory,previewInput:AdaptivePreview,resultInput:AdaptiveStoryResult,now:number,hash:AdaptiveDigest,
 options:{following?:boolean;hidden?:readonly string[]}={}):AdaptiveEligibility{
 const deny=(reason:string):AdaptiveEligibility=>({eligible:false,reason});
 try{const current=context(currentInput),source=exact(feedStorySchema,story);if(!Number.isFinite(now))return deny('invalid-time');
  const hard=feedHardFilter(current.profile,source,options);if(hard)return deny(hard);
  const literal=interpretFeedProfile(current.profile),text=[source.title,source.summary,...source.topics].join('\n');
  if(literal.only&&!literal.topics.some(t=>feedContainsTopic(text,t)))return deny('only-scope');
  const preview=checkedPreview(previewInput,hash);if(now<preview.at||adaptiveHash(current,hash)!==preview.contextSha256||!same(source,preview.story))return deny('stale-application');
  const rules=checkedBasis(current,preview.basis,hash),parsed=readAdaptiveStoryResult(JSON.stringify(resultInput),preview,hash);if(!parsed.ok)return deny(parsed.reason);
  const byRule=new Map(parsed.value.rules.map(r=>[r.id,r]));
  for(const rule of rules){const row=byRule.get(rule.id)!;if(rule.kind==='exclude'&&row.outcome!=='not-met')return deny(row.outcome==='unknown'?'unknown-exclusion':'excluded');
   if(rule.kind==='require'&&row.outcome!=='met')return deny(row.outcome==='unknown'?'unknown-requirement':'required');}
  const fresh=candidates(current,preview.basis,rules,now,hash),byCandidate=new Map(parsed.value.candidates.map(c=>[c.id,c]));
  const reasons=fresh.flatMap(c=>{const original=preview.candidates.find(p=>candidateKey(p)===candidateKey(c)),row=byCandidate.get(candidateKey(c));
   return original&&same(original,c)&&row?.outcome==='met'?[{kind:c.kind,id:c.id,label:c.label,supportIds:c.kind==='learned'?c.supportIds:[],evidence:row.evidence}]:[];});
  return reasons.length?{eligible:true,profileRevision:current.profile.revision,storyId:source.id,storyRevision:source.revision,previewSha256:preview.previewSha256,reasons}:deny('no-supported-match');
 }catch{return deny('invalid-application');}}

/** Future workers must use these minimal model inputs, never serialize the
 * whole retained capture: historical learning state may contain withdrawn text. */
export function adaptiveLearningModelInput(input:AdaptiveLearningCapture,hash:AdaptiveDigest):AdaptiveResult<unknown>{
 try{const capture=checkedLearning(input,hash),current=capture.context,rules=checkedBasis(current,capture.basis,hash);
  const existing=current.learning.interests.flatMap(interest=>{const q=qualifyAdaptiveInterest(current,capture.basis,interest,capture.at,hash);return q.ok&&q.value.status==='active'?[{id:interest.id,label:interest.label}]:[];});
  return {ok:true,value:{format:2,requestId:capture.requestId,captureSha256:capture.captureSha256,rules,kept:[...current.control.kept],existing,
   activity:current.activity.filter(row=>!suppressed(current,row)).map(row=>({id:row.id,text:row.text,action:row.action,source:row.source,at:row.at}))}};
 }catch{return fail('invalid-learning-input');}}
export function adaptiveStoryModelInput(input:AdaptivePreview,hash:AdaptiveDigest):AdaptiveResult<unknown>{
 try{const preview=checkedPreview(input,hash),rules=checkedBasis(preview.context,preview.basis,hash);
  return {ok:true,value:{format:2,requestId:preview.requestId,previewSha256:preview.previewSha256,rules,candidates:preview.candidates.map(candidate=>({
   kind:candidate.kind,id:candidateKey(candidate),label:candidate.label,...(candidate.kind==='learned'?{supports:candidate.supportIds.map(id=>{
    const interest=preview.context.learning.interests.find(i=>i.id===candidate.id)!,support=interest.supports.find(s=>s.id===id)!;
    return {activityId:id,quote:support.span.quote};})}:{})})),
   preview:{title:preview.story.title,summary:preview.story.summary,topics:preview.story.topics,publisher:preview.story.publisher,canonicalUrl:preview.story.canonicalUrl,summaryKind:preview.story.summaryKind}}};
 }catch{return fail('invalid-story-input');}}
