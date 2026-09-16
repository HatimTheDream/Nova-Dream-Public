export type InboxGrouping = 'topic' | 'sender' | 'recipient' | 'none';
export type InboxSortOrder = 'newest' | 'oldest' | 'sender-asc' | 'sender-desc' | 'subject-asc' | 'subject-desc' | 'attention';

export interface GroupableInboxThread {
  from: string;
  subject?: string;
  accountLabel: string;
  category?: string;
  date?: string;
  attentionScore?: number;
  isPinned?: boolean;
}

const TOPIC_LABELS: Record<string, string> = {
  account_billing_action_required: 'Action and billing',
  personal_outreach: 'People and outreach',
  calendar_logistics: 'Meetings and scheduling',
  updates_tools: 'Updates and tools',
  promo_social: 'Newsletters and promotions',
  other: 'Other mail',
};

const TOPIC_ORDER = new Map([
  'account_billing_action_required',
  'personal_outreach',
  'calendar_logistics',
  'updates_tools',
  'promo_social',
  'other',
].map((value, index) => [value, index]));

export function normalizeInboxGrouping(value?: string | null): InboxGrouping {
  return value === 'sender' || value === 'recipient' || value === 'topic' ? value : 'none';
}

export function normalizeInboxSortOrder(value?: string | null): InboxSortOrder {
  return value === 'oldest'
    || value === 'sender-asc'
    || value === 'sender-desc'
    || value === 'subject-asc'
    || value === 'subject-desc'
    || value === 'attention'
    ? value
    : 'newest';
}

function extractAddress(value: string): string {
  const input = String(value || '').trim();
  const match = input.match(/<([^>]+)>/);
  return (match?.[1] || input).trim().toLowerCase();
}

export function inboxSenderLabel(value: string): string {
  const input = String(value || '').trim();
  if (!input) return 'Unknown sender';
  const display = input.match(/^(.*?)(?:\s*<[^>]+>)$/)?.[1]?.replace(/^"+|"+$/g, '').trim();
  return display || extractAddress(input) || 'Unknown sender';
}

export function inboxGroupKey(thread: GroupableInboxThread, grouping: InboxGrouping): string {
  if (grouping === 'sender') return extractAddress(thread.from) || 'unknown-sender';
  if (grouping === 'recipient') return String(thread.accountLabel || 'Unknown account').trim().toLowerCase();
  if (grouping === 'topic') return String(thread.category || 'other').trim().toLowerCase();
  return 'all';
}

export function inboxGroupLabel(thread: GroupableInboxThread, grouping: InboxGrouping): string {
  if (grouping === 'sender') return inboxSenderLabel(thread.from);
  if (grouping === 'recipient') return String(thread.accountLabel || 'Unknown receiving account').trim();
  if (grouping === 'topic') return TOPIC_LABELS[thread.category || 'other'] || 'Other mail';
  return 'All mail';
}

export function inboxThreadTimestamp(value?: string): number {
  const normalized = String(value || '').trim();
  if (!normalized) return 0;
  if (/^\d+$/.test(normalized)) {
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) return 0;
    return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortGroupedInboxThreads<T extends GroupableInboxThread>(
  threads: T[],
  grouping: InboxGrouping,
  sortOrder: InboxSortOrder = 'newest',
): T[] {
  return [...threads].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;

    // Keep each chosen group contiguous; dates sort messages within that group.
    // Pinned messages have their own section, independent of the chosen grouping.
    if (grouping !== 'none' && !a.isPinned && !b.isPinned) {
      const aKey = inboxGroupKey(a, grouping), bKey = inboxGroupKey(b, grouping);
      if (aKey !== bKey) {
        const groupDelta = grouping === 'topic'
          ? (TOPIC_ORDER.get(aKey) ?? 99) - (TOPIC_ORDER.get(bKey) ?? 99) || aKey.localeCompare(bKey)
          : inboxGroupLabel(a, grouping).localeCompare(inboxGroupLabel(b, grouping)) || aKey.localeCompare(bKey);
        if (groupDelta) return groupDelta;
      }
    }

    const newestFirst = inboxThreadTimestamp(b.date) - inboxThreadTimestamp(a.date);
    const senderDelta = inboxSenderLabel(a.from).localeCompare(inboxSenderLabel(b.from));
    const subjectDelta = String(a.subject || '').localeCompare(String(b.subject || ''));
    const attentionDelta = (b.attentionScore || 0) - (a.attentionScore || 0);

    let sortDelta = 0;

    switch (sortOrder) {
      case 'oldest': sortDelta = -newestFirst || senderDelta || subjectDelta; break;
      case 'sender-asc': sortDelta = senderDelta || newestFirst || subjectDelta; break;
      case 'sender-desc': sortDelta = -senderDelta || newestFirst || subjectDelta; break;
      case 'subject-asc': sortDelta = subjectDelta || newestFirst || senderDelta; break;
      case 'subject-desc': sortDelta = -subjectDelta || newestFirst || senderDelta; break;
      case 'attention': sortDelta = attentionDelta || newestFirst || senderDelta; break;
      default: sortDelta = newestFirst || attentionDelta || senderDelta || subjectDelta;
    }
    if (sortDelta !== 0) return sortDelta;

    if (grouping === 'none') return 0;
    const aKey = inboxGroupKey(a, grouping);
    const bKey = inboxGroupKey(b, grouping);
    if (grouping === 'topic') return (TOPIC_ORDER.get(aKey) ?? 99) - (TOPIC_ORDER.get(bKey) ?? 99);
    return inboxGroupLabel(a, grouping).localeCompare(inboxGroupLabel(b, grouping));
  });
}
