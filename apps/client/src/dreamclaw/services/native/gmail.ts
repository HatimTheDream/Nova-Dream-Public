import { getInboxMailApi, captureInboxMailScope, subscribeInboxMailScope, selectInboxHydration } from '../../inbox-transport';

export interface NativeGmailAccountStatus {
  id: string;
  generation: string;
  email: string;
  client: string;
  auth: string;
  createdAt?: string;
  services: string[];
  scopes: string[];
  canRead: boolean;
  canSend: boolean;
  canDraft: boolean;
  canModify: boolean;
}

export interface NativeGmailStatus {
  success: boolean;
  toolAvailable?: boolean;
  toolVersion?: string;
  credentialsConfigured?: boolean;
  available: boolean;
  defaultAccount?: string;
  accounts: NativeGmailAccountStatus[];
  error?: string;
}

export interface NativeGmailThreadSummary {
  snippet?: string;
  sourceMessageId?: string;
  id: string;
  date?: string;
  from?: string;
  subject?: string;
  labels: string[];
  messageCount?: number;
}

export interface NativeGmailThreadsSearchResult {
  success: boolean;
  account?: string;
  threads: NativeGmailThreadSummary[];
  nextPageToken?: string;
  exhausted: boolean;
  error?: string;
}

interface NativeGmailHeader {
  name?: string;
  value?: string;
}

interface NativeGmailBody {
  data?: string;
  size?: number;
  attachmentId?: string;
}

interface NativeGmailPart {
  mimeType?: string;
  filename?: string;
  body?: NativeGmailBody;
  headers?: NativeGmailHeader[];
  parts?: NativeGmailPart[];
}

export interface NativeGmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: NativeGmailPart;
}

export interface NativeGmailThread {
  id: string;
  historyId?: string;
  messages: NativeGmailMessage[];
}

export interface NativeGmailThreadResult {
  success: boolean;
  account?: string;
  thread?: NativeGmailThread;
  error?: string;
}

interface NativeGmailAttachmentDataResult {
  success: boolean;
  account?: string;
  base64?: string;
  bytes?: number;
  error?: string;
}

export interface NativeGmailThreadDigest {
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

export interface NativeGmailLabel {
  id: string;
  name: string;
  type?: string;
  labelListVisibility?: string;
  messageListVisibility?: string;
}

export interface NativeGmailInboxStats {
  success: boolean;
  account?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  error?: string;
}

export interface NativeGmailMailboxSnapshot {
  account: string;
  query: string;
  unreadThreadCount: number;
  fetchedThreadCount: number;
  fetchedDetailCount: number;
  truncated: boolean;
  generatedAt: string;
  categories: Array<{ key: string; label: string; count: number }>;
  labelCounts: Array<{ label: string; count: number }>;
  threads: NativeGmailThreadDigest[];
}

export interface NativeGmailSendAsAlias {
  sendAsEmail: string;
  displayName?: string;
  replyToAddress?: string;
  signature?: string;
  isDefault?: boolean;
  isPrimary?: boolean;
  verificationStatus?: string;
  treatAsAlias?: boolean;
}

export interface NativeGmailSendAsResult {
  success: boolean;
  account?: string;
  sendAs: NativeGmailSendAsAlias[];
  error?: string;
}

export interface NativeGmailThreadMessageView {
  id: string;
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
  labelIds: string[];
  internalDate?: string;
}

const MAILBOX_CACHE_MS = 60_000;
const SEND_AS_CACHE_MS = 300_000;
const BASE_UNREAD_QUERY = 'in:inbox is:unread';
const THREAD_PAGE_SIZE = 50;
const MAX_UNREAD_THREADS = 200;
const MAX_DETAIL_THREADS = 80;
const DETAIL_CONCURRENCY = 4;
const MAX_CONTEXT_THREADS = 12;
const MAX_BODY_CHARS = 1_200;
const MAX_CONTEXT_CHARS = 20_000;
const PROMOTION_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']);
const CATEGORY_LABELS = ['CATEGORY_PERSONAL', 'CATEGORY_UPDATES', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'];
const STOPWORDS = new Set([
  'a', 'about', 'all', 'an', 'and', 'any', 'are', 'at', 'be', 'billing', 'by', 'can', 'categorize', 'check', 'count', 'draft',
  'email', 'emails', 'for', 'follow', 'from', 'get', 'gmail', 'i', 'important', 'in', 'inbox', 'into', 'is', 'it', 'mail', 'mailbox',
  'message', 'messages', 'my', 'of', 'on', 'or', 'please', 'read', 'reply', 'send', 'show', 'summarize', 'summary', 'tell', 'that',
  'the', 'their', 'them', 'there', 'these', 'this', 'thread', 'threads', 'to', 'triage', 'unread', 'up', 'urgent', 'what', 'which', 'with', 'work'
]);
const CATEGORY_LABEL_TITLES: Record<string, string> = {
  account_billing_action_required: 'account / billing / action-required',
  updates_tools: 'updates / tools',
  personal_outreach: 'personal / outreach',
  calendar_logistics: 'calendar / logistics',
  promo_social: 'promo / social',
  other: 'other',
};

const mailboxCache = new Map<string, { expiresAt: number; snapshot: NativeGmailMailboxSnapshot }>();
const sendAsCache = new Map<string, { expiresAt: number; aliases: NativeGmailSendAsAlias[] }>();
subscribeInboxMailScope(() => { mailboxCache.clear(); sendAsCache.clear(); });

function fallbackStatus(error?: string): NativeGmailStatus {
  return {
    success: false,
    available: false,
    defaultAccount: undefined,
    accounts: [],
    ...(error ? { error } : {}),
  };
}

function normalizeNativeGmailThreadShape(value: any): NativeGmailThread | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value.messages)) return value as NativeGmailThread;
  if (value.thread && typeof value.thread === 'object' && Array.isArray(value.thread.messages)) {
    return value.thread as NativeGmailThread;
  }
  return undefined;
}

function decodeBase64UrlUtf8(value: string): string {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);

  try {
    if (typeof globalThis.atob === 'function') {
      const binary = globalThis.atob(padded);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    }
  } catch {
    // fall through to Buffer path
  }

  const bufferCtor = (globalThis as { Buffer?: { from: (input: string, encoding: string) => { toString: (enc?: string) => string } } }).Buffer;
  if (bufferCtor?.from) {
    return bufferCtor.from(padded, 'base64').toString('utf-8');
  }

  return '';
}

function normalizeBase64Url(value: string): string {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
}

function normalizeWhitespace(value: string): string {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countUrlNoise(value: string): number {
  const matches = String(value || '').match(/https?:\/\/\S+/gi) || [];
  return matches.reduce((score, url) => score + (url.length >= 60 ? 2 : 1), 0);
}

function shortenEmailUrl(url: string): string {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.length < 60) return raw;
  try {
    const parsed = new URL(raw);
    return `[link: ${parsed.hostname}]`;
  } catch {
    return '[link]';
  }
}

function sanitizeEmailDisplayText(value: string): string {
  let text = normalizeWhitespace(value);
  if (!text) return '';

  text = text
    .replace(/\s*\((https?:\/\/[^)\s]+)\)/gi, (_match, url: string) => ` (${shortenEmailUrl(url)})`)
    .replace(/\s*<(https?:\/\/[^>\s]+)>/gi, (_match, url: string) => ` <${shortenEmailUrl(url)}>` )
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^https?:\/\/\S+$/i.test(trimmed) && trimmed.length >= 40) return false;
      return true;
    })
    .join('\n');

  text = text.replace(/https?:\/\/\S+/gi, (url) => shortenEmailUrl(url));
  return normalizeWhitespace(text);
}

function stripHtml(value: string): string {
  const html = String(value || '');
  if (!html) return '';

  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return normalizeWhitespace(doc.body?.textContent || '');
    } catch {
      // fall through to regex cleanup
    }
  }

  return normalizeWhitespace(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, '"'),
  );
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getHeader(message: NativeGmailMessage | undefined, name: string): string {
  const headers = message?.payload?.headers || [];
  const match = headers.find((header) => String(header?.name || '').toLowerCase() === name.toLowerCase());
  return String(match?.value || '').trim();
}

function getPartHeader(part: NativeGmailPart | undefined, name: string): string {
  const headers = part?.headers || [];
  const match = headers.find((header) => String(header?.name || '').toLowerCase() === name.toLowerCase());
  return String(match?.value || '').trim();
}

function normalizeContentId(value: string): string {
  return String(value || '').trim().replace(/^<|>$/g, '').trim();
}

function htmlToParagraphs(value: string): string {
  const normalized = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  return normalized
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 12px 0;">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function collectTextParts(part: NativeGmailPart | undefined, mimeType: 'text/plain' | 'text/html', bucket: string[]) {
  if (!part || part.filename || /attachment/i.test(getPartHeader(part, 'Content-Disposition'))) return;
  if (part.mimeType === mimeType && part.body?.data) {
    const decoded = decodeBase64UrlUtf8(part.body.data);
    if (decoded) bucket.push(decoded);
  }
  for (const child of part.parts || []) {
    collectTextParts(child, mimeType, bucket);
  }
}

type GmailPartHydrationTarget = {
  messageId: string;
  attachmentId: string;
  part: NativeGmailPart;
  size?: number;
};

function collectHydrationTargets(
  message: NativeGmailMessage | undefined,
  part: NativeGmailPart | undefined,
  bucket: GmailPartHydrationTarget[],
  seen: Set<string>,
): void {
  if (!message?.id || !part) return;
  const attachmentId = String(part.body?.attachmentId || '').trim();
  const hasBodyData = Boolean(String(part.body?.data || '').trim());
  const key = `${message.id}:${attachmentId}`;
  if (attachmentId && !hasBodyData && !seen.has(key)) {
    seen.add(key);
    bucket.push({
      messageId: message.id,
      attachmentId,
      part,
      size: part.body?.size,
    });
  }

  for (const child of part.parts || []) {
    collectHydrationTargets(message, child, bucket, seen);
  }
}

async function hydrateNativeGmailThreadParts(
  thread: NativeGmailThread | undefined,
  account?: string,
): Promise<NativeGmailThread | undefined> {
  if (!thread) return thread;

  const api = getInboxMailApi()?.gmail;
  if (!api?.getAttachment) return thread;

  const targets: GmailPartHydrationTarget[] = [];
  const seen = new Set<string>();
  for (const message of Array.isArray(thread.messages) ? thread.messages : []) {
    collectHydrationTargets(message, message.payload, targets, seen);
  }

  if (targets.length === 0) return thread;

  const scope = captureInboxMailScope();
  // Text bodies load first; retain metadata when a file is too large or fails.
  targets.sort((a, b) => Number(!a.part.mimeType?.startsWith('text/')) - Number(!b.part.mimeType?.startsWith('text/')));
  await mapConcurrent(selectInboxHydration(targets), 3, async (target) => {
    scope.assertCurrent();
    let result: NativeGmailAttachmentDataResult | undefined;
    try {
      result = await api.getAttachment({
        messageId: target.messageId,
        attachmentId: target.attachmentId,
        account,
      });
    } catch {
      result = undefined;
    }

    scope.assertCurrent();
    if (result?.success && result.base64 && (target.size === undefined || result.bytes === target.size)) {
      target.part.body = {
        ...(target.part.body || {}),
        data: result.base64,
        size: result.bytes ?? target.part.body?.size,
      };
    }
  });

  return thread;
}

function extractMessageBodyText(message: NativeGmailMessage | undefined): string {
  if (!message?.payload) return normalizeWhitespace(String(message?.snippet || ''));

  const plainParts: string[] = [];
  const htmlParts: string[] = [];
  collectTextParts(message.payload, 'text/plain', plainParts);
  collectTextParts(message.payload, 'text/html', htmlParts);

  const plain = sanitizeEmailDisplayText(plainParts.join('\n\n'));
  const html = sanitizeEmailDisplayText(stripHtml(htmlParts.join('\n\n')));
  if (plain && html) {
    return countUrlNoise(plain) > countUrlNoise(html) ? html : plain;
  }
  if (plain) return plain;
  if (html) return html;

  const direct = message.payload.body?.data ? decodeBase64UrlUtf8(message.payload.body.data) : '';
  const decodedDirect = message.payload.mimeType === 'text/html'
    ? sanitizeEmailDisplayText(stripHtml(direct))
    : sanitizeEmailDisplayText(direct);
  return decodedDirect || sanitizeEmailDisplayText(String(message.snippet || ''));
}

function extractMessageBodyHtml(message: NativeGmailMessage | undefined): string {
  if (!message?.payload) return '';

  const htmlParts: string[] = [];
  collectTextParts(message.payload, 'text/html', htmlParts);
  if (htmlParts.length > 0) {
    return htmlParts.join('\n\n').trim();
  }

  if (message.payload.mimeType === 'text/html' && message.payload.body?.data) {
    return decodeBase64UrlUtf8(message.payload.body.data).trim();
  }

  return '';
}

function collectMessageAttachments(
  part: NativeGmailPart | undefined,
  bucket: NativeGmailThreadMessageView['attachments'],
  seen: Set<string>,
): void {
  if (!part) return;

  const mimeType = String(part.mimeType || '').trim().toLowerCase();
  const filename = String(part.filename || '').trim();
  const disposition = getPartHeader(part, 'Content-Disposition').toLowerCase();
  const contentId = normalizeContentId(getPartHeader(part, 'Content-ID'));
  const attachmentId = String(part.body?.attachmentId || '').trim();
  const bodyData = String(part.body?.data || '').trim();
  const isTextBody = mimeType === 'text/plain' || mimeType === 'text/html';
  const isMultipart = mimeType.startsWith('multipart/');
  const looksLikeAttachment = Boolean(
    !isMultipart
      && (!isTextBody || Boolean(filename) || disposition.includes('attachment'))
      && (filename || contentId || disposition.includes('attachment') || disposition.includes('inline') || attachmentId || bodyData),
  );

  if (looksLikeAttachment && bucket) {
    const id = attachmentId || contentId || filename || `${mimeType || 'attachment'}:${bucket.length}`;
    if (!seen.has(id)) {
      seen.add(id);
      const isInline = disposition.includes('inline') || Boolean(contentId);
      const base64 = bodyData ? normalizeBase64Url(bodyData) : undefined;
      const dataUrl = bodyData && mimeType.startsWith('image/')
        ? `data:${mimeType};base64,${base64}`
        : undefined;

      bucket.push({
        id,
        name: filename || contentId || 'attachment',
        mimeType: mimeType || 'application/octet-stream',
        size: typeof part.body?.size === 'number' ? part.body.size : undefined,
        contentId: contentId || undefined,
        isInline,
        base64,
        dataUrl,
      });
    }
  }

  for (const child of part.parts || []) {
    collectMessageAttachments(child, bucket, seen);
  }
}

function summarizeText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}...`;
}

function isLikelyPromotional(summary: NativeGmailThreadSummary): boolean {
  return summary.labels.some((label) => PROMOTION_LABELS.has(label));
}

function tokenizePrompt(prompt: string): string[] {
  const matches = String(prompt || '').toLowerCase().match(/[a-z0-9@._-]{3,}/g) || [];
  const terms = new Set<string>();
  for (const raw of matches) {
    const term = raw.trim();
    if (!term || STOPWORDS.has(term)) continue;
    if (/^\d+$/.test(term)) continue;
    terms.add(term);
  }
  return [...terms].slice(0, 12);
}

function categorizeDigest(summary: NativeGmailThreadSummary, latestBody: string): string {
  const corpus = `${summary.subject || ''}\n${summary.from || ''}\n${latestBody}`.toLowerCase();
  const labels = new Set(summary.labels || []);

  if (
    /\b(invoice|receipt|billing|payment|payments|trial ending|card declined|subscription|renewal|spend cap|spend caps|account alert|action required|required action|verify your account|security alert|statement ready|overdue|past due|failed payment)\b/.test(corpus)
  ) {
    return 'account_billing_action_required';
  }

  if (
    labels.has('CATEGORY_UPDATES')
    || /\b(update|release|changelog|new feature|tool|workspace|product update|launch|integration|calendar reminder|workflow)\b/.test(corpus)
  ) {
    return 'updates_tools';
  }

  if (
    /\b(meeting|calendar|schedule|availability|invite|tomorrow|today|reschedul|call|zoom|google meet)\b/.test(corpus)
  ) {
    return 'calendar_logistics';
  }

  if (
    labels.has('CATEGORY_PERSONAL')
    || /\b(reply|follow up|following up|reaching out|reach out|introduction|intro|casting|candidate|application|thank you|thanks again|let me know|would love|opportunity)\b/.test(corpus)
  ) {
    return 'personal_outreach';
  }

  if (isLikelyPromotional(summary)) {
    return 'promo_social';
  }

  return 'other';
}

function computeAttentionScore(summary: NativeGmailThreadSummary, latestBody: string, promptTerms: string[]): number {
  const haystack = `${summary.subject || ''}\n${summary.from || ''}\n${latestBody}`.toLowerCase();
  let score = 0;

  if (summary.labels.includes('IMPORTANT')) score += 12;
  if (summary.labels.includes('INBOX')) score += 5;
  if (summary.labels.includes('UNREAD')) score += 8;
  if (!isLikelyPromotional(summary)) score += 6;
  if (/\b(action required|required action|payment|trial ending|invoice|reply|follow up|availability|meeting|urgent|deadline)\b/.test(haystack)) score += 14;

  for (const term of promptTerms) {
    if (haystack.includes(term)) score += 10;
  }

  return score;
}

function buildDigest(summary: NativeGmailThreadSummary, thread: NativeGmailThread, promptTerms: string[]): NativeGmailThreadDigest {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const latestMessage = messages.slice().sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0)).at(-1);
  const latestBody = summarizeText(extractMessageBodyText(latestMessage), MAX_BODY_CHARS);
  const latestSnippet = summarizeText(String(latestMessage?.snippet || ''), 280);
  const subject = summary.subject || getHeader(latestMessage, 'Subject') || '(no subject)';
  const from = summary.from || getHeader(latestMessage, 'From') || '(unknown sender)';
  const date = summary.date || getHeader(latestMessage, 'Date') || '';
  const category = categorizeDigest(summary, latestBody || latestSnippet);
  const summaryText = latestBody || latestSnippet || '(no readable body)';

  return {
    id: summary.id,
    sourceMessageId: summary.sourceMessageId,
    subject,
    from,
    date,
    labels: summary.labels || [],
    providerTags: summary.labels || [],
    messageCount: summary.messageCount || messages.length || 1,
    category,
    summary: summarizeText(summaryText, 320),
    latestBody,
    latestSnippet,
    attentionScore: computeAttentionScore(summary, `${latestBody}\n${latestSnippet}`, promptTerms),
  };
}

function buildFallbackDigest(summary: NativeGmailThreadSummary, promptTerms: string[]): NativeGmailThreadDigest {
  const subject = summary.subject || '(no subject)';
  const from = summary.from || '(unknown sender)';
  const date = summary.date || '';
  const latestSnippet = summarizeText(summary.snippet || '', 160);

  return {
    id: summary.id,
    sourceMessageId: summary.sourceMessageId,
    subject,
    from,
    date,
    labels: summary.labels || [],
    providerTags: summary.labels || [],
    messageCount: summary.messageCount || 1,
    category: categorizeDigest(summary, ''),
    summary: summarizeText(subject, 180),
    latestBody: '',
    latestSnippet,
    attentionScore: computeAttentionScore(summary, latestSnippet, promptTerms),
  };
}

function countByLabel(threads: NativeGmailThreadSummary[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    for (const label of thread.labels || []) {
      if (!label || CATEGORY_LABELS.includes(label)) continue;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 8);
}

function countByCategory(digests: NativeGmailThreadDigest[], fallbackThreads: NativeGmailThreadSummary[]): Array<{ key: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const digest of digests) {
    counts.set(digest.category, (counts.get(digest.category) || 0) + 1);
  }

  const covered = new Set(digests.map((digest) => digest.id));
  for (const thread of fallbackThreads) {
    if (covered.has(thread.id)) continue;
    const fallbackCategory = isLikelyPromotional(thread)
      ? 'promo_social'
      : thread.labels.includes('CATEGORY_UPDATES')
        ? 'updates_tools'
        : 'other';
    counts.set(fallbackCategory, (counts.get(fallbackCategory) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: CATEGORY_LABEL_TITLES[key] || key, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await fn(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function getNativeGmailStatus(_force = false): Promise<NativeGmailStatus> {
  const api = getInboxMailApi()?.gmail;
  if (!api) return fallbackStatus('Connect this workspace before opening mail.');
  return api.getStatus();
}

export function getPrimaryNativeGmailAccount(status: NativeGmailStatus, identity?: string): NativeGmailAccountStatus | undefined {
  const selected = identity ?? status.defaultAccount;
  const candidates = selected ? status.accounts.filter(account => account.id === selected || account.email.toLowerCase() === selected.toLowerCase()) : status.accounts;
  return candidates.length === 1 ? candidates[0] : undefined;
}

function describeCapabilities(account?: NativeGmailAccountStatus): string {
  if (!account) return 'none';
  const parts = [
    account.canRead ? 'read/search' : null,
    account.canDraft ? 'draft' : null,
    account.canSend ? 'send' : null,
    account.canModify ? 'modify' : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

export async function searchNativeGmailThreads(opts: {
  query: string;
  max?: number;
  account?: string;
  page?: string;
  all?: boolean;
  failEmpty?: boolean;
}): Promise<NativeGmailThreadsSearchResult> {
  const api = getInboxMailApi()?.gmail;
  if (!api?.searchThreads) {
    return {
      success: false,
      threads: [],
      exhausted: true,
      error: 'Native Gmail thread search is unavailable in this runtime.',
    };
  }

  const response = await api.searchThreads(opts);
  return {
    success: Boolean(response?.success),
    account: response?.account,
    threads: Array.isArray(response?.threads) ? response.threads : [],
    nextPageToken: response?.nextPageToken || undefined,
    exhausted: Boolean(response?.exhausted ?? !response?.nextPageToken),
    error: response?.error,
  };
}

export async function getNativeGmailThread(opts: { threadId: string; account?: string }): Promise<NativeGmailThreadResult> {
  const api = getInboxMailApi()?.gmail;
  if (!api?.getThread) {
    return { success: false, error: 'Native Gmail thread read is unavailable in this runtime.' };
  }
  const scope = captureInboxMailScope();
  const response = await api.getThread(opts);
  scope.assertCurrent();
  const thread = normalizeNativeGmailThreadShape(response?.thread);
  const hydratedThread = await hydrateNativeGmailThreadParts(thread, response?.account || opts.account);
  scope.assertCurrent();
  return {
    success: Boolean(response?.success),
    account: response?.account,
    thread: hydratedThread,
    error: response?.error,
  };
}

export async function getNativeGmailSendAsAliases(opts?: {
  account?: string;
  force?: boolean;
}): Promise<NativeGmailSendAsResult> {
  const scope = captureInboxMailScope();
  const status = await getNativeGmailStatus();
  scope.assertCurrent();
  const primary = getPrimaryNativeGmailAccount(status, opts?.account);
  if (!primary) {
    return {
      success: false,
      sendAs: [],
      error: status.error || 'No Gmail account is available for send-as lookup.',
    };
  }

  const account = primary.id;
  const cached = sendAsCache.get(account);
  if (!opts?.force && cached && cached.expiresAt > Date.now()) {
    return {
      success: true,
      account,
      sendAs: cached.aliases,
    };
  }

  const api = getInboxMailApi()?.gmail;
  if (!api?.getSendAsAliases) {
    return {
      success: false,
      account,
      sendAs: [],
      error: 'Native Gmail send-as lookup is unavailable in this runtime.',
    };
  }

  const response = await api.getSendAsAliases({ account });
  scope.assertCurrent();
  const aliases = Array.isArray(response?.sendAs) ? response.sendAs : [];
  if (response?.success) {
    sendAsCache.set(account, {
      expiresAt: Date.now() + SEND_AS_CACHE_MS,
      aliases,
    });
  }

  return {
    success: Boolean(response?.success),
    account: response?.account || account,
    sendAs: aliases,
    error: response?.error,
  };
}

export async function modifyNativeGmailThread(payload: {
  threadId: string;
  account?: string;
  add?: string[];
  remove?: string[];
}): Promise<{ success: boolean; account?: string; result?: any; error?: string }> {
  const api = getInboxMailApi()?.gmail;
  if (!api?.modifyThread) {
    return {
      success: false,
      error: 'Native Gmail thread modify is unavailable in this runtime.',
    };
  }

  const response = await api.modifyThread(payload);
  return {
    success: Boolean(response?.success),
    account: response?.account,
    result: response?.result,
    error: response?.error,
  };
}

export async function listNativeGmailLabels(payload?: {
  account?: string;
}): Promise<{ success: boolean; account?: string; labels: NativeGmailLabel[]; error?: string }> {
  const api = getInboxMailApi()?.gmail;
  if (!api?.listLabels) {
    return {
      success: false,
      error: 'Native Gmail label listing is unavailable in this runtime.',
      labels: [],
    };
  }

  const response = await api.listLabels(payload);
  return {
    success: Boolean(response?.success),
    account: response?.account,
    labels: Array.isArray(response?.labels) ? response.labels : [],
    error: response?.error,
  };
}

export async function getNativeGmailInboxStats(payload?: {
  account?: string;
}): Promise<NativeGmailInboxStats> {
  const api = getInboxMailApi()?.gmail;
  if (!api?.getInboxStats) {
    return { success: false, error: 'Native Gmail inbox counts are unavailable in this runtime.' };
  }

  const response = await api.getInboxStats(payload);
  return {
    success: Boolean(response?.success),
    account: response?.account,
    messagesTotal: Number.isFinite(Number(response?.messagesTotal)) ? Number(response.messagesTotal) : undefined,
    messagesUnread: Number.isFinite(Number(response?.messagesUnread)) ? Number(response.messagesUnread) : undefined,
    threadsTotal: Number.isFinite(Number(response?.threadsTotal)) ? Number(response.threadsTotal) : undefined,
    threadsUnread: Number.isFinite(Number(response?.threadsUnread)) ? Number(response.threadsUnread) : undefined,
    error: response?.error,
  };
}

export async function trashNativeGmailThread(payload: {
  threadId: string;
  account?: string;
}): Promise<{ success: boolean; account?: string; result?: any; error?: string }> {
  const api = getInboxMailApi()?.gmail;
  if (!api?.trashThread) {
    return {
      success: false,
      error: 'Native Gmail thread trash is unavailable in this runtime.',
    };
  }

  const response = await api.trashThread(payload);
  return {
    success: Boolean(response?.success),
    account: response?.account,
    result: response?.result,
    error: response?.error,
  };
}

// Summaries may shorten links and prose; the actual reader keeps full plain text.
function extractReaderBodyText(message: NativeGmailMessage): string {
  const plain: string[] = [], html: string[] = [];
  collectTextParts(message.payload, 'text/plain', plain);
  if (plain.length) return plain.join('\n\n');
  collectTextParts(message.payload, 'text/html', html);
  return html.length ? stripHtml(html.join('\n\n')) : message.snippet ?? '';
}

export function describeNativeGmailThread(thread: NativeGmailThread): NativeGmailThreadMessageView[] {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  return messages.map((message) => {
    const attachments: NonNullable<NativeGmailThreadMessageView['attachments']> = [];
    collectMessageAttachments(message.payload, attachments, new Set<string>());
    return {
      id: message.id,
      from: getHeader(message, 'From') || '(unknown sender)',
      to: getHeader(message, 'To'),
      cc: getHeader(message, 'Cc'),
      subject: getHeader(message, 'Subject') || '(no subject)',
      date: getHeader(message, 'Date'),
      bodyText: extractReaderBodyText(message),
      bodyHtml: extractMessageBodyHtml(message) || undefined,
      attachments,
      snippet: summarizeText(String(message.snippet || ''), 400),
      labelIds: Array.isArray(message.labelIds) ? message.labelIds : [],
      internalDate: message.internalDate,
    };
  });
}

export function getDefaultNativeGmailSendAs(aliases: NativeGmailSendAsAlias[]): NativeGmailSendAsAlias | undefined {
  return aliases.find((alias) => alias.isDefault)
    || aliases.find((alias) => alias.isPrimary)
    || aliases[0];
}

export function getDefaultNativeGmailSignatureHtml(aliases: NativeGmailSendAsAlias[]): string {
  return String(getDefaultNativeGmailSendAs(aliases)?.signature || '').trim();
}

export function signatureHtmlToPlainText(signatureHtml?: string): string {
  return stripHtml(String(signatureHtml || ''));
}

export function buildNativeGmailReplyHtml(bodyText: string, signatureHtml?: string): string {
  const bodyHtml = htmlToParagraphs(bodyText);
  const signature = String(signatureHtml || '').trim();
  if (!bodyHtml && !signature) return '';
  return `<div dir="ltr">${bodyHtml}${bodyHtml && signature ? '<div style="height:12px"></div>' : ''}${signature}</div>`;
}

export function buildNativeGmailReplyPlainText(bodyText: string, signatureHtml?: string): string {
  const trimmedBody = normalizeWhitespace(bodyText);
  const signatureText = signatureHtmlToPlainText(signatureHtml);
  if (trimmedBody && signatureText) return `${trimmedBody}\n\n${signatureText}`;
  return trimmedBody || signatureText;
}

export async function crawlNativeGmailThreads(query: string, opts?: {
  account?: string;
  pageSize?: number;
  maxThreads?: number;
}): Promise<{ account: string; threads: NativeGmailThreadSummary[]; truncated: boolean; warning?: string }> {
  const scope = captureInboxMailScope();
  const status = await getNativeGmailStatus();
  scope.assertCurrent();
  const primary = getPrimaryNativeGmailAccount(status, opts?.account);
  if (!primary?.canRead) {
    throw new Error(status.error || 'No readable local Gmail account is available.');
  }

  const account = primary.id;
  const pageSize = Math.max(1, Math.min(100, opts?.pageSize || THREAD_PAGE_SIZE));
  const maxThreads = Math.max(1, Math.min(5_000, opts?.maxThreads || MAX_UNREAD_THREADS));
  const threads: NativeGmailThreadSummary[] = [];
  let page: string | undefined;
  let exhausted = false;
  const seen = new Set<string>();
  let warning: string | undefined;
  const requestSize = Math.min(pageSize, maxThreads);

  while (!exhausted && threads.length < maxThreads) {
    const pageResult = await searchNativeGmailThreads({
      query,
      account,
      page,
      max: requestSize,
    });

    scope.assertCurrent();
    if (!pageResult.success) {
      if (!threads.length) throw new Error(pageResult.error || 'Gmail thread search failed');
      warning = pageResult.error; break;
    }

    warning = pageResult.error ?? warning;
    threads.push(...pageResult.threads);
    page = pageResult.nextPageToken || undefined;
    exhausted = pageResult.exhausted;
    if (!page || seen.has(page) || seen.size >= 250) break;
    seen.add(page);
  }

  return {
    account,
    threads: threads.slice(0, maxThreads),
    truncated: !exhausted || threads.length > maxThreads,
    warning,
  };
}

export async function buildNativeGmailSummaryDigests(query: string, opts?: {
  account?: string;
  maxThreads?: number;
  prompt?: string;
}): Promise<{ account: string; threads: NativeGmailThreadDigest[]; truncated: boolean; warning?: string }> {
  const scope = captureInboxMailScope();
  const { account, threads, truncated, warning } = await crawlNativeGmailThreads(query, {
    account: opts?.account,
    maxThreads: opts?.maxThreads,
  });
  scope.assertCurrent();
  const promptTerms = tokenizePrompt(opts?.prompt || '');
  return {
    account,
    truncated,
    warning,
    threads: threads.map((summary) => buildFallbackDigest(summary, promptTerms)),
  };
}

export async function buildNativeGmailMailboxSnapshot(prompt: string, opts?: {
  query?: string;
  account?: string;
  force?: boolean;
  detailLimit?: number;
}): Promise<NativeGmailMailboxSnapshot> {
  const scope = captureInboxMailScope();
  const query = String(opts?.query || BASE_UNREAD_QUERY).trim() || BASE_UNREAD_QUERY;
  const cacheKey = `${opts?.account || 'default'}::${query}::${prompt.toLowerCase()}`;
  const cached = mailboxCache.get(cacheKey);
  if (!opts?.force && cached && cached.expiresAt > Date.now()) {
    return cached.snapshot;
  }

  const { account, threads, truncated } = await crawlNativeGmailThreads(query, { account: opts?.account });
  scope.assertCurrent();
  const promptTerms = tokenizePrompt(prompt);
  const detailCandidates = [...threads].sort((a, b) => {
    const scoreSummary = (summary: NativeGmailThreadSummary) => {
      const haystack = `${summary.subject || ''}\n${summary.from || ''}`.toLowerCase();
      let score = (summary.labels.includes('IMPORTANT') ? 20 : 0) + (isLikelyPromotional(summary) ? 0 : 8);
      for (const term of promptTerms) {
        if (haystack.includes(term)) score += 12;
      }
      return score;
    };
    const aScore = scoreSummary(a);
    const bScore = scoreSummary(b);
    return bScore - aScore;
  });
  const detailLimit = Math.max(0, Math.min(MAX_DETAIL_THREADS, Number(opts?.detailLimit ?? MAX_DETAIL_THREADS)));
  const detailTarget = Math.min(detailCandidates.length, detailLimit);
  const selectedForDetails = detailCandidates.slice(0, detailTarget);
  const detailedDigests = (await mapConcurrent(selectedForDetails, DETAIL_CONCURRENCY, async (summary) => {
    scope.assertCurrent();
    const threadResult = await getNativeGmailThread({ threadId: summary.id, account });
    scope.assertCurrent();
    if (!threadResult.success || !threadResult.thread) return null;
    return buildDigest(summary, threadResult.thread, promptTerms);
  })).filter((value): value is NativeGmailThreadDigest => Boolean(value));

  const detailedById = new Map(detailedDigests.map((digest) => [digest.id, digest]));
  const digests = detailCandidates.map((summary) => detailedById.get(summary.id) || buildFallbackDigest(summary, promptTerms));
  digests.sort((a, b) => b.attentionScore - a.attentionScore || a.subject.localeCompare(b.subject));

  const snapshot: NativeGmailMailboxSnapshot = {
    account,
    query,
    unreadThreadCount: threads.length,
    fetchedThreadCount: threads.length,
    fetchedDetailCount: detailedDigests.length,
    truncated,
    generatedAt: new Date().toISOString(),
    categories: countByCategory(digests, threads),
    labelCounts: countByLabel(threads),
    threads: digests,
  };

  scope.assertCurrent();
  mailboxCache.set(cacheKey, {
    expiresAt: Date.now() + MAILBOX_CACHE_MS,
    snapshot,
  });

  return snapshot;
}

/** Original digest builder reused for an exact conversation opened outside a folder. */
export function describeNativeGmailLinkedThread(thread: NativeGmailThread): NativeGmailThreadDigest {
  const messages = thread.messages ?? [], latest = [...messages].sort((a,b) => Number(a.internalDate ?? 0)-Number(b.internalDate ?? 0)).at(-1);
  return buildDigest({id:thread.id,sourceMessageId:latest?.id,labels:[...new Set(messages.flatMap(message=>message.labelIds ?? []))],messageCount:messages.length},thread,[]);
}
