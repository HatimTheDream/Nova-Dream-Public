import { useCallback, useEffect, useRef, useState } from 'react';

/** One owner for following live output. Upward intent wins before the next token. */
export function useTranscriptScroll(parent: HTMLElement | null, canFollow = true) {
  const following = useRef(true), restoring = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const latest = useCallback(() => { restoring.current = false; following.current = true; setShowLatest(false); if (parent) parent.scrollTop = parent.scrollHeight; }, [parent]);
  const beginRestore = useCallback(() => { restoring.current = true; following.current = false; setShowLatest(true); }, []);
  const endRestore = useCallback(() => { restoring.current = false; }, []);
  useEffect(() => {
    if (!parent) return;
    if (!canFollow) { following.current = false; setShowLatest(true); }
    let previousTop = parent.scrollTop, previousHeight = parent.scrollHeight, previousViewport = parent.clientHeight, finger = 0, frame = 0, settling = false;
    const stopFollowing = () => { restoring.current = false; following.current = false; setShowLatest(true); };
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) stopFollowing(); };
    const touchStart = (event: TouchEvent) => { finger = event.touches[0]?.clientY ?? 0; };
    const touchMove = (event: TouchEvent) => { const next = event.touches[0]?.clientY ?? finger; if (next > finger + 1) stopFollowing(); finger = next; };
    const key = (event: KeyboardEvent) => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && !(event.target as HTMLElement).closest('input,textarea,[contenteditable=true]')) stopFollowing(); };
    const pointer = (event: PointerEvent) => { if (event.target === parent && event.clientX >= parent.getBoundingClientRect().left + parent.clientWidth) stopFollowing(); };
    const scroll = () => {
      const top = parent.scrollTop, height = parent.scrollHeight, viewport = parent.clientHeight, bottom = height - viewport - top <= 2;
      const resized = height !== previousHeight || viewport !== previousViewport;
      // Shrinking the composer expands the reading viewport, which can clamp
      // scrollTop upward before ResizeObserver runs. That is layout, not a
      // request to stop following the reply. Explicit upward input still wins.
      if (!restoring.current && !settling && !resized && top < previousTop - 1) stopFollowing();
      // A layout change must not re-enable follow; arriving at the bottom by scrolling down can.
      if (canFollow && !restoring.current && !resized && bottom && top > previousTop && !following.current) { following.current = true; setShowLatest(false); }
      previousTop = top; previousHeight = height; previousViewport = viewport;
    };
    const fit = () => {
      if (!following.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!following.current) return;
        settling = true; parent.scrollTop = parent.scrollHeight; previousTop = parent.scrollTop; previousHeight = parent.scrollHeight; previousViewport = parent.clientHeight;
        frame = requestAnimationFrame(() => { settling = false; });
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(parent);
    const observeChildren = () => { for (const child of parent.children) observer.observe(child); fit(); };
    const mutations = new MutationObserver(observeChildren); mutations.observe(parent, { childList: true }); observeChildren();
    parent.addEventListener('wheel', wheel, { passive: true }); parent.addEventListener('touchstart', touchStart, { passive: true }); parent.addEventListener('touchmove', touchMove, { passive: true }); parent.addEventListener('keydown', key); parent.addEventListener('pointerdown', pointer); parent.addEventListener('scroll', scroll, { passive: true });
    return () => { observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame); parent.removeEventListener('wheel', wheel); parent.removeEventListener('touchstart', touchStart); parent.removeEventListener('touchmove', touchMove); parent.removeEventListener('keydown', key); parent.removeEventListener('pointerdown', pointer); parent.removeEventListener('scroll', scroll); };
  }, [parent, canFollow]);
  return { following, restoring, beginRestore, endRestore, showLatest, latest };
}
