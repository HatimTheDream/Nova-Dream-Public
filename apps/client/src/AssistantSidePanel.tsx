import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { File, Folder, List, Device, Plus, X, PanelRightClose } from './icons';
import { viewTitle, type WorkspaceTab } from './workspace-tabs';
import './conversation-context.css';
export function AssistantSidePanel({ tabs, active, visible, expanded, select, closeTab, addTab, expand, close, fallbackFocus, children }: { tabs: WorkspaceTab[]; active: string; visible: boolean; expanded: boolean; select: (id: string) => void; closeTab: (id: string) => void; addTab: () => void; expand: () => void; close: () => void; fallbackFocus?: () => HTMLElement | null; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const fallback = useRef(fallbackFocus); fallback.current = fallbackFocus;
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1100px)').matches);
  const overlay = visible && (narrow || expanded);
  useEffect(() => { const query = matchMedia('(max-width: 1100px)'); const change = () => setNarrow(query.matches); query.addEventListener('change', change); return () => query.removeEventListener('change', change); }, []);
  useLayoutEffect(() => {
    if (!visible) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { const opener = returnFocus.current; requestAnimationFrame(() => {
      const target = opener?.isConnected && opener.getClientRects().length && !opener.closest('[inert]') ? opener : fallback.current?.();
      if (target?.isConnected && target.getClientRects().length && !target.closest('[inert]')) target.focus();
    }); };
  }, [visible]);
  useLayoutEffect(() => {
    if (!overlay || !panel.current) return;
    // A docked workspace can become modal while writing elsewhere. Transfer
    // focus before making that background inert, and return there on close.
    // Layout timing precedes the organization rail's passive resize focus.
    if (!panel.current.contains(document.activeElement)) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      panel.current.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    }
    const previous: [HTMLElement, boolean][] = [];
    // In overlay mode, every background branch is inert. Walk the ancestor
    // chain so the shell navigation cannot receive focus behind the dialog.
    for (let branch: HTMLElement | null = panel.current; branch?.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) if (sibling !== branch && sibling instanceof HTMLElement) { previous.push([sibling, sibling.inert]); sibling.inert = true; }
      if (branch.parentElement === document.body) break;
    }
    return () => { for (const [element, inert] of previous) element.inert = inert; };
  }, [overlay]);
  useEffect(() => { if (visible) panel.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus(); }, [visible, active]);
  const focusSelected = () => requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus());
  return <aside ref={panel} hidden={!visible} role={overlay ? 'dialog' : undefined} aria-modal={overlay || undefined} className={`assistant-context-panel assistant-tabbed-panel ${expanded ? 'workspace-expanded' : ''}`} aria-label="Workspace" onKeyDown={event => {
    if (event.defaultPrevented || event.target instanceof HTMLElement && event.target.closest('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab' && overlay) {
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]),a[href],summary,input:not(:disabled):not([type="hidden"]),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? []).filter(n => {
        if (!n.getClientRects().length || n.closest('[inert]') || getComputedStyle(n).visibility !== 'visible') return false;
        // Closed disclosure contents can retain boxes in Chromium, but cannot
        // receive keyboard focus. Only their direct summary stays in the loop.
        for (let ancestor = n.parentElement; ancestor && ancestor !== panel.current; ancestor = ancestor.parentElement) {
          if (ancestor instanceof HTMLDetailsElement && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(n)) return false;
        }
        return true;
      });
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><header className="workspace-tab-strip"><div className="workspace-tabs" role="tablist" aria-label="Workspace tabs" onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return;
    event.preventDefault(); const i = tabs.findIndex(tab => tab.id === active);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    select(tabs[next].id); focusSelected();
  }}>{tabs.map(tab => { const Icon = tab.view.kind === 'file' ? File : tab.view.kind === 'changes' || tab.view.kind === 'plan' ? List : tab.view.kind === 'live' ? Device : Folder; const title = viewTitle(tab.view); return <div key={tab.id} className={`workspace-tab ${active === tab.id ? 'selected' : ''}`} role="presentation"><button role="tab" id={`workspace-tab-${tab.id}`} aria-controls={`workspace-view-${tab.id}`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} title={title} onClick={() => select(tab.id)}><Icon size={15}/><span>{title}</span></button><button className="workspace-tab-close" aria-label={`Close ${title} tab`} onClick={() => { closeTab(tab.id); focusSelected(); }}><X size={13}/></button></div>; })}</div><button className="icon-button" aria-label="New workspace tab" title="New workspace tab" onClick={() => { addTab(); focusSelected(); }}><Plus size={18}/></button><button className="icon-button workspace-expand" aria-label={expanded ? 'Restore panel size' : 'Expand workspace'} title={expanded ? 'Restore panel size' : 'Expand workspace'} onClick={expand}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={expanded ? 'M4 9h5V4m11 11h-5v5M9 9 3 3m12 12 6 6' : 'M4 9V4h5m11 11v5h-5M4 4l6 6m10 10-6-6'}/></svg></button><button className="icon-button" aria-label="Hide workspace" title="Hide workspace" onClick={close}><PanelRightClose size={19}/></button></header>{children}</aside>;
}
