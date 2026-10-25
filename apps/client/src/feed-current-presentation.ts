import type {FeedEvidence,FeedStory} from '../../../packages/domain/news-feed';
import type {FeedViewInterest,FeedViewReady,FeedViewRow,FeedViewState} from '../../../packages/domain/news-feed-view';

export type FeedCurrentView=FeedViewState|null|undefined;
export type FeedLiteralReason=Extract<FeedViewRow['match'],{kind:'literal'}>['literal']['reasons'][number];
export type FeedSemanticReason=Extract<FeedViewRow['match'],{kind:'semantic'}>['semantic']['reasons'][number];
export type FeedCurrentWhy={literal:{reason:FeedLiteralReason;supports:FeedEvidence[]}[];semantic:FeedSemanticReason[]};
export type FeedCurrentInterest=
 |{kind:'literal';key:string;label:string;status:'active'|'suggested';supports:FeedEvidence[]}
 |{kind:'semantic';key:string;label:string;status:'active'|'suggested';supports:FeedViewInterest['supports']};
export function feedRowLabels(row:FeedViewRow):string[]{return [
 ...('literal'in row.match?row.match.literal.reasons.map(reason=>reason.topic):[]),
 ...('semantic'in row.match?row.match.semantic.reasons.map(reason=>reason.label):[]),
];}

/** Inputs belong to the currently published, strictly checked DTO. The caller
 * clears that DTO on access/owner/generation changes; this module keeps no cache
 * and grants no eligibility or command authority. A retained reader is separate. */
export function currentFeedRow(view:FeedCurrentView,story:FeedStory):FeedViewRow|undefined{
 if(view?.state!=='ready')return;
 return view.stories.find(({story:current})=>current.id===story.id&&current.revision===story.revision&&current.sourceId===story.sourceId&&current.sourceDigest===story.sourceDigest&&
  current.canonicalUrl===story.canonicalUrl&&current.publisherId===story.publisherId&&current.publisher===story.publisher&&current.title===story.title&&current.summary===story.summary&&
  current.summaryKind===story.summaryKind&&current.publishedAt===story.publishedAt&&current.updatedAt===story.updatedAt&&current.fetchedAt===story.fetchedAt&&
  current.topics.length===story.topics.length&&current.topics.every((topic,index)=>topic===story.topics[index]));
}
function literalSupports(view:FeedViewReady,ids:readonly string[]):FeedEvidence[]|undefined{
 const supports:FeedEvidence[]=[];
 for(const id of ids){const found=view.activity.literalEvidence.find(row=>row.id===id&&row.available);if(!found)return;supports.push(found);}
 return supports;
}
export function currentFeedWhy(view:FeedCurrentView,story:FeedStory):FeedCurrentWhy|undefined{
 const row=currentFeedRow(view,story);if(!row||view?.state!=='ready')return;
 const literal:FeedCurrentWhy['literal']=[];
 if('literal'in row.match)for(const reason of row.match.literal.reasons){
  const supports=literalSupports(view,reason.evidenceIds);if(!supports||reason.kind==='learned-interest'&&!supports.length)continue;
  literal.push({reason,supports});
 }
 const semantic='semantic'in row.match&&view.semantic.state==='ready'?row.match.semantic.reasons:[];
 return literal.length||semantic.length?{literal,semantic}:undefined;
}
export function currentFeedInterests(view:FeedCurrentView):FeedCurrentInterest[]{
 if(view?.state!=='ready')return [];
 const literal:FeedCurrentInterest[]=view.value.interests.flatMap(interest=>{
  const supports=literalSupports(view,interest.evidence.map(row=>row.id));
  // The checked DTO joins the complete literal support identity. Never retain
  // a private quote from the old interest when current evidence disappeared.
  return supports&&supports.length? [{kind:'literal' as const,key:'literal:'+interest.topic,label:interest.topic,status:interest.status,supports}]:[];
 });
 const semantic:FeedCurrentInterest[]=view.semantic.state==='ready'?view.semantic.interests.map(interest=>({
  kind:'semantic',key:'semantic:'+interest.id,label:interest.label,status:interest.status,supports:interest.supports,
 })):[];
 return [...literal,...semantic];
}
