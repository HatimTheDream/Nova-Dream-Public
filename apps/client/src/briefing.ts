import type { Draft, Entity, Snapshot, Task } from '../../../packages/domain/contracts';

/**
 * Proactive home briefing: "Here's what deserves your attention, and why."
 *
 * Pure ranking engine. No I/O, no model calls. Every claim is grounded in
 * the snapshot; when the data doesn't support a claim, the wording says so.
 */

export type BriefingTier = 1 | 2 | 3 | 4;

export interface BriefingWhy {
  source: string;
  freshness: string;
  reason: string;
}

export interface BriefingAction {
  kind: 'open-task' | 'review-draft' | 'snooze' | 'mark-done' | 'hide';
  label: string;
  taskId?: string;
}

export interface BriefingItem {
  /** Stable obligation id (task id, draft id). Dismissal ties to this. */
  id: string;
  /** Obligation + occurrence (e.g. task id + date). Rewording never resurrects dismissal. */
  occurrenceKey: string;
  tier: BriefingTier;
  title: string;
  /** Honest wording. Never overstates what the data supports. */
  detail: string;
  whyThis: BriefingWhy;
  actions: BriefingAction[];
  importance: 'low' | 'normal' | 'high';
  /** Latest useful action time, when known. Never invented. */
  latestActionTime?: number;
}

export interface Briefing {
  items: BriefingItem[];
  /** Count of urgent items beyond the visible cap. Never silently hidden. */
  overflowCount: number;
  generatedAt: number;
  /** Per-source freshness, e.g. "Tasks current as of 8:42 AM". */
  freshnessLine: string;
}

export interface DismissalState {
  /** occurrenceKey -> 'snoozed' | 'hidden' | 'done' */
  dismissed: Record<string, 'snoozed' | 'hidden' | 'done'>;
  /** occurrenceKey -> timestamp when a snooze expires */
  snoozeUntil: Record<string, number>;
}

const MAX_VISIBLE = 5;

const importanceRank = { high: 0, normal: 1, low: 2 } as const;

function startOfDay(timestamp: number, timezone?: string): number {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return new Date(`${parts}T00:00:00`).getTime();
}

function dayKey(timestamp: number, timezone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
}

function formatTime(timestamp: number, timezone?: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(timestamp);
}

/**
 * Build the briefing from the snapshot. Pure function for testability.
 *
 * Gate questions per candidate:
 * 1. Does this require me? (not the agent, not someone else)
 * 2. Can I take a useful action now?
 * 3. Is the supporting information current enough?
 */
export function buildBriefing(snapshot: Snapshot, now: number, dismissals: DismissalState, timezone?: string): Briefing {
  const candidates: BriefingItem[] = [];
  const todayStart = startOfDay(now, timezone);
  const todayKey = dayKey(now, timezone);
  const freshnessLine = `Tasks current as of ${formatTime(now, timezone)}`;

  const isDismissed = (occurrenceKey: string): boolean => {
    const state = dismissals.dismissed[occurrenceKey];
    if (!state) return false;
    if (state === 'snoozed') {
      const until = dismissals.snoozeUntil[occurrenceKey] ?? 0;
      return now < until;
    }
    return true;
  };

  // --- Tasks: overdue with real due dates ---
  for (const task of snapshot.tasks) {
    const value = task.value;
    if (['done', 'skipped'].includes(value.status)) continue;
    if (value.trashed) continue;

    const occurrenceKey = `task:${task.id}:${todayKey}`;
    if (isDismissed(occurrenceKey)) continue;

    const dueDateStr = value.due && typeof value.due === 'string' ? value.due.slice(0, 10) : undefined;
    // Compare as calendar dates, not timestamps, to avoid timezone edge cases.
    // The due field is a YYYY-MM-DD date; "overdue" means the date is before today.
    const isOverdue = dueDateStr !== undefined && dueDateStr < todayKey;
    const isDueToday = dueDateStr !== undefined && dueDateStr === todayKey;
    const isDueTomorrow = dueDateStr !== undefined && dueDateStr === dayKey(now + 86400000, timezone);

    // Gate 1: requires me? Waiting/blocked tasks need a decision.
    // Gate 2: actionable now? Yes for overdue/due-soon.
    // Gate 3: info current? Due dates are snapshot facts.

    if (isOverdue) {
      // Days overdue from calendar dates: parse both as UTC midnight for a stable diff.
      const dueDateUtc = new Date(`${dueDateStr}T00:00:00Z`).getTime();
      const todayUtc = new Date(`${todayKey}T00:00:00Z`).getTime();
      const daysOverdue = Math.max(0, Math.round((todayUtc - dueDateUtc) / 86400000));
      const latestActionTime = dueDateUtc;
      candidates.push({
        id: task.id,
        occurrenceKey,
        tier: value.priority === 'high' ? 1 : 4,
        title: value.title,
        // Epistemic care: "due date passed" is a fact; "late" implies a broken commitment we can't verify.
        detail: daysOverdue === 0
          ? `Due date passed today.`
          : `Due date was ${daysOverdue} ${daysOverdue === 1 ? 'day' : 'days'} ago.`,
        whyThis: {
          source: 'Task due date',
          freshness: freshnessLine,
          reason: value.priority === 'high'
            ? 'Marked high priority with a passed due date.'
            : 'Due date has passed.',
        },
        actions: [
          { kind: 'open-task', label: 'Open task', taskId: task.id },
          { kind: 'snooze', label: 'Snooze', taskId: task.id },
          { kind: 'mark-done', label: 'Mark done', taskId: task.id },
        ],
        importance: value.priority ?? 'normal',
        latestActionTime,
      });
    } else if (isDueToday) {
      candidates.push({
        id: task.id,
        occurrenceKey,
        tier: 3,
        title: value.title,
        detail: `Due today.`,
        whyThis: {
          source: 'Task due date',
          freshness: freshnessLine,
          reason: 'Due date is today.',
        },
        actions: [
          { kind: 'open-task', label: 'Open task', taskId: task.id },
          { kind: 'snooze', label: 'Snooze', taskId: task.id },
        ],
        importance: value.priority ?? 'normal',
        latestActionTime: undefined,
      });
    } else if (isDueTomorrow) {
      // Tier 3 only if effort suggests starting now; otherwise it waits.
      const estimate = value.estimateMinutes ?? 0;
      if (estimate >= 60 || value.priority === 'high') {
        candidates.push({
          id: task.id,
          occurrenceKey,
          tier: 3,
          title: value.title,
          detail: `Due tomorrow${estimate >= 60 ? `, estimated ${estimate} minutes` : ''}.`,
          whyThis: {
            source: 'Task due date and estimate',
            freshness: freshnessLine,
            reason: estimate >= 60
              ? 'Due tomorrow with a substantial time estimate; starting today is prudent.'
              : 'Due tomorrow and marked high priority.',
          },
          actions: [
            { kind: 'open-task', label: 'Open task', taskId: task.id },
            { kind: 'snooze', label: 'Snooze', taskId: task.id },
          ],
          importance: value.priority ?? 'normal',
          latestActionTime: undefined,
        });
      }
    }

    // Blocked/waiting: your decision is needed.
    if (['blocked', 'waiting'].includes(value.status)) {
      const blockKey = `task-block:${task.id}:${todayKey}`;
      if (!isDismissed(blockKey)) {
        candidates.push({
          id: `${task.id}:block`,
          occurrenceKey: blockKey,
          tier: 2,
          title: value.title,
          detail: value.waitReason
            ? `Waiting: ${value.waitReason}`
            : `Marked ${value.status}. Your decision may unblock it.`,
          whyThis: {
            source: 'Task status',
            freshness: freshnessLine,
            reason: `Task is ${value.status}; only you can resolve it.`,
          },
          actions: [
            { kind: 'open-task', label: 'Open task', taskId: task.id },
            { kind: 'hide', label: 'Not now', taskId: task.id },
          ],
          importance: value.priority ?? 'normal',
        });
      }
    }
  }

  // --- Drafts with content: actionable now ---
  for (const draft of snapshot.drafts) {
    if (!draft.value.text?.trim() && !draft.value.attachments.length) continue;
    const occurrenceKey = `draft:${draft.id}:${todayKey}`;
    if (isDismissed(occurrenceKey)) continue;
    candidates.push({
      id: draft.id,
      occurrenceKey,
      tier: 3,
      title: draft.value.title || 'Untitled draft',
      detail: 'A draft is waiting for your attention.',
      whyThis: {
        source: 'Saved draft',
        freshness: freshnessLine,
        reason: 'Draft has unsent content.',
      },
      actions: [
        { kind: 'review-draft', label: 'Review draft' },
        { kind: 'snooze', label: 'Snooze' },
      ],
      importance: 'normal',
    });
  }

  // --- Rank: tier, then importance, then latest action time, then stable id ---
  candidates.sort((a, b) =>
    a.tier - b.tier ||
    importanceRank[a.importance] - importanceRank[b.importance] ||
    (a.latestActionTime ?? Infinity) - (b.latestActionTime ?? Infinity) ||
    a.id.localeCompare(b.id)
  );

  const items = candidates.slice(0, MAX_VISIBLE);
  const overflowCount = Math.max(0, candidates.length - MAX_VISIBLE);

  return { items, overflowCount, generatedAt: now, freshnessLine };
}

/** Empty dismissal state for first run. */
export function emptyDismissals(): DismissalState {
  return { dismissed: {}, snoozeUntil: {} };
}
