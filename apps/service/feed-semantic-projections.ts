import {canonical} from '../../packages/domain/contracts.js';
import {feedHardFilter,feedContainsTopic,interpretFeedProfile,feedProfileSchema,feedStorySchema,
 type FeedStory,type FeedInterest,type FeedHardFilterDenial} from '../../packages/domain/news-feed.js';
import {captureFeedBrief,feedSemanticLimits,type FeedSemanticContext,type FeedSemanticDigest,type FeedBriefCapture}
 from '../../packages/domain/news-feed-interpretation.js';

/** Internal data, not permission or readiness. Current literal learning is kept
 * separate from any immutable accepted interpretation of written directions. */
export type FeedCurrentSnapshot={context:FeedSemanticContext;stories:FeedStory[];interests:FeedInterest[];
 hidden:string[];at:number;learningMode:'literal'|'interpretation-required'};
type ContextProjection={usable:true;context:FeedSemanticContext;brief:FeedBriefCapture;learningMode:FeedCurrentSnapshot['learningMode']}
 |{usable:false;reason:'evidence-limit'|'input-limit'|'invalid-context'};
/** Bounds classify use of a new result only. They never revoke access to an
 * original operation, clear it, or claim that current learning is semantic. */
export function projectFeedCurrentContext(snapshot:FeedCurrentSnapshot,requestId:string,digest:FeedSemanticDigest):ContextProjection{
 if(!snapshot?.context||!Array.isArray(snapshot.context.evidence))return {usable:false,reason:'invalid-context'};
 if(snapshot.context.evidence.length>feedSemanticLimits.evidenceRows)return {usable:false,reason:'evidence-limit'};
 const captured=captureFeedBrief(snapshot.context,requestId,digest);
 if(!captured.ok)return {usable:false,reason:captured.reason==='input-limit'?'input-limit':'invalid-context'};
 return {usable:true,context:structuredClone(snapshot.context),brief:captured.value,
  learningMode:interpretFeedProfile(snapshot.context.profile).status==='pending'?'interpretation-required':'literal'};
}
const targetSchema=feedStorySchema.pick({id:true,revision:true,sourceId:true,sourceDigest:true}).strict();
type Selection={available:true;story:FeedStory}|{available:false;reason:'invalid-current'|'story-changed'|'unsupported-match'|FeedHardFilterDenial};
/** Resolve an exact current cached preview and its shared hard constraints.
 * This does not establish a positive semantic or activity-only relevance match. */
export function selectFeedCurrentStory(snapshot:FeedCurrentSnapshot,raw:unknown,options:{following?:boolean}={}):Selection{
 try{
  const target=targetSchema.parse(raw),profile=feedProfileSchema.parse(snapshot.context.profile);
  if(canonical(target)!==canonical(raw)||canonical(profile)!==canonical(snapshot.context.profile)||
    !Array.isArray(snapshot.stories)||!Array.isArray(snapshot.hidden)||snapshot.hidden.some(id=>typeof id!=='string'))
   return {available:false,reason:'invalid-current'};
  const rows=snapshot.stories.filter(story=>story.id===target.id);
  if(rows.length!==1)return {available:false,reason:'story-changed'};
  const story=feedStorySchema.parse(rows[0]);
  if(canonical(story)!==canonical(rows[0])||story.revision!==target.revision||story.sourceId!==target.sourceId||story.sourceDigest!==target.sourceDigest)
   return {available:false,reason:'story-changed'};
  const denied=feedHardFilter(profile,story,{following:options.following,hidden:snapshot.hidden});
  if(denied)return {available:false,reason:denied};
  const rules=interpretFeedProfile(profile),text=[story.title,story.summary,...story.topics].join('\n');
  if(rules.only&&!rules.topics.some(topic=>feedContainsTopic(text,topic)))return {available:false,reason:'unsupported-match'};
  return {available:true,story:structuredClone(story)};
 }catch{return {available:false,reason:'invalid-current'};}
}
