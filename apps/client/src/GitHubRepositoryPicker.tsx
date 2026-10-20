import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubRepository, WorkCheckout } from '../../../packages/domain/work-repositories';
import { request } from './api';
import { GitHubConnection } from './GitHubConnection';
import './work-tools.css';
import { validGitBranch, validGitHubName } from '../../../packages/domain/work-input';
import { CheckoutRequestOwner, checkoutList, sameCheckout, type CheckoutRequest } from './work-checkout-client';

export function RepositoryResults({ repositories, query, state, selectedId, disabled, onChoose, clearQuery, retry }: { repositories: GitHubRepository[]; query: string; state: 'idle' | 'loading' | 'ready' | 'error'; selectedId?: number; disabled: boolean; onChoose: (repository: GitHubRepository) => void; clearQuery: () => void; retry: () => void }) {
  const matches = repositories.filter(repository => repository.fullName.toLowerCase().includes(query.trim().toLowerCase()));
  return <><div className="repository-list" aria-busy={state === 'loading'}>{matches.map(repo => <button type="button" key={repo.id} aria-pressed={selectedId === repo.id} disabled={disabled || repo.archived} onClick={() => onChoose(repo)}><strong>{repo.fullName}</strong><small>{repo.private ? 'Private' : 'Public'} · {repo.archived ? 'Archived' : repo.canPush ? 'Read & write' : 'Read only'}</small></button>)}</div>
    {state === 'loading' && <p role="status">Loading repositories…</p>}
    {state === 'ready' && !matches.length && <div role="status"><p>{repositories.length && query.trim() ? 'No loaded repositories match your search.' : 'No accessible repositories found.'}</p>{query.trim() && repositories.length > 0 && <button type="button" onClick={clearQuery}>Clear repository search</button>}</div>}
    {state === 'error' && <button type="button" disabled={disabled} onClick={retry}>Retry loading repositories</button>}
  </>;
}
export function GitHubRepositoryPicker({epoch,deviceId,projectId,onSelect}:{epoch:string;deviceId:string;projectId:string;onSelect:(checkout:WorkCheckout)=>boolean}){
  const key=`e3:work-checkout:${epoch}:${deviceId}:${projectId}`;
  const scope=useRef(key); scope.current=key;
  const retained=useRef<CheckoutRequestOwner|undefined>(undefined);
  const changed=!!retained.current&&retained.current.key!==key;
  if(changed)retained.current!.retire();
  if(!retained.current||changed)retained.current=new CheckoutRequestOwner(key,epoch,()=>scope.current===key);
  const owner=retained.current;
  const [repositories,setRepositories]=useState<GitHubRepository[]>([]),[nextPage,setNextPage]=useState<number|null>(1),[query,setQuery]=useState(''),[repository,setRepository]=useState<GitHubRepository>(),[branches,setBranches]=useState<string[]>([]),[branch,setBranch]=useState(''),[branchPage,setBranchPage]=useState<number|null>(null),[checkouts,setCheckouts]=useState<WorkCheckout[]>([]),[,setPending]=useState<CheckoutRequest|undefined>(()=>owner.pending),[busy,setBusy]=useState(false),[error,setError]=useState(owner.error);
  const branchOwner=useRef(''),branchRequest=useRef(0),repositoryRequest=useRef(0),acting=useRef(false);
  const [repositoryState,setRepositoryState]=useState<'idle'|'loading'|'ready'|'error'>('idle');
  // Scope changes retire old callbacks during render, before effects or new interaction.
  if(changed){setRepositories([]);setNextPage(1);setQuery('');setRepository(undefined);setBranches([]);setBranch('');setBranchPage(null);setCheckouts([]);setPending(owner.pending);setBusy(false);setError(owner.error);setRepositoryState('idle');acting.current=false;branchOwner.current='';}
  const pending=owner.pending;
  const failed=(e:unknown)=>setError(e instanceof Error?e.message:'The original checkout request is kept.');
  useEffect(()=>{owner.activate();return()=>owner.retire();},[owner]);
  const load=useCallback(async(page=1)=>{
    if(!owner.current())return;const lifetime=owner.ticket(),ticket=++repositoryRequest.current;
    setRepositoryState('loading');setError('');
    try{const result=await request<{items:GitHubRepository[];nextPage:number|null}>(`work/repositories?page=${page}`);if(!owner.current(lifetime)||ticket!==repositoryRequest.current)return;setRepositories(old=>page===1?result.items:[...old,...result.items]);setNextPage(result.nextPage);setRepositoryState('ready');}
    catch(e){if(owner.current(lifetime)&&ticket===repositoryRequest.current){setRepositoryState('error');failed(e);}}
  },[owner]);
  const connected=useCallback(()=>{if(owner.current())void load();},[owner,load]);
  const loadBranches=async(repo:GitHubRepository,page=1)=>{
    if(!owner.current())return;const lifetime=owner.ticket(),ticket=++branchRequest.current;branchOwner.current=repo.fullName;setError('');
    try{const result=await request<{items:{name:string}[];nextPage:number|null}>(`work/branches?repository=${encodeURIComponent(repo.fullName)}&page=${page}`);if(!owner.current(lifetime)||ticket!==branchRequest.current||branchOwner.current!==repo.fullName)return;setBranches(old=>page===1?result.items.map(b=>b.name):[...old,...result.items.map(b=>b.name)]);setBranchPage(result.nextPage);}
    catch(e){if(owner.current(lifetime)&&ticket===branchRequest.current)failed(e);}
  };
  useEffect(()=>{
    const abort=new AbortController(),lifetime=owner.ticket();let poll=0;
    const read=()=>{const ticket=++poll;return request<unknown>('work/state',undefined,abort.signal).then(state=>{if(!abort.signal.aborted&&owner.current(lifetime)&&ticket===poll){const rows=checkoutList(state);owner.observe(rows);setCheckouts(rows);}}).catch(e=>{if(!abort.signal.aborted&&owner.current(lifetime)&&ticket===poll)failed(e);});};
    void read();const timer=setInterval(()=>void read(),pending?1800:12000);return()=>{abort.abort();clearInterval(timer);};
  },[owner,pending?.requestId]);
  const active=owner.known;
  const observed=pending&&checkouts.find(c=>c.operationId===pending.requestId&&c.repository.fullName===pending.repository);
  const choose=async(checkout:WorkCheckout)=>{
    if(!owner.current()||acting.current)return;
    const lifetime=owner.ticket();acting.current=true;setBusy(true);setError('');
    try{
      owner.check();
      if(owner.pending&&(!owner.known||!sameCheckout(owner.known,checkout)))throw Error('Reconcile and use the original checkout before choosing another prepared repository.');
      const rows=checkoutList(await request<unknown>('work/state'));
      if(!owner.current(lifetime))return;
      const current=rows.find(c=>sameCheckout(c,checkout));
      if(!current||current.state!=='ready')throw Error('This checkout is not currently ready. Its original request is kept.');
      if(owner.pending){const original=owner.originalStatus(rows);owner.clearCompleted(original,'ready');setPending(undefined);}else owner.empty();
      // Clearing an already completed request precedes the parent's own retention guard.
      // If that guard refuses, the genuine prepared checkout remains available for retry.
      if(!owner.current(lifetime))return;
      if(!onSelect(current))setError('Free browser storage before selecting this repository. The prepared checkout remains available.');
    }catch(e){if(owner.current(lifetime))failed(e);}finally{if(owner.current(lifetime)){acting.current=false;setBusy(false);}}
  };
  const retireFailed=async()=>{
    if(!owner.current()||acting.current)return;const lifetime=owner.ticket();acting.current=true;setBusy(true);setError('');
    try{owner.check();const rows=checkoutList(await request<unknown>('work/state'));if(!owner.current(lifetime))return;owner.clearCompleted(owner.originalStatus(rows),'failed');setPending(undefined);}
    catch(e){if(owner.current(lifetime))failed(e);}finally{if(owner.current(lifetime)){acting.current=false;setBusy(false);}}
  };
  const prepare=async()=>{
    if(!owner.current()||acting.current)return;
    if(!owner.pending&&(!repository||!branch))return;
    const command=owner.pending??{requestId:crypto.randomUUID(),epoch,repository:repository!.fullName,baseBranch:branch};
    if(!owner.pending&&(!validGitHubName(command.repository)||!validGitBranch(command.baseBranch))){setError('Choose a supported repository and branch (200 characters maximum).');return;}
    const lifetime=owner.ticket();acting.current=true;setBusy(true);setError('');
    try{
      owner.retain(command);setPending(owner.pending);
      // A known response needs only a local ownership retry and read-only status refresh.
      if(owner.known){const rows=checkoutList(await request<unknown>('work/state'));if(!owner.current(lifetime))return;owner.originalStatus(rows);setCheckouts(rows);return;}
      const result=await request<unknown>('work/checkout',command,undefined,30000);
      if(!owner.current(lifetime))return;
      const c=owner.accept(command,result);setCheckouts(old=>[c,...old.filter(item=>item.id!==c.id)]);
    }catch(e){if(owner.current(lifetime)){setPending(owner.pending);failed(e);}}finally{if(owner.current(lifetime)){acting.current=false;setBusy(false);}}
  };
  return <div className="github-picker"><GitHubConnection key={key} epoch={epoch} onConnected={connected}/>
    <p className="metadata">Repositories run on Nova’s host. You can use them from your phone without a linked desktop.</p>
    {!pending&&!owner.error&&<><label>Find a repository<input type="search" value={query} onChange={e=>{if(owner.current())setQuery(e.target.value);}} placeholder="Filter loaded repositories"/></label><RepositoryResults repositories={repositories} query={query} state={repositoryState} selectedId={repository?.id} disabled={busy} clearQuery={()=>{if(owner.current())setQuery('');}} retry={()=>void load()} onChoose={repo=>{if(!owner.current()||acting.current)return;try{owner.empty();setRepository(repo);setBranch(repo.defaultBranch);setBranches([repo.defaultBranch]);setBranchPage(null);void loadBranches(repo);}catch(e){failed(e);}}}/>{nextPage&&repositories.length>0&&<button type="button" disabled={busy} onClick={()=>void load(nextPage)}>Load more repositories</button>}
    {repository&&<div className="work-branch-picker"><label>Start from branch<select value={branch} disabled={busy} onChange={e=>{if(owner.current())setBranch(e.target.value);}}>{[...new Set([repository.defaultBranch,...branches])].map(b=><option key={b}>{b}</option>)}</select></label>{branchPage&&<button type="button" disabled={busy} onClick={()=>void loadBranches(repository,branchPage)}>More branches</button>}<button type="button" className="primary" disabled={busy||!branch} onClick={()=>void prepare()}>Prepare on host</button><p className="metadata">Creates a separate Nova feature branch. The original branch stays available.</p></div>}</>}
    {pending&&<div className="notice"><div><strong>{pending.repository}</strong><p className="metadata">Original branch: {pending.baseBranch}</p><p role="status">{active?.message??observed?.message??'The original preparation is kept.'}</p>{active?.state==='ready'&&<button type="button" className="primary" disabled={busy} onClick={()=>void choose(active)}>Use this repository</button>}{(!active||active.state==='preparing'||active.state==='unknown')&&<button type="button" disabled={busy} onClick={()=>void prepare()}>{active?'Refresh original status':'Reconcile preparation'}</button>}{active?.state==='failed'&&<button type="button" disabled={busy} onClick={()=>void retireFailed()}>Choose another checkout</button>}{(!active||active.state==='unknown')&&<p className="metadata">Keep this request until its original result is verified. An unknown preparation cannot be replaced.</p>}</div></div>}
    {checkouts.some(c=>c.state==='ready')&&<details><summary>Prepared repositories</summary>{checkouts.filter(c=>c.state==='ready').map(c=><div className="section-heading" key={c.id}><div><strong>{c.repository.fullName}</strong><p className="metadata">{c.branch}</p></div><button type="button" disabled={busy||!!pending} onClick={()=>void choose(c)}>Use</button></div>)}</details>}
    {owner.error&&<button type="button" disabled={busy} onClick={()=>{if(!owner.current())return;try{owner.read();setPending(owner.pending);setError(owner.error);}catch(e){failed(e);}}}>Read kept request again</button>}
    {error&&<p role="alert" className="field-error">{error}</p>}
  </div>;
}
