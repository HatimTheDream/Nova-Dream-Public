import { readPreparedView } from './prepared-views';
import { LoadingRing } from './ModuleLoading';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { questCommandSchema, type QuestCommand, type ProfileProgress, type PersonalQuestProgress } from '../../../packages/domain/profile-progression';
import { ApiError, request } from './api';
import { ProfileIdentityEditor, type ProfileIdentitySection } from './ProfileIdentityEditor';
import { SquareLynx } from './nova/square-lynx/SquareLynx';
import { Check, Plus, Target } from './icons';
import { Dialog, Empty } from './ui';
import { ProfileQuestEditor } from './ProfileQuestEditor';
import { retainedWindowId } from './useWorkspace';
import { ProfileStudio } from './ProfileStudio';
import { readProfileViewSlot, type ProfileView } from './profile-view';
import { ProfileWeek, currentProfileWeek } from './ProfileWeek';
import { readProfileSlot, writeProfileSlot } from './profile-kept-state';
import { mayLeaveRecordDrafts, registerRecordDraftNavigation } from './record-draft-navigation';
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
  const [identity, setIdentity] = useState<{ section: ProfileIdentitySection; token: number }>();
  const identityOwner = useRef(identity); identityOwner.current = identity;
  const identitySequence = useRef(0), profileTrigger = useRef<HTMLButtonElement>(null), lookTrigger = useRef<HTMLButtonElement>(null);
  const identityScope = `${snapshot.epoch}:${snapshot.deviceId}`, currentIdentityScope = useRef(identityScope); currentIdentityScope.current = identityScope;
  const openIdentity = (section: ProfileIdentitySection) => { if (mayLeaveRecordDrafts()) { const next = { section, token: ++identitySequence.current }; identityOwner.current = next; setIdentity(next); } };
  const closeIdentity = (token: number) => {
    if (identityOwner.current?.token !== token || currentIdentityScope.current !== identityScope || !mayLeaveRecordDrafts()) return;
    const trigger = identityOwner.current.section === 'identity' ? profileTrigger : lookTrigger;
    identityOwner.current = undefined; setIdentity(undefined);
    requestAnimationFrame(() => { if (!identityOwner.current && currentIdentityScope.current === identityScope) trigger.current?.focus(); });
  };
  const [viewSlot, setViewSlot] = useState(() => readProfileViewSlot(localStorage, `e3:profile-view:${snapshot.epoch}:${snapshot.deviceId}:${retainedWindowId}`));
  const viewOwner = useRef(viewSlot); viewOwner.current = viewSlot;
  const { tab, cadence, questFilter } = viewSlot.value;
  const retainView = () => { if (viewOwner.current.invalid) return true; try { const kept = writeProfileSlot(localStorage, viewOwner.current, viewOwner.current.value); viewOwner.current = kept; setViewSlot(kept); return true; } catch (problem) { setOperationError(problem instanceof Error ? problem.message : 'Keep this Profile view open.'); return false; } };
  useEffect(() => {
    const unregister = registerRecordDraftNavigation(retainView);
    const leave = (event: BeforeUnloadEvent) => { if (!retainView()) { event.preventDefault(); event.returnValue = ''; } };
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', leave);
    return () => { unregister(); if (typeof window !== 'undefined') window.removeEventListener('beforeunload', leave); };
  }, []);
  const changeView = (patch: Partial<ProfileView>) => {
    if (!mayLeaveRecordDrafts()) return false;
    try { const kept = writeProfileSlot(localStorage, viewOwner.current, { ...viewOwner.current.value, ...patch }); viewOwner.current = kept; setViewSlot(kept); return true; }
    catch (problem) { setOperationError(problem instanceof Error ? problem.message : 'The Profile view could not be kept.'); return false; }
  };
  const setTab = (tab: ProfileView['tab']) => changeView({ tab, ...(tab === 'week' && progress && !viewOwner.current.value.week ? { week: currentProfileWeek(progress) } : {}) });
  const setCadence = (cadence: ProfileView['cadence']) => changeView({ cadence });
  const setQuestFilter = (questFilter: ProfileView['questFilter']) => changeView({ questFilter, reviewId: null });
  const writerKey = `e3:profile-writer:${snapshot.deviceId}:${retainedWindowId}`;
  const [writerSlot, setWriterSlot] = useState(() => readProfileSlot(localStorage, writerKey, null as string | null, (value): value is string | null => value === null || typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)));
  const writerOwner = useRef(writerSlot); writerOwner.current = writerSlot;
  const kept = writerSlot.value ?? undefined;
  const [editing, setEditing] = useState<string>();
  const [operationError, setOperationError] = useState('');
  type ArchiveAction = Extract<QuestCommand, { action: 'archive' }>;
  const actionKey = `e3:profile-action:${snapshot.deviceId}:${snapshot.epoch}:${retainedWindowId}`;
  const [actionSlot, setActionSlot] = useState(() => readProfileSlot(localStorage, actionKey, null as ArchiveAction | null, (value): value is ArchiveAction | null => {
    if (value === null) return true; const parsed = questCommandSchema.safeParse(value); return parsed.success && parsed.data.action === 'archive' && parsed.data.epoch === snapshot.epoch;
  }));
  const actionOwner = useRef(actionSlot); actionOwner.current = actionSlot;
  const action = actionSlot.value ?? undefined, [busy, setBusy] = useState(false);
  const actionFlight = useRef(false), confirmedArchive = useRef<ArchiveAction | undefined>(undefined);
  const keepAction = (next: ArchiveAction | null) => { try { const saved = writeProfileSlot(localStorage, actionOwner.current, next); actionOwner.current = saved; setActionSlot(saved); return true; } catch (problem) { setOperationError(problem instanceof Error ? problem.message : 'Keep this original quest action open.'); return false; } };
  const profile = snapshot.records?.profile.find(p => p.id === 'profile:owner');
  const keepWriter = (id: string | null) => { try { const saved = writeProfileSlot(localStorage, writerOwner.current, id); writerOwner.current = saved; setWriterSlot(saved); return true; } catch (problem) { setOperationError(problem instanceof Error ? problem.message : 'Keep this quest draft open.'); return false; } };
  const openWriter = (id: string) => {
    if (!mayLeaveRecordDrafts()) return;
    if (kept && kept !== id) { setOperationError('Resume or explicitly discard the original kept quest before opening another draft.'); return; }
    if (keepWriter(id)) setEditing(id);
  };
  const forgetWriter = () => { if (!keepWriter(null)) return false; setEditing(undefined); return true; };
  const updated = async () => { await load(); try { await refresh(); } catch { setOperationError('The change was saved. Refresh the workspace to see the latest Tasks.'); } };
  const archive = async (quest?: PersonalQuestProgress) => {
    if (actionFlight.current || !alive.current || actionOwner.current.invalid) return;
    const command = actionOwner.current.value ?? (quest && { action: 'archive' as const, id: quest.id, archived: !quest.archived, expectedRevision: quest.revision, epoch: snapshot.epoch, requestId: crypto.randomUUID() });
    if (!command || !keepAction(command)) return;
    actionFlight.current = true; setBusy(true); setOperationError('');
    try {
      if (!confirmedArchive.current) {
        const result = await request<PersonalQuestProgress>('profile/quests', command);
        if (!alive.current) return;
        if (result.id !== command.id || result.revision !== command.expectedRevision + 1 || result.archived !== command.archived) throw Error('This response does not confirm the original quest action. Check the same request.');
        confirmedArchive.current = command;
      }
      if (!keepAction(null)) return;
      confirmedArchive.current = undefined; await updated();
    } catch (problem) {
      if (!alive.current) return;
      const text = problem instanceof Error ? problem.message : 'The action is unconfirmed.';
      setOperationError(text);
      if (!confirmedArchive.current && problem instanceof ApiError && problem.status && problem.status < 500) { if (keepAction(null)) { setOperationError(text); await load(); } }
    } finally { actionFlight.current = false; if (alive.current) setBusy(false); }
  };
  const tasks = new Map([...snapshot.tasks, ...(snapshot.trashedTasks ?? [])].map(t => [t.id, t]));
  const openTask = (id: string) => { const task = tasks.get(id); if (task && !task.value.trashed && mayLeaveRecordDrafts()) editTask(task); };
  const shownQuests = progress?.personalQuests.filter(q => viewSlot.value.reviewId ? q.id === viewSlot.value.reviewId : questFilter === 'archived' ? q.archived : !q.archived && q.complete === (questFilter === 'completed')) ?? [];
  return <div className="profile-workspace">
    <section className={`card profile-hero${tab === 'studio' ? ' studio-hero' : ''}`} aria-label="Your profile and experience">
      <div className="profile-portrait"><SquareLynx appearance={profile?.value.appearance ?? null} size="profile" accessibility={{ mode: 'informative', label: `${profile?.value.name || 'Your'} avatar` }}/></div>
      <div className="profile-identity"><span className="eyebrow">My Studio</span><h2>{profile?.value.name || 'Make it yours.'}</h2>{profile?.value.position && <p className="profile-position">{profile.value.position}</p>}{profile?.value.about && profile.value.about !== 'Isolated pixel navigation preview.' && <p className="profile-about">{profile.value.about}</p>}<div className="profile-identity-entry"><button ref={profileTrigger} onClick={() => openIdentity('identity')}>Edit Profile</button><button ref={lookTrigger} onClick={() => openIdentity('look')}>Edit Look</button></div></div>
      {tab !== 'studio' && <div className="profile-experience">{progress ? <><div className="profile-level"><span>Level</span><strong>{progress.level}</strong></div><p className="profile-xp"><strong>{progress.earnedXp.toLocaleString()}</strong> earned XP</p><progress aria-label={`Level ${progress.level} experience`} max={progress.nextLevelXp - progress.currentLevelXp} value={Math.max(0, progress.earnedXp - progress.currentLevelXp)}/><p className="metadata">{progress.nextLevelXp - progress.earnedXp} XP to level {progress.level + 1}</p>{progress.imported && <details><summary>{progress.imported.xp.toLocaleString()} XP carried from {progress.imported.source}</summary><p>Verified for {progress.imported.name} through {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: progress.timezone }).format(new Date(progress.imported.asOf))}. The {progress.imported.eventCount} original entries remain in the preserved import. Earlier completions do not earn XP again or count toward today’s quests.</p></details>}<details><summary>How Experience Works</summary><p>Completing a Task earns 10 XP. Reopening it reverses that award; completing it again restores the same credit. Quest steps share this ledger. Quest completion adds no extra XP.</p><p>Daily and weekly progress uses each Task’s first completion date. New routine occurrences count separately. Trash preserves earned history. Level 2 starts at 140 XP; later levels follow the original progression curve. Rest days never remove XP.</p></details></> : <LoadingRing label="Loading earned progress…"/>}</div>}
    </section>
    {viewSlot.invalid && <div className="notice warning" role="alert"><p>Your saved Profile view could not be verified. Its original record is preserved.</p><details><summary>Original view record</summary><pre>{viewSlot.original ?? 'Browser storage could not be read.'}</pre></details></div>}
    {error && <div className="notice warning" role="alert"><p>{error}{progress && ' · Showing the last confirmed progress.'}</p><button onClick={() => void load()}>Retry Progress</button></div>}
    {(writerSlot.invalid || actionSlot.invalid) && <div className="notice warning" role="alert"><p>A kept quest draft or action could not be verified. The original browser records are preserved.</p><details><summary>Original kept records</summary><pre>{[writerSlot.invalid ? writerSlot.original ?? 'Draft index could not be read.' : '', actionSlot.invalid ? actionSlot.original ?? 'Action could not be read.' : ''].filter(Boolean).join('\n')}</pre></details></div>}
    {operationError && <div className="notice warning" role="alert"><p>{operationError}</p><button onClick={() => setOperationError('')}>Dismiss</button></div>}
    {progress && <>
      {tab !== 'studio' && <div className="profile-stats"><div><strong>{progress.completedTasks}</strong><span>{progress.imported ? 'New Tasks completed' : 'Tasks completed'}</span></div><div><strong>{progress.activeDays}</strong><span>{progress.imported ? 'New days with a finish' : 'Days with a finish'}</span></div><div><strong>{progress.personalQuests.filter(q => q.complete).length}</strong><span>Personal quests finished</span></div></div>}
      <nav className="record-tabs" aria-label="Profile views">{(['studio', 'quests', 'week', 'milestones'] as const).map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t === 'studio' ? 'My Studio' : t === 'quests' ? 'Quests' : t === 'week' ? 'Your Week' : 'Milestones'}</button>)}</nav>
      {notice && <div className="notice profile-progress-note"><p role="status">{notice.text}</p><div className="button-row">{notice.completed && <button onClick={() => changeView({ tab: 'quests', questFilter: 'completed', reviewId: null })}>View Completed Quests</button>}<button aria-label="Dismiss progress update" onClick={() => setNotice(undefined)}>Dismiss</button></div></div>}
      {tab === 'studio' && <><ProfileStudio snapshot={snapshot} progress={progress} focusedId={viewSlot.value.focusedId} focus={focusedId => changeView({ focusedId })} openTask={task => openTask(task.id)} newQuest={() => openWriter(kept ?? crypto.randomUUID())} reviewQuest={reviewId => changeView({ tab: 'quests', reviewId })}/><div className="studio-earned"><strong>Level {progress.level}</strong><span>{progress.earnedXp.toLocaleString()} earned XP</span><span>{progress.completedTasks} Tasks completed</span><button className="text-button" onClick={() => changeView({ tab: 'week', week: viewOwner.current.value.week ?? currentProfileWeek(progress), weekSection: 'history' })}>See Earned History</button></div><button className="card profile-week-entry" onClick={() => { const start = progress.quests.find(quest => quest.cadence === 'weekly')?.start; if (start) changeView({ tab: 'week', week: { start, timezone: progress.timezone }, day: null, weekSection: 'week', weekScroll: 0 }); }}><strong>Your Week</strong><span>Review credited work and actual activity</span><span className="metadata">By first completion date · still credited · {progress.timezone}</span></button></>}
      {tab === 'quests' && <div className="profile-quests-layout">
        <section className="profile-periodic"><div className="section-heading"><div><h2>Small steps. Real progress.</h2><p className="metadata">{cadence === 'daily' ? dateLabel(progress.today) : `Week of ${dateLabel(progress.quests.find(q => q.cadence === 'weekly')!.start)}`} · {progress.timezone}</p></div><div className="button-row"><button aria-pressed={cadence === 'daily'} onClick={() => setCadence('daily')}>Daily</button><button aria-pressed={cadence === 'weekly'} onClick={() => setCadence('weekly')}>Weekly</button></div></div>
          <div className="profile-quest-list">{progress.quests.filter(q => q.cadence === cadence).map(q => <article className={`period-quest${q.complete ? ' is-complete' : ''}`} key={q.id}>
            <span className="quest-emblem" aria-hidden="true">{q.complete ? <Check size={20}/> : <Target size={20}/>}</span>
            <div className="period-quest-copy"><h3>{q.title}</h3><p>{q.description}</p></div>
            <div className="period-quest-progress"><progress max={q.target} value={Math.min(q.target, q.progress)} aria-label={`${q.title} progress`}/><p className="metadata">{q.complete ? 'Complete' : 'In progress'} · {Math.min(q.target, q.progress)} / {q.target} {q.unit}</p></div>
            {q.taskIds.length > 0 && <details><summary>Contributing Tasks</summary><ul>{q.taskIds.map(id => <li key={id}><button className="text-button" disabled={!tasks.has(id) || tasks.get(id)?.value.trashed} onClick={() => openTask(id)}>{tasks.get(id)?.value.title ?? 'Task unavailable'}{tasks.get(id)?.value.trashed ? ' · In Trash' : ''}</button></li>)}</ul></details>}
          </article>)}</div>
          <p className="metadata">Quests update automatically from completed work. A fresh period starts at midnight; unfinished quests have no penalty.</p>
        </section>
        <section className="profile-personal"><div className="section-heading"><div><h2>Personal Quests</h2><p>Turn an ambition into a few clear next steps.</p></div><button className="primary" onClick={() => openWriter(kept ?? crypto.randomUUID())}><Plus size={17}/>{kept ? 'Resume Quest Draft' : 'New Quest'}</button></div><div className="button-row profile-filter" aria-label="Personal quest filter">{(['active', 'completed', 'archived'] as const).map(f => <button key={f} aria-pressed={questFilter === f} onClick={() => setQuestFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>)}</div>
          {viewSlot.value.reviewId && <p className="metadata">Showing the original quest from Studio. <button className="text-button" onClick={() => changeView({ tab: 'studio', reviewId: null })}>Back to My Studio</button> <button className="text-button" onClick={() => changeView({ reviewId: null })}>Show All Quests</button></p>}{action && <div className="notice"><p>A quest action is awaiting confirmation.</p><button disabled={busy} onClick={() => void archive()}>Check Quest Action</button></div>}
          {shownQuests.length ? <div className="profile-personal-grid">{shownQuests.map(q => <article key={q.id} className="card personal-quest"><div className="section-heading"><div><span className="eyebrow">{q.archived ? 'Archived' : q.complete ? 'Completed' : 'Personal quest'}</span><h3>{q.title}</h3></div><span className="quest-count">{q.progress}/{q.steps.length}</span></div>{q.description && <p className="quest-description">{q.description}</p>}{(q.due || q.projectId) && <p className="metadata">{q.projectId ? snapshot.projects.find(p => p.id === q.projectId)?.value.name ?? 'Project unavailable' : ''}{q.due ? `${q.projectId ? ' · ' : ''}${q.due < progress.today && !q.complete ? 'Target passed · ' : 'Target · '}${dateLabel(q.due)}` : ''}</p>}<progress value={q.progress} max={q.steps.length} aria-label={`${q.title} progress`}/><ol className="quest-step-list">{q.stepProgress.map((s, i) => <li key={s.id}><span aria-hidden="true" className={`quest-step-number${s.done ? ' is-complete' : ''}`}>{s.done ? <Check size={15}/> : i + 1}</span><button className="quest-step-link" disabled={s.trashed || s.status === 'missing'} onClick={() => openTask(s.taskId)}><strong>{s.title}</strong><span>{s.status === 'missing' ? 'Unavailable' : s.done ? 'Completed' : s.status === 'open' ? 'Ready to begin' : s.status}{s.trashed ? ' · In Trash' : ''}</span></button></li>)}</ol><div className="button-row">{!q.archived && <button disabled={!!kept && kept !== q.id} title={kept && kept !== q.id ? 'Resume or discard the kept quest draft first.' : undefined} onClick={() => openWriter(q.id)}>Edit Quest</button>}<button disabled={busy || !!action || actionSlot.invalid || kept === q.id} onClick={() => void archive(q)}>{q.archived ? 'Restore Quest' : 'Archive Quest'}</button></div></article>)}</div> : <Empty title={questFilter === 'active' ? 'Give your next goal a home.' : questFilter === 'completed' ? 'Every finish will be kept here.' : 'No archived quests.'}>{questFilter === 'active' ? 'Create a quest with new steps or link work you already have in Tasks.' : questFilter === 'completed' ? 'Finish every linked step to complete a personal quest.' : 'Archived quests keep their steps and earned work.'}</Empty>}
        </section>
      </div>}
      {tab === 'milestones' && <section><h2>Milestones along the way</h2><p>Recognition for work you have completed. Corrections stay connected to their original Tasks.</p><div className="profile-milestones">{progress.milestones.map(m => <article key={m.id} className={`card profile-milestone${m.earned ? ' is-complete' : ''}`}><span className="quest-emblem" aria-hidden="true">{m.earned ? <Check size={22}/> : <Target size={22}/>}</span><h3>{m.title}</h3><p>{m.description}</p><progress max={m.target} value={Math.min(m.target, m.progress)} aria-label={`${m.title} progress`}/><span className="metadata">{m.earned ? 'Earned' : `${Math.min(m.target, m.progress)} / ${m.target}`}</span></article>)}</div></section>}
      <ProfileWeek epoch={snapshot.epoch} progress={progress} view={viewSlot.value} changeView={changeView} captureView={patch => { if (viewOwner.current.invalid) return; const next = { ...viewOwner.current, value: { ...viewOwner.current.value, ...patch } }; viewOwner.current = next; setViewSlot(next); }} openTask={openTask} canOpenTask={id => !!tasks.get(id) && !tasks.get(id)!.value.trashed} revision={snapshot.cursor} active={tab === 'week'}/>
    </>}
    {identity && <ProfileIdentityEditor key={`${identityScope}:${identity.token}`} initialSection={identity.section} snapshot={snapshot} entity={profile} refresh={refresh} owns={() => identityOwner.current?.token === identity.token && currentIdentityScope.current === identityScope} close={() => closeIdentity(identity.token)}/>}
    {editing && <Dialog title={progress?.personalQuests.some(q => q.id === editing) ? 'Edit personal quest' : 'Create a personal quest'} close={() => { if (mayLeaveRecordDrafts()) setEditing(undefined); }}><ProfileQuestEditor key={`${snapshot.epoch}:${snapshot.deviceId}:${editing}`} id={editing} quest={progress?.personalQuests.find(q => q.id === editing)} snapshot={snapshot} saved={async () => { forgetWriter(); await updated(); }} discard={forgetWriter}/></Dialog>}
  </div>;
}
