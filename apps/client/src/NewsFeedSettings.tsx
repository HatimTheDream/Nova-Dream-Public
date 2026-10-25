import {useEffect,useRef,useState} from 'react';
import {canonical} from '../../../packages/domain/contracts';
import type {FeedSettings} from '../../../packages/domain/news-feed';
import {ContentRecoveryPanel} from './ContentRecoveryPanel';
import {registerHomeDraftNavigation} from './home-draft-navigation';
import {feedSettingsWriting,parseFeedSettingsWriting,type FeedSettingsDraft,type FeedSettingsWriting} from './news-feed-retained';
import type {NewsFeedController} from './useNewsFeed';
import type {FeedSettingsSnapshot} from './feed-view-publication';
import {FeedCurrentInterests} from './NewsFeedEvidence';

const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const message=(error:unknown)=>error&&typeof error==='object'&&'issues'in error
 ?(error as {issues:{message:string}[]}).issues[0]?.message??'Review the Feed settings.'
 :error instanceof Error?error.message:'These changes could not be kept.';
function Summary({value}:{value:FeedSettings}){
 return <dl className="news-brief-summary">
  <dt>Interests</dt><dd className="preserve-case">{value.interests.join(' · ')||'No Written Interests'}</dd>
  <dt>Written Directions</dt><dd><pre className="preserve-case">{value.directions||'None'}</pre></dd>
  <dt>Excluded Topics</dt><dd className="preserve-case">{value.exclusions.join(' · ')||'None'}</dd>
  <dt>Sources</dt><dd>{value.sources.map(source=><p key={source.id} className="preserve-case">{source.title} · {source.enabled?'Enabled':'Off'}<br/>{source.url}</p>)}</dd>
  <dt>Following</dt><dd className="preserve-case">{value.followedPublishers.join(' · ')||'None'}</dd>
  <dt>Automatic Source Checks</dt><dd>{value.autoRefreshHours?`Every ${value.autoRefreshHours} Hours`:'Off'}</dd>
  <dt>Muted Publishers</dt><dd className="preserve-case">{value.mutedPublishers.join(' · ')||'None'}</dd>
  <dt>Learning</dt><dd>{value.learning.enabled?'On':'Off'} · {value.learning.paused?'Paused':'Updates Allowed'} · {value.learning.instructionsOnly?'Written Instructions Only':'Permitted Interests Applied'}<br/>
   {value.learning.allowed.join(' · ')||'No Activity Sources'} · {value.learning.scope==='within'?'Within My Interests':'Related Discoveries'}</dd>
 </dl>;
}
export function NewsFeedSettings({controller,state,close,focus}:{controller:NewsFeedController;state:FeedSettingsSnapshot;close():void;focus():HTMLElement|null}){
 const journal=controller.settings;
 const initial=journal.value.draft??{baseRevision:state.value.revision,base:state.value.profile.settings,writing:feedSettingsWriting(state.value.profile.settings)};
 const [draft,setDraft]=useState<FeedSettingsDraft>(initial),[error,setError]=useState(''),[section,setSection]=useState<'instructions'|'learning'|'sources'>('instructions'),
  [review,setReview]=useState<FeedSettings>(),[compare,setCompare]=useState(false),[resetReview,setResetReview]=useState(false);
 const current=useRef(draft);current.current=draft;
 const retain=()=>{
  if(journal.put(current.current)){setError('');return true;}setError(journal.error);return false;
 };
 useEffect(()=>{retain();return registerHomeDraftNavigation(retain);},[journal]);
 useEffect(()=>{
  const previous=current.current,saved=state.value.profile.settings;
  if(state.value.revision<=previous.baseRevision)return;
  if(same(previous.base,saved)){
   const next={...previous,baseRevision:state.value.revision};current.current=next;setDraft(next);journal.put(next);
  }
 },[state.value.revision,journal]);
 useEffect(()=>{
  const receipt=controller.receipt;
  if(receipt?.kind!=='mutation'||receipt.value.state!=='saved'||receipt.value.command.type!=='settings')return;
  const previous=current.current,command=receipt.value.command;
  if(previous.baseRevision!==command.expectedRevision)return;
  const next={...previous,baseRevision:receipt.value.revision,base:command.settings};current.current=next;setDraft(next);journal.put(next);setReview(undefined);
 },[controller.receipt,journal]);
 const change=(patch:Partial<FeedSettingsWriting>)=>{
  const next={...current.current,writing:{...current.current.writing,...patch}};current.current=next;setDraft(next);setReview(undefined);
  if(!journal.put(next))setError(journal.error);else setError('');
 };
 const changedElsewhere=state.value.revision>draft.baseRevision&&!same(draft.base,state.value.profile.settings);
 const prepare=(useSaved:boolean)=>{
  if(!journal.prepare(current.current,state,useSaved)){setError(journal.error);return;}
  const next=journal.value.draft!;current.current=next;setDraft(next);setCompare(false);setReview(undefined);setError('');
 };
 const closeSafely=()=>{if(retain())close();};
 const blocked=controller.busy||!!controller.pending||journal.invalid;
 const raw=draft.writing;
 const editSource=(index:number,patch:Partial<FeedSettingsWriting['sources'][number]>)=>change({sources:raw.sources.map((source,i)=>i===index?{...source,...patch}:source)});
 const reviewBrief=()=>{try{if(!retain())return;if(changedElsewhere){setCompare(true);return;}setReview(parseFeedSettingsWriting(current.current.writing));setError('');}catch(reason){setError(message(reason));}};
 return <ContentRecoveryPanel title="Feed Settings" close={closeSafely} fallbackFocus={focus} breakpoint={800} backLabel="Back To Feed" tools>
  <p className="metadata">Changes stay on this device until you review and use the brief.</p>
  {controller.settingsStale?<p role="status">Last Loaded Preferences · These settings may have changed elsewhere. Changes still use saved revision {state.value.revision} and require current server permission.</p>:controller.settingsSeparate&&<p role="status">Preferences Loaded Separately · Current story matching remains unavailable.</p>}
  {(error||journal.error)&&<div role="alert"><p>{error||journal.error}</p><details><summary>Complete Kept Writing</summary><textarea readOnly aria-label="Copy Complete Feed Writing" value={JSON.stringify({draft,currentStorage:journal.copy()},null,2)}/></details><button onClick={retain}>Retry Keeping Changes</button></div>}
  {controller.pending&&<p role="status">An original Feed request is unconfirmed. Your newer writing stays separate.</p>}
  {changedElsewhere&&<div className="notice warning"><p>The saved brief changed elsewhere. Both versions stay separate.</p><button onClick={()=>setCompare(true)}>Compare Versions</button></div>}
  {compare?<section><h3>Your Kept Writing</h3><pre className="preserve-case">{draft.writing.interestsText}{'\n\n'}{draft.writing.directions}{'\n\nExcluded: '}{draft.writing.exclusionsText}</pre>
   <details><summary>All Kept Settings</summary><textarea readOnly aria-label="Complete Local Feed Settings" value={JSON.stringify(draft.writing,null,2)}/></details>
   <h3>Latest Saved Brief</h3><Summary value={state.value.profile.settings}/><div className="button-row"><button disabled={blocked} onClick={()=>prepare(false)}>Prepare My Writing</button><button disabled={blocked} onClick={()=>prepare(true)}>Prepare Saved Brief</button></div><p>Both complete versions are kept before preparing either choice. Saving remains a separate action.</p>
  </section>:review?<section><h3>Review This Brief</h3><Summary value={review}/><p>Only supported matches may appear. Written directions may use a current accepted interpretation; unsupported literal syntax alone does not establish a match.</p>
   <div className="button-row"><button onClick={()=>setReview(undefined)}>Back To Editing</button><button className="primary" disabled={blocked||changedElsewhere} onClick={()=>void controller.mutate({type:'settings',expectedRevision:draft.baseRevision,settings:review})}>Use This Brief</button></div>
  </section>:<>
   <div className="segmented" aria-label="Feed Settings Sections">{(['instructions','learning','sources'] as const).map(value=><button key={value} aria-pressed={section===value} onClick={()=>setSection(value)}>{value==='instructions'?'Your Instructions':value==='learning'?'Learning':'Sources'}</button>)}</div>
   <div hidden={section!=='instructions'}>
    <label>Interests <textarea value={raw.interestsText} maxLength={4000} onChange={event=>change({interestsText:event.target.value})} placeholder="One topic or phrase per line"/></label>
    <label>Written Directions <textarea value={raw.directions} maxLength={4000} onChange={event=>change({directions:event.target.value})}/></label>
    <p className="metadata">Current matching supports exact topics and these lines: <span className="preserve-case">Topics: design; writing</span>, <span className="preserve-case">Only topics: science</span>, or <span className="preserve-case">Exclude topics: crypto</span>. Other directions remain intact and may use an accepted interpretation in Interpretations.</p>
    <label>Excluded Topics <textarea value={raw.exclusionsText} maxLength={4000} onChange={event=>change({exclusionsText:event.target.value})} placeholder="One excluded topic per line"/></label>
   </div>
   <div hidden={section!=='learning'}>
    <p>{state.activity.message}</p>
    <label className="checkbox"><input type="checkbox" checked={raw.learning.enabled} disabled={state.activity.status==='not-connected'} onChange={event=>change({learning:{...raw.learning,enabled:event.target.checked}})}/>Learn From My Activity</label>
    <p>Written directions and exclusions remain yours. Activity cannot give permission to send messages or start work.</p>
    {(['reading','library','ideas'] as const).map(source=><label className="checkbox" key={source}><input type="checkbox" disabled={!state.activity.supported?.includes(source)} checked={raw.learning.allowed.includes(source)} onChange={event=>change({learning:{...raw.learning,allowed:event.target.checked?[...raw.learning.allowed,source]:raw.learning.allowed.filter(value=>value!==source)}})}/>{source==='reading'?'Feed Reading And Returns':source==='library'?'Saved Library Notes And Links':state.activity.supported?.includes('ideas')?'Ideas I Submit To Assistant':'Ideas I Pursue — Not Connected Yet'}</label>)}
    <label>Discovery Scope<select value={raw.learning.scope} onChange={event=>change({learning:{...raw.learning,scope:event.target.value as 'within'|'related'}})}><option value="within">Stay Within My Interests</option><option value="related">Include Related Discoveries</option></select></label>
    <label className="checkbox"><input type="checkbox" checked={raw.learning.paused} onChange={event=>change({learning:{...raw.learning,paused:event.target.checked}})}/>Pause Automatic Learning Updates</label>
    <label className="checkbox"><input type="checkbox" checked={raw.learning.instructionsOnly} onChange={event=>change({learning:{...raw.learning,instructionsOnly:event.target.checked}})}/>Use Written Instructions Only</label>
    <p>Pausing keeps the existing learned profile in use. Instructions Only stops applying learned interests. Explicitly kept interests remain your own choices.</p>
    <section>
     <FeedCurrentInterests view={controller.currentView} controls={interest=><div className="button-row">
      <button disabled={blocked} onClick={()=>void controller.mutate({type:'interest',expectedRevision:state.value.revision,topic:interest.label,action:'keep'})}>Keep As My Interest</button>
      <button disabled={blocked} onClick={()=>void controller.mutate({type:'interest',expectedRevision:state.value.revision,topic:interest.label,action:'stop'})}>Stop Using This Interest</button>
     </div>}/>
     {state.value.control.kept.length>0&&<><h4>Explicitly Kept</h4>{state.value.control.kept.map(topic=><p key={topic}><span className="preserve-case">{topic}</span> <button disabled={blocked} onClick={()=>void controller.mutate({type:'interest',expectedRevision:state.value.revision,topic,action:'stop'})}>Stop Using</button></p>)}</>}
     {state.value.control.stopped.length>0&&<><h4>Stopped Interests</h4>{state.value.control.stopped.map(topic=><p key={topic}><span className="preserve-case">{topic}</span> <button disabled={blocked} onClick={()=>void controller.mutate({type:'interest',expectedRevision:state.value.revision,topic,action:'allow'})}>Allow Learning Again</button></p>)}</>}
     {resetReview?<div><p>Clear learned interests and reading signals, then pause learning. Written interests, kept/stopped choices, feedback, Library items and drafts stay intact. Old activity will not rebuild the profile.</p>
      <button disabled={blocked} onClick={()=>{setResetReview(false);void controller.mutate({type:'learning-reset',expectedRevision:state.value.revision});}}>Reset And Pause Learning</button> <button onClick={()=>setResetReview(false)}>Cancel Reset</button></div>
      :<button disabled={blocked} onClick={()=>setResetReview(true)}>Reset Learned Interests…</button>}
    </section>
   </div>
   <div hidden={section!=='sources'}>
    <p>Add public RSS, Atom or JSON Feed sources. Stories still have to match your brief.</p>
    <label>Automatic Source Checks<select value={raw.autoRefreshHours??''} onChange={event=>change({autoRefreshHours:event.target.value?Number(event.target.value) as 6|12|24:null})}>
     <option value="">Off — Check Manually</option><option value="6">Every 6 Hours</option><option value="12">Every 12 Hours</option><option value="24">Every 24 Hours</option>
    </select></label>
    <p>After you review and save this brief, Dream checks enabled sources while it is running. Missed checks are skipped. New stories wait quietly without moving your current article. Saving the brief starts a fresh interval; it never retries an earlier request.</p>
    {state.schedule&&<p role="status">{state.schedule.message} {state.schedule.retainedCount} Of {state.schedule.limit} Original Checks Retained. Checks pause when history is full; existing stories and results stay available.</p>}
    {raw.sources.map((source,index)=><fieldset className="news-source-editor" key={source.id}><legend>Source {index+1}</legend>
     <label>Publisher Name<input value={source.title} maxLength={150} onChange={event=>editSource(index,{title:event.target.value})}/></label>
     <label>Feed Address<input type="url" value={source.url} maxLength={2048} onChange={event=>editSource(index,{url:event.target.value})}/></label>
     <label className="checkbox"><input type="checkbox" checked={source.enabled} onChange={event=>editSource(index,{enabled:event.target.checked})}/>Enabled</label>
     <button onClick={()=>change({sources:raw.sources.filter((_,i)=>i!==index)})}>Remove Source From Brief</button>
    </fieldset>)}
    <button disabled={raw.sources.length>=12} onClick={()=>change({sources:[...raw.sources,{id:'source:'+crypto.randomUUID(),title:'',url:'',enabled:true}]})}>Add Source</button>
    {raw.mutedPublishers.length>0&&<section><h3>Muted Publishers</h3>{raw.mutedPublishers.map(publisher=><p key={publisher}><span className="preserve-case">{publisher}</span> <button onClick={()=>change({mutedPublishers:raw.mutedPublishers.filter(value=>value!==publisher)})}>Unmute</button></p>)}</section>}
    {raw.followedPublishers.length>0&&<section><h3>Following</h3>{raw.followedPublishers.map(publisher=><p key={publisher}><span className="preserve-case">{publisher}</span> <button onClick={()=>change({followedPublishers:raw.followedPublishers.filter(value=>value!==publisher)})}>Unfollow</button></p>)}</section>}
   </div>
   <button className="primary" disabled={blocked} onClick={reviewBrief}>Review Brief</button>
  </>}
 </ContentRecoveryPanel>;
}
