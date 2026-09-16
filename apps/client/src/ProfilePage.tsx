import { readPreparedView } from './prepared-views';
import { LoadingRing } from './ModuleLoading';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import type { ProfileProgress, PersonalQuestProgress, ProgressHistoryPage } from '../../../packages/domain/profile-progression';
import { ApiError, readLocal, request, saveLocal } from './api';
import { RecordEditor } from './RecordEditor';
import { Portrait } from './nova/lynx-portrait/Portrait';
import { Check, Plus, Target } from './icons';
import { Dialog, Empty } from './ui';
import { ProfileQuestEditor } from './ProfileQuestEditor';
import { retainedWindowId } from './useWorkspace';
import './profile.css';

const dateLabel = (day: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
export default function ProfilePage({ snapshot, refresh, editTask }: { snapshot: Snapshot; refresh: () => Promise<void>; editTask: (task: Entity<Task>) => void }) {
  const [progress, setProgress] = useState<ProfileProgress | undefined>(() => readPreparedView(snapshot, 'profile/progress')), [error, setError] = useState('');
  const alive = useRef(true), loading = useRef(false);
  const load = useCallback(async () => { if (loading.current) return; loading.current = true; try { const data = await request<ProfileProgress>('profile/progress'); if (alive.current && data.epoch === snapshot.epoch) { setProgress(data); setError(''); } } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Progress is unavailable.'); } finally { loading.current = false; } }, [snapshot.epoch]);
  useEffect(() => { alive.current = true; void load(); const interval = setInterval(() => { if (!document.hidden) void load(); }, 5000); return () => { alive.current = false; clearInterval(interval); }; }, [load]);
  useEffect(() => { void load(); }, [snapshot.cursor, load]);
  const previousProgress = useRef<ProfileProgress | undefined>(undefined);
  const [notice, setNotice] = useState<{ text: string; completed: boolean }>();
  useEffect(() => {
    if (!progress) return;
    const previous = previousProgress.current; previousProgress.current = progress;
    if (!previous) return;
    const delta = progress.earnedXp - previous.earnedXp;
    const finished = progress.personalQuests.filter(q => q.complete && previous.personalQuests.some(p => p.id === q.id && !p.complete));
    if (delta > 0) setNotice({ text: `${finished.length ? `${finished.map(q => q.title).join(', ')} completed. ` : 'Task completed. '}+${delta} XP${progress.level > previous.level ? ` · You reached level ${progress.level}!` : ''}`, completed: !!finished.length });
    else if (delta < 0) setNotice({ text: `Progress corrected: ${delta} XP after a Task was reopened.`, completed: false });
  }, [progress]);
  const [identity, setIdentity] = useState(false), [tab, setTab] = useState<'quests' | 'milestones' | 'history'>('quests');
  const [cadence, setCadence] = useState<'daily' | 'weekly'>('daily');
  const [questFilter, setQuestFilter] = useState<'active' | 'completed' | 'archived'>('active');
  const writerKey = `e3:profile-writer:${snapshot.deviceId}:${retainedWindowId}`;
  const [kept, setKept] = useState<string | undefined>(() => readLocal(writerKey));
  const [editing, setEditing] = useState<string>();
  const [operationError, setOperationError] = useState('');
  const [action, setAction] = useState<Record<string, unknown> | undefined>(() => readLocal(`e3:profile-action:${snapshot.deviceId}:${snapshot.epoch}:${retainedWindowId}`)), [busy, setBusy] = useState(false);
  const actionFlight = useRef(false);
  const profile = snapshot.records?.profile.find(p => p.id === 'profile:owner');
  const openWriter = (id: string) => { if (!saveLocal(writerKey, id)) { setOperationError('Free browser storage before starting a quest.'); return; } setKept(id); setEditing(id); };
  const forgetWriter = () => { if (!saveLocal(writerKey, null)) { setOperationError('Free browser storage before closing the kept draft.'); return; } setKept(undefined); setEditing(undefined); };
  const updated = async () => { await load(); try { await refresh(); } catch { setOperationError('The change was saved. Refresh the workspace to see the latest Tasks.'); } };
  const archive = async (quest?: PersonalQuestProgress) => {
    if (actionFlight.current) return;
    const command = action ?? (quest && { action: 'archive', id: quest.id, archived: !quest.archived, expectedRevision: quest.revision, epoch: snapshot.epoch, requestId: crypto.randomUUID() });
    if (!command) return;
    const key = `e3:profile-action:${snapshot.deviceId}:${snapshot.epoch}:${retainedWindowId}`;
    if (!saveLocal(key, command)) { setOperationError('Free browser storage before archiving this quest.'); return; }
    setAction(command); actionFlight.current = true; setBusy(true); setOperationError('');
    try { await request('profile/quests', command); if (!saveLocal(key, null)) throw new Error('Saved on the host. Free browser storage, then check the original action.'); setAction(undefined); await updated(); }
    catch (e) { setOperationError(e instanceof Error ? e.message : 'The action is unconfirmed.'); if (e instanceof ApiError && e.status && e.status < 500) { if (saveLocal(key, null)) setAction(undefined); await load(); } }
    finally { actionFlight.current = false; setBusy(false); }
  };
  const tasks = new Map([...snapshot.tasks, ...(snapshot.trashedTasks ?? [])].map(t => [t.id, t]));
  const openTask = (id: string) => { const task = tasks.get(id); if (task && !task.value.trashed) editTask(task); };
  const shownQuests = progress?.personalQuests.filter(q => questFilter === 'archived' ? q.archived : !q.archived && q.complete === (questFilter === 'completed')) ?? [];
  return <div className="profile-workspace">
    <section className="card profile-hero" aria-label="Your profile and experience">
      <div className="profile-portrait"><Portrait recipe={profile?.value.appearance ?? null} size="profile" accessibility={{ mode: 'informative', label: `${profile?.value.name || 'Your'} Lynx portrait` }}/></div>
      <div className="profile-identity"><span className="eyebrow">Your journey</span><h2>{profile?.value.name || 'Make it yours.'}</h2>{profile?.value.position && <p className="profile-position">{profile.value.position}</p>}{profile?.value.about && <p className="profile-about">{profile.value.about}</p>}<button onClick={() => setIdentity(true)}>Edit profile & appearance</button></div>
      <div className="profile-experience">{progress ? <><div className="profile-level"><span>Level</span><strong>{progress.level}</strong></div><p className="profile-xp"><strong>{progress.earnedXp.toLocaleString()}</strong> earned XP</p><progress aria-label={`Level ${progress.level} experience`} max={progress.nextLevelXp - progress.currentLevelXp} value={Math.max(0, progress.earnedXp - progress.currentLevelXp)}/><p className="metadata">{progress.nextLevelXp - progress.earnedXp} XP to level {progress.level + 1}</p>{progress.imported && <details><summary>{progress.imported.xp.toLocaleString()} XP carried from {progress.imported.source}</summary><p>Verified for {progress.imported.name} through {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: progress.timezone }).format(new Date(progress.imported.asOf))}. The {progress.imported.eventCount} original entries remain in the preserved import. Earlier completions do not earn XP again or count toward today’s quests.</p></details>}<details><summary>How experience works</summary><p>Completing a Task earns 10 XP. Reopening it reverses that award; completing it again restores the same credit. Quest steps share this ledger. Quest completion adds no extra XP.</p><p>Daily and weekly progress uses each Task’s first completion date. New routine occurrences count separately. Trash preserves earned history. Level 2 starts at 140 XP; later levels follow the original progression curve. Rest days never remove XP.</p></details></> : <LoadingRing label="Loading earned progress…"/>}</div>
    </section>
    {error && <div className="notice warning" role="alert"><p>{error}{progress && ' · Showing the last confirmed progress.'}</p><button onClick={() => void load()}>Retry progress</button></div>}
    {operationError && <div className="notice warning" role="alert"><p>{operationError}</p><button onClick={() => setOperationError('')}>Dismiss</button></div>}
    {progress && <>
      <div className="profile-stats"><div><strong>{progress.completedTasks}</strong><span>{progress.imported ? 'New Tasks completed' : 'Tasks completed'}</span></div><div><strong>{progress.activeDays}</strong><span>{progress.imported ? 'New days with a finish' : 'Days with a finish'}</span></div><div><strong>{progress.personalQuests.filter(q => q.complete).length}</strong><span>Personal quests finished</span></div><div className="profile-week" aria-label="Task completions in the last seven days">{progress.days.map(d => <span key={d.day} className={d.count ? 'is-active' : ''} title={`${dateLabel(d.day)}: ${d.count} Tasks completed`} aria-label={`${dateLabel(d.day)}: ${d.count} Tasks completed`}><i aria-hidden="true">{d.count ? <Check size={13}/> : '·'}</i><small>{new Date(`${d.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' })}</small></span>)}</div></div>
      <nav className="record-tabs" aria-label="Profile views">{(['quests', 'milestones', 'history'] as const).map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t === 'quests' ? 'Quests' : t === 'milestones' ? 'Milestones' : 'Earned history'}</button>)}</nav>
      {notice && <div className="notice profile-progress-note"><p role="status">{notice.text}</p><div className="button-row">{notice.completed && <button onClick={() => { setTab('quests'); setQuestFilter('completed'); }}>View completed quests</button>}<button aria-label="Dismiss progress update" onClick={() => setNotice(undefined)}>Dismiss</button></div></div>}
      {tab === 'quests' && <>
        <section className="profile-periodic"><div className="section-heading"><div><h2>Small steps. Real progress.</h2><p className="metadata">{cadence === 'daily' ? dateLabel(progress.today) : `Week of ${dateLabel(progress.quests.find(q => q.cadence === 'weekly')!.start)}`} · {progress.timezone}</p></div><div className="button-row"><button aria-pressed={cadence === 'daily'} onClick={() => setCadence('daily')}>Daily</button><button aria-pressed={cadence === 'weekly'} onClick={() => setCadence('weekly')}>Weekly</button></div></div>
          <div className="profile-quest-grid">{progress.quests.filter(q => q.cadence === cadence).map(q => <article className={`card period-quest${q.complete ? ' is-complete' : ''}`} key={q.id}><span className="quest-emblem" aria-hidden="true">{q.complete ? <Check size={20}/> : <Target size={20}/>}</span><div><h3>{q.title}</h3><p>{q.description}</p><progress max={q.target} value={Math.min(q.target, q.progress)} aria-label={`${q.title} progress`}/><p className="metadata">{q.complete ? 'Complete' : 'In progress'} · {Math.min(q.target, q.progress)} / {q.target} {q.unit}</p>{q.taskIds.length > 0 && <details><summary>Contributing Tasks</summary><ul>{q.taskIds.map(id => <li key={id}><button className="text-button" disabled={!tasks.has(id) || tasks.get(id)?.value.trashed} onClick={() => openTask(id)}>{tasks.get(id)?.value.title ?? 'Task unavailable'}{tasks.get(id)?.value.trashed ? ' · In Trash' : ''}</button></li>)}</ul></details>}</div></article>)}</div>
          <p className="metadata">Quests update automatically from completed work. A fresh period starts at midnight; unfinished quests have no penalty.</p>
        </section>
        <section className="profile-personal"><div className="section-heading"><div><h2>Your personal quests</h2><p>Turn an ambition into a few clear next steps.</p></div><button className="primary" onClick={() => openWriter(kept ?? crypto.randomUUID())}><Plus size={17}/>{kept ? 'Resume quest draft' : 'New quest'}</button></div><div className="button-row profile-filter" aria-label="Personal quest filter">{(['active', 'completed', 'archived'] as const).map(f => <button key={f} aria-pressed={questFilter === f} onClick={() => setQuestFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>)}</div>
          {action && <div className="notice"><p>A quest action is awaiting confirmation.</p><button disabled={busy} onClick={() => void archive()}>Check quest action</button></div>}
          {shownQuests.length ? <div className="profile-personal-grid">{shownQuests.map(q => <article key={q.id} className="card personal-quest"><div className="section-heading"><div><span className="eyebrow">{q.archived ? 'Archived' : q.complete ? 'Completed' : 'Personal quest'}</span><h3>{q.title}</h3></div><span className="quest-count">{q.progress}/{q.steps.length}</span></div>{q.description && <p className="quest-description">{q.description}</p>}{(q.due || q.projectId) && <p className="metadata">{q.projectId ? snapshot.projects.find(p => p.id === q.projectId)?.value.name ?? 'Project unavailable' : ''}{q.due ? `${q.projectId ? ' · ' : ''}${q.due < progress.today && !q.complete ? 'Target passed · ' : 'Target · '}${dateLabel(q.due)}` : ''}</p>}<progress value={q.progress} max={q.steps.length} aria-label={`${q.title} progress`}/><ol className="quest-step-list">{q.stepProgress.map((s, i) => <li key={s.id}><span aria-hidden="true" className={`quest-step-number${s.done ? ' is-complete' : ''}`}>{s.done ? <Check size={15}/> : i + 1}</span><button className="quest-step-link" disabled={s.trashed || s.status === 'missing'} onClick={() => openTask(s.taskId)}><strong>{s.title}</strong><span>{s.status === 'missing' ? 'Unavailable' : s.done ? 'Completed' : s.status === 'open' ? 'Ready to begin' : s.status}{s.trashed ? ' · In Trash' : ''}</span></button></li>)}</ol><div className="button-row">{!q.archived && <button disabled={!!kept && kept !== q.id} title={kept && kept !== q.id ? 'Resume or discard the kept quest draft first.' : undefined} onClick={() => openWriter(q.id)}>Edit quest</button>}<button disabled={busy || !!action || kept === q.id} onClick={() => void archive(q)}>{q.archived ? 'Restore quest' : 'Archive quest'}</button></div></article>)}</div> : <Empty title={questFilter === 'active' ? 'Give your next goal a home.' : questFilter === 'completed' ? 'Every finish will be kept here.' : 'No archived quests.'}>{questFilter === 'active' ? 'Create a quest with new steps or link work you already have in Tasks.' : questFilter === 'completed' ? 'Finish every linked step to complete a personal quest.' : 'Archived quests keep their steps and earned work.'}</Empty>}
        </section>
      </>}
      {tab === 'milestones' && <section><h2>Milestones along the way</h2><p>Recognition for work you have completed. Corrections stay connected to their original Tasks.</p><div className="profile-milestones">{progress.milestones.map(m => <article key={m.id} className={`card profile-milestone${m.earned ? ' is-complete' : ''}`}><span className="quest-emblem" aria-hidden="true">{m.earned ? <Check size={22}/> : <Target size={22}/>}</span><h3>{m.title}</h3><p>{m.description}</p><progress max={m.target} value={Math.min(m.target, m.progress)} aria-label={`${m.title} progress`}/><span className="metadata">{m.earned ? 'Earned' : `${Math.min(m.target, m.progress)} / ${m.target}`}</span></article>)}</div></section>}
      {tab === 'history' && <ProfileHistory key={`${snapshot.epoch}:${progress.history.entries[0]?.id ?? 'empty'}`} initial={progress.history} openTask={openTask} timezone={progress.timezone}/>}
    </>}
    {identity && <Dialog title="Your profile & appearance" close={() => setIdentity(false)}><RecordEditor kind="profile" id="profile:owner" compact snapshot={snapshot} refresh={refresh} editTask={editTask} entity={profile} onSaved={() => setIdentity(false)}/></Dialog>}
    {editing && <Dialog title={progress?.personalQuests.some(q => q.id === editing) ? 'Edit personal quest' : 'Create a personal quest'} close={() => setEditing(undefined)}><ProfileQuestEditor key={`${snapshot.deviceId}:${editing}`} id={editing} quest={progress?.personalQuests.find(q => q.id === editing)} snapshot={snapshot} saved={async () => { forgetWriter(); await updated(); }} discard={forgetWriter}/></Dialog>}
  </div>;
}
function ProfileHistory({ initial, openTask, timezone }: { initial: ProgressHistoryPage; openTask: (id: string) => void; timezone: string }) {
  const [page, setPage] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const more = async () => { if (!page.next || busy) return; setBusy(true); try { const next = await request<ProgressHistoryPage>(`profile/history?before=${encodeURIComponent(page.next)}`); setPage({ ...next, entries: [...page.entries, ...next.entries] }); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'History is unavailable.'); } finally { setBusy(false); } };
  return <section className="card profile-history"><div className="section-heading"><div><h2>Earned history</h2><p>Completed Tasks and their corrections, kept together.</p></div><span className="metadata">{page.entries.length} of {page.total}</span></div>{page.entries.length ? <ul>{page.entries.map(e => <li key={e.id}><div><button className="text-button" disabled={e.trashed} onClick={() => openTask(e.taskId)}>{e.title}{e.trashed ? ' · In Trash' : ''}</button><p className="metadata">{e.xpDelta > 0 ? 'Task completed' : 'Task reopened'} · {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(e.at))}</p></div><strong className={e.xpDelta > 0 ? 'xp-positive' : ''}>{e.xpDelta > 0 ? '+' : ''}{e.xpDelta} XP</strong></li>)}</ul> : <Empty title="Your next step counts.">Complete a Task to begin your earned history.</Empty>}{error && <p className="field-error" role="alert">{error}</p>}{page.next && <button disabled={busy} onClick={() => void more()}>{busy ? 'Loading…' : 'Load earlier history'}</button>}</section>;
}
