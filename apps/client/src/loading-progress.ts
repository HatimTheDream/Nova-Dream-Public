import { downloadPercent, type DownloadProgress } from './download-progress';
import { readLocal } from './api';
import { startupHistory, type StartupTiming } from './startup-estimate';

// One overall pass: transfer occupies the first tenth; completed preparation
// advances the remainder. This measures work completed, not seconds remaining.
export function workspaceLoadingPercent(download?: DownloadProgress, complete = false, preparation?: number) {
  const measured = download ? downloadPercent(download) : 0;
  return complete ? 100 : preparation !== undefined ? Math.min(99, preparation) : measured === undefined ? 0 : Math.floor(Math.min(100, measured) * .1);
}
export function playfulStartupSubtitle(percent: number) {
  if (percent === 100) return 'Let’s make something good.';
  if (percent >= 85) return 'One last whisker check…';
  if (percent >= 45) return 'Putting a little order in the universe…';
  if (percent > 0) return 'Gathering your good ideas…';
  return 'Stretching our paws…';
}

// Startup phases report in coarse chunks (one inbox update can jump the bar
// from 10 to 43, and the long message-preload phase reports nothing for many
// seconds), so the bar paces itself against this device's startup history:
// real progress always leads, and during stalls a history-paced floor keeps
// the bar creeping instead of freezing. Only real completion may show 100.

// A new version has no timing history yet; pace against a typical full
// startup so the bar still moves instead of freezing on its first run.
const defaultPaceMs = 20_000;
const timingKeyPrefix = 'nova:startup-timings:v2:';

/** Median total duration of past startup runs: the bar's historical pace. */
export function estimatedTotalMs(history: StartupTiming[]): number | undefined {
  const totals = history
    .map(run => run.points.at(-1)?.ms)
    .filter((ms): ms is number => typeof ms === 'number' && ms > 0);
  if (!totals.length) return undefined;
  totals.sort((a, b) => a - b);
  return totals[Math.floor(totals.length / 2)];
}

/** Where the bar should be `elapsedMs` into the run at its historical pace.
 *  Capped below completion: only real completion may show 100. */
export function pacedPercent(elapsedMs: number, totalMs: number): number {
  if (!(totalMs > 0) || elapsedMs <= 0) return 0;
  return Math.min(95, 95 * Math.min(1, elapsedMs / totalMs));
}

/** One frame of exponential approach toward the goal, frame-rate independent
 *  through the time constant. Progress never visually regresses: a goal below
 *  the display applies instantly. */
export function approachValue(shown: number, goal: number, dtMs: number, timeConstantMs = 200): number {
  if (dtMs <= 0) return shown;
  if (goal <= shown) return goal;
  return shown + (goal - shown) * (1 - Math.exp(-dtMs / timeConstantMs));
}

/** Resolve this device's pace: the versioned timing history first, then the
 *  most recent run from any version, then the default. */
export function paceTotalMs(timingKey: string | undefined): number {
  if (timingKey) {
    const total = estimatedTotalMs(startupHistory(readLocal(timingKey), Date.now()));
    if (total) return total;
  }
  let best: StartupTiming[] | undefined, bestAt = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(timingKeyPrefix) || key === timingKey) continue;
      const history = startupHistory(readLocal(key), Date.now());
      const at = history.reduce((latest, run) => Math.max(latest, run.at), 0);
      if (history.length && at > bestAt) { bestAt = at; best = history; }
    }
  } catch { /* storage unavailable: fall through to the default */ }
  return estimatedTotalMs(best ?? []) ?? defaultPaceMs;
}
