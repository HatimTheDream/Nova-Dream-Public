import type { Snapshot } from '../../../packages/domain/contracts';

type Destination = 'agents' | 'content';
type Scope = Pick<Snapshot, 'epoch' | 'deviceId'>;
export const connectedRouteKey = (scope: Scope, windowId: string) => 'e3:connected-view:' + scope.epoch + ':' + scope.deviceId + ':' + windowId;

export function restoredWorkRoute(scope: Scope, windowId: string, session: Pick<Storage,'getItem'>, local: Pick<Storage,'getItem'>): Destination | undefined {
  try {
    const saved = JSON.parse(session.getItem(connectedRouteKey(scope, windowId)) ?? 'null');
    if (!saved || !['agents', 'content'].includes(saved.page) || typeof saved.id !== 'string') return;
    const kind = saved.page === 'agents' ? 'assignment' : 'content';
    const index = JSON.parse(local.getItem('e3:record-index:' + scope.deviceId + ':' + kind + ':' + windowId) ?? 'null');
    if (index?.selected !== saved.id) return;
    if (saved.page === 'agents' && JSON.parse(local.getItem('e3:agent-view:' + scope.deviceId + ':' + windowId) ?? 'null')?.view !== 'assignment') return;
    return saved.page;
  } catch { return undefined; }
}
