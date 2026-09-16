import {useCallback,useEffect,useRef,useState} from 'react';
import {ApiError,readLocal,request,saveLocal} from './api';
import type {Snapshot} from '../../../packages/domain/contracts';
import type {ContentLibraryItem,ContentWorkspaceState} from '../../../packages/domain/content-workspace';
export function useContentCommand(snapshot:Snapshot,key:string,refresh:()=>Promise<void>){
 const storage=`e3:content-command:${snapshot.deviceId}:${snapshot.epoch}:${key}`;
 const [pending,setPending]=useState<Record<string,unknown>|undefined>(()=>readLocal(storage)),[busy,setBusy]=useState(false),[error,setError]=useState('');const flight=useRef(false);
 const run=async(input:Record<string,unknown>)=>{if(flight.current)return;const command=pending??{...input,requestId:crypto.randomUUID(),epoch:snapshot.epoch};if(!saveLocal(storage,command)){setError('Free browser storage before saving this change. Your writing is kept.');return;}
  setPending(command);flight.current=true;setBusy(true);setError('');try{const result=await request<any>('content/workspace',command);saveLocal(storage,null);setPending(undefined);await refresh();return result;}catch(e){setError(e instanceof Error?e.message:'The change is unconfirmed. Check the original request.');if(e instanceof ApiError&&e.status&&e.status<500){saveLocal(storage,null);setPending(undefined);await refresh();}}finally{flight.current=false;setBusy(false);}
 };return {run,pending,busy,error,setError};
}
export function useContentLibrary(){const [items,setItems]=useState<ContentLibraryItem[]>([]),[error,setError]=useState('');const load=useCallback(async()=>{try{setItems(await request<ContentLibraryItem[]>('content/library'));setError('');}catch(e){setError(e instanceof Error?e.message:'Library unavailable.');}},[]);useEffect(()=>{void load();},[load]);return {items,error,load};}
export function useContentState(id:string,saved:boolean){const [state,setState]=useState<ContentWorkspaceState>(),[error,setError]=useState('');const alive=useRef(true),loading=useRef(false);
 const load=useCallback(async()=>{if(!saved||loading.current)return;loading.current=true;try{const next=await request<ContentWorkspaceState>(`content/state?id=${encodeURIComponent(id)}`);if(alive.current){setState(next);setError('');}}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Content activity unavailable.');}finally{loading.current=false;}},[id,saved]);
 useEffect(()=>{alive.current=true;void load();const timer=setInterval(()=>{if(!document.hidden)void load();},2500);return()=>{alive.current=false;clearInterval(timer);};},[load]);return {state,error,load};
}
