import { useCallback, useEffect, useState } from 'react';
import type { GitHubState } from '../../../packages/domain/work-repositories';
import { request } from './api';

export function useGitHub(epoch:string) {
  const [state,setState]=useState<GitHubState>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const refresh=useCallback(async()=>{try{const state=await request<GitHubState>('work/github');setState(state);setError('');}catch(e){setError((e as Error).message);}},[epoch]);
  useEffect(()=>{void refresh();},[refresh]);
  useEffect(()=>{if(!state?.attempt||!['starting','waiting'].includes(state.attempt.state))return;const timer=setInterval(()=>void refresh(),2000);return()=>clearInterval(timer);},[state?.attempt?.state,refresh]);
  const action=async(action:'connect'|'cancel'|'disconnect')=>{setBusy(true);setError('');try{setState(await request<GitHubState>('work/github',{requestId:crypto.randomUUID(),epoch,action}));}catch(e){setError((e as Error).message);void refresh();}finally{setBusy(false);}};
  return {state,error,busy,refresh,action};
}
export function GitHubConnection({epoch,onConnected}:{epoch:string;onConnected?:()=>void}){
  const github=useGitHub(epoch),{state,busy,error}=github;
  useEffect(()=>{if(state?.account)onConnected?.();},[state?.account?.id,onConnected]);
  const waiting=state?.attempt&&['starting','waiting'].includes(state.attempt.state);
  return <section className="github-connection">
    <div className="section-heading"><div><strong>GitHub</strong><p className="metadata">{state?.message??'Checking GitHub connection…'}</p></div>{state?.account?<button type="button" disabled={busy} onClick={()=>void github.action('disconnect')}>Disconnect</button>:!waiting&&<button type="button" disabled={busy||!state?.available} onClick={()=>void github.action('connect')}>Connect GitHub</button>}</div>
    {waiting&&<div className="notice"><div><p>{state!.attempt!.message}</p>{state!.attempt!.code&&<><p><code className="github-device-code">{state!.attempt!.code}</code></p><a href={state!.attempt!.url} target="_blank" rel="noreferrer">Continue on GitHub</a><p className="metadata">GitHub CLI requests repository access. Credentials stay on the workspace host.</p></>}<button type="button" disabled={busy} onClick={()=>void github.action('cancel')}>Cancel sign-in</button></div></div>}
    {!waiting&&state?.attempt?.state==='failed'&&<p role="status" className="metadata">{state.attempt.message}</p>}
    {state&&!state.available&&<p className="metadata"><a href="https://cli.github.com/" target="_blank" rel="noreferrer">GitHub CLI setup</a> · Install it on the computer or server running Nova.</p>}
    {error&&<p role="alert" className="field-error">{error} <button type="button" onClick={()=>void github.refresh()}>Refresh</button></p>}
  </section>;
}
