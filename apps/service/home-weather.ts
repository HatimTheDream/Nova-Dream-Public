import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import { homeWidgetSchema, resolveWidgetType } from '../../packages/domain/home-widgets.js';
import { homeWeatherForecastSchema, homeWeatherLocationSchema, homeWeatherResultSchema, homeWeatherTimezoneSchema, type HomeWeatherForecast, type HomeWeatherLocation, type HomeWeatherLocations, type HomeWeatherResult, type HomeWeatherUnits } from '../../packages/domain/home-weather.js';
import { Fault, type Store } from './store.js';

const freshnessMs = 15 * 60 * 1000, retryMs = 60 * 1000, maximumEntries = 64;
const unavailable = 'Weather is temporarily unavailable. Try again shortly.';
const querySchema = z.string().trim().min(2).max(100);
const currentTime = z.number().int().min(0).max(4102444800);
const temperature = z.number().min(-150).max(180).nullable();
const providerForecastSchema = z.object({
  timezone: homeWeatherTimezoneSchema,
  current: z.object({ time: currentTime, temperature_2m: z.number().min(-150).max(180), weather_code: z.number().int().min(0).max(99) }),
  current_units: z.object({ temperature_2m: z.enum(['°C', '°F']) }),
  daily: z.object({ time: z.array(currentTime).length(1), temperature_2m_max: z.array(temperature).length(1), temperature_2m_min: z.array(temperature).length(1), precipitation_probability_max: z.array(z.number().min(0).max(100).nullable()).length(1) }),
  daily_units: z.object({ temperature_2m_max: z.enum(['°C', '°F']), temperature_2m_min: z.enum(['°C', '°F']), precipitation_probability_max: z.literal('%') }),
});
const providerLocationsSchema = z.object({ results: z.array(z.object({
  name: z.string().min(1).max(120), admin1: z.string().max(120).optional(), country: z.string().max(120).optional(),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), timezone: homeWeatherTimezoneSchema,
})).max(5).optional() });
type Reading = { forecast: HomeWeatherForecast; fetchedAt: string; dataTime: string };
type ForecastCache = { reading: Reading | null; checkedAt: number; error?: string };

/** Public weather reads only. Saved widget configuration selects a fixed provider. */
export class HomeWeatherService {
  private cache = new Map<string, ForecastCache>();
  private forecasts = new Map<string, Promise<ForecastCache>>();
  private searches = new Map<string, Promise<HomeWeatherLocations>>();
  private locations = new Map<string, { checkedAt: number; value: HomeWeatherLocations }>();
  private shutdown = new AbortController();
  constructor(private store: Store, private fetcher: typeof fetch = fetch, private now: () => number = Date.now, private apiKey = process.env.OPEN_METEO_API_KEY?.trim() ?? '') {}

  private keep<T>(map: Map<string, T>, key: string, value: T) {
    map.delete(key); map.set(key, value);
    while (map.size > maximumEntries) map.delete(map.keys().next().value!);
  }
  private async json(url: URL): Promise<unknown> {
    if (this.store.recoveryEffectsPaused) throw new Fault(409, 'weather_paused', 'Weather reads are paused in this recovery workspace.');
    if (this.apiKey) url.searchParams.set('apikey', this.apiKey);
    const response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(6000)]), headers: { Accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Weather request unavailable.'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing weather response.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 65536) { await reader.cancel(); throw new Error('Weather response too large.'); } chunks.push(part.value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { reader.releaseLock(); }
  }
  private widget(id: unknown) {
    const widgetId = z.string().min(1).max(100).parse(id);
    const saved = this.store.readEntity('layout', 'layout')?.value.widgets.find(widget => widget.id === widgetId);
    if (!saved || resolveWidgetType(saved) !== 'weather') throw new Fault(404, 'weather_widget_missing', 'Save a Weather widget before loading its forecast.');
    const widget = homeWidgetSchema.parse(saved);
    return { widgetId, location: widget.settings?.location ?? null, units: widget.settings?.units ?? 'celsius' as HomeWeatherUnits };
  }
  async read(id: unknown): Promise<HomeWeatherResult> {
    const identity = this.widget(id);
    const empty = { ...identity, forecast: null, fetchedAt: null, dataTime: null, stale: false };
    if (!identity.location) return { ...empty, error: 'Choose a location for this widget.' };
    const key = canonical([identity.location.latitude, identity.location.longitude, identity.units]);
    let cached = this.cache.get(key);
    if (!cached || this.now() - cached.checkedAt >= (cached.error ? retryMs : freshnessMs)) {
      let pending = this.forecasts.get(key);
      if (!pending) {
        if (this.forecasts.size >= 8) throw new Fault(429, 'weather_busy', 'Weather is already refreshing. Try again shortly.');
        pending = this.refresh(identity.location, identity.units, cached?.reading ?? null).then(result => { this.keep(this.cache, key, result); return result; }).finally(() => { this.forecasts.delete(key); });
        this.forecasts.set(key, pending);
      }
      cached = await pending;
    }
    if (canonical(this.widget(id)) !== canonical(identity)) throw new Fault(409, 'weather_widget_changed', 'The widget settings changed. Load its saved location again.');
    return homeWeatherResultSchema.parse({ ...empty, ...(cached.reading ?? {}), stale: Boolean(cached.reading && cached.error), ...(cached.error ? { error: cached.error } : {}) });
  }
  private async refresh(location: HomeWeatherLocation, units: HomeWeatherUnits, prior: Reading | null): Promise<ForecastCache> {
    try {
      const url = new URL(`https://${this.apiKey ? 'customer-api' : 'api'}.open-meteo.com/v1/forecast`);
      url.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), current: 'temperature_2m,weather_code', daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max', timezone: 'auto', temperature_unit: units, forecast_days: '1', timeformat: 'unixtime' }).toString();
      const data = providerForecastSchema.parse(await this.json(url));
      const unit = units === 'fahrenheit' ? '°F' : '°C';
      if ([data.current_units.temperature_2m, data.daily_units.temperature_2m_max, data.daily_units.temperature_2m_min].some(value => value !== unit)) throw new Error('Weather units did not match.');
      const forecast = homeWeatherForecastSchema.parse({ temperature: data.current.temperature_2m, weatherCode: data.current.weather_code, high: data.daily.temperature_2m_max[0], low: data.daily.temperature_2m_min[0], precipitationProbability: data.daily.precipitation_probability_max[0] });
      return { checkedAt: this.now(), reading: { forecast, fetchedAt: new Date(this.now()).toISOString(), dataTime: new Date(data.current.time * 1000).toISOString() } };
    } catch { return { checkedAt: this.now(), reading: prior, error: unavailable }; }
  }
  async search(query: unknown): Promise<HomeWeatherLocations> {
    const name = querySchema.parse(query), key = name.toLocaleLowerCase('en');
    const cached = this.locations.get(key);
    if (cached && this.now() - cached.checkedAt < 60 * 60 * 1000) return structuredClone(cached.value);
    let pending = this.searches.get(key);
    if (!pending) {
      if (this.searches.size >= 4) throw new Fault(429, 'weather_search_busy', 'A location search is already running. Try again shortly.');
      pending = (async (): Promise<HomeWeatherLocations> => {
        try {
          const url = new URL(`https://${this.apiKey ? 'customer-geocoding-api' : 'geocoding-api'}.open-meteo.com/v1/search`);
          url.search = new URLSearchParams({ name, count: '5', language: 'en', format: 'json' }).toString();
          const data = providerLocationsSchema.parse(await this.json(url));
          const locations = (data.results ?? []).map(item => homeWeatherLocationSchema.parse({ name: [...new Set([item.name, item.admin1, item.country].filter(Boolean))].join(', ').slice(0, 120), latitude: item.latitude, longitude: item.longitude, timezone: item.timezone }));
          const value: HomeWeatherLocations = { locations, attribution: 'GeoNames' };
          this.keep(this.locations, key, { checkedAt: this.now(), value }); return value;
        } catch { throw new Fault(503, 'weather_location_unavailable', 'Location search is temporarily unavailable. Try again shortly.'); }
      })().finally(() => { this.searches.delete(key); });
      this.searches.set(key, pending);
    }
    return structuredClone(await pending);
  }
  close() { this.shutdown.abort(); }
}
