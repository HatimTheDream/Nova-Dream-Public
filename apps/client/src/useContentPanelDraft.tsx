import {useEffect,useRef,useState} from 'react';
import type {z} from 'zod';
import {RetainedBook} from './content-library-recovery';
import {draftBrowserStorage} from './draft-browser-storage';
import {registerRecordDraftNavigation} from './record-draft-navigation';

/** The component owns current writing; the existing slot keeps its exact legacy
 * shape/key and refuses unreadable or competing bytes. There is no second store. */
export type ContentPanelLeaveRef={current:(()=>boolean)|null};
export function useContentPanelDraft<T>(key:string,schema:z.ZodType<T>,initial:T,leaveRef?:ContentPanelLeaveRef){
 const [owner]=useState(()=>{const book=new RetainedBook(draftBrowserStorage,key,schema,initial);return {key,book,value:book.value,dirty:false,generation:0,active:true,error:book.error};});
 const currentKey=useRef(key);currentKey.current=key;
 const [,render]=useState(0);
 const generation=owner.generation;
 const current=()=>owner.active&&currentKey.current===owner.key;
 const retain=()=>{
  if(!current()){owner.error='This writing belongs to an earlier workspace. Copy it before reloading.';if(owner.active)render(n=>n+1);return false;}
  // A clean unreadable slot still exists byte-for-byte. It must not trap the
  // owner in this view; only new writing that would be lost holds departure.
  if(!owner.dirty)return true;
  const kept=owner.book.keep(owner.value);owner.error=kept?'':owner.book.error;if(kept)owner.dirty=false;render(n=>n+1);return kept;
 };
 const change=(next:T|((value:T)=>T))=>{
  if(!current()||generation!==owner.generation)return false;
  const value=typeof next==='function'?(next as (value:T)=>T)(owner.value):next;
  if(value===owner.value)return true;
  owner.value=value;owner.dirty=true;
  return retain();
 };
 const discard=()=>{
  if(!current())return false;
  // Explicitly discard this window's new edits only. The original slot is
  // never cleared or overwritten, including invalid or competing bytes.
  owner.value=owner.book.value;owner.dirty=false;owner.generation++;owner.error=owner.book.invalid?owner.book.error:'';render(n=>n+1);return true;
 };
 useEffect(()=>{
  owner.active=true;
  const unregister=registerRecordDraftNavigation(retain);
  if(leaveRef)leaveRef.current=retain;
  const unload=(event:BeforeUnloadEvent)=>{if(!retain()){event.preventDefault();event.returnValue='';}};
  if(typeof window!=='undefined')window.addEventListener('beforeunload',unload);
  return()=>{
   // Ordinary exits have already passed the registered guard. This final write
   // stays under the original key even if the owner is forcibly retired.
   if(owner.dirty)owner.book.keep(owner.value);owner.active=false;unregister();
   if(leaveRef?.current===retain)leaveRef.current=null;
   if(typeof window!=='undefined')window.removeEventListener('beforeunload',unload);
  };
 },[owner,leaveRef]);
 return {value:owner.value,change,retain,retainForCommand:()=>current()&&generation===owner.generation&&!owner.book.invalid&&retain(),discard,unretained:owner.dirty,blocked:!current()||owner.book.invalid||!!owner.error,
  error:!current()?'This writing belongs to an earlier workspace. Copy it before reloading.':owner.error,
  copy:()=>JSON.stringify({key:owner.key,current:owner.value,recovery:owner.book.copy()},null,2)};
}

export function ContentPanelDraftNotice({draft}:{draft:{error:string;unretained:boolean;retain():boolean;discard():boolean;copy():string}}){
 return draft.error?<section className="notice"><p role="alert">{draft.unretained?'Your latest writing is kept in this window.':'Earlier kept writing needs attention. Its original is preserved.'} {draft.error}</p>
  <button type="button" onClick={()=>draft.retain()}>Retry Keeping Writing</button>
  {draft.unretained&&<button type="button" onClick={()=>draft.discard()}>Discard This Window’s Changes</button>}
  <details><summary>Copy Current Writing And Recovery</summary><textarea readOnly rows={8} aria-label="Copy Current Content Panel Writing" value={draft.copy()}/></details>
 </section>:null;
}
