export type AgentView = 'agent' | 'hub' | 'assignment' | 'routines' | 'skills';
export type AgentDestination = 'work' | 'team' | 'routines' | 'skills';
export type AgentSelection = { view: AgentView; target?: string; teamPresentation?: 'agent' | 'hub' };
export type AgentViewStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
export type AgentSelectionRead = { ok: true; raw: string | null; value: AgentSelection } | { ok: false; error: string };
const views: AgentView[] = ['agent', 'hub', 'assignment', 'routines', 'skills'];

export function agentSelection(value: unknown): value is AgentSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ['view', 'target', 'teamPresentation'].includes(key))
    && views.includes(row.view as AgentView)
    && (row.target === undefined || typeof row.target === 'string')
    && (row.teamPresentation === undefined || row.teamPresentation === 'agent' || row.teamPresentation === 'hub');
}

export function readAgentSelection(storage: AgentViewStorage, key: string): AgentSelectionRead {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { ok: true, raw, value: { view: 'agent' } };
    const value: unknown = JSON.parse(raw);
    return agentSelection(value) ? { ok: true, raw, value }
      : { ok: false, error: 'The saved Agents view needs review. Its original data is kept.' };
  } catch {
    return { ok: false, error: 'The saved Agents view could not be read. Keep this window open and retry.' };
  }
}

export function agentDestination(view: AgentView): AgentDestination {
  return view === 'assignment' ? 'work' : view === 'agent' || view === 'hub' ? 'team' : view;
}

export function nextAgentSelection(current: AgentSelection, destination: AgentDestination | AgentView): AgentSelection {
  const teamPresentation = current.view === 'agent' || current.view === 'hub' ? current.view : current.teamPresentation ?? 'agent';
  const view: AgentView = destination === 'team' ? teamPresentation : destination === 'work' ? 'assignment' : destination;
  return { ...current, view, teamPresentation: view === 'agent' || view === 'hub' ? view : teamPresentation };
}

/** View metadata only. The mounted editor remains the sole owner of writing. */
export function keepAgentSelection(storage: AgentViewStorage, key: string, original: AgentSelectionRead, next: AgentSelection, retain: () => boolean): AgentSelectionRead {
  if (!original.ok) return original;
  try {
    if (!agentSelection(next)) return { ok: false, error: 'The requested Agents view is unavailable.' };
    if (!retain()) return { ok: false, error: 'Keep your current writing before changing Agents views.' };
    if (storage.getItem(key) !== original.raw) return { ok: false, error: 'The saved Agents view changed. Your current writing is kept; reopen the current view before navigating.' };
    const raw = JSON.stringify(next);
    storage.setItem(key, raw);
    // localStorage.setItem is synchronous. Do not turn a later read failure into
    // permission to repeat or overwrite this successful write.
    return { ok: true, raw, value: next };
  } catch {
    return { ok: false, error: 'Browser storage is unavailable. Your current Agents view and writing remain open.' };
  }
}

type Owner = { scope: string; retain: () => boolean };
const owners = new Set<Owner>();
function beforeUnload(event: BeforeUnloadEvent) {
  if (!mayLeaveAgentDrafts()) { event.preventDefault(); event.returnValue = ''; }
}
export function registerAgentDraftNavigation(scope: string, retain: () => boolean) {
  const owner = { scope, retain };
  if (!owners.size && typeof window !== 'undefined') window.addEventListener('beforeunload', beforeUnload);
  owners.add(owner);
  return () => {
    owners.delete(owner);
    if (!owners.size && typeof window !== 'undefined') window.removeEventListener('beforeunload', beforeUnload);
  };
}
export function mayLeaveAgentDrafts(scope?: string) {
  let kept = true;
  for (const owner of owners) if (scope === undefined || owner.scope === scope) {
    try { if (!owner.retain()) kept = false; } catch { kept = false; }
  }
  return kept;
}
export const agentDraftScope = (epoch: string, deviceId: string, windowId: string) => `${epoch}:${deviceId}:${windowId}`;

/** An existing component still owns its editable value. This slot remembers
 * only the last read/written bytes so a departure cannot replace unseen data. */
export function agentLocalSlot<T>(storage: AgentViewStorage, key: string, valid: (value: unknown) => value is T, fallback: T) {
  let raw: string | null | undefined, initial = fallback, error = '';
  try {
    raw = storage.getItem(key);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!valid(parsed)) throw Error('Invalid retained value');
      initial = parsed;
    }
  } catch {
    raw = undefined;
    error = 'Some kept Agents writing or view data could not be read. Its original bytes are preserved.';
  }
  let saved = JSON.stringify(initial);
  return {
    initial, error,
    keep(value: T) {
      const next = JSON.stringify(value);
      // Unedited defaults never replace an unreadable or malformed original.
      if (next === saved) return true;
      try {
        if (raw === undefined || storage.getItem(key) !== raw) return false;
        storage.setItem(key, next);
        raw = next; saved = next; return true;
      } catch { return false; }
    },
  };
}
