import { useRef } from 'react';
import { formatBytes, type DownloadProgress } from './download-progress';
import { playfulStartupSubtitle, workspaceLoadingPercent } from './loading-progress';
import { LoadingProgress } from './LoadingProgress';

export function StartupScreen({ download, complete = false, error, reconnect }: { phase?: 'connecting' | 'session' | 'workspace'; download?: DownloadProgress; complete?: boolean; error?: string; reconnect?: () => void }) {
  const percent = workspaceLoadingPercent(download, complete);
  const reached = useRef(0);
  reached.current = Math.max(reached.current, percent ?? 0);
  return <main className="startup startup-screen" aria-labelledby="startup-title">
    <img className="startup-logo" src="/icons/nova-dream-brand-192-v2.png" alt="Nova Dream logo" width="112" height="112"/>
    <div className="startup-copy"><h1 id="startup-title">Nova Dream</h1><p role={error ? 'alert' : 'status'}>{error || playfulStartupSubtitle(reached.current)}</p></div>
    <div className="startup-meter">
      <LoadingProgress percent={percent} label="Nova Dream loading" paused={!!error}/>
      {download && !download.cached && !complete && <p className="startup-amount">{formatBytes(download.loadedBytes)}{download.totalBytes ? ` of ${formatBytes(download.totalBytes)}` : ' received'}</p>}
    </div>
    {error && reconnect && <button className="primary" onClick={reconnect}>Reconnect</button>}
  </main>;
}
