import {z} from 'zod';
import {feedSourceSchema,feedProfileSchema,feedLearningControlSchema,feedStorySchema,feedEvidenceSchema,rankAdmittedFeed,type FeedFeedback} from './news-feed.js';
import {feedPreviewSpanSchema} from './news-feed-interpretation.js';

export const feedViewByteLimit=524288;
const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identity=z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/),topic=z.string().min(1).max(80),instant=z.string().datetime();
const literalInterest=z.object({topic,score:z.number().finite().nonnegative(),status:z.enum(['active','suggested']),evidence:z.array(feedEvidenceSchema).max(8)}).strict();
const saved=z.object({format:z.literal(1),revision:positive,profile:feedProfileSchema,control:feedLearningControlSchema,
 interests:z.array(literalInterest).max(64),feedback:z.array(z.object({storyId:digest,value:z.enum(['more','less','neutral']),topics:z.array(topic).max(64).optional()}).strict()).max(2000),hidden:z.array(digest).max(2000)}).strict();
const interpretation=z.object({status:z.enum(['ready','pending','unconfigured']),profileRevision:positive,topics:z.array(topic).max(2048),excluded:z.array(topic).max(2048),only:z.boolean(),unsupported:z.array(z.string().max(4000)).max(4001)}).strict();
const literal=z.object({eligible:z.literal(true),profileRevision:positive,storyId:digest,storyRevision:positive,
 reasons:z.array(z.object({kind:z.enum(['written-topic','kept-interest','learned-interest']),topic,evidenceIds:z.array(identity).max(8)}).strict()).min(1).max(4096)}).strict();
const support=z.object({id:identity,eventId:identity,source:z.enum(['reading','library','ideas']),sourceId:identity,sourceRevision:positive,contextSha256:digest,
 at:instant,action:z.enum(['open','return','save','pursue']),available:z.literal(true),sourceEntryId:uuid.optional(),sourceOperationId:uuid.optional(),
 span:z.object({start:z.number().int().nonnegative(),end:positive,quote:z.string().min(1).max(2000)}).strict().refine(value=>value.end>value.start&&value.quote.length===value.end-value.start)}).strict().refine(value=>value.source==='ideas'?!!value.sourceEntryId&&!!value.sourceOperationId:!value.sourceEntryId&&!value.sourceOperationId);
const basis=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('empty'),sha256:digest}).strict(),
 z.object({kind:z.literal('accepted'),sha256:digest,reviewId:uuid,interpretationId:uuid,briefSha256:digest,planSha256:digest,terminalSha256:digest}).strict(),
]);
const semanticReason=z.object({kind:z.enum(['written','kept','learned']),id:identity,label:z.string().min(1).max(240),evidence:z.array(feedPreviewSpanSchema).min(1).max(8),supports:z.array(support).max(8)}).strict()
 .refine(value=>value.kind==='learned'?value.supports.length>=2:value.supports.length===0);
const semantic=z.object({operationId:uuid,terminalSha256:digest,basis,contextSha256:digest,previewSha256:digest,profileRevision:positive,storyId:digest,storyRevision:positive,
 reasons:z.array(semanticReason).min(1).max(160)}).strict();
const match=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('literal'),literal}).strict(),z.object({kind:z.literal('semantic'),semantic}).strict(),z.object({kind:z.literal('both'),literal,semantic}).strict(),
]);
const row=z.object({story:feedStorySchema,match}).strict();
const interest=z.object({id:digest,label:topic,learningRequestId:uuid,learningCaptureSha256:digest,appliedByRequestId:uuid,basis,
 score:z.number().finite().nonnegative(),status:z.enum(['active','suggested']),supports:z.array(support).min(2).max(8)}).strict();
const checkpoint=z.object({epoch:uuid,deviceId:uuid,savedRevision:positive,profileRevision:positive,following:z.boolean(),at:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
const semanticState=z.discriminatedUnion('state',[
 z.object({state:z.literal('ready'),interests:z.array(interest).max(64),ambiguousStories:z.number().int().nonnegative().max(1000000)}).strict(),
 z.object({state:z.literal('unavailable'),reason:z.enum(['current-source','story-inventory','response-budget']),interests:z.tuple([])}).strict(),
]);
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schedule=z.object({status:z.enum(['off','paused','attention','full','checking','scheduled']),message:z.string().max(4000),nextAt:instant.nullable(),retainedCount:count,limit:z.literal(512)}).strict();
const sourceState=z.object({source:feedSourceSchema,fetchedAt:instant.nullable(),acceptedCount:count,rejectedCount:count}).strict();
export const feedViewSchema=z.discriminatedUnion('state',[
 z.object({format:z.literal(1),state:z.literal('ready'),checkpoint,value:saved,interpretation,stories:z.array(row).max(100),eligibleCount:z.number().int().nonnegative().max(1000000),
  sources:z.array(sourceState).max(12),schedule:schedule.optional(),hiddenStories:z.array(z.object({id:digest,title:z.string().max(500).nullable()}).strict()).max(2000),
  activity:z.object({status:z.enum(['not-connected','ready']),message:z.string().max(2000),supported:z.array(z.enum(['reading','library','ideas'])).max(3).optional(),literalEvidence:z.array(feedEvidenceSchema).max(512)}).strict(),semantic:semanticState}).strict(),
 z.object({format:z.literal(1),state:z.literal('unavailable'),checkpoint,reason:z.literal('response-budget')}).strict(),
]);
export type FeedViewState=z.infer<typeof feedViewSchema>;
export type FeedViewReady=Extract<FeedViewState,{state:'ready'}>;
export type FeedViewRow=z.infer<typeof row>;
export type FeedViewSemantic=z.infer<typeof semantic>;
export type FeedViewInterest=z.infer<typeof interest>;
export type FeedViewBasis=z.infer<typeof basis>;

/** Exact JSON serialization with a bounded accumulator. Inputs must already be
 * shape-checked. Scalar strings have an independent finite ceiling. No combined
 * string larger than the budget is allocated, including escape-heavy UTF-8. */
export function boundedFeedViewJson(value:unknown,maximum=feedViewByteLimit):string|undefined{
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>feedViewByteLimit)throw Error('Invalid Feed view byte bound');
 const chunks:string[]=[];let bytes=0;const seen=new Set<object>();
 const add=(text:string)=>{const count=new TextEncoder().encode(text).byteLength;if(bytes+count>maximum)throw Error('budget');bytes+=count;chunks.push(text);};
 const walk=(item:unknown,depth:number)=>{
  if(depth>32)throw Error('depth');
  if(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item)){add(JSON.stringify(item));return;}
  if(typeof item==='string'){if(item.length>20000)throw Error('scalar');add(JSON.stringify(item));return;}
  if(!item||typeof item!=='object'||seen.has(item))throw Error('value');seen.add(item);
  try{
   if(Array.isArray(item)){add('[');for(let i=0;i<item.length;i++){if(i)add(',');walk(item[i]===undefined?null:item[i],depth+1);}add(']');return;}
   if(Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)throw Error('object');
   add('{');let first=true;for(const [key,entry] of Object.entries(item)){if(entry===undefined)continue;if(key.length>200)throw Error('key');if(!first)add(',');first=false;add(JSON.stringify(key));add(':');walk(entry,depth+1);}add('}');
  }finally{seen.delete(item);}
 };
 try{walk(value,0);const result=chunks.join('');if(new TextEncoder().encode(result).byteLength!==bytes)throw Error('serialization');return result;}catch{return;}
}

// Compare normalized parser output without constructing an aggregate JSON string.
function exactJson(a:unknown,b:unknown):boolean{
 if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const left=Object.keys(a),right=Object.keys(b);return left.length===right.length&&left.every(key=>Object.prototype.hasOwnProperty.call(b,key)&&exactJson((a as any)[key],(b as any)[key]));
}
/** Strict shape and internal identity joins. Deep authorization/proof derivation
 * remains in the service; client DTO validation never creates authority. */
export function checkedFeedView(input:unknown):FeedViewState{
 const value=feedViewSchema.parse(input);if(!exactJson(value,input))throw Error('Feed view normalization refused');if(value.state==='unavailable')return value;
 const cp=value.checkpoint;
 if(value.value.revision!==cp.savedRevision||value.value.profile.revision!==cp.profileRevision||value.interpretation.profileRevision!==cp.profileRevision||
  new Set(value.stories.map(row=>row.story.id)).size!==value.stories.length||value.eligibleCount<value.stories.length)throw Error('Feed view identity changed');
 if(!exactJson(value.sources.map(row=>row.source),value.value.profile.settings.sources)||!exactJson(value.hiddenStories.map(row=>row.id),value.value.hidden))throw Error('Feed metadata checkpoint changed');
 const literalEvidence=value.activity.literalEvidence;
 for(const entry of value.value.interests)for(const evidence of entry.evidence)
  if(!literalEvidence.some(row=>exactJson(row,evidence)))throw Error('Literal interest evidence unavailable');
 for(const row of value.stories){
  if('literal' in row.match){const proof=row.match.literal;if(proof.storyId!==row.story.id||proof.storyRevision!==row.story.revision||proof.profileRevision!==cp.profileRevision)throw Error('Literal story identity changed');
   for(const reason of proof.reasons)if(reason.kind==='learned-interest'&&(!reason.evidenceIds.length||reason.evidenceIds.some(id=>!literalEvidence.some(row=>row.id===id))))throw Error('Literal story support unavailable');}
  if('semantic' in row.match){const proof=row.match.semantic;if(value.semantic.state!=='ready'||proof.storyId!==row.story.id||proof.storyRevision!==row.story.revision||proof.profileRevision!==cp.profileRevision)throw Error('Semantic story identity changed');
   for(const reason of proof.reasons){for(const span of reason.evidence){const text=span.field==='topics'?row.story.topics[span.index]:row.story[span.field];if(text===undefined||text.slice(span.start,span.end)!==span.quote)throw Error('Preview span changed');}
    if(reason.kind==='learned'){const original=value.semantic.interests.find(i=>i.id===reason.id);if(!original||original.status!=='active'||original.label!==reason.label||!exactJson(original.supports,reason.supports))throw Error('Current learned support changed');}}
  }
 }
 return value;
}

export function boundFeedView(complete:FeedViewReady,literalFallback:FeedViewReady):FeedViewState{
 const full=checkedFeedView(complete);if(boundedFeedViewJson(full)!==undefined)return full;
 const fallback=checkedFeedView(literalFallback);if(fallback.state!=='ready'||fallback.semantic.state!=='unavailable'||fallback.semantic.reason!=='response-budget'||fallback.stories.some(row=>row.match.kind!=='literal'))throw Error('Invalid literal budget fallback');
 if(boundedFeedViewJson(fallback)!==undefined)return fallback;
 const unavailable=checkedFeedView({format:1,state:'unavailable',checkpoint:complete.checkpoint,reason:'response-budget'});
 if(boundedFeedViewJson(unavailable)===undefined)throw Error('Feed checkpoint exceeds response budget');return unavailable;
}

/** Pure presentation assembly over already admitted complete candidates. It
 * cannot validate a retained original or grant authority. Source callers must
 * establish both branches and common denials before using this function. */
export function composeFeedView(base:Omit<FeedViewReady,'stories'|'eligibleCount'|'semantic'>,
 literalRows:{story:FeedViewRow['story'];eligibility:Extract<FeedViewRow['match'],{kind:'literal'}>['literal']}[],
 semanticRows:{story:FeedViewRow['story'];proof:FeedViewSemantic}[],semantic:FeedViewReady['semantic'],
 feedback:Readonly<Record<string,FeedFeedback|{value:FeedFeedback;topics?:string[]}>>):FeedViewState{
 const rows=new Map<string,FeedViewRow>();
 for(const row of literalRows){if(rows.has(row.story.id))throw Error('Duplicate literal view identity');rows.set(row.story.id,{story:row.story,match:{kind:'literal',literal:row.eligibility}});}
 const seen=new Set<string>();for(const row of semanticRows){if(seen.has(row.story.id))throw Error('Duplicate semantic view identity');seen.add(row.story.id);const prior=rows.get(row.story.id);
  if(prior){if(!exactJson(prior.story,row.story)||prior.match.kind!=='literal')throw Error('Combined current preview changed');prior.match={kind:'both',literal:prior.match.literal,semantic:row.proof};}
  else rows.set(row.story.id,{story:row.story,match:{kind:'semantic',semantic:row.proof}});
 }
 const ranked=rankAdmittedFeed([...rows.values()],feedback,base.checkpoint.at);
 const complete:FeedViewReady={...base,stories:ranked.slice(0,100),eligibleCount:ranked.length,semantic};
 // Overflow fallback starts from ALL literal candidates, not the capped union.
 const literal=rankAdmittedFeed(literalRows.map(row=>({story:row.story,match:{kind:'literal' as const,literal:row.eligibility}})),feedback,base.checkpoint.at);
 const fallback:FeedViewReady={...base,stories:literal.slice(0,100),eligibleCount:literal.length,semantic:{state:'unavailable',reason:'response-budget',interests:[]}};
 return boundFeedView(complete,fallback);
}
