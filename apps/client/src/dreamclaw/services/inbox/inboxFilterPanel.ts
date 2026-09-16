export interface InboxFilterPanelRect {
  top: number;
  right: number;
  bottom: number;
}

export interface InboxFilterPanelViewport {
  width: number;
  height: number;
  topInset?: number;
}

export interface InboxFilterPanelGeometry {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: 'above' | 'below';
}

const PANEL_MARGIN = 12;
const PANEL_GAP = 8;
const MIN_USEFUL_HEIGHT = 160;
const MAX_PANEL_HEIGHT = 620;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function resolveInboxFilterPanelGeometry(
  trigger: InboxFilterPanelRect,
  viewport: InboxFilterPanelViewport,
  preferredWidth = 360,
): InboxFilterPanelGeometry {
  const safeTop = Math.max(PANEL_MARGIN, (viewport.topInset || 0) + PANEL_MARGIN);
  const width = Math.min(
    Math.max(220, preferredWidth),
    Math.max(220, viewport.width - PANEL_MARGIN * 2),
  );
  const left = clamp(
    trigger.right - width,
    PANEL_MARGIN,
    viewport.width - width - PANEL_MARGIN,
  );
  const belowTop = trigger.bottom + PANEL_GAP;
  const belowSpace = Math.max(0, viewport.height - PANEL_MARGIN - belowTop);
  const aboveSpace = Math.max(0, trigger.top - PANEL_GAP - safeTop);
  const placement = belowSpace < MIN_USEFUL_HEIGHT && aboveSpace > belowSpace ? 'above' : 'below';
  const availableHeight = placement === 'above' ? aboveSpace : belowSpace;
  const maxHeight = Math.max(96, Math.min(MAX_PANEL_HEIGHT, availableHeight));
  const top = placement === 'above'
    ? Math.max(safeTop, trigger.top - PANEL_GAP - maxHeight)
    : belowTop;

  return { top, left, width, maxHeight, placement };
}
