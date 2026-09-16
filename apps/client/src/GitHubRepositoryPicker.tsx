import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubRepository, WorkCheckout } from '../../../packages/domain/work-repositories';
import { readLocal, request, saveLocal } from './api';
import { GitHubConnection } from './GitHubConnection';
import './work-tools.css';
import { workRequestRejected } from './work-request';

type CheckoutRequest={requestId:string;epoch:string;repository:string;baseBranch:string};
export function GitHubRepositoryPicker({epoch,deviceId,projectId,onSelect}:{epoch:string;deviceId:string;projectId:string;onSelect:(checkout:WorkCheckout)=>boolean}){
  const key=`e3:work-checkout:${epoch}:${deviceId}:${projectId}`;
  const [repositories,setRepositories]=useState<GitHubRepository[]>([]),[nextPage,setNextPage]=useState<number|null>(1),[query,setQuery]=useState(''),[repository,setRepository]=useState<GitHubRepository>(),[branches,setBranches]=useState<string[]>([]),[branch,setBranch]=useState(''),[branchPage,setBranchPage]=useState<number|null>(null),[checkouts,setCheckouts]=useState<WorkCheckout[]>([]),[pending,setPending]=useState<CheckoutRequest|undefined>(()=>readLocal(key)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const branchOwner=useRef('');
  const branchRequest=useRef(0);
  const load=useCallback(async(page=1)=>{setBusy(true);setError('');try{const result=await request<{items:GitHubRepository[];nextPage:number|null}>(`work/repositories?page=${page}`);setRepositories(old=>page===1?result.items:[...old,...result.items]);setNextPage(result.nextPage);}catch(e){setError((e as Error).message);}finally{setBusy(false);}},[epoch]);
  const connected=useCallback(()=>{void load();},[load]);
  const loadBranches=async(repo:GitHubRepository,page=1)=>{const ticket=++branchRequest.current;branchOwner.current=repo.fullName;setError('');try{const result=await request<{items:{name:string}[];nextPage:number|null}>(`work/branches?repository=${encodeURIComponent(repo.fullName)}&page=${page}`);if(ticket!==branchRequest.current||branchOwner.current!==repo.fullName)return;setBranches(old=>page===1?result.items.map(b=>b.name):[...old,...result.items.map(b=>b.name)]);setBranchPage(result.nextPage);}catch(e){if(ticket===branchRequest.current)setError((e as Error).message);}};
  useEffect(()=>{const abort=new AbortController();const read=()=>request<{checkouts:WorkCheckout[]}>('work/state',undefined,abort.signal).then(state=>{if(!abort.signal.aborted)setCheckouts(state.checkouts);}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});void read();const timer=setInterval(()=>void read(),pending?1800:12000);return()=>{abort.abort();clearInterval(timer);};},[epoch,pending?.requestId]);
  const active=checkouts.find(c=>c.operationId===pending?.requestId);
  const choose=(checkout:WorkCheckout)=>{if(onSelect(checkout)){saveLocal(key,null);setPending(undefined);}else setError('Free browser storage before selecting this repository.');};
  const prepare=async()=>{
    if(!pending&&(!repository||!branch))return;const command=pending??{requestId:crypto.randomUUID(),epoch,repository:repository!.fullName,baseBranch:branch};
    if(!saveLocal(key,command)){setError('Free browser storage before preparing this repository.');return;}
    setPending(command);setBusy(true);setError('');
    try{const c=await request<WorkCheckout>('work/checkout',command,undefined,30000);setCheckouts(old=>[c,...old.filter(item=>item.id!==c.id)]);}catch(e){if(workRequestRejected(e)){saveLocal(key,null);setPending(undefined);}setError((e as Error).message);}finally{setBusy(false);}
  };
  return <div className="github-picker"><GitHubConnection epoch={epoch} onConnected={connected}/>
    <p className="metadata">Repositories run on Nova’s host. You can use them from your phone without a linked desktop.</p>
    {!pending&&<><label>Find a repository<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Filter loaded repositories"/></label><div className="repository-list">{repositories.filter(r=>r.fullName.toLowerCase().includes(query.toLowerCase())).map(repo=><button type="button" key={repo.id} aria-pressed={repository?.id===repo.id} disabled={busy||repo.archived} onClick={()=>{setRepository(repo);setBranch(repo.defaultBranch);setBranches([repo.defaultBranch]);setBranchPage(null);void loadBranches(repo);}}><strong>{repo.fullName}</strong><small>{repo.private?'Private':'Public'} · {repo.archived?'Archived':repo.canPush?'Read & write':'Read only'}</small></button>)}</div>{nextPage&&repositories.length>0&&<button type="button" disabled={busy} onClick={()=>void load(nextPage)}>Load more repositories</button>}
    {repository&&<div className="work-branch-picker"><label>Start from branch<select value={branch} onChange={e=>setBranch(e.target.value)}>{[...new Set([repository.defaultBranch,...branches])].map(b=><option key={b}>{b}</option>)}</select></label>{branchPage&&<button type="button" onClick={()=>void loadBranches(repository,branchPage)}>More branches</button>}<button type="button" className="primary" disabled={busy||!branch} onClick={()=>void prepare()}>Prepare on host</button><p className="metadata">Creates a separate Nova feature branch. The original branch stays available.</p></div>}</>}
    {pending&&<div className="notice"><div><strong>{pending.repository}</strong><p role="status">{active?.message??'Checking the original preparation…'}</p>{active?.state==='ready'&&<button type="button" className="primary" onClick={()=>choose(active)}>Use this repository</button>}{!active&&<button type="button" disabled={busy} onClick={()=>void prepare()}>Reconcile preparation</button>}{active&&['failed','unknown'].includes(active.state)&&<button type="button" onClick={()=>{saveLocal(key,null);setPending(undefined);}}>Choose another checkout</button>}</div></div>}
    {checkouts.some(c=>c.state==='ready')&&<details><summary>Prepared repositories</summary>{checkouts.filter(c=>c.state==='ready').map(c=><div className="section-heading" key={c.id}><div><strong>{c.repository.fullName}</strong><p className="metadata">{c.branch}</p></div><button type="button" onClick={()=>choose(c)}>Use</button></div>)}</details>}
    {error&&<p role="alert" className="field-error">{error}</p>}
  </div>;
}
