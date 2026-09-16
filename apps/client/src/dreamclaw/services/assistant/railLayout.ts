export const ASSISTANT_RAIL_DEFAULT_WIDTH = 272;
export const ASSISTANT_RAIL_MIN_WIDTH = 272;
export const ASSISTANT_RAIL_MAX_WIDTH = 420;

export function clampAssistantRailWidth(width: number): number {
  if (!Number.isFinite(width)) return ASSISTANT_RAIL_DEFAULT_WIDTH;
  return Math.round(Math.min(ASSISTANT_RAIL_MAX_WIDTH, Math.max(ASSISTANT_RAIL_MIN_WIDTH, width)));
}
