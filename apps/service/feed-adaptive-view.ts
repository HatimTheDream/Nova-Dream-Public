import {z} from 'zod';
import type {Store} from './store.js';
import type {NewsFeed} from './news-feed.js';
import type {FeedAdaptiveOwner} from './feed-adaptive-authority.js';
import {currentFeedPreferences,projectFeedAdaptiveCurrent,type FeedCurrentPermissionResolver} from './feed-adaptive-current-source.js';
import type {FeedReadGraph} from '../../packages/domain/news-feed-read-graph.js';
import {canonical} from '../../packages/domain/contracts.js';
import {adaptiveHash,adaptiveEligibility,adaptiveWrittenCurrent,qualifyAdaptiveInterest,type AdaptiveWrittenBasis} from '../../packages/domain/news-feed-adaptive.js';
import {readAdaptiveOutput,type AdaptiveSource} from '../../packages/domain/news-feed-adaptive-capture.js';
import {feedHardFilter,rankAdmittedFeed,type FeedStory,type FeedState} from '../../packages/domain/news-feed.js';
import {composeFeedView,type FeedViewBasis,type FeedViewInterest,type FeedViewReady,type FeedViewSemantic,type FeedViewState} from '../../packages/domain/news-feed-view.js';
import {workerInputHash as hash} from './worker-plugin/identity.js';

const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b),uuid=z.string().uuid();
const querySchema=z.object({following:z.boolean().default(false)}).strict();
type News=Pick<NewsFeed,'internalAdaptivePreferencesSnapshot'|'internalAdaptiveSourceSnapshot'|'internalAdaptiveStoryInventory'|'internalLiteralViewSnapshot'>;
function basisIdentity(basis:AdaptiveWrittenBasis,graph:FeedReadGraph):FeedViewBasis{
 if(basis.kind==='empty')return {kind:'empty',sha256:adaptiveHash(basis,hash)};
 const saved=graph.adaptiveReviews.get(basis.approval.reviewRequestId);
 if(!saved||!same(saved.source,basis))throw Error('Exact accepted Feed basis unavailable');
 return {kind:'accepted',sha256:adaptiveHash(basis,hash),reviewId:saved.record.id,interpretationId:basis.capture.requestId,
  briefSha256:basis.capture.briefSha256,planSha256:basis.approval.planSha256,terminalSha256:saved.record.workerTerminalSha256};
}
function currentInterests(graph:FeedReadGraph,source:AdaptiveSource,at:number):FeedViewInterest[]{
 const applied=new Map<string,string>();let head=source.learningHead;
 while(head){const mutation=graph.mutations.get(head);if(!mutation)throw Error('Current Feed learning ancestry unavailable');
  const learning=graph.learning.get(head);if(learning)applied.set(learning.command.operationId,learning.id);head=mutation.before.learningHead;
 }
 const values:FeedViewInterest[]=[];
 for(const interest of source.context.learning.interests){const worker=graph.adaptiveWorkers.get(interest.learningRequestId),appliedByRequestId=applied.get(interest.learningRequestId);
  if(!worker||!appliedByRequestId||worker.capture.kind!=='learn'||worker.state!=='completed'||!worker.capture.basis)continue;
  const q=qualifyAdaptiveInterest(source.context,worker.capture.basis,interest,at,hash);if(!q.ok)continue;
  const supports=q.value.supportIds.map(id=>interest.supports.find(s=>s.id===id)!);
  // Qualification checked exact current identity and text for every support.
  // No raw activity text or unsupported historical interest crosses this edge.
  values.push({id:interest.id,label:interest.label,learningRequestId:interest.learningRequestId,learningCaptureSha256:interest.learningCaptureSha256,
   appliedByRequestId,basis:basisIdentity(worker.capture.basis,graph),score:q.value.score,status:q.value.status,supports:structuredClone(supports) as FeedViewInterest['supports']});
 }
 return values;
}

/** Passive service-owned batch. Its graph and current sources live only inside
 * one synchronous Store snapshot. Nothing here owns a timer, provider, command,
 * readiness ticket, cache, durable cursor or browser-selected worker identity. */
export class FeedAdaptiveView{
 constructor(private store:Store,private news:News,private permissions:FeedCurrentPermissionResolver,private now=Date.now){}
 private owner(input:FeedAdaptiveOwner){if(typeof input?.authorize!=='function')throw Error('Original authenticated Feed request required');
  return Object.freeze({deviceId:uuid.parse(input.deviceId),epoch:uuid.parse(input.epoch),authorize:input.authorize.bind(input)});}
 private guard(owner:FeedAdaptiveOwner){
  const result:unknown=owner.authorize();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw Error('Original authorization must be synchronous');}
  const raw:unknown=this.permissions(owner);if(raw&&typeof(raw as any).then==='function'){void Promise.resolve(raw).catch(()=>{});throw Error('Current permissions must be synchronous');}
  const permission=z.object({read:z.boolean(),write:z.boolean()}).strict().parse(raw);
  if(!same(permission,raw)||!permission.read||owner.epoch!==this.store.epoch)throw Error('Original Feed read access unavailable');
 }
 read(input:FeedAdaptiveOwner,options:unknown={}):FeedViewState{return this.project(input,options,value=>value);}
 /** Current server-side admission projection, not a browser DTO assertion. The
  * rare whole-view budget fallback uses the already validated literal candidate
  * set from this exact snapshot, never a second loose cache read. */
 readingEligible(input:FeedAdaptiveOwner,story:FeedStory):boolean{
  return this.project(input,{},(value,literalFallback)=>(value.state==='ready'?value.stories.map(row=>row.story):literalFallback).some(row=>same(row,story)));
 }
 private project<T>(input:FeedAdaptiveOwner,options:unknown,consume:(value:FeedViewState,literalFallback:FeedStory[])=>T):T{
  const owner=this.owner(input),query=querySchema.parse(options);this.guard(owner);
  try{return this.store.internalWithFeedReadGraph(graph=>{
   this.guard(owner);const at=this.now();
   const saved=this.news.internalAdaptivePreferencesSnapshot();if(saved.epoch!==owner.epoch)throw Error('Current Feed workspace changed');
   const preferences=currentFeedPreferences(saved,graph),raw=this.news.internalAdaptiveSourceSnapshot(owner.deviceId);
   const current=projectFeedAdaptiveCurrent(owner,graph,preferences,raw),inventory=this.news.internalAdaptiveStoryInventory();
   if(!inventory)throw Error('Exact current Feed story inventory unavailable');
   const literal=this.news.internalLiteralViewSnapshot(query);
   if(literal.epoch!==owner.epoch||literal.value.revision!==preferences.savedRevision||!same(literal.value.profile,preferences.profile)||!same(literal.value.control,preferences.control))throw Error('Current literal Feed checkpoint changed');
   const literalRows=new Map<string,FeedState['stories'][number]>();
   for(const row of literal.stories){const checked=inventory.get(row.story.id);
    if(checked&&same(checked.story,row.story)&&!feedHardFilter(preferences.profile,row.story,{...query,hidden:checked.hidden}))literalRows.set(row.story.id,row);
   }
   const interests=current.source?currentInterests(graph,current.source,at):[],semanticRows=new Map<string,FeedViewSemantic>();let ambiguousStories=0;
   if(current.source){const source=current.source,contextSha256=adaptiveHash(source.context,hash);
    const groups=new Map<string,{worker:typeof graph.adaptiveWorkers extends ReadonlyMap<string,infer W>?W:never;result:unknown}[]>();
    // All current positive, negative and unknown originals enter the same group.
    // One map walk and one complete graph proof; no per-story controller calls.
    for(const worker of graph.adaptiveWorkers.values()){
     if(worker.deviceId!==owner.deviceId||worker.command.epoch!==owner.epoch||worker.state!=='completed'||worker.capture.kind!=='classify'||!worker.output?.text||!worker.terminal)continue;
     const preview=worker.capture.preview,story=inventory.get(preview.story.id);
     if(!story||at<preview.at||preview.contextSha256!==contextSha256||!same(story.story,preview.story)||!adaptiveWrittenCurrent(source.context,preview.basis,hash)||
      feedHardFilter(preferences.profile,story.story,{...query,hidden:story.hidden}))continue;
     basisIdentity(preview.basis,graph);const result=readAdaptiveOutput(worker.output.text,worker.capture,hash);if(!result.ok)continue;
     groups.set(story.story.id,[...(groups.get(story.story.id)??[]),{worker,result:result.value}]);
    }
    for(const [id,originals] of groups){if(originals.length!==1){ambiguousStories++;continue;}
     const {worker,result}=originals[0]!;if(worker.capture.kind!=='classify')throw Error('Classifier inventory changed');
     const story=inventory.get(id)!,preview=worker.capture.preview,eligible=adaptiveEligibility(source.context,story.story,preview,result as any,at,hash,{...query,hidden:story.hidden});
     if(!eligible.eligible)continue;
     let supportsAvailable=true;
     const reasons=eligible.reasons.map(reason=>{const interest=reason.kind==='learned'?interests.find(i=>i.id===reason.id&&i.status==='active'):undefined;
      if(reason.kind==='learned'&&(!interest||!same(interest.supports.map(s=>s.id),reason.supportIds)))supportsAvailable=false;
      return {kind:reason.kind,id:reason.id,label:reason.label,evidence:structuredClone(reason.evidence),supports:interest?.supports??[]};});
     if(!supportsAvailable)continue;
     semanticRows.set(id,{operationId:worker.id,terminalSha256:adaptiveHash(worker.terminal,hash),basis:basisIdentity(preview.basis,graph),contextSha256,
      previewSha256:preview.previewSha256,profileRevision:eligible.profileRevision,storyId:id,storyRevision:eligible.storyRevision,reasons});
    }
   }
   const checkpoint={epoch:owner.epoch,deviceId:owner.deviceId,savedRevision:preferences.savedRevision,profileRevision:preferences.profile.revision,following:query.following,at};
   const base={format:1 as const,state:'ready' as const,checkpoint,value:literal.value,interpretation:literal.interpretation,sources:literal.sources,...(literal.schedule?{schedule:literal.schedule}:{}),hiddenStories:literal.hiddenStories,
    activity:{status:literal.activity.status,message:literal.activity.message,...(literal.activity.supported?{supported:literal.activity.supported}:{}),literalEvidence:literal.activity.evidence??[]}};
   const semantic:FeedViewReady['semantic']=current.source?{state:'ready',interests,ambiguousStories}:{state:'unavailable',reason:'current-source',interests:[]};
   const feedback=Object.fromEntries(literal.value.feedback.map(row=>[row.storyId,row]));
   this.guard(owner);const value=composeFeedView(base,[...literalRows.values()],[...semanticRows].map(([id,proof])=>({story:inventory.get(id)!.story,proof})),semantic,feedback);this.guard(owner);
   const fallback=value.state==='unavailable'?rankAdmittedFeed([...literalRows.values()],feedback,at).slice(0,100).map(row=>row.story):[];
   const selected=consume(value,fallback);this.guard(owner);return selected;
  });}finally{this.guard(owner);}
 }
}
