export type ReorderPoint = { x: number; y: number };
export type ReorderBox = { left: number; top: number; width: number; height: number };
export type ReorderSlot<T extends string = string> = ReorderBox & { id: T };

export const sameOrder = (first: readonly string[], second: readonly string[]) => first.length === second.length && first.every((id, index) => id === second[index]);
export const containsPoint = (box: ReorderBox, point: ReorderPoint) => point.x >= box.left && point.x <= box.left + box.width && point.y >= box.top && point.y <= box.top + box.height;

/** Surface holds yield to text selection and native scrolling before activation. */
export function reorderGesture(distance: number, surface: boolean, touch: boolean, motion: boolean): 'wait' | 'start' | 'cancel' {
  if (surface || touch && !motion) return distance > 8 ? 'cancel' : 'wait';
  return distance >= 6 ? 'start' : 'wait';
}

/** Work from layout boxes, not the moving card or its neighbors' animations. */
export function reorderTarget<T extends string>(point: ReorderPoint, slots: readonly ReorderSlot<T>[], maximumGap = 28): T | null {
  let closest: { id: T; distance: number; center: number } | undefined;
  for (const slot of slots) {
    const dx = Math.max(slot.left - point.x, 0, point.x - slot.left - slot.width);
    const dy = Math.max(slot.top - point.y, 0, point.y - slot.top - slot.height);
    const distance = Math.hypot(dx, dy);
    const center = Math.hypot(point.x - slot.left - slot.width / 2, point.y - slot.top - slot.height / 2);
    if (distance <= maximumGap && (!closest || distance < closest.distance || distance === closest.distance && center < closest.center)) closest = { id: slot.id, distance, center };
  }
  return closest?.id ?? null;
}

/** A bounded velocity keeps scrolling while the pointer rests at an edge. */
export function reorderScrollDelta(y: number, top: number, bottom: number, elapsedMs: number): number {
  const edge = Math.min(64, Math.max(0, (bottom - top) / 4));
  if (!edge || y < top - edge || y > bottom + edge) return 0;
  const direction = y < top + edge ? -Math.min(1, (top + edge - y) / edge) : y > bottom - edge ? Math.min(1, (y - bottom + edge) / edge) : 0;
  return direction * 900 * Math.min(32, Math.max(0, elapsedMs)) / 1000;
}

/** A drag must not overwrite an order changed elsewhere while it was held. */
export function reorderCommit<T extends string>(initial: readonly T[], current: readonly T[], preview: readonly T[], commit: boolean): T[] | null {
  if (!commit || !sameOrder(initial, current) || sameOrder(current, preview) || preview.length !== initial.length || new Set(preview).size !== preview.length || preview.some(id => !initial.includes(id))) return null;
  return [...preview];
}
