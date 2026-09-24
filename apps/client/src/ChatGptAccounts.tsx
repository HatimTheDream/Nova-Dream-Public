import type { ChatGptAccountStatus } from '../../../packages/domain/sign-in';
import type { UsageWindow } from '../../../packages/domain/usage';
import { ArrowDown, ArrowUp } from './icons';
import { accountHealth, accountOrder, accountTime, allowanceLabel, moveAccount, remainingAllowance } from './chatgpt-account-controls';
import './chatgpt-accounts.css';

export function AllowanceWindows({ windows, label }: { windows: UsageWindow[]; label: string }) {
  return <div className="usage-windows">{windows.map((window, index) => {
    const left = remainingAllowance(window.usedPercent), title = allowanceLabel(window.label);
    return <div className={`usage-window ${left !== null && left <= 10 ? 'usage-low' : ''}`} key={`${window.label}:${index}`}>
      <div className="usage-window-label"><span>{title}</span><strong>{left === null ? 'Unavailable' : `${Math.round(left)}% Left`}</strong></div>
      {left !== null && <progress aria-label={`${label} · ${title} Remaining`} max={100} value={left}/>}
      <p>{accountTime(window.resetAt) ? `Resets ${accountTime(window.resetAt)}` : 'Reset Time Not Reported'}</p>
    </div>;
  })}</div>;
}

export function ChatGptAccountList({ status, disabled, reconnect, reorder }: { status: ChatGptAccountStatus; disabled: boolean; reconnect: (profileId: string) => void; reorder: (profileIds: string[]) => void }) {
  const order = accountOrder(status);
  return <div className="chatgpt-accounts">{order.map((id, index) => {
    const account = status.accounts!.find(value => value.profileId === id)!;
    const preferred = status.preferredProfileId === id;
    return <details className="chatgpt-account settings-account-row" key={id} aria-label={account.label}>
      <summary><span><strong>{account.label}</strong>{account.email && account.email !== account.label && <span className="metadata">{account.email}</span>}<span className="metadata">{accountHealth(account.health)} · {preferred ? 'Preferred' : status.preferredProfileId ? `Backup ${index || 1}` : 'Account'}{account.health === 'cooldown' && accountTime(account.cooldownUntil) ? ` · Until ${accountTime(account.cooldownUntil)}` : ''}{account.duplicateOf ? ' · Shared allowance' : ''}</span></span><span className="settings-manage-label">Manage</span></summary>
      <div className="setup-actions"><button disabled={disabled} onClick={() => reconnect(id)}>Reconnect</button>
        {!preferred && <button disabled={disabled || !status.canManage} onClick={() => reorder(moveAccount(order, id, 0))}>Make Preferred</button>}
        {order.length > 2 && index > 0 && <span className="chatgpt-order-controls"><button className="icon-button" aria-label={`Move ${account.label} Earlier`} title="Move Earlier" disabled={disabled || !status.canManage || index < 2} onClick={() => reorder(moveAccount(order, id, index - 1))}><ArrowUp size={16}/></button><button className="icon-button" aria-label={`Move ${account.label} Later`} title="Move Later" disabled={disabled || !status.canManage || index === order.length - 1} onClick={() => reorder(moveAccount(order, id, index + 1))}><ArrowDown size={16}/></button></span>}
      </div>
    </details>;
  })}</div>;
}

export function ChatGptAccountAllowances({ status, stale = false }: { status: ChatGptAccountStatus; stale?: boolean }) {
  return <>{accountOrder(status).map(id => {
    const account = status.accounts!.find(value => value.profileId === id)!, usage = account.usage;
    const time = accountTime(usage.reportedAt ?? usage.checkedAt);
    return <section className="usage-provider" key={id} aria-label={`${account.label} Allowance`}>
      <div className="section-heading"><h3>{account.label}</h3>{status.preferredProfileId === id && <span className="status-pill done">Preferred</span>}</div>
      <p className="metadata">{accountHealth(account.health)}{usage.plan ? ` · ${usage.plan}` : ''}</p>
      {account.duplicateOf ? <p className="metadata">Shares An Existing Account Allowance</p> : usage.state === 'unavailable' ? <p className="metadata">Allowance Unavailable</p> : <>
        {usage.windows.length ? <AllowanceWindows windows={usage.windows} label={account.label}/> : <p className="metadata">No Allowance Windows Reported</p>}
        {usage.credits !== null && <p className="metadata">{new Intl.NumberFormat().format(usage.credits)} Credits Available</p>}
      </>}
      <p className="settings-footnote">{stale || usage.state === 'stale' ? 'Last Known · ' : ''}{time ? `${usage.reportedAt ? 'Reported' : 'Checked'} ${time}` : 'No Account Usage Timestamp Reported'}</p>
    </section>;
  })}</>;
}
