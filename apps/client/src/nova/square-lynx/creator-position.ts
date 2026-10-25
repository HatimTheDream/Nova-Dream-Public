type Bounds = { left: number; right: number; top: number; bottom: number };
/** Fixed-position color controls stay inside both the visible viewport and their
 * current editor. A short viewport scrolls the picker rather than clipping it. */
export function creatorColorPosition(target: { left: number; bottom: number }, popup: { width: number; height: number }, viewport: Bounds, editor?: Bounds) {
  const left = Math.max(viewport.left, editor?.left ?? viewport.left) + 4;
  const right = Math.min(viewport.right, editor?.right ?? viewport.right) - 4;
  const top = Math.max(viewport.top, editor?.top ?? viewport.top) + 4;
  const bottom = Math.min(viewport.bottom, editor?.bottom ?? viewport.bottom) - 4;
  const maxWidth = Math.max(0, right - left), maxHeight = Math.max(0, bottom - top);
  if (maxWidth < 44 || maxHeight < 44) return;
  return {
    left: Math.max(left, Math.min(target.left, right - Math.min(popup.width, maxWidth))),
    top: Math.max(top, Math.min(target.bottom + 6, bottom - Math.min(popup.height, maxHeight))),
    maxWidth, maxHeight,
  };
}
