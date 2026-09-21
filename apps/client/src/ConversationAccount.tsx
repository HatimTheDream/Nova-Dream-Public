import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../../../packages/domain/assistant';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { ChatGptAccountStatus } from '../../../packages/domain/sign-in';
import { request } from './api';
import { RefreshReader } from './refresh-reader';
import { accountHealth, accountOrder, allowanceLabel, remainingAllowance } from './chatgpt-account-controls';
import './chatgpt-accounts.css';

export function ConversationAccountSelect({ status, conversation, blocked, stale = false, onChange }: { status?: ChatGptAccountStatus; conversation?: Conversation; blocked: boolean; stale?: boolean; onChange: (profileId: string | null) => void }) {
  const selected = conversation?.preferredAccountId ?? '';
  const accounts = accountOrder(status).map(id => status!.accounts!.find(account => account.profileId === id)!).filter(account => !account.duplicateOf || account.profileId === selected);
  const actual = conversation?.accountSelection;
  return <div className="conversation-account">
    <select aria-label="ChatGPT Account" title="Account For The Next Message" value={selected} disabled={blocked || stale || !conversation || !status?.accounts || status.state === 'unavailable'} onChange={event => onChange(event.target.value || null)}>
      <option value="">Default Account</option>
      {selected && !accounts.some(account => account.profileId === selected) && <option value={selected} disabled>{actual?.profileId === selected && actual.label || 'Saved Account'} · Unavailable</option>}
      {accounts.map(account => <option key={account.profileId} value={account.profileId} disabled={account.health !== 'ready' || !!account.duplicateOf}>{account.label}{account.duplicateOf ? ' · Shared Allowance' : account.health !== 'ready' ? ` · ${accountHealth(account.health)}` : ''}</option>)}
    </select>
    {actual && <span className="metadata" title="Account Selected For The Latest Reply">{actual.reason === 'backup' ? 'Backup Selected' : 'Selected'}: {actual.label ?? 'Saved Account'}</span>}
    {stale && <span className="metadata" role="status">Account Status Unavailable</span>}
  </div>;
}

export function useConversationAccount({ snapshot, conversation, blocked, onChange }: { snapshot: Snapshot; conversation?: Conversation; blocked: boolean; onChange: (profileId: string | null) => Promise<void> }) {
  const identity = `${snapshot.epoch}:${snapshot.deviceId}:${conversation?.id ?? ''}`;
  const context = useRef(identity); context.current = identity;
  const [status, setStatus] = useState<ChatGptAccountStatus>(), [stale, setStale] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [reader] = useState(() => new RefreshReader({ identity: () => context.current, read: signal => request<ChatGptAccountStatus>('assistant/account', undefined, signal), accept: value => { setStatus(value); setStale(false); }, fail: () => setStale(true) }));
  useEffect(() => {
    setStatus(undefined); setStale(false); setBusy(false); setError('');
    if (!conversation) return;
    void reader.refresh(); const timer = setInterval(() => void reader.poll(), 30000);
    return () => { clearInterval(timer); reader.cancel(); };
  }, [identity, reader]);
  const change = async (profileId: string | null) => {
    setBusy(true); setError('');
    try { await onChange(profileId); }
    catch (reason) { if (context.current === identity) setError(reason instanceof Error ? reason.message : 'Account selection could not be confirmed.'); }
    finally { if (context.current === identity) setBusy(false); }
  };
  return { status, conversation, blocked: blocked || busy, stale, error, onChange: (profileId: string | null) => void change(profileId) };
}

export function ConversationAccountPanel(props: ReturnType<typeof useConversationAccount>) {
  return <div className="conversation-account-panel">
    <span className="menu-heading">ChatGPT Account</span>
    <ConversationAccountSelect {...props}/>
    <div className="conversation-account-usage">{accountOrder(props.status).map(id => {
      const account = props.status!.accounts!.find(value => value.profileId === id)!;
      if (account.duplicateOf) return null;
      const usage = account.usage;
      return <div key={id}><strong>{account.label}</strong><span>{account.health !== 'ready' ? `${accountHealth(account.health)} · ` : ''}{props.stale || usage.state === 'stale' ? 'Last Known · ' : ''}{usage.state === 'unavailable' || !usage.windows.length ? 'Allowance Unavailable' : usage.windows.map(window => {
        const left = remainingAllowance(window.usedPercent);
        return `${allowanceLabel(window.label)}: ${left === null ? 'Unavailable' : `${Math.round(left)}% Left`}`;
      }).join(' · ')}</span></div>;
    })}</div>
    {props.error && <p className="field-error" role="alert">{props.error}</p>}
  </div>;
}
