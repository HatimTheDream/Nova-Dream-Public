import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, layoutSchema, widgetIds } from '../packages/domain/contracts';
import { createHomeWidget, homeQuickLinkSchema, homeWidgetColors, homeWidgetLimit, homeWidgetSchema, homeWidgetTypes, resetHomeWidgets, resolveWidgetType, widgetTitle } from '../packages/domain/home-widgets';

const link = () => ({ id: crypto.randomUUID(), label: 'Project reference', url: 'https://example.test/docs?topic=home#widgets' });

test('Legacy Home entries preserve their identities, order, sizes, visibility and task preference', () => {
  const legacy = { ...structuredClone(defaultLayout), showCompleted: true, widgets: [...defaultLayout.widgets].reverse().map((widget, index) => ({ ...widget, hidden: index === 1, size: index === 2 ? 'compact' as const : widget.size })) };
  const parsed = layoutSchema.parse(legacy);
  assert.deepEqual(parsed, legacy);
  assert.deepEqual(parsed.widgets.map(resolveWidgetType), [...widgetIds].reverse());
  assert.equal(widgetTitle(parsed.widgets.find(widget => widget.id === 'next')!), 'Tasks');
  assert.equal(widgetTitle({ id: 'next', title: '  My priorities  ' }), 'My priorities');
  assert.equal(widgetTitle({ id: 'next', title: '   ' }), 'Tasks');
});

test('New Home instances have independent identities and settings, including repeated types', () => {
  const first = createHomeWidget('links'), second = createHomeWidget('links');
  first.settings!.links!.push(link());
  first.color = 'sky';
  assert.notEqual(first.id, second.id);
  assert.deepEqual(second.settings?.links, []);
  assert.equal(second.color, undefined);
  const widgets = homeWidgetTypes.map(createHomeWidget);
  const before = structuredClone(widgets);
  assert.deepEqual(layoutSchema.parse({ ...defaultLayout, widgets: [...widgets, first, second] }).widgets, [...widgets, first, second]);
  assert.deepEqual(widgets, before);
  assert.deepEqual(createHomeWidget('next').settings, { view: 'ready', projectId: null, limit: 5 });
});

test('Home instances require unique stable identities and a matching type', () => {
  const custom = createHomeWidget('note');
  assert.equal(homeWidgetSchema.safeParse({ ...custom, type: undefined }).success, false);
  assert.equal(homeWidgetSchema.safeParse({ ...custom, id: 'note' }).success, false);
  assert.equal(homeWidgetSchema.safeParse({ ...custom, id: 'widget:invalid' }).success, false);
  assert.equal(homeWidgetSchema.safeParse({ ...custom, id: 'next' }).success, false);
  assert.equal(layoutSchema.safeParse({ ...defaultLayout, widgets: [custom, custom] }).success, false);
  assert.equal(layoutSchema.safeParse({ ...defaultLayout, widgets: Array.from({ length: homeWidgetLimit }, () => createHomeWidget('note')) }).success, true);
  assert.equal(layoutSchema.safeParse({ ...defaultLayout, widgets: Array.from({ length: homeWidgetLimit + 1 }, () => createHomeWidget('note')) }).success, false);
  assert.equal(layoutSchema.safeParse({ ...defaultLayout, widgets: [] }).success, true);
  assert.equal(layoutSchema.safeParse({ ...defaultLayout, nav: ['home'] }).success, false);
});

test('Home rejects type-inappropriate settings instead of silently losing their contents', () => {
  const valid = [
    { ...createHomeWidget('next'), settings: { view: 'upcoming', projectId: 'project:one', limit: 12 } },
    { ...createHomeWidget('attention'), settings: { projectId: null, limit: 1 } },
    { ...createHomeWidget('welcome'), settings: { timezone: 'America/Los_Angeles' } },
    { ...createHomeWidget('note'), settings: { text: 'Preserve this note\nwith its second line.' } },
    { ...createHomeWidget('links'), settings: { links: [link()] } },
  ];
  for (const widget of valid) assert.deepEqual(homeWidgetSchema.parse(widget), widget);
  for (const type of homeWidgetTypes.filter(type => type !== 'note')) {
    assert.equal(homeWidgetSchema.safeParse({ ...createHomeWidget(type), settings: { text: 'Do not discard this writing' } }).success, false, type);
  }
  assert.equal(homeWidgetSchema.safeParse({ ...createHomeWidget('note'), settings: { links: [link()] } }).success, false);
  assert.equal(homeWidgetSchema.safeParse({ ...createHomeWidget('next'), settings: { unknown: 'kept?' } }).success, false);
  assert.equal(homeWidgetSchema.safeParse({ ...createHomeWidget('welcome'), settings: { timezone: 'Not/A_Zone' } }).success, false);
});

test('Home bounds saved configuration content', () => {
  for (const limit of [0, 13, 1.5]) assert.equal(homeWidgetSchema.safeParse({ ...createHomeWidget('next'), settings: { limit } }).success, false);
  assert.equal(homeWidgetSchema.safeParse({ ...createHomeWidget('note'), title: 'x'.repeat(81) }).success, false);
  assert.equal(homeWidgetSchema.safeParse({ ...createHomeWidget('note'), settings: { text: 'x'.repeat(10000) } }).success, true);
  assert.equal(homeWidgetSchema.safeParse({ ...createHomeWidget('note'), settings: { text: 'x'.repeat(10001) } }).success, false);
  assert.equal(homeWidgetSchema.safeParse({ ...createHomeWidget('links'), settings: { links: Array.from({ length: 13 }, link) } }).success, false);
  const repeated = link();
  assert.equal(homeWidgetSchema.safeParse({ ...createHomeWidget('links'), settings: { links: [repeated, repeated] } }).success, false);
});

test('Home accepts the shared widget palette while preserving an unspecified legacy color', () => {
  const original = { id: 'welcome', size: 'wide' as const, hidden: false };
  assert.deepEqual(homeWidgetSchema.parse(original), original);
  for (const color of homeWidgetColors) {
    for (const widget of [original, createHomeWidget('note')]) {
      assert.deepEqual(homeWidgetSchema.parse({ ...widget, color }), { ...widget, color });
    }
  }
  for (const color of ['#fff', 'red', '', null]) {
    assert.equal(homeWidgetSchema.safeParse({ ...original, color }).success, false);
  }
});

test('Quick links accept only absolute web addresses without embedded credentials', () => {
  for (const url of ['https://example.test/docs', 'http://localhost:4383/', 'https://example.test/?next=https%3A%2F%2Felsewhere.test']) {
    assert.equal(homeQuickLinkSchema.safeParse({ ...link(), url }).success, true, url);
  }
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/local', '/relative', '//example.test/', 'https://name@example.test', 'https://name:password@example.test', 'https://name%40mail.test@example.test']) {
    assert.equal(homeQuickLinkSchema.safeParse({ ...link(), url }).success, false, url);
  }
  assert.equal(homeQuickLinkSchema.safeParse({ ...link(), label: '' }).success, false);
  assert.equal(homeQuickLinkSchema.safeParse({ ...link(), label: 'x'.repeat(81) }).success, false);
});

test('Resetting Home keeps custom writing and settings while arranging only retained originals', () => {
  const note = { ...createHomeWidget('note'), title: 'Keep this note', color: 'lavender' as const, hidden: true, settings: { text: 'Exact retained writing\nSecond line' } };
  const links = { ...createHomeWidget('links'), settings: { links: [link()] } };
  const original = [{ id: 'attention', size: 'large' as const, color: 'sage' as const, hidden: true, title: 'My attention', settings: { projectId: 'project:one', limit: 3 } }, { id: 'welcome', size: 'compact' as const, hidden: true, settings: { timezone: 'UTC' } }];
  const widgets = [note, ...original, links], before = structuredClone(widgets);
  const reset = resetHomeWidgets(widgets);
  assert.deepEqual(reset.map(widget => widget.id), ['welcome', 'attention', note.id, links.id]);
  assert.deepEqual(reset[0], { ...original[1], size: 'wide', hidden: false });
  assert.deepEqual(reset[1], { ...original[0], size: 'square', hidden: false });
  assert.deepEqual(reset.slice(2), [note, links]);
  assert.deepEqual(widgets, before);
  assert.deepEqual(layoutSchema.parse({ ...defaultLayout, widgets: reset }).widgets, reset);
  const full = Array.from({ length: homeWidgetLimit }, () => createHomeWidget('note'));
  assert.deepEqual(resetHomeWidgets(full), full);
  assert.equal(resetHomeWidgets(full).length, homeWidgetLimit);
  assert.deepEqual(resetHomeWidgets([]), []);
});
