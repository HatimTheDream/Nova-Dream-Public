import { useEffect, useState, useRef } from 'react';
import type { ModuleAction } from '../../../packages/domain/module-actions';
import { readLocal, request, saveLocal } from './api';
import { Check, X } from './icons';
import { pollReader } from './polling';
import { RefreshReader } from './refresh-reader';
import './module-actions.css';
const hidden=new Set(['id','epoch','generation','requestId','writerId','expectedRevision','expectedVersion','expectedOverrideRevision','expectedExceptionsRevision','sha256','base64','digest','deviceId','sourceId','accountId','providerDraftId','providerMessageId','version','contentHash']);
const label=(key:string)=>({bodyText:'Message',bodyHtml:'Formatted message',to:'To',cc:'Cc',bcc:'Bcc',from:'From',planned:'Scheduled',due:'Deadline',kind:'Type',repeat:'Repeats',projectId:'Project',taskId:'Task'}[key]??key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,s=>s.toUpperCase()));
function Value({value,depth=0}:{value:unknown;depth?:number}){
 if(value===null||value===undefined||value==='')return <span className="metadata">None</span>;
 if(typeof value==='boolean')return <span>{value?'Yes':'No'}</span>;
 if(Array.isArray(value))return value.length?<ul>{value.map((item,i)=><li key={i}><Value value={item} depth={depth+1}/></li>)}</ul>:<span className="metadata">None</span>;
 if(typeof value==='object')return <dl>{Object.entries(value).filter(([k])=>!hidden.has(k)).map(([key,v])=><div key={key}><dt>{label(key)}</dt><dd><Value value={v} depth={depth+1}/></dd></div>)}</dl>;
 return <span>{String(value)}</span>;
}
function ActionCard({a,epoch,refresh}:{a:ModuleAction;epoch:string;refresh:()=>Promise<void>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const key='e3:module-decision:'+a.id;
 const decide=async(decision:'apply'|'cancel'|'check')=>{setBusy(true);setError('');try{
  const pending=readLocal<any>(key);const input=decision==='check'?{requestId:crypto.randomUUID(),epoch,actionId:a.id,expectedRevision:a.revision,decision}:pending??{requestId:crypto.randomUUID(),epoch,actionId:a.id,expectedRevision:a.revision,decision};
  if(decision!=='check'&&!saveLocal(key,input))throw new Error('This browser could not retain the decision. Free some local storage and try again.');
  await request('assistant/module-action',input,undefined,30000);localStorage.removeItem(key);
 }catch(e){setError(e instanceof Error?e.message:'The action is unconfirmed. Check its status.');}finally{try{await refresh();}catch(e){setError(e instanceof Error?e.message:'Could not refresh the saved result.');}setBusy(false);}};
 const review=a.review,preview=a.operation==='inbox.organize'&&review?{action:review.action,organization:review.organization,summary:review.summary,accounts:Object.values(review.accountLabels??{}),messages:review.outcomes?.map((o:any)=>({subject:o.subject,status:o.state,detail:o.detail}))}:review?.message??review?.value??a.preview;
 const fields=a.before&&preview&&typeof preview==='object'&&!Array.isArray(preview)?Object.fromEntries(Object.entries(preview as Record<string,unknown>).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify((a.before as any)[k]))):preview;
 return <section className="approval-card module-action" aria-label={a.title}><strong>{a.title}</strong>{a.external&&<p className="metadata">{a.operation==='inbox.compose'?(a.input.mode==='send'?'This sends the message below.':'This saves a draft in your email account.'):a.operation==='agents.start'?'This runs the selected agent assignment.':'This changes the connected account.'}</p>}
 {review?.attendees>0&&<p>Applying may notify {review.attendees} attendees.</p>}{review?.source?.accountEmail&&<p>{review.source.accountEmail}</p>}{review?.accountEmail&&<p>{review.accountEmail}</p>}
 <details open={a.state==='pending'}><summary>Review changes</summary><Value value={fields}/>{(review?.warnings??[]).map((v:string,i:number)=><p key={i}>{v}</p>)}{review?.attendees>0&&<p>Updates may notify {review.attendees} attendees.</p>}</details>
 {a.error&&<p role="status">{a.error}</p>}<div className="button-row">{a.state==='pending'?<><button disabled={busy} onClick={()=>void decide('apply')}><Check size={17}/>{a.operation==='inbox.compose'&&a.input.mode==='send'?'Send email':'Apply'}</button><button className="text-button" disabled={busy} onClick={()=>void decide('cancel')}><X size={17}/>Cancel</button></>:<span>{a.state==='applied'?'Applied':a.state==='cancelled'?'Cancelled':a.state==='failed'?'Not applied':a.state==='partial'?'Partly applied':a.state==='preparing'?'Preparing review…':a.state==='applying'?'Applying…':'Needs checking'}</span>}{a.state==='unknown'&&<button disabled={busy} onClick={()=>void decide('check')}>Check status</button>}</div>{error&&<p role="alert">{error}</p>}</section>;
}
export function ModuleActionTray({conversationId,assignmentId,epoch,refreshWorkspace,working=false}:{conversationId?:string;assignmentId?:string;epoch:string;refreshWorkspace:()=>Promise<void>;working?:boolean}){
 const [items,setItems]=useState<ModuleAction[]>([]),[error,setError]=useState('');
 const refreshRef=useRef(refreshWorkspace);refreshRef.current=refreshWorkspace;
 const readerRef=useRef<{reader:RefreshReader<ModuleAction[]>;refresh:()=>Promise<void>;interval:()=>number} | null>(null);
 useEffect(()=>{
  setItems([]);setError('');if(!conversationId&&!assignmentId)return;
  let nextInterval=30000,signature='',alive=true,workspaceRead=Promise.resolve();
  const reader=new RefreshReader<ModuleAction[]>({identity:()=>JSON.stringify([conversationId,assignmentId,epoch]),
   read:signal=>request('assistant/module-actions',assignmentId?{assignmentId}:{conversationId},signal),
   accept:next=>{setItems(next);setError('');nextInterval=next.some(a=>['preparing','pending','unknown','applying'].includes(a.state))?3000:30000;
    const changed=next.filter(a=>['applied','partial'].includes(a.state)).map(a=>a.id+':'+a.revision).join('|');if(changed!==signature){signature=changed;workspaceRead=refreshRef.current().catch(e=>{if(alive)setError(e instanceof Error?e.message:'Could not refresh the saved result.');});}},
   fail:e=>setError(e instanceof Error?e.message:'Workspace changes are unavailable.')});
  readerRef.current={reader,refresh:async()=>{await reader.refresh();await workspaceRead;},interval:()=>nextInterval};
  return()=>{alive=false;reader.cancel();if(readerRef.current?.reader===reader)readerRef.current=null;};
 },[conversationId,assignmentId,epoch]);
 useEffect(()=>{const current=readerRef.current;if(!current)return;
  return pollReader(current.reader,()=>working?3000:current.interval());
 },[conversationId,assignmentId,epoch,working]);
 const refresh=async()=>{await readerRef.current?.refresh();};
 const pending=items.filter(a=>['preparing','pending','unknown','applying'].includes(a.state));
 const applied=items.filter(a=>a.state==='applied').length,partial=items.filter(a=>a.state==='partial').length;
 const summary=pending.length?`${pending.length} workspace ${pending.length===1?'change':'changes'} to review`:`Workspace changes${applied?` · ${applied} applied`:''}${partial?` · ${partial} partly applied`:''}`;
 if(!items.length)return error?<p className="metadata" role="status">{error}</p>:null;
 return <details className="approval-tray module-action-tray" open={pending.length>0}><summary>{summary}</summary><div className="approval-tray-content">{(pending.length?pending:items.slice(0,5)).map(a=><ActionCard key={a.id} a={a} epoch={epoch} refresh={refresh}/>)}</div></details>;
}
