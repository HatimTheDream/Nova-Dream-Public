import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { moveItem } from '../../../packages/domain/contracts';

/** Click on release; touch scroll wins before hold; menus/Alt+arrows are equivalent. */
export function useReorder<T extends string>(items: T[], save: (items: T[]) => void, group: string) {
  const [preview, setPreview] = useState<T[] | null>(null);
  const [dragging, setDragging] = useState<T | null>(null);
  const [announcement, announce] = useState('');
  const state = useRef<{ id: T; x: number; y: number; pointer: number; target: HTMLElement; capture: HTMLElement; touch: boolean; active: boolean; order: T[]; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const suppressClick = useRef(false);
  const latest = useRef({ items, save }); latest.current = { items, save };
  const finish = (commit: boolean) => {
    const drag = state.current; if (!drag) return;
    clearTimeout(drag.timer);
    state.current = null; setPreview(null); setDragging(null);
    if (drag.active) {
      suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0);
      if (commit && drag.order.join() !== latest.current.items.join()) { latest.current.save(drag.order); announce(`Moved to position ${drag.order.indexOf(drag.id) + 1} of ${drag.order.length}.`); }
      else announce('Move cancelled.');
    }
    if (drag.capture.hasPointerCapture(drag.pointer)) drag.capture.releasePointerCapture(drag.pointer);
  };
  const start = (drag: NonNullable<typeof state.current>) => {
    drag.active = true; setDragging(drag.id); setPreview(drag.order);
    // Capture on the stable scrolling surface: moving a keyed item in the DOM can
    // release capture on that item and silently cancel the gesture.
    drag.capture.setPointerCapture(drag.pointer);
  };
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(false); };
    const touchMove = (event: TouchEvent) => { if (state.current?.active) event.preventDefault(); };
    const move = (event: PointerEvent) => {
      const drag = state.current; if (!drag || event.pointerId !== drag.pointer) return;
      const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
      if (!drag.active) {
        if (drag.touch && distance > 8) { finish(false); return; }
        if (!drag.touch && distance >= 6) start(drag);
      }
      if (!drag.active) return;
      event.preventDefault();
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
    window.addEventListener('keydown', cancel); document.addEventListener('touchmove', touchMove, { passive: false });
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', lost); window.addEventListener('lostpointercapture', lost); window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', cancel); document.removeEventListener('touchmove', touchMove);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', lost); window.removeEventListener('lostpointercapture', lost); window.removeEventListener('blur', blur);
      if (state.current) clearTimeout(state.current.timer);
    };
  }, []);
  const bind = (id: T) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const drag: NonNullable<typeof state.current> = { id, x: event.clientX, y: event.clientY, pointer: event.pointerId, target: event.currentTarget, capture: event.currentTarget.closest<HTMLElement>('[data-reorder-scroll]') ?? event.currentTarget, touch: event.pointerType === 'touch', active: false, order: [...latest.current.items] };
      state.current = drag;
      if (drag.touch) drag.timer = setTimeout(() => { if (state.current === drag) start(drag); }, 350);
    },
  });
  const move = (id: T, to: number) => { const next = moveItem(items, items.indexOf(id), to); save(next); announce(`Moved to position ${next.indexOf(id) + 1} of ${next.length}.`); };
  return { order: preview ?? items, dragging, announcement, bind, move, suppressClick };
}
