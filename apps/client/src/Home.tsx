import { projectIsDeleted } from '../../../packages/domain/project-organization';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Clock3, Copy, EyeOff, GripVertical, MoreHorizontal, Plus, Settings2, Trash2, X } from './icons';
import { sizes, type Draft, type Entity, type Layout, type ModuleId, type Snapshot, type Task } from '../../../packages/domain/contracts';
import { createHomeWidget, resolveWidgetType, widgetTitle, homeWidgetNames, type HomeWidget } from '../../../packages/domain/home-widgets';
import { useReorder } from './useReorder';
import { HomeWidgetContent } from './HomeWidgets';
import { Dialog } from './ui';
import { LoadingRing } from './ModuleLoading';
const HomeWidgetDialog = lazy(() => import('./HomeWidgetDialog').then(module => ({ default: module.HomeWidgetDialog })));
import { homeTaskState } from './home-task-state';
import { retainedWindowId } from './useWorkspace';

export const widgetNames = homeWidgetNames;
type Props = {
  snapshot: Snapshot; layout: Layout; saveLayout: (value: Layout) => boolean | void;
  open: (id: ModuleId) => void; openSettings: (tab: 'general' | 'accounts') => void;
  newTask: (defaults?: Partial<Task>) => void; editTask: (task: Entity<Task>) => void; complete: (task: Entity<Task>) => void;
  draft: Draft; dirty: boolean; draftStatus: string;
};
export function Home({ snapshot, layout, saveLayout, open, openSettings, newTask, editTask, complete, draft, dirty, draftStatus }: Props) {
  const [menu, setMenu] = useState<string | null>(null);
  const optionsButtons = useRef(new Map<string, HTMLButtonElement>());
  const closeMenu = () => {
    const trigger = menu ? optionsButtons.current.get(menu) : undefined;
    setMenu(null);
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  const [editor, setEditor] = useState<HomeWidget | 'new' | null>(null);
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<HomeWidget | null>(null);
  const [removed, setRemoved] = useState<{ widget: HomeWidget; index: number } | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 60000); return () => clearInterval(timer); }, []);
  const persist = (next: Layout) => {
    if (saveLayout(next) === false) throw Error('Browser storage is full. Keep this page open until your changes can be saved.');
  };
  const update = (next: Layout) => { try { persist(next); setNotice(''); return true; } catch (error) { setNotice((error as Error).message); return false; } };
  const reorder = useReorder(layout.widgets.filter(widget => !widget.hidden).map(widget => widget.id), order => {
    return update({ ...layout, widgets: [...order.map(id => layout.widgets.find(widget => widget.id === id)!), ...layout.widgets.filter(widget => widget.hidden)] });
  }, 'widgets', { motion: true });
  const changeWidget = (id: string, values: Partial<HomeWidget>) => update({ ...layout, widgets: layout.widgets.map(widget => widget.id === id ? { ...widget, ...values } : widget) });
  const saveWidget = (widget: HomeWidget) => {
    const exists = layout.widgets.some(item => item.id === widget.id);
    if (!exists && layout.widgets.length >= 24) throw Error('Your board already has 24 widgets. Restore a hidden widget or edit an existing one.');
    persist({ ...layout, widgets: exists ? layout.widgets.map(item => item.id === widget.id ? widget : item) : [...layout.widgets, widget] });
    setNotice(exists ? 'Widget changes are kept on this device while the board saves.' : 'Widget added. Your board is saving.');
  };
  const duplicate = (widget: HomeWidget) => {
    if (layout.widgets.length >= 24) { setNotice('Your board already has 24 widgets.'); return; }
    const copy = { ...structuredClone(widget), id: createHomeWidget(resolveWidgetType(widget)).id, type: resolveWidgetType(widget), title: `${widgetTitle(widget).slice(0, 73)} copy`, hidden: false };
    if (update({ ...layout, widgets: [...layout.widgets, copy] })) { setMenu(null); setNotice('Widget duplicated.'); }
  };
  return <div className="home-page page-scroll" data-reorder-scroll tabIndex={0} aria-label="Home board">
    <div className="page-intro"><div><h1>Today</h1></div><button className="primary" onClick={() => { setMenu(null); setEditor('new'); }}><Plus size={17}/>Add Widget</button></div>
    {notice && <div className="home-board-notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss board notice" onClick={() => setNotice('')}><X size={16}/></button></div>}
    {reorder.order.length === 0 && <div className="home-empty-board"><h2>Make room for what matters</h2><p>Add tasks, a note, useful links, or a clock. Hidden widgets are kept in your widget library.</p><button className="primary" onClick={() => setEditor('new')}>Browse Widgets</button></div>}
    <div className="home-grid" ref={reorder.containerRef}>{reorder.order.map(id => {
      const widget = layout.widgets.find(item => item.id === id)!;
      const type = resolveWidgetType(widget), title = widgetTitle(widget);
      const timezone = widget.settings?.timezone ?? layout.timezone;
      const projectId = widget.settings?.projectId;
      const projectMissing = Boolean(projectId && !snapshot.projects.some(project => project.id === projectId));
      const source = projectId ? { ...snapshot, tasks: snapshot.tasks.filter(task => task.value.projectId === projectId) } : snapshot;
      const state = homeTaskState(source, { ...layout, timezone }, clock, snapshot.tasks);
      const date = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: timezone }).format(clock);
      const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(clock);
      return <section className={`widget widget-${type} size-${widget.size} ${reorder.dragging === id ? 'dragging' : ''}`} key={id} {...reorder.bindSurface(id)} data-reorder-group="widgets" data-reorder-item={id} data-widget-color={widget.color ?? 'default'} aria-label={title}>
        <div className="widget-header"><strong className="widget-title" title={title}>{title}</strong><div className="widget-header-controls"><button className="icon-button widget-move-handle" {...reorder.bind(id)} title="Move Widget · Drag Or Alt + Up/Down" onKeyDown={event => {
          if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); reorder.move(id, reorder.order.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1)); }
        }} aria-label={`Move ${title}. Drag or use Alt and arrow keys.`}><GripVertical size={16}/></button><button ref={node => { if (node) optionsButtons.current.set(id, node); else optionsButtons.current.delete(id); }} className="icon-button widget-options-toggle" title="Widget Options" aria-label={`${title} options`} aria-expanded={menu === id} aria-controls={`widget-options-${id}`} onClick={() => setMenu(menu === id ? null : id)}><MoreHorizontal size={17}/></button></div></div>
        {menu === id && <div className="popover widget-options" id={`widget-options-${id}`} role="group" aria-label={`${title} Widget Options`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); } }}><div className="section-heading"><strong>{title}</strong><button className="icon-button widget-options-close" title="Close Widget Options" aria-label="Close Widget Options" onClick={closeMenu}><X size={16}/></button></div>
          <button className="widget-customize" onClick={() => { closeMenu(); setEditor(widget); }}><Settings2 size={16}/>Customize Widget</button>
          <div className="size-options" role="group" aria-label="Widget Size">{sizes.map(size => {
            const label = size === 'square' ? 'Standard' : size.charAt(0).toUpperCase() + size.slice(1);
            return <button key={size} aria-label={label} title={label} aria-pressed={widget.size === size} onClick={() => changeWidget(id, { size })}><span className={`home-size-diagram diagram-${size}`} aria-hidden="true"/></button>;
          })}</div>
          {type === 'next' && !widget.type && <label className="check-label"><input type="checkbox" checked={layout.showCompleted} onChange={event => update({ ...layout, showCompleted: event.target.checked })}/>Show Completed Tasks</label>}
          {type === 'welcome' && <button onClick={() => openSettings('general')}><Clock3 size={16}/>Home Timezone</button>}
          <div className="widget-option-actions"><button className="icon-button" title="Duplicate Widget" aria-label="Duplicate Widget" disabled={layout.widgets.length >= 24} onClick={() => duplicate(widget)}><Copy size={17}/></button>
          <button className="icon-button" title="Hide Widget" aria-label="Hide Widget" onClick={() => { if (changeWidget(id, { hidden: true })) { setMenu(null); setNotice('Widget hidden. Restore it from Add Widget; its content is kept.'); } }}><EyeOff size={17}/></button>
          <button className="icon-button widget-remove" title="Remove Widget" aria-label="Remove Widget" onClick={() => { setMenu(null); setRemoving(widget); }}><Trash2 size={17}/></button></div>
        </div>}
        <div className="widget-body" aria-label={`${title} content`}><HomeWidgetContent id={type} snapshot={snapshot} widget={widget} state={state} draft={draft} dirty={dirty} draftStatus={draftStatus} time={time} date={date} timezone={timezone} now={clock} projectMissing={projectMissing} customize={() => setEditor(widget)} open={open} openSettings={openSettings} newTask={() => newTask(projectId && !projectIsDeleted(snapshot, projectId) ? { projectId } : undefined)} editTask={editTask} complete={complete}/></div>
      </section>;
    })}</div>
    {reorder.order.length > 0 && <p className="board-hint">Use a widget’s move control, or hold its background, to rearrange it. Options include customization, size, and visibility.</p>}
    {removed && <div className="home-board-notice"><span>{widgetTitle(removed.widget)} removed.</span><button onClick={() => {
      if (layout.widgets.length >= 24) { setNotice('Remove another widget before restoring this one.'); return; }
      const widgets = [...layout.widgets]; widgets.splice(Math.min(removed.index, widgets.length), 0, removed.widget);
      if (update({ ...layout, widgets })) setRemoved(null);
    }}>Undo Removal</button></div>}
    {removing && <Dialog title={`Remove ${widgetTitle(removing)}?`} close={() => setRemoving(null)}><p>This removes this widget and its settings from your board. Notes and links inside it will also be removed. Hide it instead to keep everything.</p><div className="button-row"><button onClick={() => setRemoving(null)}>Keep Widget</button><button className="danger" onClick={() => {
      const current = layout.widgets.find(widget => widget.id === removing.id);
      if (current && update({ ...layout, widgets: layout.widgets.filter(widget => widget.id !== current.id) })) { setRemoved({ widget: current, index: layout.widgets.indexOf(current) }); setRemoving(null); }
    }}>Remove Widget</button></div></Dialog>}
    <span className="sr-only" role="status">{reorder.announcement}</span>
    {editor && <Suspense fallback={<Dialog title="Opening widget library" close={() => setEditor(null)}><LoadingRing label="Loading widget choices…"/></Dialog>}><HomeWidgetDialog key={editor === 'new' ? 'new' : editor.id} widget={editor === 'new' ? undefined : editor} widgets={layout.widgets} projects={snapshot.projects} defaultTaskView={layout.showCompleted ? 'all' : 'ready'} storageKey={`e3:home-widget:${snapshot.epoch}:${snapshot.deviceId}:${retainedWindowId}`} onSave={saveWidget} onRestore={id => { persist({ ...layout, widgets: layout.widgets.map(widget => widget.id === id ? { ...widget, hidden: false } : widget) }); setNotice('Widget restored.'); }} close={() => setEditor(null)}/></Suspense>}
  </div>;
}
