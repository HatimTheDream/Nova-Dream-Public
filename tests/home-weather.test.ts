import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store';
import { HomeWeatherService } from '../apps/service/home-weather';
import { startServer } from '../apps/service/http';
import { phoneRouteAllowed } from '../apps/service/phone-policy';
import { createHomeWidget, homeWidgetSchema, type HomeWidget } from '../packages/domain/home-widgets';
import { homeWeatherResultSchema, type HomeWeatherLocation } from '../packages/domain/home-weather';

const location: HomeWeatherLocation = { name: 'Fixture city', latitude: 35, longitude: -120, timezone: 'America/Los_Angeles' };
const instant = Date.parse('2026-09-19T12:00:00Z');
const providerForecast = (unit = '°C') => ({
  timezone: location.timezone, current: { time: instant / 1000, temperature_2m: 20, weather_code: 2 }, current_units: { temperature_2m: unit },
  daily: { time: [instant / 1000 - 3600], temperature_2m_max: [24], temperature_2m_min: [14], precipitation_probability_max: [30] },
  daily_units: { temperature_2m_max: unit, temperature_2m_min: unit, precipitation_probability_max: '%' },
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(t: TestContext, loader: (url: URL, init?: RequestInit) => Promise<Response> | Response = () => response(providerForecast()), apiKey = '') {
  const directory = mkdtempSync(join(tmpdir(), 'nova-weather-')), store = new Store(directory), calls: URL[] = [];
  let now = instant;
  const fetcher: typeof fetch = async (input, init) => { const url = new URL(String(input)); calls.push(url); return loader(url, init); };
  const service = new HomeWeatherService(store, fetcher, () => now, apiKey);
  const save = (widgets: HomeWidget[]) => { const layout = store.readEntity('layout', 'layout')!; store.mutate('owner', { kind: 'layout', entityId: 'layout', requestId: randomUUID(), epoch: store.epoch, expectedRevision: layout.revision, payload: { ...layout.value, widgets } }); };
  const widget = createHomeWidget('weather'); widget.settings = { location, units: 'celsius' }; save([widget]);
  t.after(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service, widget, calls, save, advance(milliseconds: number) { now += milliseconds; } };
}

test('Weather settings are bounded and only saved Weather identities may fetch', async t => {
  const f = fixture(t), unconfigured = createHomeWidget('weather'), note = createHomeWidget('note'); f.save([unconfigured, note]);
  assert.deepEqual(await f.service.read(unconfigured.id), { widgetId: unconfigured.id, location: null, units: 'celsius', forecast: null, fetchedAt: null, dataTime: null, stale: false, error: 'Choose a location for this widget.' });
  await assert.rejects(f.service.read(note.id), /Save a Weather widget/);
  await assert.rejects(f.service.read('https://internal.invalid/'), /Save a Weather widget/);
  assert.equal(f.calls.length, 0);
  for (const patch of [{ latitude: 91 }, { longitude: -181 }, { timezone: 'Invalid/Zone' }, { name: 'x'.repeat(121) }]) assert.equal(homeWidgetSchema.safeParse({ ...f.widget, settings: { location: { ...location, ...patch } } }).success, false);
  assert.equal(homeWidgetSchema.safeParse({ ...note, settings: { location } }).success, false);
  assert.equal(createHomeWidget('clock').size, 'compact');
  assert.deepEqual(createHomeWidget('next-action').settings, { projectId: null });
});

test('Forecast reads coalesce by coordinates and units, retain each widget identity, and cache for fifteen minutes', async t => {
  let finish!: (result: Response) => void;
  const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const second = createHomeWidget('weather'); second.settings = { location: { ...location, name: 'My other label' }, units: 'celsius' }; f.save([f.widget, second]);
  const firstRead = f.service.read(f.widget.id), secondRead = f.service.read(second.id);
  assert.equal(f.calls.length, 1); finish(response(providerForecast()));
  const [first, other] = await Promise.all([firstRead, secondRead]);
  assert.equal(first.widgetId, f.widget.id); assert.deepEqual(first.location, location);
  assert.equal(other.widgetId, second.id); assert.equal(other.location?.name, 'My other label');
  assert.equal(first.forecast?.temperature, 20); assert.equal(first.dataTime, new Date(instant).toISOString());
  assert.equal(first.stale, false); assert.deepEqual(homeWeatherResultSchema.parse(first), first);
  const url = f.calls[0]; assert.equal(url.origin, 'https://api.open-meteo.com'); assert.equal(url.pathname, '/v1/forecast'); assert.equal(url.searchParams.get('forecast_days'), '1'); assert.equal(url.searchParams.get('timezone'), 'auto'); assert.equal(url.searchParams.get('temperature_unit'), 'celsius');
  await f.service.read(f.widget.id); f.advance(15 * 60 * 1000 - 1); await f.service.read(f.widget.id); assert.equal(f.calls.length, 1);
  f.advance(1); const refresh = f.service.read(f.widget.id); assert.equal(f.calls.length, 2); finish(response(providerForecast())); await refresh;
});

test('Provider failures retain the last confirmed forecast with a stale label and bounded retry', async t => {
  let failed = false;
  const f = fixture(t, () => failed ? response({ error: true, reason: 'private diagnostic must not escape' }, 429) : response(providerForecast()));
  const first = await f.service.read(f.widget.id); f.advance(15 * 60 * 1000); failed = true;
  const stale = await f.service.read(f.widget.id);
  assert.deepEqual(stale.forecast, first.forecast); assert.equal(stale.fetchedAt, first.fetchedAt); assert.equal(stale.stale, true); assert.match(stale.error!, /temporarily unavailable/);
  assert.doesNotMatch(JSON.stringify(stale), /private diagnostic/);
  await f.service.read(f.widget.id); assert.equal(f.calls.length, 2);
  f.advance(60 * 1000); failed = false; const recovered = await f.service.read(f.widget.id);
  assert.equal(recovered.stale, false); assert.equal(recovered.error, undefined); assert.notEqual(recovered.fetchedAt, first.fetchedAt);
});

test('Changed settings during a request cannot relabel the earlier location as the new forecast', async t => {
  let finish!: (result: Response) => void;
  const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const pending = f.service.read(f.widget.id);
  f.widget.settings = { location: { ...location, latitude: 40 }, units: 'fahrenheit' }; f.save([f.widget]);
  finish(response(providerForecast())); await assert.rejects(pending, /settings changed/);
  const changed = f.service.read(f.widget.id); assert.equal(f.calls[1].searchParams.get('latitude'), '40'); assert.equal(f.calls[1].searchParams.get('temperature_unit'), 'fahrenheit');
  finish(response(providerForecast('°F'))); assert.equal((await changed).units, 'fahrenheit');
});

test('Location searches are explicit, bounded, cached and use only the fixed geocoding provider', async t => {
  const f = fixture(t, () => response({ results: [{ name: 'Example', admin1: 'Region', country: 'Country', latitude: 35, longitude: -120, timezone: location.timezone }] }));
  for (const q of ['', 'a', 'x'.repeat(101), null]) await assert.rejects(f.service.search(q));
  assert.equal(f.calls.length, 0);
  const result = await f.service.search(' Example ');
  assert.deepEqual(result, { locations: [{ ...location, name: 'Example, Region, Country' }], attribution: 'GeoNames' });
  await f.service.search('example'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].origin, 'https://geocoding-api.open-meteo.com'); assert.equal(f.calls[0].searchParams.get('count'), '5');
  await f.service.search('https://internal.invalid/path?q=value');
  assert.equal(f.calls[1].origin, 'https://geocoding-api.open-meteo.com'); assert.equal(f.calls[1].searchParams.get('name'), 'https://internal.invalid/path?q=value');
});

test('Malformed, oversized and inconsistent provider data cannot become a displayed forecast', async t => {
  const bad: unknown[] = [null, {}, { ...providerForecast(), current: { time: 'bad', temperature_2m: 20, weather_code: 0 } }, providerForecast('°F'), { ...providerForecast(), daily: { ...providerForecast().daily, precipitation_probability_max: [101] } }, { ...providerForecast(), daily: { ...providerForecast().daily, temperature_2m_min: [30] } }];
  for (const payload of bad) {
    const f = fixture(t, () => response(payload)), result = await f.service.read(f.widget.id);
    assert.equal(result.forecast, null); assert.equal(result.fetchedAt, null); assert.equal(result.stale, false); assert.match(result.error!, /unavailable/);
  }
  const huge = fixture(t, () => response({ padding: 'x'.repeat(70000) })); assert.equal((await huge.service.read(huge.widget.id)).forecast, null);
  const badLocations = fixture(t, () => response({ results: Array.from({ length: 6 }, () => ({ ...location })) })); await assert.rejects(badLocations.service.search('Example'), /temporarily unavailable/);
});

test('Forecast cache stays bounded and commercial credentials remain in provider requests only', async t => {
  const f = fixture(t, () => response(providerForecast()));
  for (let i = 0; i < 65; i++) { f.widget.settings = { location: { ...location, latitude: i }, units: 'celsius' }; f.save([f.widget]); await f.service.read(f.widget.id); }
  f.widget.settings = { location: { ...location, latitude: 0 }, units: 'celsius' }; f.save([f.widget]); await f.service.read(f.widget.id);
  assert.equal(f.calls.length, 66);
  const secret = 'synthetic-provider-key';
  const commercial = fixture(t, url => url.pathname === '/v1/search' ? response({}) : response(providerForecast()), secret);
  const forecast = await commercial.service.read(commercial.widget.id), locations = await commercial.service.search('Example');
  assert.equal(commercial.calls[0].origin, 'https://customer-api.open-meteo.com'); assert.equal(commercial.calls[1].origin, 'https://customer-geocoding-api.open-meteo.com');
  assert.ok(commercial.calls.every(url => url.searchParams.get('apikey') === secret)); assert.doesNotMatch(JSON.stringify([forecast, locations]), /synthetic-provider-key/);
});

test('Weather HTTP reads require a session, reject foreign origins and arbitrary query parameters, and allow only narrow phone GET routes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'nova-weather-http-')); let calls = 0;
  const server = await startServer({ directory: root, port: 0, weatherFetch: async () => { calls++; return response(providerForecast()); } });
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
  const widget = createHomeWidget('weather'); widget.settings = { location, units: 'celsius' };
  const layout = server.store.readEntity('layout', 'layout')!;
  server.store.mutate('owner', { kind: 'layout', entityId: 'layout', requestId: randomUUID(), epoch: server.store.epoch, expectedRevision: layout.revision, payload: { ...layout.value, widgets: [widget] } });
  const path = '/api/home/weather?widgetId=' + encodeURIComponent(widget.id);
  assert.equal((await fetch(server.origin + path)).status, 401);
  const login = await fetch(server.origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: '{}' });
  const Cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(server.origin + path, { headers: { Cookie, Origin: 'https://foreign.test' } })).status, 403);
  assert.equal((await fetch(server.origin + path + '&url=https://internal.invalid', { headers: { Cookie } })).status, 400);
  assert.equal((await fetch(server.origin + '/api/home/weather/locations?q=a', { headers: { Cookie } })).status, 400);
  assert.equal(calls, 0);
  const good = await fetch(server.origin + path, { headers: { Cookie } }); assert.equal(good.status, 200); assert.equal((await good.json()).widgetId, widget.id); assert.equal(calls, 1);
  for (const route of ['/api/home/weather', '/api/home/weather/locations']) { assert.equal(phoneRouteAllowed(route, 'GET'), true); assert.equal(phoneRouteAllowed(route, 'POST'), false); }
});
