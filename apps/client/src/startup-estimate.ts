export type StartupPoint = { percent: number; ms: number };
export type StartupTiming = { at: number; points: StartupPoint[] };
const maxDuration = 5 * 60_000;
const retention = 14 * 24 * 60 * 60_000;

/** Timing samples contain only elapsed milliseconds and progress, kept on this device. */
export function startupHistory(value: unknown, now: number): StartupTiming[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is StartupTiming => {
    if (!entry || !Number.isFinite(entry.at) || entry.at > now || now - entry.at > retention || !Array.isArray(entry.points) || entry.points.length < 2 || entry.points.length > 101) return false;
    const points = entry.points as StartupPoint[];
    return points[0]?.percent === 0 && points[0]?.ms === 0 && points.at(-1)?.percent === 100 && points.at(-1)!.ms >= 500 && points.at(-1)!.ms <= maxDuration && points.every((point, i) => point && Number.isInteger(point.percent) && Number.isFinite(point.ms) && point.percent >= 0 && point.percent <= 100 && point.ms >= 0 && (!i || point.percent > points[i - 1].percent && point.ms >= points[i - 1].ms));
  }).slice(-5);
}

function timeAt(points: StartupPoint[], percent: number) {
  const end = points.findIndex(point => point.percent >= percent);
  if (end <= 0) return points[0].ms;
  const a = points[end - 1], b = points[end];
  return a.ms + (b.ms - a.ms) * (percent - a.percent) / (b.percent - a.percent);
}
const median = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.floor(sorted.length / 2)]; };

/** Estimate a deadline at an observed advance; clock ticks never manufacture progress. */
export function startupRemaining(points: StartupPoint[], elapsed: number, history: StartupTiming[]): number | undefined {
  const last = points.at(-1)!;
  if (last.percent >= 100) return 0;
  if (elapsed - last.ms > 15_000) return undefined;
  let remaining: number;
  if (history.length) {
    const expectedElapsed = median(history.map(run => timeAt(run.points, last.percent)));
    const expectedRemaining = median(history.map(run => run.points.at(-1)!.ms - timeAt(run.points, last.percent)));
    const pace = expectedElapsed >= 2_000 && last.ms >= 2_000 ? Math.max(.5, Math.min(3, last.ms / expectedElapsed)) : 1;
    remaining = expectedRemaining * pace;
  } else {
    // A first run needs an observed preparation advance, not just a few downloaded bytes.
    if (last.percent < 25 || last.ms < 2_000 || points.length < 3) return undefined;
    remaining = last.ms * (100 - last.percent) / last.percent;
  }
  const left = remaining - (elapsed - last.ms);
  return left >= 1_000 ? left : undefined;
}

export function startupWaitLabel(remaining: number | undefined, elapsed: number, complete: boolean) {
  if (complete) return 'Ready';
  if (remaining === undefined) return elapsed < 15_000 ? 'Estimating time remaining…' : 'Updating time estimate…';
  if (remaining <= 5_000) return 'A few seconds left';
  const seconds = Math.ceil(remaining / 5_000) * 5;
  if (seconds < 60) return `About ${seconds} seconds left`;
  const rounded = Math.ceil(seconds / 15) * 15, minutes = Math.floor(rounded / 60), rest = rounded % 60;
  return `About ${minutes} min${rest ? ` ${rest} sec` : ''} left`;
}

export class StartupClock {
  readonly points: StartupPoint[] = [{ percent: 0, ms: 0 }];
  private start: number;
  private invalid = false;
  constructor(now: number) { this.start = now; }
  elapsed(now: number) { return Math.max(0, now - this.start); }
  observe(percent: number, now: number) {
    const next = Math.max(0, Math.min(100, Math.floor(percent)));
    if (Number.isFinite(next) && next > this.points.at(-1)!.percent) this.points.push({ percent: next, ms: this.elapsed(now) });
  }
  interrupt() { this.invalid = true; }
  finish(now: number, at: number): StartupTiming | undefined {
    if (this.invalid) return;
    this.observe(100, now);
    const result = { at, points: this.points.map(point => ({ ...point })) };
    return startupHistory([result], at)[0];
  }
}
