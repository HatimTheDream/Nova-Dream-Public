import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ComposerMenu } from './ComposerMenu';
import { Filter, Plus, Search, X } from './icons';
import { agentDestination, type AgentDestination, type AgentView } from './agent-workspace-navigation';
import './agents-workspace.css';

const destinations = [
  ['work', 'Work'], ['team', 'Team'], ['routines', 'Routines'], ['skills', 'Skills'],
] as const;

/** The destination owner admits a transition before this control moves focus. */
export function AgentsWorkspaceNavigation({ view, choose }: { view: AgentView; choose: (destination: AgentDestination) => boolean }) {
  const current = agentDestination(view);
  return <nav className="agents-workspace-navigation" aria-label="Agents Views" onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    if (!(event.target instanceof HTMLButtonElement) || event.target.parentElement !== event.currentTarget) return;
    event.preventDefault();
    const index = destinations.findIndex(([id]) => id === current);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? destinations.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + destinations.length) % destinations.length;
    if (choose(destinations[next][0])) event.currentTarget.querySelectorAll('button')[next]?.focus();
  }}>
    {destinations.map(([id, label]) => <button type="button" key={id} aria-current={current === id ? 'page' : undefined} onClick={() => choose(id)}>{label}</button>)}
  </nav>;
}

/** Presentation for the existing saved-brief collection; no attempt counts,
 * record values, command receipts or parallel assignment controller. */
export function AgentWorkControls({ savedCount, draftCount, query, changeQuery, filters, filterCount, filterSummary, assign }: {
  savedCount: number; draftCount: number; query: string; changeQuery: (query: string) => void;
  filters: (close: () => void) => ReactNode; filterCount: number; filterSummary: string; assign: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false), id = useId();
  const trigger = useRef<HTMLButtonElement>(null), field = useRef<HTMLInputElement>(null);
  const close = () => { setSearchOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (searchOpen) field.current?.focus(); }, [searchOpen]);
  return <section className="agents-workspace-controls" aria-label="Saved Assignment Briefs">
    <div className="agents-workspace-count"><h1 className="sr-only">Work</h1><h2>Saved Briefs</h2><span className="metadata">{savedCount}{draftCount > 0 ? ` · ${draftCount} Unfinished Device ${draftCount === 1 ? 'Draft' : 'Drafts'}` : ''}</span></div>
    <div className="compact-actions">
      <ComposerMenu className="agents-controls-menu" label={`Filter Assignments${filterCount ? `: ${filterCount} Active` : ''}`} text={filterCount ? `Filter · ${filterCount}` : 'Filter'} icon={<Filter size={16}/>} placement="below" align="right">{filters}</ComposerMenu>
      <button ref={trigger} className="compact-utility" type="button" aria-label="Search Assignments" aria-expanded={searchOpen} aria-controls={searchOpen ? id : undefined} onClick={() => searchOpen ? close() : setSearchOpen(true)}><Search size={16}/></button>
      <button className="compact-utility primary" type="button" onClick={assign}><Plus size={16}/>Assign</button>
    </div>
    {filterSummary && <p className="metadata agents-workspace-summary">{filterSummary}</p>}
    {searchOpen ? <div id={id} className="agents-workspace-search" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <label className="search-input"><Search size={16}/><input ref={field} type="search" aria-label="Search Saved Assignment Briefs" value={query} placeholder="Find a saved brief…" onChange={event => changeQuery(event.target.value)}/></label>
      <button className="compact-utility" type="button" aria-label="Close Assignment Search" onClick={close}><X size={16}/></button>
    </div> : query && <div className="agents-workspace-search"><button className="compact-utility agents-query-summary" type="button" onClick={() => setSearchOpen(true)}>Search: <span className="preserve-case">{query}</span></button><button className="compact-utility" type="button" aria-label="Clear Assignment Search" onClick={() => { changeQuery(''); close(); }}>Clear</button></div>}
  </section>;
}
