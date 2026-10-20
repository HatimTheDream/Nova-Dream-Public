import type { Draft, ModuleId, Snapshot } from '../../../packages/domain/contracts';
import type { HomeLibraryState, HomeReference } from '../../../packages/domain/home-library';
import { savedRecordMatches } from './saved-record-search';
import { validRecordSelection, type RecordSelection } from './record-target-navigation';
import { libraryView, type LibraryView } from './home-library-navigation';

export type SearchKind = 'task' | 'draft' | 'project' | 'contact' | 'content' | 'agent' | 'assignment' | 'profile' | 'collection' | 'note' | 'link' | 'local-draft';
export type SearchTarget = { kind: SearchKind; id: string; revision: number; ownerToken?: string };
export type SearchOrigin = { route: ModuleId | 'settings'; label: string; settingsTab?: string; record?: RecordSelection; library?: LibraryView };
export type SearchScope = { epoch: string; deviceId: string; windowId: string };
export type SearchFilters = { type: SearchKind | 'all'; project: string; status: 'all' | 'active' | 'archived' | 'completed'; sort: 'match' | 'recent' };
export type SearchView = SearchScope & {
  format: 1; open: boolean; token: string; origin: SearchOrigin; query: string; filters: SearchFilters;
  selected?: SearchTarget; batch: number; scroll: number; detail: boolean;
};
export type SearchReturn = SearchScope & { token: string };
export type SearchQueryRequest = SearchReturn & { nonce: string; query: string };
export type LocalSearchDraft = { token: string; id: string; value: Draft; revision: number; epoch: string; deviceId: string; pending: boolean };
export type SearchResult = {
  target: SearchTarget; title: string; location: string; text: string; updatedAt: string; projectId: string | null;
  archived: boolean; completed: boolean; provenance: 'host' | 'device'; reference?: HomeReference;
};
export type SearchStorage = { read(key: string): unknown; write(key: string, value: unknown): boolean };
export const searchKinds: SearchKind[] = ['task', 'draft', 'project', 'contact', 'content', 'agent', 'assignment', 'profile', 'collection', 'note', 'link', 'local-draft'];
export const searchLabels: Record<SearchKind, string> = { task: 'Task', draft: 'Saved Draft', project: 'Project', contact: 'Contact', content: 'Content', agent: 'Agent', assignment: 'Assignment Plan', profile: 'Profile', collection: 'Library Collection', note: 'Library Note', link: 'Library Link', 'local-draft': 'Current Assistant Writing' };
export const defaultSearchFilters: SearchFilters = { type: 'all', project: 'all', status: 'all', sort: 'match' };
const routes = ['home', 'assistant', 'tasks', 'calendar', 'inbox', 'contacts', 'content', 'agents', 'profile', 'settings'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const searchKey = (scope: SearchScope) => `e3:global-search:${scope.epoch}:${scope.deviceId}:${scope.windowId}`;
export const searchResultKey = (target: SearchTarget) => `${target.kind}:${target.id}`;
export const sameSearchTarget = (a: SearchTarget, b: SearchTarget) => searchResultKey(a) === searchResultKey(b) && a.revision === b.revision && a.ownerToken === b.ownerToken;
export const searchReturn = (view: SearchView): SearchReturn => ({ epoch: view.epoch, deviceId: view.deviceId, windowId: view.windowId, token: view.token });
export const matchesSearchReturn = (view: SearchView | undefined, target: SearchReturn, scope: SearchScope) => !!view?.open
  && view.token === target.token && view.epoch === target.epoch && view.deviceId === target.deviceId && view.windowId === target.windowId
  && scope.epoch === target.epoch && scope.deviceId === target.deviceId && scope.windowId === target.windowId;
export const matchesSearchQuery = (request: SearchQueryRequest | undefined, scope: Pick<SearchScope, 'epoch' | 'deviceId'>) =>
  !!request && request.epoch === scope.epoch && request.deviceId === scope.deviceId && !!request.nonce
  && typeof request.query === 'string' && request.query.length <= 4096;
export function validSearchTarget(value: unknown): value is SearchTarget {
  return object(value) && searchKinds.includes(value.kind as SearchKind) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 250
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
    && (value.ownerToken === undefined || typeof value.ownerToken === 'string' && value.ownerToken.length <= 200);
}
export function readSearchView(value: unknown, scope: SearchScope): SearchView | undefined {
  if (!object(value) || value.format !== 1 || value.epoch !== scope.epoch || value.deviceId !== scope.deviceId || value.windowId !== scope.windowId
    || typeof value.open !== 'boolean' || typeof value.token !== 'string' || !value.token || value.token.length > 100
    || !object(value.origin) || !routes.includes(String(value.origin.route)) || typeof value.origin.label !== 'string' || value.origin.label.length > 100
    || value.origin.settingsTab !== undefined && (typeof value.origin.settingsTab !== 'string' || value.origin.settingsTab.length > 50)
    || value.origin.record !== undefined && !validRecordSelection(value.origin.record)
    || value.origin.library !== undefined && !libraryView(value.origin.library)
    || typeof value.query !== 'string' || value.query.length > 4096 || !object(value.filters)
    || !['all', ...searchKinds].includes(String(value.filters.type)) || typeof value.filters.project !== 'string' || value.filters.project.length > 200
    || !['all', 'active', 'archived', 'completed'].includes(String(value.filters.status)) || !['match', 'recent'].includes(String(value.filters.sort))
    || value.selected !== undefined && !validSearchTarget(value.selected)
    || !Number.isSafeInteger(value.batch) || Number(value.batch) < 20 || !Number.isFinite(value.scroll) || Number(value.scroll) < 0
    || typeof value.detail !== 'boolean') return;
  return value as SearchView;
}

/** Only view metadata is stored here. Original editors own every editable value and command. */
export class SearchNavigation {
  view: SearchView | undefined;
  error = '';
  private unreadable = false;
  constructor(readonly scope: SearchScope, private storage: SearchStorage, private nonce: () => string = () => crypto.randomUUID()) {
    const raw = storage.read(searchKey(scope));
    this.view = readSearchView(raw, scope);
    this.unreadable = raw !== undefined && !this.view;
  }
  private keep(value: SearchView) {
    if (!readSearchView(value, this.scope)) { this.error = 'This Search view is unavailable. The original saved view is kept.'; return false; }
    if (!this.storage.write(searchKey(this.scope), value)) { this.error = 'Search could not be kept on this device. Keep this window open and free browser storage before leaving.'; return false; }
    this.view = value; this.error = ''; return true;
  }
  begin(origin: SearchOrigin) {
    if (this.unreadable) { this.error = 'The original Search view could not be read. Its browser data is preserved.'; return false; }
    const old = this.view;
    return old?.open ? this.keep(old) : this.keep({ ...this.scope, format: 1, open: true, token: this.nonce(), origin,
      query: old?.query ?? '', filters: old?.filters ?? { ...defaultSearchFilters }, batch: old?.batch ?? 20, scroll: old?.scroll ?? 0, detail: false });
  }
  update(patch: Partial<Pick<SearchView, 'query' | 'filters' | 'selected' | 'batch' | 'scroll' | 'detail'>>, token = this.view?.token) {
    if (!this.view?.open || this.view.token !== token) return false;
    return this.keep({ ...this.view, ...patch });
  }
  prepareReturn(target: SearchReturn) {
    return matchesSearchReturn(this.view, target, this.scope) && this.keep(this.view!);
  }
  close(token: string) {
    return this.view?.token === token && this.view.open ? this.keep({ ...this.view, open: false }) : false;
  }
}

/** Complete projections from authenticated saved inputs; no request, mutation or localStorage scan. */
export function searchProjection(snapshot: Snapshot, library?: HomeLibraryState, local?: LocalSearchDraft): SearchResult[] {
  const result: SearchResult[] = [];
  const add = (kind: SearchKind, row: { id: string; revision: number; updatedAt: string }, title: string, text: string, options: Partial<Omit<SearchResult, 'target' | 'title' | 'text' | 'updatedAt'>> = {}) =>
    result.push({ target: { kind, id: row.id, revision: row.revision }, title, text, location: searchLabels[kind], updatedAt: row.updatedAt,
      projectId: null, archived: false, completed: false, provenance: 'host', ...options });
  for (const row of snapshot.tasks) add('task', row, row.value.title, row.value.notes, { projectId: row.value.projectId ?? null, completed: ['done', 'skipped'].includes(row.value.status), location: `Tasks · ${row.value.status}` });
  for (const row of snapshot.drafts) {
    if ((snapshot.draftRemovals?.find(item => item.draftId === row.id)?.revision ?? 0) >= row.revision) continue;
    add('draft', row, row.value.title, row.value.text, { projectId: row.value.projectId, location: row.deviceId === snapshot.deviceId ? 'Assistant · Host-Saved Device Draft' : 'Assistant · Another Saved Device Draft' });
  }
  for (const row of snapshot.projects) {
    if (snapshot.projectOrganization?.find(item => item.projectId === row.id)?.deleted) continue;
    add('project', row, row.value.name, row.value.purpose, { projectId: row.id });
  }
  // Keep the existing explicit field allowlist; query '' is a projection, not a changed matching contract.
  for (const row of savedRecordMatches(snapshot, '', true)) {
    const entity = snapshot.records?.[row.kind]?.find(item => item.id === row.id);
    if (!entity) continue;
    const value = entity.value as unknown as Record<string, unknown>;
    add(row.kind, entity, row.title, row.text, { archived: row.archived, projectId: typeof value.projectId === 'string' ? value.projectId : null, location: row.label });
  }
  if (library?.epoch === snapshot.epoch) {
    for (const row of library.collections) add('collection', row, row.title, row.subtitle, { archived: row.archived, location: 'Home · Library Collection' });
    for (const row of library.items) add(row.kind, row, row.title, `${row.body}${row.kind === 'link' ? `\n${row.url}` : ''}`, {
      archived: row.archived, location: `Home · ${searchLabels[row.kind]}`, reference: { kind: row.kind, id: row.id, revision: row.revision },
    });
  }
  if (local && local.epoch === snapshot.epoch && local.deviceId === snapshot.deviceId && local.value.text.trim()) result.push({
    target: { kind: 'local-draft', id: local.id, revision: local.revision, ownerToken: local.token }, title: local.value.title || 'Current Assistant Writing',
    location: 'On This Device · Current Assistant Writing', text: local.value.text, projectId: local.value.projectId, updatedAt: '', archived: false, completed: false, provenance: 'device',
  });
  return result;
}
export function searchMatches(results: SearchResult[], query: string, filters: SearchFilters) {
  const needle = query.trim().toLocaleLowerCase(), score = (row: SearchResult) => {
    const title = row.title.toLocaleLowerCase(); return !needle ? 0 : title === needle ? 3 : title.startsWith(needle) ? 2 : title.includes(needle) ? 1 : 0;
  };
  return results.filter(row => (filters.type === 'all' || row.target.kind === filters.type)
    && (filters.project === 'all' || (row.projectId ?? '') === filters.project)
    && (filters.status === 'all' || (filters.status === 'archived' ? row.archived : filters.status === 'completed' ? row.completed : !row.archived && !row.completed))
    && (!needle || `${row.title}\n${row.text}\n${row.location}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => (filters.sort === 'match' ? score(b) - score(a) : 0) || b.updatedAt.localeCompare(a.updatedAt) || searchResultKey(a.target).localeCompare(searchResultKey(b.target)));
}
export function searchExcerpt(text: string, query: string, limit = 240) {
  const clean = text.replace(/\s+/g, ' ').trim(), index = clean.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const start = Math.max(0, index - 65); return `${start ? '…' : ''}${clean.slice(start, start + limit)}${clean.length > start + limit ? '…' : ''}`;
}
