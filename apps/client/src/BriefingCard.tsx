import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot, Task, Entity } from '../../../packages/domain/contracts';
import { buildBriefing, emptyDismissals, type BriefingItem, type DismissalState } from './briefing';

interface Props {
  snapshot: Snapshot;
  timezone?: string;
  editTask: (task: Entity<Task>) => void;
  complete: (task: Entity<Task>) => void;
  openAssistant: () => void;
}

const DISMISSAL_KEY = 'nova:briefing:dismissals';

function loadDismissals(): DismissalState {
  try {
    const raw = localStorage.getItem(DISMISSAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.dismissed === 'object') return parsed as DismissalState;
    }
  } catch { /* corrupted storage: start fresh */ }
  return emptyDismissals();
}

function saveDismissals(state: DismissalState) {
  try {
    localStorage.setItem(DISMISSAL_KEY, JSON.stringify(state));
  } catch { /* storage full or unavailable: dismissal won't persist */ }
}

function Greeting({ now }: { now: number }) {
  const hour = new Date(now).getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return <>{greeting}</>;
}

function BriefingItemCard({ item, onAction }: { item: BriefingItem; onAction: (item: BriefingItem, kind: string) => void }) {
  const [showWhy, setShowWhy] = useState(false);
  return (
    <li className="briefing-item" data-tier={item.tier}>
      <div className="briefing-item-main">
        <strong className="briefing-item-title">{item.title}</strong>
        <p className="briefing-item-detail">{item.detail}</p>
        <div className="briefing-item-actions">
          {item.actions.map(action => (
            <button
              key={action.kind}
              className={`briefing-action briefing-action-${action.kind}${['open-task', 'review-draft'].includes(action.kind) ? ' primary' : ''}`}
              onClick={() => onAction(item, action.kind)}
            >
              {action.label}
            </button>
          ))}
          <button
            className="briefing-why-toggle"
            aria-expanded={showWhy}
            onClick={() => setShowWhy(v => !v)}
          >
            Why this?
          </button>
        </div>
        {showWhy && (
          <div className="briefing-why">
            <dl>
              <div><dt>Source</dt><dd>{item.whyThis.source}</dd></div>
              <div><dt>Freshness</dt><dd>{item.whyThis.freshness}</dd></div>
              <div><dt>Reason</dt><dd>{item.whyThis.reason}</dd></div>
            </dl>
          </div>
        )}
      </div>
    </li>
  );
}

export function BriefingCard({ snapshot, timezone, editTask, complete, openAssistant }: Props) {
  const [now, setNow] = useState(() => Date.now());
  // Reevaluate at minute boundaries so midnight rollover and snooze expiry take effect.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const [dismissals, setDismissals] = useState<DismissalState>(loadDismissals);
  const [updateNotice, setUpdateNotice] = useState(false);
  const lastCursor = useRef(snapshot.cursor);

  const briefing = useMemo(
    () => buildBriefing(snapshot, now, dismissals, timezone),
    [snapshot, now, dismissals, timezone]
  );

  // When new snapshot data arrives, note it without yanking the layout.
  useEffect(() => {
    if (snapshot.cursor !== lastCursor.current) {
      lastCursor.current = snapshot.cursor;
      setUpdateNotice(true);
      const timer = window.setTimeout(() => setUpdateNotice(false), 8000);
      return () => window.clearTimeout(timer);
    }
  }, [snapshot.cursor]);

  const updateDismissals = (next: DismissalState) => {
    setDismissals(next);
    saveDismissals(next);
  };

  const handleAction = (item: BriefingItem, kind: string) => {
    const task = item.actions.find(a => a.taskId)?.taskId
      ? snapshot.tasks.find(t => t.id === item.actions.find(a => a.taskId)?.taskId)
      : undefined;

    switch (kind) {
      case 'open-task':
        if (task) editTask(task);
        break;
      case 'review-draft':
        openAssistant();
        break;
      case 'snooze': {
        // Snooze until tomorrow morning.
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(7, 0, 0, 0);
        updateDismissals({
          dismissed: { ...dismissals.dismissed, [item.occurrenceKey]: 'snoozed' },
          snoozeUntil: { ...dismissals.snoozeUntil, [item.occurrenceKey]: tomorrow.getTime() },
        });
        break;
      }
      case 'hide':
        updateDismissals({
          dismissed: { ...dismissals.dismissed, [item.occurrenceKey]: 'hidden' },
          snoozeUntil: dismissals.snoozeUntil,
        });
        break;
      case 'mark-done':
        if (task) complete(task);
        updateDismissals({
          dismissed: { ...dismissals.dismissed, [item.occurrenceKey]: 'done' },
          snoozeUntil: dismissals.snoozeUntil,
        });
        break;
    }
  };

  // Zero items: say so plainly and get out of the way.
  if (briefing.items.length === 0) {
    return (
      <section className="briefing-card briefing-empty" aria-label="Morning briefing">
        <p><Greeting now={now} />. Nothing needs you right now. Enjoy the quiet.</p>
        <p className="briefing-freshness">{briefing.freshnessLine}</p>
      </section>
    );
  }

  return (
    <section className="briefing-card" aria-label="Morning briefing">
      <div className="briefing-header">
        <h2><Greeting now={now} />. {briefing.items.length === 1 ? 'One priority' : `${briefing.items.length} priorities`} for today.</h2>
        {updateNotice && <p className="briefing-updated" role="status">Briefing updated.</p>}
      </div>
      <ol className="briefing-items">
        {briefing.items.map(item => (
          <BriefingItemCard key={item.occurrenceKey} item={item} onAction={handleAction} />
        ))}
      </ol>
      {briefing.overflowCount > 0 && (
        <p className="briefing-overflow">
          {briefing.overflowCount} more {briefing.overflowCount === 1 ? 'needs' : 'need'} attention.
        </p>
      )}
      <p className="briefing-freshness">{briefing.freshnessLine}</p>
    </section>
  );
}
