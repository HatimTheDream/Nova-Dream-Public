import { useLayoutEffect } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { connectedRouteKey } from './connected-work-route';

/** Only an open connected view overrides the normal Home entry on a reload in this tab. */
export function useRememberWorkRoute(scope: Pick<Snapshot, 'epoch' | 'deviceId'>, windowId: string, page: 'agents' | 'content', id?: string) {
  useLayoutEffect(() => {
    if (!id) return;
    const slot = connectedRouteKey(scope, windowId), value = JSON.stringify({ page, id });
    try { sessionStorage.setItem(slot, value); } catch { return; }
    return () => {
      try { if (sessionStorage.getItem(slot) === value) sessionStorage.removeItem(slot); } catch { /* Writing stays in its own journal. */ }
    };
  }, [scope.epoch, scope.deviceId, windowId, page, id]);
}
