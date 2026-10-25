import {canonical} from '../../packages/domain/contracts.js';
import {emptyFeedSettings,emptyFeedLearningControl,feedCommandSchema,feedRefreshSchema,feedSettingsSchema,feedProfileSchema,feedLearningControlSchema,feedStorySchema,interpretFeedProfile,rankEligibleFeed,feedTopicKey,resetFeedLearning,refreshFeedLearning,deriveFeedInterests,
 type FeedStory,type FeedSavedState,type FeedMutationReceipt,type FeedRefreshCommand,type FeedRefreshReceipt,type FeedSourceCache,type FeedSource,type FeedState} from '../../packages/domain/news-feed.js';
import {Fault,type Store} from './store.js';
import {canonicalNewsUrl,newsDigest,type ParsedNewsFeed} from './news-feed-parser.js';
import {fetchNewsFeed} from './news-feed-fetch.js';
import {collectFeedEvidence,feedFeedbackTopics,readingKey,type FeedReadingEvent} from './news-feed-activity.js';
import {FeedSchedule} from './news-feed-schedule.js';
import type {FeedCurrentSnapshot} from './feed-semantic-projections.js';
import {collectFeedAdaptiveActivity,type FeedAdaptiveSourceResult} from './feed-adaptive-activity.js';
import {currentFeedStoryInventory} from './news-feed-story-inventory.js';

const stateKey='home:news:state',cacheKey='home:news:cache',operationKey='home:news:refresh:';
const maximumCacheBytes=8*1024*1024;
type ReadingAdmission={authorize():void;eligible(story:FeedStory):boolean};
type FetchPort=(source:FeedSource,signal:AbortSignal,permitted:()=>boolean)=>Promise<ParsedNewsFeed>;
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
/** Local encrypted state and explicitly requested public feed fetches. Reading
 * this service never opens private conversations, mail, calendars or an URL. */
export class NewsFeed {
 private running=new Map<string,AbortController>();
 private closed=false;
 private timer?:ReturnType<typeof setInterval>;
 private schedule:FeedSchedule;
 constructor(private store:Store,private now=Date.now,private fetchSource:FetchPort=fetchNewsFeed){
  this.schedule=new FeedSchedule(store,{saved:()=>this.saved(),refresh:(device,command)=>this.refresh(device,command),
   receipt:(device,command)=>this.refreshReceipt(device,command),count:()=>store.internalList(operationKey).length},now);
 }
 start(){if(this.closed||this.timer)return;this.timer=setInterval(()=>{void this.tick().catch(()=>undefined);},60000);this.timer.unref();}
 tick(){return this.schedule.tick();}
 private at(){return new Date(this.now()).toISOString();}
 private saved():FeedSavedState{
  return this.store.internalRead<FeedSavedState>(stateKey)??{format:1,revision:1,
   profile:{format:1,revision:1,updatedAt:new Date(0).toISOString(),settings:emptyFeedSettings()},
   control:emptyFeedLearningControl(),interests:[],feedback:[],hidden:[]};
 }
 private available(){this.store.assertUpdateAdmission();if(this.closed||this.store.recoveryEffectsPaused)throw new Fault(409,'news_held','Feed changes are paused while workspace recovery is unresolved.');}
 private cache(state=this.saved()){
  const caches=this.store.internalRead<FeedSourceCache[]>(cacheKey)??[];
  return state.profile.settings.sources.filter(source=>source.enabled).flatMap(source=>{
   const row=caches.find(row=>row.source.id===source.id);
   return row&&same(row.source,source)?[row]:[];
  });
 }
 private learning(saved:FeedSavedState,now=this.now()){
  const stories=[...new Map(this.cache(saved).flatMap(row=>row.stories).map(story=>[story.id,story])).values()];
  const evidence=collectFeedEvidence(this.store,saved,stories,now);
  const proposed=refreshFeedLearning(saved.profile,saved.control,saved.interests,evidence,now);
  // Even paused learning must rejoin the exact currently permitted evidence.
  // Dropped/changed sources cannot keep an old derived interest alive.
  const interests=proposed.flatMap(interest=>{
   const current=evidence.filter(row=>interest.evidence.some(old=>same(old,row)));
   const qualified=deriveFeedInterests(saved.profile,saved.control,current,now).find(row=>feedTopicKey(row.topic)===feedTopicKey(interest.topic));
   return qualified?[qualified]:[];
  });
  return {stories,evidence,interests};
 }
 /** Complete internal local projection, not a device authorization or readiness
  * decision. The caller must already own current request access. No timer,
  * fetch, model call, activity capture or saved-state write occurs here. */
 internalSemanticSnapshot(deviceId:string):FeedCurrentSnapshot{
  return this.store.internalReadSnapshot(()=>{
   const now=this.now(),saved=this.saved(),{stories,evidence,interests}=this.learning(saved,now);
   return structuredClone({context:{epoch:this.store.epoch,deviceId,profile:saved.profile,control:saved.control,evidence},
    stories,interests,hidden:saved.hidden,at:now,
    learningMode:interpretFeedProfile(saved.profile).status==='pending'?'interpretation-required' as const:'literal' as const});
  });
 }
 /** Current permitted raw sources for the separate adaptive route. The owned
  * caller must join verified learning/suppression in this same read snapshot,
  * bind selection beside its strict capture, and recheck current authority.
  * A raw activity bound never proves the complete adaptive input fits. */
 internalAdaptiveSourceSnapshot(deviceId:string):FeedAdaptiveSourceResult{
  return this.store.internalReadSnapshot(()=>{
   try{
    const now=this.now(),saved=this.saved();
    const stories=[...new Map(this.cache(saved).flatMap(row=>row.stories).map(story=>[story.id,story])).values()];
    const projected=collectFeedAdaptiveActivity(this.store,saved,stories,now);
    if(!projected.usable)return projected;
    return {usable:true,snapshot:structuredClone({epoch:this.store.epoch,deviceId,profile:saved.profile,control:saved.control,
     activity:projected.activity,selection:projected.selection,stories,hidden:saved.hidden,at:now})};
   }catch{return {usable:false,reason:'invalid-source'};}
  });
 }
 /** Read-only saved writing/control projection. It never reads activity or
  * cache, so an optional collection failure cannot erase current writing. */
 internalAdaptivePreferencesSnapshot(){
  return this.store.internalReadSnapshot(()=>{
   const saved=this.saved(),profile=feedProfileSchema.parse(saved.profile),control=feedLearningControlSchema.parse(saved.control);
   if(saved.format!==1||!Number.isSafeInteger(saved.revision)||saved.revision<1||!same(profile,saved.profile)||!same(control,saved.control))
    throw new Error('Current saved Feed preferences are invalid');
   return structuredClone({epoch:this.store.epoch,savedRevision:saved.revision,profile,control,at:this.now()});
  });
 }
 /** Exact current enabled-cache story, independent of optional activity. The
  * authenticated owner and retained graph are joined by the enclosing adapter. */
 internalAdaptiveStorySnapshot(id:string){
  if(!/^[a-f0-9]{64}$/.test(id))return undefined;
  return this.internalAdaptiveStoryInventory()?.get(id);
 }
 internalAdaptiveStoryInventory(){
  return this.store.internalReadSnapshot(()=>currentFeedStoryInventory(this.saved(),this.store.internalRead<FeedSourceCache[]>(cacheKey)??[]));
 }
 state(options:{following?:boolean}={}):FeedState{
  const value=this.internalLiteralViewSnapshot(options);return {...value,stories:value.stories.slice(0,100)};
 }
 /** Full eligible literal candidates, before the display cap, for a passive
  * same-Store consumer. The maintained literal collector runs once; it is a
  * distinct policy from semantic activity and cannot be replaced by a cast. */
 internalLiteralViewSnapshot(options:{following?:boolean}={}):FeedState{
  return this.store.internalReadSnapshot(()=>{
  const saved=this.saved(),caches=this.cache(saved),{stories,evidence,interests}=this.learning(saved);
  const ranked=rankEligibleFeed(stories,saved.profile,saved.control,interests,evidence,this.now(),
   Object.fromEntries(saved.feedback.map(row=>[row.storyId,row])),{...options,hidden:saved.hidden});
  const used=new Set(interests.flatMap(row=>row.evidence.map(item=>item.id)));
  return {epoch:this.store.epoch,value:{...saved,interests},interpretation:interpretFeedProfile(saved.profile),schedule:this.schedule.status(),stories:ranked,eligibleCount:ranked.length,
   sources:saved.profile.settings.sources.map(source=>{const cache=caches.find(row=>row.source.id===source.id);
    return {source,fetchedAt:cache?.fetchedAt??null,acceptedCount:cache?.stories.length??0,rejectedCount:cache?.rejectedCount??0};}),
   hiddenStories:saved.hidden.map(id=>({id,title:stories.find(story=>story.id===id)?.title??null})),
   activity:{status:'ready' as const,supported:['reading','library','ideas'],evidence:evidence.filter(row=>used.has(row.id)),
    message:'Learning uses only selected activity: Feed reading, saved Library notes/links, and your saved directions/questions from Ideas submitted while Ideas learning is enabled. Earlier submissions are not backfilled. Captured source text and private replies are excluded from Ideas signals. Exact topics and publisher categories must appear in retrievable source quotes.'}};
  });
 }
 receipt(device:string,raw:unknown){
  const command=feedCommandSchema.parse(raw),value=this.store.replayAdmission<FeedMutationReceipt>(device,command,{type:'news.command',command});
  return value??{state:'unknown' as const,command};
 }
 command(device:string,raw:unknown):FeedMutationReceipt{return this.commandWithReading(device,raw);}
 /** Service-owned protected semantic reading join. The unchanged original
  * news.command identity/receipt and event format remain owned here. A browser
  * cannot supply this synchronous authority callback or a classification proof. */
 internalReadingCommand(device:string,raw:unknown,reading:ReadingAdmission):FeedMutationReceipt{
  const command=feedCommandSchema.parse(raw);if(command.type!=='reading'||typeof reading?.authorize!=='function'||typeof reading?.eligible!=='function')throw new Fault(400,'news_reading_command','Use the original reading command.');
  reading.authorize();try{return this.commandWithReading(device,command,reading);}finally{reading.authorize();}
 }
 private commandWithReading(device:string,raw:unknown,reading?:ReadingAdmission):FeedMutationReceipt{
  const command=feedCommandSchema.parse(raw);this.available();
  const admitted=this.store.admit<FeedMutationReceipt>(device,command,{type:'news.command',command},()=>{
   reading?.authorize();try{
   const before=this.saved(),at=this.at(),base={format:1 as const,requestId:command.requestId,epoch:command.epoch,command,at};
   // Every refusal is recorded before any writes. A delayed repeat cannot
   // become eligible after the original failure's surroundings have changed.
   const reject=(code:string,message:string):FeedMutationReceipt=>({...base,state:'rejected',code,message});
   if(command.expectedRevision!==before.revision)return reject('news_changed','Feed preferences changed. Keep your edits and compare the saved version.');
   const next=structuredClone(before);let profileChanged=false;
   if(command.type==='settings'){
    if(command.settings.sources.some(source=>!canonicalNewsUrl(source.url)))return reject('news_source_invalid','Use a public HTTP or HTTPS feed source.');
    if(command.settings.learning.paused&&!before.profile.settings.learning.paused)next.interests=this.learning(before).interests;
    next.profile.settings=feedSettingsSchema.parse(command.settings);profileChanged=true;
   }else if(command.type==='learning-reset'){
    const reset=resetFeedLearning(next.profile,next.control,at);next.profile=reset.profile;next.control=reset.control;next.interests=[];
    profileChanged=true;
   }else if(command.type==='interest'){
    const key=feedTopicKey(command.topic),without=(values:string[])=>values.filter(topic=>feedTopicKey(topic)!==key);
    if(command.action==='keep'){next.control.kept=[...without(next.control.kept),command.topic];next.control.stopped=without(next.control.stopped);}
    else if(command.action==='stop'){next.control.stopped=[...without(next.control.stopped),command.topic];next.control.kept=without(next.control.kept);}
    else next.control.stopped=without(next.control.stopped);
    if(next.control.kept.length>64||next.control.stopped.length>64)return reject('news_interest_limit','Review the existing interests before adding another.');
    profileChanged=true;
   }else if(command.type==='unhide'){
    next.hidden=next.hidden.filter(id=>id!==command.storyId);
   }else{
    const story=this.cache(before).flatMap(row=>row.stories).find(story=>story.id===command.story.id&&story.revision===command.story.revision
     &&story.sourceId===command.story.sourceId&&story.sourceDigest===command.story.sourceDigest);
    if(!story)return reject('news_story_changed','This exact story version is unavailable. Keep the original request and reload the Feed.');
    if(command.type==='reading'){
     const learning=before.profile.settings.learning;
     if(!learning.enabled||learning.paused||learning.instructionsOnly||!learning.allowed.includes('reading'))
      return reject('news_reading_disabled','Reading activity is not enabled. No learning event was kept.');
     const eligible=reading?reading.eligible(story):this.state().stories.some(row=>row.story.id===story.id);
     if(typeof eligible!=='boolean')throw Error('Reading admission must be synchronous');
     if(!eligible)return reject('news_reading_unavailable','This story is no longer eligible for activity learning.');
     const events=this.store.internalRead<FeedReadingEvent[]>(readingKey)??[];
     const previous=events.find(row=>row.storyId===story.id&&row.revision===story.revision&&row.sourceDigest===story.sourceDigest);
     const firstAt=previous?.firstAt??at;
     const returnedAt=previous?.returnedAt??(previous&&this.now()-Date.parse(previous.lastAt)>=60000?at:null);
     const event={storyId:story.id,revision:story.revision,sourceId:story.sourceId,sourceDigest:story.sourceDigest,firstAt,lastAt:at,returnedAt};
     this.store.internalWrite(readingKey,[...events.filter(row=>row.storyId!==story.id&&this.now()-Date.parse(row.lastAt)<=90*86400000),event].slice(-2000));
    }else if(command.type==='feedback'){
     next.feedback=next.feedback.filter(row=>row.storyId!==story.id);
     if(command.value!=='neutral')next.feedback.push({storyId:story.id,value:command.value,topics:feedFeedbackTopics(before,story)});
     if(next.feedback.length>2000)return reject('news_feedback_limit','Review existing story feedback before adding more.');
    }else{
     next.hidden=next.hidden.filter(id=>id!==story.id);if(command.hidden)next.hidden.push(story.id);
     if(next.hidden.length>2000)return reject('news_hidden_limit','Review hidden stories before hiding more.');
    }
   }
   next.revision++;if(profileChanged)next.profile={...next.profile,revision:next.profile.revision+1,updatedAt:at};
   if(command.type==='settings')this.store.internalWrite(cacheKey,this.cache(next));
   if(command.type==='learning-reset'||command.type==='settings'&&(!next.profile.settings.learning.enabled||!next.profile.settings.learning.allowed.includes('reading')))
    this.store.internalWrite(readingKey,[]);
   if(!next.profile.settings.learning.instructionsOnly)next.interests=this.learning(next).interests;
   this.store.internalWrite(stateKey,next);
   if(command.type==='settings')this.schedule.configure(device,command.requestId,next);
   return {...base,state:'saved',revision:next.revision,profileRevision:next.profile.revision};
   }finally{reading?.authorize();}
  });
  if(admitted.fresh&&admitted.value.state==='saved'&&['settings','interest','learning-reset'].includes(command.type))
   for(const controller of this.running.values())controller.abort();
  return admitted.value;
 }
 private currentRefresh(device:string,command:FeedRefreshCommand):FeedRefreshReceipt|undefined{
  const admitted=this.store.replayAdmission<FeedRefreshReceipt>(device,command,{type:'news.refresh',command});
  if(!admitted)return;
  const latest=this.store.internalRead<FeedRefreshReceipt>(operationKey+command.requestId)??(admitted.state==='rejected'?admitted:undefined);
  if(!latest||latest.deviceId!==device||!same(latest.command,command))throw new Fault(409,'news_refresh_changed','The original source check is unavailable. It has not been repeated.');
  if(latest.state==='running'&&this.now()>=Date.parse(latest.deadline))
   return {...latest,state:'expired',message:'The original check deadline ended. Its outcome is unconfirmed, and this request will not run again.'};
  return latest.state==='running'&&!this.running.has(command.requestId)
   ?{...latest,state:'unknown',message:'The original source check was interrupted. Its outcome is unconfirmed; it will not restart automatically.'}
   :latest;
 }
 refreshReceipt(device:string,raw:unknown){const command=feedRefreshSchema.parse(raw);return this.currentRefresh(device,command)??{state:'unknown' as const,command};}
 async refresh(device:string,raw:unknown):Promise<FeedRefreshReceipt>{
  const command=feedRefreshSchema.parse(raw),original=this.currentRefresh(device,command);if(original)return original;
  return this.store.trackUpdateEffect('news-feed',()=>this.performRefresh(device,command));
 }
 private async performRefresh(device:string,command:FeedRefreshCommand):Promise<FeedRefreshReceipt>{
  this.available();
  const state=this.saved(),source=state.profile.settings.sources.find(row=>row.id===command.sourceId&&row.enabled);
  const history=this.store.internalList<FeedRefreshReceipt>(operationKey),last=history.filter(row=>row.command.sourceId===command.sourceId).sort((a,b)=>b.startedAt.localeCompare(a.startedAt))[0];
  const refusal=!source||state.profile.revision!==command.profileRevision?'Feed preferences changed before this source check started.'
   :!canonicalNewsUrl(source.url)?'Use a public feed address.'
   :this.running.size>=2?'Two source checks are already running. Read their results before checking another source.'
   :history.length>=512?'The retained source-check history needs review before another check. Existing stories are kept.'
   :last&&this.now()-Date.parse(last.startedAt)<60000?'This source was checked recently. Read its original result before checking again.':null;
  const startedAt=this.at(),controller=new AbortController();
  const receipt:FeedRefreshReceipt={format:1,requestId:command.requestId,epoch:command.epoch,deviceId:device,command,source:source??null,
   startedAt,deadline:new Date(this.now()+20000).toISOString(),finishedAt:refusal?startedAt:null,state:refusal?'rejected':'running',message:refusal??'Checking This Source',acceptedCount:0,rejectedCount:0};
  this.store.admit(device,command,{type:'news.refresh',command},()=>{if(!refusal)this.store.internalWrite(operationKey+command.requestId,receipt);return receipt;});
  if(refusal||!source)return receipt;
  this.running.set(command.requestId,controller);
  const permitted=()=>!this.closed&&!controller.signal.aborted&&this.now()<Date.parse(receipt.deadline)&&!this.store.recoveryEffectsPaused&&!this.store.updateMaintenanceHeld&&this.store.epoch===command.epoch
   &&this.saved().profile.revision===command.profileRevision
   &&same(this.saved().profile.settings.sources.find(row=>row.id===source.id&&row.enabled)??null,source);
  const finish=(value:FeedRefreshReceipt)=>{
   // A restored workspace must never receive an old epoch's late result.
   if(!this.closed&&this.store.epoch===command.epoch&&!this.store.updateMaintenanceHeld&&!this.store.recoveryEffectsPaused)this.store.internalWrite(operationKey+command.requestId,value);
   return value;
  };
  try{
   const parsed=await this.fetchSource(source,AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]),permitted);
   return this.store.internalAtomic(()=>{
    if(!permitted())return finish({...receipt,state:'withdrawn',finishedAt:this.at(),message:'The source or preferences changed. The old response was not saved.'});
    if(parsed.sourceId!==source.id||parsed.stories.length>200||parsed.rejected.length>200||!/^[a-f0-9]{64}$/u.test(parsed.sourceDigest)||!Number.isFinite(Date.parse(parsed.fetchedAt))
     ||parsed.stories.some(row=>row.sourceId!==source.id||row.sourceDigest!==parsed.sourceDigest||row.fetchedAt!==parsed.fetchedAt))
     throw Error('The source response identity changed.');
    const previous=this.cache().find(row=>row.source.id===source.id);
    const stories=parsed.stories.map(raw=>{
     const story=feedStorySchema.parse(raw);
     if(story.id!==newsDigest(story.canonicalUrl)||canonicalNewsUrl(story.canonicalUrl)!==story.canonicalUrl||story.publisherId!==new URL(source.url).hostname)throw Error('A story identity is invalid.');
     const old=previous?.stories.find(row=>row.id===story.id);
     const content=(row:typeof story)=>({...row,revision:1,fetchedAt:'',sourceDigest:''});
     return {...story,revision:old?(same(content(old),content(story))?old.revision:old.revision+1):1};
    });
    const cache:FeedSourceCache={source,profileRevision:command.profileRevision,fetchedAt:parsed.fetchedAt,sourceDigest:parsed.sourceDigest,stories,rejectedCount:parsed.rejected.length};
    const others=this.cache().filter(row=>row.source.id!==source.id);
    if(Buffer.byteLength(JSON.stringify([...others,cache]))>maximumCacheBytes)throw Error('The Feed cache reached its 8 MB limit. Existing stories were kept.');
    this.store.internalWrite(cacheKey,[...others,cache]);
    return finish({...receipt,state:'saved',finishedAt:this.at(),message:'Source Checked',acceptedCount:stories.length,rejectedCount:parsed.rejected.length});
   });
  }catch(error){
   const value={...receipt,state:permitted()?'failed' as const:'withdrawn' as const,finishedAt:this.at(),
    message:permitted()?(error instanceof Error?error.message:'This source check failed. Existing stories are kept.'):'The source or preferences changed. Existing stories are kept.'};
   return finish(value);
  }finally{this.running.delete(command.requestId);}
 }
 close(){this.closed=true;if(this.timer)clearInterval(this.timer);this.schedule.close();for(const controller of this.running.values())controller.abort();}
}
