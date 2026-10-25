import {canonical} from '../../packages/domain/contracts.js';
import {feedContainsTopic,feedTopicKey,interpretFeedProfile,type FeedEvidence,type FeedSavedState,type FeedStory} from '../../packages/domain/news-feed.js';
import type {HomeItem} from '../../packages/domain/home-library.js';
import type {Store} from './store.js';
import {newsDigest} from './news-feed-parser.js';
import {ideaActivityPrefix,authoredIdea,type IdeaActivity} from './idea-activity.js';
import type {IdeaEntry,IdeaPursuit,IdeaRun} from '../../packages/domain/idea-pursuits.js';

export const readingKey='home:news:reading';
export type FeedReadingEvent={storyId:string;revision:number;sourceId:string;sourceDigest:string;firstAt:string;lastAt:string;returnedAt:string|null};
type Context={id:string;source:'reading'|'library'|'ideas';revision:number;at:string;action:'open'|'return'|'save'|'pursue';text:string;hash:string;entryId?:string;operationId?:string};
const unique=(values:string[])=>[...new Map(values.map(value=>[feedTopicKey(value),value])).values()];
const currentText=(story:FeedStory)=>[story.title,story.summary,...story.topics].join('\n');
export function feedFeedbackTopics(saved:FeedSavedState,story:FeedStory){
 return unique([...story.topics,...interpretFeedProfile(saved.profile).topics,...saved.control.kept])
  .filter(topic=>feedContainsTopic(currentText(story),topic)).slice(0,8);
}
function quotation(text:string,topic:string,anchors:string[]){
 const normalized=text.normalize('NFKC'),lower=normalized.toLowerCase(),snippets:string[]=[];
 for(const term of [topic,...anchors]){
  const index=lower.indexOf(term.normalize('NFKC').toLowerCase());
  if(index<0)continue;
  const start=Math.max(0,index-160),end=Math.min(normalized.length,index+term.length+220);
  const part=normalized.slice(start,end);if(!snippets.includes(part))snippets.push(part);
 }
 return snippets.join('\n…\n').slice(0,2000);
}
/** Read only explicitly selected material. No workspace snapshot, conversation,
 * mail, calendar or source-body fetch is part of the collector. Current saved
 * source revisions are joined on every read; old quotes never authorize use. */
export function collectFeedEvidence(store:Store,saved:FeedSavedState,stories:FeedStory[],now:number):FeedEvidence[]{
 const learning=saved.profile.settings.learning;
 if(!learning.enabled||learning.instructionsOnly||!learning.allowed.length)return [];
 const rules=interpretFeedProfile(saved.profile);
 if(rules.status==='pending')return [];
 const labels=unique([...rules.topics,...saved.control.kept,...stories.flatMap(story=>story.topics)]).slice(0,64);
 const contexts:Context[]=[];
 if(learning.allowed.includes('library')){
  const items=store.internalList<HomeItem>('home:library:item:');
  for(const item of items)if(!item.archived){
   const text=[item.title,item.body].join('\n');
   contexts.push({id:item.id,source:'library',revision:item.revision,at:item.updatedAt,action:'save',text,
    hash:newsDigest(canonical({kind:item.kind,title:item.title,body:item.body,...(item.kind==='link'?{url:item.url}:{})}))});
  }
 }
 if(learning.allowed.includes('reading')){
  const events=store.internalRead<FeedReadingEvent[]>(readingKey)??[];
  for(const event of events){
   const story=stories.find(row=>row.id===event.storyId&&row.revision===event.revision&&row.sourceId===event.sourceId&&row.sourceDigest===event.sourceDigest);
   if(!story)continue;
   const text=currentText(story);
   contexts.push({id:story.id,source:'reading',revision:story.revision,at:event.returnedAt??event.firstAt,
    action:event.returnedAt?'return':'open',text,hash:newsDigest(canonical({storyId:story.id,revision:story.revision,sourceDigest:story.sourceDigest,text}))});
  }
 }
 if(learning.allowed.includes('ideas')){
  for(const {value:activity} of store.internalPage<IdeaActivity>(ideaActivityPrefix,'',128)){
   const pursuit=store.internalRead<IdeaPursuit>('home:ideas:pursuit:'+activity.pursuitId),entry=store.internalRead<IdeaEntry>('home:ideas:entry:'+activity.entryId);
   if(!pursuit||!entry||pursuit.epoch!==store.epoch||entry.epoch!==store.epoch||entry.pursuitId!==pursuit.id)continue;
   const link=store.internalRead<IdeaRun>(`home:ideas:run:${pursuit.id}:${activity.at}:${activity.operationId}`);
   if(!link||link.pursuitId!==pursuit.id||link.entryId!==entry.id||link.operationId!==activity.operationId||link.createdAt!==activity.at)continue;
   const authored=authoredIdea(entry);if(!authored.text.trim()||authored.hash!==activity.authoredSha256)continue;
   contexts.push({id:pursuit.id,source:'ideas',revision:1,at:activity.at,action:'pursue',text:authored.text,hash:authored.hash,entryId:entry.id,operationId:activity.operationId});
  }
 }
 const evidence:FeedEvidence[]=[];
 // Deterministic bounded work. Older and reset activity is ineligible before
 // quoting. Labels come from current explicit topics or publisher categories;
 // this is literal evidence, not an invented semantic interpretation.
 for(const context of contexts.sort((a,b)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id)).slice(0,128)){
  const at=Date.parse(context.at);if(!Number.isFinite(at)||at>now||now-at>90*86400000||saved.control.resetAt&&at<=Date.parse(saved.control.resetAt))continue;
  const excerpt=context.text.slice(0,12000);
  const anchors=rules.topics.filter(topic=>feedContainsTopic(excerpt,topic)).slice(0,4);
  for(const topic of labels){
   if(saved.control.stopped.some(stopped=>feedTopicKey(stopped)===feedTopicKey(topic))||!feedContainsTopic(excerpt,topic))continue;
   const quote=quotation(excerpt,topic,anchors);if(!quote||!feedContainsTopic(quote,topic))continue;
   const eventId=`${context.source}:${newsDigest(canonical({id:context.id,revision:context.revision,at:context.at,action:context.action}))}`;
   evidence.push({id:`evidence:${newsDigest(canonical({eventId,topic:feedTopicKey(topic),hash:context.hash}))}`,eventId,
    source:context.source,sourceId:context.id,sourceRevision:context.revision,contextSha256:context.hash,at:context.at,
    action:context.action,topic,quote,available:true,anchorTopics:anchors.filter(anchor=>feedContainsTopic(quote,anchor)),
    ...(context.entryId?{sourceEntryId:context.entryId,sourceOperationId:context.operationId}:{})});
   if(evidence.length>=512)return evidence;
  }
 }
 return evidence;
}
