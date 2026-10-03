import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppIconChoice, Snapshot, Task, Entity } from '../../../packages/domain/contracts';
import { addDays } from '../../../packages/domain/calendar';
import { dayInZone } from '../../../packages/domain/tasks';
import { reminderInstant } from '../../../packages/domain/reminders';
import { buildBriefing, emptyDismissals, type BriefingItem, type DismissalState } from './briefing';
import { NovaAppMark } from './AppIcon';
import { CheckSquare2, FileText, MoreHorizontal } from './icons';

interface Props {
  snapshot: Snapshot;
  timezone?: string;
  appIcon?: AppIconChoice;
  editTask: (task: Entity<Task>) => void;
  complete: (task: Entity<Task>) => void;
  openAssistant: () => void;
  openDraft?: (id: string) => void;
  openTasks?: () => void;
  children?: ReactNode;
}

function loadDismissals(key: string): DismissalState {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    if (parsed && parsed.dismissed && parsed.snoozeUntil && typeof parsed.dismissed === 'object' && typeof parsed.snoozeUntil === 'object') {
      return {
        dismissed: Object.fromEntries(Object.entries(parsed.dismissed).filter(([, value]) => ['snoozed', 'hidden', 'done'].includes(String(value)))) as DismissalState['dismissed'],
        snoozeUntil: Object.fromEntries(Object.entries(parsed.snoozeUntil).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) as Record<string, number>,
      };
    }
  } catch { /* Unavailable or malformed storage does not block the briefing. */ }
  return emptyDismissals();
}

function BriefingRow({ item, primary, onAction }: { item: BriefingItem; primary: boolean; onAction: (item: BriefingItem, kind: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const action = item.actions[0];
  const Icon = action.kind === 'review-draft' ? FileText : CheckSquare2;
  return <li className="quiet-work-row briefing-item" data-tier={item.tier}>
    <span className="quiet-row-icon" aria-hidden="true"><Icon size={22}/></span>
    <div className="quiet-row-copy"><strong>{item.title}</strong><p>{item.detail}</p></div>
    <div className="quiet-row-actions">
      <button className={primary ? 'primary' : undefined} onClick={() => onAction(item, action.kind)}>{action.label}</button>
      <button className="icon-button" aria-label={`Details and options for ${item.title}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><MoreHorizontal size={19}/></button>
    </div>
    {expanded && <div className="briefing-row-details">
      <dl><div><dt>Source</dt><dd>{item.whyThis.source}</dd></div><div><dt>Why this?</dt><dd>{item.whyThis.reason}</dd></div><div><dt>Data</dt><dd>{item.whyThis.freshness}</dd></div></dl>
      <div className="button-row">{item.actions.slice(1).filter(action => action.kind !== 'mark-done').map(action => <button key={action.kind} onClick={() => onAction(item, action.kind)}>{action.label}</button>)}</div>
    </div>}
  </li>;
}

export function BriefingCard({ snapshot, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, appIcon = 'red', editTask, openAssistant, openDraft, openTasks, children }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer); }, []);
  const key = `nova:briefing:dismissals:${snapshot.epoch}:${snapshot.deviceId}`;
  const [dismissals, setDismissals] = useState<DismissalState>(() => loadDismissals(key));
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setDismissals(loadDismissals(key));
    const update = (event: StorageEvent) => { if (event.key === key) setDismissals(loadDismissals(key)); };
    window.addEventListener('storage', update); return () => window.removeEventListener('storage', update);
  }, [key]);
  const briefing = useMemo(() => buildBriefing(snapshot, now, dismissals, timezone), [snapshot, now, dismissals, timezone]);
  const hour = Number(new Intl.DateTimeFormat('en', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(now));
  const greeting = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
  const tomorrow = addDays(dayInZone(timezone, now), 1);
  const groups = [
    { name: 'Needs attention', items: briefing.items.filter(item => item.actions[0].kind !== 'review-draft' && (item.tier <= 2 || snapshot.tasks.find(task => task.id === item.id)?.value.due !== tomorrow)) },
    { name: 'Drafts to return to', items: briefing.items.filter(item => item.actions[0].kind === 'review-draft') },
    { name: 'Prepare for tomorrow', items: briefing.items.filter(item => item.actions[0].kind !== 'review-draft' && item.tier > 2 && snapshot.tasks.find(task => task.id === item.id)?.value.due === tomorrow) },
  ].filter(group => group.items.length);
  const firstId = groups[0]?.items[0]?.occurrenceKey;
  const handleAction = (item: BriefingItem, kind: string) => {
    const taskId = item.actions.find(action => action.taskId)?.taskId;
    if (kind === 'open-task') { const task = snapshot.tasks.find(task => task.id === taskId); if (task) editTask(task); return; }
    if (kind === 'review-draft') { if (openDraft) openDraft(item.id); else openAssistant(); return; }
    const current = loadDismissals(key);
    const next = { dismissed: { ...dismissals.dismissed, ...current.dismissed }, snoozeUntil: { ...dismissals.snoozeUntil, ...current.snoozeUntil } };
    if (kind === 'snooze') {
      const until = reminderInstant({ date: tomorrow, time: '07:00', timezone, overlap: 'later' }).instant;
      if (until === null) { setNotice('That morning time is unavailable in your timezone. You can hide this item for today.'); return; }
      // The timed key is independent of the day so it survives midnight.
      next.snoozeUntil[item.occurrenceKey.replace(/:\d{4}-\d{2}-\d{2}$/, '')] = until;
    } else { next.dismissed[item.occurrenceKey] = 'hidden'; }
    setDismissals(next);
    try { localStorage.setItem(key, JSON.stringify(next)); setNotice(''); }
    catch { setNotice('This choice is kept only in this view because browser storage is unavailable.'); }
  };
  return <section className="briefing-card" aria-label="Daily briefing">
    <header className="home-welcome"><NovaAppMark choice={appIcon}/><div><p className="home-date">{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: timezone }).format(now)}</p><h1>{greeting}</h1><p>{briefing.items.length ? `${briefing.items.length === 1 ? 'One thing' : `${briefing.items.length} things`} to take a look at today.` : 'Your day, at a glance.'}</p></div></header>
    {children}
    {notice && <p className="notice" role="status">{notice}</p>}
    {groups.map(group => <section className="quiet-section" key={group.name}><h2>{group.name}</h2><ul className="briefing-items">{group.items.map(item => <BriefingRow key={item.occurrenceKey} item={item} primary={item.occurrenceKey === firstId} onAction={handleAction}/>)}</ul></section>)}
    {!briefing.items.length && <div className="quiet-section"><h2>A little breathing room</h2><p>No items to show from your saved tasks and drafts. Hidden or snoozed items may still need attention.</p><button onClick={openTasks || openAssistant}>View saved work</button></div>}
    {briefing.overflowCount > 0 && <div className="briefing-overflow"><p>{briefing.overflowCount} more items in your saved work.</p><button onClick={openTasks || openAssistant}>View tasks</button><button onClick={openAssistant}>View drafts</button></div>}
    <p className="briefing-freshness">{briefing.freshnessLine} · <span>Details explain each suggestion.</span></p>
  </section>;
}
