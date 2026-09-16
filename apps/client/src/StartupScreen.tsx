import { downloadPercent, formatBytes, type DownloadProgress } from './download-progress';
import { inboxStartupView, type InboxStartupProgress } from './inbox-startup-progress';

export function StartupScreen({ phase = 'workspace', download, inbox, error, reconnect }: { phase?: 'connecting' | 'session' | 'workspace'; download?: DownloadProgress; inbox?: InboxStartupProgress; error?: string; reconnect?: () => void }) {
  const preparation = inbox && inboxStartupView(inbox);
  const percent = preparation ? preparation.percent : downloadPercent(download);
  const detail = preparation ? preparation.detail : phase === 'connecting' ? 'Connecting to your workspace…' : phase === 'session' ? 'Opening your session…' : 'Loading your saved work…';
  const amount = preparation ? preparation.amount : download?.cached ? 'Loaded from this device' : download ? `${formatBytes(download.loadedBytes)}${download.totalBytes ? ` of ${formatBytes(download.totalBytes)}` : ' received'}` : 'Waiting for workspace data';
  return <main className="startup startup-screen" aria-labelledby="startup-title">
    <img className="startup-logo" src="/icons/nova-dream-brand-192-v2.png" alt="Nova Dream logo" width="112" height="112"/>
    <div className="startup-copy"><h1 id="startup-title">Nova Dream</h1><p role={error ? 'alert' : 'status'}>{error || detail}</p></div>
    <div className={`startup-progress${percent === undefined && !error ? ' is-indeterminate' : ''}`}>
      <div className="startup-track" role="progressbar" aria-label={inbox ? 'Inbox preparation' : 'Workspace data download'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={error ? 'Waiting to reconnect' : `${percent === undefined ? '' : `${percent}% · `}${amount}`}>
        <span className="startup-fill" style={{ width: percent === undefined ? error ? '0%' : '28%' : `${percent}%` }}/>
      </div>
      <p className="startup-percent" aria-hidden="true">{percent === undefined ? error ? 'Connection paused' : 'Loading…' : `${percent}%`}</p>
      <p className="startup-amount">{amount}</p>
    </div>
    {error && reconnect && <button className="primary" onClick={reconnect}>Reconnect</button>}
  </main>;
}
