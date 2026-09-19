import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { weatherGraphicKind } from '../apps/client/src/WeatherGraphic';
import { defaultLayout, type Entity, type Snapshot, type Task } from '../packages/domain/contracts';
import { createHomeWidget } from '../packages/domain/home-widgets';
import type { HomeWeatherResult } from '../packages/domain/home-weather';
import type { Routine } from '../packages/domain/tasks';
import { dailyRoutineTasks } from '../apps/client/src/DailyRoutinesWidget';
import { homeWeatherCondition, weatherResponseMatches, WeatherReading } from '../apps/client/src/HomeWeatherWidget';

const now = Date.parse('2026-09-20T01:00:00Z');
const entity = <T>(id: string, value: T): Entity<T> => ({ id, value, revision: 1, deviceId: 'test-device', updatedAt: new Date(now).toISOString() });
const routine = (id: string, patch: Partial<Routine> = {}) => entity<Routine>(id, { title: id, notes: '', kind: 'task', state: 'active', startsOn: '2026-01-01', timezone: 'UTC', cadence: 'daily', weekdays: [], projectId: null, plannedTime: '', priority: 'normal', estimateMinutes: 0, ...patch });
const task = (id: string, patch: Partial<Task> = {}) => entity<Task>(id, { title: id, notes: '', status: 'open', planned: '2026-09-20', due: '', ...patch });
const snapshot = (): Pick<Snapshot, 'tasks' | 'routines' | 'taskState' | 'layout'> => ({
  tasks: [], routines: [routine('routine:daily')], layout: entity('layout', { ...defaultLayout, timezone: 'UTC' }),
  taskState: { occurrences: [], events: [], routineEvents: [], focus: [], earnedXp: 0, orders: [] },
});

test('daily widgets use retained occurrences in their own timezone and saved task order', () => {
  const state = snapshot();
  state.tasks = [task('a'), task('b'), task('los-angeles', { planned: '2026-09-19', timezone: 'America/Los_Angeles' }), task('yesterday', { planned: '2026-09-19' }), task('one-off')];
  state.taskState!.occurrences = [
    ...['a', 'b'].map(taskId => ({ taskId, routineId: 'routine:daily', templateRevision: 1, date: '2026-09-20', timezone: 'UTC', kind: 'task' as const })),
    { taskId: 'los-angeles', routineId: 'routine:daily', templateRevision: 1, date: '2026-09-19', timezone: 'America/Los_Angeles', kind: 'task' },
    { taskId: 'yesterday', routineId: 'routine:daily', templateRevision: 1, date: '2026-09-19', timezone: 'UTC', kind: 'task' },
    { taskId: 'missing', routineId: 'routine:daily', templateRevision: 1, date: '2026-09-20', timezone: 'UTC', kind: 'task' },
  ];
  state.taskState!.orders = [{ date: '2026-09-20', timezone: 'UTC', revision: 1, taskIds: ['b', 'los-angeles', 'a'] }];
  assert.deepEqual(dailyRoutineTasks(state, now).map(item => item.id), ['b', 'los-angeles', 'a']);
  assert.equal(state.tasks.length, 5, 'projection does not create routine tasks');
});

test('daily widgets exclude unready work, future plans and other recurrence cadences', () => {
  const state = snapshot();
  state.routines!.push(routine('routine:weekly', { cadence: 'weekly', weekdays: [0] }), routine('routine:interval', { interval: 2 }));
  state.tasks = [task('ready'), task('done', { status: 'done' }), task('skipped', { status: 'skipped' }), task('blocked', { status: 'blocked' }), task('waiting', { status: 'waiting' }), task('trashed', { trashed: true }), task('future', { planned: '2026-09-21' }), task('dependent', { dependencies: ['missing'] }), task('weekly'), task('interval')];
  state.taskState!.occurrences = state.tasks.map(item => ({ taskId: item.id, routineId: item.id === 'weekly' ? 'routine:weekly' : item.id === 'interval' ? 'routine:interval' : 'routine:daily', templateRevision: 1, date: '2026-09-20', timezone: 'UTC', kind: 'task' }));
  assert.deepEqual(dailyRoutineTasks(state, now).map(item => item.id), ['ready']);
});

test('weather display rejects responses for other widget settings', () => {
  const widget = createHomeWidget('weather');
  widget.settings = { units: 'celsius', location: { name: 'Test City', latitude: 10, longitude: 20, timezone: 'UTC' } };
  const result: HomeWeatherResult = { widgetId: widget.id, location: { ...widget.settings.location! }, units: 'celsius', forecast: null, dataTime: null, fetchedAt: null, stale: false };
  assert.equal(weatherResponseMatches(widget, result), true);
  assert.equal(weatherResponseMatches(widget, { ...result, units: 'fahrenheit' }), false);
  assert.equal(weatherResponseMatches(widget, { ...result, widgetId: 'other' }), false);
  assert.equal(weatherResponseMatches(widget, { ...result, location: { ...result.location!, latitude: 11 } }), false);
  assert.equal(weatherResponseMatches(widget, { ...result, location: null }), false);
  assert.equal(homeWeatherCondition(999), 'Conditions unavailable');
});

test('weather graphics distinguish provider conditions without inventing a clear forecast', () => {
  const groups = {
    clear: [0], 'partly-cloudy': [1, 2], cloudy: [3], fog: [45, 48], drizzle: [51, 53, 55],
    rain: [61, 63, 65, 80, 81, 82], sleet: [56, 57, 66, 67], snow: [71, 73, 75, 77, 85, 86], storm: [95], hail: [96, 99],
  };
  for (const [condition, codes] of Object.entries(groups)) {
    for (const code of codes) assert.equal(weatherGraphicKind(code), condition, `WMO ${code}`);
  }
  for (const code of [undefined, -1, 999]) assert.equal(weatherGraphicKind(code), 'unknown');
});

test('weather composition keeps missing metrics and stale observations truthful', () => {
  const props = { forecast: { temperature: 9, weatherCode: 61, high: null, low: null, precipitationProbability: null }, locationName: 'Test City', units: 'celsius' as const, stale: true, age: '20 min ago', sample: true };
  const full = renderToStaticMarkup(createElement(WeatherReading, { ...props, size: 'large' }));
  assert.match(full, /data-weather-kind="rain"/);
  assert.equal(full.match(/Unavailable/g)?.length, 3);
  assert.match(full, /Last available forecast.*20 min ago/);
  assert.doesNotMatch(full, /0%/);
  const compact = renderToStaticMarkup(createElement(WeatherReading, { ...props, size: 'compact' }));
  assert.match(compact, /Last available.*20 min ago/);
  assert.doesNotMatch(compact, /weather-metrics/);
});
