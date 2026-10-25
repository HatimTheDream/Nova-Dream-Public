import {z} from 'zod';
import {canonical} from '../../packages/domain/contracts.js';
import {adaptiveActivitySchema,adaptiveCanonical,type AdaptiveActivity} from '../../packages/domain/news-feed-adaptive.js';
import {feedProfileSchema,feedLearningControlSchema,feedStorySchema,type FeedSavedState,type FeedProfile,
 type FeedLearningControl,type FeedStory} from '../../packages/domain/news-feed.js';
import {homeItemValueSchema,type HomeItem} from '../../packages/domain/home-library.js';
import {ideaPursuitSchema,ideaEntrySchema} from '../../packages/domain/idea-pursuits.js';
import {authoredIdea,ideaActivityPrefix} from './idea-activity.js';
import {readingKey} from './news-feed-activity.js';
import {newsDigest} from './news-feed-parser.js';
import type {Store} from './store.js';

/** Source policy is service-owned. A digest checks identity, not provenance.
 * Retain this selection beside the strict adaptive capture in its future owned
 * admission graph. Never send this local snapshot wholesale to a model/client. */
export const feedAdaptiveSelectionPolicy=Object.freeze({format:1,policy:'feed-adaptive-activity-v1',
 libraryRows:588,readingRows:2000,ideaIndexRows:128,selectedRows:128,textCodeUnits:12000,activityBytes:131072,
 order:'at-desc/source-id-asc/stable-library-reading-ideas',ageDays:90,ageFilter:'after-selection/no-backfill'} as const);
export const feedAdaptiveSelectionPolicySha256=newsDigest(adaptiveCanonical(feedAdaptiveSelectionPolicy));
const identity=z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/),uuid=z.string().uuid();
const positive=z.number().int().positive().refine(Number.isSafeInteger),instant=z.string().datetime();
const digest=z.string().regex(/^[a-f0-9]{64}$/),count=z.number().int().nonnegative().refine(Number.isSafeInteger);
const itemEnvelope=z.object({id:identity,revision:positive,updatedAt:instant}).strict();
const readingSchema=z.object({storyId:identity,revision:positive,sourceId:identity,sourceDigest:digest,
 firstAt:instant,lastAt:instant,returnedAt:instant.nullable()}).strict();
const ideaActivitySchema=z.object({pursuitId:uuid,entryId:uuid,operationId:uuid,at:instant,authoredSha256:digest}).strict();
const ideaRunSchema=z.object({pursuitId:uuid,entryId:uuid,operationId:uuid,conversationId:uuid,createdAt:instant}).strict();
const windowRowSchema=z.object({id:identity,eventId:identity,source:z.enum(['library','reading','ideas']),sourceId:identity,
 sourceRevision:positive,contextSha256:digest,at:instant,action:z.enum(['save','open','return','pursue']),available:z.literal(true),
 sourceEntryId:uuid.optional(),sourceOperationId:uuid.optional()}).strict().refine(row=>row.source==='ideas'
 ?!!row.sourceEntryId&&!!row.sourceOperationId&&row.action==='pursue'
 :!row.sourceEntryId&&!row.sourceOperationId&&(row.source==='library'?row.action==='save':['open','return'].includes(row.action)));
const sourceCountSchema=z.object({observed:count,joined:count}).strict();
const selectionSchema=z.object({format:z.literal(1),policy:z.literal('feed-adaptive-activity-v1'),policySha256:digest,
 limits:z.object({libraryRows:z.literal(588),readingRows:z.literal(2000),ideaIndexRows:z.literal(128),selectedRows:z.literal(128),
  textCodeUnits:z.literal(12000),activityBytes:z.literal(131072)}).strict(),
 counts:z.object({library:sourceCountSchema,reading:sourceCountSchema,ideas:sourceCountSchema}).strict(),
 window:z.array(windowRowSchema).max(128),excluded:z.object({future:count,expired:count,reset:count}).strict(),
 returned:count,activitySha256:digest,activityBytes:count}).strict();
export type FeedAdaptiveSelection=z.infer<typeof selectionSchema>;
export type FeedAdaptiveActivityResult={usable:true;activity:AdaptiveActivity[];selection:FeedAdaptiveSelection}
 |{usable:false;reason:'invalid-source'|'source-window-limit'|'activity-text-limit'|'activity-input-limit'};
export type FeedAdaptiveSourceSnapshot={epoch:string;deviceId:string;profile:FeedProfile;control:FeedLearningControl;
 activity:AdaptiveActivity[];stories:FeedStory[];hidden:string[];at:number;selection:FeedAdaptiveSelection};
export type FeedAdaptiveSourceResult={usable:true;snapshot:FeedAdaptiveSourceSnapshot}|Extract<FeedAdaptiveActivityResult,{usable:false}>;
type SourceStore=Pick<Store,'epoch'|'internalRead'|'internalPage'>;
type Context={source:AdaptiveActivity['source'];sourceId:string;sourceRevision:number;at:string;action:AdaptiveActivity['action'];
 text:string;contextSha256:string;sourceEntryId?:string;sourceOperationId?:string};
const same=(a:unknown,b:unknown)=>adaptiveCanonical(a)===adaptiveCanonical(b);
function exact<T>(schema:z.ZodType<T>,raw:unknown):T{const value=schema.parse(raw);if(!same(raw,value))throw Error('Changed source');return value;}
function excluded(at:string,now:number,control:FeedLearningControl):keyof FeedAdaptiveSelection['excluded']|undefined{
 const time=Date.parse(at);if(time>now)return 'future';if(now-time>90*86400000)return 'expired';
 if(control.resetAt&&time<=Date.parse(control.resetAt))return 'reset';return undefined;
}
function sourceIdentity(row:Context):z.infer<typeof windowRowSchema>{
 const {text,contextSha256,...event}=row;
 const eventId='adaptive-event:'+newsDigest(adaptiveCanonical({format:1,...event}));
 return {id:'adaptive-activity:'+newsDigest(adaptiveCanonical({eventId,contextSha256})),eventId,...event,contextSha256,available:true};
}
function counts(){return {library:{observed:0,joined:0},reading:{observed:0,joined:0},ideas:{observed:0,joined:0}};}

/** Shape/consistency validation only. This cannot authenticate caller-supplied
 * activity or replace a fresh same-snapshot source/retained-graph comparison. */
export function readFeedAdaptiveSelection(activity:AdaptiveActivity[],raw:unknown,now:number,control:FeedLearningControl):FeedAdaptiveSelection|null{
 try{
  if(!Number.isSafeInteger(now)||now<0)return null;
  exact(feedLearningControlSchema,control);
  const selection=exact(selectionSchema,raw),rows=exact(z.array(adaptiveActivitySchema).max(128),activity);
  if(selection.policySha256!==feedAdaptiveSelectionPolicySha256)return null;
  const joined=Object.values(selection.counts).reduce((sum,c)=>sum+c.joined,0);
  if(selection.window.length!==Math.min(128,joined)||Object.entries(selection.counts).some(([source,c])=>
   c.joined>c.observed||c.observed>({library:588,reading:2000,ideas:128}[source as keyof typeof selection.counts])||
   selection.window.filter(row=>row.source===source).length>c.joined))return null;
  if(new Set(selection.window.map(row=>row.id)).size!==selection.window.length||new Set(selection.window.map(row=>row.eventId)).size!==selection.window.length)return null;
  if(selection.window.some(row=>{const {id,eventId,available,...event}=row;return !same(row,sourceIdentity({...event,text:''}));}))return null;
  if(selection.window.some((row,index)=>index>0&&(selection.window[index-1].at.localeCompare(row.at)<0||
   selection.window[index-1].at===row.at&&selection.window[index-1].sourceId.localeCompare(row.sourceId)>0)))return null;
  const rejected={future:0,expired:0,reset:0},kept=selection.window.filter(row=>{const why=excluded(row.at,now,control);if(why){rejected[why]++;return false;}return true;});
  if(!same(rejected,selection.excluded)||!same(kept,rows.map(({text,...row})=>row))||selection.returned!==rows.length)return null;
  const serialized=adaptiveCanonical(rows),bytes=Buffer.byteLength(serialized,'utf8');
  if(bytes>131072||bytes!==selection.activityBytes||newsDigest(serialized)!==selection.activitySha256)return null;
  return selection;
 }catch{return null;}
}

/** Synchronous current permitted source reads. The owning caller supplies a
 * Store read snapshot; no private broad snapshot, writes or provider calls. */
export function collectFeedAdaptiveActivity(store:SourceStore,saved:FeedSavedState,stories:FeedStory[],now:number):FeedAdaptiveActivityResult{
 try{
  if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid time');
  exact(uuid,store.epoch);exact(feedProfileSchema,saved.profile);exact(feedLearningControlSchema,saved.control);
  const learning=saved.profile.settings.learning,contexts:Context[]=[],seen=counts();
  const enabled=learning.enabled&&!learning.instructionsOnly&&learning.allowed.length>0;
  if(enabled&&learning.allowed.includes('library')){
   const prefix='home:library:item:',first=store.internalPage<unknown>(prefix,'',500);
   const items=first.length===500?[...first,...store.internalPage<unknown>(prefix,first[499].id,89)]:first;
   if(first.length>500||items.length>588)return {usable:false,reason:'source-window-limit'};
   seen.library.observed=items.length;
   let prior='';
   for(const row of items){
    if(!row.id.startsWith(prefix)||row.id<=prior)throw Error('Invalid item page');prior=row.id;
    if(!row.value||typeof row.value!=='object')throw Error('Invalid item');
    const {id,revision,updatedAt,...raw}=row.value as HomeItem;
    const envelope=exact(itemEnvelope,{id,revision,updatedAt}),value=exact(homeItemValueSchema,raw);
    if(row.id!==prefix+envelope.id)throw Error('Item identity changed');
    if(value.archived)continue;
    contexts.push({source:'library',sourceId:id,sourceRevision:revision,at:updatedAt,action:'save',
     text:[value.title,value.body].join('\n'),contextSha256:newsDigest(canonical({kind:value.kind,title:value.title,body:value.body,...(value.kind==='link'?{url:value.url}:{})}))});
    seen.library.joined++;
   }
  }
  if(enabled&&learning.allowed.includes('reading')){
   const stored=store.internalRead<unknown>(readingKey),raw=stored===undefined?[]:stored;
   if(!Array.isArray(raw))throw Error('Invalid reading history');
   if(raw.length>2000)return {usable:false,reason:'source-window-limit'};
   const events=exact(z.array(readingSchema).max(2000),raw),eventIds=new Set<string>();seen.reading.observed=events.length;
   const current=new Map<string,FeedStory>();
   for(const rawStory of stories){const story=exact(feedStorySchema,rawStory);if(current.has(story.id))throw Error('Duplicate story');current.set(story.id,story);}
   for(const event of events){
    if(eventIds.has(event.storyId)||Date.parse(event.lastAt)<Date.parse(event.firstAt)||
     event.returnedAt&&(Date.parse(event.returnedAt)<Date.parse(event.firstAt)||Date.parse(event.returnedAt)>Date.parse(event.lastAt)))throw Error('Invalid reading identity/time');
    eventIds.add(event.storyId);
    const story=current.get(event.storyId);
    if(!story||story.revision!==event.revision||story.sourceId!==event.sourceId||story.sourceDigest!==event.sourceDigest)continue;
    const text=[story.title,story.summary,...story.topics].join('\n');
    contexts.push({source:'reading',sourceId:story.id,sourceRevision:story.revision,at:event.returnedAt??event.firstAt,
     action:event.returnedAt?'return':'open',text,contextSha256:newsDigest(canonical({storyId:story.id,revision:story.revision,sourceDigest:story.sourceDigest,text}))});
    seen.reading.joined++;
   }
  }
  if(enabled&&learning.allowed.includes('ideas')){
   const items=store.internalPage<unknown>(ideaActivityPrefix,'',128);
   if(items.length>128)return {usable:false,reason:'source-window-limit'};
   seen.ideas.observed=items.length;let prior='';const operations=new Set<string>();
   for(const row of items){
    const activity=exact(ideaActivitySchema,row.value),time=Date.parse(activity.at);
    if(time<0||time>9999999999999||row.id!==ideaActivityPrefix+(9999999999999-time).toString().padStart(13,'0')+':'+activity.operationId||
     row.id<=prior||operations.has(activity.operationId))throw Error('Invalid Idea activity identity');
    prior=row.id;operations.add(activity.operationId);
    const pursuitRaw=store.internalRead('home:ideas:pursuit:'+activity.pursuitId),entryRaw=store.internalRead('home:ideas:entry:'+activity.entryId);
    if(pursuitRaw===undefined||entryRaw===undefined)continue;
    const pursuit=exact(ideaPursuitSchema,pursuitRaw),entry=exact(ideaEntrySchema,entryRaw);
    if(pursuit.id!==activity.pursuitId||entry.id!==activity.entryId||entry.pursuitId!==pursuit.id)throw Error('Idea identity changed');
    if(pursuit.epoch!==store.epoch||entry.epoch!==store.epoch)continue;
    const linkRaw=store.internalRead(`home:ideas:run:${pursuit.id}:${activity.at}:${activity.operationId}`);
    if(linkRaw===undefined)continue;
    const link=exact(ideaRunSchema,linkRaw);
    if(link.pursuitId!==pursuit.id||link.entryId!==entry.id||link.operationId!==activity.operationId||link.createdAt!==activity.at)throw Error('Original Idea link changed');
    const authored=authoredIdea(entry);
    if(authored.hash!==activity.authoredSha256)throw Error('Original authored Idea changed');
    if(!authored.text.trim())continue;
    contexts.push({source:'ideas',sourceId:pursuit.id,sourceRevision:1,at:activity.at,action:'pursue',text:authored.text,
     contextSha256:authored.hash,sourceEntryId:entry.id,sourceOperationId:activity.operationId});seen.ideas.joined++;
   }
  }
  const selected=contexts.sort((a,b)=>b.at.localeCompare(a.at)||a.sourceId.localeCompare(b.sourceId)).slice(0,128);
  const window=selected.map(sourceIdentity),rejected={future:0,expired:0,reset:0},activity:AdaptiveActivity[]=[];
  for(let i=0;i<selected.length;i++){
   const row=selected[i],why=excluded(row.at,now,saved.control);if(why){rejected[why]++;continue;}
   if(row.text.length>12000)return {usable:false,reason:'activity-text-limit'};
   activity.push(exact(adaptiveActivitySchema,{...window[i],text:row.text}));
  }
  const serialized=adaptiveCanonical(activity),bytes=Buffer.byteLength(serialized,'utf8');
  if(bytes>131072)return {usable:false,reason:'activity-input-limit'};
  const selection:FeedAdaptiveSelection={format:1,policy:'feed-adaptive-activity-v1',policySha256:feedAdaptiveSelectionPolicySha256,
   limits:{libraryRows:588,readingRows:2000,ideaIndexRows:128,selectedRows:128,textCodeUnits:12000,activityBytes:131072},
   counts:seen,window,excluded:rejected,returned:activity.length,activitySha256:newsDigest(serialized),activityBytes:bytes};
  if(!readFeedAdaptiveSelection(activity,selection,now,saved.control))throw Error('Invalid selection');
  return {usable:true,activity:structuredClone(activity),selection:structuredClone(selection)};
 }catch{return {usable:false,reason:'invalid-source'};}
}
