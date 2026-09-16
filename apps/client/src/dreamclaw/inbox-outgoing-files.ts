import {useEffect,useState} from 'react';
import {useStore} from 'zustand';
import type {MailDeliveryReview} from '../../../../packages/domain/mail-delivery';
import {savedFileSelection,type InboxFileJournal} from './inbox-file-journal';

export function useInboxOutgoingFiles(journal:InboxFileJournal,source:string,review:MailDeliveryReview|undefined,enabled:boolean,scopeVersion:string) {
  const record=useStore(journal.store,state=>state.records[source]);
  const entries=record?.files??savedFileSelection(review);
  const [attempt,setAttempt]=useState(0);
  const key=enabled?JSON.stringify([source,scopeVersion,entries.map(item=>[item.id,item.ready,item.reference]),attempt]):'';
  type Loaded=Awaited<ReturnType<InboxFileJournal['read']>>;
  const [state,setState]=useState<{key:string;files:Record<string,Loaded>;errors:Record<string,string>}>({key:'',files:{},errors:{}});
  useEffect(()=>{
    if(!enabled)return;
    try{journal.ensure(source,review);}catch{/* The host exposes durable storage errors. */}
    for(const entry of entries)if(!entry.ready)void journal.retry(source,entry.id).catch(()=>{});
  },[journal,source,review?.digest,enabled]);
  useEffect(()=>{
    if(!key){setState({key,files:{},errors:{}});return;}
    const controller=new AbortController();let active=true,next=0;
    setState({key,files:{},errors:{}});
    void Promise.allSettled(Array.from({length:Math.min(3,entries.length)},async()=>{while(active&&next<entries.length){const entry=entries[next++];if(!entry.ready)continue;
      try{const file=await journal.read(entry,controller.signal);if(active)setState(state=>state.key===key?{...state,files:{...state.files,[entry.id]:file}}:state);}
      catch(error){if(active)setState(state=>state.key===key?{...state,errors:{...state.errors,[entry.id]:error instanceof Error?error.message:'The file preview could not be loaded.'}}:state);}
    }}));
    return()=>{active=false;controller.abort();};
  },[journal,key]);
  const current=state.key===key?state:{key,files:{},errors:{}};
  return {entries,...current,add:(files:readonly File[])=>journal.add(source,files),remove:(id:string)=>journal.remove(source,id),
    retry:async(id:string,file?:File)=>{await journal.retry(source,id,file);setAttempt(value=>value+1);}};
}
export type InboxOutgoingFiles=ReturnType<typeof useInboxOutgoingFiles>;
