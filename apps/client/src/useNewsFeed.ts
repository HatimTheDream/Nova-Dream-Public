import {useEffect,useMemo,useRef,useState} from 'react';
import type {Snapshot} from '../../../packages/domain/contracts';
import {feedCommandSchema,type FeedRefreshCommand} from '../../../packages/domain/news-feed';
import {request} from './api';
import {draftBrowserStorage} from './draft-browser-storage';
import {retainedWindowId} from './useWorkspace';
import {FeedReadingJournal,FeedRequestJournal,FeedSettingsJournal,type FeedPending,type FeedReadingView} from './news-feed-retained';
import {FeedViewPublication,feedAccessDenied,feedPendingRoute} from './feed-view-publication';

export function useNewsFeed(snapshot:Snapshot){
 const scope=useMemo(()=>({deviceId:snapshot.deviceId,epoch:snapshot.epoch,windowId:retainedWindowId}),[snapshot.deviceId,snapshot.epoch]);
 const owner=useMemo(()=>({scope,requests:new FeedRequestJournal(draftBrowserStorage,scope),reading:new FeedReadingJournal(draftBrowserStorage,scope),
  settings:new FeedSettingsJournal(draftBrowserStorage,scope),publication:new FeedViewPublication(scope),active:true,flight:false,automaticFlight:false,automaticError:''}),[scope]);
 const currentOwner=useRef(owner);currentOwner.current=owner;
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[,render]=useState(0);
 const active=()=>owner.active&&currentOwner.current===owner;
 const changed=()=>{if(active())render(value=>value+1);};
 const load=async(signal?:AbortSignal)=>{
  const ticket=owner.publication.begin(owner.reading.value.following);if(active())setLoading(true);
  try{
   const raw=await request(`home/news/semantic/feed?following=${ticket.following?'1':'0'}`,undefined,signal);
   if(!active()||signal?.aborted||!owner.publication.publish(ticket,raw))return;
   setError(owner.automaticError);changed();
   if(owner.publication.current?.state==='unavailable'){
    // This independently owned read supplies Settings only, never Feed proof.
    try{const settings=await request(`home/news${ticket.following?'?following=1':''}`,undefined,signal);
     if(active()&&!signal?.aborted&&owner.publication.publishSettings(ticket,settings))changed();
    }catch(reason){if(active()&&!signal?.aborted&&owner.publication.settingsFailed(ticket,reason)){setError(reason instanceof Error?reason.message:'Current preferences could not refresh.');setLoading(false);changed();}}
   }
  }catch(reason){if(active()&&!signal?.aborted&&owner.publication.fail(ticket,reason)){setError(reason instanceof Error?reason.message:'Feed could not refresh.');setLoading(false);changed();}}
  finally{if(active()&&owner.publication.owns(ticket))setLoading(false);}
 };
 useEffect(()=>{
  owner.active=true;owner.publication.activate();setBusy(false);setError('');
  const controller=new AbortController();void load(controller.signal);
  const advance=async()=>{
   if(document.hidden||owner.flight||owner.automaticFlight||!active())return;owner.automaticFlight=true;
   try{await request('home/news/semantic/advance',{epoch:scope.epoch},controller.signal);if(!controller.signal.aborted)owner.automaticError='';}
   catch(reason){if(!controller.signal.aborted){owner.automaticError=reason instanceof Error?reason.message:'Automatic Feed matching could not save its result.';if(active())setError(owner.automaticError);}}
   finally{owner.automaticFlight=false;if(active()&&!controller.signal.aborted)void load(controller.signal);}
  };
  void advance();const timer=setInterval(()=>void advance(),15000);
  return()=>{owner.active=false;owner.publication.dispose();controller.abort();clearInterval(timer);};
 },[owner]);
 const execute=async(send:boolean,next?:FeedPending)=>{
  if(!active()||owner.flight||owner.requests.invalid)return;
  owner.flight=true;setBusy(true);setError('');
  try{
   const pending=next??owner.requests.value.pending;if(!pending)return;
   if(next&&!owner.requests.begin(next))throw Error(owner.requests.error);
   changed();const route=feedPendingRoute(pending);
   if(send){try{await request(route,pending.command,undefined,pending.kind==='refresh'?25000:12000);}catch(reason){
    if(feedAccessDenied(reason))throw reason;/* Exact readback settles uncertain sends. */
   }}
   if(!active())return;
   const receipt=await request(`${route}/receipt`,pending.command);if(!active())return;
   if(!owner.requests.acknowledge(pending,receipt))throw Error(owner.requests.error);
   changed();await load();
   if(active()){
    const value=owner.requests.value.receipt?.value;
    if(value&&['unknown','running'].includes(value.state))setError('The original request is still unconfirmed. Check its result; a new request has not been sent.');
    else if(value&&['rejected','failed','withdrawn','expired'].includes(value.state)&&'message'in value)setError(value.message);
   }
  }catch(reason){if(active()){if(feedAccessDenied(reason)){owner.publication.deny();setLoading(false);}setError(reason instanceof Error?reason.message:'The original request remains unconfirmed.');changed();}}
  finally{owner.flight=false;if(active()){setBusy(false);changed();}}
 };
 const keepReading=(value:FeedReadingView)=>{
  if(!active())return false;
  const saved=owner.reading.keep(value);if(saved)owner.publication.select(value.following);changed();return saved;
 };
 const published=owner.publication.current;
 const currentView=published?.checkpoint.following===owner.reading.value.following?published:undefined;
 return {scope,settings:owner.settings,reading:owner.reading,requests:owner.requests,
  currentView,state:currentView?.state==='ready'?currentView:undefined,
  settingsState:owner.publication.settings,settingsStale:owner.publication.settingsStale,settingsSeparate:owner.publication.settingsSeparate,
  authorized:owner.publication.authorized,loading,busy,error,load:()=>load(),keepReading,
  mutate:(input:Record<string,unknown>)=>{
   try{const command=feedCommandSchema.parse({...input,epoch:snapshot.epoch,requestId:crypto.randomUUID()});return execute(true,{kind:'mutation',command});}
   catch(reason){if(active())setError(reason instanceof Error?reason.message:'Review this Feed change.');return Promise.resolve();}
  },
  refresh:(command:FeedRefreshCommand)=>execute(true,{kind:'refresh',command}),
  check:()=>execute(false),retry:()=>execute(true),pending:owner.requests.value.pending,receipt:owner.requests.value.receipt,
  invalid:owner.requests.invalid||owner.reading.invalid||owner.settings.invalid,
 };
}
export type NewsFeedController=ReturnType<typeof useNewsFeed>;
