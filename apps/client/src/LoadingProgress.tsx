import { useRef } from 'react';

export function LoadingProgress({ percent, label, paused = false }: { percent?: number; label: string; paused?: boolean }) {
  const reached = useRef(0);
  if (percent !== undefined) reached.current = Math.max(reached.current, percent);
  const shown = percent === undefined && reached.current === 0 ? undefined : reached.current;
  return <div className={`startup-progress${shown === undefined && !paused ? ' is-indeterminate' : ''}`}>
    <div className="startup-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown} aria-valuetext={paused ? 'Waiting to reconnect' : shown === undefined ? 'Loading' : `${shown}%`}>
      <span className="startup-fill" style={{ width: shown === undefined ? '100%' : `${shown}%` }}/>
    </div>
    {shown !== undefined && <p className="startup-percent" aria-hidden="true">{shown}%</p>}
  </div>;
}
