export type WeatherGraphicKind = 'clear' | 'partly-cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'sleet' | 'snow' | 'storm' | 'hail' | 'unknown';

/** WMO groups follow the same provider codes used by the textual conditions. */
export function weatherGraphicKind(code: number | undefined): WeatherGraphicKind {
  if (code === 0) return 'clear';
  if (code === 1 || code === 2) return 'partly-cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ([51, 53, 55].includes(code ?? -1)) return 'drizzle';
  if ([61, 63, 65, 80, 81, 82].includes(code ?? -1)) return 'rain';
  if ([56, 57, 66, 67].includes(code ?? -1)) return 'sleet';
  if ([71, 73, 75, 77, 85, 86].includes(code ?? -1)) return 'snow';
  if (code === 95) return 'storm';
  if (code === 96 || code === 99) return 'hail';
  return 'unknown';
}

function SunShape({ partial = false }: { partial?: boolean }) {
  return <g className="weather-art-sun" transform={partial ? 'translate(14 -10) scale(.8)' : undefined}><g fill="none" strokeWidth="5" strokeLinecap="round"><path d="M80 12v10m0 80v10M30 62H20m120 0h-10M45 27l7 7m56 56 7 7m0-70-7 7M52 90l-7 7"/></g><circle cx="80" cy="62" r="29"/></g>;
}
function CloudShape({ storm = false }: { storm?: boolean }) {
  return <path className={`weather-art-cloud${storm ? ' storm-cloud' : ''}`} d="M43 83C28 83 22 73 25 63c2-9 10-14 20-13 4-18 19-27 34-23 13 3 21 13 22 25 13-6 29 1 31 14 2 11-6 20-19 20H43Z" strokeWidth="3" strokeLinejoin="round"/>;
}
function Snowflake({ x, y }: { x: number; y: number }) {
  return <g className="weather-art-snow" transform={`translate(${x} ${y})`} strokeWidth="2.5" strokeLinecap="round"><path d="M0-7V7m-6-10 12 6m-12 0 12-6"/></g>;
}

/** Decorative: the adjacent text names the condition without relying on graphics. */
export function WeatherGraphic({ code }: { code?: number }) {
  const kind = weatherGraphicKind(code);
  return <svg className={`weather-graphic weather-graphic-${kind}`} viewBox="0 0 160 128" aria-hidden="true" focusable="false" data-weather-kind={kind}>
    {kind === 'clear' && <SunShape/>}
    {kind === 'partly-cloudy' && <><SunShape partial/><CloudShape/></>}
    {['cloudy', 'fog', 'drizzle', 'rain', 'sleet', 'snow', 'storm', 'hail'].includes(kind) && <CloudShape storm={kind === 'storm' || kind === 'hail'}/>}
    {kind === 'fog' && <g className="weather-art-fog" fill="none" strokeWidth="4" strokeLinecap="round"><path d="M30 96h102M40 107h77M55 117h45"/></g>}
    {['drizzle', 'rain', 'sleet'].includes(kind) && <g className="weather-art-rain" fill="none" strokeWidth={kind === 'drizzle' ? 3 : 5} strokeLinecap="round"><path d={kind === 'drizzle' ? 'M48 96l-3 7m35-7-3 7m35-7-3 7' : 'M49 96l-5 14m35-14-5 14m35-14-5 14'}/></g>}
    {kind === 'sleet' && <Snowflake x={128} y={106}/>}
    {kind === 'snow' && <><Snowflake x={47} y={103}/><Snowflake x={79} y={111}/><Snowflake x={111} y={101}/></>}
    {['storm', 'hail'].includes(kind) && <path className="weather-art-lightning" d="m83 78-16 24h14l-4 20 23-29H86l5-15Z" strokeWidth="2" strokeLinejoin="round"/>}
    {kind === 'hail' && <g className="weather-art-hail"><circle cx="45" cy="101" r="4"/><circle cx="118" cy="103" r="4"/><circle cx="124" cy="117" r="3"/></g>}
    {kind === 'unknown' && <g className="weather-art-unknown" fill="none" strokeWidth="3" strokeLinecap="round"><circle cx="80" cy="62" r="32" strokeDasharray="4 7"/><path d="M71 50c0-13 22-13 22 0 0 8-13 9-13 17"/><circle cx="80" cy="78" r="1"/></g>}
  </svg>;
}