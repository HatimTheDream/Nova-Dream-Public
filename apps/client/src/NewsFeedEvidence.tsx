import type {ReactNode} from 'react';
import type {FeedEvidence,FeedStory} from '../../../packages/domain/news-feed';
import type {FeedViewInterest} from '../../../packages/domain/news-feed-view';
import {currentFeedInterests,currentFeedWhy,type FeedCurrentView,type FeedCurrentInterest} from './feed-current-presentation';

type Support=FeedEvidence|FeedViewInterest['supports'][number];
const sources={reading:'Feed Reading',library:'Library',ideas:'Ideas'} as const;
const actions={open:'Opened',return:'Returned',save:'Saved',pursue:'Submitted To Assistant'} as const;
function SupportingActivity({supports}:{supports:readonly Support[]}){
 return <details><summary>Supporting Activity</summary>{supports.map((support,index)=><blockquote key={support.id+':'+index}>
  <p className="preserve-case">{'span'in support?support.span.quote:support.quote}</p>
  <p className="metadata preserve-case">{sources[support.source]} · {actions[support.action]} · <time dateTime={support.at}>{support.at.slice(0,10)}</time></p>
  <details><summary>Source Version</summary><p>Revision {support.sourceRevision}</p>
   {support.source==='ideas'&&<p>This passage belongs to the Idea brief submitted in the original Assistant attempt.</p>}
  </details>
 </blockquote>)}</details>;
}

/** Fits inside the existing card/reader details element. No local proof state,
 * fetch, effect, focus change or reader mutation is introduced here. */
export function FeedStoryWhy({view,story}:{view:FeedCurrentView;story:FeedStory}){
 const why=currentFeedWhy(view,story);
 if(!why)return <p>Current matching details are unavailable for this preview.</p>;
 return <>
  {why.literal.length>0&&<ul>{why.literal.map(({reason,supports},index)=><li key={reason.kind+':'+index}>
   <span className="preserve-case">{reason.kind==='written-topic'?'Your Topic':reason.kind==='kept-interest'?'Your Kept Interest':'Learned Topic'}: {reason.topic}</span>
   {supports.length>0&&<SupportingActivity supports={supports}/>}
  </li>)}</ul>}
  {why.semantic.length>0&&<><p className="metadata">Matched From The Publisher Preview</p><ul>{why.semantic.map((reason,index)=><li key={reason.kind+':'+reason.id+':'+index}>
   <span className="preserve-case">{reason.kind==='written'?'Your Written Meaning':reason.kind==='kept'?'Your Kept Interest':'Learned Interest'}: {reason.label}</span>
   {reason.evidence.map((span,spanIndex)=><blockquote key={spanIndex}><p className="metadata">{span.field==='title'?'Preview Title':span.field==='summary'?'Preview Summary':'Publisher Topic'}</p><p className="preserve-case">{span.quote}</p></blockquote>)}
   {reason.supports.length>0&&<SupportingActivity supports={reason.supports}/>}
  </li>)}</ul><p className="metadata">These passages come from the publisher preview, not the full article.</p></>}
 </>;
}

/** The parent supplies its existing Keep/Stop controls using the matching saved
 * revision. This component adds no command, consent or control policy. */
export function FeedCurrentInterests({view,controls}:{view:FeedCurrentView;controls?:(interest:FeedCurrentInterest)=>ReactNode}){
 const interests=currentFeedInterests(view);
 return <section aria-label="Current Learned Interests"><h3>Learned Interests</h3>
  {view?.state!=='ready'?<p>Current learned interests are unavailable.</p>:<>
   {!interests.length&&<p>No currently supported learned interests. One passive open is not enough.</p>}
   {interests.map(interest=><article key={interest.key}><h4 className="preserve-case">{interest.label}</h4>
    <p>{interest.status==='active'?'Within Current Discovery Scope':'Suggested — Not Used To Match Stories'}</p>
    <p className="metadata">{interest.kind==='literal'?'Supported By Matching Topics':'Supported By Current Activity Meaning'}</p>
    <SupportingActivity supports={interest.supports}/>
    {controls?.(interest)}
   </article>)}
   {view.semantic.state==='unavailable'&&<p>Meaning-based interests are unavailable. Any supported topic interests are shown above.</p>}
  </>}
 </section>;
}
