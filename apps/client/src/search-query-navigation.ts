import { matchesSearchQuery, type SearchQueryRequest, type SearchScope, type SearchStorage } from './search-workspace';

export type InboxSearchRequest = SearchQueryRequest & { inboxWindowId: string };
const viewKey = (deviceId: string, windowId: string) => `e3:original-inbox:${deviceId}:${windowId}:view`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Keep only the query in the existing Inbox view; account, folder and writing stay owned there. */
export function admitInboxSearch(scope: SearchScope, request: InboxSearchRequest, storage: SearchStorage): string | undefined {
  if (!matchesSearchQuery(request, scope) || request.windowId !== scope.windowId || !request.inboxWindowId) return 'This Inbox search belongs to another window.';
  const key = viewKey(scope.deviceId, request.inboxWindowId), previous = storage.read(key);
  if (previous !== undefined && !object(previous)) return 'The kept Inbox view could not be read. Its original value is preserved.';
  if (!storage.write(key, { ...(previous ?? {}), search: request.query, searchNonce: request.nonce })) return 'The Inbox query could not be kept. Your current account and writing remain open.';
}
export function admittedInboxSearch(scope: Pick<SearchScope, 'epoch' | 'deviceId'>, windowId: string, request: InboxSearchRequest | undefined, storage: Pick<SearchStorage, 'read'>): request is InboxSearchRequest {
  if (!matchesSearchQuery(request, scope) || request?.inboxWindowId !== windowId) return false;
  const view = storage.read(viewKey(scope.deviceId, windowId));
  return object(view) && view.searchNonce === request.nonce && view.search === request.query;
}
