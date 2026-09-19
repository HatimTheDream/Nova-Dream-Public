import { useRef } from 'react';
import type { AppIconChoice } from '../../../packages/domain/contracts';
import { NovaAppMark, useAppIcon } from './AppIcon';
import { readCachedAppIcon } from './app-icon';
import { type DownloadProgress } from './download-progress';
import { playfulStartupSubtitle, workspaceLoadingPercent } from './loading-progress';
import { LoadingProgress } from './LoadingProgress';
import { useStartupEstimate } from './useStartupEstimate';

export function StartupScreen({ appIcon = readCachedAppIcon(), download, complete = false, preparation, error, reconnect, timingKey, rememberTiming = true }: { appIcon?: AppIconChoice; phase?: 'connecting' | 'session' | 'workspace'; download?: DownloadProgress; complete?: boolean; preparation?: number; error?: string; reconnect?: () => void; timingKey?: string; rememberTiming?: boolean }) {
  const choice = useAppIcon(appIcon);
  const percent = workspaceLoadingPercent(download, complete, preparation);
  const reached = useRef(0);
  reached.current = Math.max(reached.current, percent ?? 0);
  const estimate = useStartupEstimate(reached.current, complete, !!error, timingKey, rememberTiming);
  return <main className="startup startup-screen" aria-labelledby="startup-title">
    <NovaAppMark choice={choice} className="startup-logo" alt="Nova Dream logo" width="112" height="112"/>
    <div className="startup-copy"><h1 id="startup-title">Nova Dream</h1><p role={error ? 'alert' : 'status'}>{error || playfulStartupSubtitle(reached.current)}</p></div>
    <div className="startup-meter">
      <LoadingProgress percent={percent} label="Nova Dream loading" paused={!!error}/>
      {!error && <p className="startup-estimate" aria-label="Estimated time remaining">{estimate}</p>}
    </div>
    {error && reconnect && <button className="primary" onClick={reconnect}>Reconnect</button>}
  </main>;
}
