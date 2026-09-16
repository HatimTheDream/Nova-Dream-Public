import { useEffect, useState } from 'react';

/** A display clock only. The service and native host still enforce deadlines. */
export function useDeadline(deadline: number, active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!active || deadline <= Date.now()) return;
    const update = () => { setNow(Date.now()); if (Date.now() >= deadline) clearInterval(timer); };
    const timer = setInterval(update, 1000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [deadline, active]);
  const seconds = Math.max(0, Math.ceil((deadline - Math.max(now, Date.now())) / 1000));
  return { expired: seconds === 0, remaining: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` };
}
