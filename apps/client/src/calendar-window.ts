let identity: Promise<{ id: string; previous?: string }> | undefined;
/** A cloned browser tab gets a separate journal, including a copy of kept work. */
export function calendarWindowIdentity() {
  return identity ??= new Promise(resolve => {
    let previous: string | undefined; try { previous = sessionStorage.getItem('e3:calendar-tab') ?? undefined; } catch { /* A new in-memory identity still isolates this window. */ }
    const claim = (id: string, copied?: string) => {
      try { sessionStorage.setItem('e3:calendar-tab', id); } catch { /* The journal remains in localStorage under this identity. */ }
      resolve({ id, ...(copied ? { previous: copied } : {}) });
    };
    const id = previous ?? crypto.randomUUID();
    if (!navigator.locks) { claim(crypto.randomUUID(), previous); return; }
    const hold = (lockId: string, copied?: string) => navigator.locks.request(`e3:calendar-window:${lockId}`, { ifAvailable: true }, async lock => {
      if (!lock) { void hold(crypto.randomUUID(), previous); return; }
      claim(lockId, copied); await new Promise<void>(release => window.addEventListener('pagehide', () => release(), { once: true }));
    });
    void hold(id).catch(() => claim(crypto.randomUUID(), previous));
  });
}
