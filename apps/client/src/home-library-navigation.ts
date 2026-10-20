import type { HomeLibraryState, HomeReference, HomeResource } from '../../../packages/domain/home-library';
import { isHomeCollectionDraft } from '../../../packages/domain/home-library-view';
import type { SearchScope, SearchStorage, SearchTarget } from './search-workspace';

export type LibraryRoute = { kind: 'all' | 'up-next' | 'unassigned' } | { kind: 'space'; id: string };
export type LibraryView = { query: string; mode: 'cards' | 'compact'; filter: 'all' | 'pinned' | 'archived'; collectionId: string | null; selection: { collectionId: string; references: HomeReference[] } | null; route?: LibraryRoute };
export const defaultLibraryView = (): LibraryView => ({ query: '', mode: 'cards', filter: 'all', collectionId: null, selection: null });
export function libraryView(value: unknown): LibraryView | undefined {
  const row = value as LibraryView | undefined;
  if (!row || typeof row !== 'object' || typeof row.query !== 'string' || !['cards', 'compact'].includes(row.mode) || !['all', 'pinned', 'archived'].includes(row.filter) || !(row.collectionId === null || typeof row.collectionId === 'string')) return;
  const selection = row.selection;
  if (selection !== null && (!selection || typeof selection !== 'object' || typeof selection.collectionId !== 'string' || !Array.isArray(selection.references) || selection.references.length > 200
    || !isHomeCollectionDraft({ title: '', subtitle: '', icon: 'folder', pinned: false, archived: false, references: selection.references }))) return;
  const route = row.route;
  if (route !== undefined && (!route || typeof route !== 'object' || (route.kind === 'space' ?
    Object.keys(route).some(key => !['kind', 'id'].includes(key)) || typeof route.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(route.id) :
    !['all', 'up-next', 'unassigned'].includes(route.kind) || Object.keys(route).some(key => key !== 'kind')))) return;
  return { query: row.query, mode: row.mode, filter: row.filter, collectionId: row.collectionId, selection, ...(route ? { route } : {}) };
}
export type LibraryTarget = SearchScope & { nonce: string; target?: SearchTarget; restore?: LibraryView };
export const libraryViewKey = (scope: Pick<SearchScope, 'epoch' | 'deviceId'>) => `e3:home-library-view:${scope.deviceId}:${scope.epoch}`;
export function admitLibraryTarget(scope: SearchScope, state: HomeLibraryState, target: LibraryTarget, storage: SearchStorage) {
  if (target.epoch !== scope.epoch || target.deviceId !== scope.deviceId || target.windowId !== scope.windowId || state.epoch !== scope.epoch) return 'This Library source belongs to another workspace.';
  const raw = storage.read(libraryViewKey(scope)), previous = raw === undefined ? defaultLibraryView() : libraryView(raw);
  if (!previous) return 'The kept Library view could not be read. Its original data is preserved.';
  let next = target.restore && libraryView(target.restore);
  if (!next) {
    const source = target.target;
    const row = source?.kind === 'collection' ? state.collections.find(item => item.id === source.id)
      : state.items.find(item => item.kind === source?.kind && item.id === source.id);
    if (!source || !row || row.revision !== source.revision) return 'This Library source changed or is unavailable. Review it in Search.';
    next = source.kind === 'collection' ? { ...previous, query: '', filter: row.archived ? 'archived' : 'all', collectionId: row.id, route: { kind: 'all' } } : previous;
  }
  // The nonce accompanies only view metadata. Both writer journals remain untouched.
  return storage.write(libraryViewKey(scope), { ...next, searchNonce: target.nonce }) ? undefined : 'Free browser storage before opening this Library source. Your writing and selection are kept.';
}
export function admittedLibraryView(scope: SearchScope, target: LibraryTarget, storage: Pick<SearchStorage, 'read'>) {
  if (target.epoch !== scope.epoch || target.deviceId !== scope.deviceId || target.windowId !== scope.windowId) return;
  const raw = storage.read(libraryViewKey(scope)) as { searchNonce?: string } | undefined;
  return raw?.searchNonce === target.nonce ? libraryView(raw) : undefined;
}
export function libraryTargetPreview(state: HomeLibraryState, target: LibraryTarget): HomeResource | undefined {
  const ref = target.target;
  if (state.epoch !== target.epoch || !ref || !['note', 'link'].includes(ref.kind)) return;
  const row = state.items.find(item => item.id === ref.id && item.kind === ref.kind && item.revision === ref.revision);
  if (!row) return;
  return { reference: { kind: row.kind, id: row.id, revision: row.revision }, title: row.title, subtitle: row.archived ? 'Archived Library item' : 'Library item',
    text: row.body, ...(row.kind === 'link' ? { url: row.url } : {}), updatedAt: row.updatedAt, availability: 'current' };
}
