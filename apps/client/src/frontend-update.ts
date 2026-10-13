import { mayLeaveAssistantDraft } from './assistant-draft-navigation';
import { startPolling } from './polling';

type LoadedFrontend = { candidateId?: string; frontendId?: string };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Unknown health cannot replace an observed selection. A service change keeps
 * its existing request fence; it never becomes a compatible frontend update. */
export function availableFrontend(loaded: LoadedFrontend, health: unknown): string | null | undefined {
  if (!hash(loaded.candidateId) || !hash(loaded.frontendId) || !record(health) ||
    health.application !== 'nova-dream-edition-3' || health.status !== 'ready' || !hash(health.candidateId)) return undefined;
  if (health.candidateId !== loaded.candidateId) return null;
  const frontend = health.frontend;
  if (!record(frontend) || !hash(frontend.id) || !['bundled', 'frontend'].includes(String(frontend.source)) ||
    frontend.blocked !== undefined && typeof frontend.blocked !== 'boolean' ||
    frontend.source === 'bundled' && frontend.id !== health.candidateId) return undefined;
  return frontend.blocked || frontend.id === loaded.frontendId ? null : frontend.id;
}

export function startFrontendUpdatePolling(options: {
  identity: LoadedFrontend; read: () => Promise<unknown>; changed: (id: string | null) => void; enabled?: () => boolean;
}, environment?: Parameters<typeof startPolling>[1]): () => void {
  const loaded = { ...options.identity };
  if (!hash(loaded.candidateId) || !hash(loaded.frontendId)) return () => {};
  let active = true, previous: string | null = null;
  const stop = startPolling({
    read: async () => {
      if (options.enabled?.() === false) return;
      const next = availableFrontend(loaded, await options.read());
      if (!active || options.enabled?.() === false) return;
      if (next === undefined) return false;
      if (next !== previous) { previous = next; options.changed(next); }
    },
    interval: () => options.enabled?.() === false ? null : 10000,
    hiddenInterval: 30000,
    immediate: false,
  }, environment);
  return () => { active = false; stop(); };
}

/** Keep the mounted composer's storage-failure warning before replacing it.
 * Other editors retain their normal browser beforeunload guards. */
export function refreshFrontend(reload: () => void = () => location.reload()): boolean {
  if (!mayLeaveAssistantDraft()) return false;
  reload();
  return true;
}
