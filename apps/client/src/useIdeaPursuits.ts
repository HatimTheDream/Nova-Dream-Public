import {useEffect,useMemo,useRef,useState} from 'react';
import type {Snapshot} from '../../../packages/domain/contracts';
import {ideaCommandSchema,ideaPursuitSchema,type IdeaCommand,type IdeaPage,type IdeaPursuit} from '../../../packages/domain/idea-pursuits';
import {request} from './api';
import {draftBrowserStorage} from './draft-browser-storage';
import {IdeaRequestJournal} from './idea-pursuits-retained';

export function useIdeaPursuits(snapshot:Snapshot){
 const owner=useMemo(()=>({epoch:snapshot.epoch,deviceId:snapshot.deviceId,active:true,flight:false,generation:0,
  journal:new IdeaRequestJournal(draftBrowserStorage,snapshot)}),[snapshot.epoch,snapshot.deviceId]);
 const current=useRef(owner);current.current=owner;
 const [page,setPage]=useState<{owner:typeof owner;value:IdeaPage<IdeaPursuit>}>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[,render]=useState(0);
 const active=()=>owner.active&&current.current===owner;
 const load=async(after='')=>{
  const ticket=++owner.generation;
  try{
   const value=await request<IdeaPage<IdeaPursuit>>(`home/ideas${after?'?after='+encodeURIComponent(after):''}`);
   if(value.epoch!==owner.epoch||!Array.isArray(value.rows)||value.rows.length>50||value.rows.some(row=>!ideaPursuitSchema.safeParse(row).success||row.epoch!==owner.epoch)
    ||value.next!==null&&(typeof value.next!=='string'||!value.next.startsWith('home:ideas:pursuit:')||value.next.length>300))throw Error('The pursuit list could not be verified.');
   if(active()&&ticket===owner.generation){setPage({owner,value});setError('');}
  }catch(reason){if(active()&&ticket===owner.generation)setError(reason instanceof Error?reason.message:'Pursuits could not load.');}
 };
 useEffect(()=>{owner.active=true;setBusy(false);setError('');void load();return()=>{owner.active=false;owner.generation++;};},[owner]);
 const execute=async(send:boolean,input?:IdeaCommand)=>{
  if(!active()||owner.flight||owner.journal.invalid)return;
  owner.flight=true;setBusy(true);setError('');
  try{
   const command=input?ideaCommandSchema.parse(input):owner.journal.pending;if(!command)return;
   if(input&&!owner.journal.begin(command))throw Error(owner.journal.error);
   render(v=>v+1);
   if(send){try{await request('home/ideas',command);}catch{/* Only exact durable readback settles this request. */}}
   if(!active())return;
   const receipt=await request('home/ideas/receipt',command);
   if(!active())return;
   if(!owner.journal.acknowledge(command,receipt))throw Error(owner.journal.error);
   render(v=>v+1);const saved=owner.journal.value.receipt!;
   if(saved.state==='rejected')setError(saved.message);
   if(saved.state==='unknown')setError('The original request is unconfirmed. Check it again or explicitly retry the same request.');
   if(saved.state==='saved')await load();
   return active()?saved:undefined;
  }catch(reason){if(active())setError(reason instanceof Error?reason.message:'The original Idea request remains kept.');}
  finally{owner.flight=false;if(active()){setBusy(false);render(v=>v+1);}}
 };
 return {journal:owner.journal,page:page?.owner===owner?page.value:undefined,error,busy,load,
  run:(command:IdeaCommand)=>execute(true,command),check:()=>execute(false),retry:()=>execute(true)};
}
