import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

type Label = { text: string; left: number; top: number };

/** One label for a navigation surface, outside its scrolling/clipping container. */
export function NavigationLabels({ children, placement = 'top', suspended = false }: {
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  placement?: 'right' | 'top';
  suspended?: boolean;
}) {
  const [label, setLabel] = useState<Label | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const tooltip = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimer = () => { clearTimeout(timer.current); };
  const hide = () => { clearTimer(); anchor.current = null; setLabel(null); };
  const buttonAt = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLButtonElement>('button[data-navigation-label]') : null;
  const show = (button: HTMLButtonElement | null, reposition = false) => {
    clearTimer();
    if (!button || (!reposition && button === anchor.current)) return;
    if (!button.getClientRects().length) { hide(); return; }
    const bounds = button.getBoundingClientRect();
    anchor.current = button;
    const next = { text: button.dataset.navigationLabel ?? '', left: placement === 'right' ? bounds.right + 10 : bounds.left + bounds.width / 2, top: placement === 'right' ? bounds.top + bounds.height / 2 : bounds.top - 10 };
    setLabel(previous => previous?.text === next.text && previous.left === next.left && previous.top === next.top ? previous : next);
  };
  const leave = (relatedTarget: EventTarget | null) => {
    if (relatedTarget instanceof Node && (anchor.current?.contains(relatedTarget) || tooltip.current?.contains(relatedTarget))) return;
    clearTimer();
    timer.current = setTimeout(() => {
      if (!anchor.current?.contains(document.activeElement)) hide();
    }, 120);
  };
  useLayoutEffect(() => {
    if (!label || !tooltip.current) return;
    const bounds = tooltip.current.getBoundingClientRect();
    const dx = bounds.left < 8 ? 8 - bounds.left : bounds.right > window.innerWidth - 8 ? window.innerWidth - 8 - bounds.right : 0;
    const dy = bounds.top < 8 ? 8 - bounds.top : bounds.bottom > window.innerHeight - 8 ? window.innerHeight - 8 - bounds.bottom : 0;
    if (dx || dy) setLabel({ ...label, left: label.left + dx, top: label.top + dy });
  }, [label]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (suspended) hide(); }, [suspended]);
  useEffect(() => {
    if (!label) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    // Revealing an off-screen dock button scrolls after focus capture. Keep its
    // keyboard label attached while scrolling; pointer hover labels dismiss.
    const move = () => {
      if (anchor.current?.contains(document.activeElement)) show(anchor.current, true);
      else hide();
    };
    window.addEventListener('keydown', dismiss);
    window.addEventListener('resize', move);
    window.addEventListener('scroll', move, true);
    return () => {
      window.removeEventListener('keydown', dismiss);
      window.removeEventListener('resize', move);
      window.removeEventListener('scroll', move, true);
    };
  }, [label]);
  return <>{cloneElement(children, {
    onPointerOver: event => { children.props.onPointerOver?.(event); if (!suspended && event.pointerType !== 'touch') show(buttonAt(event.target)); },
    onPointerOut: event => { children.props.onPointerOut?.(event); leave(event.relatedTarget); },
    onPointerDownCapture: event => { children.props.onPointerDownCapture?.(event); hide(); },
    onFocusCapture: event => { children.props.onFocusCapture?.(event); if (!suspended) show(buttonAt(event.target)); },
    onBlurCapture: event => { children.props.onBlurCapture?.(event); leave(event.relatedTarget); },
    onClickCapture: event => { children.props.onClickCapture?.(event); hide(); },
    onContextMenuCapture: event => { children.props.onContextMenuCapture?.(event); hide(); },
  })}{label && createPortal(<span ref={tooltip} className={`navigation-label navigation-label-${placement}`} role="tooltip" style={{ left: label.left, top: label.top }} onPointerEnter={clearTimer} onPointerLeave={event => leave(event.relatedTarget)}>{label.text}</span>, anchor.current?.closest('dialog') ?? document.body)}</>;
}
