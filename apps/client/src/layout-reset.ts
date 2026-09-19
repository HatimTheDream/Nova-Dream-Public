import type { Layout } from '../../../packages/domain/contracts';
import { legacyHomeWidgetIds, type HomeWidget } from '../../../packages/domain/home-widgets';

type Arrangement = Pick<HomeWidget, 'id' | 'size' | 'hidden'>;
export type LayoutResetUndo =
  | { kind: 'navigation'; nav: Layout['nav'] }
  | { kind: 'home'; order: string[]; originals: Arrangement[]; showCompleted: boolean };

/** Keep only what reset changes. Widget content never belongs in an undo receipt. */
export function captureLayoutReset(layout: Layout, kind: LayoutResetUndo['kind']): LayoutResetUndo {
  if (kind === 'navigation') return { kind, nav: [...layout.nav] };
  return {
    kind,
    order: layout.widgets.map(widget => widget.id),
    originals: layout.widgets.filter(widget => legacyHomeWidgetIds.some(id => id === widget.id))
      .map(({ id, size, hidden }) => ({ id, size, hidden })),
    showCompleted: layout.showCompleted,
  };
}

/** Undo against today's board: retain edits/additions and never revive removals. */
export function undoLayoutReset(current: Layout, undo: LayoutResetUndo): Layout {
  if (undo.kind === 'navigation') return { ...current, nav: [...undo.nav] };
  const originals = new Map(undo.originals.map(widget => [widget.id, widget]));
  const widgets = new Map(current.widgets.map(widget => {
    const arrangement = originals.get(widget.id);
    return [widget.id, arrangement ? { ...widget, size: arrangement.size, hidden: arrangement.hidden } : widget];
  }));
  const priorIds = new Set(undo.order);
  return {
    ...current,
    widgets: [...undo.order.flatMap(id => widgets.has(id) ? [widgets.get(id)!] : []),
      ...current.widgets.filter(widget => !priorIds.has(widget.id))],
    showCompleted: undo.showCompleted,
  };
}
