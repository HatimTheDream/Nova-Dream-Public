import type { Snapshot } from '../../../packages/domain/contracts';
import { addDays } from '../../../packages/domain/calendar';

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
  /** Describes the available source, without inventing a synchronization time. */
  freshnessLine: string;
}

export interface DismissalState {
  /** occurrenceKey -> 'snoozed' | 'hidden' | 'done' */
  dismissed: Record<string, 'snoozed' | 'hidden' | 'done'>;
  /** Stable obligation key -> expiry; legacy occurrence keys remain readable. */
  snoozeUntil: Record<string, number>;
}

const MAX_VISIBLE = 5;

const importanceRank = { high: 0, normal: 1, low: 2 } as const;

function dayKey(timestamp: number, timezone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
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
  const todayKey = dayKey(now, timezone);
  const tomorrowKey = addDays(todayKey, 1);
  const freshnessLine = 'From saved tasks and drafts';

  const isDismissed = (occurrenceKey: string): boolean => {
    const stableKey = occurrenceKey.replace(/:\d{4}-\d{2}-\d{2}$/, '');
    const until = Math.max(dismissals.snoozeUntil[stableKey] ?? 0, dismissals.snoozeUntil[occurrenceKey] ?? 0);
    // Timed snoozes survive the calendar-day boundary and do not require a
    // per-day dismissal entry. Continue honoring the former keyed format.
    if (now < until) return true;
    const state = dismissals.dismissed[occurrenceKey];
    return state === 'hidden' || state === 'done';
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
    const isDueTomorrow = dueDateStr !== undefined && dueDateStr === tomorrowKey;

    // Due dates are saved facts. Showing an actionable task does not establish
    // who caused a delay or whether the owner can resolve a blockage alone.

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

    // Status is evidence of a blockage, not evidence that only the owner can
    // resolve it. A due date and a blockage describe one obligation.
    if (['blocked', 'waiting'].includes(value.status)) {
      const blockKey = `task-block:${task.id}:${todayKey}`;
      if (!isDismissed(blockKey)) {
        const statusDetail = value.waitReason
          ? `Marked ${value.status}: ${value.waitReason}`
          : `Marked ${value.status}. Review its status or next step.`;
        const statusReason = `Task is marked ${value.status}; review what can move it forward.`;
        const dueCandidate = candidates.at(-1);
        if (dueCandidate?.id === task.id) {
          dueCandidate.tier = Math.min(dueCandidate.tier, 2) as BriefingTier;
          dueCandidate.detail += ` ${statusDetail}`;
          dueCandidate.whyThis.source += ' and task status';
          dueCandidate.whyThis.reason += ` ${statusReason}`;
          dueCandidate.actions.push({ kind: 'hide', label: 'Not now', taskId: task.id });
        } else candidates.push({
          id: task.id,
          occurrenceKey,
          tier: 2,
          title: value.title,
          detail: statusDetail,
          whyThis: {
            source: 'Task status',
            freshness: freshnessLine,
            reason: statusReason,
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
    const organization = snapshot.draftOrganization?.find(row => row.draftId === draft.id && row.draftRevision === draft.revision);
    if (organization && organization.folder !== 'active') continue;
    const occurrenceKey = `draft:${draft.id}:${todayKey}`;
    if (isDismissed(occurrenceKey)) continue;
    candidates.push({
      id: draft.id,
      occurrenceKey,
      tier: 3,
      title: draft.value.title || 'Untitled draft',
      detail: 'Unsent content is saved here when you want to return to it.',
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
