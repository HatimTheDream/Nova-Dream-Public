import { useState } from 'react';
import type { HomeReference, HomeResource } from '../../../packages/domain/home-library';
import { exactHomeReference, homeReferenceKey } from '../../../packages/domain/home-library-view';

type Props = {
 resources: HomeResource[];
 selected: HomeReference[];
 select: (references: HomeReference[]) => void;
 busy?: boolean;
 disabled?: (reference: HomeReference) => boolean;
 selectionCount?: number;
 selectionLimit?: number;
};

export function HomeSourcePicker({ resources, selected, select, busy = false, disabled, selectionCount = selected.length, selectionLimit }: Props) {
 const [query, setQuery] = useState(''), [limit, setLimit] = useState(40);
 const current = resources.filter(resource => resource.availability === 'current');
 const needle = query.trim().toLocaleLowerCase();
 const matches = current.filter(resource => `${resource.title} ${resource.subtitle}`.toLocaleLowerCase().includes(needle));
 const needsReview = selected.filter(reference => !current.some(resource => exactHomeReference(resource.reference, reference))).length;
 const remove = (reference: HomeReference) => select(selected.filter(kept => !exactHomeReference(kept, reference)));
 return <div className="home-source-selection">
  <label>Find a source<input type="search" value={query} onChange={event => { setQuery(event.target.value);setLimit(40); }}/></label>
  {selected.length > 0 && <details><summary>{selected.length} selected{needsReview > 0 && ` · ${needsReview} need review`}</summary><div className="home-source-picker">{selected.map(reference => {
   const resource = resources.find(item => exactHomeReference(item.reference, reference)) ?? resources.find(item => homeReferenceKey(item.reference) === homeReferenceKey(reference));
   const available = current.some(item => exactHomeReference(item.reference, reference));
   return <label className="check-label" key={homeReferenceKey(reference)}><input type="checkbox" aria-label={`Remove ${resource?.title ?? 'unavailable source'}`} checked disabled={busy} onChange={() => remove(reference)}/><span><strong>{resource?.title ?? 'Unavailable saved source'}</strong><small>{available ? 'Selected source' : resource ? 'Changed or unavailable — choose its current version below or remove this selection.' : 'Unavailable — remove this selection to continue.'}</small></span></label>;
  })}</div></details>}
  <p className="metadata" role="status">{matches.length} {needle ? 'matching' : 'available'} sources · {selected.length} selected{selectionLimit !== undefined && ` · ${selectionCount} / ${selectionLimit} including Tasks`}</p>
  <div className="home-source-picker">{matches.slice(0, limit).map(resource => {
   const reference = resource.reference, key = homeReferenceKey(reference), kept = selected.some(item => homeReferenceKey(item) === key);
   const blocked = busy || disabled?.(reference) || (!kept && selectionLimit !== undefined && selectionCount >= selectionLimit);
   return <label className="check-label" key={key}><input type="checkbox" checked={selected.some(item => exactHomeReference(item, reference))} disabled={blocked} onChange={event => select(event.target.checked ? [...selected.filter(item => homeReferenceKey(item) !== key), reference] : selected.filter(item => homeReferenceKey(item) !== key))}/><span><strong>{resource.title}</strong><small>{resource.subtitle}</small></span></label>;
  })}</div>
  {matches.length > limit && <button onClick={() => setLimit(value => value + 40)}>Show more sources ({matches.length - limit} remaining)</button>}
  {!matches.length && <p className="metadata">{needle ? 'No sources match this search. Your selections are kept.' : 'No current sources are available.'}</p>}
 </div>;
}
