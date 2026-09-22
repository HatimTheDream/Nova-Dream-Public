type PollingEnvironment = {
  visible: () => boolean;
  schedule: (read: () => void, delay: number) => () => void;
  subscribe: (change: () => void) => () => void;
};

const browser: PollingEnvironment = {
  visible: () => !document.hidden,
  schedule: (read, delay) => { const timer = setTimeout(read, delay); return () => clearTimeout(timer); },
  subscribe: change => {
    document.addEventListener('visibilitychange', change); window.addEventListener('focus', change);
    return () => { document.removeEventListener('visibilitychange', change); window.removeEventListener('focus', change); };
  },
};

export function pollReader(reader: { poll: () => Promise<void>; readonly failed: boolean }, interval: () => number | null, hiddenInterval: number | null = null): () => void {
  return startPolling({ read: async () => { await reader.poll(); return !reader.failed; }, interval, hiddenInterval });
}

/** Automatic reads only. Mutations and explicit refreshes keep their own receipt semantics. */
export function startPolling(options: {
  read: () => Promise<boolean | void>;
  interval: () => number | null;
  hiddenInterval?: number | null;
  immediate?: boolean;
}, environment: PollingEnvironment = browser): () => void {
  let stopped = false, reading = false, retryDelay = 0;
  let cancelTimer: (() => void) | undefined;
  const schedule = () => {
    cancelTimer?.();
    const interval = environment.visible() ? options.interval() : options.hiddenInterval ?? null;
    if (stopped || interval === null) return;
    cancelTimer = environment.schedule(read, Math.max(interval, retryDelay));
  };
  const read = async () => {
    if (stopped || reading) return;
    cancelTimer?.(); reading = true;
    let success = false;
    try { success = await options.read() !== false; } catch { /* Failed reads use the same bounded retry delay. */ }
    finally { retryDelay = success ? 0 : Math.min(120000, retryDelay * 2 || 5000); reading = false; if (!stopped) schedule(); }
  };
  const unsubscribe = environment.subscribe(() => {
    if (environment.visible()) void read();
    else if (!reading) schedule();
  });
  if (options.immediate !== false && environment.visible()) void read(); else schedule();
  return () => { stopped = true; cancelTimer?.(); unsubscribe(); };
}
