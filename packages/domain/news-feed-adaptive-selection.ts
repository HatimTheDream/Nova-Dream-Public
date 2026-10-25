import {z} from 'zod';
import {createHash} from 'node:crypto';
import {adaptiveActivitySchema,adaptiveCanonical,type AdaptiveActivity} from './news-feed-adaptive.js';
import {feedLearningControlSchema,type FeedSavedState,type FeedProfile,type FeedLearningControl,type FeedStory} from './news-feed.js';
import type {Store} from '../../apps/service/store.js';
const selectionDigest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const feedAdaptiveSelectionPolicy=Object.freeze({format:1,policy:'feed-adaptive-activity-v1',
 libraryRows:588,readingRows:2000,ideaIndexRows:128,selectedRows:128,textCodeUnits:12000,activityBytes:131072,
 order:'at-desc/source-id-asc/stable-library-reading-ideas',ageDays:90,ageFilter:'after-selection/no-backfill'} as const);
export const feedAdaptiveSelectionPolicySha256=selectionDigest(adaptiveCanonical(feedAdaptiveSelectionPolicy));
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
 const eventId='adaptive-event:'+selectionDigest(adaptiveCanonical({format:1,...event}));
 return {id:'adaptive-activity:'+selectionDigest(adaptiveCanonical({eventId,contextSha256})),eventId,...event,contextSha256,available:true};
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
  if(bytes>131072||bytes!==selection.activityBytes||selectionDigest(serialized)!==selection.activitySha256)return null;
  return selection;
 }catch{return null;}
}

