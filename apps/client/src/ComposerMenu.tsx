import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Anchored disclosure outside the transcript's scrolling and virtualized items. */
export function ComposerMenu({ label, icon, text, className = '', align = 'left', placement = 'above', kind = 'dialog', pinned = false, panelLabel, openRequest = 0, onOpenChange, children }: { label: string; icon: ReactNode; text?: ReactNode; className?: string; align?: 'left' | 'right'; placement?: 'above' | 'below'; kind?: 'dialog' | 'menu'; pinned?: boolean; panelLabel?: string; openRequest?: number; onOpenChange?: (open: boolean) => void; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);
  useEffect(() => { onOpenChange?.(open); }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const menu = panel.current, button = trigger.current; if (!menu || !button) return;
      const anchor = button.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
      const workspace = button.closest('.assistant-workspace')?.getBoundingClientRect();
      const leftEdge = Math.max(8, (workspace?.left ?? 0) + 4), topEdge = Math.max(8, workspace?.top ?? 0);
      const left = Math.min(innerWidth - bounds.width - 8, Math.max(leftEdge, align === 'right' ? anchor.right - bounds.width : anchor.left));
      const above = anchor.top - bounds.height - 10, below = anchor.bottom + 10;
      const fitsBelow = below + bounds.height < innerHeight - 8;
      const top = placement === 'below' && fitsBelow ? below : above >= topEdge ? above : fitsBelow ? below : Math.max(topEdge, innerHeight - bounds.height - 8);
      menu.style.left = `${left}px`; menu.style.top = `${top}px`;
    };
    position();
    if (!pinned) (panel.current?.querySelector<HTMLElement>('form input:not(:disabled),form select:not(:disabled)') ?? panel.current?.querySelector<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]'))?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position); if (panel.current) observer.observe(panel.current);
    const inside = (target: EventTarget | null) => root.current?.contains(target as Node) || panel.current?.contains(target as Node);
    const outside = (event: Event) => {
      if (pinned) return;
      // A touch release focuses its original row after the hold opened the menu.
      if (event.type === 'focusin' && root.current?.closest('.conversation-row')?.contains(event.target as Node)) return;
      if (!inside(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { observer.disconnect(); document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open, align, placement, kind, pinned]);
  return <div className={`composer-menu-anchor ${className}`} ref={root} onKeyDown={event => {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (kind === 'menu' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled)') ?? [])]; if (!items.length) return;
      event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    }
  }}>
    <button ref={trigger} type="button" className={`composer-control-button ${text ? 'composer-labeled-button' : ''}`} aria-label={label} title={label} aria-haspopup={pinned ? undefined : kind} aria-pressed={pinned ? open : undefined} aria-controls={open ? panelId : undefined} aria-expanded={open} onClick={() => setOpen(value => !value)}>{icon}{text && <span className="composer-control-label">{text}</span>}</button>
    {open && createPortal(<div ref={panel} id={panelId} className={`composer-popover ${pinned ? 'pinned-summary' : ''}`} role={pinned ? 'region' : kind} aria-label={panelLabel ?? label}>{children(close)}</div>, trigger.current?.closest('.assistant-workspace') ?? document.body)}
  </div>;
}
