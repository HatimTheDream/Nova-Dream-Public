import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, AlertCircle } from './icons';

export function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; ref.current?.showModal(); ref.current?.querySelector<HTMLElement>('input:not([type=hidden]),textarea')?.focus(); return () => previous?.focus(); }, []);
  return <dialog ref={ref} className="dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); closeRef.current(); }} onClick={event => { if (event.target === event.currentTarget) closeRef.current(); }}><div className="dialog-inner"><div className="section-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={20}/></button></div>{children}</div></dialog>;
}
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}
export function Conflict({ name, message, current, reapply, discard, reapplyLabel = 'Save my version' }: { name: string; message: string; current?: string; reapply: () => void; discard: () => void; reapplyLabel?: string }) {
  return <div className="notice warning" role="alert"><AlertCircle size={20}/><div><strong>{name} needs review</strong><p>{message}</p>{current && <details><summary>View the host version</summary><pre className="conflict-copy">{current}</pre></details>}<div className="button-row"><button onClick={reapply}>{reapplyLabel}</button><button className="quiet" onClick={discard}>Use host version</button></div></div></div>;
}
export function formatSaved(value: string) { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
