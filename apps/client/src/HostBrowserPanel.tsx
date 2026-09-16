import { useEffect, useState } from 'react';
import type { BrowserActionResult, BrowserObservation, HostBrowserState } from '../../../packages/domain/host-browser';
import { readLocal, request, saveLocal } from './api';
import './work-tools.css';
import { workRequestRejected } from './work-request';
export function HostBrowserPanel({epoch,active=true}:{epoch:string;active?:boolean}){
  const key=`e3:host-browser:${epoch}`;
  const [state,setState]=useState<HostBrowserState>(),[observation,setObservation]=useState<BrowserObservation>(),[url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<BrowserActionResult>(),[pending,setPending]=useState<{requestId:string;epoch:string;input:{action:'open';url:string}|{action:'close';targetId:string}}|undefined>(()=>readLocal(key));
  const refresh=async()=>{try{setState(await request<HostBrowserState>('work/browser',undefined,undefined,40000));}catch(e){setError((e as Error).message);}};
  useEffect(()=>{if(!active)return;void refresh();const timer=setInterval(()=>void refresh(),15000);return()=>clearInterval(timer);},[epoch,active]);
  const enable=async(enabled:boolean)=>{setBusy(true);setError('');try{setState(await request<HostBrowserState>('work/browser/configure',{requestId:crypto.randomUUID(),epoch,enabled},undefined,40000));if(!enabled)setObservation(undefined);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const act=async(input:{action:'open';url:string}|{action:'close';targetId:string})=>{
    const cmd=pending??{requestId:crypto.randomUUID(),epoch,input};if(!saveLocal(key,cmd)){setError('Free browser storage before opening this page.');return;}setPending(cmd);setBusy(true);setError('');
    try{const response=await request<BrowserActionResult>('work/browser/action',cmd,undefined,40000);setResult(response);saveLocal(key,null);setPending(undefined);if(cmd.input.action==='close'&&observation?.targetId===cmd.input.targetId)setObservation(undefined);await refresh();}catch(e){if(workRequestRejected(e)){saveLocal(key,null);setPending(undefined);}setError((e as Error).message);}finally{setBusy(false);}
  };
  const observe=async(target:string)=>{setBusy(true);setError('');try{setObservation(await request<BrowserObservation>(`work/browser/observe?target=${encodeURIComponent(target)}`,undefined,undefined,60000));}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="host-browser-panel"><div className="section-heading"><h3>Host browser</h3><button type="button" disabled={busy} onClick={()=>void refresh()}>Refresh</button></div>
    <p className="metadata">{state?.message??'Checking browser availability…'}</p><p className="metadata">Ask Nova to browse or test a website, then inspect its tabs here. A VPS works without your desktop. A local host needs to stay on.</p>
    <button type="button" disabled={busy||!state} onClick={()=>void enable(!state?.enabled)}>{state?.enabled?'Turn browser off':'Enable host browser'}</button>
    {state?.enabled&&<><form className="browser-address" onSubmit={e=>{e.preventDefault();void act({action:'open',url});}}><label>Website address<input type="url" required placeholder="https://example.com" value={url} onChange={e=>setUrl(e.target.value)}/></label><button disabled={busy||!!pending||!url}>Open page</button></form><div className="browser-tabs">{state.tabs.map(tab=><div className="browser-tab-row" key={tab.id}><button type="button" disabled={busy} onClick={()=>void observe(tab.id)}><strong>{tab.title||'Untitled page'}</strong><small>{tab.url}</small></button><button type="button" className="icon-button" aria-label={`Close ${tab.title||'page'}`} disabled={busy||!!pending} onClick={()=>void act({action:'close',targetId:tab.id})}>×</button></div>)}</div></>}
    {pending&&<div className="notice"><div><p>The original browser request is kept.</p><button disabled={busy} onClick={()=>void act(pending.input)}>Check original request</button></div></div>}
    {result&&<p role="status" className="metadata">{result.message}</p>}{busy&&<p role="status" className="metadata">Checking the host browser…</p>}
    {observation&&<div className="browser-observation"><div className="section-heading"><strong>Latest observation</strong><button type="button" disabled={busy} onClick={()=>void observe(observation.targetId)}>Observe again</button></div><p className="metadata">{new Date(observation.at).toLocaleTimeString()} · {observation.url}</p>{observation.image&&<img alt="Observed page in the host browser" src={`data:${observation.image.mimeType};base64,${observation.image.data}`}/>}<details><summary>Readable page & element references</summary><pre>{observation.text}</pre></details></div>}
    {error&&<p role="alert" className="field-error">{error}</p>}
  </section>;
}
