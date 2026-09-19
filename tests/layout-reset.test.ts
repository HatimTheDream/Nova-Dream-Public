import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, layoutSchema, type Layout } from '../packages/domain/contracts';
import { createHomeWidget, resetHomeWidgets } from '../packages/domain/home-widgets';
import { captureLayoutReset, undoLayoutReset } from '../apps/client/src/layout-reset';

test('Home reset undo restores only arrangement while retaining current content and widget identities', () => {
  const note = { ...createHomeWidget('note'), settings: { text: 'Earlier note' }, hidden: true };
  const removed = createHomeWidget('links');
  const before: Layout = { ...structuredClone(defaultLayout), showCompleted: true, widgets: [
    note, { id: 'attention', size: 'large', hidden: true, title: 'Earlier title', color: 'cream', settings: { limit: 2 } },
    removed, { id: 'welcome', size: 'compact', hidden: true },
  ] };
  const receipt = captureLayoutReset(before, 'home');
  const added = { ...createHomeWidget('note'), settings: { text: 'Added after reset' }, color: 'rose' as const };
  const latestNote = { ...note, hidden: false, size: 'large' as const, color: 'sky' as const, settings: { text: 'Keep my new writing\nSecond line' } };
  const current: Layout = { ...before, theme: 'dark', timezone: 'Pacific/Honolulu', nav: [...before.nav].reverse(), showCompleted: false,
    widgets: [added, ...resetHomeWidgets(before.widgets).filter(widget => ![removed.id, 'welcome'].includes(widget.id)).map(widget => widget.id === note.id ? latestNote : { ...widget, title: 'New title', color: 'sage' as const, settings: { limit: 7 } })],
  };
  const unchanged = structuredClone(current);
  const result = undoLayoutReset(current, receipt);
  assert.deepEqual(result.widgets.map(widget => widget.id), [note.id, 'attention', added.id]);
  assert.equal(result.widgets[0], latestNote);
  assert.deepEqual(result.widgets[1], { ...current.widgets.find(widget => widget.id === 'attention'), size: 'large', hidden: true });
  assert.equal(result.widgets[2], added);
  assert.equal(result.showCompleted, true);
  assert.equal(result.theme, 'dark');
  assert.equal(result.timezone, 'Pacific/Honolulu');
  assert.deepEqual(result.nav, current.nav);
  assert.deepEqual(current, unchanged);
  assert.deepEqual(layoutSchema.parse(result), result);
  assert.doesNotMatch(JSON.stringify(receipt), /Earlier note|Earlier title|cream|limit/);
});

test('navigation reset undo retains all current Home settings and content', () => {
  const before: Layout = { ...structuredClone(defaultLayout), nav: [...defaultLayout.nav].reverse() };
  const receipt = captureLayoutReset(before, 'navigation');
  const note = { ...createHomeWidget('note'), settings: { text: 'Written after navigation reset' } };
  const current: Layout = { ...before, nav: [...defaultLayout.nav], theme: 'dark', timezone: 'UTC', showCompleted: true, widgets: [note] };
  const result = undoLayoutReset(current, receipt);
  assert.deepEqual(result, { ...current, nav: before.nav });
  assert.equal(result.widgets, current.widgets);
  assert.notEqual(result.nav, before.nav);
  assert.deepEqual(layoutSchema.parse(result), result);
});

test('Home reset undo keeps an emptied board empty and includes every later addition', () => {
  const receipt = captureLayoutReset(defaultLayout, 'home');
  assert.deepEqual(undoLayoutReset({ ...defaultLayout, widgets: [] }, receipt).widgets, []);
  const added = Array.from({ length: 24 }, () => createHomeWidget('note'));
  const result = undoLayoutReset({ ...defaultLayout, widgets: added }, receipt);
  assert.deepEqual(result.widgets, added);
  assert.deepEqual(layoutSchema.parse(result), result);
});
