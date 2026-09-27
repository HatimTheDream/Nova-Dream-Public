import { useEffect, useMemo, useRef, useState } from 'react';
import { readLocal, saveLocal } from './api';
import { paceInfo } from './loading-progress';
import { StartupClock, startupHistory, startupWaitLabel } from './startup-estimate';

export function useStartupEstimate(percent: number, complete: boolean, error: boolean, timingKey?: string, remember = true) {
  const [clock] = useState(() => new StartupClock(performance.now()));
  const [now, setNow] = useState(() => performance.now());
  const saved = useRef(false), previousKey = useRef(timingKey);
  useEffect(() => {
    // A new key means a new run: don't let the old run's points pollute it.
    if (previousKey.current && previousKey.current !== timingKey) clock.interrupt();
    previousKey.current = timingKey;
  }, [clock, timingKey]);
  useEffect(() => {
    const tick = () => setNow(performance.now());
    const hide = () => { if (document.hidden) clock.interrupt(); };
    hide(); document.addEventListener('visibilitychange', hide);
    const interval = window.setInterval(tick, 1_000);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', hide); };
  }, [clock]);
  useEffect(() => {
    const current = performance.now();
    if (error || complete && !remember) clock.interrupt();
    clock.observe(percent, current); setNow(current);
    if (complete && !saved.current && timingKey) {
      saved.current = true;
      const sample = clock.finish(current, Date.now());
      if (sample) saveLocal(timingKey, [...startupHistory(readLocal(timingKey), Date.now()), sample].slice(-5));
    }
  }, [clock, percent, complete, error, timingKey, remember]);
  // The estimate counts down the same historical pace the bar follows, so the
  // two never disagree. Past the expected finish the app is nearly there by
  // construction (the bar parks at 95), so say so instead of going silent.
  const pace = useMemo(() => paceInfo(timingKey), [timingKey]);
  if (error || complete) return '';
  const remaining = pace.totalMs - clock.elapsed(now);
  return remaining > 0 ? startupWaitLabel(remaining, false) : 'almost there';
}
