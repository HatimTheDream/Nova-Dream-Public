import { useEffect, useMemo, useRef, useState } from 'react';
import { approachValue, pacedPercent, paceTotalMs } from './loading-progress';

// The bar moves continuously from 0 to 100: real progress always leads, and
// during stalls a history-paced floor keeps the bar creeping instead of
// freezing. One exponential approach smooths both jumps and creep into a
// single steady motion; the display never moves backward.
function useSteadyPercent(target: number | undefined, timingKey: string | undefined, complete: boolean, paused: boolean): number | undefined {
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);
  const realRef = useRef(0);
  if (target !== undefined) realRef.current = Math.max(realRef.current, target);
  const hasTarget = target !== undefined;
  const pace = useMemo(() => paceTotalMs(timingKey), [timingKey]);
  const startRef = useRef(0);
  if (startRef.current === 0) startRef.current = performance.now();
  const reduceMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  useEffect(() => {
    if (!hasTarget) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = now - last; last = now;
      const real = realRef.current;
      // The paced floor runs only while work is outstanding, unpaused, and
      // motion is welcome. It never claims near-completion before the real
      // thing: the cap reserves the finish for actual completion.
      const floor = !complete && !paused && !reduceMotion
        ? Math.max(real, pacedPercent(now - startRef.current, pace))
        : real;
      const goal = complete ? 100 : floor;
      const next = reduceMotion ? goal : approachValue(shownRef.current, goal, dt);
      if (next !== shownRef.current) { shownRef.current = next; setShown(next); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hasTarget, pace, complete, paused, reduceMotion]);
  return hasTarget ? shown : undefined;
}

export function LoadingProgress({ percent, label, paused = false, timingKey, complete = false }: { percent?: number; label: string; paused?: boolean; timingKey?: string; complete?: boolean }) {
  const steady = useSteadyPercent(percent, timingKey, complete, paused);
  const shown = steady === undefined ? undefined : Math.round(steady);
  return <div className={`startup-progress${shown === undefined && !paused ? ' is-indeterminate' : ''}`}>
    <div className="startup-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown} aria-valuetext={paused ? 'Waiting to reconnect' : shown === undefined ? 'Loading' : `${shown}%`}>
      <span className="startup-fill" style={{ width: steady === undefined ? '100%' : `${steady}%` }}/>
    </div>
    {shown !== undefined && <p className="startup-percent" aria-hidden="true">{shown}%</p>}
  </div>;
}
