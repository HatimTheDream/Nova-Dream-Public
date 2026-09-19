import { useEffect, useState } from 'react';
import type { HomeWidget } from '../../../packages/domain/home-widgets';
import { homeWeatherResultSchema, type HomeWeatherResult } from '../../../packages/domain/home-weather';
import { ApiError, request } from './api';
import { WeatherGraphic } from './WeatherGraphic';

const pollInterval = 15 * 60 * 1000;

export function weatherResponseMatches(widget: HomeWidget, result: HomeWeatherResult): boolean {
  const location = widget.settings?.location, received = result.location;
  return !!location && !!received && widget.id === result.widgetId && (widget.settings?.units ?? 'celsius') === result.units
    && location.name === received.name && location.latitude === received.latitude && location.longitude === received.longitude && location.timezone === received.timezone;
}

// WMO groups documented by Open-Meteo: https://open-meteo.com/en/docs#weathervariables
export function homeWeatherCondition(code: number): string {
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if ([45, 48].includes(code)) return 'Fog';
  if ([51, 53, 55].includes(code)) return 'Drizzle';
  if ([56, 57].includes(code)) return 'Freezing drizzle';
  if ([61, 63, 65].includes(code)) return 'Rain';
  if ([66, 67].includes(code)) return 'Freezing rain';
  if ([71, 73, 75, 77].includes(code)) return 'Snow';
  if ([80, 81, 82].includes(code)) return 'Rain showers';
  if ([85, 86].includes(code)) return 'Snow showers';
  if (code === 95) return 'Thunderstorms';
  if ([96, 99].includes(code)) return 'Thunderstorms with hail';
  return 'Conditions unavailable';
}

function forecastTime(value: string | null, timezone: string): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(undefined, { timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function WeatherAttribution({ sample = false }: { sample?: boolean }) {
  return <p className="weather-credit">{sample ? 'Open-Meteo · CC BY 4.0' : <><a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a></>}</p>;
}

export function WeatherReading({ forecast, locationName, units, size, stale = false, age = '', timestamp, error, loading = false, retry, sample = false }: {
  forecast: NonNullable<HomeWeatherResult['forecast']>;
  locationName: string;
  units: HomeWeatherResult['units'];
  size: HomeWidget['size'];
  stale?: boolean;
  age?: string;
  timestamp?: string | null;
  error?: string;
  loading?: boolean;
  retry?: () => void;
  sample?: boolean;
}) {
  const compact = size === 'compact';
  const temperature = (value: number | null) => value === null ? <span>Unavailable</span> : `${Math.round(value)}°`;
  return <div className={`home-content home-weather home-weather-visual weather-size-${size}`} aria-busy={loading} data-weather-stale={stale || undefined}>
    <p className="weather-location" title={locationName}>{locationName}</p>
    <div className="weather-scene"><div className="weather-temperature-block"><strong className="weather-temperature">{Math.round(forecast.temperature)}<span>{units === 'fahrenheit' ? '°F' : '°C'}</span></strong><p className="weather-condition">{compact && stale ? `Last available${age ? ` · ${age}` : ''}` : homeWeatherCondition(forecast.weatherCode)}</p></div><WeatherGraphic code={forecast.weatherCode}/></div>
    {!compact && <dl className="weather-metrics"><div><dt>High Today</dt><dd>{temperature(forecast.high)}</dd></div><div><dt>Low Today</dt><dd>{temperature(forecast.low)}</dd></div><div><dt>Rain Or Snow</dt><dd>{forecast.precipitationProbability === null ? <span>Unavailable</span> : `${Math.round(forecast.precipitationProbability)}%`}</dd></div></dl>}
    <div className="weather-footnotes">{!compact && (stale ? <p className="weather-status" title={error} role="status">Last available forecast{age ? ` · ${age}` : ''}</p> : timestamp && <p className="weather-data-time">Forecast for {timestamp}</p>)}<WeatherAttribution sample={sample}/></div>
    {!compact && error && retry && <button className="home-action weather-retry" disabled={loading} onClick={retry}>{loading ? 'Checking…' : 'Try Again'}</button>}
  </div>;
}
export function HomeWeatherWidget({ widget, customize }: { widget: HomeWidget; customize?: () => void }) {
  const location = widget.settings?.location, compact = widget.size === 'compact';
  const identity = JSON.stringify([widget.id, location ?? null, widget.settings?.units ?? 'celsius']);
  const [received, setReceived] = useState<{ identity: string; result: HomeWeatherResult }>();
  const [failure, setFailure] = useState<{ identity: string; message: string }>();
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!location) return;
    let disposed = false, running = false, syncAttempts = 0, lastRead = 0;
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const waiting = () => {
      setFailure({ identity, message: 'Waiting for this widget’s settings to sync. Your chosen location is kept.' });
      if (syncAttempts++ < 5) syncTimer = setTimeout(() => void read(), 2000);
    };
    const read = async () => {
      if (disposed || running) return;
      running = true; lastRead = Date.now(); setLoading(true);
      controller = new AbortController();
      try {
        const parsed = homeWeatherResultSchema.safeParse(await request<unknown>(`home/weather?widgetId=${encodeURIComponent(widget.id)}`, undefined, controller.signal));
        if (disposed) return;
        if (!parsed.success) throw new Error('The weather response was incomplete. Try again.');
        const result = parsed.data;
        if (!weatherResponseMatches(widget, result)) { waiting(); return; }
        setReceived(previous => ({ identity, result: !result.forecast && previous?.identity === identity && previous.result.forecast
          ? { ...result, forecast: previous.result.forecast, fetchedAt: previous.result.fetchedAt, dataTime: previous.result.dataTime, stale: true, error: result.error ?? 'Weather could not be refreshed.' } : result }));
        setFailure(undefined); syncAttempts = 0;
      } catch (reason) {
        if (disposed || controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.status === 404) waiting();
        else setFailure({ identity, message: reason instanceof Error ? reason.message : 'Weather could not be refreshed. Try again.' });
      } finally { running = false; if (!disposed) setLoading(false); }
    };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, pollInterval);
    const visible = () => { if (!document.hidden && Date.now() - lastRead >= pollInterval) void read(); };
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; controller?.abort(); clearInterval(timer); clearTimeout(syncTimer); document.removeEventListener('visibilitychange', visible); };
  }, [identity, retry]);

  if (!location) return <div className={`home-content home-weather home-weather-visual weather-placeholder weather-size-${widget.size}`}>
    {!compact && <WeatherGraphic/>}{compact ? <p>Choose your weather location.</p> : <div><h3>Weather Where You Are</h3><p>Choose a city for current conditions and today’s outlook.</p></div>}
    <button className="home-action" onClick={customize}>Choose A City</button>
  </div>;
  const result = received?.identity === identity ? received.result : undefined;
  const error = failure?.identity === identity ? failure.message : result?.error;
  const forecast = result?.forecast;
  const stale = !!forecast && (!!error || result?.stale === true);
  const observed = result ? forecastTime(result.dataTime, location.timezone) : null;
  const fetched = result ? forecastTime(result.fetchedAt, location.timezone) : null;
  const ageMinutes = result?.fetchedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(result.fetchedAt)) / 60000)) : null;
  const age = ageMinutes === null || !Number.isFinite(ageMinutes) ? '' : ageMinutes < 1 ? 'less than a minute ago' : ageMinutes < 60 ? `${ageMinutes} min ago` : `${Math.floor(ageMinutes / 60)} hr ago`;
  const again = () => setRetry(value => value + 1);
  if (forecast) return <WeatherReading forecast={forecast} locationName={location.name} units={widget.settings?.units ?? 'celsius'} size={widget.size} stale={stale} age={age} timestamp={observed ?? fetched} error={error} loading={loading} retry={again}/>;
  return <div className={`home-content home-weather home-weather-visual weather-placeholder weather-size-${widget.size}`} aria-busy={loading}>
    <p className="weather-location" title={location.name}>{location.name}</p>
    {!compact && <WeatherGraphic/>}
    <p className="weather-missing" title={error} role="status">{loading ? 'Loading weather…' : error ?? 'Weather is unavailable right now.'}</p>
    <button className="home-action" disabled={loading} onClick={again}>{loading ? 'Checking…' : 'Try Again'}</button>
    {!compact && <WeatherAttribution/>}
  </div>;
}
