import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from './icons';

/** A desktop adjoining panel becomes a focused modal workspace below the dock boundary. */
export function TaskDetailsShell({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, media = matchMedia('(max-width: 800px)');
    const open = () => { const element = dialog.current; if (!element) return; element.close(); if (media.matches) element.showModal(); else element.show(); };
    open(); media.addEventListener('change', open);
    dialog.current?.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden]) input:not(:disabled),[role="tab"][aria-selected="true"]')?.focus();
    return () => { media.removeEventListener('change', open); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="task-details-shell" aria-labelledby={titleId}
    onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); closeRef.current(); }}
    onClick={event => { if (event.target === event.currentTarget) closeRef.current(); }}
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented && (event.target as HTMLElement).closest('dialog') === event.currentTarget) { event.preventDefault(); closeRef.current(); } }}>
    <header className="task-details-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close Task Details" onClick={close}><X size={20}/></button></header>
    {children}
  </dialog>;
}
