import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayInZone } from '../packages/domain/tasks.js';

const OriginalDateTimeFormat = Intl.DateTimeFormat;
function uncachedDay(zone: string, instant: number): string {
  const parts = new OriginalDateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}

test('day formatter reuse stays bounded and evicts without changing dates', () => {
  // This file has its own test process; the first dayInZone calls fill an empty cache.
  const zones = Intl.supportedValuesOf('timeZone').slice(0, 33);
  assert.equal(zones.length, 33);
  const created: string[] = [], instant = Date.parse('2026-03-08T09:30:00Z');
  Intl.DateTimeFormat = new Proxy(OriginalDateTimeFormat, {
    construct(target, args) {
      const formatter = Reflect.construct(target, args);
      created.push((args[1] as Intl.DateTimeFormatOptions).timeZone!);
      return formatter;
    },
  });
  try {
    for (const zone of zones.slice(0, 32)) assert.equal(dayInZone(zone, instant), uncachedDay(zone, instant));
    assert.equal(created.length, 32);
    for (let round = 0; round < 20; round++) for (const zone of zones.slice(0, 32)) assert.equal(dayInZone(zone, instant + round * 86400000), uncachedDay(zone, instant + round * 86400000));
    assert.equal(created.length, 32, 'repeated calls must reuse their formatter, not their date');
    assert.equal(dayInZone(zones[32], instant), uncachedDay(zones[32], instant));
    assert.equal(created.length, 33);
    assert.equal(dayInZone(zones[31], instant), uncachedDay(zones[31], instant));
    assert.equal(created.length, 33, 'a retained zone must still reuse its formatter');
    assert.equal(dayInZone(zones[0], instant), uncachedDay(zones[0], instant));
    assert.equal(created.length, 34, 'the oldest of 32 entries must have been evicted');
    assert.equal(created.at(-1), zones[0]);
  } finally { Intl.DateTimeFormat = OriginalDateTimeFormat; }
});

test('day formatting preserves civil dates across midnight, DST, leap day and skipped dates', () => {
  const cases = [
    ['UTC', '1970-01-01T00:00:00Z', '1970-01-01'],
    ['America/Los_Angeles', '2026-03-08T07:59:59Z', '2026-03-07'],
    ['America/Los_Angeles', '2026-03-08T08:00:00Z', '2026-03-08'],
    ['America/Los_Angeles', '2026-03-08T09:59:59Z', '2026-03-08'],
    ['America/Los_Angeles', '2026-03-08T10:00:00Z', '2026-03-08'],
    ['America/New_York', '2026-11-01T05:30:00Z', '2026-11-01'],
    ['America/New_York', '2026-11-01T06:30:00Z', '2026-11-01'],
    ['Asia/Kathmandu', '2026-06-30T18:14:59Z', '2026-06-30'],
    ['Asia/Kathmandu', '2026-06-30T18:15:00Z', '2026-07-01'],
    ['Australia/Lord_Howe', '2026-04-04T14:59:59Z', '2026-04-05'],
    ['Australia/Lord_Howe', '2026-04-04T15:00:00Z', '2026-04-05'],
    ['Pacific/Kiritimati', '2025-12-31T10:00:00Z', '2026-01-01'],
    ['Pacific/Honolulu', '2026-01-01T09:59:59Z', '2025-12-31'],
    ['UTC', '2024-02-29T23:59:59Z', '2024-02-29'],
    ['Pacific/Apia', '2011-12-30T09:59:59Z', '2011-12-29'],
    ['Pacific/Apia', '2011-12-30T10:00:00Z', '2011-12-31'],
  ];
  for (const [zone, instant, expected] of cases) {
    assert.equal(dayInZone(zone, Date.parse(instant)), expected, zone + ' ' + instant);
    assert.equal(dayInZone(zone, Date.parse(instant)), uncachedDay(zone, Date.parse(instant)));
  }
});

test('cached formatter output matches the previous Intl contract across changing instants and zones', t => {
  const zones = ['UTC', 'Etc/UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'Pacific/Auckland', 'Pacific/Apia'];
  const instants = [-1, 0, 86400000, Date.parse('2000-02-29T00:00:00Z'), Date.parse('2026-03-08T09:59:59Z'), Date.parse('2026-03-08T10:00:00Z'), Date.parse('2026-11-01T05:59:59Z'), Date.parse('2026-11-01T06:00:00Z'), Date.parse('2026-12-31T23:59:59Z'), Date.parse('2027-01-01T00:00:00Z')];
  for (const instant of instants) for (const zone of zones) assert.equal(dayInZone(zone, instant), uncachedDay(zone, instant));
  const now = Date.parse('2026-11-01T06:30:00Z');
  t.mock.method(Date, 'now', () => now);
  for (const zone of zones) assert.equal(dayInZone(zone), uncachedDay(zone, now));
});

test('invalid timezone and instant exceptions remain equivalent on cache misses and hits', () => {
  const failure = (run: () => unknown) => { try { run(); } catch (error) { assert.ok(error instanceof Error); return { name: error.name, message: error.message }; } assert.fail('expected the existing Intl exception'); };
  for (const zone of ['', 'not-a-timezone', 'America/Not_A_Zone']) {
    for (let repeat = 0; repeat < 2; repeat++) assert.deepEqual(failure(() => dayInZone(zone, 0)), failure(() => uncachedDay(zone, 0)));
  }
  for (const zone of ['UTC', 'Antarctica/Troll']) {
    for (const instant of [NaN, Infinity, -Infinity, 8640000000000001, -8640000000000001]) assert.deepEqual(failure(() => dayInZone(zone, instant)), failure(() => uncachedDay(zone, instant)));
    assert.equal(dayInZone(zone, 0), uncachedDay(zone, 0), 'a failed call must not poison later valid dates');
  }
});
