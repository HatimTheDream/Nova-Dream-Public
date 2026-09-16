import { useEffect, useState } from 'react';
import type { AccountsState } from '../../../packages/domain/accounts';
import { request } from './api';
import { Inbox, CalendarDays, ArrowRight } from './icons';

export function AccountSetup({ calendar = false, openSettings }: { calendar?: boolean; openSettings: () => void }) {
  const Icon = calendar ? CalendarDays : Inbox;
  return <section className={`account-setup${calendar ? ' account-setup-inline' : ''}`} aria-label={calendar ? 'Connect calendars' : 'Connect your inbox'}>
    <div className="account-setup-mark"><Icon size={calendar ? 24 : 36}/></div>
    <div><h2>{calendar ? 'Bring your calendars together' : 'Your mail, in one place'}</h2><p>{calendar ? 'Connect Google or Microsoft. Your local schedule is ready to use.' : 'Connect Google or Microsoft to read and organize your mail here.'}</p></div>
    <button className={calendar ? '' : 'primary'} onClick={openSettings}>Connect accounts<ArrowRight size={18}/></button>
  </section>;
}

export function CalendarAccountSetup({ openSettings }: { openSettings: () => void }) {
  const [state, setState] = useState<AccountsState>();
  useEffect(() => { const abort = new AbortController(); void request<AccountsState>('accounts', undefined, abort.signal).then(setState).catch(() => {}); return () => abort.abort(); }, []);
  if (!state || state.accounts.some(account => account.state !== 'disconnected' && account.capabilities.calendarRead)) return null;
  return <AccountSetup calendar openSettings={openSettings}/>;
}
