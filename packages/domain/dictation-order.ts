import type { DictationTurn } from './dictation.js';

/** Audio item order is independent of when each phrase finishes transcribing.
 * Older saved turns have no ordering metadata and retain their arrival order. */
export function orderDictationTurns(turns: DictationTurn[]) {
  const remaining = [...turns].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)), ordered: DictationTurn[] = [];
  const outstanding = new Set(remaining.map(t => t.id));
  while (remaining.length) {
    const index = remaining.findIndex(t => !t.previousTurnId || !outstanding.has(t.previousTurnId));
    // Keep bounded, deterministic recovery even for malformed historical cycles.
    const [turn] = remaining.splice(index < 0 ? 0 : index, 1); ordered.push(turn); outstanding.delete(turn.id);
  }
  return ordered;
}
