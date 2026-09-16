export interface InboxWheelIntent {
  ctrlKey: boolean;
  deltaX: number;
  deltaY: number;
  targetBlocksDelegation: boolean;
  targetCanConsume: boolean;
}

/** Keep native zoom, horizontal gestures, controls, and nested scrollers in charge. */
export function shouldDelegateInboxWheel(intent: InboxWheelIntent): boolean {
  if (intent.ctrlKey || intent.targetBlocksDelegation || intent.targetCanConsume) return false;
  if (!Number.isFinite(intent.deltaY) || intent.deltaY === 0) return false;
  return Math.abs(intent.deltaY) > Math.abs(intent.deltaX);
}

export function normalizeInboxWheelDelta(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number,
): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * Math.max(1, viewportHeight);
  return deltaY;
}

export function inboxKeyboardScrollAmount(
  key: string,
  shiftKey: boolean,
  viewportHeight: number,
): number | 'start' | 'end' | null {
  const page = Math.max(1, viewportHeight * 0.9);
  if (key === 'PageUp') return -page;
  if (key === 'PageDown') return page;
  if (key === 'Home') return 'start';
  if (key === 'End') return 'end';
  if (key === 'ArrowUp') return -40;
  if (key === 'ArrowDown') return 40;
  if (key === ' ') return shiftKey ? -page : page;
  return null;
}
