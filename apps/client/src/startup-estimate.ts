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

/** Progress speed (percent per millisecond) across the most recent `span`
 *  percent. A local window tracks phase changes: a quick download followed by
 *  slow inbox preparation should not be averaged into one lifetime pace. */
function recentPace(points: StartupPoint[], span = 10): number | undefined {
  const last = points.at(-1)!;
  const from = Math.max(0, last.percent - span);
  const elapsed = last.ms - timeAt(points, from), advanced = last.percent - from;
  return elapsed > 0 && advanced > 0 ? advanced / elapsed : undefined;
}

/** Median progress speed across past runs over the same percent window, so the
 *  current run is compared against history doing the same phase of work. */
function historyPace(history: StartupTiming[], from: number, to: number): number | undefined {
  const paces: number[] = [];
  for (const run of history) {
    const elapsed = timeAt(run.points, to) - timeAt(run.points, from);
    if (elapsed > 0) paces.push((to - from) / elapsed);
  }
  return paces.length ? median(paces) : undefined;
}

/** Estimate remaining milliseconds. History anchors the estimate and the
 *  current run's recent pace scales it; clock ticks never manufacture progress. */
export function startupRemaining(points: StartupPoint[], elapsed: number, history: StartupTiming[]): number | undefined {
  const last = points.at(-1)!;
  if (last.percent >= 100) return 0;
  if (elapsed - last.ms > 15_000) return undefined;
  const pace = recentPace(points);
  let remaining: number | undefined;
  if (history.length) {
    const from = Math.max(0, last.percent - 10);
    const expected = pace === undefined ? undefined : historyPace(history, from, last.percent);
    const expectedRemaining = median(history.map(run => run.points.at(-1)!.ms - timeAt(run.points, last.percent)));
    const ratio = pace !== undefined && expected ? Math.max(.5, Math.min(3, pace / expected)) : 1;
    remaining = expectedRemaining / ratio;
  } else if (pace !== undefined) {
    // A first run extrapolates from its recent pace, not from the origin: the
    // bar is back-loaded (inbox preparation dominates the later percent), so a
    // lifetime average would under-promise once the slow phase starts.
    if (last.percent < 25 || last.ms < 2_000 || points.length < 3) return undefined;
    remaining = Math.min(maxDuration, (100 - last.percent) / pace);
  } else {
    return undefined;
  }
  const left = Math.round(remaining - (elapsed - last.ms));
  return left >= 1_000 ? left : undefined;
}

export function startupWaitLabel(remaining: number | undefined, complete: boolean) {
  if (complete) return '0 seconds';
  if (remaining === undefined || !Number.isFinite(remaining) || remaining <= 0) return '';
  // Round to the nearest five seconds: the number is an estimate, and
  // one-second precision would promise more certainty than the math has.
  const total = Math.max(5, Math.round(remaining / 5_000) * 5);
  if (total < 60) return `about ${total} seconds`;
  const minutes = Math.round(total / 60);
  return minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`;
}

/** Ease bad news in: when a new sample revises the wait upward, approach it
 *  over a few ticks instead of jumping. Good news (a shorter wait) and first
 *  sightings apply immediately so the countdown stays live. */
export function softenEstimate(previous: number | undefined, raw: number | undefined): number | undefined {
  if (raw === undefined || previous === undefined || raw <= previous) return raw;
  return previous + (raw - previous) / 2;
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
