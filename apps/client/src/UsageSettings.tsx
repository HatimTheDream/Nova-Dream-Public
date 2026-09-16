import { useEffect, useState } from 'react';
import type { UsageState } from '../../../packages/domain/usage';
import type { ChatGptAccountStatus } from '../../../packages/domain/sign-in';
import { request } from './api';
import { RefreshCw } from './icons';

const count=(value:number|null|undefined)=>value==null?'Unavailable':new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(value);
const windowLabel=(label:string)=>label==='5h'?'5-hour allowance':label==='7d'||label==='168h'||label==='Week'?'Weekly allowance':label==='24h'?'Daily allowance':label;
export function UsageSettings({active,online}:{active:boolean;online:boolean}){
  const [usage,setUsage]=useState<UsageState>(),[account,setAccount]=useState<ChatGptAccountStatus>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    if(!active||!online)return;let alive=true,reading=false;
    const load=async()=>{if(reading)return;reading=true;setBusy(true);setError('');try{const [u,a]=await Promise.allSettled([request<UsageState>('assistant/usage'),request<ChatGptAccountStatus>('assistant/account')]);if(alive){if(u.status==='rejected')throw u.reason;setUsage(u.value);setAccount(a.status==='fulfilled'?a.value:undefined);}}catch{if(alive)setError('Usage could not be refreshed. Try again when your Assistant is connected.');}finally{reading=false;if(alive)setBusy(false);}};
    void load();const timer=setInterval(()=>void load(),60000);return()=>{alive=false;clearInterval(timer);};
  },[active,online,refresh]);
  const stale=!!error||!online;
  return <>
    <section className="card settings-card usage-overview"><div className="section-heading"><h2>AI allowance</h2><button aria-label="Refresh usage" disabled={busy||!online} onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={16}/><span>{busy?'Checking…':'Refresh'}</span></button></div><p>Limits shared across your provider account.</p>
      {(!online||error)&&<p className="notice" role="status">{!online?'You’re offline. Connect to refresh usage.':error}</p>}
      {!usage&&busy&&<p role="status">Checking provider limits…</p>}
      {usage?.state==='unavailable'&&<p className="settings-empty">Provider limits are unavailable from this connection. Some providers don’t report them.</p>}
      {usage?.state==='refreshing'&&<p role="status">Your provider is refreshing its usage figures.</p>}
      {usage?.state==='ready'&&!usage.providers.length&&<p className="settings-empty">No allowance figures are available from this connection.</p>}
      {usage?.providers.map((provider,index)=><div className="usage-provider" key={provider.provider+index}>
        <div className="section-heading"><h3>{provider.name}</h3>{provider.plan&&<span className="status-pill">{provider.plan}</span>}</div>
        {provider.unavailable?<p className="metadata">Usage is unavailable for this provider. Check its account connection.</p>:<>
          {!provider.windows.length&&<p className="metadata">This provider hasn’t reported an allowance window.</p>}
          <div className="usage-windows">{provider.windows.map((window,index)=>{const left=window.usedPercent===null?null:Math.max(0,100-window.usedPercent);return <div className={`usage-window ${left!==null&&left<=10?'usage-low':''}`} key={window.label+index}>
            <div className="usage-window-label"><span>{windowLabel(window.label)}</span><strong>{left===null?'Unavailable':`${Math.round(left)}% left`}</strong></div>
            {left!==null&&<progress aria-label={`${windowLabel(window.label)} remaining`} max={100} value={left}/>}
            <p>{window.resetAt?`Resets ${new Date(window.resetAt).toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit',month:'short',day:'numeric'})}`:'Reset time not reported'}</p>
          </div>;})}</div>
          {provider.credits!==null&&<p className="metadata">{new Intl.NumberFormat().format(provider.credits)} credits available</p>}
        </>}
      </div>)}
      {usage&&<p className="settings-footnote">{stale?'Last known figures · ':''}{usage.reportedAt?`Provider updated ${new Date(usage.reportedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`:`Checked ${new Date(usage.checkedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`} · Provider figures may include activity outside Nova.</p>}
    </section>
    <section className="card settings-card"><h2>Recent activity</h2><p>Recorded by your Assistant host · last 7 days, UTC.</p>
      {usage && usage.activity.status !== 'unavailable' && <div className="usage-metrics">{([['Total tokens',usage.activity.tokens],['Input',usage.activity.input],['Output',usage.activity.output]] as const).map(([label,value])=><div key={label}><span>{label}</span><strong className={value===null?'usage-missing':undefined}>{count(value)}</strong></div>)}</div>}
      {usage?.activity.status==='partial'&&<p className="notice">Recent activity is still updating. These totals may be incomplete.</p>}
      {usage?.activity.status==='unavailable'&&<p className="metadata">Activity totals are unavailable from this connection.</p>}
      {!!usage?.activity.daily.length&&<details className="settings-details"><summary>Daily breakdown</summary><dl className="usage-days">{usage.activity.daily.map(day=><div key={day.date}><dt>{new Date(day.date+'T12:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'})}</dt><dd>{count(day.tokens)} tokens</dd></div>)}</dl><p className="metadata">Cached input: {count(usage.activity.cacheRead)} tokens.</p></details>}
      <p className="settings-footnote">Token counts are activity measurements, not a bill or your subscription allowance.</p>
    </section>
    <details className="settings-disclosure"><summary>Account details</summary><div className="settings-disclosure-body"><p>{account?.emails.length?account.emails.join(', '):account?.profileCount?`${account.profileCount} saved account(s)`:'No saved account identity reported.'}</p><p className="metadata">These are the accounts saved in Nova’s connection. Provider totals are reported by the runtime; they aren’t attributed to an individual saved profile. Signing into Codex separately does not change this connection.</p></div></details>
  </>;
}
