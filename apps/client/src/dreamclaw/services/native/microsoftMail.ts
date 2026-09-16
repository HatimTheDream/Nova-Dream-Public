import { getInboxMailApi, captureInboxMailScope, subscribeInboxMailScope } from '../../inbox-transport';

export interface NativeMicrosoftMailAccountStatus {
  generation: string;
  id: string;
  provider: 'microsoft';
  email: string;
  displayName: string;
  signatureText?: string;
  hasSignature: boolean;
  createdAt: string;
  updatedAt: string;
  scopes: string[];
  canRead: boolean;
  canSend: boolean;
  canDraft: boolean;
  canModify: boolean;
  canUseCalendar: boolean;
}

export interface NativeMicrosoftMailStatus {
  success: boolean;
  available: boolean;
  clientConfigured: boolean;
  tenant: string;
  accounts: NativeMicrosoftMailAccountStatus[];
  error?: string;
}

export interface NativeMicrosoftMailDeviceCodeStartResult {
  success: boolean;
  clientConfigured: boolean;
  tenant: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  deviceCode?: string;
  interval?: number;
  expiresAt?: number;
  message?: string;
  error?: string;
}

export interface NativeMicrosoftMailThreadDigest {
  id: string;
  conversationId: string;
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

export interface NativeMicrosoftMailCategoryOption {
  name: string;
  color?: string;
}

export interface NativeMicrosoftMailMessageView {
  isDraft?: boolean;
  id: string;
  idType?: 'immutable' | 'legacy';
  conversationId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml?: string;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    contentId?: string;
    isInline: boolean;
    base64?: string;
    dataUrl?: string;
  }>;
  snippet: string;
  isRead: boolean;
}

export interface NativeMicrosoftMailMailboxSnapshot {
  accountId: string;
  unreadThreadCount: number;
  fetchedThreadCount: number;
  totalItemCount?: number;
  unreadItemCount?: number;
  truncated: boolean;
  generatedAt: string;
  warning?: string;
  categories: Array<{ key: string; label: string; count: number }>;
  threads: NativeMicrosoftMailThreadDigest[];
}

export type NativeMicrosoftMailFolder = 'inbox' | 'sentitems' | 'drafts' | 'archive' | 'deleteditems';

const MAILBOX_CACHE_MS = 60_000;
const DEFAULT_MAX_THREADS = 200;
const MAX_THREADS = 5_000;

const mailboxCache = new Map<string, { expiresAt: number; snapshot: NativeMicrosoftMailMailboxSnapshot }>();

subscribeInboxMailScope(() => mailboxCache.clear());

function getApi() {
  return getInboxMailApi()?.microsoftMail;
}

function ensureApi() {
  const api = getApi();
  if (!api) throw new Error('Microsoft mail is unavailable in this build.');
  return api;
}

function categoryLabel(key: string): string {
  switch (key) {
    case 'account_billing_action_required': return 'account / billing / action-required';
    case 'updates_tools': return 'updates / tools';
    case 'personal_outreach': return 'personal / outreach';
    case 'calendar_logistics': return 'calendar / logistics';
    case 'promo_social': return 'promo / social';
    default: return 'other';
  }
}

export function mergeThreadDigests(digests: NativeMicrosoftMailThreadDigest[]): NativeMicrosoftMailThreadDigest[] {
  const merged = new Map<string, NativeMicrosoftMailThreadDigest>();
  for (const thread of digests) {
    const existing = merged.get(thread.id);
    if (!existing) {
      merged.set(thread.id, { ...thread });
      continue;
    }

    const existingDate = Date.parse(existing.date || '') || 0;
    const nextDate = Date.parse(thread.date || '') || 0;
    merged.set(thread.id, {
      ...existing,
      messageCount: Math.max(existing.messageCount, thread.messageCount),
      labels: Array.from(new Set([...existing.labels, ...thread.labels])),
      providerTags: Array.from(new Set([...(existing.providerTags || []), ...(thread.providerTags || [])])),
      attentionScore: Math.max(existing.attentionScore, thread.attentionScore),
      ...(nextDate >= existingDate ? {
        sourceMessageId: thread.sourceMessageId,
        date: thread.date,
        from: thread.from,
        subject: thread.subject || existing.subject,
        summary: thread.summary || existing.summary,
        latestBody: thread.latestBody || existing.latestBody,
        latestSnippet: thread.latestSnippet || existing.latestSnippet,
        category: thread.category || existing.category,
      } : {}),
    });
  }
  return [...merged.values()].sort((a, b) => b.attentionScore - a.attentionScore || ((Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0)));
}

export async function getNativeMicrosoftMailStatus(_force = false): Promise<NativeMicrosoftMailStatus> {
  return ensureApi().getStatus();
}

export async function startNativeMicrosoftDeviceAuth(): Promise<NativeMicrosoftMailDeviceCodeStartResult> {
  return ensureApi().startDeviceAuth();
}

export async function completeNativeMicrosoftDeviceAuth(payload: {
  deviceCode: string;
  tenant?: string;
  interval?: number;
  expiresAt?: number;
}): Promise<{ success: boolean; account?: NativeMicrosoftMailAccountStatus; error?: string }> {
  const result = await ensureApi().completeDeviceAuth(payload);
  return result;
}

export async function disconnectNativeMicrosoftAccount(accountId: string): Promise<{ success: boolean; error?: string }> {
  const result = await ensureApi().disconnectAccount({ accountId });
  mailboxCache.delete(accountId);
  return result;
}

export async function updateNativeMicrosoftSignature(payload: {
  accountId: string;
  signatureText?: string;
}): Promise<{ success: boolean; account?: NativeMicrosoftMailAccountStatus; error?: string }> {
  const result = await ensureApi().updateSignature(payload);
  return result;
}

export async function listNativeMicrosoftInboxThreads(opts: {
  accountId: string;
  folder?: NativeMicrosoftMailFolder;
  maxMessages?: number;
  nextLink?: string;
  unreadOnly?: boolean;
}) {
  return ensureApi().listInboxThreads(opts);
}

export async function getNativeMicrosoftInboxStats(accountId: string, folder: NativeMicrosoftMailFolder = 'inbox'): Promise<{
  success: boolean;
  accountId: string;
  totalItemCount?: number;
  unreadItemCount?: number;
  error?: string;
}> {
  const api = ensureApi();
  if (!api.getInboxStats) {
    return { success: false, accountId, error: 'Microsoft inbox counts are unavailable in this runtime.' };
  }
  return api.getInboxStats({ accountId, folder });
}

export async function getNativeMicrosoftConversation(opts: {
  accountId: string;
  conversationId: string;
  messageId?: string;
}): Promise<{
  success: boolean;
  accountId: string;
  messages: NativeMicrosoftMailMessageView[];
  threads?: NativeMicrosoftMailThreadDigest[];
  itemUnavailable?: boolean;
  partial?: boolean;
  error?: string;
}> {
  return ensureApi().getConversation(opts);
}

export async function modifyNativeMicrosoftConversation(payload: {
  accountId: string;
  conversationId: string;
  messageId?: string;
  action: 'mark-read' | 'mark-unread' | 'archive' | 'delete' | 'flag' | 'unflag';
}) {
  return ensureApi().modifyConversation(payload);
}

export async function listNativeMicrosoftCategories(payload: {
  accountId: string;
}): Promise<{ success: boolean; accountId: string; categories: NativeMicrosoftMailCategoryOption[]; error?: string }> {
  return ensureApi().listCategories(payload);
}

export async function updateNativeMicrosoftConversationCategories(payload: {
  accountId: string;
  conversationId: string;
  messageId?: string;
  add?: string[];
  remove?: string[];
}): Promise<{ success: boolean; error?: string }> {
  return ensureApi().updateConversationCategories(payload);
}

export async function createNativeMicrosoftDraft(payload: {
  accountId: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
}): Promise<{ success: boolean; draftId?: string; error?: string }> {
  return ensureApi().createDraft(payload);
}

export async function sendNativeMicrosoftEmail(payload: {
  accountId: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
}): Promise<{ success: boolean; error?: string }> {
  return ensureApi().sendEmail(payload);
}

export async function buildNativeMicrosoftMailboxSnapshot(opts: {
  accountId: string;
  folder?: NativeMicrosoftMailFolder;
  force?: boolean;
  maxThreads?: number;
  unreadOnly?: boolean;
}): Promise<NativeMicrosoftMailMailboxSnapshot> {
  const scope = captureInboxMailScope();
  const maxThreads = Math.max(1, Math.min(MAX_THREADS, opts.maxThreads || DEFAULT_MAX_THREADS));
  const unreadOnly = opts.unreadOnly !== false;
  const folder = opts.folder || 'inbox';
  const key = `${opts.accountId}:${folder}:${unreadOnly ? 'unread' : 'all'}:${maxThreads}`;
  const cached = mailboxCache.get(key);
  if (!opts.force && cached && cached.expiresAt > Date.now()) {
    return cached.snapshot;
  }

  const collected: NativeMicrosoftMailThreadDigest[] = [];
  let nextLink: string | undefined;
  let exhausted = false;
  const seen = new Set<string>();
  let warning: string | undefined;
  const pageSize = Math.min(100, maxThreads);
  const statsPromise = getNativeMicrosoftInboxStats(opts.accountId, folder).catch(() => ({ success: false, accountId: opts.accountId, totalItemCount: undefined, unreadItemCount: undefined }));

  while (collected.length < maxThreads && !exhausted) {
    const result = await listNativeMicrosoftInboxThreads({
      accountId: opts.accountId,
      folder,
      maxMessages: pageSize,
      nextLink,
      unreadOnly,
    });
    scope.assertCurrent();
    if (!result.success) {
      if (!collected.length) throw new Error(result.error || 'Microsoft inbox load failed.');
      warning = result.error; break;
    }
    warning = result.error ?? warning;
    collected.push(...result.threads);
    nextLink = result.nextLink;
    exhausted = result.exhausted;
    if (!nextLink || seen.has(nextLink) || seen.size >= 250) break;
    seen.add(nextLink);
  }

  const threads = mergeThreadDigests(collected).slice(0, maxThreads);
  const stats = await statsPromise;
  scope.assertCurrent();
  const categoryCounts = new Map<string, number>();
  for (const thread of threads) {
    categoryCounts.set(thread.category, (categoryCounts.get(thread.category) || 0) + 1);
  }

  const snapshot: NativeMicrosoftMailMailboxSnapshot = {
    accountId: opts.accountId,
    unreadThreadCount: unreadOnly ? threads.length : (stats.unreadItemCount || 0),
    fetchedThreadCount: threads.length,
    totalItemCount: stats.success ? stats.totalItemCount : undefined,
    unreadItemCount: stats.success ? stats.unreadItemCount : undefined,
    truncated: !exhausted || mergeThreadDigests(collected).length > maxThreads,
    warning,
    generatedAt: new Date().toISOString(),
    categories: [...categoryCounts.entries()].map(([category, count]) => ({
      key: category,
      label: categoryLabel(category),
      count,
    })),
    threads,
  };

  mailboxCache.set(key, { expiresAt: Date.now() + MAILBOX_CACHE_MS, snapshot });
  return snapshot;
}

export function describeNativeMicrosoftConversation(messages: NativeMicrosoftMailMessageView[]): NativeMicrosoftMailMessageView[] {
  return [...messages].sort((a, b) => (Date.parse(a.date || '') || 0) - (Date.parse(b.date || '') || 0));
}
