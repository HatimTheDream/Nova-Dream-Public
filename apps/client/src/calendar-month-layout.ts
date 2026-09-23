export const monthEventGeometry = { event: 20, more: 16, gap: 2, maximum: 3 };

/** Keep complete rows and reserve room for the count whenever any event is hidden. */
export function monthEventLayout(count: number, availableHeight: number) {
  const total = Math.max(0, Math.floor(count));
  const height = Number.isFinite(availableHeight) ? Math.max(0, availableHeight) : 0;
  const { event, more, gap, maximum } = monthEventGeometry;
  for (let visible = Math.min(total, maximum); visible >= 0; visible--) {
    const hidden = total - visible;
    const needed = visible * event + (hidden ? more : 0) + Math.max(0, visible + Number(hidden > 0) - 1) * gap;
    if (needed <= height) return { visible, hidden, inlineOverflow: false };
  }
  return { visible: 0, hidden: total, inlineOverflow: total > 0 };
}
