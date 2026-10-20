import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { HomeLibraryState } from '../../../packages/domain/home-library';
import { readHomeLibraryState } from '../../../packages/domain/home-library-view';
import { request, saveLocal } from './api';
import { readNavigationLocal } from './navigation-storage';
import { retainedWindowId } from './useWorkspace';
import { ArrowLeft, Filter, Search, X } from './icons';
import { Dialog } from './ui';
import { defaultSearchFilters, searchExcerpt, searchKinds, searchLabels, searchMatches, searchProjection, searchResultKey,
  sameSearchTarget, SearchNavigation, type LocalSearchDraft, type SearchFilters, type SearchOrigin, type SearchResult, type SearchTarget, type SearchView } from './search-workspace';
import './global-search.css';

export function useGlobalSearch(snapshot: Snapshot) {
  const [navigation] = useState(() => new SearchNavigation({ epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId: retainedWindowId }, { read: readNavigationLocal, write: saveLocal }));
  const [, render] = useState(0);
  const [shown, setShown] = useState(!!navigation.view?.open), [notice, setNotice] = useState('');
  const [library, setLibrary] = useState<HomeLibraryState>(), [libraryStatus, setLibraryStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadKey, setLoadKey] = useState(0);
  const [localDraft, setLocalDraft] = useState<LocalSearchDraft>();
  const localDraftRef = useRef(localDraft); localDraftRef.current = localDraft;
  const changed = () => render(value => value + 1);
  const run = (action: () => boolean) => { const result = action(); changed(); return result; };
  const begin = (origin: SearchOrigin) => {
    if (!run(() => navigation.begin(origin))) return false;
    setNotice(''); setShown(true); return true;
  };
  const publishDraft = useCallback((owner: string, value?: LocalSearchDraft) => {
    if (value || localDraftRef.current?.token === owner) setLocalDraft(value);
  }, []);
  const view = navigation.view;
  useEffect(() => {
    if (!view?.open) return;
    let current = true;
    const abort = new AbortController(); setLibraryStatus('loading');
    request<unknown>('home/library', undefined, abort.signal).then(value => {
      if (!current || abort.signal.aborted) return;
      const state = readHomeLibraryState(value);
      if (!state || state.epoch !== snapshot.epoch) throw new Error('The Library response could not be verified.');
      setLibrary(state); setLibraryStatus('ready');
    }).catch(() => { if (current && !abort.signal.aborted) setLibraryStatus('error'); });
    return () => { current = false; abort.abort(); };
  }, [view?.open, view?.token, snapshot.epoch, snapshot.deviceId, loadKey]);
  const rows = useMemo(() => searchProjection(snapshot, library, localDraft), [snapshot, library, localDraft]);
  return {
    navigation, view, shown, setShown, notice, setNotice, begin, changed,
    error: navigation.error, rows, library, libraryStatus,
    retryLibrary: () => setLoadKey(value => value + 1),
    update: (patch: Parameters<SearchNavigation['update']>[0], token?: string) => run(() => navigation.update(patch, token)),
    retain: () => run(() => navigation.view ? navigation.update({}, navigation.view.token) : false),
    close: () => run(() => navigation.view ? navigation.close(navigation.view.token) : false),
    publishDraft,
  };
}
export type GlobalSearchController = ReturnType<typeof useGlobalSearch>;

export function SearchWorkspace({ search, snapshot, open, close, queryIn }: {
  search: GlobalSearchController; snapshot: Snapshot; open(target: SearchTarget): void; close(): void;
  queryIn(destination: 'assistant' | 'inbox'): void;
}) {
  const view = search.view!;
  const [filters, setFilters] = useState<SearchFilters>(), [coverage, setCoverage] = useState(false);
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), filterTrigger = useRef<HTMLButtonElement>(null);
  const matches = useMemo(() => searchMatches(search.rows, view.query, view.filters), [search.rows, view.query, view.filters]);
  const selected = view.selected && search.rows.find(row => searchResultKey(row.target) === searchResultKey(view.selected!));
  const changedSource = !!selected && !!view.selected && !sameSearchTarget(selected.target, view.selected);
  const librarySelection = !!view.selected && ['collection', 'note', 'link'].includes(view.selected.kind);
  const ready = !librarySelection || search.libraryStatus === 'ready';
  useLayoutEffect(() => { if (list.current) list.current.scrollTop = view.scroll; }, [view.token, search.shown]);
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, [view.token, search.shown]);
  const select = (row: SearchResult) => search.update({ selected: row.target, detail: true });
  const apply = (patch: Partial<Pick<SearchView, 'query' | 'filters'>>) => {
    const next = searchMatches(search.rows, patch.query ?? view.query, patch.filters ?? view.filters);
    const stillPresent = view.selected && next.some(row => searchResultKey(row.target) === searchResultKey(view.selected!));
    search.update({ ...patch, batch: 20, scroll: 0, ...(stillPresent ? {} : { selected: undefined, detail: false }) });
    list.current?.scrollTo({ top: 0 });
  };
  const activeFilters = Number(view.filters.type !== 'all') + Number(view.filters.project !== 'all') + Number(view.filters.status !== 'all') + Number(view.filters.sort !== 'match');
  return <main className={`global-search${view.detail ? ' global-search-detail-open' : ''}`} aria-label="Search" onKeyDown={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Escape' || filters || coverage) return;
    event.preventDefault(); if (view.detail) search.update({ detail: false }); else close();
  }}>
    <header className="global-search-heading"><div><h1>Search</h1><p>Find saved work. Keep its original context.</p></div><button className="compact-action" onClick={close}><X size={18}/>Close Search</button></header>
    <div className="global-search-tools"><label className="global-search-input"><Search size={19}/><input ref={input} type="search" aria-label="Search saved work" placeholder="Search saved work…" value={view.query} maxLength={4096} onChange={event => apply({ query: event.target.value })}/></label><button ref={filterTrigger} className="compact-action" onClick={() => setFilters({ ...view.filters })}><Filter size={17}/>Filters{activeFilters ? ` · ${activeFilters}` : ''}</button></div>
    <div className="global-search-summary"><span role="status">{matches.length} {matches.length === 1 ? 'Result' : 'Results'}{search.libraryStatus === 'loading' ? ' · Library loading' : search.libraryStatus === 'error' ? ' · Library unavailable' : ''}</span><button className="text-button" onClick={() => setCoverage(true)}>What Is Searched?</button></div>
    {search.libraryStatus === 'error' && <p className="global-search-notice" role="status">Saved workspace results are available. Library results could not be refreshed; their originals stay closed until verified.<button onClick={search.retryLibrary}>Retry Library</button></p>}
    {(search.notice || search.error) && <p className="field-error" role="alert">{search.notice || search.error}</p>}
    <div className="global-search-body">
      <div ref={list} className="global-search-list" aria-label="Search results" onScroll={event => { search.update({ scroll: event.currentTarget.scrollTop }); }}>
        {!matches.length && <div className="global-search-empty"><h2>{view.query.trim() || activeFilters ? 'No matches in the available saved work.' : 'No saved work is available yet.'}</h2><p>{search.libraryStatus === 'ready' ? 'Try another phrase or adjust the filters.' : 'Library is a separate read and is not included in this count yet.'}</p></div>}
        {matches.slice(0, view.batch).map(row => <button key={searchResultKey(row.target)} className="global-search-result" aria-pressed={!!view.selected && searchResultKey(row.target) === searchResultKey(view.selected)} onClick={() => select(row)}>
          <span className="global-search-type">{searchLabels[row.target.kind]}{row.archived ? ' · Archived' : row.completed ? ' · Completed' : ''}</span><strong>{row.title}</strong><small>{row.location}</small><span>{searchExcerpt(row.text, view.query)}</span>
        </button>)}
        {matches.length > view.batch && <button className="global-search-more" onClick={() => search.update({ batch: view.batch + 20 })}>Show More · {matches.length - view.batch} Remaining</button>}
      </div>
      <section className="global-search-preview" aria-label="Selected result">
        <button className="global-search-back compact-action" onClick={() => search.update({ detail: false })}><ArrowLeft size={18}/>Back To Results</button>
        {!view.selected ? <div className="global-search-empty"><h2>Choose a result</h2><p>Inspect the saved version, then open its original.</p></div> : !selected ? <div className="global-search-empty"><h2>This original is unavailable.</h2><p>The exact saved reference is kept. It may have been removed or the current editor may have changed.</p></div> : <>
          <div className="global-search-type">{searchLabels[selected.target.kind]} · {selected.provenance === 'device' ? 'On This Device' : 'Host Saved'}</div><h2>{selected.title}</h2><p className="metadata">{selected.location}{selected.archived ? ' · Archived' : ''}</p>
          {changedSource && <p role="status">The source changed since you selected it. Review the current version below before opening it.</p>}
          {!ready && <p role="status">Refresh Library before opening this original.</p>}
          <div className="global-search-text">{selected.text || 'No additional text.'}</div>
          <button className="primary compact-action" disabled={!ready} onClick={() => { if (!search.update({ selected: selected.target })) return; open(selected.target); }}>{changedSource ? 'Open Current Version' : 'Open Original'}</button>
        </>}
      </section>
    </div>
    <footer className="global-search-footer"><span>Looking for messages?</span><button className="compact-action" onClick={() => queryIn('assistant')}>Search In Assistant</button><button className="compact-action" onClick={() => queryIn('inbox')}>Search In Inbox</button></footer>
    {filters && <Dialog title="Search Filters" close={() => { setFilters(undefined); filterTrigger.current?.focus(); }}><form className="global-search-filter-dialog" onSubmit={event => { event.preventDefault(); apply({ filters }); setFilters(undefined); filterTrigger.current?.focus(); }}>
      <label>Type<select value={filters.type} onChange={e => setFilters({ ...filters, type: e.target.value as SearchFilters['type'] })}><option value="all">All Types</option>{searchKinds.map(kind => <option key={kind} value={kind}>{searchLabels[kind]}</option>)}</select></label>
      <label>Project<select value={filters.project} onChange={e => setFilters({ ...filters, project: e.target.value })}><option value="all">All Projects</option><option value="">Unfiled Or No Direct Project</option>{snapshot.projects.filter(item => !snapshot.projectOrganization?.find(row => row.projectId === item.id)?.deleted).map(item => <option key={item.id} value={item.id}>{item.value.name}</option>)}</select></label>
      <label>Status<select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value as SearchFilters['status'] })}><option value="all">All Statuses</option><option value="active">Active</option><option value="archived">Archived</option><option value="completed">Completed Tasks</option></select></label>
      <label>Sort<select value={filters.sort} onChange={e => setFilters({ ...filters, sort: e.target.value as SearchFilters['sort'] })}><option value="match">Best Match</option><option value="recent">Recently Updated</option></select></label><p className="metadata">Best Match prioritizes matching titles, then saved update time. It does not use AI retrieval.</p><div className="dialog-footer"><button type="button" onClick={() => setFilters({ ...defaultSearchFilters })}>Reset</button><button className="primary" type="submit">Apply Filters</button></div>
    </form></Dialog>}
    {coverage && <Dialog title="What Is Searched?" close={() => setCoverage(false)}><p>Saved Tasks, Projects, Contacts, Content, Agents, assignment plans, Profiles and host-saved Assistant drafts. Library includes saved collection titles, note text and link titles, notes and addresses; linked websites and attachments are not fetched.</p><p>On This Device includes only the current mounted Assistant writing. Other local writing and previous-window drafts remain in their original editors and Recover Writing, rather than this search.</p><p>Conversation messages and mail use their existing search tools. Opening those tools keeps the current account and writing; searching messages remains an explicit action.</p></Dialog>}
  </main>;
}
