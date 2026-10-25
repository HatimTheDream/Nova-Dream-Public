import {z} from 'zod';

const identity=z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const instant=z.string().datetime();
export const feedTopicKey=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const topic=z.string().trim().min(1).max(80).refine(v=>!/\p{Cc}/u.test(v),'Use one topic or phrase per entry.');
const topics=(maximum:number)=>z.array(topic).max(maximum).refine(values=>new Set(values.map(feedTopicKey)).size===values.length,'Keep each topic once.');
export const feedSourceUrl=(raw:string)=>{
 try{const url=new URL(raw);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash||url.href.length>2048||url.port&&!['80','443'].includes(url.port))return;return url.href;}catch{return;}
};
const publicUrl=z.string().max(2048).refine(v=>!!feedSourceUrl(v),'Use an HTTP or HTTPS address without credentials or a fragment.');
const publisher=z.string().min(1).max(253).refine(v=>{try{return new URL('https://'+v).hostname===v&&!v.includes(':')&&!v.includes('/');}catch{return false;}});
export const feedSourceSchema=z.object({id:identity,title:z.string().trim().min(1).max(150),url:publicUrl,enabled:z.boolean()}).strict();
export type FeedSource=z.infer<typeof feedSourceSchema>;
export const feedActivitySources=['reading','library','ideas'] as const;
const activitySource=z.enum(feedActivitySources);
export const feedSettingsSchema=z.object({
 interests:topics(32),directions:z.string().max(4000),exclusions:topics(32),
 sources:z.array(feedSourceSchema).max(12).refine(v=>new Set(v.map(s=>s.id)).size===v.length&&new Set(v.map(s=>feedSourceUrl(s.url))).size===v.length),
 followedPublishers:z.array(publisher).max(64),mutedPublishers:z.array(publisher).max(64),
 autoRefreshHours:z.union([z.literal(6),z.literal(12),z.literal(24)]).nullable().optional(),
 learning:z.object({enabled:z.boolean(),paused:z.boolean(),instructionsOnly:z.boolean(),
  allowed:z.array(activitySource).max(3).refine(v=>new Set(v).size===v.length),scope:z.enum(['within','related'])}).strict(),
}).strict();
export type FeedSettings=z.infer<typeof feedSettingsSchema>;
export const emptyFeedSettings=():FeedSettings=>({interests:[],directions:'',exclusions:[],sources:[],followedPublishers:[],mutedPublishers:[],
 learning:{enabled:false,paused:false,instructionsOnly:false,allowed:[],scope:'within'}});
export const feedProfileSchema=z.object({format:z.literal(1),revision:z.number().int().positive(),updatedAt:instant,settings:feedSettingsSchema}).strict();
export type FeedProfile=z.infer<typeof feedProfileSchema>;

/** Literal topic rules are deliberately named as such. Arbitrary prose does not
 * become a pretend semantic match: a later qualified interpreter must provide
 * its own exact-profile contract before unsupported directions can admit news. */
export type FeedInterpretation={status:'ready'|'pending'|'unconfigured';profileRevision:number;topics:string[];excluded:string[];only:boolean;unsupported:string[]};
export function interpretFeedProfile(profile:FeedProfile):FeedInterpretation{
 const settings=profile.settings,positive=[...settings.interests],negative=[...settings.exclusions],unsupported:string[]=[],onlyTopics:string[]=[];let only=false;
 for(const original of settings.directions.split(/\r?\n/u)){
  const line=original.trim();if(!line)continue;
  const rule=/^(Topics|Only topics|Exclude topics):\s*(.+)$/iu.exec(line);
  if(!rule){unsupported.push(original);continue;}
  const terms=rule[2].split(';').map(v=>v.trim()),valid=topics(32).safeParse(terms);
  if(!valid.success){unsupported.push(original);continue;}
  if(rule[1].toLowerCase()==='exclude topics')negative.push(...valid.data);
  else if(rule[1].toLowerCase()==='only topics'){if(only){unsupported.push(original);continue;}only=true;onlyTopics.push(...valid.data);}
  else positive.push(...valid.data);
 }
 const unique=(values:string[])=>[...new Map(values.map(value=>[feedTopicKey(value),value])).values()];
 const selected=only?onlyTopics:positive;
 return {status:unsupported.length?'pending':selected.length||settings.learning.enabled?'ready':'unconfigured',
  profileRevision:profile.revision,topics:unique(selected),excluded:unique(negative),only,unsupported};
}
export const feedStorySchema=z.object({
 id:digest,revision:z.number().int().positive(),canonicalUrl:publicUrl,sourceId:identity,publisherId:publisher,
 publisher:z.string().min(1).max(200),title:z.string().min(1).max(500),summary:z.string().max(20000),
 summaryKind:z.enum(['publisher-preview','url-only']),publishedAt:instant.nullable(),updatedAt:instant.nullable(),fetchedAt:instant,
 sourceDigest:digest,topics:topics(32),
}).strict();
export type FeedStory=z.infer<typeof feedStorySchema>;
export const feedEvidenceSchema=z.object({
 id:identity,eventId:identity,source:activitySource,sourceId:identity,sourceRevision:z.number().int().positive(),contextSha256:digest,
 at:instant,action:z.enum(['open','return','save','pursue']),topic,quote:z.string().min(1).max(2000),
 // The service resolves these from the current permitted source; never accept
 // client-supplied activity assertions as authority.
 available:z.boolean(),anchorTopics:topics(32),
 sourceEntryId:z.string().uuid().optional(),sourceOperationId:z.string().uuid().optional(),
}).strict();
export type FeedEvidence=z.infer<typeof feedEvidenceSchema>;
export type FeedInterest={topic:string;score:number;evidence:FeedEvidence[];status:'active'|'suggested'};
export const feedLearningControlSchema=z.object({resetAt:instant.nullable(),stopped:topics(64),kept:topics(64)}).strict();
export type FeedLearningControl=z.infer<typeof feedLearningControlSchema>;
export const emptyFeedLearningControl=():FeedLearningControl=>({resetAt:null,stopped:[],kept:[]});
const wordMatch=(haystack:string,needle:string)=>{
 const quoted=feedTopicKey(needle).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp(`(?<![\\p{L}\\p{N}_])${quoted}(?![\\p{L}\\p{N}_])`,'u').test(feedTopicKey(haystack));
};
export const feedContainsTopic=wordMatch;
const day=86400000,weights={open:0,return:1,save:3,pursue:4};
function allowedEvidence(profile:FeedProfile,control:FeedLearningControl,evidence:FeedEvidence,now:number){
 const at=Date.parse(evidence.at);
 return profile.settings.learning.allowed.includes(evidence.source)&&evidence.available&&Number.isFinite(at)&&at<=now
  &&(!control.resetAt||at>Date.parse(control.resetAt))&&now-at<=90*day&&!control.stopped.some(t=>feedTopicKey(t)===feedTopicKey(evidence.topic))
  &&wordMatch(evidence.quote,evidence.topic);
}
/** No passive exposures or single opens establish an interest. Each source
 * contributes at most its strongest action; repeats cannot manufacture weight. */
export function deriveFeedInterests(profile:FeedProfile,control:FeedLearningControl,evidence:FeedEvidence[],now:number):FeedInterest[]{
 const interpretation=interpretFeedProfile(profile);if(!Number.isFinite(now)||interpretation.status==='pending'||!profile.settings.learning.enabled)return [];
 const grouped=new Map<string,Map<string,FeedEvidence>>();
 for(const row of evidence){
  if(!allowedEvidence(profile,control,row,now)||!weights[row.action])continue;
  if(interpretation.excluded.some(t=>wordMatch(row.quote,t)||wordMatch(row.topic,t)))continue;
  const key=feedTopicKey(row.topic),source=`${row.source}:${row.sourceId}`,group=grouped.get(key)??new Map<string,FeedEvidence>();grouped.set(key,group);
  const prior=group.get(source);if(!prior||weights[row.action]>weights[prior.action]||weights[row.action]===weights[prior.action]&&row.at>prior.at)group.set(source,row);
 }
 const interests:FeedInterest[]=[];
 for(const rows of grouped.values()){
  const uniqueEvents=new Map<string,FeedEvidence>();for(const row of rows.values()){const prior=uniqueEvents.get(row.eventId);if(!prior||weights[row.action]>weights[prior.action])uniqueEvents.set(row.eventId,row);}
  const kept=[...uniqueEvents.values()].sort((a,b)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id)).slice(0,8);if(kept.length<2)continue;
  const score=kept.reduce((sum,row)=>sum+weights[row.action]*Math.pow(0.5,(now-Date.parse(row.at))/(30*day)),0);if(score<4)continue;
  const topic=kept[0].topic,within=interpretation.topics.some(t=>feedTopicKey(t)===feedTopicKey(topic));
  const adjacent=kept.filter(row=>row.anchorTopics.some(anchor=>interpretation.topics.some(t=>feedTopicKey(t)===feedTopicKey(anchor))&&wordMatch(row.quote,anchor))).length>=2;
  const activityOnly=interpretation.topics.length===0&&!interpretation.only;
  const permitted=within||activityOnly||!interpretation.only&&profile.settings.learning.scope==='related'&&adjacent;
  interests.push({topic,score,evidence:kept,status:permitted?'active':'suggested'});
 }
 return interests.sort((a,b)=>b.score-a.score||feedTopicKey(a.topic).localeCompare(feedTopicKey(b.topic))).slice(0,64);
}
export type FeedReason={kind:'written-topic'|'kept-interest'|'learned-interest';topic:string;evidenceIds:string[]};
export type FeedEligibility={eligible:true;profileRevision:number;storyId:string;storyRevision:number;reasons:FeedReason[]}
 |{eligible:false;profileRevision:number;storyId:string;storyRevision:number;reason:'setup'|'matching-pending'|'source-withdrawn'|'muted-publisher'|'excluded-topic'|'hidden-story'|'unsupported-match'|'not-followed'};
export type FeedHardFilterDenial='source-withdrawn'|'muted-publisher'|'excluded-topic'|'hidden-story'|'not-followed';
/** Shared constraints for literal and semantic selection. Callers retain their
 * own setup/review/positive-match checks; none can override this denial. */
export function feedHardFilter(profile:FeedProfile,story:FeedStory,
 options:{following?:boolean;hidden?:readonly string[]}={}):FeedHardFilterDenial|null{
 const rules=interpretFeedProfile(profile);
 if(!profile.settings.sources.some(source=>source.id===story.sourceId&&source.enabled))return ('source-withdrawn');
 if(profile.settings.mutedPublishers.includes(story.publisherId))return ('muted-publisher');
 const text=[story.title,story.summary,...story.topics].join('\n');
 if(rules.excluded.some(topic=>wordMatch(text,topic)))return ('excluded-topic');
 if(options.hidden?.includes(story.id))return ('hidden-story');
 if(options.following&&!profile.settings.followedPublishers.includes(story.publisherId))return ('not-followed');
 return null;
}
export function feedEligibility(profile:FeedProfile,control:FeedLearningControl,story:FeedStory,interests:FeedInterest[],
 evidence:FeedEvidence[],now:number,options:{following?:boolean;hidden?:readonly string[]}={}):FeedEligibility{
 const rules=interpretFeedProfile(profile),base={profileRevision:profile.revision,storyId:story.id,storyRevision:story.revision};
 const deny=(reason:Extract<FeedEligibility,{eligible:false}>['reason']):FeedEligibility=>({...base,eligible:false,reason});
 if(rules.status==='pending')return deny('matching-pending');
 if(rules.status==='unconfigured'&&!control.kept.length)return deny('setup');
 const hardDenial=feedHardFilter(profile,story,options);if(hardDenial)return deny(hardDenial);
 const text=[story.title,story.summary,...story.topics].join('\n');
 const reasons:FeedReason[]=rules.topics.filter(topic=>wordMatch(text,topic)).map(topic=>({kind:'written-topic',topic,evidenceIds:[]}));
 // Explicitly kept interests remain deliberate preferences after withdrawal or
 // reset. "Only topics" still prevents expansion beyond the written scope.
 for(const topic of control.kept)if(wordMatch(text,topic)&&(!rules.only||rules.topics.some(t=>feedTopicKey(t)===feedTopicKey(topic))))
  reasons.push({kind:'kept-interest',topic,evidenceIds:[]});
 if(profile.settings.learning.enabled&&!profile.settings.learning.instructionsOnly){
  for(const interest of interests){
   if(interest.status!=='active'||!wordMatch(text,interest.topic)||rules.only&&!rules.topics.some(t=>feedTopicKey(t)===feedTopicKey(interest.topic)))continue;
   const originals=evidence.filter(row=>interest.evidence.some(old=>old.id===row.id&&old.source===row.source&&old.sourceId===row.sourceId
    &&old.eventId===row.eventId&&old.sourceRevision===row.sourceRevision&&old.contextSha256===row.contextSha256&&old.topic===row.topic&&old.quote===row.quote&&old.at===row.at&&old.action===row.action));
   const current=deriveFeedInterests(profile,control,originals,now).find(row=>feedTopicKey(row.topic)===feedTopicKey(interest.topic)&&row.status==='active');
   if(current)reasons.push({kind:'learned-interest',topic:current.topic,evidenceIds:current.evidence.map(row=>row.id)});
  }
 }
 return reasons.length?{...base,eligible:true,reasons}:deny('unsupported-match');
}
export type FeedFeedback='more'|'less'|'neutral';
export const nextFeedFeedback=(current:FeedFeedback,selected:Exclude<FeedFeedback,'neutral'>):FeedFeedback=>current===selected?'neutral':selected;
export function rankEligibleFeed(stories:FeedStory[],profile:FeedProfile,control:FeedLearningControl,interests:FeedInterest[],evidence:FeedEvidence[],now:number,
 feedback:Readonly<Record<string,FeedFeedback|{value:FeedFeedback;topics?:string[]}>>,options:{following?:boolean;hidden?:readonly string[]}={}){
 const rows=stories.map(story=>({story,eligibility:feedEligibility(profile,control,story,interests,evidence,now,options)}))
  .filter((row):row is {story:FeedStory;eligibility:Extract<FeedEligibility,{eligible:true}>}=>row.eligibility.eligible);
 return rankAdmittedFeed(rows,feedback,now);
}
/** Ranking never grants eligibility. Consumers must supply independently
 * admitted rows; proof count and semantic labels cannot alter this arithmetic. */
export function rankAdmittedFeed<T extends {story:FeedStory}>(rows:T[],feedback:Readonly<Record<string,FeedFeedback|{value:FeedFeedback;topics?:string[]}>>,now:number):T[]{
 const value=(entry:FeedFeedback|{value:FeedFeedback}|undefined)=>typeof entry==='string'?entry:entry?.value;
 const score=(story:FeedStory)=>{const time=Date.parse(story.publishedAt??story.fetchedAt),age=Math.max(0,(now-time)/day);
  const text=[story.title,story.summary,...story.topics].join('\n');
  // Explicit feedback informs related *eligible* stories, even while automatic
  // learning is paused. It cannot create a topic, change rules or admit a row.
  const related=Object.entries(feedback).reduce((sum,[id,row])=>id!==story.id&&typeof row!=='string'&&row.topics?.some(topic=>wordMatch(text,topic))
   ?sum+(row.value==='more'?1:row.value==='less'?-2:0):sum,0);
  return 10/(1+age)+(value(feedback[story.id])==='more'?4:value(feedback[story.id])==='less'?-8:0)+Math.max(-6,Math.min(3,related));};
 return rows.sort((a,b)=>score(b.story)-score(a.story)||a.story.id.localeCompare(b.story.id));
}
export function resetFeedLearning(profile:FeedProfile,control:FeedLearningControl,at:string){
 instant.parse(at);
 return {profile:{...profile,settings:{...profile.settings,learning:{...profile.settings.learning,paused:true}}},
  control:{...control,resetAt:at},interests:[] as FeedInterest[]};
}
export function refreshFeedLearning(profile:FeedProfile,control:FeedLearningControl,previous:FeedInterest[],evidence:FeedEvidence[],now:number){
 return !profile.settings.learning.enabled||profile.settings.learning.paused?structuredClone(previous):deriveFeedInterests(profile,control,evidence,now);
}

const envelope={requestId:z.uuid().length(36),epoch:z.uuid().length(36)};
const guard={...envelope,expectedRevision:z.number().int().positive()};
const storyGuard=z.object({id:digest,revision:z.number().int().positive(),sourceId:identity,sourceDigest:digest}).strict();
export const feedCommandSchema=z.discriminatedUnion('type',[
 z.object({...guard,type:z.literal('settings'),settings:feedSettingsSchema}).strict(),
 z.object({...guard,type:z.literal('feedback'),story:storyGuard,value:z.enum(['more','less','neutral'])}).strict(),
 z.object({...guard,type:z.literal('visibility'),story:storyGuard,hidden:z.boolean()}).strict(),
 z.object({...guard,type:z.literal('reading'),story:storyGuard}).strict(),
 z.object({...guard,type:z.literal('unhide'),storyId:digest}).strict(),
 z.object({...guard,type:z.literal('interest'),topic,action:z.enum(['keep','stop','allow'])}).strict(),
 z.object({...guard,type:z.literal('learning-reset')}).strict(),
]);
export type FeedCommand=z.infer<typeof feedCommandSchema>;
export const feedRefreshSchema=z.object({...envelope,sourceId:identity,profileRevision:z.number().int().positive()}).strict();
export type FeedRefreshCommand=z.infer<typeof feedRefreshSchema>;
export type FeedSavedState={format:1;revision:number;profile:FeedProfile;control:FeedLearningControl;interests:FeedInterest[];
 feedback:{storyId:string;value:FeedFeedback;topics?:string[]}[];hidden:string[]};
export type FeedMutationReceipt={format:1;requestId:string;epoch:string;command:FeedCommand;at:string}
 &({state:'saved';revision:number;profileRevision:number}|{state:'rejected';code:string;message:string});
export type FeedSourceCache={source:FeedSource;profileRevision:number;fetchedAt:string;sourceDigest:string;stories:FeedStory[];rejectedCount:number};
export type FeedRefreshReceipt={format:1;requestId:string;epoch:string;deviceId:string;command:FeedRefreshCommand;source:FeedSource|null;
 startedAt:string;deadline:string;finishedAt:string|null;state:'running'|'saved'|'failed'|'unknown'|'withdrawn'|'rejected'|'expired';message:string;acceptedCount:number;rejectedCount:number};
export type FeedScheduleStatus={status:'off'|'paused'|'attention'|'full'|'checking'|'scheduled';message:string;nextAt:string|null;retainedCount:number;limit:512};
export type FeedState={epoch:string;value:FeedSavedState;interpretation:FeedInterpretation;schedule?:FeedScheduleStatus;
 stories:{story:FeedStory;eligibility:Extract<FeedEligibility,{eligible:true}>}[];eligibleCount:number;
 sources:{source:FeedSource;fetchedAt:string|null;acceptedCount:number;rejectedCount:number}[];
 hiddenStories:{id:string;title:string|null}[];
 activity:{status:'not-connected'|'ready';message:string;supported?:('reading'|'library'|'ideas')[];evidence?:FeedEvidence[]}};
