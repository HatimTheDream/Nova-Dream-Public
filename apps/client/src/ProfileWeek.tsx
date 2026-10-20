import { useEffect, useRef, useState } from 'react';
import type { ProfileProgress, ProgressHistoryEntry } from '../../../packages/domain/profile-progression';
import { questPeriod } from '../../../packages/domain/profile-progression';
import type { ProfileDayEntry, ProfileDayPage, ProfileHistoryState, ProfileWeekIdentity, ProfileWeekState } from '../../../packages/domain/profile-week';
import { sameProfileWeek, shiftProfileDay } from '../../../packages/domain/profile-week';
import type { ProfileView } from './profile-view';
import { ProfilePages } from './profile-week-client';
import { request } from './api';
import { Empty } from './ui';
import { ProfileWeekNotes } from './ProfileWeekNotes';

const dateLabel = (day: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
const query = (identity: ProfileWeekIdentity) => new URLSearchParams(identity).toString();
export const currentProfileWeek = (progress: ProfileProgress): ProfileWeekIdentity => ({
  start: progress.quests.find(quest => quest.cadence === 'weekly')?.start ?? questPeriod('weekly', progress.timezone, Date.parse(progress.today + 'T12:00:00Z')).start,
  timezone: progress.timezone
});
const stamp = (at: string, timezone: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(at));

export function ProfileWeek({ epoch, deviceId, progress, view, changeView, captureView, openTask, canOpenTask, revision, active }: {
  epoch: string; deviceId: string; progress: ProfileProgress; view: ProfileView; changeView(patch: Partial<ProfileView>): boolean;
  captureView(patch: Partial<ProfileView>): void;
  openTask(id: string): void; canOpenTask(id: string): boolean; revision: number; active: boolean;
}) {
  const [, render] = useState(0), [state, setState] = useState<ProfileWeekState>(), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const alive = useRef(true), readGeneration = useRef(0), weekHeading = useRef<HTMLHeadingElement>(null), historyHeading = useRef<HTMLHeadingElement>(null), historyAction = useRef<HTMLButtonElement>(null);
  const focusAfterNavigation = useRef<'week' | 'history' | undefined>(undefined);
  const content = useRef<HTMLElement>(null), currentView = useRef(view); currentView.current = view;
  const capture = useRef(captureView); capture.current = captureView;
  const taskNavigation = useRef({ canOpenTask, openTask }); taskNavigation.current = { canOpenTask, openTask };
  const progressKey = `${revision}:${progress.history.entries[0]?.id ?? ''}:${progress.history.total}:${progress.today}:${progress.timezone}`;
  const lastProgress = useRef(progressKey);
  const scrollOwner = () => content.current?.closest<HTMLElement>('.page-scroll') ?? null;
  const identity = view.week ?? currentProfileWeek(progress), identityKey = `${identity.start}:${identity.timezone}`;
  const latestIdentity = useRef(identity); latestIdentity.current = identity;
  const [history] = useState(() => new ProfilePages<ProgressHistoryEntry>(epoch, async before => {
    const result = await request<ProfileHistoryState>('profile/week/history' + (before ? `?before=${encodeURIComponent(before)}` : ''));
    return { ...result.page, epoch: result.epoch, revision: result.revision, head: result.head };
  }, () => render(value => value + 1)));
  const day = view.day && view.day >= identity.start && view.day < shiftProfileDay(identity.start, 7) ? view.day : identity.start;
  const dayKey = `${identityKey}:${day}`, dayOwner = useRef<{ key: string; pages: ProfilePages<ProfileDayEntry> } | undefined>(undefined);
  if (dayOwner.current?.key !== dayKey) {
    dayOwner.current?.pages.retire();
    const captured = { ...identity }, capturedDay = day;
    dayOwner.current = { key: dayKey, pages: new ProfilePages<ProfileDayEntry>(epoch, async before => {
      const params = new URLSearchParams({ ...captured, day: capturedDay, ...(before ? { before } : {}) });
      const result = await request<ProfileDayPage>(`profile/week/activity?${params}`);
      if (!sameProfileWeek(result.identity, captured) || result.day !== capturedDay) throw Error('This activity belongs to another day. Your original selection is kept.');
      return result;
    }, () => { if (alive.current) render(value => value + 1); }) };
  }
  const activity = dayOwner.current.pages;
  const load = async () => {
    const captured = { ...latestIdentity.current }, token = ++readGeneration.current;
    setLoading(true);
    try {
      const result = await request<ProfileWeekState>(`profile/week?${query(captured)}`);
      if (!alive.current || token !== readGeneration.current || !sameProfileWeek(latestIdentity.current, captured)) return;
      if (result.epoch !== epoch || !sameProfileWeek(result.identity, captured) || result.days.length !== 7 || result.days.some((row, i) => row.day !== shiftProfileDay(captured.start, i))) throw Error('This week could not be verified. Your confirmed view is kept.');
      setState(result); setError('');
    } catch (problem) { if (alive.current && token === readGeneration.current) setError(problem instanceof Error ? problem.message : 'Your week is unavailable.'); }
    finally { if (alive.current && token === readGeneration.current) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true; history.active = true; if (dayOwner.current) dayOwner.current.pages.active = true;
    return () => { alive.current = false; readGeneration.current++; history.retire(); dayOwner.current?.pages.retire(); };
  }, [history]);
  useEffect(() => {
    if (!active) return;
    if (view.weekSection === 'week') { void load(); if (!activity.loaded && !activity.busy) void activity.refresh(); }
    else if (!history.loaded && !history.busy) void history.refresh(Math.max(50, view.historyCount));
  }, [active, identityKey, dayKey, view.weekSection]);
  useEffect(() => {
    if (lastProgress.current === progressKey) return;
    lastProgress.current = progressKey;
    history.noteHead(progress.history.entries[0]?.id ?? null, progress.history.total);
    if (active && view.weekSection === 'week') { void load(); activity.noteHead(null, -1); }
  }, [progressKey]);
  useEffect(() => {
    if (!active) return;
    const scroll = view.weekSection === 'history' ? view.historyScroll : view.weekScroll;
    const owner = scrollOwner(); if (owner) owner.scrollTop = scroll;
    if (focusAfterNavigation.current === 'week') historyAction.current?.focus();
    else if (focusAfterNavigation.current === 'history') historyHeading.current?.focus();
    focusAfterNavigation.current = undefined;
  }, [active, view.weekSection]);
  useEffect(() => {
    if (!active) return;
    const owner = scrollOwner(), keep = () => { if (owner) capture.current(currentView.current.weekSection === 'history' ? { historyScroll: owner.scrollTop } : { weekScroll: owner.scrollTop }); };
    owner?.addEventListener('scroll', keep);
    return () => owner?.removeEventListener('scroll', keep);
  }, [active]);
  const rememberScroll = () => {
    const scroll = scrollOwner()?.scrollTop ?? 0;
    return view.weekSection === 'history' ? { historyScroll: scroll } : { weekScroll: scroll };
  };
  const select = (patch: Partial<ProfileView>) => changeView({ ...rememberScroll(), ...patch });
  const moveWeek = (delta: number) => {
    if (select({ week: { ...identity, start: shiftProfileDay(identity.start, delta) }, day: null, weekScroll: 0 })) weekHeading.current?.focus();
  };
  const showHistory = () => { focusAfterNavigation.current = 'history'; if (!select({ week: identity, day, weekSection: 'history', historyCount: Math.max(view.historyCount, history.rows.length) })) focusAfterNavigation.current = undefined; };
  const backWeek = () => { focusAfterNavigation.current = 'week'; if (!select({ weekSection: 'week', historyCount: Math.max(view.historyCount, history.rows.length) })) focusAfterNavigation.current = undefined; };
  const current = currentProfileWeek(progress), confirmed = state && sameProfileWeek(state.identity, identity) ? state : undefined;
  const currentZone = progress.timezone === identity.timezone;
  return <section ref={content} className="profile-week-workspace" hidden={!active} aria-label="Your week">
    <div className="button-row"><button onClick={() => select({ tab: 'studio' })}>Back To My Studio</button>{view.weekSection === 'history' && <button onClick={backWeek}>Back To My Week</button>}</div>
    <section hidden={view.weekSection !== 'week'}>
      <div className="section-heading"><div><h2 ref={weekHeading} tabIndex={-1}>Week Of {dateLabel(identity.start)}</h2><p className="metadata">{identity.timezone}{!currentZone && ' · Retained timezone'}</p></div><div className="button-row"><button onClick={() => moveWeek(-7)}>Previous Week</button><button onClick={() => moveWeek(7)}>Next Week</button><button disabled={sameProfileWeek(identity, current)} onClick={() => select({ week: current, day: null, weekScroll: 0 })}>{currentZone ? 'This Week' : 'Use Current Home Timezone'}</button></div></div>
      {!currentZone && <p className="notice">Home Timezone is now {progress.timezone}. This view keeps its original timezone until you choose the current one.</p>}
      <ProfileWeekNotes key={`${epoch}:${deviceId}`} epoch={epoch} deviceId={deviceId} identity={identity} active={active && view.weekSection === 'week'}/>
      <p className="metadata">By first completion date · still credited.</p>
      {error && <div className="notice warning" role="alert"><p>{error}{confirmed ? ' Showing the last confirmed week.' : ''}</p><button onClick={() => void load()}>Retry Week</button></div>}
      {confirmed ? <div className="profile-week-chart" aria-label="Currently credited Tasks by first completion date">{confirmed.days.map(row => <button key={row.day} className={day === row.day ? 'active' : ''} aria-pressed={day === row.day} aria-label={`${dateLabel(row.day)}: ${row.count} still credited Tasks, ${row.activityCount} activity entries`} onClick={() => select({ week: identity, day: row.day })}><span>{new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${row.day}T12:00:00Z`))}</span><strong>{row.count}</strong><span>{dateLabel(row.day)}</span><small>{row.activityCount ? `${row.activityCount} activity` : 'No activity'}</small></button>)}</div> : <p role="status">{loading ? 'Loading this week…' : 'This week has not been read yet.'}</p>}
      <p className="metadata">Reopening reverses credit; completing again restores it to the first completion day. Day activity records when each change actually happened, so a day with zero credit can still have activity.</p>
      <section className="profile-day-activity"><div className="section-heading"><h3>{dateLabel(day)} Activity</h3><button disabled={activity.busy} onClick={() => void activity.refresh()}>Refresh Activity</button></div>
        <PageStatus pages={activity} noun="activity"/>
        {activity.loaded && <><p className="metadata">{activity.rows.length} of {activity.total} activity entries · {identity.timezone}</p>{activity.rows.length ? <ul className="profile-event-list">{activity.rows.map(row => <li key={row.id}><div><button className="text-button" disabled={!row.available || row.trashed || !canOpenTask(row.taskId)} onClick={() => { if (taskNavigation.current.canOpenTask(row.taskId) && select({ week: identity, day })) taskNavigation.current.openTask(row.taskId); }}>{row.title}{row.trashed ? ' · In Trash' : ''}</button><p className="metadata">{row.transition === 'reopened' ? 'Task reopened' : row.transition === 'completed-again' ? 'Task completed again' : 'Task completed'} · {stamp(row.at, identity.timezone)}</p></div><strong>{row.xpDelta ? `${row.xpDelta > 0 ? '+' : ''}${row.xpDelta} XP` : 'No new XP'}</strong></li>)}</ul> : <Empty title="No completion activity on this day.">This does not remove earlier credit or change any Task.</Empty>}</>}
        <PageActions pages={activity} noun="Activity"/>
      </section>
      <button ref={historyAction} onClick={showHistory}>See Full Earned History</button>
    </section>
    <section className="card profile-history" hidden={view.weekSection !== 'history'}>
      <div className="section-heading"><div><h2 ref={historyHeading} tabIndex={-1}>Earned History</h2><p>Every recorded Task credit and correction, across all weeks.</p></div><button disabled={history.busy} onClick={() => void history.refresh()}>Refresh History</button></div>
      <PageStatus pages={history} noun="history"/>
      {history.loaded && <><p className="metadata">{history.rows.length} of {history.total} earned entries · {identity.timezone}</p>{history.rows.length ? <ul>{history.rows.map(row => <li key={row.id}><div><button className="text-button" disabled={row.trashed || !canOpenTask(row.taskId)} onClick={() => { if (select({ historyCount: history.rows.length })) openTask(row.taskId); }}>{row.title}{row.trashed ? ' · In Trash' : ''}</button><p className="metadata">{row.xpDelta > 0 ? 'Task completed' : 'Task reopened'} · {stamp(row.at, identity.timezone)}</p></div><strong>{row.xpDelta > 0 ? '+' : ''}{row.xpDelta} XP</strong></li>)}</ul> : <Empty title="Your next step counts.">Complete a Task to begin your earned history.</Empty>}</>}
      <PageActions pages={history} noun="History" kept={() => changeView({ historyCount: Math.max(currentView.current.historyCount, history.rows.length) })}/>
    </section>
  </section>;
}

function PageStatus<T extends { id: string }>({ pages, noun }: { pages: ProfilePages<T>; noun: string }) {
  return <>{pages.busy && <p role="status">Loading {noun}…</p>}{pages.stale && <p className="notice">New or changed activity is available. Refresh {noun} to review it; your loaded entries remain here.</p>}{pages.error && <p role="alert" className="field-error">{pages.error}</p>}{pages.refreshing && <p className="metadata">{pages.refreshedRows} refreshed entries read. Earlier confirmed rows stay visible until the loaded range is complete.</p>}</>;
}
function PageActions<T extends { id: string }>({ pages, noun, kept }: { pages: ProfilePages<T>; noun: string; kept?(): void }) {
  return <div className="button-row">{pages.refreshing ? <button disabled={pages.busy} onClick={async () => { await pages.refresh(undefined, true); if (pages.active) kept?.(); }}>Continue Refreshing {noun}</button> : pages.next ? <button disabled={pages.busy} onClick={async () => { await pages.more(); if (pages.active) kept?.(); }}>Load Earlier {noun}</button> : null}{pages.error && <button disabled={pages.busy} onClick={async () => { await pages.refresh(); if (pages.active) kept?.(); }}>Retry {noun}</button>}</div>;
}
