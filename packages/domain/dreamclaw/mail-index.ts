// Actual original Dream Claw mail-index model, normalization and merge helpers.
// Nova Dream supplies its existing encrypted storage and account authority.
export type MailIndexProvider = 'gmail' | 'microsoft';
export type MailIndexStatus = 'idle' | 'indexing' | 'paused' | 'complete' | 'error';

export interface IndexedMailThread {
  id: string;
  sourceMessageId?: string;
  subject: string;
  from: string;
  date: string;
  labels: string[];
  providerTags: string[];
  messageCount: number;
  category: string;
  summary: string;
  latestBody: string;
  latestSnippet: string;
  attentionScore: number;
}

export interface MailIndexSnapshot {
  schemaVersion: 1;
  provider: MailIndexProvider;
  accountId: string;
  query: 'inbox';
  microsoftIdType?: 'immutable';
  status: MailIndexStatus;
  threads: IndexedMailThread[];
  nextCursor?: string;
  exhausted: boolean;
  totalMessageCount?: number;
  totalThreadCount?: number;
  pagesIndexed: number;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  lastSuccessfulPageAt?: string;
  error?: string;
}

export const MAX_INDEXED_THREADS = 100_000;
const MAX_TEXT_LENGTH = 4_000;

function cleanString(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanStringList(value: unknown, maxItems = 50): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanString(item, 160)).filter(Boolean))].slice(0, maxItems);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return fallback;
  return Math.min(max, Math.max(min, normalized));
}

export function sanitizeIndexedMailThread(value: unknown): IndexedMailThread | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const id = cleanString(source.id, 1_000);
  if (!id) return null;

  return {
    id,
    sourceMessageId: cleanString(source.sourceMessageId, 1_000) || undefined,
    subject: cleanString(source.subject, 1_000) || '(no subject)',
    from: cleanString(source.from, 1_000) || '(unknown sender)',
    date: cleanString(source.date, 100),
    labels: cleanStringList(source.labels),
    providerTags: cleanStringList(source.providerTags),
    messageCount: Math.round(clampNumber(source.messageCount, 1, 100_000, 1)),
    category: cleanString(source.category, 100) || 'other',
    summary: cleanString(source.summary, 1_200),
    latestBody: cleanString(source.latestBody, MAX_TEXT_LENGTH),
    latestSnippet: cleanString(source.latestSnippet, 1_200),
    attentionScore: clampNumber(source.attentionScore, -1_000, 1_000, 0),
  };
}

export function createMailIndexSnapshot(
  provider: MailIndexProvider,
  accountId: string,
  now = new Date().toISOString(),
): MailIndexSnapshot {
  return {
    schemaVersion: 1,
    provider,
    accountId: cleanString(accountId, 1_000),
    query: 'inbox',
    status: 'idle',
    threads: [],
    exhausted: false,
    pagesIndexed: 0,
    updatedAt: now,
  };
}

export function mergeIndexedMailThreads(
  current: IndexedMailThread[],
  incoming: unknown[],
): IndexedMailThread[] {
  const byId = new Map<string, IndexedMailThread>();
  for (const candidate of current) {
    const normalized = sanitizeIndexedMailThread(candidate);
    if (normalized) byId.set(normalized.id, normalized);
  }
  for (const candidate of incoming) {
    const normalized = sanitizeIndexedMailThread(candidate);
    if (!normalized) continue;
    const previous = byId.get(normalized.id);
    if (!previous) {
      byId.set(normalized.id, normalized);
      continue;
    }
    const latest = (Date.parse(normalized.date) || 0) >= (Date.parse(previous.date) || 0)
      ? normalized
      : previous;
    byId.set(normalized.id, {
      ...latest,
      labels: [...new Set([...previous.labels, ...normalized.labels])],
      providerTags: [...new Set([...previous.providerTags, ...normalized.providerTags])],
      messageCount: Math.max(previous.messageCount, normalized.messageCount),
      attentionScore: Math.max(previous.attentionScore, normalized.attentionScore),
    });
  }

  // Date.parse inside a sort comparator becomes extremely expensive for large
  // mailboxes because each thread is parsed O(log n) times. Cache the sortable
  // key once so encrypted index reads and checkpoints remain bounded.
  return [...byId.values()]
    .map((thread) => ({ thread, timestamp: Date.parse(thread.date) || 0 }))
    .sort((a, b) => b.timestamp - a.timestamp || b.thread.attentionScore - a.thread.attentionScore)
    .slice(0, MAX_INDEXED_THREADS)
    .map(({ thread }) => thread);
}

export function removeIndexedMailThread(
  snapshot: MailIndexSnapshot,
  threadId: string,
  now = new Date().toISOString(),
): MailIndexSnapshot {
  const normalizedThreadId = cleanString(threadId, 1_000);
  if (!normalizedThreadId) return snapshot;
  const threads = snapshot.threads.filter((thread) => thread.id !== normalizedThreadId);
  if (threads.length === snapshot.threads.length) return snapshot;
  return {
    ...snapshot,
    threads,
    totalThreadCount: typeof snapshot.totalThreadCount === 'number'
      ? Math.max(0, snapshot.totalThreadCount - 1)
      : undefined,
    updatedAt: now,
  };
}

export function requiresMicrosoftImmutableIdRebuild(snapshot: MailIndexSnapshot): boolean {
  return snapshot.provider === 'microsoft'
    && (
      snapshot.microsoftIdType !== 'immutable'
      || snapshot.threads.some((thread) => !thread.sourceMessageId)
    );
}

export function sanitizeMailIndexSnapshot(value: unknown): MailIndexSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<MailIndexSnapshot>;
  if (source.provider !== 'gmail' && source.provider !== 'microsoft') return null;
  const accountId = cleanString(source.accountId, 1_000);
  if (!accountId) return null;
  const status: MailIndexStatus = ['idle', 'indexing', 'paused', 'complete', 'error'].includes(String(source.status))
    ? source.status as MailIndexStatus
    : 'idle';
  const snapshot = createMailIndexSnapshot(source.provider, accountId, cleanString(source.updatedAt, 100) || new Date().toISOString());
  return {
    ...snapshot,
    microsoftIdType: source.provider === 'microsoft' && source.microsoftIdType === 'immutable'
      ? 'immutable'
      : undefined,
    status,
    threads: mergeIndexedMailThreads([], Array.isArray(source.threads) ? source.threads : []),
    nextCursor: cleanString(source.nextCursor, 16_000) || undefined,
    exhausted: Boolean(source.exhausted),
    totalMessageCount: Number.isFinite(Number(source.totalMessageCount))
      ? Math.max(0, Number(source.totalMessageCount))
      : undefined,
    totalThreadCount: Number.isFinite(Number(source.totalThreadCount))
      ? Math.max(0, Number(source.totalThreadCount))
      : undefined,
    pagesIndexed: Math.round(clampNumber(source.pagesIndexed, 0, 1_000_000, 0)),
    startedAt: cleanString(source.startedAt, 100) || undefined,
    completedAt: cleanString(source.completedAt, 100) || undefined,
    lastSuccessfulPageAt: cleanString(source.lastSuccessfulPageAt, 100) || undefined,
    error: cleanString(source.error, 1_000) || undefined,
  };
}

export function normalizeGmailIndexThreads(values: unknown[]): IndexedMailThread[] {
  return values.map((value) => {
    const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const labels = cleanStringList(source.labels);
    const subject = cleanString(source.subject, 1_000) || '(no subject)';
    const from = cleanString(source.from, 1_000) || '(unknown sender)';
    const haystack = `${subject} ${from}`.toLowerCase();
    let category = 'other';
    if (labels.some((label) => /CATEGORY_(PROMOTIONS|SOCIAL)/i.test(label)) || /unsubscribe|sale|discount|newsletter/.test(haystack)) {
      category = 'promo_social';
    } else if (labels.some((label) => /CATEGORY_UPDATES/i.test(label)) || /notification|update|digest|report/.test(haystack)) {
      category = 'updates_tools';
    } else if (/invoice|receipt|billing|payment|credit card|action required|verify/.test(haystack)) {
      category = 'account_billing_action_required';
    } else if (/meeting|calendar|schedule|appointment|invite/.test(haystack)) {
      category = 'calendar_logistics';
    } else if (!/no-?reply|donotreply|notification/.test(from.toLowerCase())) {
      category = 'personal_outreach';
    }
    let attentionScore = 0;
    if (labels.some((label) => /^UNREAD$/i.test(label))) attentionScore += 25;
    if (labels.some((label) => /^IMPORTANT$/i.test(label))) attentionScore += 20;
    if (labels.some((label) => /^STARRED$/i.test(label))) attentionScore += 15;
    if (/urgent|action required|deadline|past due|payment failed|declined/.test(haystack)) attentionScore += 20;
    if (category === 'promo_social') attentionScore -= 10;
    return sanitizeIndexedMailThread({
      id: source.id,
      sourceMessageId: source.sourceMessageId,
      subject,
      from,
      date: source.date,
      labels,
      providerTags: labels,
      messageCount: source.messageCount,
      category,
      summary: cleanString(source.snippet, 1_200) || subject,
      latestBody: '',
      latestSnippet: cleanString(source.snippet, 1_200),
      attentionScore,
    });
  }).filter((thread): thread is IndexedMailThread => Boolean(thread));
}
