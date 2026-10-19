import { useEffect, useState } from 'react';

/** Refresh day-based views at the minute boundary and immediately after resume. */
export function usePlanningClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      timer = setTimeout(refresh, 60_000 - current % 60_000);
    };
    const visible = () => { if (!document.hidden) refresh(); };
    refresh();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, []);
  return now;
}
