import {z} from 'zod';
import {feedContainsTopic,feedEligibility,feedHardFilter,feedEvidenceSchema,feedLearningControlSchema,feedProfileSchema,
 feedStorySchema,interpretFeedProfile,type FeedEligibility,type FeedEvidence,type FeedInterest,
 type FeedLearningControl,type FeedProfile,type FeedStory} from './news-feed.js';

/** Pure proposal only. The future service must supply authoritative current inputs,
 * a durable accepted review, and its maintained SHA-256 implementation. These
 * contracts validate their joins; they do not authenticate browser assertions,
 * call a model, save records, or prove complete understanding of prose. */
export const feedSemanticLimits={inputBytes:131072,resultBytes:32768,rules:32,spansPerRule:8,
 unsupportedSpans:64,evidenceRows:128,previewEvidencePerRule:8} as const;
export type FeedSemanticDigest=(canonicalUtf8Text:string)=>string;
const digest=/* @__PURE__ */ (() => (z.string().regex(/^[a-f0-9]{64}$/)))(),uuid=/* @__PURE__ */ (() => (z.string().uuid()))(),positive=/* @__PURE__ */ (() => (z.number().int().positive()))();
const identity=/* @__PURE__ */ (() => (z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/)))();
const word=/* @__PURE__ */ (() => (z.string().min(1).max(240).refine(v=>v.trim().length>0&&!/[\p{Cc}]/u.test(v))))();
const id=/* @__PURE__ */ (() => (z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)))();
const offsets=/* @__PURE__ */ (() => ({start:z.number().int().min(0),end:z.number().int().positive(),quote:z.string().min(1).max(4000)}))();
export const feedBriefSpanSchema=/* @__PURE__ */ (() => (z.discriminatedUnion('field',[
 z.object({field:z.literal('directions'),...offsets}).strict(),
 z.object({field:z.enum(['interests','exclusions']),index:z.number().int().min(0).max(31),...offsets}).strict(),
])))();
export type FeedBriefSpan=z.infer<typeof feedBriefSpanSchema>;
export const feedPreviewSpanSchema=/* @__PURE__ */ (() => (z.discriminatedUnion('field',[
 z.object({field:z.enum(['title','summary']),...offsets}).strict(),
 z.object({field:z.literal('topics'),index:z.number().int().min(0).max(31),...offsets}).strict(),
])))();
export type FeedPreviewSpan=z.infer<typeof feedPreviewSpanSchema>;
const contextSchema=/* @__PURE__ */ (() => (z.object({epoch:uuid,deviceId:identity,profile:feedProfileSchema,
 control:feedLearningControlSchema,evidence:z.array(feedEvidenceSchema).max(feedSemanticLimits.evidenceRows)}).strict()))();
export type FeedSemanticContext=z.infer<typeof contextSchema>;
const bindingSchema=/* @__PURE__ */ (() => (z.object({epoch:uuid,deviceId:identity,profileRevision:positive,
 profileSha256:digest,controlSha256:digest,evidenceSha256:digest}).strict()))();
const briefSchema=/* @__PURE__ */ (() => (z.object({format:z.literal(1),requestId:uuid,binding:bindingSchema,
 profile:feedProfileSchema,briefSha256:digest}).strict()))();
export type FeedBriefCapture=z.infer<typeof briefSchema>;
const ruleSchema=/* @__PURE__ */ (() => (z.object({id,kind:z.enum(['include','require','exclude']),meaning:word,
 sources:z.array(feedBriefSpanSchema).min(1).max(feedSemanticLimits.spansPerRule)}).strict()))();
const planSchema=/* @__PURE__ */ (() => (z.object({format:z.literal(1),requestId:uuid,briefSha256:digest,
 rules:z.array(ruleSchema).max(feedSemanticLimits.rules),
 unsupported:z.array(feedBriefSpanSchema).max(feedSemanticLimits.unsupportedSpans)}).strict()))();
export type FeedInterpretationPlan=z.infer<typeof planSchema>;
const reviewedSchema=/* @__PURE__ */ (() => (z.object({format:z.literal(1),state:z.literal('accepted'),reviewRequestId:uuid,
 binding:bindingSchema,briefSha256:digest,planSha256:digest}).strict()))();
export type FeedInterpretationReview=z.infer<typeof reviewedSchema>;
const previewSchema=/* @__PURE__ */ (() => (z.object({format:z.literal(1),requestId:uuid,binding:bindingSchema,
 briefSha256:digest,planSha256:digest,reviewRequestId:uuid,story:feedStorySchema,previewSha256:digest}).strict()))();
export type FeedSemanticPreview=z.infer<typeof previewSchema>;
const resultSchema=/* @__PURE__ */ (() => (z.object({format:z.literal(1),requestId:uuid,previewSha256:digest,
 judgments:z.array(z.object({ruleId:id,outcome:z.enum(['met','not-met','unknown']),
 evidence:z.array(feedPreviewSpanSchema).max(feedSemanticLimits.previewEvidencePerRule)}).strict()).max(feedSemanticLimits.rules)}).strict()))();
export type FeedSemanticResult=z.infer<typeof resultSchema>;
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
const fail=(reason:string):Result<never>=>({ok:false,reason});
const bytes=(text:string)=>new TextEncoder().encode(text).byteLength;
function unicode(text:string){
 for(let i=0;i<text.length;i++){const n=text.charCodeAt(i);
  if(n>=0xd800&&n<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}
  else if(n>=0xdc00&&n<=0xdfff)return false;
 }return true;
}
function canonical(value:unknown):string{
 if(typeof value==='string'){if(!unicode(value))throw new Error('Invalid Unicode');return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined)
  .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>canonical(key)+':'+canonical(v)).join(',')+'}';
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 throw new Error('Unsupported canonical value');
}
function hash(value:unknown,digestText:FeedSemanticDigest){return digest.parse(digestText(canonical(value)));}
function bounded(value:unknown,maximum=feedSemanticLimits.inputBytes){return bytes(canonical(value))<=maximum;}
function equal(a:unknown,b:unknown){return canonical(a)===canonical(b);}
function exactContext(input:FeedSemanticContext){const parsed=contextSchema.parse(input);
 if(!equal(parsed,input))throw new Error('Noncanonical context');return parsed;}
function boundary(text:string,offset:number){return offset===0||offset===text.length||
 !(text.charCodeAt(offset)>=0xdc00&&text.charCodeAt(offset)<=0xdfff&&text.charCodeAt(offset-1)>=0xd800&&text.charCodeAt(offset-1)<=0xdbff);}
function exactSpan(text:string|undefined,span:{start:number;end:number;quote:string}){
 return text!==undefined&&unicode(text)&&unicode(span.quote)&&span.start<span.end&&span.end<=text.length&&
  boundary(text,span.start)&&boundary(text,span.end)&&text.slice(span.start,span.end)===span.quote;
}
const briefText=(profile:FeedProfile,span:FeedBriefSpan)=>span.field==='directions'?profile.settings.directions:profile.settings[span.field][span.index];
const previewText=(story:FeedStory,span:FeedPreviewSpan)=>span.field==='topics'?story.topics[span.index]:story[span.field];
function binding(context:FeedSemanticContext,digestText:FeedSemanticDigest){return {epoch:context.epoch,deviceId:context.deviceId,
 profileRevision:context.profile.revision,profileSha256:hash(context.profile,digestText),
 controlSha256:hash(context.control,digestText),evidenceSha256:hash(context.evidence,digestText)};}

export function captureFeedBrief(input:FeedSemanticContext,requestId:string,digestText:FeedSemanticDigest):Result<FeedBriefCapture>{
 try{const current=exactContext(input);uuid.parse(requestId);if(!bounded(current))return fail('input-limit');
  const body={format:1 as const,requestId,binding:binding(current,digestText),profile:current.profile};
  return {ok:true,value:{...body,briefSha256:hash(body,digestText)}};
 }catch{return fail('invalid-context');}
}
function checkedBrief(input:FeedBriefCapture,digestText:FeedSemanticDigest){
 const capture=briefSchema.parse(input),{briefSha256,...body}=capture;
 return equal(capture,input)&&bounded(capture)&&hash(body,digestText)===briefSha256&&hash(capture.profile,digestText)===capture.binding.profileSha256&&
  capture.binding.profileRevision===capture.profile.revision?capture:undefined;
}
function readJson(raw:string){
 if(typeof raw!=='string'||!unicode(raw)||bytes(raw)>feedSemanticLimits.resultBytes)throw new Error('Result limit');
 return JSON.parse(raw) as unknown;
}
/** Every non-whitespace UTF-16 code unit in every written field must be covered
 * by an exact rule or unsupported span. This detects omitted fields/passages;
 * it cannot establish that a paraphrase preserved every meaning. */
function covered(profile:FeedProfile,spans:FeedBriefSpan[]){
 const fields:{field:FeedBriefSpan['field'];index?:number;text:string}[]=[{field:'directions',text:profile.settings.directions},
  ...profile.settings.interests.map((text,index)=>({field:'interests' as const,index,text})),
  ...profile.settings.exclusions.map((text,index)=>({field:'exclusions' as const,index,text}))];
 return fields.every(({field,index,text})=>{
  const mask=new Uint8Array(text.length);
  for(const span of spans)if(span.field===field&&(span.field==='directions'||span.index===index))mask.fill(1,span.start,span.end);
  for(let i=0;i<text.length;i++)if(!mask[i]&&!/\s/u.test(text[i]))return false;
  return true;
 });
}
export function readFeedInterpretation(raw:string,input:FeedBriefCapture,digestText:FeedSemanticDigest):Result<{
 plan:FeedInterpretationPlan;planSha256:string;status:'reviewable'|'unsupported'|'no-inclusion'}>{
 try{const capture=checkedBrief(input,digestText);if(!capture)return fail('invalid-brief');
  const plan=planSchema.parse(readJson(raw));
  if(plan.requestId!==capture.requestId||plan.briefSha256!==capture.briefSha256)return fail('stale-brief');
  if(new Set(plan.rules.map(rule=>rule.id)).size!==plan.rules.length)return fail('duplicate-rule');
  for(const rule of plan.rules)for(const span of rule.sources){
   if(!exactSpan(briefText(capture.profile,span),span))return fail('invented-source');
   if(span.field==='exclusions'&&rule.kind!=='exclude'||span.field==='interests'&&rule.kind==='exclude')return fail('source-role');
  }
  if(plan.unsupported.some(span=>!exactSpan(briefText(capture.profile,span),span)))return fail('invented-source');
  if(!covered(capture.profile,[...plan.rules.flatMap(rule=>rule.sources),...plan.unsupported]))return fail('incomplete-coverage');
  return {ok:true,value:{plan,planSha256:hash(plan,digestText),status:plan.unsupported.length?'unsupported':
   plan.rules.some(rule=>rule.kind==='include')?'reviewable':'no-inclusion'}};
 }catch{return fail('invalid-plan');}
}
function checkedPlan(capture:FeedBriefCapture,plan:FeedInterpretationPlan,review:FeedInterpretationReview,digestText:FeedSemanticDigest){
 const parsed=readFeedInterpretation(JSON.stringify(plan),capture,digestText),accepted=reviewedSchema.parse(review);
 if(!parsed.ok||parsed.value.status!=='reviewable'||!equal(accepted.binding,capture.binding)||
  accepted.briefSha256!==capture.briefSha256||accepted.planSha256!==parsed.value.planSha256)return;
 return {plan:parsed.value.plan,planSha256:parsed.value.planSha256,review:accepted};
}
export function captureFeedSemanticPreview(current:FeedSemanticContext,input:FeedBriefCapture,plan:FeedInterpretationPlan,
 review:FeedInterpretationReview,story:FeedStory,requestId:string,digestText:FeedSemanticDigest):Result<FeedSemanticPreview>{
 try{const context=exactContext(current),capture=checkedBrief(input,digestText);uuid.parse(requestId);
  if(!capture||!equal(binding(context,digestText),capture.binding))return fail('stale-context');
  const checked=checkedPlan(capture,plan,review,digestText);if(!checked)return fail('review-required');
  const preview=feedStorySchema.parse(story);if(!equal(preview,story))return fail('invalid-preview');
  if(preview.summaryKind!=='publisher-preview'||!preview.summary.trim())return fail('insufficient-preview');
  const body={format:1 as const,requestId,binding:capture.binding,briefSha256:capture.briefSha256,
   planSha256:checked.planSha256,reviewRequestId:checked.review.reviewRequestId,story:preview};
  if(!bounded({context,brief:capture,plan:checked.plan,preview:body}))return fail('input-limit');
  return {ok:true,value:{...body,previewSha256:hash(body,digestText)}};
 }catch{return fail('invalid-preview');}
}
function checkedPreview(input:FeedSemanticPreview,digestText:FeedSemanticDigest){
 const preview=previewSchema.parse(input),{previewSha256,...body}=preview;
 return equal(preview,input)&&bounded(preview)&&hash(body,digestText)===previewSha256?preview:undefined;
}
export function readFeedSemanticResult(raw:string,input:FeedSemanticPreview,plan:FeedInterpretationPlan,digestText:FeedSemanticDigest):Result<FeedSemanticResult>{
 try{const preview=checkedPreview(input,digestText);if(!preview||hash(planSchema.parse(plan),digestText)!==preview.planSha256)return fail('invalid-preview');
  const result=resultSchema.parse(readJson(raw));
  if(result.requestId!==preview.requestId||result.previewSha256!==preview.previewSha256)return fail('stale-result');
  const ids=new Set(result.judgments.map(row=>row.ruleId));
  if(ids.size!==result.judgments.length||ids.size!==plan.rules.length||plan.rules.some(rule=>!ids.has(rule.id)))return fail('rule-coverage');
  for(const judgment of result.judgments){
   if(judgment.outcome==='met'&&!judgment.evidence.length)return fail('missing-evidence');
   if(judgment.outcome==='unknown'&&judgment.evidence.length)return fail('unknown-evidence');
   if(judgment.evidence.some(span=>!exactSpan(previewText(preview.story,span),span)))return fail('invented-evidence');
   if(new Set(judgment.evidence.map(canonical)).size!==judgment.evidence.length)return fail('duplicate-evidence');
  }
  return {ok:true,value:result};
 }catch{return fail('invalid-result');}
}
type LiteralDenied=Extract<FeedEligibility,{eligible:false}>['reason'];
export type FeedSemanticEligibility={eligible:false;profileRevision:number;storyId:string;storyRevision:number;
 reason:LiteralDenied|'invalid-context'|'review-required'|'stale-context'|'stale-preview'|'invalid-result'|'semantic-unknown'|'semantic-exclusion'|'semantic-requirement'}|
 {eligible:true;profileRevision:number;storyId:string;storyRevision:number;previewSha256:string;planSha256:string;
 reasons:{kind:'semantic-written';ruleId:string;direction:string;sources:FeedBriefSpan[];evidence:FeedPreviewSpan[]}[]};
export type FeedSemanticSelection={current:FeedSemanticContext;brief:FeedBriefCapture;plan:FeedInterpretationPlan;
 review:FeedInterpretationReview;preview:FeedSemanticPreview;result:FeedSemanticResult;digestText:FeedSemanticDigest};
/** Optional semantic selection never changes the literal legacy branch. Future
 * integration uses the shared hard guards from news-feed.ts. This source
 * proposal remains outside the app until its complete integration is reviewed.
 * Learned interests cannot independently admit a semantic-mode story here. */
export function feedEligibilityWithSemantic(profile:FeedProfile,control:FeedLearningControl,story:FeedStory,
 interests:FeedInterest[],evidence:FeedEvidence[],now:number,options:{following?:boolean;hidden?:readonly string[]}={},
 semantic?:FeedSemanticSelection):FeedEligibility|FeedSemanticEligibility{
 if(!semantic)return feedEligibility(profile,control,story,interests,evidence,now,options);
 const base={profileRevision:profile.revision,storyId:story.id,storyRevision:story.revision};
 const deny=(reason:Extract<FeedSemanticEligibility,{eligible:false}>['reason']):FeedSemanticEligibility=>({...base,eligible:false,reason});
 try{const current=exactContext(semantic.current);feedProfileSchema.parse(profile);feedLearningControlSchema.parse(control);feedStorySchema.parse(story);
  if(!Number.isFinite(now)||!equal(current.profile,profile)||!equal(current.control,control)||!equal(current.evidence,evidence))return deny('invalid-context');
  // Shared literal hard guards. Unsupported prose does not
  // suppress them, and a model result can never override any of them.
  const rules=interpretFeedProfile(profile),text=[story.title,story.summary,...story.topics].join('\n');
  const hardDenial=feedHardFilter(profile,story,options);if(hardDenial)return deny(hardDenial);
  // Explicit Only topics remains a hard scope boundary, including alongside
  // freeform prose. Semantic paraphrases cannot silently expand that scope.
  if(rules.only&&!rules.topics.some(topic=>feedContainsTopic(text,topic)))return deny('unsupported-match');
  const capture=checkedBrief(semantic.brief,semantic.digestText);
  if(!capture||!equal(binding(current,semantic.digestText),capture.binding))return deny('stale-context');
  const plan=checkedPlan(capture,semantic.plan,semantic.review,semantic.digestText);if(!plan)return deny('review-required');
  const original=checkedPreview(semantic.preview,semantic.digestText);
  const fresh=captureFeedSemanticPreview(current,capture,plan.plan,plan.review,story,semantic.preview.requestId,semantic.digestText);
  if(!original||!fresh.ok||fresh.value.previewSha256!==original.previewSha256)return deny('stale-preview');
  const result=readFeedSemanticResult(JSON.stringify(semantic.result),original,plan.plan,semantic.digestText);if(!result.ok)return deny('invalid-result');
  const byId=new Map(result.value.judgments.map(row=>[row.ruleId,row]));
  for(const rule of plan.plan.rules){const judgment=byId.get(rule.id)!;
   if(rule.kind==='exclude'&&judgment.outcome==='met')return deny('semantic-exclusion');
   if(rule.kind==='require'&&judgment.outcome==='not-met')return deny('semantic-requirement');
   if((rule.kind==='require'||rule.kind==='exclude')&&judgment.outcome==='unknown')return deny('semantic-unknown');
  }
  const reasons=plan.plan.rules.filter(rule=>rule.kind==='include'&&byId.get(rule.id)!.outcome==='met')
   .map(rule=>({kind:'semantic-written' as const,ruleId:rule.id,direction:rule.meaning,
    sources:structuredClone(rule.sources),evidence:structuredClone(byId.get(rule.id)!.evidence)}));
  return reasons.length?{...base,eligible:true,previewSha256:original.previewSha256,planSha256:plan.planSha256,reasons}:deny('unsupported-match');
 }catch{return deny('invalid-context');}
}
