import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {request} from './api';
import type {Snapshot} from '../../../packages/domain/contracts';
import {contentWorkspaceCommandSchema,type ContentLibraryItem,type ContentWorkspaceState} from '../../../packages/domain/content-workspace';
import {ContentCommandJournal} from './content-command-recovery';
import {draftBrowserStorage} from './draft-browser-storage';
export function useContentCommand(snapshot:Snapshot,key:string,refresh:()=>Promise<void>){
 const owner=useMemo(()=>({journal:new ContentCommandJournal(draftBrowserStorage,{deviceId:snapshot.deviceId,epoch:snapshot.epoch,id:key}),active:true,flight:false}),[snapshot.deviceId,snapshot.epoch,key]);
 const current=useRef(owner);current.current=owner;
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[,render]=useState(0);
 const active=()=>owner.active&&current.current===owner;
 useEffect(()=>{owner.active=true;setBusy(false);setError('');return()=>{owner.active=false;};},[owner]);
 const execute=async(send:boolean,input?:Record<string,unknown>):Promise<any>=>{
  if(!active()||owner.flight||owner.journal.invalid)return;
  owner.flight=true;setBusy(true);setError('');
  try{
   if(input){
    const command=contentWorkspaceCommandSchema.parse({...input,requestId:crypto.randomUUID(),epoch:snapshot.epoch});
    if(!owner.journal.begin(command))throw Error(owner.journal.error);
   }
   const command=owner.journal.pending;if(!command)return;
   render(n=>n+1);
   if(send){try{await request('content/workspace',command);}catch{/* HTTP status is not an original-command receipt. */}}
   if(!active())return;
   const receipt=await request('content/workspace/receipt',command);
   if(!active())return;
   if(!owner.journal.acknowledge(command,receipt))throw Error(owner.journal.error);
   render(n=>n+1);
   const confirmed=owner.journal.value.receipt!;
   if(confirmed.state!=='recorded')setError(confirmed.message);
   await refresh();
   if(active()&&confirmed.state==='recorded')return confirmed.result;
  }catch(reason){if(active())setError(reason instanceof Error?reason.message:'The original Content request remains unconfirmed.');}
  finally{owner.flight=false;if(active()){setBusy(false);render(n=>n+1);}}
 };
 return {run:(input:Record<string,unknown>)=>execute(true,input),check:()=>execute(false),retry:()=>execute(true),
  pending:owner.journal.pending,busy,error:error||owner.journal.error,setError,invalid:owner.journal.invalid,copy:()=>owner.journal.copy(),receipt:owner.journal.value.receipt};
}
export function useContentLibrary(){const [items,setItems]=useState<ContentLibraryItem[]>([]),[error,setError]=useState('');const load=useCallback(async()=>{try{setItems(await request<ContentLibraryItem[]>('content/library'));setError('');}catch(e){setError(e instanceof Error?e.message:'Library unavailable.');}},[]);useEffect(()=>{void load();},[load]);return {items,error,load};}
export function useContentState(id:string,saved:boolean,epoch=''){
 const owner=useMemo(()=>({active:true,loading:false}),[id,saved,epoch]),current=useRef(owner);current.current=owner;
 const [published,setPublished]=useState<{owner:typeof owner;state:ContentWorkspaceState}>(),[error,setError]=useState('');
 const load=useCallback(async()=>{if(!saved||!owner.active||owner.loading)return;owner.loading=true;
  try{const state=await request<ContentWorkspaceState>(`content/state?id=${encodeURIComponent(id)}`);if(owner.active&&current.current===owner){setPublished({owner,state});setError('');}}
  catch(e){if(owner.active&&current.current===owner)setError(e instanceof Error?e.message:'Content activity unavailable.');}
  finally{owner.loading=false;}},[id,saved,owner]);
 useEffect(()=>{owner.active=true;setError('');void load();const timer=setInterval(()=>{if(!document.hidden)void load();},2500);return()=>{owner.active=false;clearInterval(timer);};},[load]);
 return {state:published?.owner===owner?published.state:undefined,error,load};
}
