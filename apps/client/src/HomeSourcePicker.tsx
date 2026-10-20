import { useEffect, useId, useRef, useState } from 'react';
import type { HomeCollection, HomeReference, HomeResource } from '../../../packages/domain/home-library';
import { exactHomeReference, homeReferenceKey } from '../../../packages/domain/home-library-view';
import { ComposerMenu } from './ComposerMenu';
import { Filter, Search, X } from './icons';
import { emptySourcePickerView, type SourcePickerView } from './home-source-picker-view';

type Props = {
 resources: HomeResource[];
 selected: HomeReference[];
 select: (references: HomeReference[]) => void;
 busy?: boolean;
 disabled?: (reference: HomeReference) => boolean;
 selectionCount?: number;
 selectionLimit?: number;
 compact?: boolean;
 collections?: HomeCollection[];
 view?: SourcePickerView;
 changeView?: (view: SourcePickerView) => void;
 inspect?: (resource: HomeResource) => void;
};

export function HomeSourcePicker({ resources, selected, select, busy = false, disabled, selectionCount = selected.length, selectionLimit, compact = false, collections = [], view, changeView, inspect }: Props) {
 const [localView, setLocalView] = useState<SourcePickerView>(emptySourcePickerView);
 const currentView = view ?? localView, { query, limit } = currentView;
 const updateView = (patch: Partial<SourcePickerView>) => { const next = { ...currentView, ...patch };if (changeView) changeView(next);else setLocalView(next); };
 const current = resources.filter(resource => resource.availability === 'current');
 const needle = query.trim().toLocaleLowerCase();
 const collection = collections.find(item => item.id === currentView.collection && !item.archived);
 const matches = current.filter(resource => (!compact || (!currentView.collection || collection?.references.some(ref => exactHomeReference(ref, resource.reference))) && (currentView.type === 'all' || currentView.type === resource.reference.kind)) && `${resource.title} ${resource.subtitle}`.toLocaleLowerCase().includes(needle));
 const needsReview = selected.filter(reference => !current.some(resource => exactHomeReference(resource.reference, reference))).length;
 const remove = (reference: HomeReference) => select(selected.filter(kept => !exactHomeReference(kept, reference)));
 return <div className={`home-source-selection${compact ? ' home-source-compact' : ''}`}>
  {compact ? <SourceTools view={currentView} update={updateView} collections={collections} busy={busy}/> : <label>Find a source<input type="search" value={query} onChange={event => updateView({ query: event.target.value, limit: 40 })}/></label>}
  {compact && currentView.collection && !collection && <p role="status">The chosen collection is unavailable. Your selected source versions are kept.</p>}
  {selected.length > 0 && <details><summary>{selected.length} selected{needsReview > 0 && ` · ${needsReview} need review`}</summary><div className="home-source-picker">{selected.map(reference => {
   const resource = resources.find(item => exactHomeReference(item.reference, reference)) ?? resources.find(item => homeReferenceKey(item.reference) === homeReferenceKey(reference));
   const available = current.some(item => exactHomeReference(item.reference, reference));
   return <label className="check-label" key={homeReferenceKey(reference)}><input type="checkbox" aria-label={`Remove ${resource?.title ?? 'unavailable source'}`} checked disabled={busy} onChange={() => remove(reference)}/><span><strong>{resource?.title ?? 'Unavailable saved source'}</strong><small>{available ? 'Selected source' : resource ? 'Changed or unavailable — choose its current version below or remove this selection.' : 'Unavailable — remove this selection to continue.'}</small></span></label>;
  })}</div></details>}
  <p className="metadata" role="status">{matches.length} {needle ? 'matching' : 'available'} sources · {selected.length} selected{selectionLimit !== undefined && ` · ${selectionCount} / ${selectionLimit} including Tasks`}</p>
  <div className="home-source-picker">{matches.slice(0, limit).map(resource => {
   const reference = resource.reference, key = homeReferenceKey(reference), kept = selected.some(item => homeReferenceKey(item) === key);
   const blocked = busy || disabled?.(reference) || (!kept && selectionLimit !== undefined && selectionCount >= selectionLimit);
   const row = <label className="check-label" key={key}><input type="checkbox" checked={selected.some(item => exactHomeReference(item, reference))} disabled={blocked} onChange={event => select(event.target.checked ? [...selected.filter(item => homeReferenceKey(item) !== key), reference] : selected.filter(item => homeReferenceKey(item) !== key))}/><span><strong>{resource.title}</strong><small>{resource.subtitle}</small></span></label>;
   return compact && inspect ? <div className="home-source-choice" key={key}>{row}<button className="compact-action compact-utility" disabled={busy} aria-label={`Preview ${resource.title}`} onClick={() => inspect(resource)}>Preview</button></div> : row;
  })}</div>
  {matches.length > limit && <button onClick={() => updateView({ limit: Math.min(100000, limit + 40) })}>Show More Sources ({matches.length - limit} Remaining)</button>}
  {!matches.length && <p className="metadata">{needle ? 'No sources match this search. Your selections are kept.' : 'No current sources are available.'}</p>}
 </div>;
}

const sourceTypes: [SourcePickerView['type'], string][] = [['all', 'All Types'], ['note', 'Notes'], ['link', 'Links'], ['content', 'Content'], ['output', 'Assistant Outputs'], ['assignment', 'Agent Results'], ['widget', 'Retained Home Writing']];
function SourceTools({ view, update, collections, busy }: { view: SourcePickerView; update: (patch: Partial<SourcePickerView>) => void; collections: HomeCollection[]; busy: boolean }) {
 const search = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), id = useId();
 useEffect(() => { if (view.searchOpen) search.current?.focus({ preventScroll: true }); }, [view.searchOpen]);
 const close = () => { update({ searchOpen: false });trigger.current?.focus({ preventScroll: true }); };
 return <>
  <div className="home-source-tools">
   <label>Collection<select disabled={busy} value={view.collection} onChange={event => update({ collection: event.target.value, limit: 40 })}><option value="">All Collections</option>{view.collection && !collections.some(c => c.id === view.collection && !c.archived) && <option value={view.collection}>Unavailable Collection</option>}{collections.filter(c => !c.archived).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
   <ComposerMenu label="Source Types" icon={<Filter size={16}/>} text={sourceTypes.find(([type]) => type === view.type)?.[1] ?? view.type} className="compact-composer-menu" placement="below" kind="menu">{closeMenu => <div className="home-source-type-options">{sourceTypes.map(([type, label]) => <button className="compact-action compact-utility" role="menuitemradio" aria-checked={view.type === type} disabled={busy} key={type} onClick={() => { update({ type, limit: 40 });closeMenu(); }}>{label}</button>)}</div>}</ComposerMenu>
   <button className="compact-action compact-utility compact-icon" ref={trigger} disabled={busy} aria-label="Search Library Sources" aria-expanded={view.searchOpen} aria-controls={view.searchOpen ? id : undefined} onClick={() => update({ searchOpen: !view.searchOpen })}><Search size={16}/></button>
  </div>
  {view.searchOpen ? <div id={id} className="home-source-search" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault();event.stopPropagation();close(); } }}><label className="search-input"><Search size={16}/><input ref={search} type="search" aria-label="Find A Library Source" maxLength={300} value={view.query} disabled={busy} onChange={event => update({ query: event.target.value, limit: 40 })}/></label><button className="compact-action compact-utility compact-icon" aria-label="Close Source Search" onClick={close}><X size={16}/></button></div> : view.query && <div className="home-source-query"><button className="compact-action compact-utility preserve-case" onClick={() => update({ searchOpen: true })}>Search: {view.query}</button><button className="compact-action compact-utility compact-icon" disabled={busy} aria-label="Clear Source Search" onClick={() => update({ query: '', limit: 40 })}><X size={16}/></button></div>}
 </>;
}
