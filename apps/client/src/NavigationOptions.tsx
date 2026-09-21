import { useEffect, useId, useRef } from 'react';
import { X } from './icons';

export function NavigationOptions({ label, index, count, move, close, trigger }: {
  label: string;
  index: number;
  count: number;
  move: (index: number) => void;
  close: () => void;
  trigger: HTMLElement | null;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const lastAction = useRef<HTMLButtonElement | null>(null);
  const heading = useId();
  const closeRef = useRef(close); closeRef.current = close;
  const dismiss = () => { closeRef.current(); if (trigger?.isConnected) trigger.focus(); };
  useEffect(() => {
    if (lastAction.current?.disabled) panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [index]);

  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) closeRef.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
      if (trigger?.isConnected) trigger.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [trigger]);

  return <div ref={panel} className="nav-popover popover" role="dialog" aria-labelledby={heading} onClick={event => { if (event.target instanceof HTMLButtonElement) lastAction.current = event.target; }}>
    <div className="section-heading"><strong id={heading}>{label}</strong><button className="icon-button" aria-label="Close navigation options" onClick={dismiss}><X size={18}/></button></div>
    <button disabled={index === 0} onClick={() => move(index - 1)}>Move Earlier</button>
    <button disabled={index === count - 1} onClick={() => move(index + 1)}>Move Later</button>
    <button disabled={index === 0} onClick={() => move(0)}>Move To First</button>
    <button disabled={index === count - 1} onClick={() => move(count - 1)}>Move To Last</button>
  </div>;
}
