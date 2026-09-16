// Frame, resize handlers and focus return extracted from Dream Claw's actual
// AssistantOrganizationRail. E3 supplies the saved-work body and host actions.
import { useEffect, useRef, useState, type ReactNode, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { PanelLeft, Plus, Search } from '../../../icons';
import { ASSISTANT_RAIL_MAX_WIDTH, ASSISTANT_RAIL_MIN_WIDTH, clampAssistantRailWidth } from '../../services/assistant/railLayout';

type Props = { spaceSwitch: ReactNode; newDraftLabel?: string; open: boolean; width: number; setWidth(width: number): void; onToggle(): void; onNewDraft(): void; onSearch(): void; children: ReactNode };
export function AssistantOrganizationRailFrame({ open, width, setWidth, onToggle, onNewDraft, onSearch, children, spaceSwitch, newDraftLabel = 'New chat' }: Props) {
  const [draftWidth, setDraftWidth] = useState(() => clampAssistantRailWidth(width));
  const resizeState = useRef<{ pointerId: number; startX: number; startWidth: number; width: number; direction: 1 | -1 } | null>(null);
  const wasOpen = useRef(open);
  const railRef = useRef<HTMLElement>(null);
  useEffect(() => { if (!resizeState.current) setDraftWidth(clampAssistantRailWidth(width)); }, [width]);
  useEffect(() => {
    if (wasOpen.current && !open) document.querySelector<HTMLButtonElement>('[data-assistant-sidebar-toggle]')?.focus();
    else if (!wasOpen.current && open && document.activeElement === document.body) railRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeDrawer = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && window.innerWidth <= 1000 && !document.querySelector('dialog[open], [aria-modal="true"]')) { event.preventDefault(); onToggle(); }
    };
    window.addEventListener('keydown', closeDrawer);
    return () => window.removeEventListener('keydown', closeDrawer);
  }, [open, onToggle]);
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 1000 || event.button !== 0) return;
    const direction = document.documentElement.dir === 'rtl' ? -1 : 1;
    resizeState.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: draftWidth, width: draftWidth, direction };
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const continueResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    state.width = clampAssistantRailWidth(state.startWidth + ((event.clientX - state.startX) * state.direction));
    setDraftWidth(state.width);
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    resizeState.current = null;
    setWidth(state.width);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const logicalDirection = document.documentElement.dir === 'rtl' ? -1 : 1;
    const delta = event.key === 'ArrowRight' ? 16 * logicalDirection : event.key === 'ArrowLeft' ? -16 * logicalDirection : 0;
    const nextWidth = event.key === 'Home'
      ? ASSISTANT_RAIL_MIN_WIDTH
      : event.key === 'End'
        ? ASSISTANT_RAIL_MAX_WIDTH
        : delta
          ? draftWidth + delta
          : null;
    if (nextWidth === null) return;
    event.preventDefault();
    const width = clampAssistantRailWidth(nextWidth);
    setDraftWidth(width);
    setWidth(width);
  };


  return <>
    {open && <button className="dc-assistant-rail-scrim" aria-label="Close assistant sidebar" tabIndex={-1} onClick={onToggle}/>}
    <aside ref={railRef} id="assistant-organization" aria-label="Assistant organization" aria-hidden={!open} inert={!open}
      className={`dc-assistant-rail ${open ? 'dc-assistant-rail--open' : 'dc-assistant-rail--closed'}`}
      style={{ '--dc-assistant-rail-width': `${draftWidth}px` } as CSSProperties}>
      <div className="dc-assistant-rail-header">
        {spaceSwitch}
        <button type="button" onClick={onSearch} className="dc-assistant-rail-icon-button" aria-label="Search conversations" title="Search conversations"><Search size={18}/></button>
        <button type="button" onClick={onNewDraft} className="dc-assistant-rail-icon-button" aria-label={newDraftLabel} title={newDraftLabel}><Plus size={18}/></button>
        <button type="button" onClick={onToggle} className="dc-assistant-rail-icon-button" aria-label="Hide assistant sidebar" aria-expanded="true" aria-controls="assistant-organization" title="Hide sidebar (Ctrl+Shift+O)"><PanelLeft size={18}/></button>
      </div>
      {children}
      <div
        className="dc-assistant-rail-resizer"
        role="separator"
        aria-label="Resize assistant sidebar"
        aria-orientation="vertical"
        aria-valuemin={ASSISTANT_RAIL_MIN_WIDTH}
        aria-valuemax={ASSISTANT_RAIL_MAX_WIDTH}
        aria-valuenow={draftWidth}
        tabIndex={0}
        onPointerDown={beginResize}
        onPointerMove={continueResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onKeyDown={resizeWithKeyboard}
      />
    </aside>
  </>;
}
