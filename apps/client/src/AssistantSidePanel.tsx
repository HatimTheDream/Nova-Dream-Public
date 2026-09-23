import { useEffect, useRef, type ReactNode } from 'react';
import { File, Folder, List, Device, Plus, X, PanelRightClose } from './icons';
import { viewTitle, type WorkspaceTab } from './workspace-tabs';
import './conversation-context.css';
export function AssistantSidePanel({ tabs, active, visible, expanded, select, closeTab, addTab, expand, close, children }: { tabs: WorkspaceTab[]; active: string; visible: boolean; expanded: boolean; select: (id: string) => void; closeTab: (id: string) => void; addTab: () => void; expand: () => void; close: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { if (visible) panel.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus(); }, [visible, active]);
  const focusSelected = () => requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus());
  return <aside ref={panel} hidden={!visible} className={`assistant-context-panel assistant-tabbed-panel ${expanded ? 'workspace-expanded' : ''}`} aria-label="Workspace" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab' && matchMedia('(max-width: 1100px)').matches) {
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]),a[href],summary,input,select,[tabindex="0"]') ?? []).filter(n => n.getClientRects().length);
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
