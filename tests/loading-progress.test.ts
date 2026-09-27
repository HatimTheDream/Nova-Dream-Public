import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceLoadingPercent, playfulStartupSubtitle, pacedPercent, estimatedTotalMs, approachValue, historicalPercent, expectedPercent, paceInfo } from '../apps/client/src/loading-progress';
import type { StartupTiming } from '../apps/client/src/startup-estimate';
import { inboxLoadingPercent } from '../apps/client/src/inbox-startup-progress';

test('workspace progress keeps one denominator and completes only with an accepted workspace', () => {
  assert.equal(workspaceLoadingPercent(), 0);
  assert.equal(workspaceLoadingPercent({ loadedBytes: 300, totalBytes: 1000 }), 3);
  assert.equal(workspaceLoadingPercent({ loadedBytes: 1000, totalBytes: 1000, complete: true }), 10);
  assert.equal(workspaceLoadingPercent({ loadedBytes: 1000, totalBytes: 1000, complete: true }, true), 100);
  assert.equal(workspaceLoadingPercent({ loadedBytes: 300 }), 0);
  assert.equal(workspaceLoadingPercent(undefined, true), 100);
});

test('Inbox progress never restarts at its account, first page and recent message boundaries', () => {
  const values = [
    inboxLoadingPercent({ phase: 'accounts', completed: 0 }),
    ...[0,1,2,3].map(completed => inboxLoadingPercent({ phase: 'mailboxes', completed, total: 3 })),
    ...Array.from({ length: 26 }, (_, completed) => inboxLoadingPercent({ phase: 'messages', completed, total: 25 })),
    inboxLoadingPercent({ phase: 'ready', completed: 25, total: 25 }),
  ];
  assert.deepEqual(values, [...values].sort((a,b) => a-b));
  assert.equal(values[0], 0); assert.equal(values.at(-2), 99); assert.equal(values.at(-1), 100);
  assert.equal(inboxLoadingPercent({ phase: 'messages', completed: 0, total: 0 }), 20);
  assert.equal(inboxLoadingPercent({ phase: 'ready', completed: 0, total: 0 }), 100);
});

test('startup keeps playful copy while preparation continues after the transfer', () => {
  assert.equal(workspaceLoadingPercent({ loadedBytes: 1000, totalBytes: 1000, complete: true }, false, 72), 72);
  assert.equal(workspaceLoadingPercent(undefined, false, 100), 99);
  for (const percent of [0,15,55,95,100]) assert.doesNotMatch(playfulStartupSubtitle(percent), /inbox|mail|account|session|bytes/i);
});

test('paced progress climbs steadily and never claims completion', () => {
  assert.equal(pacedPercent(0, 20_000), 0);
  assert.equal(pacedPercent(-100, 20_000), 0);
  assert.equal(pacedPercent(10_000, 20_000), 47.5);
  // The cap reserves the finish for real completion, however slow the run.
  assert.equal(pacedPercent(20_000, 20_000), 95);
  assert.equal(pacedPercent(120_000, 20_000), 95);
  // Degenerate inputs pace nothing.
  assert.equal(pacedPercent(10_000, 0), 0);
  assert.equal(pacedPercent(10_000, -5), 0);
});

test('estimated total takes the median run duration', () => {
  const run = (ms: number) => ({ at: Date.now(), points: [{ percent: 0, ms: 0 }, { percent: 100, ms }] });
  assert.equal(estimatedTotalMs([run(18_000), run(22_000), run(20_000)]), 20_000);
  assert.equal(estimatedTotalMs([run(20_000)]), 20_000);
  assert.equal(estimatedTotalMs([]), undefined);
  assert.equal(estimatedTotalMs([{ at: Date.now(), points: [] }]), undefined);
});

test('approachValue converges without overshoot and never regresses', () => {
  // A frame moves toward the goal but never past it.
  const step = approachValue(0, 100, 16.7);
  assert.ok(step > 0 && step < 100, `expected partial approach, got ${step}`);
  // ~2 seconds of frames settles onto the goal.
  let shown = 0;
  for (let i = 0; i < 120; i++) shown = approachValue(shown, 100, 16.7);
  assert.ok(shown > 99.9 && shown <= 100, `expected convergence, got ${shown}`);
  // A goal below the display snaps instead of easing backward.
  assert.equal(approachValue(60, 40, 16.7), 40);
  assert.equal(approachValue(60, 60, 16.7), 60);
  // No time passing changes nothing.
  assert.equal(approachValue(30, 100, 0), 30);
});

test('historicalPercent follows the median run curve', () => {
  const run = (at: number, samples: [number, number][]): StartupTiming =>
    ({ at, points: samples.map(([percent, ms]) => ({ percent, ms })) });
  const history = [
    run(3, [[0, 0], [43, 2000], [100, 20000]]),
    run(2, [[0, 0], [43, 4000], [100, 24000]]),
    run(1, [[0, 0], [43, 2000], [100, 16000]]),
  ];
  assert.equal(historicalPercent(history, 0), 0);
  // At 2s the runs read 43, 21.5 and 43: the median is 43.
  assert.equal(historicalPercent(history, 2000), 43);
  // Finished runs hold 100 past their end.
  assert.equal(historicalPercent(history, 60000), 100);
  assert.equal(historicalPercent([], 5000), undefined);
  assert.equal(historicalPercent(history, -1), undefined);
});

test('expectedPercent caps the historical curve below completion', () => {
  const run = (at: number, samples: [number, number][]): StartupTiming =>
    ({ at, points: samples.map(([percent, ms]) => ({ percent, ms })) });
  const history = [run(1, [[0, 0], [100, 10000]])];
  const pace = { totalMs: 10000, history };
  assert.equal(expectedPercent(pace, 0), 0);
  assert.equal(expectedPercent(pace, 5000), 50);
  // The curve reads 100 past the end; only real completion may show it.
  assert.equal(expectedPercent(pace, 20000), 95);
  // Without history the bar ramps steadily over the pace.
  assert.equal(expectedPercent({ totalMs: 20000, history: [] }, 10000), 47.5);
});

test('paceInfo falls back to the default pace without stored history', () => {
  // Node has no localStorage; the scan throws and is caught.
  assert.deepEqual(paceInfo(undefined), { totalMs: 20000, history: [] });
});
