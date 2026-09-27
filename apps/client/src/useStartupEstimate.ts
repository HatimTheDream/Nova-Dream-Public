import { useEffect, useRef, useState } from 'react';
import { readLocal, saveLocal } from './api';
import { StartupClock, softenEstimate, startupHistory, startupRemaining, startupWaitLabel } from './startup-estimate';

export function useStartupEstimate(percent: number, complete: boolean, error: boolean, timingKey?: string, remember = true) {
  const [clock] = useState(() => new StartupClock(performance.now()));
  const [now, setNow] = useState(() => performance.now());
  const [history, setHistory] = useState(() => startupHistory(timingKey ? readLocal(timingKey) : undefined, Date.now()));
  const saved = useRef(false), previousKey = useRef(timingKey);
  const shown = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (previousKey.current && previousKey.current !== timingKey) clock.interrupt();
    previousKey.current = timingKey;
    shown.current = undefined;
    setHistory(startupHistory(timingKey ? readLocal(timingKey) : undefined, Date.now()));
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
  const raw = startupRemaining(clock.points, clock.elapsed(now), history);
  // Never blank a shown estimate mid-load: when progress stalls long enough
  // that the math runs out of things to say, a frozen estimate still tells
  // the owner the app is working, while a vanished one looks broken.
  if (raw !== undefined) shown.current = softenEstimate(shown.current, raw);
  return startupWaitLabel(shown.current, complete);
}
