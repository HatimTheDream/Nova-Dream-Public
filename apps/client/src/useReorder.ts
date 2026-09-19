import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { moveItem } from '../../../packages/domain/contracts';
import { containsPoint, reorderCommit, reorderGesture, reorderScrollDelta, reorderTarget, sameOrder, type ReorderBox } from './reorder-motion';

type Visual = { node: HTMLElement; ghost: HTMLElement; left: number; top: number; animation?: Animation };
type Drag<T extends string> = { id: T; x: number; y: number; point: { x: number; y: number }; pointer: number; target: HTMLElement; capture: HTMLElement; touch: boolean; surface: boolean; active: boolean; initial: T[]; order: T[]; timer?: ReturnType<typeof setTimeout>; frame?: number; lastFrame?: number; visual?: Visual; entered?: ReorderBox };
const interactiveSurface = 'button,a,input,textarea,select,option,label,summary,.widget-options,[contenteditable]:not([contenteditable="false"]),[tabindex],[data-reorder-no-drag],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="combobox"],[role="slider"],[role="spinbutton"],[role="textbox"],[role="option"],[role="listbox"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="treeitem"]';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const box = (element: HTMLElement): ReorderBox => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

/** Opt-in motion adds a move handle and a surface hold; Alt+arrows stay equivalent. */
export function useReorder<T extends string>(items: T[], save: (items: T[]) => boolean | void, group: string, options: { motion?: boolean } = {}) {
  const motion = Boolean(options.motion);
  const [preview, setPreview] = useState<T[] | null>(null);
  const [dragging, setDragging] = useState<T | null>(null);
  const [announcement, announce] = useState('');
  const state = useRef<Drag<T> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const positions = useRef<Map<string, ReorderBox>>(new Map());
  const before = useRef<Map<string, ReorderBox> | null>(null);
  const animations = useRef(new Map<HTMLElement, Animation>());
  const ending = useRef<Visual | null>(null);
  const focusAfterMove = useRef<HTMLElement | null>(null);
  const suppressClick = useRef(false);
  const latest = useRef({ items, save }); latest.current = { items, save };
  const nodes = () => [...(containerRef.current?.children ?? [])].filter((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.reorderGroup === group && Boolean(node.dataset.reorderItem));
  const layoutBox = (node: HTMLElement) => {
    const rect = box(node);
    if (animations.current.has(node)) {
      const transform = getComputedStyle(node).transform;
      if (transform !== 'none') { const matrix = new DOMMatrixReadOnly(transform); rect.left -= matrix.m41; rect.top -= matrix.m42; }
    }
    return rect;
  };
  const captureBefore = () => { if (motion) before.current = new Map(nodes().map(node => [node.dataset.reorderItem!, box(node)])); };
  const clearVisual = (visual: Visual) => {
    visual.animation?.cancel(); visual.ghost.remove(); delete visual.node.dataset.reorderPlaceholder;
    if (ending.current === visual) ending.current = null;
  };
  const stopAnimations = () => { for (const animation of animations.current.values()) animation.cancel(); animations.current.clear(); };
  const followPointer = (drag: Drag<T>) => {
    if (drag.visual) drag.visual.ghost.style.transform = `translate3d(${drag.point.x - drag.x}px,${drag.point.y - drag.y}px,0)`;
  };
  const previewAtPointer = (drag: Drag<T>) => {
    if (!motion || !containerRef.current) return;
    // Keep a preview stable while the pointer remains in the area just entered.
    // Variable-width cards can repack several grid cells after one insertion.
    if (drag.entered && containsPoint(drag.entered, drag.point)) return;
    drag.entered = undefined;
    const slots = nodes().map(node => ({ id: node.dataset.reorderItem as T, ...layoutBox(node) }));
    const over = reorderTarget(drag.point, slots);
    if (!over || over === drag.id) return;
    const from = drag.order.indexOf(drag.id), to = drag.order.indexOf(over);
    if (from < 0 || to < 0) return;
    captureBefore(); drag.entered = slots.find(slot => slot.id === over);
    drag.order = moveItem(drag.order, from, to); setPreview([...drag.order]);
  };
  const finish = (commit: boolean) => {
    const drag = state.current; if (!drag) return;
    clearTimeout(drag.timer); if (drag.frame !== undefined) cancelAnimationFrame(drag.frame);
    captureBefore();
    if (drag.visual) ending.current = drag.visual;
    state.current = null; setPreview(null); setDragging(null);
    if (containerRef.current) delete containerRef.current.dataset.reorderActive;
    if (drag.active) {
      suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0);
      const next = motion ? reorderCommit(drag.initial, latest.current.items, drag.order, commit) : commit && !sameOrder(drag.order, latest.current.items) ? drag.order : null;
      if (next) {
        try { if (latest.current.save(next) === false) announce('Move could not be saved.'); else announce(`Moved to position ${next.indexOf(drag.id) + 1} of ${next.length}.`); }
        catch { announce('Move could not be saved.'); }
      } else announce(commit && sameOrder(drag.initial, drag.order) ? 'Position unchanged.' : 'Move cancelled.');
    }
    if (drag.capture.hasPointerCapture(drag.pointer)) drag.capture.releasePointerCapture(drag.pointer);
  };
  const start = (drag: Drag<T>) => {
    if (drag.active || state.current !== drag) return;
    clearTimeout(drag.timer);
    if (motion) {
      const node = nodes().find(item => item.dataset.reorderItem === drag.id);
      if (!node) { finish(false); return; }
      if (ending.current) clearVisual(ending.current);
      const rect = box(node), ghost = node.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('data-reorder-group'); ghost.removeAttribute('data-reorder-item'); ghost.removeAttribute('data-reorder-placeholder'); ghost.removeAttribute('id');
      for (const child of ghost.querySelectorAll('[id]')) child.removeAttribute('id');
      ghost.classList.remove('dragging'); ghost.classList.add('reorder-floating'); ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
      Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      node.closest('.home-page')?.append(ghost);
      node.dataset.reorderPlaceholder = 'true';
      drag.visual = { node, ghost, left: rect.left, top: rect.top };
      if (containerRef.current) containerRef.current.dataset.reorderActive = 'true';
      const selection = window.getSelection();
      if (selection?.anchorNode && node.contains(selection.anchorNode)) selection.removeAllRanges();
      followPointer(drag);
    }
    drag.active = true; setDragging(drag.id); setPreview(drag.order);
    // Capture on the stable scrolling surface: moving a keyed item in the DOM can
    // release capture on that item and silently cancel the gesture.
    drag.capture.setPointerCapture(drag.pointer);
    if (motion) {
      const scroll = (time: number) => {
        if (state.current !== drag || !drag.active) return;
        const rect = drag.capture.getBoundingClientRect(), elapsed = drag.lastFrame === undefined ? 16 : time - drag.lastFrame;
        drag.lastFrame = time;
        if (drag.point.x >= rect.left && drag.point.x <= rect.right) {
          const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom), oldTop = drag.capture.scrollTop;
          drag.capture.scrollTop += reorderScrollDelta(drag.point.y, top, bottom, elapsed);
          const delta = drag.capture.scrollTop - oldTop;
          if (delta) {
            if (drag.entered) drag.entered = { ...drag.entered, top: drag.entered.top - delta };
            previewAtPointer(drag);
          }
        }
        drag.frame = requestAnimationFrame(scroll);
      };
      drag.frame = requestAnimationFrame(scroll);
    }
  };
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!motion || !container) return;
    container.dataset.reorderMotion = 'true';
    if (state.current?.active && !sameOrder(state.current.initial, items)) { finish(false); return; }
    const elements = nodes(), next = new Map(elements.map(node => [node.dataset.reorderItem!, layoutBox(node)]));
    const moved = [...next].some(([id, rect]) => {
      const previous = positions.current.get(id);
      return previous && (Math.abs(previous.left - rect.left) > .5 || Math.abs(previous.top - rect.top) > .5);
    });
    if (moved && before.current) {
      for (const node of elements) {
        const id = node.dataset.reorderItem!, from = before.current?.get(id) ?? positions.current.get(id), to = next.get(id)!;
        animations.current.get(node)?.cancel(); animations.current.delete(node);
        if (!from || reducedMotion() || node.dataset.reorderPlaceholder) continue;
        const x = from.left - to.left, y = from.top - to.top;
        if (Math.abs(x) < .5 && Math.abs(y) < .5) continue;
        const animation = node.animate([{ transform: `translate(${x}px,${y}px)` }, { transform: 'translate(0,0)' }], { duration: 220, easing: 'cubic-bezier(.2,.75,.25,1)' });
        animations.current.set(node, animation);
        void animation.finished.then(() => { if (animations.current.get(node) === animation) animations.current.delete(node); }, () => {});
      }
    }
    positions.current = next; before.current = null;
    if (focusAfterMove.current?.isConnected) focusAfterMove.current.focus({ preventScroll: true });
    focusAfterMove.current = null;
    const visual = ending.current;
    if (visual && !visual.animation) {
      const target = next.get(visual.node.dataset.reorderItem!);
      if (!target || reducedMotion()) clearVisual(visual);
      else {
        const start = box(visual.ghost);
        visual.animation = visual.ghost.animate([
          { transform: `translate3d(${start.left - visual.left}px,${start.top - visual.top}px,0)` },
          { transform: `translate3d(${target.left - visual.left}px,${target.top - visual.top}px,0)` },
        ], { duration: 180, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'forwards' });
        void visual.animation.finished.then(() => { if (ending.current === visual) clearVisual(visual); }, () => {});
      }
    }
  });
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(false); };
    const touchMove = (event: TouchEvent) => { if (state.current?.active) event.preventDefault(); };
    const move = (event: PointerEvent) => {
      const drag = state.current; if (!drag || event.pointerId !== drag.pointer) return;
      drag.point = { x: event.clientX, y: event.clientY };
      const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
      if (!drag.active) {
        const action = reorderGesture(distance, drag.surface, drag.touch, motion);
        if (action === 'cancel') { finish(false); return; }
        if (action === 'start') start(drag);
      }
      if (!drag.active) return;
      event.preventDefault();
      if (motion) { followPointer(drag); previewAtPointer(drag); return; }
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(`[data-reorder-group="${group}"][data-reorder-item]`);
      const over = target?.dataset.reorderItem as T | undefined;
      if (over && over !== drag.id) { drag.order = moveItem(drag.order, drag.order.indexOf(drag.id), drag.order.indexOf(over)); setPreview([...drag.order]); }
      const box = drag.capture.getBoundingClientRect();
      if (event.clientY < box.top + 40) drag.capture.scrollBy(0, -16);
      if (event.clientY > box.bottom - 40) drag.capture.scrollBy(0, 16);
    };
    const up = (event: PointerEvent) => { if (event.pointerId === state.current?.pointer) finish(true); };
    const lost = (event: PointerEvent) => { if (event.pointerId === state.current?.pointer) finish(false); };
    const blur = () => finish(false);
    const resize = () => { if (motion) { finish(false); stopAnimations(); positions.current.clear(); } };
    window.addEventListener('keydown', cancel); document.addEventListener('touchmove', touchMove, { passive: false });
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', lost); window.addEventListener('lostpointercapture', lost); window.addEventListener('blur', blur);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('keydown', cancel); document.removeEventListener('touchmove', touchMove);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', lost); window.removeEventListener('lostpointercapture', lost); window.removeEventListener('blur', blur);
      window.removeEventListener('resize', resize);
      const drag = state.current; state.current = null;
      if (drag) {
        clearTimeout(drag.timer); if (drag.frame !== undefined) cancelAnimationFrame(drag.frame);
        if (drag.visual) clearVisual(drag.visual);
        if (drag.capture.hasPointerCapture(drag.pointer)) drag.capture.releasePointerCapture(drag.pointer);
      }
      if (ending.current) clearVisual(ending.current);
      stopAnimations();
    };
  }, []);
  const bind = (id: T, surface = false) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !event.isPrimary || state.current) return;
      if (surface) {
        if (!motion || !(event.target instanceof Element)) return;
        const interactive = event.target.closest(interactiveSurface);
        if (interactive && event.currentTarget.contains(interactive)) return;
      }
      if (ending.current) clearVisual(ending.current);
      const drag: Drag<T> = { id, x: event.clientX, y: event.clientY, point: { x: event.clientX, y: event.clientY }, pointer: event.pointerId, target: event.currentTarget, capture: event.currentTarget.closest<HTMLElement>('[data-reorder-scroll]') ?? event.currentTarget, touch: event.pointerType === 'touch', surface, active: false, initial: [...latest.current.items], order: [...latest.current.items] };
      state.current = drag;
      if (surface || drag.touch) drag.timer = setTimeout(() => { if (state.current === drag) start(drag); }, 350);
    },
  });
  const bindSurface = (id: T) => ({
    ...bind(id, true),
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => { if (state.current?.id === id && state.current.active) event.preventDefault(); },
  });
  const move = (id: T, to: number) => {
    if (state.current || items.indexOf(id) < 0) return;
    const next = moveItem(items, items.indexOf(id), to);
    if (sameOrder(next, items)) return;
    captureBefore();
    if (motion && document.activeElement instanceof HTMLElement && containerRef.current?.contains(document.activeElement)) focusAfterMove.current = document.activeElement;
    try { if (save(next) === false) announce('Move could not be saved.'); else announce(`Moved to position ${next.indexOf(id) + 1} of ${next.length}.`); }
    catch { announce('Move could not be saved.'); }
  };
  const order = motion && state.current && !sameOrder(state.current.initial, items) ? items : preview ?? items;
  return { order, dragging, announcement, bind, bindSurface, move, suppressClick, containerRef };
}
