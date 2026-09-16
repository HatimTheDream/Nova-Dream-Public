/** Shared eight-way headings and bounded presentation motions. No work state lives here. */
export const lynxDirections = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type LynxDirection = typeof lynxDirections[number];
export type LynxMotion = 'idle' | 'walk' | 'sit-down' | 'seated-work' | 'stand-up' | 'wave' | 'talk' | 'listen' | 'seated-talk' | 'seated-idle' | 'read' | 'stretch';
export type LynxExpression = 'neutral' | 'happy' | 'focused' | 'blink';
export function directionFromVector(x: number, y: number, previous: LynxDirection = 'S'): LynxDirection {
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) < .001) return previous;
  return lynxDirections[(Math.round(Math.atan2(x, -y) / (Math.PI / 4)) + 8) % 8];
}
export function motionPhase(motion: LynxMotion, elapsedSeconds: number, reduced = false) {
  const elapsed = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0);
  const progress = Math.min(1, elapsed / .6), eased = progress * progress * (3 - 2 * progress);
  return {
    step: !reduced && motion === 'walk' ? Math.floor(elapsed * 10) % 8 : 0,
    seated: ['seated-work', 'seated-idle', 'seated-talk', 'read'].includes(motion) ? 1 : motion === 'sit-down' ? reduced ? 1 : eased : motion === 'stand-up' ? reduced ? 0 : 1 - eased : 0,
    wave: !reduced && motion === 'wave' ? Math.sin(elapsed * 7) : 0,
    blink: !reduced && elapsed % 4.6 > 4.4,
  };
}

/** Advance through adjacent headings instead of snapping across a half turn. */
export function turnToward(current: LynxDirection, target: LynxDirection): LynxDirection {
  const from=lynxDirections.indexOf(current), to=lynxDirections.indexOf(target), delta=(to-from+8)%8;
  return delta===0?current:lynxDirections[(from+(delta<=4?1:7))%8];
}
