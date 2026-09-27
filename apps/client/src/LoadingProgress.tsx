import { useEffect, useRef, useState } from 'react';
import { easeOutCubic } from './loading-progress';

// How long the bar takes to sweep toward a newly reported value. Long enough
// to read as motion, short enough that the bar never feels behind the work.
const EASE_MS = 650;

// Eases the displayed percent toward the reported target so coarse phase
// updates sweep instead of jumping. The display only ever moves forward;
// a target below the display snaps (progress is monotonic by construction).
function useEasedPercent(target: number | undefined): number | undefined {
  const [shown, setShown] = useState(target ?? 0);
  const shownRef = useRef(shown);
  useEffect(() => {
    if (target === undefined) return;
    if (target <= shownRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (target !== shownRef.current) { shownRef.current = target; setShown(target); }
      return;
    }
    let raf = 0;
    const from = shownRef.current, started = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / EASE_MS);
      const value = from + (target - from) * easeOutCubic(progress);
      shownRef.current = value;
      setShown(value);
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return target === undefined ? undefined : shown;
}

export function LoadingProgress({ percent, label, paused = false }: { percent?: number; label: string; paused?: boolean }) {
  const reached = useRef(0);
  if (percent !== undefined) reached.current = Math.max(reached.current, percent);
  const target = percent === undefined && reached.current === 0 ? undefined : reached.current;
  const eased = useEasedPercent(target);
  const shown = eased === undefined ? undefined : Math.round(eased);
  return <div className={`startup-progress${shown === undefined && !paused ? ' is-indeterminate' : ''}`}>
    <div className="startup-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown} aria-valuetext={paused ? 'Waiting to reconnect' : shown === undefined ? 'Loading' : `${shown}%`}>
      <span className="startup-fill" style={{ width: eased === undefined ? '100%' : `${eased}%` }}/>
    </div>
    {shown !== undefined && <p className="startup-percent" aria-hidden="true">{shown}%</p>}
  </div>;
}
