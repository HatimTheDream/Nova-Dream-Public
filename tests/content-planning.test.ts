import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import { CalendarService } from '../apps/service/calendar.js';
import type { Entity } from '../packages/domain/contracts.js';
import type { CalendarRange } from '../packages/domain/calendar.js';
import { contentPlanningCommand, contentCalendarEvents, contentDay } from '../packages/domain/content-planning.js';
import { blankRecord, type Content } from '../packages/domain/workspace-records.js';
import { projectCalendarEvent } from '../apps/client/src/dreamclaw/calendar-projection.js';
const range: CalendarRange = { from: '2026-03-01', to: '2026-04-01', timezone: 'America/Los_Angeles' };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'e3-content-planning-')); let store = new Store(directory);
  const accounts = { state: () => ({ accounts: [], clients: [], attempts: [], probes: [] }), calendarSources: async () => ({ items: [], limited: false }), calendarEvents: async () => ({ events: [], coverage: 'complete' as const, pages: 1, skipped: 0 }) };
  let calendar = new CalendarService(store, accounts);
  return { get store() { return store; }, get calendar() { return calendar; }, async restart() { await calendar.close(); store.close(); store = new Store(directory); calendar = new CalendarService(store, accounts); }, async close() { await calendar.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const value = (): Content => ({ ...blankRecord('content', 'UTC') as Content, title: 'Spring publication', brief: 'Review before publishing.', body: '# Exact draft\n\nPrivate body should not be copied into Calendar.', platform: 'Newsletter', plannedDate: '2026-03-08' });
const save = (store: Store, payload: Content, id = 'content:plan', expectedRevision = 0) => store.mutate('owner', { kind: 'content', entityId: id, expectedRevision, epoch: store.epoch, requestId: randomUUID(), payload }) as Entity<Content>;

test('a planning move keeps the exact draft and Project, survives lost reply/restart, and conflicts with a competing edit', async () => {
  const f = fixture(); try {
    f.store.mutate('owner', { kind: 'project', entityId: 'project:launch', expectedRevision: 0, epoch: f.store.epoch, requestId: randomUUID(), payload: { name: 'Launch', purpose: 'Shared context' } });
    const first = save(f.store, { ...value(), projectId: 'project:launch' });
    const cmd = contentPlanningCommand(first, { stage: 'review', plannedDate: '2026-03-09' }, f.store.epoch, randomUUID());
    const moved = f.store.mutate('owner', cmd) as Entity<Content>;
    assert.deepEqual(moved.value, { ...first.value, stage: 'review', plannedDate: '2026-03-09' });
    await f.restart(); assert.deepEqual(f.store.mutate('owner', cmd), moved);
    const competing = save(f.store, { ...moved.value, body: 'Another window retained its writing.' }, first.id, moved.revision);
    assert.throws(() => f.store.mutate('owner', contentPlanningCommand(moved, { stage: 'ready' }, f.store.epoch, randomUUID())), /newer version/);
    assert.deepEqual(f.store.readEntity('content', first.id), competing); assert.equal(f.store.recordHistory({ kind: 'content', id: first.id }).versions.length, 3);
    assert.throws(() => f.store.mutate('other', cmd), /different work/);
  } finally { await f.close(); }
});
test('quick planning never creates a publication claim and leaves existing manual records intact', async () => {
  const f = fixture(); try {
    const first = save(f.store, value());
    assert.throws(() => contentPlanningCommand(first, { stage: 'published' } as never, f.store.epoch, randomUUID()));
    const published = save(f.store, { ...first.value, stage: 'published', publication: { kind: 'manual', date: '2026-03-10', note: 'Published by the owner on the private newsletter.' } }, first.id, first.revision);
    assert.equal(contentDay(published.value), '2026-03-10');
    assert.throws(() => contentPlanningCommand(published, { plannedDate: '2026-03-11' }, f.store.epoch, randomUUID()), /manual publication/);
    const cmd = contentPlanningCommand(published, { stage: 'drafting' }, f.store.epoch, randomUUID()); const moved = f.store.mutate('owner', cmd) as Entity<Content>;
    assert.deepEqual(moved.value.publication, published.value.publication); assert.equal(contentDay(moved.value), '2026-03-08');
    assert.throws(() => contentPlanningCommand({ ...moved, value: { ...moved.value, archived: true } }, { stage: 'ready' }, f.store.epoch, randomUUID()), /archived/);
  } finally { await f.close(); }
});
test('Calendar reads the same Content identity/date without copying its body or creating an event or Task', async () => {
  const f = fixture(); try {
    const first = save(f.store, value());
    const before = f.calendar.state('owner', range), display = before.events.find(event => event.contentId === first.id)!;
    assert.equal(display.interval.start, '2026-03-08'); assert.equal(display.sourceId, 'content'); assert.ok(display.notes.includes('Planned content')); assert.ok(!display.notes.includes('Private body'));
    const projected = projectCalendarEvent(display, before); assert.equal(projected.source, 'content'); assert.equal(projected.readOnly, true); assert.equal(projected.sourceRoute, '/content?item=content%3Aplan'); assert.equal(projected.writeToken, undefined);
    assert.equal(f.store.snapshot('owner').tasks.length, 0); assert.equal(before.localEvents.length, 0); assert.equal(f.store.internalList('calendar:local:').length, 0);
    f.store.mutate('owner', contentPlanningCommand(first, { plannedDate: '2026-03-15' }, f.store.epoch, randomUUID()));
    await f.restart(); const after = f.calendar.state('owner', range).events.filter(event => event.contentId === first.id); assert.equal(after.length, 1); assert.equal(after[0].interval.start, '2026-03-15');
    const current = f.store.readEntity('content', first.id) as Entity<Content>; save(f.store, { ...current.value, archived: true }, first.id, current.revision);
    assert.equal(f.calendar.state('owner', range).events.filter(event => event.contentId === first.id).length, 0);
  } finally { await f.close(); }
});
test('Content dates keep their civil day across timezones, exclusive range ends, unscheduled and published projections', () => {
  const entity = { id: 'content:date', kind: 'content', revision: 1, updatedAt: '2026-03-01T00:00:00Z', deviceId: 'owner', value: value() } as Entity<Content>;
  for (const timezone of ['America/Los_Angeles', 'Pacific/Auckland']) assert.equal(contentCalendarEvents([entity], { ...range, timezone })[0].interval.start, '2026-03-08');
  assert.equal(contentCalendarEvents([entity], { ...range, to: '2026-03-08' }).length, 0);
  assert.equal(contentCalendarEvents([{ ...entity, value: { ...entity.value, plannedDate: '' } }], range).length, 0);
  const published = { ...entity, value: { ...entity.value, stage: 'published' as const, publication: { kind: 'manual' as const, date: '2026-03-12', note: 'Explicit local record.' } } };
  const [event] = contentCalendarEvents([published], range); assert.equal(event.interval.start, '2026-03-12'); assert.ok(event.notes.includes('manual record'));
});
