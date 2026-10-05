import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { ModuleId } from '../../../packages/domain/contracts';
import { Settings, type Icon } from './icons';
import { NavigationLabels } from './NavigationLabels';
import type { useReorder } from './useReorder';

type Destination = { id: ModuleId; label: string; icon: Icon };
type Props = {
  items: Destination[];
  route: ModuleId | 'settings';
  open: (route: ModuleId | 'settings') => boolean;
  returnToWideNavigation: () => void;
  updateAvailable?: boolean;
  reorder?: ReturnType<typeof useReorder<ModuleId>>;
};
type Drag = { pointer: number; x: number; y: number; left: number; moved: boolean };
const buttonsIn = (strip: HTMLElement) => Array.from(strip.querySelectorAll<HTMLButtonElement>('button[data-navigation-label]'));
const motion = (): ScrollBehavior => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

/** Only the dock scrolls: revealing a module must not move the page or composer. */
function reveal(strip: HTMLElement, button: HTMLElement | null, behavior: ScrollBehavior = 'auto') {
  if (!button || !strip.clientWidth) return;
  const view = strip.getBoundingClientRect(), item = button.getBoundingClientRect();
  const left = item.left < view.left ? item.left - view.left : item.right > view.right ? item.right - view.right : 0;
  if (left) strip.scrollBy({ left, behavior });
}

/** Saved order stays intact; swiping only changes which destinations are visible. */
export function BottomNavigation({ items, route, open, returnToWideNavigation, updateAvailable = false, reorder }: Props) {
  const localStrip = useRef<HTMLDivElement>(null);
  const strip = reorder?.containerRef ?? localStrip;
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const returnFocus = useRef(returnToWideNavigation);
  returnFocus.current = returnToWideNavigation;
  const [progress, setProgress] = useState({ size: 100, position: 0 });
  const order = items.map(item => item.id).join(',');
  const destinations = reorder ? reorder.order.map(id => items.find(item => item.id === id)!).filter(Boolean) : items;

  const measure = () => {
    const node = strip.current;
    if (!node || !node.clientWidth) return;
    const size = Math.min(100, node.clientWidth / node.scrollWidth * 100);
    // Modern RTL scrollers use negative scrollLeft. Logical positioning keeps
    // the progress indicator at the same end as the visible destinations.
    const position = Math.min(100 - size, Math.max(0, Math.abs(node.scrollLeft) / node.scrollWidth * 100));
    setProgress(previous => previous.size === size && previous.position === position ? previous : { size, position });
  };
  const stopDrag = () => {
    const node = strip.current, current = drag.current;
    drag.current = null;
    if (!node || !current) return;
    node.classList.remove('dragging');
    if (current.moved) suppressClick.current = true;
    if (current.moved && node.hasPointerCapture(current.pointer)) node.releasePointerCapture(current.pointer);
  };
  useEffect(() => {
    const node = strip.current;
    if (!node) return;
    const resize = () => {
      if (!window.matchMedia('(max-width: 800px)').matches) {
        stopDrag();
        if (node.contains(document.activeElement)) returnFocus.current();
        return;
      }
      const focused = node.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
      reveal(node, focused ?? node.querySelector<HTMLButtonElement>('[aria-current="page"]'));
      measure();
    };
    // The active destination is revealed on entry, route/order changes, and
    // resize, not on each snapshot render while someone browses the strip.
    if (window.matchMedia('(max-width: 800px)').matches) {
      reveal(node, node.querySelector<HTMLButtonElement>('[aria-current="page"]'));
      measure();
    } else resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    window.addEventListener('resize', resize);
    window.addEventListener('blur', stopDrag);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); window.removeEventListener('blur', stopDrag); stopDrag(); };
  }, [route, order]);

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const node = event.currentTarget;
    stopDrag();
    if (current.moved && event.type === 'pointerup') {
      const bounds = node.getBoundingClientRect(), rtl = getComputedStyle(node).direction === 'rtl';
      const offsets = buttonsIn(node).map(button => {
        const item = button.getBoundingClientRect();
        return rtl ? item.right - bounds.right : item.left - bounds.left;
      });
      const nearest = offsets.reduce((best, offset) => Math.abs(offset) < Math.abs(best) ? offset : best, Infinity);
      if (Number.isFinite(nearest)) node.scrollBy({ left: nearest, behavior: motion() });
    }
  };

  return <NavigationLabels suspended={Boolean(reorder?.dragging)}><nav className="bottom-navigation" data-reorder-host aria-label="Main navigation" aria-description="Swipe or drag to see more sections. Hold a button to move it. Use arrow keys to move between buttons, or Alt and Left or Right to change their order.">
    <div className="bottom-navigation-strip" data-reorder-scroll ref={strip} onScroll={measure}
      onPointerDown={event => {
        suppressClick.current = false;
        if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, moved: false };
      }}
      onPointerMove={event => {
        if (reorder?.dragging) { stopDrag(); return; }
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId) return;
        const dx = event.clientX - current.x, dy = event.clientY - current.y;
        if (!current.moved && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          reorder?.cancel();
          current.moved = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.classList.add('dragging');
        }
        if (current.moved) { event.preventDefault(); event.currentTarget.scrollLeft = current.left - dx; }
      }}
      onPointerUp={finishDrag} onPointerCancel={finishDrag}
      onLostPointerCapture={event => { if (drag.current?.pointer === event.pointerId) stopDrag(); }}
      onPointerLeave={() => { if (drag.current && !drag.current.moved) stopDrag(); }}
      onClickCapture={event => {
        // A synthesized keyboard/assistive click is still valid after a drag.
        if ((suppressClick.current || reorder?.suppressClick.current) && event.detail !== 0) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
      }}
      onFocusCapture={event => { if (!drag.current) reveal(event.currentTarget, event.target.closest<HTMLButtonElement>('button'), motion()); }}
      onContextMenu={event => { if (reorder?.dragging || reorder?.suppressClick.current) event.preventDefault(); }}
      onKeyDown={event => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
        const buttons = buttonsIn(event.currentTarget), target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
        const index = target ? buttons.indexOf(target) : -1;
        if (index < 0) return;
        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
        const delta = event.key === 'ArrowRight' ? (rtl ? -1 : 1) : event.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
        if (event.altKey) {
          const id = target?.dataset.reorderItem as ModuleId | undefined;
          if (delta && id && reorder) { event.preventDefault(); reorder.move(id, reorder.order.indexOf(id) + delta); }
          return;
        }
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : delta ? Math.max(0, Math.min(buttons.length - 1, index + delta)) : null;
        if (next === null) return;
        event.preventDefault();
        buttons[next].focus({ preventScroll: true });
        reveal(event.currentTarget, buttons[next], motion());
      }}>
      {destinations.map(item => { const Icon = item.icon; return <button type="button" key={item.id} className={`bottom-navigation-item${route === item.id ? ' active' : ''}`} aria-label={item.label} aria-description="Hold to move. Alt and Left or Right also changes position." data-navigation-label={item.label} data-reorder-group="bottom-navigation" data-reorder-item={item.id} aria-current={route === item.id ? 'page' : undefined} {...reorder?.bind(item.id)} onClick={() => open(item.id)}><Icon size={20}/></button>; })}
      <button type="button" className={`bottom-navigation-item${route === 'settings' ? ' active' : ''}`} aria-label="Settings" data-navigation-label={updateAvailable ? 'Settings · update available' : 'Settings'} aria-current={route === 'settings' ? 'page' : undefined} aria-description={updateAvailable ? 'Software update available' : undefined} onClick={() => open('settings')}><span className="bottom-navigation-settings-icon"><Settings size={20}/>{updateAvailable && <span className="settings-update-dot" aria-hidden="true"/>}</span></button>
    </div>
    <span className="bottom-navigation-progress" aria-hidden="true" hidden={progress.size >= 100}><span style={{ width: `${progress.size}%`, insetInlineStart: `${progress.position}%` }}/></span>
  </nav></NavigationLabels>;
}
