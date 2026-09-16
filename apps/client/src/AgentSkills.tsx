import { LoadingRing } from './ModuleLoading';
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { lazy } from './preload-lazy';
import type { Snapshot } from '../../../packages/domain/contracts';
import { skillAvailability, type InstalledSkills } from '../../../packages/domain/agent-skills';
import { readLocal, request, saveLocal } from './api';
import { Empty } from './ui';
import './agent-skills.css';

const Workshop = lazy(() => import('./SkillWorkshop'));
export default function AgentSkills({ snapshot }: { snapshot: Snapshot }) {
  const key = `e3:skills-view:${snapshot.deviceId}:${snapshot.epoch}`;
  const [view, setView] = useState(() => readLocal<string>(key) === 'proposals' ? 'proposals' : 'installed');
  return <><nav className="record-tabs" aria-label="Skill views"><button aria-pressed={view === 'installed'} onClick={() => { setView('installed'); saveLocal(key, 'installed'); }}>Installed</button><button aria-pressed={view === 'proposals'} onClick={() => { setView('proposals'); saveLocal(key, 'proposals'); }}>Proposals & reviews</button></nav>{view === 'installed' ? <Installed/> : <Suspense fallback={<LoadingRing label="Opening skill proposals…"/>}><Workshop snapshot={snapshot}/></Suspense>}</>;
}
function Installed() {
  const [state, setState] = useState<InstalledSkills>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState(0);
  const results = useRef<HTMLDivElement>(null), pageChanged = useRef(false);
  const turnPage = (next: number) => { pageChanged.current = true; setPage(next); };
  useLayoutEffect(() => { if (pageChanged.current) { pageChanged.current = false; results.current?.focus(); results.current?.scrollIntoView({ block: 'start' }); } }, [page]);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [source, setSource] = useState('all');
  useEffect(() => {
    const controller = new AbortController(); setBusy(true);
    void request<InstalledSkills>('agent-skills/installed', undefined, controller.signal).then(next => { if (!controller.signal.aborted) { setState(next); setError(''); } }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Installed skills could not load.'); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [refresh]);
  const skills = state?.skills ?? [], sources = [...new Set(skills.map(s => s.source))].sort();
  const visible = skills.filter(skill => `${skill.name} ${skill.skillKey} ${skill.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (source === 'all' || skill.source === source) && (filter === 'all' || (filter === 'ready' ? ['available', 'ready'].includes(skillAvailability(skill).state) : !['available', 'ready'].includes(skillAvailability(skill).state))));
  useEffect(() => setPage(0), [query, filter, source, refresh]);
  const missingLabels = { bins: 'Required programs', anyBins: 'One of these programs', env: 'Environment settings', config: 'Host settings', os: 'Operating system' };
  return <section className="agent-skills" aria-label="Installed skills"><div className="record-toolbar"><div><h2>Assistant skills</h2><p className="metadata">Installed on this Assistant host. Saved assignments use their captured inputs; this list does not equip them with extra tools.</p></div><button disabled={busy} onClick={() => setRefresh(v => v + 1)}>{busy ? 'Reading host…' : 'Refresh skills'}</button></div>
    <div className="record-filters"><label>Find a skill<input type="search" value={query} placeholder="Name, key or description" onChange={e => setQuery(e.target.value)}/></label><label>Availability<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All skills</option><option value="ready">Ready</option><option value="attention">Needs attention</option></select></label><label>Source<select value={source} onChange={e => setSource(e.target.value)}><option value="all">All sources</option>{sources.map(s => <option key={s}>{s}</option>)}</select></label></div>
    {error && <p role="alert" className="field-error">{error}{state ? ' The list below is the last observation; current availability is unconfirmed.' : ''}</p>}
    {state && <p className="metadata">{visible.length} of {skills.length} installed skills · observed {new Date(state.observedAt).toLocaleString()}</p>}
    {!state && busy && <p role="status">Reading the host’s installed skills…</p>}
    {state && !visible.length && <div className="card"><Empty title={skills.length ? 'No skills match these filters.' : 'No installed skills reported.'}>The current host inventory will appear here when available.</Empty></div>}
    <div ref={results} className="agent-skill-list" role="group" aria-label="Skill results" tabIndex={-1}>{visible.slice(page * 40, (page + 1) * 40).map(skill => { const status = skillAvailability(skill); return <article className="card agent-skill" key={skill.skillKey}><header><h3>{skill.name}</h3><span className="skill-availability" data-ready={!error && status.state === 'available'}>{error ? 'Status unconfirmed' : status.label}</span></header><p>{skill.description || 'No description reported.'}</p><p className="metadata">{skill.source}{skill.skillKey !== skill.name && <><br/>Skill key: {skill.skillKey}</>}</p>{skill.missing && Object.values(skill.missing).some(items => items?.length) && <details><summary>Setup requirements</summary><dl>{Object.entries(skill.missing).filter(([, items]) => items.length).map(([kind, items]) => <div key={kind}><dt>{missingLabels[kind as keyof typeof missingLabels]}</dt><dd>{items.join(', ')}</dd></div>)}</dl></details>}</article>; })}</div>
    {visible.length > 40 && <nav className="button-row skill-pages" aria-label="Skill pages"><button disabled={page === 0} onClick={() => turnPage(Math.max(0, page - 1))}>Previous skills</button><span className="metadata">{page * 40 + 1}–{Math.min(visible.length, (page + 1) * 40)} of {visible.length}</span><button disabled={(page + 1) * 40 >= visible.length} onClick={() => turnPage(page + 1)}>Next skills</button></nav>}
  </section>;
}
