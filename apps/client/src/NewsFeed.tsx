import {lazy,Suspense,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {Snapshot} from '../../../packages/domain/contracts';
import {feedTopicKey,nextFeedFeedback,type FeedStory,type FeedSettings} from '../../../packages/domain/news-feed';
import type {HomeLibraryController,HomeSourceActions} from './HomeLibrary';
import {ContentRecoveryPanel} from './ContentRecoveryPanel';
import {NewsFeedSettings} from './NewsFeedSettings';
import {useNewsFeed} from './useNewsFeed';
import {FeedStoryWhy} from './NewsFeedEvidence';
import {currentFeedRow,feedRowLabels} from './feed-current-presentation';
import {stableFeedEdition,feedStoryGuard,feedRefreshInput} from './news-feed-retained';
import {newsDiscuss,newsLibrarySave,savedNewsLocations} from './news-feed-actions';
import {mayLeaveHomeDraft} from './home-draft-navigation';
import {Empty} from './ui';
import {LoadingRing} from './ModuleLoading';
import './content-workspace.css';
import './news-feed.css';
const NewsFeedInterpretations=lazy(async()=>({default:(await import('./NewsFeedInterpretations')).NewsFeedInterpretations}));

export default function NewsFeed({snapshot,library,onAssistantHandoff,openLibrary}:{snapshot:Snapshot;library:HomeLibraryController;openLibrary(collectionId?:string):void}&HomeSourceActions){
 const controller=useNewsFeed(snapshot),state=controller.state,view=controller.reading.value;
 const [settingsOpen,setSettingsOpen]=useState(false),[interpretationsOpen,setInterpretationsOpen]=useState(false),[sourceChecks,setSourceChecks]=useState(false),[destination,setDestination]=useState(''),
  [notice,setNotice]=useState(''),[handoffBusy,setHandoffBusy]=useState(false),[checkedBusy,setCheckedBusy]=useState(false),[compact,setCompact]=useState(false);
 const root=useRef<HTMLElement>(null),settingsButton=useRef<HTMLButtonElement>(null),interpretationsButton=useRef<HTMLButtonElement>(null),alive=useRef(true),lastReader=useRef(view.reader);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useLayoutEffect(()=>{const measure=()=>{if(root.current)setCompact(root.current.getBoundingClientRect().width<=800);};measure();
  const observer=new ResizeObserver(measure);if(root.current)observer.observe(root.current);return()=>observer.disconnect();},[]);
 const edition=state?stableFeedEdition(view,state):{rows:[],queued:[],order:[]};
 useEffect(()=>{
  if(!state||controller.reading.invalid)return;
  if(view.profileRevision!==state.value.profile.revision||JSON.stringify(view.order)!==JSON.stringify(edition.order))
   controller.keepReading({...view,profileRevision:state.value.profile.revision,order:edition.order});
 },[state,view.profileRevision,JSON.stringify(edition.order)]);
 const scroller=()=>root.current?.closest<HTMLElement>('.page-scroll')??null;
 const restore=()=>{
  if(!alive.current||settingsOpen)return;
  const anchor=controller.reading.value.anchor,node=anchor&&root.current?.querySelector<HTMLElement>(`[data-news-story="${anchor.id}"]`),scroll=scroller();
  if(node&&scroll&&node.isConnected&&!node.closest('[hidden],[inert]')){
   scroll.scrollTop+=node.getBoundingClientRect().top-scroll.getBoundingClientRect().top-anchor!.offset;
   node.querySelector<HTMLButtonElement>('.news-story-open')?.focus({preventScroll:true});
  }
 };
 useLayoutEffect(()=>{
  const prior=lastReader.current;lastReader.current=view.reader;
  if(prior&&!view.reader){const frame=requestAnimationFrame(restore);return()=>cancelAnimationFrame(frame);}
 },[view.reader,settingsOpen]);
 const openStory=(story:FeedStory)=>{
  if(handoffBusy||!mayLeaveHomeDraft())return;
  const node=root.current?.querySelector<HTMLElement>(`[data-news-story="${story.id}"]`),scroll=scroller();
  const anchor=node&&scroll?{id:story.id,offset:node.getBoundingClientRect().top-scroll.getBoundingClientRect().top}:view.anchor;
  if(controller.keepReading({...view,reader:story,anchor})){
   setSettingsOpen(false);setInterpretationsOpen(false);setNotice('');
   const learning=state?.value.profile.settings.learning;
   if(learning?.enabled&&!learning.paused&&!learning.instructionsOnly&&learning.allowed.includes('reading')&&!controller.busy&&!controller.pending&&!controller.invalid)
    void controller.mutate({type:'reading',expectedRevision:state!.value.revision,story:feedStoryGuard(story)});
  }
 };
 const closeReader=()=>{if(!handoffBusy)controller.keepReading({...controller.reading.value,reader:null});};
 const openSettings=()=>{if(!handoffBusy&&controller.keepReading({...view,reader:null})){setInterpretationsOpen(false);setSettingsOpen(true);}};
 const openInterpretations=()=>{if(!handoffBusy&&mayLeaveHomeDraft()&&controller.keepReading({...view,reader:null})){setSettingsOpen(false);setInterpretationsOpen(true);}};
 const pending=controller.pending,blocked=controller.busy||!!pending||controller.invalid||checkedBusy;
 const feedback=(story:FeedStory,value:'more'|'less')=>{
  if(!state)return;
  const current=state.value.feedback.find(row=>row.storyId===story.id)?.value??'neutral';
  void controller.mutate({type:'feedback',expectedRevision:state.value.revision,story:feedStoryGuard(story),value:nextFeedFeedback(current,value)});
 };
 const hide=(story:FeedStory,hidden:boolean)=>{
  if(state)void controller.mutate({type:'visibility',expectedRevision:state.value.revision,story:feedStoryGuard(story),hidden});
 };
 const checkSources=async()=>{
  if(!state||blocked)return;setCheckedBusy(true);setNotice('');
  try{
   for(const source of state.value.profile.settings.sources.filter(source=>source.enabled)){
    if(!alive.current||controller.requests.value.pending)break;
    await controller.refresh(feedRefreshInput(snapshot.epoch,source.id,state.value.profile.revision));
    if(controller.requests.value.pending)break;
   }
  }finally{if(alive.current)setCheckedBusy(false);}
 };
 const briefChange=(patch:Partial<FeedSettings>)=>{
  if(state)void controller.mutate({type:'settings',expectedRevision:state.value.revision,settings:{...state.value.profile.settings,...patch}});
 };
 const publication=(story:FeedStory)=>story.publishedAt?new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric',timeZone:snapshot.layout.value.timezone}).format(new Date(story.publishedAt)):'Date Not Provided';
 const thumbs=(story:FeedStory)=>{
  const selected=state?.value.feedback.find(row=>row.storyId===story.id)?.value??'neutral';
  return <><button disabled={blocked} aria-pressed={selected==='more'} aria-label={`More Like This: ${story.title}`} onClick={()=>feedback(story,'more')}>👍 More</button>
   <button disabled={blocked} aria-pressed={selected==='less'} aria-label={`Less Like This: ${story.title}`} onClick={()=>feedback(story,'less')}>👎 Less</button>
   {selected!=='neutral'&&<button disabled={blocked} onClick={()=>feedback(story,selected==='more'?'more':'less')}>Undo Feedback</button>}</>;
 };
 const currentStory=view.reader;
 const exactRow=currentStory&&currentFeedRow(controller.currentView,currentStory);
 const saved=currentStory&&library.state?savedNewsLocations(currentStory,library.state):[];
 const keep=async()=>{
  if(!currentStory||!library.state||library.busy||library.pending)return;
  try{
   const planned=newsLibrarySave(currentStory,library.state,destination,crypto.randomUUID());
   if(planned.already){setNotice('Already Saved In This Collection');return;}
   const result=await library.run(planned.command,planned.command.type==='collection-save');
   if(alive.current&&result)setNotice(`Saved To ${library.state.collections.find(row=>row.id===destination)?.title??'Library'}`);
  }catch(error){if(alive.current)setNotice(error instanceof Error?error.message:'The Library save could not be prepared.');}
 };
 const discuss=async()=>{
  if(!currentStory||!onAssistantHandoff||handoffBusy||!mayLeaveHomeDraft())return;
  setHandoffBusy(true);setNotice('');
  try{await onAssistantHandoff(newsDiscuss(currentStory));}
  catch(error){if(alive.current)setNotice(error instanceof Error?error.message:'The discussion draft could not be opened.');}
  finally{if(alive.current)setHandoffBusy(false);}
 };
 const filtered=edition.rows.filter(row=>!view.topic||feedRowLabels(row).some(label=>feedTopicKey(label)===feedTopicKey(view.topic)));
 const topics=[...new Map(edition.rows.flatMap(row=>feedRowLabels(row).map(label=>[feedTopicKey(label),label] as const))).values()];
 const latest=controller.receipt?.value;
 return <section ref={root} className="news-feed" aria-label="Feed" data-compact={compact||undefined}>
  <header className="home-approved-heading"><div><h1>Feed</h1><p>Reading Shaped By Your Interests</p></div><div className="news-header-actions">
   <button disabled={!state||blocked||!state.value.profile.settings.sources.some(source=>source.enabled)} onClick={()=>void checkSources()}>{checkedBusy?'Checking Sources…':'Check For Stories'}</button>
   <button ref={settingsButton} disabled={!controller.settingsState||handoffBusy} onClick={openSettings}>Feed Settings</button>
   <button ref={interpretationsButton} disabled={!controller.authorized||handoffBusy} onClick={openInterpretations}>Interpretations</button>
  </div></header>
  {(controller.error||controller.requests.error||controller.reading.error)&&<div className="notice warning" role="alert"><p>{controller.error||controller.requests.error||controller.reading.error}{state?' Previously loaded reading remains available.':''}</p><button disabled={controller.loading} onClick={()=>void controller.load()}>Reload Saved Feed</button></div>}
  {pending&&<div className="notice warning"><p>{pending.kind==='refresh'?'Original Source Check':'Original Feed Change'} · Unconfirmed</p><div className="button-row">
   <button disabled={controller.busy} onClick={()=>void controller.check()}>Check Original Result</button>
   <button disabled={controller.busy} onClick={()=>void controller.retry()}>{pending.kind==='mutation'?'Retry Original Change':'Retry Original Check'}</button>
  </div></div>}
  {controller.invalid&&<details><summary>Kept Recovery Records</summary><textarea readOnly aria-label="Copy Feed Recovery" value={[controller.requests.copy(),controller.settings.copy(),controller.reading.copy()].join('\n\n')}/></details>}
  {controller.loading&&!controller.currentView?<LoadingRing label="Loading Feed…"/>:controller.currentView?.state==='unavailable'?<Empty title="Current Matching Is Unavailable"><p>Your kept reading remains available. Current matching details and supporting activity are not shown.</p><button disabled={!controller.settingsState} onClick={openSettings}>Review Feed Settings</button></Empty>:!state?<Empty title="Feed Is Unavailable"><p>Reconnect to refresh your current Feed.</p>{controller.settingsState&&<button onClick={openSettings}>Review Last Loaded Settings</button>}</Empty>:<>
   <div className="news-reading-controls"><div className="segmented" aria-label="Feed Edition">
    {[false,true].map(following=><button key={String(following)} aria-pressed={view.following===following} onClick={()=>{if(mayLeaveHomeDraft()&&controller.keepReading({...view,following,order:[],anchor:null,reader:null})){setNotice('');void controller.load();}}}>{following?'Following':'For You'}</button>)}
   </div><label>Topic<select value={view.topic} onChange={event=>controller.keepReading({...view,topic:event.target.value})}><option value="">All Matching Topics</option>{view.topic&&!topics.includes(view.topic)&&<option value={view.topic}>{view.topic}</option>}{topics.map(topic=><option key={topic} value={topic}>{topic}</option>)}</select></label><button onClick={()=>setSourceChecks(value=>!value)}>Source Checks</button></div>
   {sourceChecks&&<section className="news-source-checks"><h2>Source Checks</h2>
    {state.schedule&&<p role="status">{state.schedule.message}{state.schedule.nextAt&&<> Next Check: {new Date(state.schedule.nextAt).toLocaleString()}.</>} {state.schedule.retainedCount} Of {state.schedule.limit} Original Checks Retained.</p>}
    {state.sources.map(row=><div key={row.source.id}><span className="preserve-case">{row.source.title}</span><p>{row.fetchedAt?`Cached ${new Date(row.fetchedAt).toLocaleString()} · ${row.acceptedCount} parsed · ${row.rejectedCount} unsupported`:'No Cached Stories'}</p>
    <button disabled={blocked||!row.source.enabled} onClick={()=>void controller.refresh(feedRefreshInput(snapshot.epoch,row.source.id,state.value.profile.revision))}>Check This Source</button></div>)}
    {latest&&controller.receipt?.kind==='refresh'&&<p role="status">{'message'in latest?latest.message:'The original source check remains unconfirmed.'}</p>}
   </section>}
   {edition.queued.length>0&&<button className="news-arrivals" onClick={()=>controller.keepReading({...view,order:state.stories.map(row=>row.story.id),profileRevision:state.value.profile.revision})}>{edition.queued.length} New {edition.queued.length===1?'Story':'Stories'}</button>}
   {!state.stories.length&&state.interpretation.status==='unconfigured'?<Empty title="Make This Feed Yours"><p>Add interests and choose reading sources to begin.</p><button onClick={openSettings}>Personalize Feed</button></Empty>
    :!state.stories.length&&state.interpretation.status==='pending'?<Empty title="Matching Pending"><p>Your complete directions are kept. Stories appear when your directions have supported matches.</p><button onClick={openSettings}>Review My Brief</button></Empty>
    :!filtered.length?<Empty title={view.following?'No Matching Stories From Followed Publishers':view.topic?'No Stories In This Topic':'No Qualifying Stories Yet'}><p>{!state.sources.length?'Choose reading sources in Feed Settings.':'Your brief and exclusions still apply. Unrelated headlines will not fill this space.'}</p><button onClick={openSettings}>Review Feed Settings</button></Empty>
    :<div className="news-story-list">{filtered.map(({story})=><article className="news-story-card" key={story.id} data-news-story={story.id}>
     <div className="news-byline"><span aria-hidden="true" className="news-publisher-icon">{story.publisher.slice(0,1)}</span><span className="preserve-case">{story.publisher}</span><time dateTime={story.publishedAt??undefined}>{publication(story)}</time></div>
     <button className="news-story-open" onClick={()=>openStory(story)}><h2 className="preserve-case">{story.title}</h2><p className="news-excerpt preserve-case">{story.summary||'Open the original to read this story.'}</p></button>
     <div className="news-card-actions">{thumbs(story)}<details><summary>Why</summary><FeedStoryWhy view={controller.currentView} story={story}/></details><button disabled={blocked} onClick={()=>hide(story,true)}>Hide</button></div>
    </article>)}</div>}
   {state.value.hidden.length>0&&<details className="news-hidden"><summary>Hidden Stories · {state.value.hidden.length}</summary><p>Hiding a story does not exclude its topic or mute its publisher.</p>
    {state.hiddenStories.map(story=><p key={story.id}><span className="preserve-case">{story.title??'Older Story · Source No Longer Cached'}</span> <button disabled={blocked} onClick={()=>void controller.mutate({type:'unhide',expectedRevision:state.value.revision,storyId:story.id})}>Unhide</button></p>)}
   </details>}
   <button className="news-library-link" onClick={()=>openLibrary()}>Open Saved Reading In Library</button>
  </>}
  {notice&&!currentStory&&<p role="status">{notice}</p>}
  {currentStory&&<ContentRecoveryPanel title="Reading" close={closeReader} fallbackFocus={()=>root.current?.querySelector<HTMLElement>(`[data-news-story="${currentStory.id}"] .news-story-open`)??settingsButton.current} breakpoint={800} backLabel="Back To Feed" tools>
   <article className="news-reader"><p className="news-byline preserve-case">{currentStory.publisher} · {publication(currentStory)}</p><h2 className="preserve-case">{currentStory.title}</h2>
    <p className="metadata">{currentStory.summaryKind==='publisher-preview'?'Publisher Preview':'Original Link Only'}</p><p className="news-full-preview preserve-case">{currentStory.summary||'No publisher preview was available.'}</p>
    <p className="metadata">This preview does not include the full article.</p><a className="button" href={currentStory.canonicalUrl} target="_blank" rel="noopener noreferrer">Open Original</a>
    {!exactRow&&<p>The original preview is kept here. It is no longer part of the current matching edition, or its source has a newer version.</p>}
    {state?.value.hidden.includes(currentStory.id)&&<p>Story Hidden <button disabled={blocked} onClick={()=>void controller.mutate({type:'unhide',expectedRevision:state.value.revision,storyId:currentStory.id})}>Undo Hide</button></p>}
    {exactRow&&<><div className="news-card-actions">{thumbs(currentStory)}</div><details><summary>Why This Is Here</summary><FeedStoryWhy view={controller.currentView} story={currentStory}/></details>
     <div className="button-row"><button disabled={blocked} onClick={()=>hide(currentStory,true)}>Hide This Story</button><button disabled={blocked} onClick={()=>briefChange({mutedPublishers:[...new Set([...state!.value.profile.settings.mutedPublishers,currentStory.publisherId])]})}>Mute Publisher</button>
      <button disabled={blocked} onClick={()=>briefChange({followedPublishers:state!.value.profile.settings.followedPublishers.includes(currentStory.publisherId)?state!.value.profile.settings.followedPublishers.filter(id=>id!==currentStory.publisherId):[...state!.value.profile.settings.followedPublishers,currentStory.publisherId]})}>{state?.value.profile.settings.followedPublishers.includes(currentStory.publisherId)?'Unfollow Publisher':'Follow Publisher'}</button></div></>}
    <section className="news-keep"><h3>Keep In Library</h3>{saved.map(row=><p key={row.collection.id}>Saved In <span className="preserve-case">{row.collection.title}</span> <button onClick={()=>openLibrary(row.collection.id)}>Open In Library</button></p>)}
     <label>Collection<select value={destination} onChange={event=>setDestination(event.target.value)} disabled={library.busy||!!library.pending}><option value="">Choose A Collection</option>{library.state?.collections.filter(row=>!row.archived).map(row=><option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
     <button disabled={!destination||!library.state||library.busy||!!library.pending||!!library.journalError} onClick={()=>void keep()}>Save To Collection</button>
     {library.pending&&<p>The original Library save is kept. <button onClick={()=>openLibrary()}>Review Original Save In Library</button></p>}
     {(library.error||library.journalError)&&<p role="alert">{library.error||library.journalError}</p>}
     {!library.state?.collections.some(row=>!row.archived)&&<button onClick={()=>openLibrary()}>Create A Collection In Library</button>}
     {currentStory.title.length>150&&<p>The complete original headline is included in the saved notes.</p>}
    </section>
    <button disabled={!onAssistantHandoff||handoffBusy} onClick={()=>void discuss()}>{handoffBusy?'Opening Draft…':'Discuss In Assistant'}</button><p className="metadata">Opens an editable draft with this link and preview. Sending remains a separate action.</p>
    {notice&&<p role="status">{notice}</p>}
   </article>
  </ContentRecoveryPanel>}
  {settingsOpen&&controller.settingsState&&<NewsFeedSettings controller={controller} state={controller.settingsState} close={()=>setSettingsOpen(false)} focus={()=>settingsButton.current}/>}
  {interpretationsOpen&&<Suspense fallback={<LoadingRing label="Loading Interpretations…"/>}><NewsFeedInterpretations scope={snapshot} authorized={controller.authorized}
   close={()=>setInterpretationsOpen(false)} fallbackFocus={()=>interpretationsButton.current}/></Suspense>}
 </section>;
}
