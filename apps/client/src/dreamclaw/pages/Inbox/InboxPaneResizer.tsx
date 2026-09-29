import type { ReactNode } from 'react';

export function InboxPaneResizer({ width, min, max, defaultWidth, resize, startResize, children }: {
  width: number; min: number; max: number; defaultWidth: number;
  resize(width: number): void; startResize(): void; children: ReactNode;
}) {
  const change = (next: number) => resize(Math.min(max, Math.max(min, next)));
  return <button type="button" role="separator" aria-label="Resize inbox panes" aria-orientation="vertical"
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} pixels wide`}
    title="Resize with Left and Right arrows. Home and End choose the limits; Enter resets."
    onMouseDown={startResize} onDoubleClick={() => change(defaultWidth)}
    onKeyDown={event => {
      const next = event.key === 'ArrowLeft' ? width - 16 : event.key === 'ArrowRight' ? width + 16
        : event.key === 'Home' ? min : event.key === 'End' ? max : event.key === 'Enter' || event.key === ' ' ? defaultWidth : undefined;
      if (next === undefined) return;
      event.preventDefault(); change(next);
    }} className="group flex h-full w-4 cursor-col-resize items-center justify-center">{children}</button>;
}
