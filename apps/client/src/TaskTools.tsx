import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { CalendarDays, Plus, Search, X } from './icons';
import { bindTaskSearchShortcut } from './task-search-shortcut';

/** Keep mounted inputs and writing when their disclosure closes. */
export function TaskTools({ openCalendar, filters, search, add, searchInput, query }: {
  openCalendar(): void; filters: ReactNode; search: ReactNode; add: ReactNode;
  searchInput: RefObject<HTMLInputElement | null>; query: string;
}) {
  const [searchOpen, setSearchOpen] = useState(false), [addOpen, setAddOpen] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null), addButton = useRef<HTMLButtonElement>(null), addRegion = useRef<HTMLDivElement>(null);
  useEffect(() => bindTaskSearchShortcut(() => searchInput.current, window, { trigger: () => searchButton.current, open: () => setSearchOpen(true) }), [searchInput]);
  useLayoutEffect(() => { if (searchOpen) searchInput.current?.focus({ preventScroll: true }); }, [searchOpen]);
  useLayoutEffect(() => { if (addOpen) addRegion.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }); }, [addOpen]);
  const closeSearch = () => { setSearchOpen(false); searchButton.current?.focus({ preventScroll: true }); };
  const closeAdd = () => { setAddOpen(false); addButton.current?.focus({ preventScroll: true }); };
  return <>
    <div className="task-compact-actions">
      <button className="compact-action task-plan-today" onClick={openCalendar} title="Plan Today" aria-label="Plan Today"><CalendarDays size={17}/><span>Plan Today</span></button>
      {filters}
      <button ref={searchButton} className="compact-action" aria-expanded={searchOpen} aria-controls="task-search-disclosure" aria-label={query ? 'Search Tasks, Active Query' : 'Search Tasks'} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}><Search size={17}/><span>Search{query && <span aria-hidden="true"> ·</span>}</span></button>
      <button ref={addButton} className="primary compact-action task-add-trigger" title="Add Task" aria-label="Add Task" aria-expanded={addOpen} aria-controls="task-add-disclosure" onClick={() => addOpen ? closeAdd() : setAddOpen(true)}><Plus size={18}/></button>
    </div>
    <div id="task-search-disclosure" className="task-input-disclosure" hidden={!searchOpen} onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !query) { event.preventDefault(); closeSearch(); }
    }}>{search}<button type="button" className="icon-button" aria-label="Close Task Search" onClick={closeSearch}><X size={16}/></button></div>
    <div id="task-add-disclosure" className="task-input-disclosure" ref={addRegion} hidden={!addOpen} onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); closeAdd(); }
    }}>{add}<button type="button" className="icon-button" aria-label="Close Add Task" onClick={closeAdd}><X size={16}/></button></div>
  </>;
}
