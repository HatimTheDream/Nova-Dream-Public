import { useEffect, useState } from 'react';
import type { UsageState } from '../../../packages/domain/usage';
import type { ChatGptAccountStatus } from '../../../packages/domain/sign-in';
import { request } from './api';
import { RefreshCw } from './icons';
import { AllowanceWindows, ChatGptAccountAllowances } from './ChatGptAccounts';
import { accountTime } from './chatgpt-account-controls';

const count = (value: number | null | undefined) => value == null ? 'Unavailable' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
function ProviderAllowances({ usage, stale }: { usage?: UsageState; stale: boolean }) {
  return <>
    {usage?.state === 'unavailable' && <p className="settings-empty">Provider Limits Unavailable</p>}
    {usage?.state === 'refreshing' && <p role="status">Refreshing Provider Figures…</p>}
    {usage?.state === 'ready' && !usage.providers.length && <p className="settings-empty">No Provider Allowance Figures Reported</p>}
    {usage?.providers.map((provider, index) => <div className="usage-provider" key={provider.provider + index}>
      <div className="section-heading"><h3>{provider.name}</h3>{provider.plan && <span className="status-pill">{provider.plan}</span>}</div>
      {provider.unavailable ? <p className="metadata">Allowance Unavailable</p> : <>
        {!provider.windows.length && <p className="metadata">No Allowance Windows Reported</p>}
        <AllowanceWindows windows={provider.windows} label={provider.name}/>
        {provider.credits !== null && <p className="metadata">{new Intl.NumberFormat().format(provider.credits)} Credits Available</p>}
      </>}
    </div>)}
    {usage && <p className="settings-footnote">{stale ? 'Last Known · ' : ''}{usage.reportedAt ? 'Reported ' + accountTime(usage.reportedAt) : 'Checked ' + accountTime(usage.checkedAt)}</p>}
  </>;
}

export function UsageSettings({ identity, active, online }: { identity: string; active: boolean; online: boolean }) {
  const [usage, setUsage] = useState<UsageState>(), [account, setAccount] = useState<ChatGptAccountStatus>();
  const [busy, setBusy] = useState(false), [usageError, setUsageError] = useState(false), [accountError, setAccountError] = useState(false), [refresh, setRefresh] = useState(0);
  // Returning from Connections must not attribute the previous host's readings to a new host.
  useEffect(() => { setUsage(undefined); setAccount(undefined); setUsageError(false); setAccountError(false); }, [identity, active]);
  useEffect(() => {
    if (!active || !online) { setBusy(false); return; }
    let alive = true, reading = false, first = true;
    const abort = new AbortController();
    const load = async () => {
      if (reading) return;
      reading = true; setBusy(true);
      const accountPath = first && refresh > 0 ? 'assistant/account?refresh=1' : 'assistant/account'; first = false;
      const [u, a] = await Promise.allSettled([request<UsageState>('assistant/usage', undefined, abort.signal), request<ChatGptAccountStatus>(accountPath, undefined, abort.signal)]);
      if (alive) {
        if (u.status === 'fulfilled') setUsage(u.value); setUsageError(u.status === 'rejected');
        if (a.status === 'fulfilled') setAccount(a.value); setAccountError(a.status === 'rejected');
        setBusy(false);
      }
      reading = false;
    };
    void load(); const timer = setInterval(() => void load(), 60000);
    return () => { alive = false; clearInterval(timer); abort.abort(); };
  }, [identity, active, online, refresh]);
  const individual = !!account?.accounts?.length;
  return <>
    <section className="card settings-card usage-overview"><div className="section-heading"><h2>AI Allowance</h2><button aria-label="Refresh usage" disabled={busy || !online} onClick={() => setRefresh(n => n + 1)}><RefreshCw size={16}/><span>{busy ? 'Checking…' : 'Refresh'}</span></button></div>
      {!online && <p className="notice" role="status">You’re offline. Connect to refresh usage.</p>}
      {accountError && <p className="notice" role="status">Account allowances could not be refreshed.</p>}
      {!account && !usage && busy && <p role="status">Checking Account Allowances…</p>}
      {individual ? <ChatGptAccountAllowances status={account!} stale={accountError || !online}/> : <ProviderAllowances usage={usage} stale={usageError || !online}/>}
      {individual && <details className="settings-details"><summary>Provider Totals</summary><p className="metadata">Reported by the runtime. These figures are not attributed to an individual saved account and may include activity outside Nova.</p><ProviderAllowances usage={usage} stale={usageError || !online}/></details>}
      {usageError && <p className="metadata" role="status">Provider totals could not be refreshed.</p>}
      {!individual && account && <p className="settings-footnote">{account.emails.length ? account.emails.join(', ') : account.profileCount ? account.profileCount + ' Saved Accounts' : 'No Account Connected'} · Provider totals are not attributed to individual accounts.</p>}
    </section>
    <section className="card settings-card"><h2>Recent Activity</h2><p>Recorded by your Assistant host · last 7 days, UTC.</p>
      {(usageError || !online) && usage && <p className="metadata">Last Known Activity</p>}
      {usage && usage.activity.status !== 'unavailable' && <div className="usage-metrics">{([['Total Tokens', usage.activity.tokens], ['Input', usage.activity.input], ['Output', usage.activity.output]] as const).map(([label, value]) => <div key={label}><span>{label}</span><strong className={value === null ? 'usage-missing' : undefined}>{count(value)}</strong></div>)}</div>}
      {usage?.activity.status === 'partial' && <p className="notice">Recent activity is still updating. These totals may be incomplete.</p>}
      {usage?.activity.status === 'unavailable' && <p className="metadata">Activity totals are unavailable from this connection.</p>}
      {!!usage?.activity.daily.length && <details className="settings-details"><summary>Daily Breakdown</summary><dl className="usage-days">{usage.activity.daily.map(day => <div key={day.date}><dt>{new Date(day.date + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</dt><dd>{count(day.tokens)} Tokens</dd></div>)}</dl><p className="metadata">Cached Input: {count(usage.activity.cacheRead)} Tokens</p></details>}
      <p className="settings-footnote">Token counts are activity measurements, not a bill or your subscription allowance.</p>
    </section>
  </>;
}
