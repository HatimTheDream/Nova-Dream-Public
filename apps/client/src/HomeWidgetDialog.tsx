import { useEffect, useId, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { createHomeWidget, homeWidgetColors, homeWidgetLimit, homeWidgetNames, homeWidgetSchema, homeWidgetTypes, legacyHomeWidgetIds, resolveWidgetType, widgetTitle, type HomeWidget, type HomeWidgetType } from '../../../packages/domain/home-widgets';
import { homeWeatherLocationsSchema, type HomeWeatherLocation } from '../../../packages/domain/home-weather';
import { readLocal, request, saveLocal } from './api';
import { Dialog } from './ui';
import { WeatherReading } from './HomeWeatherWidget';
import { AlertCircle, CalendarDays, CheckSquare2, Clock3, FileText, Home as HomeIcon, Link2, MessageSquare, RefreshCw, Sun, Target, Zap } from './icons';

const descriptions: Record<HomeWidgetType, string> = {
  welcome: 'See the date, time, and your task overview together.',
  clock: 'A simple clock with the date and a timezone of your choice.',
  weather: 'See current conditions and today’s outlook for a city you choose.',
  next: 'Make a task list for a project or a part of your day.',
  'next-action': 'See one ready task and open it when you want to begin.',
  'next-appointment': 'See your next scheduled event and open Calendar for the details.',
  'daily-routines': 'See today’s unfinished recurring routines in order.',
  draft: 'Return to your Assistant draft and see whether your writing is kept.',
  attention: 'See tasks that are overdue, blocked, or waiting for your attention.',
  setup: 'Keep your everyday workspace actions close at hand.',
  note: 'Keep a thought, checklist, or reference on your board.',
  links: 'Collect the websites and resources you use most.',
};
const libraryOrder: HomeWidgetType[] = ['clock', 'weather', 'next-action', 'daily-routines', 'next-appointment', 'next', 'note', 'links', 'draft', 'attention', 'setup', 'welcome'];
const colorNames = { default: 'Default', cream: 'Cream', sky: 'Sky', sage: 'Sage', rose: 'Rose', lavender: 'Lavender', slate: 'Slate' } as const;
const categories = ['All Widgets', 'Work', 'Personal'] as const;
const personalTypes: HomeWidgetType[] = ['welcome', 'clock', 'weather', 'note', 'links'];
const sizeOptions = [
  { value: 'compact', name: 'Compact', description: '1 Column · Short' },
  { value: 'square', name: 'Standard', description: '1 Column · Tall' },
  { value: 'wide', name: 'Wide', description: '2 Columns · Tall' },
  { value: 'large', name: 'Large', description: '2 Columns · Extra Tall' },
] as const;
type EditorDraft = { version: 1; selected?: HomeWidgetType; forms: Partial<Record<HomeWidgetType, HomeWidget>>; original?: HomeWidget };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// An unfinished link may deliberately have no URL yet, so validating drafts with
// the final widget schema would discard useful writing on the next visit.
function isFormWidget(value: unknown): value is HomeWidget {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.hidden !== 'boolean' || !sizeOptions.some(size => size.value === value.size)) return false;
  if (value.type !== undefined && !homeWidgetTypes.includes(value.type as HomeWidgetType)) return false;
  if (value.type === undefined && !legacyHomeWidgetIds.some(type => type === value.id)) return false;
  if (value.title !== undefined && typeof value.title !== 'string') return false;
  if (value.color !== undefined && !homeWidgetColors.some(color => color === value.color)) return false;
  if (value.settings === undefined) return true;
  if (!isObject(value.settings)) return false;
  const settings = value.settings;
  if (settings.view !== undefined && !['ready', 'all', 'attention', 'upcoming'].includes(String(settings.view))) return false;
  if (settings.projectId !== undefined && settings.projectId !== null && typeof settings.projectId !== 'string') return false;
  if (settings.limit !== undefined && (typeof settings.limit !== 'number' || !Number.isFinite(settings.limit))) return false;
  if (settings.text !== undefined && typeof settings.text !== 'string') return false;
  if (settings.timezone !== undefined && typeof settings.timezone !== 'string') return false;
  if (settings.units !== undefined && !['celsius', 'fahrenheit'].includes(String(settings.units))) return false;
  if (settings.location !== undefined && (!isObject(settings.location) || typeof settings.location.name !== 'string' || typeof settings.location.latitude !== 'number' || typeof settings.location.longitude !== 'number' || typeof settings.location.timezone !== 'string')) return false;
  return settings.links === undefined || (Array.isArray(settings.links) && settings.links.length <= 12 && settings.links.every(link => isObject(link) && typeof link.id === 'string' && typeof link.label === 'string' && typeof link.url === 'string'));
}
function restoreDraft(key: string, widget?: HomeWidget): EditorDraft {
  const kept = readLocal<unknown>(key);
  if (isObject(kept) && kept.version === 1 && isObject(kept.forms) && (kept.selected === undefined || homeWidgetTypes.includes(kept.selected as HomeWidgetType))
    && Object.entries(kept.forms).every(([type, form]) => homeWidgetTypes.includes(type as HomeWidgetType) && isFormWidget(form) && resolveWidgetType(form) === type)
    && (kept.original === undefined || isFormWidget(kept.original))) {
    const draft = kept as EditorDraft;
    if (!widget || (draft.original?.id === widget.id && draft.forms[resolveWidgetType(widget)]?.id === widget.id)) return draft;
  }
  return widget ? { version: 1, selected: resolveWidgetType(widget), forms: { [resolveWidgetType(widget)]: widget }, original: widget } : { version: 1, forms: {} };
}

function WidgetPreview({ widget, sample = false }: { widget: HomeWidget; sample?: boolean }) {
  const type = resolveWidgetType(widget), links = widget.settings?.links ?? [], compact = widget.size === 'compact';
  const capacity = compact ? 1 : widget.size === 'large' ? 6 : widget.size === 'wide' ? 3 : 2;
  return <div className={`home-widget-preview preview-${type} preview-size-${widget.size}`} data-widget-color={widget.color ?? 'default'} aria-hidden={sample || undefined}>
    <strong className="home-preview-title">{widgetTitle(widget)}</strong>
    {type === 'clock' && <><span className="home-preview-clock-digits">9:41<span>AM</span></span><span className="home-preview-date">Monday, September 21</span><small>{widget.settings?.timezone?.replaceAll('_', ' ') || 'Local Time'}</small></>}
    {type === 'welcome' && <><div className="home-preview-day-date"><span>Monday</span><strong>September 21</strong></div><span className="home-preview-clock-digits">9:41<span>AM</span></span>{!compact && <><div className="home-preview-day-stats"><span><strong>3</strong>Ready Tasks</span><span><strong>1</strong>Need Review</span></div><span className="home-preview-action">Open Tasks</span></>}</>}
    {type === 'weather' && <WeatherReading forecast={{ temperature: widget.settings?.units === 'fahrenheit' ? 73 : 23, weatherCode: 0, high: widget.settings?.units === 'fahrenheit' ? 79 : 26, low: widget.settings?.units === 'fahrenheit' ? 64 : 18, precipitationProbability: 0 }} locationName={widget.settings?.location?.name || 'San Francisco'} units={widget.settings?.units ?? 'celsius'} size={widget.size} timestamp="Sep 21, 9:30 AM" sample/>}
    {type === 'next' && <>{!compact && <span className="home-preview-kicker">Your ready tasks</span>}{['Plan the next step', 'Review the latest draft', 'Send project notes', 'Outline the next idea', 'Check the final details', 'Share an update'].slice(0, capacity).map(title => <span className="home-preview-task" key={title}>{title}</span>)}<span className="home-preview-action">Open Tasks</span></>}
    {type === 'next-action' && <>{!compact && <span className="home-preview-kicker">Up next</span>}<strong className="home-preview-headline">Review the latest draft</strong>{!compact && <small>Project work · Ready</small>}<span className="home-preview-action">Open Task</span></>}
    {type === 'next-appointment' && <>{!compact && <div className="home-preview-event-date"><span>MON</span><strong>21</strong></div>}<div className="home-preview-event"><small>10:00 – 10:30 AM</small><strong>Project check-in</strong>{!compact && <span>In 20 minutes</span>}</div>{widget.size === 'large' && <><div className="home-preview-event home-preview-event-secondary"><small>1:30 – 2:00 PM</small><strong>Planning session</strong></div><div className="home-preview-event home-preview-event-secondary"><small>4:00 – 4:30 PM</small><strong>Project review</strong></div></>}<span className="home-preview-action">Open Calendar</span></>}
    {type === 'daily-routines' && <>{!compact && <span className="home-preview-kicker">Your daily rhythm</span>}{['Review today’s plan', 'Daily check-in', 'Read a few pages', 'Make time for a walk', 'Tidy the workspace', 'Wrap up the day'].slice(0, capacity).map((title, index) => <span className="home-preview-routine" key={title}><b>{index + 1}</b>{title}</span>)}<span className="home-preview-action">Open Tasks</span></>}
    {type === 'draft' && <>{!compact && <span className="home-preview-kicker">A thought to come back to</span>}<strong className="home-preview-headline">Let’s make a plan.</strong>{!compact && <span className="home-preview-draft">Help me work through the next steps for…</span>}<span className="home-preview-action">Continue Draft</span></>}
    {type === 'attention' && <><span className="home-preview-attention-count">2<span>need a fresh look</span></span>{!compact && <span className="home-preview-attention-item">Review the proposal<small>Overdue</small></span>}<span className="home-preview-action">Review Tasks</span></>}
    {type === 'setup' && <div className="home-preview-actions"><span className="home-preview-action">New Task</span><span className="home-preview-action">Open Assistant</span>{!compact && <span className="home-preview-action">Connections</span>}</div>}
    {type === 'note' && <span className="home-preview-note">{widget.settings?.text || 'A little room for ideas.\n\nStart with the thing you don’t want to forget.'}</span>}
    {type === 'links' && <div className="home-preview-links">{(links.length ? links.slice(0, capacity) : [{ id: 'example-1', label: 'Project resources', url: '' }, { id: 'example-2', label: 'Daily reading', url: '' }, { id: 'example-3', label: 'Inspiration', url: '' }].slice(0, capacity)).map(link => <span className="home-preview-link" key={link.id}><span>{(link.label || 'L').slice(0, 1).toUpperCase()}</span><strong>{link.label || link.url || 'Untitled link'}</strong></span>)}{links.length > capacity && <small>{links.length - capacity} more links</small>}</div>}
  </div>;
}
const galleryIcons: Record<HomeWidgetType, typeof Clock3> = { clock: Clock3, weather: Sun, 'next-action': Target, 'daily-routines': RefreshCw, 'next-appointment': CalendarDays, next: CheckSquare2, note: FileText, links: Link2, draft: MessageSquare, attention: AlertCircle, setup: Zap, welcome: HomeIcon };

export function HomeWidgetDialog({ widget, widgets, projects, storageKey, defaultTaskView = 'ready', onSave, onRestore, close }: {
  widget?: HomeWidget;
  widgets: HomeWidget[];
  projects: Snapshot['projects'];
  storageKey: string;
  defaultTaskView?: 'ready' | 'all';
  onSave: (widget: HomeWidget) => void;
  onRestore: (id: string) => void;
  close: () => void;
}) {
  const key = `${storageKey}:${widget?.id ?? 'new'}`;
  const [draft, setDraft] = useState(() => restoreDraft(key, widget));
  const [search, setSearch] = useState('');
  const [galleryType, setGalleryType] = useState<HomeWidgetType>('clock');
  const [gallerySize, setGallerySize] = useState<HomeWidget['size']>(() => draft.selected ? draft.forms[draft.selected]?.size ?? 'compact' : 'compact');
  const [category, setCategory] = useState<typeof categories[number]>('All Widgets');
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [notice, setNotice] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [cityQuery, setCityQuery] = useState('');
  const [locations, setLocations] = useState<HomeWeatherLocation[]>([]);
  const [searchingCities, setSearchingCities] = useState(false);
  const [cityError, setCityError] = useState('');
  const [citySearchDone, setCitySearchDone] = useState(false);
  const locationRequest = useRef<AbortController | null>(null), locationSequence = useRef(0);
  const fieldId = useId(), configHeading = useRef<HTMLHeadingElement>(null);
  const current = draft.selected ? draft.forms[draft.selected] : undefined;
  const type = current ? resolveWidgetType(current) : undefined;
  const atLimit = !widget && widgets.length >= homeWidgetLimit;
  const currentSaved = widget && widgets.find(item => item.id === widget.id);
  const changedElsewhere = !!(currentSaved && draft.original && JSON.stringify(currentSaved) !== JSON.stringify(draft.original));
  useEffect(() => { if (current) configHeading.current?.focus(); }, [type]);
  useEffect(() => { setSearchingCities(false); return () => { locationSequence.current++; locationRequest.current?.abort(); }; }, [type]);
  useEffect(() => {
    if (!storageError) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [storageError]);

  const persist = (next: EditorDraft) => {
    const success = saveLocal(key, next);
    setStorageError(!success);
    return success;
  };
  const keep = (next: EditorDraft) => { setDraft(next); persist(next); setIssues([]); setError(''); setNotice(''); };
  const patch = (values: Partial<HomeWidget>) => { if (current && type) keep({ ...draft, forms: { ...draft.forms, [type]: { ...current, ...values } } }); };
  const settings = (values: NonNullable<HomeWidget['settings']>) => patch({ settings: { ...current?.settings, ...values } });
  const leave = () => { if (persist(draft)) close(); };
  const choose = (choice: HomeWidgetType, size?: HomeWidget['size']) => {
    const next = { ...draft, selected: choice, forms: { ...draft.forms, [choice]: size ? { ...(draft.forms[choice] ?? createHomeWidget(choice)), size } : draft.forms[choice] ?? createHomeWidget(choice) } };
    keep(next);
  };
  const apply = () => {
    if (!current || !persist(draft)) return;
    if (atLimit) { setError(`This board has ${homeWidgetLimit} widgets, including hidden widgets. Restore a hidden widget or edit one already on your board.`); return; }
    const value = type === 'next' ? { ...current, settings: { ...current.settings, view: current.settings?.view ?? defaultTaskView } } : current;
    const parsed = homeWidgetSchema.safeParse(value);
    if (!parsed.success) {
      setIssues(parsed.error.issues.map(issue => {
        const field = issue.path.join('.').replace(/^settings\./, '').replace(/links\.(\d+)\./, (_, index: string) => `Link ${Number(index) + 1} `);
        return `${field ? `${field}: ` : ''}${issue.message}`;
      }));
      return;
    }
    try {
      onSave(parsed.data);
      const remaining = { ...draft.forms }; delete remaining[type!];
      const nextDraft: EditorDraft | null = !widget && Object.keys(remaining).length ? { version: 1, forms: remaining } : null;
      if (!saveLocal(key, nextDraft)) { setStorageError(true); setNotice('Your changes were passed to Home. The editor draft is still kept; free browser storage before closing.'); return; }
      close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The widget could not be applied. Your editor draft is kept.'); }
  };
  const restore = (id: string) => {
    if (!persist(draft)) return;
    try { onRestore(id); setNotice('Widget restored to your board.'); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The widget could not be restored.'); }
  };
  const findCities = async () => {
    const query = cityQuery.trim();
    if (query.length < 2) { setCityError('Enter at least two characters to find a city.'); return; }
    locationRequest.current?.abort();
    const controller = new AbortController(); locationRequest.current = controller;
    const sequence = ++locationSequence.current;
    setSearchingCities(true); setCityError(''); setCitySearchDone(false); setLocations([]);
    try {
      const result = homeWeatherLocationsSchema.safeParse(await request<unknown>(`home/weather/locations?q=${encodeURIComponent(query)}`, undefined, controller.signal));
      if (!result.success) throw new Error('City search returned incomplete results. Try again.');
      if (sequence === locationSequence.current) { setLocations(result.data.locations); setCitySearchDone(true); }
    } catch (reason) {
      if (sequence === locationSequence.current && !controller.signal.aborted) setCityError(reason instanceof Error ? reason.message : 'Cities could not be loaded. Try again.');
    } finally { if (sequence === locationSequence.current) setSearchingCities(false); }
  };
  const visibleTypes = libraryOrder.filter(candidate => (category === 'All Widgets' || (category === 'Personal' ? personalTypes.includes(candidate) : !personalTypes.includes(candidate)))
    && `${homeWidgetNames[candidate]} ${descriptions[candidate]}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const selectedType = visibleTypes.includes(galleryType) ? galleryType : visibleTypes[0];
  const selectedSize = gallerySize;
  const selectedCount = selectedType ? widgets.filter(item => !item.hidden && resolveWidgetType(item) === selectedType).length : 0;
  const hidden = widgets.filter(item => item.hidden);
  return <Dialog title={widget ? 'Customize Widget' : current ? 'Create A Widget' : 'Add Widgets'} close={leave}>
    <div className="home-widget-dialog">
      {storageError && <div className="home-widget-message home-widget-error" role="alert"><strong>Your edits are only in this window.</strong><p>Free browser storage before applying changes or closing this editor.</p><button type="button" onClick={() => persist(draft)}>Try Keeping Draft Again</button></div>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {notice && <p className="home-widget-message" role="status">{notice}</p>}
      {!current ? <>
        <div className="home-library-heading"><p>Choose what belongs on your Home.</p><span>{widgets.filter(item => !item.hidden).length} on your board</span></div>
        {atLimit && <p className="home-widget-message">Your board has {homeWidgetLimit} widgets. You can customize existing widgets or restore ones you have hidden.</p>}
        <div className="home-widget-gallery">
          <aside className="home-gallery-sidebar" aria-label="Widget library">
            <label className="home-library-search"><span className="sr-only">Find A Widget</span><input type="search" value={search} placeholder="Search Widgets" onChange={event => setSearch(event.target.value)}/></label>
            <div className="home-library-categories" aria-label="Widget categories">{categories.map(item => <button type="button" key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item === 'All Widgets' ? 'All' : item}</button>)}</div>
            <div className="home-gallery-types" aria-label="Widget types">{visibleTypes.map(candidate => {
              const count = widgets.filter(item => !item.hidden && resolveWidgetType(item) === candidate).length, Icon = galleryIcons[candidate];
              return <button type="button" className="home-gallery-type" key={candidate} aria-pressed={selectedType === candidate} onClick={() => setGalleryType(candidate)}><span className={`home-gallery-thumb thumb-${candidate}`} aria-hidden="true"><Icon size={19}/></span><strong>{homeWidgetNames[candidate]}</strong>{count > 0 && <small aria-label={`${count} on your board`}>{count}</small>}</button>;
            })}</div>
          </aside>
          {selectedType ? <section className={`home-gallery-detail gallery-${selectedType}`} aria-label={`${homeWidgetNames[selectedType]} preview`}>
            <div className="home-gallery-detail-heading"><h3>{homeWidgetNames[selectedType]}</h3></div>
            <div className={`home-gallery-stage gallery-stage-${selectedSize}`}><WidgetPreview widget={{ ...(draft.forms[selectedType] ?? { id: selectedType, type: selectedType, hidden: false }), size: selectedSize }} sample/></div>
            <p className="home-gallery-example">Example Preview</p>
            <div className="home-gallery-size-picker" role="group" aria-label="Preview Size">{sizeOptions.map(size => <button type="button" key={size.value} aria-pressed={selectedSize === size.value} onClick={() => setGallerySize(size.value)}><span className={`home-size-diagram diagram-${size.value}`} aria-hidden="true"/><span>{size.name}</span></button>)}</div>
            <div className="home-gallery-add"><span>{selectedCount ? `${selectedCount} on your board · add another` : 'Make it yours with a name and settings'}</span><button type="button" className="primary" disabled={atLimit} onClick={() => choose(selectedType, selectedSize)}>Customize &amp; Add</button></div>
          </section> : <div className="home-gallery-no-results"><h3>No Widgets Found</h3><p>Try another name or choose All.</p></div>}
        </div>
        {hidden.length > 0 && <details className="home-hidden-widgets"><summary>Hidden Widgets ({hidden.length})</summary><p>Your content and settings are kept. Restore a widget to use it again.</p>{hidden.map(item => <div className="home-hidden-widget" key={item.id}><span><strong>{widgetTitle(item)}</strong><small>{homeWidgetNames[resolveWidgetType(item)]}</small></span><button type="button" onClick={() => restore(item.id)}>Restore<span className="sr-only"> {widgetTitle(item)}</span></button></div>)}</details>}
      </> : <form className="home-widget-config" noValidate onSubmit={event => { event.preventDefault(); apply(); }}><div className="home-widget-config-layout"><div className="home-widget-config-fields">
        {!widget && <button type="button" className="home-library-back" onClick={() => { if (persist(draft)) { setGallerySize(current.size); setGalleryType(type!); keep({ ...draft, selected: undefined }); } }}>Back To Widget Library</button>}
        <div className="home-widget-config-heading"><h3 ref={configHeading} tabIndex={-1}>{homeWidgetNames[type!]}</h3></div>
        {changedElsewhere && <div className="home-widget-message"><strong>This widget has changed since you started editing.</strong><p>Review your draft before applying it. Your changes will replace its current settings.</p><details><summary>Current widget on your board</summary><WidgetPreview widget={currentSaved!}/></details></div>}
        <label>Widget Name<input value={current.title ?? ''} maxLength={80} placeholder={homeWidgetNames[type!]} onChange={event => patch({ title: event.target.value })}/><small>Leave blank to use the default name.</small></label>
        <fieldset className="home-widget-colors"><legend>Color</legend><div>{homeWidgetColors.map(color => <button type="button" key={color} aria-pressed={(current.color ?? 'default') === color} onClick={() => patch({ color })}><span className={`home-color-swatch swatch-${color}`} data-widget-color={color} aria-hidden="true"/><span>{colorNames[color]}</span></button>)}</div><p className="metadata">Default keeps this widget’s original color.</p></fieldset>
        <fieldset className="home-widget-sizes"><legend>Size</legend><div>{sizeOptions.map(size => <button type="button" key={size.value} aria-pressed={current.size === size.value} onClick={() => patch({ size: size.value })}><span className={`home-size-diagram diagram-${size.value}`} aria-hidden="true"/><strong>{size.name}</strong><small>{size.description}</small></button>)}</div><p className="metadata">Widgets with the same size use the same space. On small screens, widgets fit one column.</p></fieldset>
        {(type === 'welcome' || type === 'clock') && <label>Timezone<select value={current.settings?.timezone ?? ''} onChange={event => settings({ timezone: event.target.value || undefined })}><option value="">Follow Workspace</option>{[...new Set([current.settings?.timezone, 'UTC', ...Intl.supportedValuesOf('timeZone')].filter((zone): zone is string => !!zone))].map(zone => <option key={zone} value={zone}>{zone.replaceAll('_', ' ').replaceAll('/', ' / ')}</option>)}</select></label>}
        {type === 'weather' && <fieldset className="home-weather-settings"><legend>Weather Location</legend>
          {current.settings?.location && <p className="home-widget-message"><strong>{current.settings.location.name}</strong><br/><span>Selected City</span></p>}
          <div className="home-weather-city-search"><label>Find A City<input type="search" value={cityQuery} maxLength={100} placeholder="City Or Postal Code" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void findCities(); } }} onChange={event => { locationSequence.current++; locationRequest.current?.abort(); setSearchingCities(false); setCityQuery(event.target.value); setLocations([]); setCitySearchDone(false); setCityError(''); }}/></label><button type="button" disabled={searchingCities} onClick={() => void findCities()}>{searchingCities ? 'Searching…' : 'Search'}</button></div>
          <p className="metadata">Search sends the city name to Open-Meteo. Your device location is not requested.</p>
          {cityError && <p className="field-error" role="alert">{cityError}</p>}
          {citySearchDone && !locations.length && <p role="status" className="metadata">No cities found. Try a nearby city or a longer name.</p>}
          {locations.length > 0 && <div className="home-weather-city-results" aria-label="Matching cities">{locations.map(location => <button type="button" key={`${location.latitude}:${location.longitude}`} aria-pressed={current.settings?.location?.latitude === location.latitude && current.settings?.location?.longitude === location.longitude} onClick={() => settings({ location })}><strong>{location.name}</strong><small>{location.timezone.replaceAll('_', ' ')}</small></button>)}</div>}
          <label>Temperature Units<select value={current.settings?.units ?? 'celsius'} onChange={event => settings({ units: event.target.value as 'celsius' | 'fahrenheit' })}><option value="celsius">Celsius (°C)</option><option value="fahrenheit">Fahrenheit (°F)</option></select></label>
          <p className="metadata">Location names by <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a>, via <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a>. Weather appears after the widget is added.</p>
        </fieldset>}
        {(type === 'next' || type === 'next-action' || type === 'attention') && <div className="home-widget-task-fields">
          {type === 'next' && <label>Show Tasks<select value={current.settings?.view ?? defaultTaskView} onChange={event => settings({ view: event.target.value as NonNullable<HomeWidget['settings']>['view'] })}><option value="ready">Ready To Work On</option><option value="all">All Tasks</option><option value="attention">Needs Attention</option><option value="upcoming">Upcoming</option></select></label>}
          <label>Project<select value={current.settings?.projectId ?? ''} onChange={event => settings({ projectId: event.target.value || null })}><option value="">All Projects</option>{current.settings?.projectId && !projects.some(project => project.id === current.settings?.projectId) && <option value={current.settings.projectId}>Unavailable Project</option>}{projects.map(project => <option value={project.id} key={project.id}>{project.value.name}</option>)}</select></label>
          {(type === 'next' || type === 'attention') && <label className="home-widget-task-limit">Maximum Tasks<input type="number" min={1} max={12} value={current.settings?.limit ?? (type === 'attention' ? 3 : 5)} onChange={event => settings({ limit: Number(event.target.value) })}/></label>}
          {type === 'next-action' && <p className="metadata">Shows the first ready task in your saved task order.</p>}
        </div>}
        {type === 'daily-routines' && <label>Maximum Routines<input type="number" min={1} max={12} value={current.settings?.limit ?? 5} onChange={event => settings({ limit: Number(event.target.value) })}/><small>Only today’s ready, unfinished daily routines appear.</small></label>}
        {type === 'note' && <label>Note<textarea rows={7} maxLength={10000} value={current.settings?.text ?? ''} placeholder="What would you like to keep close?" onChange={event => settings({ text: event.target.value })}/><small>{(current.settings?.text ?? '').length.toLocaleString()} / 10,000 characters</small></label>}
        {type === 'links' && <fieldset className="home-widget-links"><legend>Quick Links</legend><p className="metadata">Add up to 12 links. Use a complete https:// or http:// address.</p>{(current.settings?.links ?? []).map((link, index) => <div className="home-link-fields" key={link.id}>
          <label htmlFor={`${fieldId}-label-${link.id}`}>Link {index + 1} Name<input id={`${fieldId}-label-${link.id}`} value={link.label} maxLength={80} placeholder="Project resources" onChange={event => settings({ links: current.settings!.links!.map(item => item.id === link.id ? { ...item, label: event.target.value } : item) })}/></label>
          <label htmlFor={`${fieldId}-url-${link.id}`}>Web Address<input id={`${fieldId}-url-${link.id}`} type="url" value={link.url} maxLength={2000} placeholder="https://example.com" onChange={event => settings({ links: current.settings!.links!.map(item => item.id === link.id ? { ...item, url: event.target.value } : item) })}/></label>
          <button type="button" onClick={() => settings({ links: current.settings!.links!.filter(item => item.id !== link.id) })}>Remove<span className="sr-only"> link {index + 1}</span></button>
        </div>)}<button type="button" disabled={(current.settings?.links?.length ?? 0) >= 12} onClick={() => settings({ links: [...current.settings?.links ?? [], { id: crypto.randomUUID(), label: '', url: '' }] })}>Add A Link</button></fieldset>}
        </div><section className="home-widget-live-preview" aria-label="Widget content preview"><div><strong>Preview</strong><small>Sample content · actual size follows your board</small></div><WidgetPreview widget={current}/></section></div>
        {issues.length > 0 && <div className="home-widget-error" role="alert"><strong>Review these settings</strong><ul>{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
        <div className="dialog-footer"><p className="metadata">{storageError ? 'Edits are only in this window.' : 'Unfinished edits are kept in this browser.'}</p><button type="button" onClick={leave}>Keep For Later</button><button className="primary" type="submit" disabled={atLimit}>{widget ? 'Apply Changes' : 'Add Widget'}</button></div>
      </form>}
    </div>
  </Dialog>;
}
