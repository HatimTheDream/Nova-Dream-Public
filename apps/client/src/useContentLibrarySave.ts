import {useEffect,useMemo,useRef,useState} from 'react';
import {contentWorkspaceCommandSchema,type ContentLibraryCommand,type ContentLibraryReceipt} from '../../../packages/domain/content-workspace';
import type {Snapshot} from '../../../packages/domain/contracts';
import {ContentLibraryRequest} from './content-library-recovery';
import {request} from './api';
import {draftBrowserStorage} from './draft-browser-storage';

export function useContentLibrarySave(snapshot:Snapshot,refresh:()=>Promise<void>,confirmed:(receipt:ContentLibraryReceipt)=>void){
 const journal=useMemo(()=>new ContentLibraryRequest(draftBrowserStorage,snapshot),[snapshot.deviceId,snapshot.epoch]);
 const [,render]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const owner=useRef(journal),alive=useRef(true),flight=useRef(false),callback=useRef(confirmed);callback.current=confirmed;owner.current=journal;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const active=()=>alive.current&&owner.current===journal;
 const checkReceipt=async(command:ContentLibraryCommand)=>{
  const receipt=await request<ContentLibraryReceipt>('content/library/receipt',command);
  if(!active())return;
  if(!journal.acknowledge(command,receipt))throw Error(journal.error);
  render(n=>n+1);
  if(receipt.state==='unknown'){setError('The original save is not confirmed. Your writing is kept. Check again or retry that same request.');return;}
  callback.current(receipt);await refresh();
  if(active())setError(receipt.state==='rejected'?receipt.message:'');
 };
 const execute=async(send:boolean,input?:Record<string,unknown>)=>{
  if(!active()||flight.current||journal.invalid)return;
  flight.current=true;setBusy(true);setError('');
  try{
   let command=journal.pending;
   if(input){
    if(command)throw Error('Check the original library save before starting another.');
    const parsed=contentWorkspaceCommandSchema.parse({...input,type:'library-save',epoch:snapshot.epoch,requestId:crypto.randomUUID()});
    if(parsed.type!=='library-save')throw Error('Choose a library save.');
    command=parsed;
    if(!journal.begin(command))throw Error(journal.error);
    render(n=>n+1);
   }
   if(!command)return;
   if(send){
    // No HTTP error or timeout clears an intent. Only the exact retained receipt
    // can establish saved/rejected. Explicit retry preserves the original ID.
    try{await request('content/workspace',command);}catch{/* Observe the original below. */}
   }
   if(active())await checkReceipt(command);
  }catch(error){if(active())setError(error instanceof Error?error.message:'The original save remains unconfirmed.');}
  finally{flight.current=false;if(active()){setBusy(false);render(n=>n+1);}}
 };
 return {run:(input:Record<string,unknown>)=>execute(true,input),check:()=>execute(false),retry:()=>execute(true),
  pending:journal.pending,busy,error:error||journal.error||(journal.value.receipt?.state==='rejected'?journal.value.receipt.message:''),invalid:journal.invalid,copy:()=>journal.copy()};
}
