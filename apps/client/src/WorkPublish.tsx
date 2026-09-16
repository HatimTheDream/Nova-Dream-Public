import { useEffect, useState } from 'react';
import type { GitPublication, GitReview } from '../../../packages/domain/work-repositories';
import { readLocal, request, saveLocal } from './api';
import './work-tools.css';
import { workRequestRejected } from './work-request';
type PublishRequest={requestId:string;epoch:string;conversationId:string;fingerprint:string;title:string;body:string;action:GitPublication['action']};
export function WorkPublish({conversationId,epoch}:{conversationId:string;epoch:string}){
  const key=`e3:work-publication:${epoch}:${conversationId}`;
  const [review,setReview]=useState<GitReview>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),[title,setTitle]=useState(()=>readLocal<{title:string}>(key+':writing')?.title??''),[body,setBody]=useState(()=>readLocal<{body:string}>(key+':writing')?.body??''),[pending,setPending]=useState<PublishRequest|undefined>(()=>readLocal(key));
  const load=async()=>{try{setReview(await request<GitReview>(`work/review?conversation=${conversationId}`,undefined,undefined,30000));setError('');}catch(e){setError((e as Error).message);}};
  useEffect(()=>{void load();},[conversationId,refresh]);
  useEffect(()=>{if(!review?.operations.some(o=>['prepared','running'].includes(o.state)))return;const timer=setTimeout(()=>void load(),2500);return()=>clearTimeout(timer);},[review]);
  const saveWriting=(nextTitle:string,nextBody:string)=>{if(!saveLocal(key+':writing',{title:nextTitle,body:nextBody})){setError('Browser storage is full. Keep a copy of your publication text.');return;}setTitle(nextTitle);setBody(nextBody);};
  const perform=async(action:GitPublication['action'])=>{
    if(!review)return;const command=pending??{requestId:crypto.randomUUID(),epoch,conversationId,fingerprint:review.fingerprint,title,body,action};
    if(!saveLocal(key,command)){setError('Free browser storage before publishing.');return;}setPending(command);setBusy(true);setError('');
    try{const outcome=await request<GitPublication>('work/publish',command,undefined,30000);saveLocal(key,null);setPending(undefined);await load();if(outcome.state==='failed')setError(outcome.message);}catch(e){if(workRequestRejected(e)){saveLocal(key,null);setPending(undefined);}setError((e as Error).message);}finally{setBusy(false);}
  };
  const reconcile=async(id:string)=>{setBusy(true);setError('');try{await request('work/reconcile',{requestId:crypto.randomUUID(),epoch,id},undefined,30000);await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="work-publish"><div className="section-heading"><h3>Publish changes</h3><button type="button" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>Refresh review</button></div>
    {review&&<><p><strong>{review.repository}</strong></p><p className="metadata">{review.branch} → {review.baseBranch}</p><p className="metadata">{review.message}</p>
      {review.files.map(file=><details key={file.path}><summary>{file.status} · {file.path}</summary><pre className="work-project-patch">{file.patch||'Binary or omitted patch. Review this file before committing.'}</pre>{file.truncated&&<p className="metadata">Patch shortened.</p>}</details>)}
      {!review.files.length&&<p className="metadata">All checkout changes are committed.</p>}
      <label>Commit or pull request title<input maxLength={200} value={title} onChange={e=>saveWriting(e.target.value,body)} placeholder="Describe the change"/></label><label>Details<textarea rows={3} maxLength={10000} value={body} onChange={e=>saveWriting(title,e.target.value)} placeholder="What changed and how it was checked"/></label>
      <div className="button-row"><button type="button" disabled={busy||!!pending||!review.canPublish||!title.trim()||!review.files.length} onClick={()=>void perform('commit')}>Commit {review.files.length||''} files</button><button type="button" disabled={busy||!!pending||!review.canPublish||!title.trim()||!!review.files.length} onClick={()=>void perform('push')}>Push branch</button><button type="button" disabled={busy||!!pending||!review.canPublish||!title.trim()||!!review.files.length} onClick={()=>void perform('pull-request')}>Open draft PR</button></div>
      <p className="metadata">A push publishes committed code to GitHub. Merging and deployment are separate actions.</p>
      {review.operations.map(p=><div className="work-publication" key={p.id}><strong>{p.action==='pull-request'?'Pull request':p.action==='push'?'Push':'Commit'} · {p.state}</strong><p role={['running','prepared'].includes(p.state)?'status':undefined}>{p.message}</p>{p.head&&<code>{p.head.slice(0,12)}</code>}{p.url&&<a href={p.url} target="_blank" rel="noreferrer">Open pull request</a>}{p.state==='unknown'&&<button type="button" disabled={busy} onClick={()=>void reconcile(p.id)}>Check result</button>}</div>)}
    </>}
    {pending&&<div className="notice"><div><p>The original publication request is kept on this device.</p><button type="button" disabled={busy} onClick={()=>void perform(pending.action)}>Reconcile request</button></div></div>}
    {error&&<p role="alert" className="field-error">{error}</p>}
  </section>;
}
