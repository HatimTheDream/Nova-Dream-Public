import { emailImageUrl, mapEmailImageCss } from '../../../../../../packages/domain/email-images';
import {inboxReplySource} from '../../inbox-reply-source';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, KeyboardEvent as ReactKeyboardEvent, RefObject, SetStateAction, WheelEvent as ReactWheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { useInboxHost, useInboxWriting } from '../../inbox-host';
import { InboxDeliveryCard } from '../../InboxDeliveryCard';
import {useInboxOutgoingFiles,type InboxOutgoingFiles} from '../../inbox-outgoing-files';
import { inboxActiveCompose, inboxComposeSources, inboxWritingKey } from '../../inbox-writing';
import {
  AlertCircle,
  Archive,
  FileArchive,
  Unsubscribe,
  Unblock,
  Ban,
  Check,
  Clock,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Paperclip,
  AudioLines,
  Edit3,
  Eye,
  File,
  FileCode,
  FileText,
  Film,
  Filter,
  Flag,
  FlagOff,
  Inbox,
  IconParkMail,
  Image as ImageIcon,
  Loader2,
  Mail,
  MailCheck,
  MailOpen,
  ListTree,
  Minus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Pin,
  PinOff,
  Plug,
  Star,
  RefreshCw,
  Reply,
  ReplyAll,
  GripVertical,
  Save,
  Search,
  Send,
  ShieldAlert,
  Tag,
  Trash2,
  Unplug,
  X,
} from '@dreamclaw/components/icons';
import clsx from 'clsx';
import { ImageLightbox } from '@dreamclaw/components/Chat/ChatImage';
import { MailActionCard } from '@dreamclaw/components/Chat/MailActionCard';
import { GlassCard } from '@dreamclaw/components/shared/GlassCard';
import { PageTransition } from '@dreamclaw/components/shared/PageTransition';
import { getInboxMailApi } from '../../inbox-transport';
import lynxInbox from '@dreamclaw/assets/brand/mascot/lynx-inbox.webp';
import {
  buildNativeGmailReplyHtml,
  buildNativeGmailReplyPlainText,
  describeNativeGmailThread,
  getDefaultNativeGmailSendAs,
  getNativeGmailSendAsAliases,
  listNativeGmailLabels,
  getNativeGmailThread,
  type NativeGmailLabel,
  type NativeGmailSendAsAlias,
  type NativeGmailThreadDigest,
} from '@dreamclaw/services/native/gmail';
import {
  completeNativeMicrosoftDeviceAuth,
  describeNativeMicrosoftConversation,
  disconnectNativeMicrosoftAccount,
  getNativeMicrosoftConversation,
  listNativeMicrosoftCategories,
  startNativeMicrosoftDeviceAuth,
  updateNativeMicrosoftSignature,
  type NativeMicrosoftMailCategoryOption,
  type NativeMicrosoftMailDeviceCodeStartResult,
  type NativeMicrosoftMailThreadDigest,
} from '@dreamclaw/services/native/microsoftMail';
import {
  pauseNativeMailIndex,
  syncNativeMailIndex,
} from '@dreamclaw/services/native/mailIndex';
import { formatInboxCoverage, summarizeInboxCoverage } from '@dreamclaw/services/executive/inboxCoverage';
import {
  inboxGroupKey,
  inboxGroupLabel,
  normalizeInboxGrouping,
  normalizeInboxSortOrder,
  sortGroupedInboxThreads,
  type InboxGrouping,
  type InboxSortOrder,
} from '@dreamclaw/services/executive/inboxGrouping';
import { assessMailSafety, type MailSafetyAssessment } from '@dreamclaw/services/executive/mailSafety';
import type { MailActionKind, MailActionPlan } from '@dreamclaw/types/RenderBlock';
import {
  selectInboxThreadAfterRemoval,
  type InboxThreadSelection,
} from '@dreamclaw/services/inbox/selectionAfterMutation';
import { inboxThreadLoadKey } from '@dreamclaw/services/inbox/threadLoadIdentity';
import { createDisplayedMailOpening, mailReadDisplayKey, mailAppearsUnread } from '@dreamclaw/services/inbox/displayedMail';
import {
  clearInboxReaderSession,
  getInboxScrollPosition,
  loadInboxFolder,
  patchInboxReaderSession,
  setInboxFolderError,
  setInboxMicrosoftAccounts,
  setInboxReaderSession,
  setInboxScrollPosition,
  setInboxSelectedThread,
  useInboxSessionStore,
  type InboxAccountSnapshot,
  type InboxThreadMessageView,
} from '@dreamclaw/services/inbox/inboxSession';
import {
  inboxKeyboardScrollAmount,
  normalizeInboxWheelDelta,
  shouldDelegateInboxWheel,
} from '@dreamclaw/services/inbox/scrollOwnership';
import {
  inboxAccountFilterKeys,
  inboxFolderSupportsTriage,
  INBOX_MAIL_FOLDERS,
  normalizeInboxAccountFilter,
  normalizeInboxMailFolder,
  reconcileInboxAccountFilter,
  toggleInboxAccountFilter,
  type InboxMailFolder,
} from '@dreamclaw/services/inbox/mailWorkspace';
import {
  clampInboxPage,
  INBOX_DEFAULT_PAGE_SIZE,
  INBOX_PAGE_SIZES,
  inboxPageRange,
  normalizeInboxCategoryName,
  normalizeInboxPageSize,
} from '@dreamclaw/services/inbox/inboxListControls';
import {
  resolveInboxFilterPanelGeometry,
  type InboxFilterPanelGeometry,
} from '@dreamclaw/services/inbox/inboxFilterPanel';
import {
  formatInboxConversationSummary,
  formatInboxSenderLabel,
} from '@dreamclaw/services/inbox/messagePresentation';
import {
  describeInboxAttachment,
  formatInboxAttachmentSize,
  getInboxAttachmentAvailability,
  summarizeInboxAttachments,
  type InboxAttachmentKind,
} from '@dreamclaw/services/inbox/attachmentPresentation';

type InboxBucket = 'all' | 'safe_review' | 'urgent' | 'needs_reply' | 'waiting' | 'fyi';
type InboxProvider = 'gmail' | 'microsoft';
type InboxDensity = 'compact' | 'comfortable' | 'spacious';
type InboxCategoryFilter = 'all' | 'account_billing_action_required' | 'updates_tools' | 'personal_outreach' | 'calendar_logistics' | 'promo_social' | 'other';

function InboxFolderIcon({ folder, size = 15 }: { folder: InboxMailFolder; size?: number }) {
  switch (folder) {
    case 'sent': return <Send size={size} />;
    case 'drafts': return <FileText size={size} />;
    case 'archive': return <FileArchive size={size} />;
    case 'trash': return <Trash2 size={size} />;
    default: return <Inbox size={size} />;
  }
}

function normalizeInboxBucket(value?: string | null): InboxBucket {
  return value === 'safe_review' || value === 'urgent' || value === 'needs_reply' || value === 'waiting' || value === 'fyi' ? value : 'all';
}

function normalizeInboxDensity(value?: string | null): InboxDensity {
  return value === 'comfortable' || value === 'spacious' ? value : 'compact';
}

function normalizeInboxCategoryFilter(value?: string | null): InboxCategoryFilter {
  return value === 'account_billing_action_required'
    || value === 'updates_tools'
    || value === 'personal_outreach'
    || value === 'calendar_logistics'
    || value === 'promo_social'
    || value === 'other'
    ? value
    : 'all';
}

type ThreadDigestCommon = Pick<
  NativeGmailThreadDigest,
  'id' | 'sourceMessageId' | 'subject' | 'from' | 'date' | 'labels' | 'messageCount' | 'category' | 'summary' | 'latestBody' | 'latestSnippet' | 'attentionScore'
  | 'providerTags'
>;

type ThreadMessageView = InboxThreadMessageView;
type ThreadAttachmentView = NonNullable<ThreadMessageView['attachments']>[number];

type SanitizedEmailRender = {
  html: string;
  referencedAttachmentIds: Set<string>;
  remoteImageCount: number;
};

type AccountSnapshot = InboxAccountSnapshot;

type InboxThreadItem = ThreadDigestCommon & {
  provider: InboxProvider;
  accountKey: string;
  accountId: string;
  accountLabel: string;
  bucket: Exclude<InboxBucket, 'all'>;
  safety: MailSafetyAssessment;
  isPinned: boolean;
  isFlagged: boolean;
};

type NativeTagOption = {
  id: string;
  label: string;
  color?: string;
};

type ReplyRecipients = {
  to: string[];
  cc: string[];
};

const THREADS_PER_PAGE = INBOX_DEFAULT_PAGE_SIZE;
const INBOX_INITIAL_THREADS = THREADS_PER_PAGE;
const MAIL_FOLDER_INITIAL_THREADS = 75;
const MAIL_FOLDER_LOAD_STEP = 100;
const MAIL_FOLDER_MAX_THREADS = 500;
const INBOX_DENSITY_STORAGE_KEY = 'inbox-density';
const INBOX_MAIL_RAIL_WIDTH_STORAGE_KEY = 'inbox-mail-rail-width';
const INBOX_MAIL_RAIL_COLLAPSED_STORAGE_KEY = 'inbox-mail-rail-collapsed';
const INBOX_LIST_WIDTH_STORAGE_KEY = 'inbox-list-width';
const INBOX_PINNED_THREADS_STORAGE_KEY = 'inbox-pinned-threads';
const INBOX_CATEGORY_FILTER_STORAGE_KEY = 'inbox-category-filter';
const INBOX_GROUPING_STORAGE_KEY = 'inbox-grouping';
const INBOX_SORT_STORAGE_KEY = 'inbox-sort';
const INBOX_PAGE_SIZE_STORAGE_KEY = 'inbox-page-size';
const INBOX_LIST_COLLAPSED_STORAGE_KEY = 'inbox-list-collapsed';
const INBOX_FOLDER_STORAGE_KEY = 'inbox-folder';
const DEFAULT_MAIL_RAIL_WIDTH = 224;
const MIN_MAIL_RAIL_WIDTH = 200;
const MAX_MAIL_RAIL_WIDTH = 360;
const DEFAULT_LIST_PANE_WIDTH = 420;
const MIN_LIST_PANE_WIDTH = 300;
const MAX_LIST_PANE_WIDTH = 540;
const COLLAPSED_LIST_PANE_WIDTH = 0;
const EMAIL_SAFE_TAGS = new Set([
  'a', 'article', 'b', 'blockquote', 'body', 'br', 'caption', 'center', 'code', 'col', 'colgroup',
  'div', 'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'img', 'li', 'ol', 'p', 'pre', 'section', 'small', 'span', 'strong', 'sub', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);
const EMAIL_BLOCKED_TAGS = new Set([
  'audio', 'base', 'button', 'embed', 'form', 'iframe', 'input', 'link', 'meta', 'object',
  'script', 'select', 'source', 'svg', 'textarea', 'video',
]);
const EMAIL_ATTR_ALLOWLIST = new Set([
  'align', 'alt', 'aria-label', 'aria-labelledby', 'bgcolor', 'border', 'cellpadding', 'cellspacing',
  'class', 'colspan', 'dir', 'height', 'id', 'lang', 'role', 'rowspan', 'style', 'target',
  'title', 'valign', 'width',
]);
function isPresentObject<T extends object>(value: T | null | undefined): value is T {
  return Boolean(value && typeof value === 'object');
}

function normalizeEmail(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeCopy(value: string): string {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractEmail(value: string): string {
  const input = String(value || '').trim();
  const angleMatch = input.match(/<([^>]+)>/);
  if (angleMatch?.[1]) return normalizeEmail(angleMatch[1]);
  const plainMatch = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return normalizeEmail(plainMatch?.[0] || input);
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildManualSignatureHtml(value?: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return `<div dir="ltr">${escapeHtml(trimmed).replace(/\n/g, '<br>')}</div>`;
}

function parseAddressList(value: string): string[] {
  return String(value || '')
    .split(',')
    .map((part) => extractEmail(part))
    .filter(Boolean);
}

function formatMessageDate(value?: string): string {
  if (!value) return 'Unknown time';
  const normalized = String(value).trim();
  const date = /^\d+$/.test(normalized) ? new Date(Number(normalized)) : new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function ensureReplySubject(subject: string): string {
  const trimmed = String(subject || '').trim();
  if (!trimmed) return 'Re: (no subject)';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function classifyInboxBucket(
  thread: ThreadDigestCommon,
  safety = assessMailSafety(thread),
): Exclude<InboxBucket, 'all'> {
  if (safety.protected) return 'safe_review';
  const corpus = `${thread.subject}\n${thread.summary}\n${thread.latestBody}`.toLowerCase();

  if (
    thread.category === 'account_billing_action_required'
    || thread.labels.includes('IMPORTANT')
    || /\b(action required|required action|today|asap|urgent|deadline|payment|past due|overdue|statement ready)\b/.test(corpus)
    || thread.attentionScore >= 34
  ) {
    return 'urgent';
  }

  if (/\b(waiting on|will update|will let you know|circle back|for your reference|fyi|shared for reference|already sent)\b/.test(corpus)) {
    return 'waiting';
  }

  if (
    thread.category === 'personal_outreach'
    || thread.category === 'calendar_logistics'
    || /\b(reply|respond|confirm|availability|follow up|follow-up|can you|please send|let me know)\b/.test(corpus)
  ) {
    return 'needs_reply';
  }

  return 'fyi';
}

function bucketLabel(bucket: InboxBucket): string {
  switch (bucket) {
    case 'safe_review': return 'Safe review';
    case 'urgent': return 'Urgent';
    case 'needs_reply': return 'Needs reply';
    case 'waiting': return 'Waiting';
    case 'fyi': return 'FYI';
    default: return 'All';
  }
}

function isValidEmailAddress(value: string): boolean {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value);
}

function bucketDescription(bucket: InboxBucket): string {
  switch (bucket) {
    case 'safe_review': return 'Potential payment, sign-in, or sender risk';
    case 'urgent': return 'Needs attention now';
    case 'needs_reply': return 'Requires an outbound reply';
    case 'waiting': return 'Waiting on someone else';
    case 'fyi': return 'Read-only or low urgency';
    default: return 'Show every loaded conversation';
  }
}

function bucketTone(bucket: InboxBucket): string {
  switch (bucket) {
    case 'safe_review': return 'bg-orange-500/10 border-orange-500/25 text-orange-300';
    case 'urgent': return 'bg-red-500/10 border-red-500/20 text-red-300';
    case 'needs_reply': return 'bg-amber-500/10 border-amber-500/20 text-amber-300';
    case 'waiting': return 'bg-sky-500/10 border-sky-500/20 text-sky-300';
    case 'fyi': return 'bg-[rgb(var(--aegis-overlay)/0.04)] border-aegis-border text-aegis-text-dim';
    default: return 'bg-aegis-primary/10 border-aegis-primary/20 text-aegis-primary';
  }
}

function providerTone(provider: InboxProvider): string {
  return provider === 'gmail'
    ? 'border-red-400/20 bg-red-500/10 text-red-200'
    : 'border-sky-400/20 bg-sky-500/10 text-sky-200';
}

function categoryLabel(category: InboxCategoryFilter): string {
  switch (category) {
    case 'account_billing_action_required': return 'Billing / action';
    case 'updates_tools': return 'Updates / tools';
    case 'personal_outreach': return 'Outreach';
    case 'calendar_logistics': return 'Calendar';
    case 'promo_social': return 'Promo / social';
    case 'other': return 'Other';
    default: return 'All categories';
  }
}

function triageCategoryLabel(category: InboxCategoryFilter): string {
  return category === 'all' ? 'All triage' : categoryLabel(category);
}

function categoryTone(category: InboxCategoryFilter): string {
  switch (category) {
    case 'account_billing_action_required': return 'border-red-500/20 bg-red-500/10 text-red-300';
    case 'updates_tools': return 'border-sky-500/20 bg-sky-500/10 text-sky-300';
    case 'personal_outreach': return 'border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-300';
    case 'calendar_logistics': return 'border-cyan-500/20 bg-cyan-500/10 text-cyan-300';
    case 'promo_social': return 'border-zinc-500/20 bg-zinc-500/10 text-zinc-300';
    case 'other': return 'border-aegis-border bg-[rgb(var(--aegis-overlay)/0.04)] text-aegis-text-dim';
    default: return 'border-aegis-border bg-[rgb(var(--aegis-overlay)/0.04)] text-aegis-text-dim';
  }
}

function setLocalDeadline(base: Date, dayOffset: number, hour: number, minute = 0): Date {
  const deadline = new Date(base);
  deadline.setDate(deadline.getDate() + dayOffset);
  deadline.setHours(hour, minute, 0, 0);
  return deadline;
}

function ensureFutureDeadline(candidate: Date, minimumLeadMinutes = 45): Date {
  const minimum = new Date(Date.now() + minimumLeadMinutes * 60_000);
  if (candidate.getTime() > minimum.getTime()) return candidate;
  const next = new Date(minimum);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next;
}

function formatFollowUpDeadline(deadline: Date): string {
  return deadline.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function deriveFollowUpDeadline(thread: InboxThreadItem): Date {
  const now = new Date();
  const threadDate = new Date(thread.date);
  const sourceDate = Number.isNaN(threadDate.getTime()) ? now : threadDate;
  const ageMs = now.getTime() - sourceDate.getTime();
  const isOlderThanDay = ageMs > 24 * 60 * 60 * 1000;

  if (thread.bucket === 'urgent') {
    return ensureFutureDeadline(
      now.getHours() < 16
        ? setLocalDeadline(now, 0, 16, 0)
        : setLocalDeadline(now, 1, 9, 30),
      30,
    );
  }

  if (thread.bucket === 'needs_reply') {
    return ensureFutureDeadline(
      isOlderThanDay || now.getHours() >= 15
        ? setLocalDeadline(now, 1, 10, 0)
        : setLocalDeadline(now, 0, 14, 0),
      60,
    );
  }

  return ensureFutureDeadline(
    setLocalDeadline(now, isOlderThanDay ? 1 : 2, 11, 0),
    120,
  );
}

function toCalendarDateValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function toCalendarTimeValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function buildFollowUpReminderTitle(thread: InboxThreadItem): string {
  const base = String(thread.subject || thread.from || 'Inbox follow-up').trim();
  return `Follow up: ${base.slice(0, 72)}`;
}

function getInboxThreadKey(thread: Pick<InboxThreadItem, 'accountKey' | 'id'>): string {
  return `${thread.accountKey}:${thread.id}`;
}

function formatNativeTagLabel(provider: InboxProvider, value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (provider === 'gmail') {
    const normalized = raw.replace(/^CATEGORY_/, '').replace(/_/g, ' ').toLowerCase();
    return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
  }
  return raw;
}

function buildGmailLabelOptions(labels: NativeGmailLabel[]): NativeTagOption[] {
  const skip = new Set(['CHAT', 'DRAFT', 'INBOX', 'SENT', 'SPAM', 'STARRED', 'TRASH', 'UNREAD']);
  return labels
    .filter((label) => {
      const name = String(label.name || label.id || '').trim();
      if (!name || skip.has(name)) return false;
      if (label.type === 'system') {
        return name === 'IMPORTANT' || name.startsWith('CATEGORY_');
      }
      return true;
    })
    .map((label) => {
      const name = String(label.name || label.id || '').trim();
      return {
        id: label.id,
        label: formatNativeTagLabel('gmail', name),
      } satisfies NativeTagOption;
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function buildMicrosoftCategoryOptions(categories: NativeMicrosoftMailCategoryOption[]): NativeTagOption[] {
  return categories
    .map((category) => ({
      id: category.name,
      label: formatNativeTagLabel('microsoft', category.name),
      color: category.color,
    }))
    .filter((category) => category.id.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function pickThreadPreviewText(thread: ThreadDigestCommon): string {
  const subject = normalizeCopy(thread.subject).toLowerCase();
  const candidates = [thread.summary, thread.latestBody, thread.latestSnippet];
  const sender = normalizeCopy(thread.from).toLowerCase();
  for (const candidate of candidates) {
    const normalized = normalizeCopy(candidate);
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (lower === subject || lower === sender || lower === `${subject} - ${sender}`) continue;
    if (lower.startsWith(`${subject}\n`) || lower.startsWith(`${subject} `)) {
      const trimmed = normalized.slice(thread.subject.length).trim();
      if (trimmed) return trimmed;
      continue;
    }
    return normalized;
  }
  return '';
}

function formatThreadListDate(value?: string): string {
  if (!value) return '';
  const normalized = String(value).trim();
  const date = /^\d+$/.test(normalized) ? new Date(Number(normalized)) : new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
    }).format(date);
  }

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function sanitizeEmailHref(value: string): string | null {
  const href = String(value || '').trim();
  if (!href) return null;
  if (href.startsWith('mailto:')) return href;
  try {
    const parsed = new URL(href);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch {
    return null;
  }
  return null;
}

function normalizeAttachmentContentId(value?: string): string {
  return String(value || '').trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

function InboxAttachmentIcon({ kind }: { kind: InboxAttachmentKind }) {
  switch (kind) {
    case 'archive': return <FileArchive size={17} />;
    case 'audio': return <AudioLines size={17} />;
    case 'code': return <FileCode size={17} />;
    case 'image': return <ImageIcon size={17} />;
    case 'video': return <Film size={17} />;
    case 'document':
    case 'pdf':
    case 'presentation':
    case 'spreadsheet': return <FileText size={17} />;
    default: return <File size={17} />;
  }
}

function attachmentHasData(attachment: ThreadAttachmentView): boolean {
  return Boolean(attachment.dataUrl || attachment.base64);
}

function buildAttachmentDataUrl(attachment: ThreadAttachmentView): string | undefined {
  if (attachment.dataUrl) return attachment.dataUrl;
  if (!attachment.base64 || !attachment.mimeType) return undefined;
  return `data:${attachment.mimeType};base64,${attachment.base64}`;
}

function createInlineAttachmentNode(
  ownerDocument: Document,
  attachment: ThreadAttachmentView | undefined,
  fallbackLabel: string,
  maxHeight?: number,
): HTMLElement {
  const container = ownerDocument.createElement('figure');
  container.setAttribute('data-email-inline-image', 'true');

  const src = attachment ? buildAttachmentDataUrl(attachment) : undefined;
  if (src) {
    const image = ownerDocument.createElement('img');
    image.setAttribute('src', src);
    image.setAttribute('alt', attachment?.name || fallbackLabel || 'Inline image');
    image.setAttribute('loading', 'lazy');
    image.setAttribute('decoding', 'async');
    image.setAttribute('referrerpolicy', 'no-referrer');
    if (maxHeight) { image.style.maxHeight = `${maxHeight}px`; image.style.width = 'auto'; }
    container.appendChild(image);
  } else {
    const placeholder = ownerDocument.createElement('div');
    placeholder.setAttribute('data-email-image', 'true');
    placeholder.textContent = attachment?.name || fallbackLabel || '[Inline image omitted]';
    container.appendChild(placeholder);
  }

  const caption = ownerDocument.createElement('figcaption');
  caption.textContent = attachment?.name || fallbackLabel || 'Inline image';
  container.appendChild(caption);
  return container;
}

function copySafeAttributes(source: HTMLElement, target: HTMLElement): void {
  for (const attribute of Array.from(source.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;

    if (name.startsWith('on')) continue;
    if (name === 'href' || name === 'src' || name === 'srcset') continue;
    if (name.startsWith('data-') || name.startsWith('aria-') || EMAIL_ATTR_ALLOWLIST.has(name)) {
      target.setAttribute(attribute.name, value);
    }
  }
}

function InboxFileCard({attachment,allowExternalContent=true,handleOpenAttachment,handleSaveAttachment,previewAllowed,loading=false,error,onRetry,onRemove}:{
  attachment:ThreadAttachmentView;allowExternalContent?:boolean;
  handleOpenAttachment(attachment:ThreadAttachmentView):unknown;handleSaveAttachment(attachment:ThreadAttachmentView):unknown;
  previewAllowed?:boolean;loading?:boolean;error?:string;onRetry?:()=>void;onRemove?:()=>void;
}) {
  const isImage = attachment.mimeType.startsWith('image/');
  const presentation = describeInboxAttachment(attachment);
  const availability = getInboxAttachmentAvailability({
    allowExternalContent,
    hasData: attachmentHasData(attachment),
    isImage,
    hasImagePreview: previewAllowed ?? Boolean(buildAttachmentDataUrl(attachment)),
  });
  if(loading){availability.canOpen=false;availability.canDownload=false;availability.status='Loading file…';}
  if(error){availability.canOpen=false;availability.canDownload=false;availability.status=error;}
  const attachmentName = attachment.name || 'Untitled attachment';
  const openTitle = availability.canOpen
    ? `${availability.openVerb} ${attachmentName}`
    : `${availability.openVerb} unavailable: ${availability.disabledReason}`;
  const downloadTitle = availability.canDownload
    ? `Download ${attachmentName}`
    : `Download unavailable: ${availability.disabledReason}`;
  return (
    <div
      key={attachment.id}
      data-inbox-attachment-card
      data-attachment-kind={presentation.kind}
      data-attachment-available={availability.canDownload ? 'true' : 'false'}
      className="dc-inbox-attachment-card rounded-xl border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] px-3 py-2.5"
    >
      <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.04)] text-aegis-text-dim">
        <InboxAttachmentIcon kind={presentation.kind} />
      </div>
      <div className="min-w-0 flex-1">
        <div data-inbox-attachment-name className="truncate text-[12px] font-semibold text-aegis-text" title={attachmentName} aria-label={attachmentName}>{attachmentName}</div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-aegis-text-dim">
          <span>{presentation.typeLabel}</span>
          {attachment.size ? <><span aria-hidden="true">·</span><span>{formatInboxAttachmentSize(attachment.size)}</span></> : null}
          {attachment.isInline ? <><span aria-hidden="true">·</span><span>Inline</span></> : null}
        </div>
        {availability.status && (
          <div className="mt-0.5 truncate text-[10px] text-aegis-text-dim" title={availability.disabledReason || availability.status}>
            {availability.status}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1" aria-label={`Actions for ${attachmentName}`}>
    {error && onRetry && <button type="button" onClick={onRetry} aria-label={`Retry ${attachmentName}`} title={`Retry ${attachmentName}`}><RefreshCw size={14}/></button>}
        <button
          type="button"
          onClick={() => void handleOpenAttachment(attachment)}
          disabled={!availability.canOpen}
          aria-label={openTitle}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.04)] text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.08)] disabled:cursor-not-allowed disabled:opacity-40"
          title={openTitle}
        >
          <Eye size={13} />
        </button>
        <button
          type="button"
          onClick={() => void handleSaveAttachment(attachment)}
          disabled={!availability.canDownload}
          aria-label={downloadTitle}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.04)] text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.08)] disabled:cursor-not-allowed disabled:opacity-40"
          title={downloadTitle}
        >
          <Download size={13} />
        </button>
        {onRemove&&<button type="button" onClick={onRemove} aria-label={`Remove ${attachmentName}`} title={`Remove ${attachmentName}`}><X size={14}/></button>}
      </div>
    </div>
  );
}

function outgoingAttachment(model:InboxOutgoingFiles,entry:InboxOutgoingFiles['entries'][number]):ThreadAttachmentView {
  const loaded=model.files[entry.id],file=entry.file;
  return {id:entry.id,name:file.name,mimeType:loaded?.previewMimeType??file.mimeType,size:file.bytes,contentId:file.cid,isInline:file.disposition==='inline'||!!file.cid,...(loaded?{base64:loaded.file.base64}:{}),...(loaded?.previewMimeType?{dataUrl:`data:${loaded.previewMimeType};base64,${loaded.file.base64}`}:{})};
}
function InboxOutgoingFileCards({model,handleOpenAttachment,handleSaveAttachment,disabled=false,label='Message files'}:{model:InboxOutgoingFiles;handleOpenAttachment(attachment:ThreadAttachmentView):unknown;handleSaveAttachment(attachment:ThreadAttachmentView):unknown;disabled?:boolean;label?:string}) {
  const picker=useRef<HTMLInputElement>(null),attachControl=useRef<HTMLButtonElement>(null),[error,setError]=useState('');
  const act=async(run:()=>unknown)=>{setError('');try{await run();}catch(error){setError(error instanceof Error?error.message:'This file selection could not be changed.');}};
  return <section data-inbox-attachments className="dc-inbox-outgoing-files" aria-label={label}>
    <div className="dc-inbox-file-heading"><h3>Files{model.entries.length?` · ${model.entries.length}`:''}</h3><button type="button" ref={attachControl} disabled={disabled} onClick={()=>picker.current?.click()}><Paperclip size={16}/>Attach files</button></div>
    <input hidden type="file" multiple ref={picker} aria-label={`Add files to ${label.toLowerCase()}`} disabled={disabled} onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value='';void act(()=>model.add(files));}}/>
    {error&&<p role="alert">{error}</p>}
    <div className="dc-inbox-attachments-grid">{model.entries.map(entry=><div key={entry.id}>
      <InboxFileCard attachment={outgoingAttachment(model,entry)} handleOpenAttachment={handleOpenAttachment} handleSaveAttachment={handleSaveAttachment}
        previewAllowed={!!model.files[entry.id]?.previewMimeType} loading={!entry.error&&!model.errors[entry.id]&&!model.files[entry.id]}
        error={entry.error||model.errors[entry.id]} onRetry={()=>void act(()=>model.retry(entry.id))} onRemove={!disabled?()=>void act(()=>{model.remove(entry.id);requestAnimationFrame(()=>attachControl.current?.focus());}):undefined}/>
      {!entry.ready&&entry.error&&<label className="dc-inbox-file-reselect">Select the same file<input type="file" disabled={disabled} aria-label={`Select ${entry.file.name} again`} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void act(()=>model.retry(entry.id,file));}}/></label>}
    </div>)}</div>
  </section>;
}

function sanitizeEmailHtml(
  value?: string,
  attachments: ThreadAttachmentView[] = [],
  allowExternalContent = true,
  previewOptions?: { allowInlineContent?: boolean; allowRemoteImages?: boolean; maxInlineImageHeight?: number; removedContentIds?:string[]; remoteImages?: Record<string,string> },
): SanitizedEmailRender {
  const allowInlineContent = previewOptions?.allowInlineContent ?? allowExternalContent;
  const html = String(value || '').trim();
  if (!html || typeof DOMParser === 'undefined') {
    return { html: '', referencedAttachmentIds: new Set<string>(), remoteImageCount: 0 };
  }

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const output = doc.createElement('div');
    const referencedAttachmentIds = new Set<string>();
    const remoteImages = new Set<string>();
    const imageSource = (url: string) => { remoteImages.add(url); return (allowExternalContent || previewOptions?.allowRemoteImages) ? previewOptions?.remoteImages?.[url] : undefined; };
    const attachmentsByContentId = new Map<string, ThreadAttachmentView>();
    for (const attachment of attachments) {
      const normalized = normalizeAttachmentContentId(attachment.contentId);
      if (normalized) attachmentsByContentId.set(normalized, attachment);
    }

    const appendChildren = (source: ParentNode, target: Node) => {
      for (const child of Array.from(source.childNodes)) {
        const sanitized = sanitizeNode(child, doc);
        if (sanitized) target.appendChild(sanitized);
      }
    };

    const sanitizeNode = (node: Node, ownerDocument: Document): Node | null => {
      if (node.nodeType === Node.TEXT_NODE) {
        return ownerDocument.createTextNode(node.textContent || '');
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return null;
      }

      const element = node as HTMLElement;
      const tag = element.tagName.toLowerCase();

      if (EMAIL_BLOCKED_TAGS.has(tag)) {
        return null;
      }

      if (tag === 'style') {
        const style = ownerDocument.createElement('style');
        style.textContent = mapEmailImageCss(element.textContent || '', imageSource);
        return style;
      }

      if (tag === 'img') {
        const src = String(element.getAttribute('src') || '').trim();
        const alt = element.getAttribute('alt')?.trim() || '';

        if (/^cid:/i.test(src)) {
          if(previewOptions?.removedContentIds?.includes(normalizeAttachmentContentId(src.slice(4))))return ownerDocument.createTextNode('');
          const attachment = attachmentsByContentId.get(normalizeAttachmentContentId(src.slice(4)));
          if (attachment?.id) referencedAttachmentIds.add(attachment.id);
          if (!allowInlineContent) {
            const placeholder = ownerDocument.createElement('div');
            placeholder.textContent = alt || attachment?.name || '[Inline image hidden during safe review]';
            placeholder.setAttribute('data-email-image', 'true');
            return placeholder;
          }
          if (!previewOptions?.maxInlineImageHeight && attachment && buildAttachmentDataUrl(attachment)) {
            const image = ownerDocument.createElement('img'); copySafeAttributes(element, image);
            image.src = buildAttachmentDataUrl(attachment)!; image.alt = alt; image.loading = 'eager'; image.decoding = 'async';
            image.setAttribute('referrerpolicy', 'no-referrer'); return image;
          }
          return createInlineAttachmentNode(ownerDocument, attachment, alt || '[Inline image]', previewOptions?.maxInlineImageHeight);
        }

        const inlineImage = ownerDocument.createElement('img');
        copySafeAttributes(element, inlineImage);
        if (element.getAttribute('style')) inlineImage.setAttribute('style', mapEmailImageCss(element.getAttribute('style')!, imageSource));
        inlineImage.setAttribute('alt', alt || 'Inline image');
        inlineImage.setAttribute('loading', 'eager');
        inlineImage.setAttribute('decoding', 'async');
        inlineImage.setAttribute('referrerpolicy', 'no-referrer');

        if (/^data:image\//i.test(src)) {
          inlineImage.setAttribute('src', src);
          inlineImage.setAttribute('data-email-inline-image-raw', 'true');
          return inlineImage;
        }

        const remoteSrc = emailImageUrl(src);
        const invisible = (element.getAttribute('width') === '1' && element.getAttribute('height') === '1') || /display\s*:\s*none/i.test(element.getAttribute('style') || '');
        if (invisible) return ownerDocument.createTextNode('');
        const loaded = remoteSrc && imageSource(remoteSrc);
        if (loaded) {
          inlineImage.setAttribute('src', loaded);
          return inlineImage;
        }

        const placeholder = ownerDocument.createElement('div');
        placeholder.textContent = alt || 'Image';
        placeholder.setAttribute('data-email-image', 'true');
        return placeholder;
      }

      if (!EMAIL_SAFE_TAGS.has(tag)) {
        const fragment = ownerDocument.createDocumentFragment();
        appendChildren(element, fragment);
        return fragment;
      }

      const clean = ownerDocument.createElement(tag);
      copySafeAttributes(element, clean);
      if (element.getAttribute('style')) clean.setAttribute('style', mapEmailImageCss(element.getAttribute('style')!, imageSource));
      const background = emailImageUrl(element.getAttribute('background') || '');
      const loadedBackground = background && imageSource(background);
      if (loadedBackground) clean.style.backgroundImage = `url("${loadedBackground}")`;

      if (tag === 'a') {
        const href = sanitizeEmailHref(element.getAttribute('href') || '');
        if (href && allowExternalContent) {
          clean.setAttribute('href', href);
          clean.setAttribute('target', '_blank');
          clean.setAttribute('rel', 'noreferrer noopener');
        }
      }

      appendChildren(element, clean);
      return clean;
    };

    for (const style of Array.from(doc.head.querySelectorAll('style'))) { const clean = sanitizeNode(style, doc); if (clean) output.appendChild(clean); }
    appendChildren(doc.body, output);
    return {
      html: output.innerHTML.trim(),
      referencedAttachmentIds,
      remoteImageCount: remoteImages.size,
    };
  } catch {
    return { html: '', referencedAttachmentIds: new Set<string>(), remoteImageCount: 0 };
  }
}

const URL_TOKEN_PATTERN = /(https?:\/\/[^\s<]+|mailto:[^\s<]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

function linkifyPlainTextEmail(value: string, allowExternalContent = true): string {
  const input = String(value || '');
  if (!input) return '';

  let cursor = 0;
  let output = '';
  for (const match of input.matchAll(URL_TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    const token = match[0];
    output += escapeHtml(input.slice(cursor, start));

    const href = token.includes('@') && !token.toLowerCase().startsWith('http') && !token.toLowerCase().startsWith('mailto:')
      ? `mailto:${token}`
      : token;
    const safeHref = sanitizeEmailHref(href);
    if (safeHref && allowExternalContent) {
      output += `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noreferrer noopener">${escapeHtml(token)}</a>`;
    } else {
      output += escapeHtml(token);
    }
    cursor = start + token.length;
  }

  output += escapeHtml(input.slice(cursor));
  return output;
}

function buildPlainTextEmailHtml(value: string, allowExternalContent = true): string {
  const raw = String(value || '').replace(/\r/g, '\n').trim();
  if (!raw) return '';

  return raw
    .split(/\n{2,}/)
    .map((block) => {
      const htmlBlock = linkifyPlainTextEmail(block, allowExternalContent).replace(/\n/g, '<br>');
      return `<p>${htmlBlock}</p>`;
    })
    .join('');
}

function buildEmailFrameDocument(html: string, revision: string): string {
  return `<!doctype html>
<html data-email-revision="${revision}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base target="_blank" />
    <style>
      :root { color-scheme: light; }
      html, body {
        margin: 0;
        padding: 0;
        background: transparent;
        color: #111827;
        font: 14px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      }
      body {
        padding: 0;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      body > * {
        max-width: 100%;
      }
      img, table, iframe {
        max-width: 100%;
      }
      img {
        height: auto;
        display: block;
      }
      table {
        border-collapse: collapse;
      }
      td, th {
        max-width: 100%;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      [width] {
        max-width: 100%;
      }
      a {
        color: #2563eb;
      }
      p {
        margin: 0 0 12px 0;
      }
      blockquote {
        margin: 16px 0;
        padding-left: 16px;
        border-left: 3px solid rgba(148, 163, 184, 0.6);
        color: #475569;
      }
      pre, code {
        white-space: pre-wrap;
        word-break: break-word;
      }
    </style>
  </head>
  <body>${html}<style data-dream-claw-email-fit>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { width: 100% !important; max-width: 100% !important; min-width: 0 !important; overflow-x: hidden !important; }
    body > *, table, tbody, thead, tfoot, tr, td, th, div, section, article, p, blockquote, figure {
      max-width: 100%;
      min-width: 0 !important;
    }
    table { table-layout: auto !important; }
    td, th, div, section, article, p, blockquote, figcaption, span, a {
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
    }
    :not(pre):not(code)[style*="white-space"] { white-space: normal !important; }
    img { max-width: 100%; height: auto !important; }
  </style></body>
</html>`;
}

const INBOX_WHEEL_BLOCK_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-inbox-native-scroll="true"]',
].join(',');

const INBOX_KEY_BLOCK_SELECTOR = `${INBOX_WHEEL_BLOCK_SELECTOR},button,a,summary,[role="button"],[role="link"],[role="menuitem"]`;

function eventTargetElement(target: EventTarget | null): HTMLElement | null {
  return target && (target as Node).nodeType === 1 ? target as HTMLElement : null;
}

function elementCanConsumeVerticalScroll(target: HTMLElement | null, deltaY: number, stopAt?: HTMLElement | null): boolean {
  let element = target;
  while (element && element !== stopAt) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (style && /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) {
      if (deltaY < 0 && element.scrollTop > 0) return true;
      if (deltaY > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 1) return true;
    }
    element = element.parentElement;
  }
  return false;
}

function scrollInboxOwner(owner: HTMLDivElement | null, command: number | 'start' | 'end'): void {
  if (!owner) return;
  if (command === 'start') owner.scrollTop = 0;
  else if (command === 'end') owner.scrollTop = owner.scrollHeight;
  else owner.scrollTop += command;
}

function delegatePaneWheel(event: ReactWheelEvent<HTMLElement>, owner: HTMLDivElement | null): void {
  if (!owner || owner.contains(event.target as Node)) return;
  const target = eventTargetElement(event.target);
  if (!shouldDelegateInboxWheel({
    ctrlKey: event.ctrlKey,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    targetBlocksDelegation: Boolean(target?.closest(INBOX_WHEEL_BLOCK_SELECTOR)),
    targetCanConsume: elementCanConsumeVerticalScroll(target, event.deltaY, event.currentTarget),
  })) return;
  scrollInboxOwner(owner, normalizeInboxWheelDelta(event.deltaY, event.deltaMode, owner.clientHeight));
}

function delegatePaneKeyboard(event: ReactKeyboardEvent<HTMLElement>, owner: HTMLDivElement | null): void {
  if (!owner || event.defaultPrevented) return;
  const target = eventTargetElement(event.target);
  if (target?.closest(INBOX_WHEEL_BLOCK_SELECTOR)) return;
  if (event.key === ' ' && event.target !== event.currentTarget) return;
  const command = inboxKeyboardScrollAmount(event.key, event.shiftKey, owner.clientHeight);
  if (command === null) return;
  event.preventDefault();
  scrollInboxOwner(owner, command);
}

function EmailMessageFrame({
  html,
  title,
  scrollOwnerRef,
  onMeasured,
  onPrepared,
}: {
  html: string;
  title: string;
  scrollOwnerRef: RefObject<HTMLDivElement | null>;
  onMeasured?: () => void;
  onPrepared?: (html: string, failed: boolean) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const detachListenersRef = useRef<() => void>(() => undefined);
  const detachMeasurementRef = useRef<() => void>(() => undefined);
  const [height, setHeight] = useState(220);
  const frameDocument = useMemo(() => { const revision = crypto.randomUUID(); return { revision, srcDoc: buildEmailFrameDocument(html, revision) }; }, [html]);
  const { srcDoc } = frameDocument;
  const currentDocument = useRef({ html, revision: frameDocument.revision, onPrepared });
  currentDocument.current = { html, revision: frameDocument.revision, onPrepared };
  const prepareFrame = async () => {
    const doc = frameRef.current?.contentDocument, captured = currentDocument.current;
    if (!doc || doc.documentElement.dataset.emailRevision !== captured.revision) return;
    let failed = false, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const backgrounds = [...new Set([...captured.html.matchAll(/url\(["']?(data:image\/[^"')\s]+)["']?\)/g)].map(match => match[1]))];
      const backgroundImages = backgrounds.map(src => { const image = new Image(); image.src = src; return image; });
      await Promise.race([
        Promise.all([...Array.from(doc.images), ...backgroundImages].map(image => image.decode())).then(() => doc.fonts?.ready),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Image decode timed out')), 12000); }),
      ]);
    } catch { failed = true; } finally { clearTimeout(timer); }
    if (frameRef.current?.contentDocument !== doc || currentDocument.current.revision !== captured.revision) return;
    measure();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (currentDocument.current.revision === captured.revision) currentDocument.current.onPrepared?.(captured.html, failed);
    }));
  };

  const measure = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    const nextHeight = Math.max(
      180,
      Math.ceil(
        Math.max(
          doc.documentElement?.scrollHeight || 0,
          doc.body?.scrollHeight || 0,
        ),
      ) + 4,
    );
    setHeight(nextHeight);
    window.requestAnimationFrame(() => onMeasured?.());
  }, [onMeasured]);

  const attachScrollOwnership = useCallback(() => {
    detachListenersRef.current();
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    const handleWheel = (event: WheelEvent) => {
      const owner = scrollOwnerRef.current;
      const target = eventTargetElement(event.target);
      if (!owner || !shouldDelegateInboxWheel({
        ctrlKey: event.ctrlKey,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        targetBlocksDelegation: Boolean(target?.closest(INBOX_WHEEL_BLOCK_SELECTOR)),
        targetCanConsume: elementCanConsumeVerticalScroll(target, event.deltaY),
      })) return;
      event.preventDefault();
      scrollInboxOwner(owner, normalizeInboxWheelDelta(event.deltaY, event.deltaMode, owner.clientHeight));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const owner = scrollOwnerRef.current;
      const target = eventTargetElement(event.target);
      if (!owner || target?.closest(INBOX_KEY_BLOCK_SELECTOR)) return;
      const command = inboxKeyboardScrollAmount(event.key, event.shiftKey, owner.clientHeight);
      if (command === null || elementCanConsumeVerticalScroll(target, typeof command === 'number' ? command : 1)) return;
      event.preventDefault();
      scrollInboxOwner(owner, command);
    };
    doc.addEventListener('wheel', handleWheel, { passive: false });
    doc.addEventListener('keydown', handleKeyDown);
    detachListenersRef.current = () => {
      doc.removeEventListener('wheel', handleWheel);
      doc.removeEventListener('keydown', handleKeyDown);
    };
  }, [scrollOwnerRef]);

  const attachFrameMeasurement = useCallback(() => {
    detachMeasurementRef.current();
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    let frame = 0;
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    if (doc.documentElement) resizeObserver.observe(doc.documentElement);
    if (doc.body) resizeObserver.observe(doc.body);
    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(doc.body || doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    const images = Array.from(doc.images);
    const fitImage = (image: HTMLImageElement) => {
      if (!image.naturalWidth) return;
      // Do not turn a sender's small thumbnail into a blurry full-width hero.
      // Keep its authored cap as well as the available pane and original pixels.
      const authoredMax = image.style.maxWidth || doc.defaultView?.getComputedStyle(image).maxWidth;
      image.style.setProperty('max-width', `min(100%, ${image.naturalWidth}px${authoredMax && authoredMax !== 'none' ? `, ${authoredMax}` : ''})`, 'important');
    };
    const imageLoaded = (event: Event) => { fitImage(event.currentTarget as HTMLImageElement); scheduleMeasure(); };
    for (const image of images) { fitImage(image); image.addEventListener('load', imageLoaded); }
    detachMeasurementRef.current = () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      for (const image of images) image.removeEventListener('load', imageLoaded);
    };
  }, [measure]);

  useEffect(() => {
    const timers = [
      window.setTimeout(measure, 0),
      window.setTimeout(measure, 120),
      window.setTimeout(measure, 600),
    ];
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [measure, srcDoc]);

  useEffect(() => () => {
    detachListenersRef.current();
    detachMeasurementRef.current();
  }, []);

  return (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={() => {
        measure();
        attachScrollOwnership();
        attachFrameMeasurement();
        void prepareFrame();
      }}
      data-inbox-email-frame
      className="mt-3 w-full overflow-hidden rounded-[18px] border border-black/5 bg-white"
      style={{ height }}
    />
  );
}

function buildThreadItems(snapshots: AccountSnapshot[], pinnedThreadKeys: Set<string>): InboxThreadItem[] {
  return snapshots
    .flatMap(({ provider, account, threads }) => threads.map((thread) => {
      const safety = assessMailSafety(thread);
      return {
        ...thread,
        provider,
        accountKey: account.key,
        accountId: account.accountId,
        accountLabel: account.label,
        bucket: classifyInboxBucket(thread, safety),
        safety,
        isPinned: pinnedThreadKeys.has(`${account.key}:${thread.id}`),
        isFlagged: thread.labels.includes('STARRED') || thread.labels.includes('FLAGGED'),
      };
    }))
    .sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0) || b.attentionScore - a.attentionScore;
    });
}

function formatIndexUpdatedAt(value?: string): string {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return 'Not indexed yet';
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return 'Updated just now';
  if (elapsed < 60 * 60_000) return `Updated ${Math.max(1, Math.round(elapsed / 60_000))}m ago`;
  return `Updated ${new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

function getOwnEmailSet(aliases: NativeGmailSendAsAlias[], accountLabel: string): Set<string> {
  const values = new Set<string>([normalizeEmail(accountLabel)]);
  for (const alias of aliases) {
    const email = normalizeEmail(alias.sendAsEmail || '');
    if (email) values.add(email);
  }
  return values;
}


function buildReplyRecipients(
  sourceMessage: ThreadMessageView | null,
  ownEmails: Set<string>,
  replyAll: boolean,
): ReplyRecipients {
  if (!sourceMessage) return { to: [], cc: [] };

  const to = new Set<string>();
  const cc = new Set<string>();
  const sender = extractEmail(sourceMessage.from);
  if (sender && !ownEmails.has(sender)) to.add(sender);

  if (replyAll) {
    for (const address of parseAddressList(sourceMessage.to)) {
      if (!ownEmails.has(address) && !to.has(address)) cc.add(address);
    }
    for (const address of parseAddressList(sourceMessage.cc)) {
      if (!ownEmails.has(address) && !to.has(address)) cc.add(address);
    }
  }

  return {
    to: [...to],
    cc: [...cc],
  };
}

export function InboxPage() {
  const host = useInboxHost();
  const linkedState = useStore(host.source.store, state => state);
  const linkedEmail = linkedState.scope === host.scopeVersion ? linkedState.value : undefined;
  const composeWriting = useStore(host.writing, state => state.fields);
  const composeSource = inboxActiveCompose(composeWriting);
  const composeSources = useMemo(() => inboxComposeSources(composeWriting), [composeWriting]);
  const deliveryRecords = useStore(host.delivery.store, state => state.records);
  const composeDelivery = deliveryRecords[composeSource];
  const composeIsBusy = useStore(host.delivery.store, state => !!state.busy[composeSource]);
  const composeBusy = composeIsBusy ? composeDelivery?.prepare.mode ?? 'draft' : null;
  const { searchParams, addNotification, addCalendarEvent, calendarSettings, patchPageView } = host;
  const followupBusy=useStore(host.followups.store,state=>state.busy);
  const persistedInboxView = host.view;
  const routeSavedViewId = searchParams.get('view');
  const routeAccountFilter = (() => {
    const routeValue = searchParams.get('account');
    if (typeof routeValue === 'string' && routeValue.trim()) return normalizeInboxAccountFilter(routeValue);
    const saved = persistedInboxView?.layout;
    return normalizeInboxAccountFilter(typeof saved === 'string' ? saved : 'all');
  })();
  const routeBucketFilter = normalizeInboxBucket(searchParams.get('bucket') || persistedInboxView?.ordering);
  const routeCategoryFilter = (() => {
    const routeValue = normalizeInboxCategoryFilter(searchParams.get('category'));
    if (routeValue !== 'all') return routeValue;
    const persisted = normalizeInboxCategoryFilter(persistedInboxView?.grouping);
    if (persisted !== 'all') return persisted;
    if (typeof window === 'undefined') return 'all';
    const stored = host.preferences.getItem(INBOX_CATEGORY_FILTER_STORAGE_KEY);
    return normalizeInboxCategoryFilter(stored);
  })();
  const routeSearch = searchParams.get('search') ?? persistedInboxView?.search ?? '';
  const routeFolder = (() => {
    const value = searchParams.get('folder');
    if (value) return normalizeInboxMailFolder(value);
    if (typeof window === 'undefined') return 'inbox' as InboxMailFolder;
    return normalizeInboxMailFolder(host.preferences.getItem(INBOX_FOLDER_STORAGE_KEY));
  })();
  const routeDensity = (() => {
    const routeValue = normalizeInboxDensity(searchParams.get('density'));
    if (searchParams.get('density')) return routeValue;
    if (persistedInboxView?.density) return normalizeInboxDensity(persistedInboxView.density);
    if (typeof window === 'undefined') return 'compact';
    const stored = host.preferences.getItem(INBOX_DENSITY_STORAGE_KEY);
    return normalizeInboxDensity(stored);
  })();
  const routeGrouping = (() => {
    const routeValue = searchParams.get('group');
    if (routeValue) return normalizeInboxGrouping(routeValue);
    if (typeof window === 'undefined') return 'topic' as InboxGrouping;
    return normalizeInboxGrouping(host.preferences.getItem(INBOX_GROUPING_STORAGE_KEY));
  })();
  const routeSortOrder = (() => {
    const routeValue = searchParams.get('sort');
    if (routeValue) return normalizeInboxSortOrder(routeValue);
    if (typeof window === 'undefined') return 'newest' as InboxSortOrder;
    return normalizeInboxSortOrder(host.preferences.getItem(INBOX_SORT_STORAGE_KEY));
  })();

  const [activeFolder, setActiveFolder] = useState<InboxMailFolder>(() => routeFolder);
  const folderSession = useInboxSessionStore((state) => state.folders[activeFolder]);
  const gmailAccounts = useInboxSessionStore((state) => state.gmailAccounts);
  const microsoftAccounts = useInboxSessionStore((state) => state.microsoftAccounts);
  const microsoftClientConfigured = useInboxSessionStore((state) => state.microsoftClientConfigured);
  const snapshots = folderSession.snapshots;
  const loading = folderSession.loading;
  const refreshing = folderSession.refreshing;
  const mailBusy = loading || refreshing;
  const error = folderSession.error;
  const selectedThread = linkedState.target ? linkedEmail ? { provider: linkedEmail.account.provider, accountKey: linkedEmail.account.key, threadId: linkedEmail.digest.id } : null : folderSession.selectedThread;
  const readerSession = linkedEmail?.reader ?? folderSession.reader;
  const setSelectedThread: Dispatch<SetStateAction<InboxThreadSelection | null>> = useCallback(
    (update) => { if (host.source.store.getState().target && !host.source.close()) return; setInboxSelectedThread(activeFolder, update); },
    [activeFolder, host.source],
  );
  const [indexControlBusy, setIndexControlBusy] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState<string>(() => routeAccountFilter);
  const [bucketFilter, setBucketFilter] = useState<InboxBucket>(() => routeBucketFilter);
  const [categoryFilter, setCategoryFilter] = useState<InboxCategoryFilter>(() => routeCategoryFilter);
  const [search, setSearch] = useState(() => routeSearch);
  const [density, setDensity] = useState<InboxDensity>(() => routeDensity);
  const [grouping, setGrouping] = useState<InboxGrouping>(() => routeGrouping);
  const [sortOrder, setSortOrder] = useState<InboxSortOrder>(() => routeSortOrder);
  const [mailRailWidth, setMailRailWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_MAIL_RAIL_WIDTH;
    const raw = host.preferences.getItem(INBOX_MAIL_RAIL_WIDTH_STORAGE_KEY);
    const stored = raw === null ? DEFAULT_MAIL_RAIL_WIDTH : Number(raw);
    if (!Number.isFinite(stored)) return DEFAULT_MAIL_RAIL_WIDTH;
    return Math.min(MAX_MAIL_RAIL_WIDTH, Math.max(MIN_MAIL_RAIL_WIDTH, stored));
  });
  const [isMailRailCollapsed, setIsMailRailCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return host.preferences.getItem(INBOX_MAIL_RAIL_COLLAPSED_STORAGE_KEY) === '1';
  });
  const [isCompactMailLayout, setIsCompactMailLayout] = useState<boolean>(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1180px)').matches
  ));
  const [listPaneWidth, setListPaneWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_LIST_PANE_WIDTH;
    const raw = host.preferences.getItem(INBOX_LIST_WIDTH_STORAGE_KEY);
    const stored = raw === null ? DEFAULT_LIST_PANE_WIDTH : Number(raw);
    if (!Number.isFinite(stored)) return DEFAULT_LIST_PANE_WIDTH;
    return Math.min(MAX_LIST_PANE_WIDTH, Math.max(MIN_LIST_PANE_WIDTH, stored));
  });
  const [isListPaneCollapsed, setIsListPaneCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return host.preferences.getItem(INBOX_LIST_COLLAPSED_STORAGE_KEY) === '1';
  });
  const [pinnedThreadKeys, setPinnedThreadKeys] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const parsed = JSON.parse(host.preferences.getItem(INBOX_PINNED_THREADS_STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : [];
    } catch {
      return [];
    }
  });
  const [threadPage, setThreadPage] = useState(1);
  const [threadPageDraft, setThreadPageDraft] = useState('1');
  const [threadsPerPage, setThreadsPerPage] = useState<number>(() => {
    if (typeof window === 'undefined') return THREADS_PER_PAGE;
    return normalizeInboxPageSize(host.preferences.getItem(INBOX_PAGE_SIZE_STORAGE_KEY));
  });
  const [mailFolderThreadLimit, setMailFolderThreadLimit] = useState(MAIL_FOLDER_INITIAL_THREADS);
  const [selectedThreadKeys, setSelectedThreadKeys] = useState<string[]>([]);
  const [suppressedThreadKeys, setSuppressedThreadKeys] = useState<string[]>([]);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showNativeTagMenu, setShowNativeTagMenu] = useState(false);
  const [showInboxOptions, setShowInboxOptions] = useState(false);
  const [inboxOptionsGeometry, setInboxOptionsGeometry] = useState<InboxFilterPanelGeometry | null>(null);
  const [showAccountPicker, setShowAccountPicker] = useState(false);
  const [isMailRailOpen, setIsMailRailOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeAccountKey, setComposeAccountKey] = useInboxWriting<string>(composeSource, 'composeAccountKey', '');
  const [composeTo, setComposeTo] = useInboxWriting<string>(composeSource, 'composeTo', '');
  const [composeCc, setComposeCc] = useInboxWriting<string>(composeSource, 'composeCc', '');
  const [composeBcc, setComposeBcc] = useInboxWriting<string>(composeSource, 'composeBcc', '');
  const [composeSubject, setComposeSubject] = useInboxWriting<string>(composeSource, 'composeSubject', '');
  const [composeBody, setComposeBody] = useInboxWriting<string>(composeSource, 'composeBody', '');
  const [composeShowCopyFields, setComposeShowCopyFields] = useInboxWriting<boolean>(composeSource, 'composeShowCopyFields', false);
  const [composeIncludeSignature, setComposeIncludeSignature] = useInboxWriting<boolean>(composeSource, 'composeIncludeSignature', true);
  const [composeAliasState, setComposeAliasState] = useState<{source:string;accountKey:string;items:NativeGmailSendAsAlias[]}>();
  const composeAliasesReady = composeAliasState?.source === composeSource && composeAliasState.accountKey === composeAccountKey;
  const composeAliases = composeAliasesReady ? composeAliasState.items : [];
  const [composeFrom, setComposeFrom] = useInboxWriting<string>(composeSource, 'composeFrom', '');
  const [composeKeepFormatting, setComposeKeepFormatting] = useInboxWriting<boolean>(composeSource, 'composeKeepFormatting', false);
  const composeScrollRef = useRef<HTMLDivElement>(null);
  const composeImported = composeWriting[inboxWritingKey(composeSource, 'composeImportedOperation')];
  const composeOpening = !!composeDelivery?.opening && !composeImported;
  const composeFileReview = composeDelivery?.base?.review ?? composeDelivery?.review;
  const composeSavedMessage = composeFileReview?.message;
  const composeFiles=useInboxOutgoingFiles(host.files,composeSource,composeFileReview,composeOpen,host.scopeVersion);
  const composeAttachments=composeFiles.entries.map(entry=>outgoingAttachment(composeFiles,entry));
  const composeInlineAttachments=composeAttachments.filter((attachment,index)=>!!composeFiles.files[composeFiles.entries[index].id]?.previewMimeType&&!!attachment.contentId&&composeAttachments.filter(other=>normalizeAttachmentContentId(other.contentId)===normalizeAttachmentContentId(attachment.contentId)).length===1);
  useEffect(() => {
    const record = deliveryRecords[composeSource], review = record?.review;
    if (!record?.opening || review?.state !== 'saved' || composeImported) return;
    try {
      host.writing.getState().importDraft(composeSource,review.id,{
        composeAccountKey:`${review.provider === 'google' ? 'gmail' : 'microsoft'}:${review.accountId}`,
        composeTo:review.message.to.join(', '),composeCc:review.message.cc.join(', '),composeBcc:review.message.bcc.join(', '),
        composeSubject:review.message.subject,composeBody:review.message.bodyText,composeFrom:review.message.from,
        composeShowCopyFields:!!(review.message.cc.length||review.message.bcc.length),composeIncludeSignature:false,
        composeKeepFormatting:!!review.message.bodyHtml,
      });
    } catch (error) { setComposeErrors(current=>({...current,[composeSource]:error instanceof Error?error.message:'The opened draft stays in its saved review.'})); }
  }, [host.writing, composeSource, deliveryRecords, composeImported]);
  const [composeErrors, setComposeErrors] = useState<Record<string, string | null>>({});
  const composeError = composeErrors[composeSource];
  const setComposeError = useCallback((value:string|null) => setComposeErrors(current => ({...current, [composeSource]:value})), [composeSource]);
  const [compactReaderOpen, setCompactReaderOpen] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);
  const [mutatingThread, setMutatingThread] = useState(false);
  const reviewHistoryRef=useRef<HTMLDetailsElement>(null);
  const [reviewHistoryOpen,setReviewHistoryOpen]=useState(false);
  useEffect(()=>{
    if(!reviewHistoryOpen)return;
    const close=(event:PointerEvent)=>{if(!reviewHistoryRef.current?.contains(event.target as Node)&&reviewHistoryRef.current)reviewHistoryRef.current.open=false;};
    document.addEventListener('pointerdown',close,true);return()=>document.removeEventListener('pointerdown',close,true);
  },[reviewHistoryOpen]);
  const triageState = useStore(host.triage.store, state => state);
  const [pendingReadDisplays,setPendingReadDisplays]=useState<Record<string,string>>({});
  const showsUnread=(thread:InboxThreadItem)=>mailAppearsUnread(host.scopeVersion,thread,pendingReadDisplays);
  const pendingMailAction = useStore(host.triage.store, state => Object.values(state.records).find(record => record.plan?.id === state.openId)?.plan ?? null);
  const setPendingMailAction = (plan:MailActionPlan|null) => host.triage.open(plan?.id);
  useEffect(() => {
    if (!pendingMailAction) return;
    const previous=document.activeElement as HTMLElement|null;
    const dialog=host.portal.querySelector<HTMLElement>('[aria-label="Review email action"]');
    if (!dialog) return;
    const controls=()=>Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a[href], [tabindex="0"]')).filter(element=>element.getClientRects().length>0);
    controls()[0]?.focus();
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();host.triage.open();}
      if(event.key==='Tab'){
        const items=controls(),first=items[0],last=items.at(-1);
        if(!dialog.contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first)?.focus();}
        else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',onKey,true);
    return ()=>{document.removeEventListener('keydown',onKey,true);if(previous?.isConnected&&previous.getClientRects().length)previous.focus();else reviewHistoryRef.current?.querySelector('summary')?.focus();};
  }, [pendingMailAction?.id, host.portal, host.triage]);
  const [senderActionState, setSenderActionState] = useState<{
    loading: boolean;
    sender?: string;
    blocked?: boolean;
    canManage?: boolean;
    error?: string;
  }>({ loading: false });
  const [pendingMicrosoftAuth, setPendingMicrosoftAuth] = useState<NativeMicrosoftMailDeviceCodeStartResult | null>(null);
  const [microsoftAuthBusy, setMicrosoftAuthBusy] = useState(false);
  const [microsoftAuthError, setMicrosoftAuthError] = useState<string | null>(null);
  const [disconnectingAccountKey, setDisconnectingAccountKey] = useState<string | null>(null);
  const [savingMicrosoftSignature, setSavingMicrosoftSignature] = useState(false);
  const [gmailLabelOptionsByAccount, setGmailLabelOptionsByAccount] = useState<Record<string, NativeTagOption[]>>({});
  const [microsoftCategoryOptionsByAccount, setMicrosoftCategoryOptionsByAccount] = useState<Record<string, NativeTagOption[]>>({});
  const [nativeTagOptionsLoading, setNativeTagOptionsLoading] = useState(false);
  const [nativeTagOptionsError, setNativeTagOptionsError] = useState<string | null>(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [previewAttachment, setPreviewAttachment] = useState<{ src: string; alt: string } | null>(null);
  useEffect(()=>setPreviewAttachment(null),[composeFiles.key]);
  const threadListRef = useRef<HTMLDivElement | null>(null);
  const readingPaneRef = useRef<HTMLDivElement | null>(null);
  const splitPaneRef = useRef<HTMLDivElement | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const nativeTagMenuRef = useRef<HTMLDivElement | null>(null);
  const inboxOptionsPanelRef = useRef<HTMLDivElement | null>(null);
  const inboxOptionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const accountPickerRef = useRef<HTMLDivElement | null>(null);
  const accountPickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const composeDialogRef = useRef<HTMLDivElement | null>(null);
  const composeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mailRailRef = useRef<HTMLElement | null>(null);
  const mailRailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const selectPageCheckboxRef = useRef<HTMLInputElement | null>(null);
  const mailRailResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const isResizingSplitRef = useRef(false);
  const listPaneWidthBeforeCollapseRef = useRef(listPaneWidth);
  const senderStateRequestRef = useRef(0);

  const loadInbox = useCallback(async (force = false) => {
    await loadInboxFolder(activeFolder, {
      force,
      maxThreads: activeFolder === 'inbox'
        ? (force ? 120 : INBOX_INITIAL_THREADS)
        : mailFolderThreadLimit,
    });
    const state = useInboxSessionStore.getState();
    const accountKeys = [
      ...state.gmailAccounts.map((account) => `gmail:${account.id}`),
      ...state.microsoftAccounts.map((account) => `microsoft:${account.id}`),
    ];
    setAccountFilter((current) => reconcileInboxAccountFilter(current, accountKeys));
  }, [activeFolder, mailFolderThreadLimit, host.scopeVersion]);

  useEffect(() => {
    void loadInbox();
  }, [loadInbox]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    host.preferences.setItem(INBOX_DENSITY_STORAGE_KEY, density);
  }, [density]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    host.preferences.setItem(INBOX_CATEGORY_FILTER_STORAGE_KEY, categoryFilter);
  }, [categoryFilter]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    host.preferences.setItem(INBOX_GROUPING_STORAGE_KEY, grouping);
  }, [grouping]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    host.preferences.setItem(INBOX_SORT_STORAGE_KEY, sortOrder);
  }, [sortOrder]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    host.preferences.setItem(INBOX_PAGE_SIZE_STORAGE_KEY, String(threadsPerPage));
  }, [threadsPerPage]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    host.preferences.setItem(INBOX_FOLDER_STORAGE_KEY, activeFolder);
    setSelectedThreadKeys([]);
    setSuppressedThreadKeys([]);
    setThreadPage(1);
    setCompactReaderOpen(false);
    setIsMailRailOpen(false);
    setMailFolderThreadLimit(MAIL_FOLDER_INITIAL_THREADS);
    if (!inboxFolderSupportsTriage(activeFolder)) {
      setBucketFilter('all');
      setCategoryFilter('all');
    }
  }, [activeFolder]);

  useEffect(() => {
    patchPageView('inbox', { activeSavedViewId: routeSavedViewId || null });
  }, [patchPageView, routeSavedViewId]);

  useEffect(() => {
    setAccountFilter((current) => current === routeAccountFilter ? current : routeAccountFilter);
  }, [routeAccountFilter]);

  useEffect(() => {
    setBucketFilter((current) => current === routeBucketFilter ? current : routeBucketFilter);
  }, [routeBucketFilter]);

  useEffect(() => {
    setCategoryFilter((current) => current === routeCategoryFilter ? current : routeCategoryFilter);
  }, [routeCategoryFilter]);

  useEffect(() => {
    setSearch((current) => current === routeSearch ? current : routeSearch);
  }, [routeSearch]);

  useEffect(() => {
    setActiveFolder((current) => current === routeFolder ? current : routeFolder);
  }, [routeFolder]);

  useEffect(() => {
    setDensity((current) => current === routeDensity ? current : routeDensity);
  }, [routeDensity]);

  useEffect(() => {
    patchPageView('inbox', {
      layout: accountFilter,
      ordering: bucketFilter,
      grouping,
      density: density === 'compact' ? 'compact' : 'comfortable',
      search,
      filter: bucketFilter,
    });
  }, [accountFilter, bucketFilter, density, grouping, patchPageView, search]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    host.preferences.setItem(INBOX_MAIL_RAIL_WIDTH_STORAGE_KEY, String(mailRailWidth));
  }, [mailRailWidth]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    host.preferences.setItem(INBOX_MAIL_RAIL_COLLAPSED_STORAGE_KEY, isMailRailCollapsed ? '1' : '0');
  }, [isMailRailCollapsed]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1180px)');
    const sync = () => {
      setIsCompactMailLayout(query.matches);
      if (!query.matches) setIsMailRailOpen(false);
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resize = mailRailResizeRef.current;
      if (!resize) return;
      const nextWidth = Math.min(
        MAX_MAIL_RAIL_WIDTH,
        Math.max(MIN_MAIL_RAIL_WIDTH, resize.startWidth + (event.clientX - resize.startX)),
      );
      setMailRailWidth(nextWidth);
    };
    const handlePointerUp = () => {
      if (!mailRailResizeRef.current) return;
      mailRailResizeRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    host.preferences.setItem(INBOX_LIST_WIDTH_STORAGE_KEY, String(listPaneWidth));
  }, [listPaneWidth]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    host.preferences.setItem(INBOX_PINNED_THREADS_STORAGE_KEY, JSON.stringify(pinnedThreadKeys));
  }, [pinnedThreadKeys]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    host.preferences.setItem(INBOX_LIST_COLLAPSED_STORAGE_KEY, isListPaneCollapsed ? '1' : '0');
  }, [isListPaneCollapsed]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isResizingSplitRef.current || !splitPaneRef.current) return;
      const rect = splitPaneRef.current.getBoundingClientRect();
      const nextWidth = Math.min(
        MAX_LIST_PANE_WIDTH,
        Math.max(MIN_LIST_PANE_WIDTH, event.clientX - rect.left),
      );
      setIsListPaneCollapsed(false);
      setListPaneWidth(nextWidth);
      listPaneWidthBeforeCollapseRef.current = nextWidth;
    };

    const handleMouseUp = () => {
      if (!isResizingSplitRef.current) return;
      isResizingSplitRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!showActionMenu) return;
      if (actionMenuRef.current?.contains(event.target as Node)) return;
      setShowActionMenu(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [showActionMenu]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!showNativeTagMenu) return;
      if (nativeTagMenuRef.current?.contains(event.target as Node)) return;
      setShowNativeTagMenu(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [showNativeTagMenu]);

  useLayoutEffect(() => {
    if (!showInboxOptions) {
      setInboxOptionsGeometry(null);
      return;
    }
    const trigger = inboxOptionsTriggerRef.current;
    if (!trigger) return;
    const listPane = trigger.closest<HTMLElement>('[data-inbox-list-pane]');
    const updateGeometry = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const listPaneWidth = listPane?.getBoundingClientRect().width || 360;
      const titleBarBottom = document.querySelector<HTMLElement>('.dc-titlebar')?.getBoundingClientRect().bottom || 0;
      setInboxOptionsGeometry(resolveInboxFilterPanelGeometry(
        { top: triggerRect.top, right: triggerRect.right, bottom: triggerRect.bottom },
        { width: window.innerWidth, height: window.innerHeight, topInset: titleBarBottom },
        Math.min(360, Math.max(260, listPaneWidth - 24)),
      ));
    };
    updateGeometry();
    const resizeObserver = new ResizeObserver(updateGeometry);
    resizeObserver.observe(trigger);
    if (listPane) resizeObserver.observe(listPane);
    window.addEventListener('resize', updateGeometry);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateGeometry);
    };
  }, [compactReaderOpen, isListPaneCollapsed, listPaneWidth, showInboxOptions]);

  useEffect(() => {
    if (!showInboxOptions) return;
    const focusFrame = window.requestAnimationFrame(() => {
      inboxOptionsPanelRef.current?.querySelector<HTMLElement>('select, button:not([aria-haspopup])')?.focus();
    });
    const close = (restoreFocus = false) => {
      setShowInboxOptions(false);
      if (restoreFocus) window.requestAnimationFrame(() => inboxOptionsTriggerRef.current?.focus());
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (inboxOptionsPanelRef.current?.contains(target) || inboxOptionsTriggerRef.current?.contains(target)) return;
      close(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(inboxOptionsPanelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])') || []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showInboxOptions]);

  useEffect(() => {
    if (!isMailRailOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      mailRailRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (showAccountPicker) return;
        event.preventDefault();
        setIsMailRailOpen(false);
        window.requestAnimationFrame(() => mailRailTriggerRef.current?.focus());
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(mailRailRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])') || []);
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMailRailOpen, showAccountPicker]);

  const availableAccounts = useMemo(() => ([
    ...gmailAccounts.filter(isPresentObject).map((account) => ({
      provider: 'gmail' as const,
      key: `gmail:${account.id}`,
      accountId: account.id,
      generation: account.generation,
      email: account.email,
      label: account.email,
      signatureText: '',
      canRead: account.canRead,
      canSend: account.canSend,
      canDraft: account.canDraft,
      canModify: account.canModify,
      supportsSignature: true,
    })),
    ...microsoftAccounts.filter(isPresentObject).map((account) => ({
      provider: 'microsoft' as const,
      key: `microsoft:${account.id}`,
      accountId: account.id,
      generation: account.generation,
      email: account.email,
      label: account.displayName ? `${account.displayName} <${account.email}>` : account.email,
      signatureText: account.signatureText || '',
      canRead: account.canRead,
      canSend: account.canSend,
      canDraft: account.canDraft,
      canModify: account.canModify,
      supportsSignature: true,
    })),
  ]).filter(isPresentObject), [gmailAccounts, microsoftAccounts]);

  useEffect(() => { void host.source.load(availableAccounts, host.scopeVersion); }, [availableAccounts, host.source, host.scopeVersion, linkedState.target?.nonce]);
  useEffect(() => { if (linkedState.target) { setComposeOpen(false); setIsMailRailOpen(false); setShowActionMenu(false); setCompactReaderOpen(true); } }, [linkedState.target?.nonce]);

  const accountByKey = useMemo(
    () => new Map(availableAccounts.map((account) => [account.key, account])),
    [availableAccounts],
  );
  const availableAccountKeys = useMemo(
    () => availableAccounts.map((account) => account.key),
    [availableAccounts],
  );
  const explicitSelectedAccountKeys = useMemo(
    () => inboxAccountFilterKeys(accountFilter),
    [accountFilter],
  );
  const selectedAccountKeySet = useMemo(
    () => new Set(accountFilter === 'all' ? availableAccountKeys : explicitSelectedAccountKeys),
    [accountFilter, availableAccountKeys, explicitSelectedAccountKeys],
  );
  const selectedAccountCount = accountFilter === 'all'
    ? availableAccounts.length
    : selectedAccountKeySet.size;
  const accountPickerLabel = availableAccounts.length === 0
    ? 'No inboxes connected'
    : accountFilter === 'all'
      ? 'All inboxes'
      : selectedAccountCount === 1
        ? availableAccounts.find((account) => selectedAccountKeySet.has(account.key))?.email || '1 inbox'
        : `${selectedAccountCount} of ${availableAccounts.length} inboxes`;
  const activeInboxFilterCount = Number(accountFilter !== 'all')
    + Number(bucketFilter !== 'all')
    + Number(categoryFilter !== 'all');

  useEffect(() => {
    if (availableAccountKeys.length === 0) return;
    setAccountFilter((current) => reconcileInboxAccountFilter(current, availableAccountKeys));
  }, [availableAccountKeys]);

  useEffect(() => {
    if (!showAccountPicker) return;
    const focusFrame = window.requestAnimationFrame(() => {
      accountPickerRef.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus();
    });
    const close = (restoreFocus: boolean) => {
      setShowAccountPicker(false);
      if (restoreFocus) window.requestAnimationFrame(() => accountPickerTriggerRef.current?.focus());
    };
    const handlePointerDown = (event: MouseEvent) => {
      if (!accountPickerRef.current?.contains(event.target as Node)) close(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showAccountPicker]);

  const activeFolderDefinition = INBOX_MAIL_FOLDERS.find((folder) => folder.id === activeFolder) || INBOX_MAIL_FOLDERS[0];
  const composeSelectedAccount = accountByKey.get(composeAccountKey) || null;
  const composeSelectedAlias = composeAliases.find((alias) => alias.sendAsEmail === composeFrom)
    || getDefaultNativeGmailSendAs(composeAliases);

  const closeCompose = useCallback((restoreFocus = true) => {
    setComposeOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => composeTriggerRef.current?.focus());
  }, []);

  const switchCompose = (source?: string) => {
    try {
      if (source) host.writing.getState().selectMessage(source);
      else host.writing.getState().newMessage(composeAccountKey || availableAccounts.find(account => account.canDraft || account.canSend)?.key || '');
      setComposeError(null);
      window.requestAnimationFrame(() => composeDialogRef.current?.querySelector<HTMLElement>('#compose-mail-to')?.focus());
    } catch (error) { setComposeError(error instanceof Error ? error.message : 'Your current writing stays open.'); }
  };

  const openCompose = useCallback(() => {
    const preferred = availableAccounts.find((account) => selectedAccountKeySet.has(account.key) && (account.canSend || account.canDraft))
      || availableAccounts.find((account) => account.canSend || account.canDraft);
    if (!composeAccountKey) setComposeAccountKey(preferred?.key || availableAccounts[0]?.key || '');
    setComposeError(null);
    setComposeOpen(true);
    setShowAccountPicker(false);
    setIsMailRailOpen(false);
  }, [availableAccounts, selectedAccountKeySet, composeAccountKey, setComposeAccountKey, setComposeError]);

  useEffect(() => {
    if (!composeOpen || !composeSelectedAccount) return;
    let cancelled = false;
    setComposeError(null);
    if (composeSelectedAccount.provider === 'gmail') {
      void getNativeGmailSendAsAliases({ account: composeSelectedAccount.accountId }).then((result) => {
        if (cancelled) return;
        const aliases = result.success ? result.sendAs : [];
        setComposeAliasState({source:composeSource,accountKey:composeAccountKey,items:aliases});
        setComposeFrom(current => composeDelivery?.review?.openedDraft ? current || composeDelivery.review.message.from : aliases.some(alias => alias.sendAsEmail === current) || current === composeSelectedAccount.email ? current : getDefaultNativeGmailSendAs(aliases)?.sendAsEmail || composeSelectedAccount.email);
      });
    } else {
      setComposeAliasState({source:composeSource,accountKey:composeAccountKey,items:[]});
      setComposeFrom(current => composeDelivery?.review?.openedDraft ? current || composeDelivery.review.message.from : composeSelectedAccount.email);
    }
    return () => { cancelled = true; };
  }, [composeOpen, composeSelectedAccount, composeSource, composeAccountKey, setComposeFrom, setComposeError, composeDelivery?.review?.openedDraft?.messageId]);

  useEffect(() => {
    if (!composeOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      const dialog=composeDialogRef.current;
      (dialog?.querySelector<HTMLElement>('#compose-mail-to:not(:disabled)') ?? dialog?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      // The original native image dialog owns its modal keyboard interaction.
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeCompose(true);
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(composeDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) || []).filter(element => element.getClientRects().length > 0);
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!composeDialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [closeCompose, composeOpen]);

  const handleComposeDelivery = useCallback(async (mode: 'draft' | 'send') => {
    if (!composeSelectedAccount?.generation) { setComposeError('Choose the current connected mail account first.'); return; }
    if (composeSelectedAccount.provider === 'gmail' && !composeAliasesReady) { setComposeError('Your sender and signature are still loading. Try again when they are ready.'); return; }
    const to = [...new Set(parseAddressList(composeTo))], cc = [...new Set(parseAddressList(composeCc))], bcc = [...new Set(parseAddressList(composeBcc))];
    const invalid = [...to, ...cc, ...bcc].find(address => !isValidEmailAddress(address));
    if (invalid) { setComposeError(`Check the email address “${invalid}”.`); return; }
    if (mode === 'send' && !to.length && !cc.length && !bcc.length) { setComposeError('Add a recipient before sending.'); return; }
    if (!composeSubject.trim() && !composeBody.trim() && !composeFiles.entries.length) { setComposeError('Add a subject or message before saving.'); return; }
    setComposeError(null);
    try {
      const signatureHtml = composeIncludeSignature
        ? composeSelectedAccount.provider === 'gmail' ? String(composeSelectedAlias?.signature || '') : buildManualSignatureHtml(composeSelectedAccount.signatureText)
        : '';
      await host.delivery.prepare(composeSource, {
        epoch: host.epoch, accountId: composeSelectedAccount.accountId, generation: composeSelectedAccount.generation, mode, files:host.files.selection(composeSource,composeFileReview),
        ...(composeDelivery?.review?.openedDraft ? {preserveDraft:{body:composeKeepFormatting,attachments:true as const}} : {}),
        message: { from: composeDelivery?.review?.openedDraft ? composeFrom : composeSelectedAccount.provider === 'gmail' ? composeSelectedAlias?.sendAsEmail || composeSelectedAccount.email : composeSelectedAccount.email, to, cc, bcc,
          subject: composeSubject.trim(), bodyText: composeDelivery?.review?.openedDraft && !signatureHtml ? composeBody : buildNativeGmailReplyPlainText(composeBody, signatureHtml),
          bodyHtml: composeDelivery?.review?.openedDraft && !composeKeepFormatting && !signatureHtml ? undefined : buildNativeGmailReplyHtml(composeBody, signatureHtml), attachments: [] },
      });
    } catch (error) {
      setComposeError(error instanceof Error ? error.message : 'The mail review is unavailable. Your writing is kept.');
    }
  }, [host.delivery, host.files, host.epoch, composeFileReview, composeFiles.entries.length, composeSource, setComposeError, composeAliasesReady, composeDelivery?.review?.openedDraft, composeKeepFormatting, composeFrom, composeBcc, composeBody, composeCc, composeIncludeSignature, composeSelectedAccount, composeSelectedAlias?.sendAsEmail, composeSelectedAlias?.signature, composeSubject, composeTo]);

  const openProviderDraft = async (message:ThreadMessageView) => {
    if (!selectedAccount?.generation || !selectedThreadItem) return;
    let source:string|undefined;
    try {
      const current = Object.entries(host.delivery.store.getState().records).find(([key,record]) =>
        composeSources.includes(key) && record.prepare.accountId===selectedAccount.accountId && record.prepare.generation===selectedAccount.generation && !record.review?.superseded && !(record.opening && record.review?.state==='failed') &&
        (record.review?.providerMessageId===message.id || ((record.opening?.source ?? record.review?.openedDraft)?.messageId===message.id && (record.opening?.source ?? record.review?.openedDraft)?.threadId===selectedThreadItem.id)));
      if (current) {
        source=current[0];host.writing.getState().selectMessage(source);
        setComposeOpen(true);setIsMailRailOpen(false);
        if (current[1].pending==='open') await host.delivery.retry(source);
        else if (!current[1].pending && (current[1].review?.state==='saved' || current[1].review?.canEditDraft)) await host.delivery.editSaved(source);
      } else {
        source=host.writing.getState().newMessage(selectedAccount.key);
        setComposeOpen(true);setIsMailRailOpen(false);
        await host.delivery.openDraft(source,{epoch:host.epoch,accountId:selectedAccount.accountId,generation:selectedAccount.generation,accountEmail:selectedAccount.email,source:{messageId:message.id,threadId:selectedThreadItem.id}});
      }
    } catch (error) {
      const detail=error instanceof Error?error.message:'The provider draft could not be opened. Your kept writing is unchanged.';
      if(source){const failedSource=source;setComposeErrors(current=>({...current,[failedSource]:detail}));}else setReplyError(detail);
    }
  };

  const pinnedThreadKeySet = useMemo(() => new Set(pinnedThreadKeys), [pinnedThreadKeys]);

  const rawThreadItems = useMemo(
    () => buildThreadItems(snapshots, pinnedThreadKeySet),
    [pinnedThreadKeySet, snapshots],
  );
  const suppressedThreadKeySet = useMemo(() => new Set(suppressedThreadKeys), [suppressedThreadKeys]);
  const allThreadItems = useMemo(
    () => rawThreadItems.filter((thread) => !suppressedThreadKeySet.has(getInboxThreadKey(thread))),
    [rawThreadItems, suppressedThreadKeySet],
  );

  const inboxCoverage = useMemo(() => {
    const scopedSnapshots = snapshots.filter((snapshot) => selectedAccountKeySet.has(snapshot.account.key));
    return summarizeInboxCoverage(scopedSnapshots.map((snapshot) => ({
      loadedCount: snapshot.threads.length,
      totalMessageCount: snapshot.totalMessageCount,
      totalThreadCount: snapshot.totalThreadCount,
      truncated: snapshot.truncated,
    })));
  }, [selectedAccountKeySet, snapshots]);

  const inboxCoverageLabel = useMemo(
    () => formatInboxCoverage(inboxCoverage),
    [inboxCoverage],
  );

  const scopedIndexSnapshots = useMemo(
    () => snapshots.filter((snapshot) => selectedAccountKeySet.has(snapshot.account.key)),
    [selectedAccountKeySet, snapshots],
  );
  const indexingSnapshots = useMemo(
    () => scopedIndexSnapshots.filter((snapshot) => snapshot.indexStatus === 'indexing'),
    [scopedIndexSnapshots],
  );
  const pausedIndexSnapshots = useMemo(
    () => scopedIndexSnapshots.filter((snapshot) => snapshot.indexStatus === 'paused' || snapshot.indexStatus === 'error'),
    [scopedIndexSnapshots],
  );
  const activeIndexError = pausedIndexSnapshots.find((snapshot) => snapshot.indexError)?.indexError;
  const latestIndexUpdate = useMemo(() => scopedIndexSnapshots.reduce<string | undefined>((latest, snapshot) => {
    if (!snapshot.indexUpdatedAt) return latest;
    if (!latest || Date.parse(snapshot.indexUpdatedAt) > Date.parse(latest)) return snapshot.indexUpdatedAt;
    return latest;
  }, undefined), [scopedIndexSnapshots]);
  const indexStatusLabel = indexingSnapshots.length > 0
    ? 'Syncing older mail…'
    : pausedIndexSnapshots.length > 0
      ? 'Sync paused'
      : scopedIndexSnapshots.length > 0 && scopedIndexSnapshots.every((snapshot) => snapshot.indexStatus === 'complete')
        ? formatIndexUpdatedAt(latestIndexUpdate)
        : formatIndexUpdatedAt(latestIndexUpdate);
  const folderStatusLabel = activeFolder === 'inbox'
    ? indexStatusLabel
    : snapshots.some((snapshot) => snapshot.truncated)
      ? `${allThreadItems.length.toLocaleString('en-US')} recent conversations loaded`
      : `${allThreadItems.length.toLocaleString('en-US')} conversations loaded`;
  const canLoadMoreFolderMail = activeFolder !== 'inbox'
    && snapshots.some((snapshot) => snapshot.truncated)
    && mailFolderThreadLimit < MAIL_FOLDER_MAX_THREADS;

  const handlePauseIndexing = useCallback(async () => {
    const targets = indexingSnapshots.map((snapshot) => snapshot.account);
    if (targets.length === 0) return;
    setIndexControlBusy('pause');
    setInboxFolderError(activeFolder, null);
    try {
      const results = await Promise.allSettled(targets.map((account) => pauseNativeMailIndex(account.provider, account.accountId)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') setInboxFolderError(activeFolder, failed.reason instanceof Error ? failed.reason.message : 'Some indexes could not be paused.');
    } finally {
      setIndexControlBusy(null);
    }
  }, [activeFolder, indexingSnapshots]);

  const handleResumeIndexing = useCallback(async () => {
    const targets = pausedIndexSnapshots.map((snapshot) => snapshot.account);
    if (targets.length === 0) return;
    setIndexControlBusy('resume');
    setInboxFolderError(activeFolder, null);
    try {
      const results = await Promise.allSettled(targets.map((account) => syncNativeMailIndex(account.provider, account.accountId, 'resume')));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') setInboxFolderError(activeFolder, failed.reason instanceof Error ? failed.reason.message : 'Some indexes could not be resumed.');
    } finally {
      setIndexControlBusy(null);
    }
  }, [activeFolder, pausedIndexSnapshots]);

  const scopedThreadItems = useMemo(() => allThreadItems.filter((thread) => {
    if (!selectedAccountKeySet.has(thread.accountKey)) return false;
    if (bucketFilter !== 'all' && thread.bucket !== bucketFilter) return false;
    return true;
  }), [allThreadItems, bucketFilter, selectedAccountKeySet]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<InboxCategoryFilter, number>();
    for (const thread of scopedThreadItems) {
      const key = (thread.category || 'other') as InboxCategoryFilter;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [scopedThreadItems]);

  const effectiveGrouping: InboxGrouping = activeFolder === 'inbox' ? grouping : 'none';
  const threadItems = useMemo(() => sortGroupedInboxThreads(scopedThreadItems.filter((thread) => {
    if (categoryFilter !== 'all' && thread.category !== categoryFilter) return false;
    if (!search.trim()) return true;
    const haystack = `${thread.subject}\n${thread.from}\n${thread.summary}\n${thread.accountLabel}\n${thread.provider}\n${categoryLabel((thread.category || 'other') as InboxCategoryFilter)}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  }), effectiveGrouping, sortOrder), [categoryFilter, effectiveGrouping, scopedThreadItems, search, sortOrder]);

  const threadPageCount = useMemo(
    () => Math.max(1, Math.ceil(threadItems.length / threadsPerPage)),
    [threadItems.length, threadsPerPage],
  );

  const pagedThreadItems = useMemo(() => {
    const start = (threadPage - 1) * threadsPerPage;
    return threadItems.slice(start, start + threadsPerPage);
  }, [threadItems, threadPage, threadsPerPage]);

  const goToThreadPage = useCallback((requestedPage: number | string) => {
    const nextPage = clampInboxPage(requestedPage, threadPageCount, threadPage);
    setThreadPage(nextPage);
    setThreadPageDraft(String(nextPage));
  }, [threadPage, threadPageCount]);

  const visibleThreadRange = useMemo(
    () => inboxPageRange(threadPage, threadsPerPage, threadItems.length),
    [threadItems.length, threadPage, threadsPerPage],
  );

  const selectedThreadKeySet = useMemo(() => new Set(selectedThreadKeys), [selectedThreadKeys]);

  const selectedThreadItems = useMemo(() => {
    const byKey = new Map(allThreadItems.map((thread) => [getInboxThreadKey(thread), thread]));
    return selectedThreadKeys
      .map((key) => byKey.get(key))
      .filter((thread): thread is InboxThreadItem => Boolean(thread));
  }, [allThreadItems, selectedThreadKeys]);

  const bulkSelectionScope = useMemo(() => {
    if (selectedThreadItems.length === 0) return null;
    const [first] = selectedThreadItems;
    const homogeneous = selectedThreadItems.every((thread) => (
      thread.provider === first.provider && thread.accountKey === first.accountKey
    ));
    if (!homogeneous) return null;
    return {
      provider: first.provider,
      accountKey: first.accountKey,
      accountId: first.accountId,
    };
  }, [selectedThreadItems]);

  const currentPageKeys = useMemo(
    () => pagedThreadItems.map((thread) => getInboxThreadKey(thread)),
    [pagedThreadItems],
  );
  const allCurrentPageSelected = currentPageKeys.length > 0 && currentPageKeys.every((key) => selectedThreadKeySet.has(key));
  const someCurrentPageSelected = currentPageKeys.some((key) => selectedThreadKeySet.has(key)) && !allCurrentPageSelected;
  const allSelectedPinned = selectedThreadItems.length > 0 && selectedThreadItems.every((thread) => thread.isPinned);
  const allSelectedFlagged = selectedThreadItems.length > 0 && selectedThreadItems.every((thread) => thread.isFlagged);
  const selectedThreadsCanModify = selectedThreadItems.every((thread) => accountByKey.get(thread.accountKey)?.canModify);
  const threadToolbarButtonClass =
    'inline-flex h-7 w-7 items-center justify-center rounded-md text-aegis-text-dim transition-colors hover:bg-[rgb(var(--aegis-overlay)/0.04)] hover:text-aegis-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-aegis-primary/35 disabled:cursor-not-allowed disabled:opacity-35';
  const threadToolbarDangerButtonClass =
    'inline-flex h-7 w-7 items-center justify-center rounded-md text-aegis-text-dim transition-colors hover:bg-red-500/8 hover:text-red-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400/30 disabled:cursor-not-allowed disabled:opacity-35';

  useEffect(() => {
    if (linkedState.target) return;
    if (threadItems.length === 0) {
      setSelectedThread(null);
      return;
    }
    if (!selectedThread) {
      let restored: InboxThreadItem | undefined;
      try {
        const kept = JSON.parse(host.preferences.getItem(`inbox-selected:${activeFolder}`) || 'null');
        restored = threadItems.find(thread => thread.id === kept?.threadId && thread.accountKey === kept?.accountKey
          && availableAccounts.some(account => account.key === thread.accountKey && account.generation === kept?.generation));
      } catch { /* An invalid view preference must not prevent reading mail. */ }
      const first = restored || threadItems[0];
      setSelectedThread({ provider: first.provider, accountKey: first.accountKey, threadId: first.id });
      return;
    }
    const exists = threadItems.some((thread) => thread.id === selectedThread.threadId && thread.accountKey === selectedThread.accountKey);
    if (!exists) {
      const first = threadItems[0];
      setSelectedThread({ provider: first.provider, accountKey: first.accountKey, threadId: first.id });
    }
  }, [activeFolder, availableAccounts, host.preferences, selectedThread, threadItems, linkedState.target]);

  useEffect(() => {
    setThreadPage(1);
    setSelectedThreadKeys([]);
  }, [accountFilter, bucketFilter, categoryFilter, grouping, search, sortOrder, threadsPerPage]);

  useEffect(() => {
    setThreadPage((current) => Math.min(current, threadPageCount));
  }, [threadPageCount]);

  useEffect(() => {
    setThreadPageDraft(String(threadPage));
  }, [threadPage]);

  useEffect(() => {
    setSelectedThreadKeys((current) => current.filter((key) => allThreadItems.some((thread) => getInboxThreadKey(thread) === key)));
  }, [allThreadItems]);

  const listViewKey = `${accountFilter}|${bucketFilter}|${categoryFilter}|${search}|${sortOrder}|${threadsPerPage}|${threadPage}`;
  const previousListViewKeyRef = useRef(listViewKey);
  useEffect(() => {
    if (previousListViewKeyRef.current === listViewKey) return;
    previousListViewKeyRef.current = listViewKey;
    if (!threadListRef.current) return;
    threadListRef.current.scrollTop = 0;
    setInboxScrollPosition(activeFolder, { listTop: 0 });
  }, [activeFolder, listViewKey]);

  useEffect(() => {
    if (!selectPageCheckboxRef.current) return;
    selectPageCheckboxRef.current.indeterminate = someCurrentPageSelected;
  }, [someCurrentPageSelected]);

  const linkedThreadItem = useMemo(() => linkedEmail ? buildThreadItems([{ provider: linkedEmail.account.provider, account: linkedEmail.account, threads: [linkedEmail.digest], truncated: false }], pinnedThreadKeySet)[0] : undefined, [linkedEmail, pinnedThreadKeySet]);
  const selectedThreadItem = useMemo(
    () => (linkedThreadItem ?? allThreadItems.find((thread) => thread.id === selectedThread?.threadId && thread.accountKey === selectedThread?.accountKey)) || null,
    [allThreadItems, selectedThread, linkedThreadItem],
  );

  const nativeTagOptions = useMemo(() => {
    if (!bulkSelectionScope) return [];
    if (bulkSelectionScope.provider === 'gmail') {
      return gmailLabelOptionsByAccount[bulkSelectionScope.accountId] || [];
    }

    const knownOptions = microsoftCategoryOptionsByAccount[bulkSelectionScope.accountId] || [];
    const byId = new Map(knownOptions.map((option) => [option.id, option]));
    for (const thread of selectedThreadItems) {
      for (const tag of thread.providerTags || []) {
        if (!byId.has(tag)) {
          byId.set(tag, { id: tag, label: formatNativeTagLabel('microsoft', tag) });
        }
      }
    }
    return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [bulkSelectionScope, gmailLabelOptionsByAccount, microsoftCategoryOptionsByAccount, selectedThreadItems]);
  const nativeTagActionLabel = bulkSelectionScope?.provider === 'gmail'
    ? 'Gmail labels'
    : bulkSelectionScope?.provider === 'microsoft'
      ? 'Outlook categories'
      : 'Labels / categories';

  const selectedAccount = useMemo(
    () => availableAccounts.find((account) => account.key === selectedThread?.accountKey) || null,
    [availableAccounts, selectedThread?.accountKey],
  );

  useEffect(() => {
    if (!linkedState.target && selectedThread && selectedThreadItem && selectedAccount) {
      host.preferences.setItem(`inbox-selected:${activeFolder}`, JSON.stringify({ ...selectedThread, generation: selectedAccount.generation }));
    }
  }, [activeFolder, host.preferences, selectedAccount, selectedThread, selectedThreadItem, linkedState.target]);

  const [readerRetry, setReaderRetry] = useState(0);
  const retrySelectedMessage = () => {
    if (linkedState.target) { void host.source.load(availableAccounts, host.scopeVersion, true); return; }
    const current = useInboxSessionStore.getState().folders[activeFolder].reader;
    setInboxReaderSession(activeFolder, { ...current, loadKey: null });
    setReaderRetry(value => value + 1);
  };
  const selectedThreadLoadKey = inboxThreadLoadKey(selectedThreadItem && selectedAccount ? {
    provider: selectedThreadItem.provider,
    accountId: selectedAccount.accountId,
    generation: selectedAccount.generation,
    accountEmail: selectedAccount.email,
    threadId: selectedThreadItem.id,
    sourceMessageId: selectedThreadItem.sourceMessageId,
    subject: selectedThreadItem.subject,
    sender: selectedThreadItem.from,
    messageCount: selectedThreadItem.messageCount,
    latestAt: selectedThreadItem.date,
  } : null);
  const selectedThreadLoadTarget = useMemo(
    () => selectedThreadItem && selectedAccount
      ? { thread: selectedThreadItem, account: selectedAccount }
      : null,
    [selectedThreadLoadKey],
  );
  const selectedThreadIdentityKey = selectedThreadItem
    ? `${selectedThreadItem.provider}:${selectedThreadItem.accountKey}:${selectedThreadItem.id}`
    : null;
  const replyJournalKey = selectedThreadIdentityKey ? 'reply:' + selectedThreadIdentityKey : 'reply:none';
  const [emailImages, setEmailImages] = useState<Record<string, { images?: Record<string,string>; loading?: boolean; unavailable?: number; error?: string }>>({});
  const imageContextKey = JSON.stringify([selectedThreadIdentityKey, host.scopeVersion, Boolean(selectedThreadItem?.safety.protected)]);
  const imageContext = useRef(imageContextKey), imageRequestVersion = useRef(0);
  const attemptedImageMessages = useRef(new Set<string>()), imageQueue = useRef(Promise.resolve());
  const [preparedFrames, setPreparedFrames] = useState<Record<string, { html: string; failed: boolean }>>({});
  const [imageRetry, setImageRetry] = useState(0);
  useLayoutEffect(() => {
    imageContext.current = imageContextKey; imageRequestVersion.current++;
    attemptedImageMessages.current.clear(); imageQueue.current = Promise.resolve(); setEmailImages({}); setPreparedFrames({});
    return () => { imageRequestVersion.current++; };
  }, [imageContextKey]);
  const showMessageImages = useCallback(async (message: ThreadMessageView) => {
    const api = getInboxMailApi();
    if (!api || !selectedAccount || !selectedThreadItem) return;
    const version = imageRequestVersion.current;
    attemptedImageMessages.current.add(message.id);
    setEmailImages(old => ({ ...old, [message.id]: { ...old[message.id], loading: true, error: undefined } }));
    try {
      const result = await api.loadImages({ provider: selectedThreadItem.provider === 'gmail' ? 'google' : 'microsoft', accountId: selectedAccount.accountId, threadId: selectedThreadItem.id, messageId: message.id });
      if (imageRequestVersion.current === version) setEmailImages(old => ({ ...old, [message.id]: { images: { ...old[message.id]?.images, ...result.images }, unavailable: result.unavailable } }));
    } catch (error) { if (imageRequestVersion.current === version) setEmailImages(old => ({ ...old, [message.id]: { ...old[message.id], loading: false, error: error instanceof Error ? error.message : 'Images could not load.' } })); }
  }, [selectedAccount, selectedThreadItem]);

  const replyDelivery = useStore(host.delivery.store, state => state.records[replyJournalKey]);
  const replyFileReview=replyDelivery?.base?.review??replyDelivery?.review;
  const [replySubject, setReplySubject] = useInboxWriting<string>(replyJournalKey, 'replySubject', ensureReplySubject(selectedThreadItem?.subject || ''));
  const [replyBody, setReplyBody] = useInboxWriting<string>(replyJournalKey, 'replyBody', '');
  const [replyAll, setReplyAll] = useInboxWriting<boolean>(replyJournalKey, 'replyAll', false);
  const [showReplyComposer, setShowReplyComposer] = useInboxWriting<boolean>(replyJournalKey, 'showReplyComposer', false);
  const [includeSignature, setIncludeSignature] = useInboxWriting<boolean>(replyJournalKey, 'includeSignature', true);

  const replyFiles=useInboxOutgoingFiles(host.files,replyJournalKey,replyFileReview,showReplyComposer,host.scopeVersion);

  const readerMatchesSelection = Boolean(selectedThreadLoadKey && readerSession.loadKey === selectedThreadLoadKey);
  const readerMatchesThread = Boolean(selectedThreadIdentityKey && readerSession.threadKey === selectedThreadIdentityKey);
  const threadMessages = readerMatchesThread ? readerSession.messages : [];
  const renderedEmails = useMemo(() => threadMessages.map(message => {
    const images = imageContext.current === imageContextKey ? emailImages[message.id] : undefined;
    const allowExternalContent = !selectedThreadItem?.safety.protected;
    const sanitized = sanitizeEmailHtml(message.bodyHtml, message.attachments || [], allowExternalContent, { remoteImages: images?.images, allowRemoteImages: true, allowInlineContent: true });
    return { message, images, sanitized, html: sanitized.html || buildPlainTextEmailHtml(message.bodyText || message.snippet || '(no readable body)', allowExternalContent),
      imagesReady: !sanitized.remoteImageCount || !!images && !images.loading && !images.error && !images.unavailable };
  }), [threadMessages, emailImages, imageContextKey, selectedThreadItem?.safety.protected]);
  const conversationPrepared = renderedEmails.length > 0 && renderedEmails.every(item => item.imagesReady && preparedFrames[item.message.id]?.html === item.html && !preparedFrames[item.message.id]?.failed);
  const displayedOpening=useRef(createDisplayedMailOpening());
  const openingKey=JSON.stringify([host.scopeVersion,selectedThreadIdentityKey,isCompactMailLayout?compactReaderOpen:true]);
  displayedOpening.current.select(openingKey);
  useLayoutEffect(()=>{
    const ready=conversationPrepared&&readerMatchesSelection&&readerSession.status==='ready'&&!pendingMailAction&&!mutatingThread;
    const visible=()=>document.visibilityState==='visible'&&(!isCompactMailLayout||compactReaderOpen)&&!!readingPaneRef.current?.getClientRects().length;
    const schedule=()=>{
      if(!ready||!visible())return;
      if(!selectedAccount?.generation||!selectedThreadItem||!displayedOpening.current.take(openingKey,ready,visible(),selectedThreadItem.labels.includes('UNREAD'),selectedAccount.canModify))return;
      const displayKey=mailReadDisplayKey(host.scopeVersion,selectedThreadItem),attempt=crypto.randomUUID();
      // Commit the read appearance in the same paint as the prepared email.
      // Keep the provider labels intact until its background save is confirmed.
      setPendingReadDisplays(current=>({...current,[displayKey]:attempt}));
      void host.api.markDisplayed({provider:selectedThreadItem.provider,accountId:selectedAccount.accountId,generation:selectedAccount.generation,threadId:selectedThreadItem.id,messageIds:threadMessages.map(message=>message.id)})
        .then(async()=>{if(visible()&&displayedOpening.current.isCurrent(openingKey)&&activeFolder!=='inbox')await loadInbox(true);})
        .catch(error=>{if(visible()&&displayedOpening.current.isCurrent(openingKey))addNotification({severity:'error',title:'Read status was not saved',body:error instanceof Error?error.message:'Use Mark read to try again.'});})
        .finally(()=>setPendingReadDisplays(current=>{if(current[displayKey]!==attempt)return current;const next={...current};delete next[displayKey];return next;}));
    };
    schedule();document.addEventListener('visibilitychange',schedule);
    return ()=>{document.removeEventListener('visibilitychange',schedule);};
  },[openingKey,conversationPrepared,readerMatchesSelection,readerSession.status,pendingMailAction,mutatingThread,triageState.busy,selectedThreadItem,selectedAccount,host.api,threadMessages,loadInbox,addNotification,isCompactMailLayout,compactReaderOpen,activeFolder]);
  const preparationFailed = renderedEmails.some(item => !!item.images?.error || !!item.images?.unavailable || preparedFrames[item.message.id]?.html === item.html && preparedFrames[item.message.id]?.failed);
  const retryPreparation = () => { attemptedImageMessages.current.clear(); setEmailImages({}); setPreparedFrames({}); setImageRetry(value => value + 1); retrySelectedMessage(); };
  useEffect(() => {
    if (!readerMatchesThread || !selectedThreadItem) return;
    const version = imageRequestVersion.current;
    for (const { message, sanitized } of renderedEmails) {
      if (attemptedImageMessages.current.has(message.id) || !sanitized.remoteImageCount) continue;
      attemptedImageMessages.current.add(message.id);
      // Prepare the entire selected conversation while it is hidden, including
      // messages below the fold. Readiness never depends on visibility.
      imageQueue.current = imageQueue.current.then(async () => {
        if (imageRequestVersion.current === version) await showMessageImages(message);
      });
    }
  }, [readerMatchesThread, threadMessages, selectedThreadItem, imageContextKey, imageRetry, showMessageImages]);
  const threadLoading = Boolean(selectedThreadLoadTarget)
    && threadMessages.length === 0
    && (!readerMatchesSelection || readerSession.status === 'loading' || readerSession.status === 'refreshing');
  const threadRefreshing = readerMatchesThread && readerSession.status === 'refreshing' && threadMessages.length > 0;
  const threadError = readerMatchesThread || readerMatchesSelection ? readerSession.error : null;
  const sendAsAliases = readerMatchesThread ? readerSession.sendAsAliases : [];
  const [selectedFrom, setSelectedFrom] = useInboxWriting<string>(replyJournalKey, 'selectedFrom', readerMatchesThread ? readerSession.selectedFrom : '');
  const [microsoftSignatureDraft, setMicrosoftSignatureDraft] = useInboxWriting<string>(replyJournalKey, 'microsoftSignatureDraft', selectedAccount?.signatureText || '');
  const handleThreadListScroll = useCallback(() => {
    setInboxScrollPosition(activeFolder, { listTop: threadListRef.current?.scrollTop || 0 });
  }, [activeFolder]);
  const handleThreadListKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const current = eventTargetElement(event.target)?.closest<HTMLButtonElement>('button[data-inbox-thread]');
      if (current) {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-inbox-thread]'));
        const index = buttons.indexOf(current);
        const next = buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        event.preventDefault();
        if (next && next !== current) {
          next.focus();
          next.scrollIntoView({ block: 'nearest' });
        }
        return;
      }
    }
    delegatePaneKeyboard(event, threadListRef.current);
  }, []);
  const handleReadingPaneScroll = useCallback(() => {
    if (linkedState.target) { if (readerMatchesThread && readingPaneRef.current) host.source.scroll(linkedState.target.nonce, readingPaneRef.current.scrollTop); return; }
    setInboxScrollPosition(activeFolder, {
      readerTop: readingPaneRef.current?.scrollTop || 0,
      readerLoadKey: selectedThreadIdentityKey,
    });
  }, [activeFolder, selectedThreadIdentityKey, host.source, linkedState.target, readerMatchesThread]);
  const linkedReaderTop = () => {
    const target = linkedState.target, pane = readingPaneRef.current;
    if (!target || !pane) return 0;
    if (host.source.hasScroll(target.nonce)) return host.source.scroll(target.nonce);
    const message = target.messageId && Array.from(pane.querySelectorAll<HTMLElement>('[data-source-message]')).find(element => element.dataset.sourceMessage === target.messageId);
    if (!message || !readerMatchesThread) return 0;
    const top = Math.max(0, message.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 12);
    return host.source.scroll(target.nonce, top);
  };
  const handleReaderContentMeasured = useCallback(() => {
    if (linkedState.target) { if(readingPaneRef.current)readingPaneRef.current.scrollTop = linkedReaderTop(); return; }
    const saved = getInboxScrollPosition(activeFolder);
    if (saved.readerLoadKey !== selectedThreadIdentityKey || !readingPaneRef.current) return;
    readingPaneRef.current.scrollTop = saved.readerTop;
  }, [activeFolder, selectedThreadIdentityKey, host.source, linkedState.target, readerMatchesThread]);

  useLayoutEffect(() => {
    const saved = getInboxScrollPosition(activeFolder);
    if (threadListRef.current) threadListRef.current.scrollTop = saved.listTop;
    if (readingPaneRef.current) {
      readingPaneRef.current.scrollTop = linkedState.target ? linkedReaderTop() : saved.readerLoadKey === selectedThreadIdentityKey ? saved.readerTop : 0;
    }
    return () => {
      // Linked position is saved by its scroll handler. A placeholder or detached
      // reader must not replace it with zero while the exact email is loading.
      if (linkedState.target) return;
      setInboxScrollPosition(activeFolder, {
        listTop: threadListRef.current?.scrollTop || 0,
        readerTop: readingPaneRef.current?.scrollTop || 0,
        readerLoadKey: selectedThreadIdentityKey,
      });
    };
  }, [activeFolder, selectedThreadIdentityKey, host.source, linkedState.target, readerMatchesThread]);

  const refreshSelectedSenderState = useCallback(async () => {
    const requestId = ++senderStateRequestRef.current;
    const target = selectedThreadLoadTarget?.thread;
    if (!target) {
      setSenderActionState({ loading: false });
      return;
    }
    const api = host.api?.mailAssistant;
    if (!api?.senderState) {
      setSenderActionState({ loading: false, canManage: false });
      return;
    }
    setSenderActionState({ loading: true });
    let result: Awaited<ReturnType<NonNullable<typeof api.senderState>>>;
    try {
      result = await api.senderState({
        provider: target.provider,
        accountId: target.accountId,
        threadId: target.id,
      });
    } catch {
      if (requestId === senderStateRequestRef.current) setSenderActionState({ loading: false, canManage: false });
      return;
    }
    if (requestId !== senderStateRequestRef.current) return;
    setSenderActionState({
      loading: false,
      sender: result.sender,
      blocked: result.blocked,
      canManage: result.canManage,
      error: result.error,
    });
  }, [selectedThreadLoadTarget]);

  useEffect(() => {
    void refreshSelectedSenderState();
    return () => { senderStateRequestRef.current += 1; };
  }, [refreshSelectedSenderState]);

  const selectedThreadIndex = useMemo(
    () => threadItems.findIndex((thread) => thread.id === selectedThread?.threadId && thread.accountKey === selectedThread?.accountKey),
    [selectedThread, threadItems],
  );

  const newerThreadItem = selectedThreadIndex > 0 ? threadItems[selectedThreadIndex - 1] : null;
  const olderThreadItem = selectedThreadIndex >= 0 && selectedThreadIndex < threadItems.length - 1
    ? threadItems[selectedThreadIndex + 1]
    : null;
  const threadItemsRef = useRef(threadItems);

  useEffect(() => {
    threadItemsRef.current = threadItems;
  }, [threadItems]);

  const beginSplitResize = useCallback(() => {
    if (isListPaneCollapsed) {
      const restoredWidth = Math.min(MAX_LIST_PANE_WIDTH, Math.max(MIN_LIST_PANE_WIDTH, listPaneWidthBeforeCollapseRef.current || DEFAULT_LIST_PANE_WIDTH));
      setListPaneWidth(restoredWidth);
      setIsListPaneCollapsed(false);
    }
    isResizingSplitRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [isListPaneCollapsed]);

  const toggleListPaneCollapsed = useCallback(() => {
    if (isListPaneCollapsed) {
      const restoredWidth = Math.min(MAX_LIST_PANE_WIDTH, Math.max(MIN_LIST_PANE_WIDTH, listPaneWidthBeforeCollapseRef.current || DEFAULT_LIST_PANE_WIDTH));
      setListPaneWidth(restoredWidth);
      setIsListPaneCollapsed(false);
      window.requestAnimationFrame(() => splitPaneRef.current?.querySelector<HTMLInputElement>('input[aria-label^="Search"]')?.focus());
      return;
    }
    listPaneWidthBeforeCollapseRef.current = listPaneWidth;
    setIsListPaneCollapsed(true);
    window.requestAnimationFrame(() => splitPaneRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Show inbox list"]')?.focus());
  }, [isListPaneCollapsed, listPaneWidth]);

  useEffect(() => {
    let mounted = true;

    async function loadThread() {
      if (linkedState.target) return;
      if (!selectedThreadLoadTarget) {
        clearInboxReaderSession(activeFolder);
        return;
      }

      const { thread: selectedThreadItem, account: selectedAccount } = selectedThreadLoadTarget;
      const loadKey = selectedThreadLoadKey!;
      const threadKey = `${selectedThreadItem.provider}:${selectedThreadItem.accountKey}:${selectedThreadItem.id}`;
      const currentReader = useInboxSessionStore.getState().folders[activeFolder].reader;
      if (currentReader.loadKey === loadKey
        && (currentReader.status === 'ready' || currentReader.status === 'loading' || currentReader.status === 'refreshing')) return;

      const preserveCurrent = currentReader.threadKey === threadKey && currentReader.messages.length > 0;
      setInboxReaderSession(activeFolder, {
        loadKey,
        threadKey,
        status: preserveCurrent ? 'refreshing' : 'loading',
        messages: preserveCurrent ? currentReader.messages : [],
        sendAsAliases: preserveCurrent ? currentReader.sendAsAliases : [],
        selectedFrom: preserveCurrent ? currentReader.selectedFrom : '',
        microsoftSignatureDraft: preserveCurrent
          ? currentReader.microsoftSignatureDraft
          : selectedAccount.signatureText || '',
        error: null,
      });
      const requestIsCurrent = () => (
        useInboxSessionStore.getState().folders[activeFolder].reader.loadKey === loadKey
      );
      try {
        if (selectedThreadItem.provider === 'gmail') {
          const [threadResult, aliasesResult] = await Promise.all([
            getNativeGmailThread({ threadId: selectedThreadItem.id, account: selectedAccount.accountId }),
            getNativeGmailSendAsAliases({ account: selectedAccount.accountId }),
          ]);
          if (!requestIsCurrent()) return;
          if (!threadResult.success || !threadResult.thread) {
            throw new Error(threadResult.error || 'Unable to read the selected Gmail thread.');
          }

          const messages = describeNativeGmailThread(threadResult.thread);
          const aliases = aliasesResult.success ? aliasesResult.sendAs : [];
          const defaultFrom = getDefaultNativeGmailSendAs(aliases)?.sendAsEmail || selectedAccount.email;
          setInboxReaderSession(activeFolder, {
            loadKey,
            threadKey,
            status: 'ready',
            messages,
            sendAsAliases: aliases,
            selectedFrom: defaultFrom,
            microsoftSignatureDraft: '',
            error: threadResult.error || null,
          });
        } else {
          const result = await getNativeMicrosoftConversation({
            accountId: selectedAccount.accountId,
            conversationId: selectedThreadItem.id,
            messageId: selectedThreadItem.sourceMessageId,
          });
          if (!requestIsCurrent()) return;
          if (!result.success) {
            if (result.itemUnavailable) {
              const removedKeys = new Set([getInboxThreadKey(selectedThreadItem)]);
              if (mounted) {
                setSuppressedThreadKeys((current) => [...new Set([...current, ...removedKeys])]);
                setSelectedThreadKeys((current) => current.filter((key) => !removedKeys.has(key)));
              }
              setInboxSelectedThread(activeFolder, (current) => selectInboxThreadAfterRemoval(threadItemsRef.current, current, removedKeys));
              clearInboxReaderSession(activeFolder);
              return;
            }
            throw new Error(result.error || 'Unable to read the selected Outlook thread.');
          }
          setInboxReaderSession(activeFolder, {
            loadKey,
            threadKey,
            status: 'ready',
            messages: describeNativeMicrosoftConversation(result.messages),
            sendAsAliases: [],
            selectedFrom: selectedAccount.email,
            microsoftSignatureDraft: selectedAccount.signatureText || '',
            error: result.error || null,
          });
        }
      } catch (loadError: any) {
        if (!requestIsCurrent()) return;
        const latestReader = useInboxSessionStore.getState().folders[activeFolder].reader;
        setInboxReaderSession(activeFolder, {
          ...latestReader,
          loadKey,
          threadKey,
          status: latestReader.messages.length > 0 ? 'ready' : 'error',
          error: loadError?.message || 'Unable to load the selected thread.',
        });
      }
    }

    void loadThread();
    return () => {
      mounted = false;
    };
  }, [activeFolder, selectedThreadLoadKey, selectedThreadLoadTarget, linkedState.target, readerRetry]);

  const previousReplyThreadKeyRef = useRef(selectedThreadIdentityKey);
  useEffect(() => {
    if (previousReplyThreadKeyRef.current !== selectedThreadIdentityKey) {
      previousReplyThreadKeyRef.current = selectedThreadIdentityKey;
      setReplyError(null);
      setShowActionMenu(false);
    }

  }, [readerMatchesThread, readerSession.microsoftSignatureDraft, selectedAccount, selectedThreadIdentityKey, selectedThreadItem]);

  const accountScopedThreadItems = useMemo(
    () => allThreadItems.filter((thread) => selectedAccountKeySet.has(thread.accountKey)),
    [allThreadItems, selectedAccountKeySet],
  );

  const bucketCounts = useMemo(() => {
    const base = accountScopedThreadItems;
    return {
      all: base.length,
      safe_review: base.filter((thread) => thread.bucket === 'safe_review').length,
      urgent: base.filter((thread) => thread.bucket === 'urgent').length,
      needs_reply: base.filter((thread) => thread.bucket === 'needs_reply').length,
      waiting: base.filter((thread) => thread.bucket === 'waiting').length,
      fyi: base.filter((thread) => thread.bucket === 'fyi').length,
    };
  }, [accountScopedThreadItems]);

  const followUpQueue = useMemo(
    () => accountScopedThreadItems
      .filter((thread) => thread.bucket === 'urgent' || thread.bucket === 'needs_reply' || thread.bucket === 'waiting')
      .slice(0, 4),
    [accountScopedThreadItems],
  );

  const followUpPressureCount = bucketCounts.urgent + bucketCounts.needs_reply;
  const followUpPlans = useMemo(() => {
    const nextPlans = new Map<string, { deadline: Date; label: string }>();
    for (const thread of followUpQueue) {
      const deadline = deriveFollowUpDeadline(thread);
      nextPlans.set(getInboxThreadKey(thread), {
        deadline,
        label: formatFollowUpDeadline(deadline),
      });
    }
    return nextPlans;
  }, [followUpQueue]);

  const scheduleFollowUpReminder = useCallback(async (thread: InboxThreadItem) => {
    const plan = followUpPlans.get(getInboxThreadKey(thread));
    if (!plan) return;

    try {
      const deadline = plan.deadline;
      const end = new Date(deadline.getTime() + 30 * 60_000);
      const event = await addCalendarEvent({
        title: buildFollowUpReminderTitle(thread),
        date: toCalendarDateValue(deadline),
        startTime: toCalendarTimeValue(deadline),
        endTime: toCalendarTimeValue(end),
        allDay: false,
        notes: [
          `Provider: ${thread.provider === 'gmail' ? 'Gmail' : 'Outlook'}`,
          `Account: ${thread.accountLabel}`,
          `Bucket: ${bucketLabel(thread.bucket)}`,
          `From: ${thread.from}`,
          thread.summary || thread.latestSnippet || thread.latestBody || '',
        ].filter(Boolean).join('\n'),
        category: 'work',
        reminderMinutes: calendarSettings.defaultReminder,
        deliveryChannel: calendarSettings.defaultDeliveryChannel,
        status: 'scheduled',
      },{source:{provider:thread.provider==='gmail'?'google':'microsoft',accountId:thread.accountId,threadId:thread.id},startAt:deadline.toISOString(),endAt:end.toISOString()});

      addNotification({category:'system',severity:'success',title:event.created?'Follow-up saved in Calendar':'Follow-up already in Calendar',body:`${event.event.value.title} · ${event.event.value.start.date} ${event.event.value.start.time} ${event.event.value.timezone}${event.event.value.reminderMinutes?' · Reminder preference kept; delivery is not active yet.':''}`,route:'/calendar',showToast:true});
    } catch (error: any) {
      addNotification({
        category: 'error',
        severity: 'error',
        title: 'Check this Calendar follow-up',
        body: error?.message || 'Unable to add the follow-up reminder to Calendar.',
        route: '/calendar',
        showToast: true,
      });
    }
  }, [addCalendarEvent, addNotification, calendarSettings.defaultDeliveryChannel, calendarSettings.defaultReminder, followUpPlans]);

  useEffect(() => {
    if (categoryFilter === 'all') return;
    if ((categoryCounts.get(categoryFilter) || 0) > 0) return;
    setCategoryFilter('all');
  }, [categoryCounts, categoryFilter]);

  const ownEmailSet = useMemo(() => {
    if (!selectedAccount) return new Set<string>();
    return (selectedAccount?.provider ?? 'gmail') === 'gmail'
      ? getOwnEmailSet(sendAsAliases, selectedAccount.email)
      : new Set<string>([normalizeEmail(selectedAccount.email)]);
  }, [selectedAccount, sendAsAliases]);

  const replySourceMessage = useMemo(
    () => inboxReplySource(threadMessages, ownEmailSet, extractEmail),
    [ownEmailSet, threadMessages],
  );

  const replyRecipients = useMemo(
    () => buildReplyRecipients(replySourceMessage, ownEmailSet, replyAll),
    [ownEmailSet, replyAll, replySourceMessage],
  );

  const selectedAlias = useMemo(
    () => sendAsAliases.find((alias) => alias.sendAsEmail === selectedFrom) || getDefaultNativeGmailSendAs(sendAsAliases),
    [selectedFrom, sendAsAliases],
  );

  const toggleThreadSelection = useCallback((thread: InboxThreadItem) => {
    const key = getInboxThreadKey(thread);
    setSelectedThreadKeys((current) => current.includes(key)
      ? current.filter((value) => value !== key)
      : [...current, key]);
  }, []);

  const toggleCurrentPageSelection = useCallback(() => {
    setSelectedThreadKeys((current) => {
      const next = new Set(current);
      if (allCurrentPageSelected) {
        for (const key of currentPageKeys) next.delete(key);
      } else {
        for (const key of currentPageKeys) next.add(key);
      }
      return [...next];
    });
  }, [allCurrentPageSelected, currentPageKeys]);

  const loadNativeTagOptions = useCallback(async (scope: NonNullable<typeof bulkSelectionScope>) => {
    setNativeTagOptionsError(null);

    if (scope.provider === 'gmail') {
      if (gmailLabelOptionsByAccount[scope.accountId]) return;
      setNativeTagOptionsLoading(true);
      try {
        const result = await listNativeGmailLabels({ account: scope.accountId });
        if (!result.success) throw new Error(result.error || 'Unable to load Gmail labels.');
        setGmailLabelOptionsByAccount((current) => ({
          ...current,
          [scope.accountId]: buildGmailLabelOptions(result.labels),
        }));
      } catch (tagError: any) {
        setNativeTagOptionsError(tagError?.message || 'Unable to load Gmail labels.');
      } finally {
        setNativeTagOptionsLoading(false);
      }
      return;
    }

    if (microsoftCategoryOptionsByAccount[scope.accountId]) return;
    setNativeTagOptionsLoading(true);
    try {
      const result = await listNativeMicrosoftCategories({ accountId: scope.accountId });
      if (!result.success) throw new Error(result.error || 'Unable to load Outlook categories.');
      setMicrosoftCategoryOptionsByAccount((current) => ({
        ...current,
        [scope.accountId]: buildMicrosoftCategoryOptions(result.categories),
      }));
    } catch (tagError: any) {
      setNativeTagOptionsError(tagError?.message || 'Unable to load Outlook categories.');
    } finally {
      setNativeTagOptionsLoading(false);
    }
  }, [bulkSelectionScope, gmailLabelOptionsByAccount, microsoftCategoryOptionsByAccount]);

  const toggleNativeTagMenu = useCallback(() => {
    if (showNativeTagMenu) {
      setShowNativeTagMenu(false);
      return;
    }
    if (!bulkSelectionScope) return;
    setShowActionMenu(false);
    setShowNativeTagMenu(true);
    void loadNativeTagOptions(bulkSelectionScope);
  }, [bulkSelectionScope, loadNativeTagOptions, showNativeTagMenu]);

  const handlePreviewAttachment = useCallback((attachment: ThreadAttachmentView) => {
    const src = buildAttachmentDataUrl(attachment);
    if (!src || !attachment.mimeType.startsWith('image/')) return;
    setPreviewAttachment({ src, alt: attachment.name });
  }, []);

  const handleSaveAttachment = useCallback(async (attachment: ThreadAttachmentView) => {
    if (!attachmentHasData(attachment)) return;
    try {
      const base64 = attachment.base64 || (attachment.dataUrl ? attachment.dataUrl.split(',')[1] || '' : '');
      if (!base64) throw new Error('Attachment bytes are unavailable.');
      const result = await host.api?.file?.saveAttachmentData({
        fileName: attachment.name || 'attachment',
        mimeType: attachment.mimeType || 'application/octet-stream',
        base64,
      });
      if (!result?.success || result.canceled) return;
      addNotification({
        category: 'system',
        severity: 'success',
        title: 'Attachment download requested',
        body: result.path || attachment.name,
      });
    } catch (error: any) {
      addNotification({
        category: 'system',
        severity: 'error',
        title: 'Attachment save failed',
        body: error?.message || 'Unable to save attachment.',
      });
    }
  }, [addNotification]);

  const handleOpenAttachment = useCallback(async (attachment: ThreadAttachmentView) => {
    if (attachment.mimeType.startsWith('image/') && buildAttachmentDataUrl(attachment)) {
      handlePreviewAttachment(attachment);
      return;
    }
    if (!attachmentHasData(attachment)) return;
    try {
      const base64 = attachment.base64 || (attachment.dataUrl ? attachment.dataUrl.split(',')[1] || '' : '');
      if (!base64) throw new Error('Attachment bytes are unavailable.');
      const result = await host.api?.file?.openAttachmentData({
        fileName: attachment.name || 'attachment',
        mimeType: attachment.mimeType || 'application/octet-stream',
        base64,
      });
      if (!result?.success) {
        throw new Error(result?.error || 'Unable to open attachment.');
      }
    } catch (error: any) {
      addNotification({
        category: 'system',
        severity: 'error',
        title: 'Attachment open failed',
        body: error?.message || 'Unable to open attachment.',
      });
    }
  }, [addNotification, handlePreviewAttachment]);

  const prepareInboxMailAction = useCallback(async (
    threads: InboxThreadItem[],
    action: MailActionKind,
    organization?: string,
  ) => {
    if (threads.length === 0 || mutatingThread) return;
    const api = host.api?.mailAssistant;
    if (!api?.prepareSelection) {
      addNotification({
        category: 'error',
        severity: 'error',
        title: 'Reviewed action unavailable',
        body: 'This build cannot create the required approval preview, so no email was changed.',
      });
      return;
    }
    setMutatingThread(true);
    try {
      if(action==='mark-unread')displayedOpening.current.suppress();
      const result = await api.prepareSelection({
        action,
        organization,
        targets: threads.map((thread) => ({
          provider: thread.provider,
          accountId: thread.accountId,
          threadId: thread.id,
        })),
      });
      if (!result.success || !result.plan) {
        throw new Error(result.clarification || result.error || 'Dream Claw could not verify this selection.');
      }
      setPendingMailAction(result.plan);
    } catch (error: any) {
      addNotification({
        category: 'error',
        severity: 'error',
        title: 'Action preview failed',
        body: error?.message || 'No email was changed.',
      });
    } finally {
      setMutatingThread(false);
    }
  }, [addNotification, mutatingThread]);

  const handleThreadMutation = useCallback(async (mutation: 'mark-read' | 'mark-unread' | 'archive' | 'delete') => {
    if (!selectedThreadItem || !selectedAccount) return;
    if(mutation==='mark-unread')displayedOpening.current.suppress();
    await prepareInboxMailAction([selectedThreadItem], mutation);
  }, [prepareInboxMailAction, selectedAccount, selectedThreadItem]);

  const handleToggleFlag = useCallback(async () => {
    if (!selectedThreadItem || !selectedAccount) return;
    await prepareInboxMailAction([selectedThreadItem], selectedThreadItem.isFlagged ? 'unflag' : 'flag');
  }, [prepareInboxMailAction, selectedAccount, selectedThreadItem]);

  const handleSenderAction = useCallback(async (action: 'unsubscribe' | 'block-sender' | 'unblock-sender') => {
    if (!selectedThreadItem || !selectedAccount) return;
    await prepareInboxMailAction([selectedThreadItem], action);
  }, [prepareInboxMailAction, selectedAccount, selectedThreadItem]);

  const handleTogglePin = useCallback(() => {
    if (!selectedThreadItem) return;
    const storageKey = getInboxThreadKey(selectedThreadItem);
    setPinnedThreadKeys((current) => current.includes(storageKey)
      ? current.filter((value) => value !== storageKey)
      : [storageKey, ...current]);
  }, [selectedThreadItem]);

  const handleToggleRowPin = useCallback((thread: InboxThreadItem) => {
    const storageKey = getInboxThreadKey(thread);
    setPinnedThreadKeys((current) => current.includes(storageKey)
      ? current.filter((value) => value !== storageKey)
      : [storageKey, ...current]);
  }, []);

  const handleToggleRowFlag = useCallback(async (thread: InboxThreadItem) => {
    await prepareInboxMailAction([thread], thread.isFlagged ? 'unflag' : 'flag');
  }, [prepareInboxMailAction]);

  const handleBulkThreadMutation = useCallback(async (mutation: 'mark-read' | 'mark-unread' | 'archive' | 'delete') => {
    if (selectedThreadItems.length === 0) return;
    await prepareInboxMailAction(selectedThreadItems, mutation);
  }, [prepareInboxMailAction, selectedThreadItems]);

  const handleBulkFlagToggle = useCallback(async () => {
    if (selectedThreadItems.length === 0) return;
    const shouldFlag = !allSelectedFlagged;
    await prepareInboxMailAction(selectedThreadItems, shouldFlag ? 'flag' : 'unflag');
  }, [allSelectedFlagged, prepareInboxMailAction, selectedThreadItems]);

  const handleBulkPinToggle = useCallback(() => {
    if (selectedThreadItems.length === 0) return;
    const nextKeys = selectedThreadItems.map((thread) => getInboxThreadKey(thread));
    setPinnedThreadKeys((current) => {
      const currentSet = new Set(current);
      if (allSelectedPinned) {
        for (const key of nextKeys) currentSet.delete(key);
      } else {
        for (const key of nextKeys) currentSet.add(key);
      }
      return [...currentSet];
    });
  }, [allSelectedPinned, selectedThreadItems]);

  const openMailRail = useCallback(() => {
    if (isCompactMailLayout) setIsMailRailOpen(true);
    else setIsMailRailCollapsed(false);
  }, [isCompactMailLayout]);

  const closeMailRail = useCallback(() => {
    setShowAccountPicker(false);
    if (isCompactMailLayout) {
      setIsMailRailOpen(false);
      window.requestAnimationFrame(() => mailRailTriggerRef.current?.focus());
      return;
    }
    setIsMailRailCollapsed(true);
    window.requestAnimationFrame(() => mailRailTriggerRef.current?.focus());
  }, [isCompactMailLayout]);

  const resizeMailRailBy = useCallback((amount: number) => {
    setIsMailRailCollapsed(false);
    setMailRailWidth((current) => Math.min(MAX_MAIL_RAIL_WIDTH, Math.max(MIN_MAIL_RAIL_WIDTH, current + amount)));
  }, []);

  const handleApplyNativeTag = useCallback(async (tagId: string) => {
    if (!bulkSelectionScope || selectedThreadItems.length === 0) return;
    const shouldApply = !selectedThreadItems.every((thread) => thread.providerTags.includes(tagId));
    setShowNativeTagMenu(false);
    await prepareInboxMailAction(
      selectedThreadItems,
      shouldApply ? 'organize' : 'remove-organization',
      tagId,
    );
  }, [bulkSelectionScope, prepareInboxMailAction, selectedThreadItems]);

  const handleCreateNativeCategory = useCallback(async () => {
    const categoryName = normalizeInboxCategoryName(newCategoryName);
    if (!bulkSelectionScope || selectedThreadItems.length === 0) return;
    if (categoryName.length < 2) {
      setNativeTagOptionsError('Enter a category name with at least two characters.');
      return;
    }
    setNativeTagOptionsError(null);
    setShowNativeTagMenu(false);
    setNewCategoryName('');
    await prepareInboxMailAction(selectedThreadItems, 'organize', categoryName);
  }, [bulkSelectionScope, newCategoryName, prepareInboxMailAction, selectedThreadItems]);

  const navigateToThread = useCallback((thread: InboxThreadItem | null) => {
    if (!thread) return;
    setSelectedThread({
      provider: thread.provider,
      accountKey: thread.accountKey,
      threadId: thread.id,
    });
  }, []);

  const handleReplyDelivery = useCallback(async (mode: 'draft' | 'send') => {
    if (!selectedThreadItem || !selectedAccount?.generation || !replySourceMessage) return;
    if (!replyBody.trim() && !replyFiles.entries.length) { setReplyError('Write the reply first.'); return; }
    if (!replyRecipients.to.length) { setReplyError('No reply recipient could be inferred from this thread.'); return; }
    const signatureHtml = includeSignature
      ? selectedThreadItem.provider === 'gmail' ? String(selectedAlias?.signature || '') : buildManualSignatureHtml(microsoftSignatureDraft)
      : '';
    setReplyError(null); mode === 'send' ? setSendingReply(true) : setSavingDraft(true);
    try {
      await host.delivery.prepare(replyJournalKey, {
        epoch: host.epoch, accountId: selectedAccount.accountId, generation: selectedAccount.generation, mode, files:host.files.selection(replyJournalKey,replyFileReview),
        message: { from: selectedThreadItem.provider === 'gmail' ? selectedAlias?.sendAsEmail || selectedAccount.email : selectedAccount.email,
          to: replyRecipients.to, cc: replyRecipients.cc, bcc: [], subject: ensureReplySubject(replySubject),
          bodyText: buildNativeGmailReplyPlainText(replyBody, signatureHtml), bodyHtml: buildNativeGmailReplyHtml(replyBody, signatureHtml), attachments: [],
          reply: { threadId: selectedThreadItem.id, messageId: replySourceMessage.id, quote: selectedThreadItem.provider === 'gmail' } },
      });
    } catch (error) {
      addNotification({ category: 'error', severity: 'error', title: 'Mail review needs attention', body: error instanceof Error ? error.message : 'Open the original reply to check its saved status.' });
    } finally { mode === 'send' ? setSendingReply(false) : setSavingDraft(false); }
  }, [host.delivery, host.files, host.epoch, replyFileReview, replyFiles.entries.length, replyJournalKey, addNotification, includeSignature, microsoftSignatureDraft, replyBody, replyRecipients.cc, replyRecipients.to, replySourceMessage, replySubject, selectedAccount, selectedAlias?.sendAsEmail, selectedAlias?.signature, selectedThreadItem]);
  const handleSaveDraft = () => handleReplyDelivery('draft');
  const handleSendReply = () => handleReplyDelivery('send');

  const handleStartMicrosoftAuth = useCallback(async () => { host.openSettings(); }, [host.openSettings]);

  const handleFinishMicrosoftAuth = useCallback(async () => {
    if (!pendingMicrosoftAuth?.deviceCode) return;
    setMicrosoftAuthBusy(true);
    setMicrosoftAuthError(null);
    try {
      const result = await completeNativeMicrosoftDeviceAuth({
        deviceCode: pendingMicrosoftAuth.deviceCode,
        tenant: pendingMicrosoftAuth.tenant,
        interval: pendingMicrosoftAuth.interval,
        expiresAt: pendingMicrosoftAuth.expiresAt,
      });
      if (!result.success) {
        throw new Error(result.error || 'Microsoft sign-in failed.');
      }
      setPendingMicrosoftAuth(null);
      addNotification({
        category: 'system',
        severity: 'success',
        title: 'Outlook connected',
        body: result.account ? `${result.account.email} is ready in the inbox panel.` : 'Microsoft inbox account connected.',
      });
      await loadInbox(true);
    } catch (authError: any) {
      setMicrosoftAuthError(authError?.message || 'Microsoft sign-in failed.');
    } finally {
      setMicrosoftAuthBusy(false);
    }
  }, [addNotification, loadInbox, pendingMicrosoftAuth]);

  const handleDisconnectMicrosoftAccount = useCallback(async (_accountId: string) => { host.openSettings(); }, [host.openSettings]);

  const handleSaveMicrosoftSignature = useCallback(async () => {
    if (!selectedAccount || selectedAccount.provider !== 'microsoft') return;
    setSavingMicrosoftSignature(true);
    setReplyError(null);
    try {
      const result = await updateNativeMicrosoftSignature({
        accountId: selectedAccount.accountId,
        signatureText: microsoftSignatureDraft,
      });
      if (!result.success || !result.account) {
        throw new Error(result.error || 'Microsoft signature update failed.');
      }

      setInboxMicrosoftAccounts((current) => current.map((account) => (
        account.id === result.account?.id ? result.account : account
      )));

      addNotification({
        category: 'system',
        severity: 'success',
        title: 'Outlook signature saved',
        body: result.account.hasSignature
          ? `Saved signature for ${result.account.email}.`
          : `Cleared signature for ${result.account.email}.`,
      });

      setIncludeSignature(Boolean(result.account.hasSignature));
    } catch (saveError: any) {
      setReplyError(saveError?.message || 'Microsoft signature update failed.');
      addNotification({
        category: 'error',
        severity: 'error',
        title: 'Signature save failed',
        body: saveError?.message || 'The Outlook signature could not be updated.',
      });
    } finally {
      setSavingMicrosoftSignature(false);
    }
  }, [addNotification, microsoftSignatureDraft, selectedAccount]);

  const inboxFilterPanel = showInboxOptions && inboxOptionsGeometry && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={inboxOptionsPanelRef}
        data-inbox-options-panel
        data-placement={inboxOptionsGeometry.placement}
        role="dialog"
        aria-label="Inbox filters"
        className="dc-inbox-filter-panel z-[70] overflow-y-auto rounded-2xl border border-aegis-border bg-aegis-menu-bg p-4 shadow-2xl"
        style={{
          position: 'fixed',
          top: inboxOptionsGeometry.top,
          left: inboxOptionsGeometry.left,
          width: inboxOptionsGeometry.width,
          maxHeight: inboxOptionsGeometry.maxHeight,
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[13px] font-bold text-aegis-text">Filter inbox</div>
            <div className="text-[10.5px] leading-4 text-aegis-text-dim">Narrow the email list, then choose how results are organized.</div>
          </div>
          <button type="button" onClick={() => { setShowInboxOptions(false); inboxOptionsTriggerRef.current?.focus(); }} aria-label="Close inbox filters" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-aegis-text-dim hover:bg-[rgb(var(--aegis-overlay)/0.06)]"><X size={14} /></button>
        </div>

        <section className="mt-4" aria-labelledby="inbox-filter-section">
          <div id="inbox-filter-section" className="text-[9px] font-semibold uppercase tracking-[0.12em] text-aegis-text-dim">Filters</div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-[10px] font-semibold uppercase tracking-[0.1em] text-aegis-text-dim">Needs
              <select value={bucketFilter} onChange={(event) => setBucketFilter(normalizeInboxBucket(event.target.value))} className="field-input mt-1.5 !min-h-10 !rounded-xl !px-2">
                <option value="all">All email</option>
                <option value="safe_review">Safe review</option>
                <option value="urgent">Urgent</option>
                <option value="needs_reply">Needs reply</option>
                <option value="waiting">Waiting</option>
                <option value="fyi">FYI</option>
              </select>
            </label>
            <label className="text-[10px] font-semibold uppercase tracking-[0.1em] text-aegis-text-dim">Category
              <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as InboxCategoryFilter)} className="field-input mt-1.5 !min-h-10 !rounded-xl !px-2">
                <option value="all">All triage</option>
                {(['account_billing_action_required', 'updates_tools', 'personal_outreach', 'calendar_logistics', 'promo_social', 'other'] as InboxCategoryFilter[]).filter((category) => (categoryCounts.get(category) || 0) > 0).map((category) => <option key={category} value={category}>{triageCategoryLabel(category)} ({categoryCounts.get(category) || 0})</option>)}
              </select>
            </label>
          </div>
          <div className="mt-2 rounded-xl border border-aegis-border bg-aegis-elevated px-3 py-2.5">
            <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-aegis-text-dim">Accounts shown</div>
            <div className="mt-1 truncate text-[11.5px] font-semibold text-aegis-text">{accountPickerLabel}</div>
            <div className="mt-0.5 text-[9.5px] leading-4 text-aegis-text-dim">Choose inboxes from Accounts in the mail sidebar.</div>
          </div>
          {activeInboxFilterCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setAccountFilter('all');
                setBucketFilter('all');
                setCategoryFilter('all');
                setThreadPage(1);
              }}
              className="mt-2 inline-flex h-8 items-center rounded-lg border border-aegis-border px-2.5 text-[10.5px] font-semibold text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)]"
            >
              Clear {activeInboxFilterCount === 1 ? 'filter' : `${activeInboxFilterCount} filters`}
            </button>
          )}
        </section>

        <section className="mt-4 border-t border-aegis-border pt-3" aria-labelledby="inbox-organize-section">
          <div id="inbox-organize-section" className="text-[9px] font-semibold uppercase tracking-[0.12em] text-aegis-text-dim">Organize and display</div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-[10px] font-semibold uppercase tracking-[0.1em] text-aegis-text-dim">Group
              <select value={grouping} onChange={(event) => setGrouping(event.target.value as InboxGrouping)} className="field-input mt-1.5 !min-h-10 !rounded-xl !px-2">
                <option value="topic">Smart topic</option><option value="sender">Sender</option><option value="recipient">Account</option><option value="none">No grouping</option>
              </select>
            </label>
            <label className="text-[10px] font-semibold uppercase tracking-[0.1em] text-aegis-text-dim">Emails per page
              <select value={threadsPerPage} onChange={event => setThreadsPerPage(normalizeInboxPageSize(event.target.value))} aria-label="Emails per page" className="field-input mt-1.5 !min-h-10 !rounded-xl !px-2">
                {INBOX_PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <label className="text-[10px] font-semibold uppercase tracking-[0.1em] text-aegis-text-dim">Spacing
              <select value={density} onChange={(event) => setDensity(event.target.value as InboxDensity)} className="field-input mt-1.5 !min-h-10 !rounded-xl !px-2">
                <option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="spacious">Spacious</option>
              </select>
            </label>
          </div>
        </section>

        <div className="mt-4 border-t border-aegis-border pt-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-aegis-text-dim">Connected accounts</div>
          <div className="max-h-36 space-y-1.5 overflow-y-auto">
            {gmailAccounts.map((account) => <div key={`gmail:${account.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px]"><span className={clsx('rounded-full border px-2 py-0.5 text-[9px]', providerTone('gmail'))}>Gmail</span><span className="min-w-0 flex-1 truncate text-aegis-text">{account.email}</span></div>)}
            {microsoftAccounts.map((account) => <div key={`microsoft:${account.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px]"><span className={clsx('rounded-full border px-2 py-0.5 text-[9px]', providerTone('microsoft'))}>Outlook</span><span className="min-w-0 flex-1 truncate text-aegis-text">{account.email}</span><button type="button" onClick={() => void handleDisconnectMicrosoftAccount(account.id)} disabled={disconnectingAccountKey === account.id} aria-label={`Disconnect ${account.email}`} className="grid h-7 w-7 place-items-center rounded-lg text-aegis-text-dim hover:bg-red-400/10 hover:text-red-300">{disconnectingAccountKey === account.id ? <Loader2 size={12} className="animate-spin" /> : <Unplug size={12} />}</button></div>)}
          </div>
          <button type="button" onClick={() => void handleStartMicrosoftAuth()} disabled={microsoftAuthBusy} className="mt-2 inline-flex h-9 items-center gap-2 rounded-xl border border-aegis-primary/25 bg-aegis-primary/10 px-3 text-[11px] font-semibold text-aegis-primary disabled:opacity-50">
            {microsoftAuthBusy ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}{microsoftAccounts.length > 0 ? 'Add Microsoft account' : 'Connect Outlook / Live'}
          </button>
        </div>
      </div>,
      host.portal,
    )
    : null;

  return (
    <PageTransition className="flex flex-1 min-h-0 flex-col overflow-hidden">
      {linkedState.target && <div className="inbox-source-banner" role={linkedState.error || linkedState.storageError ? 'alert' : 'status'}>
        <span><strong>{linkedState.target.eventId ? 'Email linked from Calendar' : 'Email linked from Contacts'}</strong><span>{linkedState.storageError || linkedState.error || (linkedEmail ? linkedEmail.account.email : 'Opening the original account and conversation…')}</span></span>
        <div><button disabled={linkedState.status === 'loading'} onClick={() => void host.source.load(availableAccounts, host.scopeVersion, true)}>{linkedState.status === 'loading' ? 'Opening…' : linkedState.error ? 'Retry opening email' : 'Refresh email'}</button>{linkedState.error && <button onClick={host.openSettings}>Connections</button>}<button onClick={() => host.source.close()}>Return to folder</button></div>
      </div>}

      <div
        className="dc-inbox-workspace relative grid h-full min-h-0 flex-1 overflow-hidden"
        data-rail-open={isMailRailOpen ? 'true' : 'false'}
        data-rail-collapsed={isMailRailCollapsed ? 'true' : 'false'}
        style={{
          '--dc-inbox-rail-width': `${mailRailWidth}px`,
        } as CSSProperties}
      >
        <button
          type="button"
          aria-label="Close mail sidebar"
          onClick={() => setIsMailRailOpen(false)}
          className="dc-inbox-rail-scrim"
        />
        <aside id="mail-organization-rail" ref={mailRailRef} className="dc-inbox-mail-rail flex min-h-0 flex-col border-r border-aegis-border/70 bg-aegis-card-solid" aria-label="Mail folders and organization">
          <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
            <div>
              <div className="text-[12px] font-bold text-aegis-text">Mail</div>
              <div className="text-[10px] text-aegis-text-dim">Your connected accounts</div>
            </div>
            <button
              type="button"
              onClick={closeMailRail}
              aria-label="Hide mail sidebar"
              title="Hide mail sidebar"
              aria-controls="mail-organization-rail"
              aria-expanded={isCompactMailLayout ? isMailRailOpen : !isMailRailCollapsed}
              className="dc-inbox-rail-close inline-flex h-8 w-8 items-center justify-center rounded-lg text-aegis-text-dim hover:bg-[rgb(var(--aegis-overlay)/0.06)]"
            >
              <PanelLeftClose size={15} />
            </button>
          </div>

          <div ref={accountPickerRef} className="relative px-3 pb-2">
            <button
              ref={accountPickerTriggerRef}
              type="button"
              onClick={() => setShowAccountPicker((current) => !current)}
              disabled={availableAccounts.length === 0}
              aria-haspopup="menu"
              aria-expanded={showAccountPicker}
              aria-label="Choose inbox accounts"
              className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-aegis-border bg-aegis-elevated px-3 py-2 text-left transition-colors hover:border-aegis-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aegis-primary/35 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Mail size={15} className="shrink-0 text-aegis-primary" />
              <span className="min-w-0 flex-1">
                <span className="block text-[9px] font-bold uppercase tracking-[0.13em] text-aegis-text-dim">Accounts</span>
                <span className="block truncate text-[11.5px] font-semibold text-aegis-text">{accountPickerLabel}</span>
              </span>
              <ChevronDown size={14} className={clsx('shrink-0 text-aegis-text-dim transition-transform motion-reduce:transition-none', showAccountPicker && 'rotate-180')} />
            </button>

            {showAccountPicker && (
              <div
                role="menu"
                aria-label="Choose inbox accounts"
                className="absolute left-3 right-3 top-full z-50 mt-1.5 overflow-hidden rounded-xl border border-aegis-border bg-aegis-menu-bg p-1.5 shadow-2xl"
                onKeyDown={(event) => {
                  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]:not(:disabled)'));
                  if (items.length === 0) return;
                  event.preventDefault();
                  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
                  if (event.key === 'Home') items[0]?.focus();
                  else if (event.key === 'End') items[items.length - 1]?.focus();
                  else if (event.key === 'ArrowDown') items[(currentIndex + 1 + items.length) % items.length]?.focus();
                  else items[(currentIndex - 1 + items.length) % items.length]?.focus();
                }}
              >
                <div className="px-2 pb-1.5 pt-1 text-[9.5px] leading-4 text-aegis-text-dim">Choose one or more inboxes to view together.</div>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={accountFilter === 'all'}
                  onClick={() => { setAccountFilter('all'); setThreadPage(1); }}
                  className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-[11px] text-aegis-text hover:bg-[rgb(var(--aegis-overlay)/0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-aegis-primary/35"
                >
                  <span className={clsx('grid h-4 w-4 shrink-0 place-items-center rounded border', accountFilter === 'all' ? 'border-aegis-primary bg-aegis-primary text-aegis-bg' : 'border-aegis-border bg-aegis-elevated')} aria-hidden="true">
                    {accountFilter === 'all' && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 font-semibold">All inboxes</span>
                  <span className="text-[9.5px] tabular-nums text-aegis-text-dim">{availableAccounts.length}</span>
                </button>
                <div className="my-1 border-t border-aegis-border/70" />
                {availableAccounts.map((account) => {
                  const checked = accountFilter !== 'all' && selectedAccountKeySet.has(account.key);
                  const cannotClearLast = checked && selectedAccountKeySet.size === 1;
                  return (
                    <button
                      key={account.key}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      disabled={cannotClearLast}
                      title={cannotClearLast ? 'At least one inbox must stay selected' : account.email}
                      onClick={() => {
                        setAccountFilter((current) => toggleInboxAccountFilter(current, account.key, availableAccountKeys));
                        setThreadPage(1);
                      }}
                      className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[10.5px] text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.06)] hover:text-aegis-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-aegis-primary/35 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className={clsx('grid h-4 w-4 shrink-0 place-items-center rounded border', checked ? 'border-aegis-primary bg-aegis-primary text-aegis-bg' : 'border-aegis-border bg-aegis-elevated')} aria-hidden="true">
                        {checked && <Check size={11} strokeWidth={3} />}
                      </span>
                      <span className={clsx('h-2 w-2 shrink-0 rounded-full', account.provider === 'gmail' ? 'bg-red-400' : 'bg-sky-400')} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-medium text-aegis-text">{account.email}</span>
                        <span className="block text-[9px] text-aegis-text-dim">{account.provider === 'gmail' ? 'Gmail' : 'Outlook'}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="px-3 pb-3">
            <button
              type="button"
              onClick={(event) => {
                composeTriggerRef.current = event.currentTarget;
                openCompose();
              }}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-aegis-primary/35 bg-aegis-primary px-3 text-[12px] font-bold text-aegis-bg shadow-[0_5px_0_rgb(var(--aegis-primary-hover)/0.35)] transition-transform hover:-translate-y-px active:translate-y-0"
            >
              <Edit3 size={15} />
              Compose
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin">
            <div className="px-2 pb-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-aegis-text-dim">Folders</div>
            <nav aria-label="Mail folders" className="space-y-0.5">
              {INBOX_MAIL_FOLDERS.map((folder) => {
                const active = activeFolder === folder.id && bucketFilter === 'all' && categoryFilter === 'all';
                const count = folder.id === 'inbox'
                  ? bucketCounts.all
                  : activeFolder === folder.id ? allThreadItems.length : undefined;
                return (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => {
                      if (host.source.store.getState().target && !host.source.close()) return; setActiveFolder(folder.id);
                      setBucketFilter('all');
                      setCategoryFilter('all');
                      setIsMailRailOpen(false);
                    }}
                    aria-current={active ? 'page' : undefined}
                    title={folder.description}
                    className={clsx(
                      'flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aegis-primary/35',
                      active
                        ? 'bg-aegis-primary/14 text-aegis-primary'
                        : 'text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)] hover:text-aegis-text',
                    )}
                  >
                    <InboxFolderIcon folder={folder.id} />
                    <span className="min-w-0 flex-1 truncate">{folder.label}</span>
                    {typeof count === 'number' && <span className="text-[10px] tabular-nums text-aegis-text-dim">{count}</span>}
                  </button>
                );
              })}
            </nav>

            <div className="mt-4 px-2 pb-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-aegis-text-dim">Smart views</div>
            <nav aria-label="Smart mail views" className="space-y-0.5">
              {([
                ['urgent', 'Priority', AlertCircle],
                ['needs_reply', 'Needs reply', Reply],
                ['waiting', 'Waiting', Clock],
                ['safe_review', 'Safe review', ShieldAlert],
              ] as const).map(([bucket, label, Icon]) => {
                const active = activeFolder === 'inbox' && bucketFilter === bucket;
                return (
                  <button
                    key={bucket}
                    type="button"
                    onClick={() => {
                      if (host.source.store.getState().target && !host.source.close()) return; setActiveFolder('inbox');
                      setBucketFilter(bucket);
                      setCategoryFilter('all');
                      setIsMailRailOpen(false);
                    }}
                    aria-pressed={active}
                    className={clsx(
                      'flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aegis-primary/35',
                      active ? 'bg-aegis-primary/14 font-semibold text-aegis-primary' : 'text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)] hover:text-aegis-text',
                    )}
                  >
                    <Icon size={15} />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span className="text-[10px] tabular-nums text-aegis-text-dim">{bucketCounts[bucket]}</span>
                  </button>
                );
              })}
            </nav>

            <div className="mt-4 px-2 pb-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-aegis-text-dim">Categories</div>
            <nav aria-label="Mail categories" className="space-y-0.5">
              {(['account_billing_action_required', 'personal_outreach', 'calendar_logistics', 'updates_tools', 'promo_social'] as InboxCategoryFilter[]).map((category) => {
                const active = activeFolder === 'inbox' && categoryFilter === category;
                return (
                  <button
                    key={category}
                    type="button"
                    onClick={() => {
                      if (host.source.store.getState().target && !host.source.close()) return; setActiveFolder('inbox');
                      setBucketFilter('all');
                      setCategoryFilter(category);
                      setIsMailRailOpen(false);
                    }}
                    aria-pressed={active}
                    className={clsx(
                      'flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aegis-primary/35',
                      active ? 'bg-aegis-primary/14 font-semibold text-aegis-primary' : 'text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)] hover:text-aegis-text',
                    )}
                  >
                    <Tag size={14} />
                    <span className="min-w-0 flex-1 truncate">{categoryLabel(category)}</span>
                    {activeFolder === 'inbox' && (categoryCounts.get(category) || 0) > 0 && (
                      <span className="text-[10px] tabular-nums text-aegis-text-dim">{categoryCounts.get(category)}</span>
                    )}
                  </button>
                );
              })}
            </nav>

            {followUpQueue[0] && (() => {
              const thread = followUpQueue[0];
              const plan = followUpPlans.get(getInboxThreadKey(thread));
              return (
                <div className="mt-4 rounded-xl border border-aegis-primary/15 bg-aegis-primary/5 p-2.5">
                  <div className="flex items-start gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        if (host.source.store.getState().target && !host.source.close()) return; setActiveFolder('inbox');
                        setBucketFilter(thread.bucket);
                        setSelectedThread({ provider: thread.provider, accountKey: thread.accountKey, threadId: thread.id });
                        setCompactReaderOpen(true);
                        setIsMailRailOpen(false);
                      }}
                      className="min-w-0 flex-1 p-0.5 text-left"
                    >
                      <div className="text-[9px] font-bold uppercase tracking-[0.13em] text-aegis-primary">Next follow-up</div>
                      <div className="mt-1.5 line-clamp-2 text-[11px] font-semibold leading-4 text-aegis-text">{thread.subject}</div>
                      {plan && <div className="mt-1 text-[9.5px] text-aegis-text-dim">Follow up {plan.label}</div>}
                    </button>
                    <button type="button" onClick={() => void scheduleFollowUpReminder(thread)} disabled={!!followupBusy[JSON.stringify([thread.provider==='gmail'?'google':'microsoft',thread.accountId,thread.id])]} aria-label="Schedule this follow-up" title="Schedule follow-up" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-aegis-border/70 text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.06)]"><Clock size={13} /></button>
                  </div>
                  <div className="mt-2 border-t border-aegis-border/50 pt-2 text-[9.5px] text-aegis-text-dim">{followUpPressureCount} need action · {bucketCounts.waiting} waiting</div>
                </div>
              );
            })()}

          </div>

          <button
            type="button"
            onClick={() => {
              setCompactReaderOpen(false);
              setIsListPaneCollapsed(false);
              setShowInboxOptions(true);
              setIsMailRailOpen(false);
            }}
            className="m-2 mt-0 flex h-9 items-center gap-2 rounded-lg px-2.5 text-[11px] text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)] hover:text-aegis-text"
          >
            <Filter size={15} />
            Filters and views
          </button>
          <div
            role="separator"
            aria-label="Resize mail sidebar"
            aria-orientation="vertical"
            aria-valuemin={MIN_MAIL_RAIL_WIDTH}
            aria-valuemax={MAX_MAIL_RAIL_WIDTH}
            aria-valuenow={Math.round(mailRailWidth)}
            aria-valuetext={`${Math.round(mailRailWidth)} pixels wide`}
            tabIndex={0}
            className="dc-inbox-rail-resizer"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              mailRailResizeRef.current = { startX: event.clientX, startWidth: mailRailWidth };
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                resizeMailRailBy(-16);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                resizeMailRailBy(16);
              } else if (event.key === 'Home') {
                event.preventDefault();
                setMailRailWidth(MIN_MAIL_RAIL_WIDTH);
              } else if (event.key === 'End') {
                event.preventDefault();
                setMailRailWidth(MAX_MAIL_RAIL_WIDTH);
              }
            }}
          />
        </aside>

        <main className="dc-inbox-main flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden px-3 py-3 sm:px-4 lg:px-5 lg:py-4">
        <div className="dc-inbox-page-header-stack flex flex-col gap-2.5">
          <div className="dc-inbox-page-header flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="dc-inbox-page-identity min-w-0 flex flex-1 flex-wrap items-center gap-3">
              <button
                ref={mailRailTriggerRef}
                type="button"
                onClick={openMailRail}
                aria-label="Show mail sidebar"
                title="Show mail sidebar"
                aria-controls="mail-organization-rail"
                aria-expanded={isCompactMailLayout ? isMailRailOpen : !isMailRailCollapsed}
                className="dc-inbox-rail-toggle inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-aegis-border bg-aegis-elevated text-aegis-text-muted hover:text-aegis-text"
              >
                <PanelLeftOpen size={16} />
              </button>
              <div className="dc-inbox-page-heading min-w-0 max-w-full text-aegis-text">
                  <h1 className="truncate text-[18px] font-bold tracking-tight text-aegis-text">{activeFolderDefinition.label}</h1>
                  <div className="dc-inbox-page-status flex max-w-full flex-wrap items-center gap-1.5 text-[12px] text-aegis-text-dim tabular-nums">
                    <span className="min-w-0 max-w-full">
                      {loading && snapshots.length === 0
                        ? `Opening ${activeFolderDefinition.label.toLowerCase()}…`
                        : activeFolder === 'inbox'
                          ? inboxCoverageLabel
                          : `${inboxCoverage.loadedConversations.toLocaleString('en-US')} conversations loaded`}
                    </span>
                  </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedThreadItems.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-aegis-border/70 bg-[rgb(var(--aegis-overlay)/0.03)] px-2 py-1.5 text-[10.5px]">
                    <span className="font-medium text-aegis-text">
                      {selectedThreadItems.length} selected
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleBulkThreadMutation('mark-read')}
                      disabled={mutatingThread || !selectedThreadsCanModify}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-aegis-border px-2 py-1 text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <MailCheck size={12} />
                      Read
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleBulkThreadMutation('mark-unread')}
                      disabled={mutatingThread || !selectedThreadsCanModify}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-aegis-border px-2 py-1 text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Mail size={12} />
                      Unread
                    </button>
                    <button
                      type="button"
                      onClick={handleBulkFlagToggle}
                      disabled={mutatingThread || !selectedThreadsCanModify}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-aegis-border px-2 py-1 text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {bulkSelectionScope?.provider === 'microsoft' ? (
                        <Flag size={12} className={clsx(allSelectedFlagged && 'text-aegis-primary')} />
                      ) : (
                        <Star size={12} className={clsx(allSelectedFlagged && 'fill-current text-amber-300')} />
                      )}
                      {bulkSelectionScope?.provider === 'microsoft'
                        ? (allSelectedFlagged ? 'Unflag' : 'Flag')
                        : (allSelectedFlagged ? 'Unstar' : 'Star')}
                    </button>
                    <button
                      type="button"
                      onClick={handleBulkPinToggle}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-aegis-border px-2 py-1 text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)]"
                    >
                      <Pin size={12} className={clsx(allSelectedPinned && 'text-amber-300')} />
                      {allSelectedPinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleBulkThreadMutation('archive')}
                      disabled={mutatingThread || !selectedThreadsCanModify || activeFolder !== 'inbox'}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-aegis-border px-2 py-1 text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Archive size={12} />
                      Archive
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleBulkThreadMutation('delete')}
                      disabled={mutatingThread || !selectedThreadsCanModify || activeFolder === 'trash'}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 px-2 py-1 text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                    <div ref={nativeTagMenuRef} className="relative">
                      <button
                        type="button"
                        onClick={toggleNativeTagMenu}
                        disabled={mutatingThread || !bulkSelectionScope || !selectedThreadsCanModify}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-aegis-border px-2 py-1 text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Tag size={12} />
                        {nativeTagActionLabel}
                      </button>
                      {showNativeTagMenu && bulkSelectionScope && (
                        <div className="absolute left-0 z-20 mt-2 w-[min(300px,calc(100vw-32px))] rounded-xl border border-[rgb(var(--aegis-overlay)/0.18)] bg-aegis-menu-bg p-2 shadow-2xl">
                          <form
                            className="mb-2 rounded-lg border border-aegis-border/70 bg-aegis-elevated p-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void handleCreateNativeCategory();
                            }}
                          >
                            <label className="block text-[9px] font-bold uppercase tracking-[0.1em] text-aegis-text-dim" htmlFor="new-mail-category">Create category</label>
                            <div className="mt-1.5 flex items-center gap-1.5">
                              <input
                                id="new-mail-category"
                                value={newCategoryName}
                                onChange={(event) => { setNewCategoryName(event.target.value); setNativeTagOptionsError(null); }}
                                maxLength={64}
                                placeholder="Receipts, school, travel…"
                                className="h-9 min-w-0 flex-1 rounded-lg border border-aegis-border bg-aegis-card-solid px-2.5 text-[11px] text-aegis-text outline-none placeholder:text-aegis-text-dim focus:border-aegis-primary"
                              />
                              <button
                                type="submit"
                                disabled={normalizeInboxCategoryName(newCategoryName).length < 2 || mutatingThread}
                                className="inline-flex h-9 shrink-0 items-center rounded-lg border border-aegis-primary/30 bg-aegis-primary px-2.5 text-[10.5px] font-bold text-aegis-bg disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Review
                              </button>
                            </div>
                            <p className="mt-1.5 text-[9.5px] leading-4 text-aegis-text-dim">Creates the provider category and applies it to the selected emails only after you approve the review.</p>
                          </form>
                          {nativeTagOptionsLoading ? (
                            <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-aegis-text-dim">
                              <Loader2 size={12} className="animate-spin" />
                              Loading {nativeTagActionLabel.toLowerCase()}…
                            </div>
                          ) : nativeTagOptionsError ? (
                            <div className="px-3 py-2 text-[11px] text-red-300">{nativeTagOptionsError}</div>
                          ) : nativeTagOptions.length === 0 ? (
                            <div className="px-3 py-2 text-[11px] text-aegis-text-dim">No {nativeTagActionLabel.toLowerCase()} available.</div>
                          ) : (
                            nativeTagOptions.map((option) => {
                              const appliedCount = selectedThreadItems.filter((thread) => thread.providerTags.includes(option.id)).length;
                              const fullyApplied = appliedCount === selectedThreadItems.length;
                              const partiallyApplied = appliedCount > 0 && !fullyApplied;
                              return (
                                <button
                                  key={option.id}
                                  type="button"
                                  onClick={() => void handleApplyNativeTag(option.id)}
                                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] text-aegis-text hover:bg-white/5"
                                >
                                  <span className="inline-flex h-4 w-4 items-center justify-center text-aegis-text-dim">
                                    {fullyApplied ? <Check size={12} /> : partiallyApplied ? <Minus size={12} /> : null}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedThreadKeys([])}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-aegis-border px-2 py-1 text-aegis-text-dim hover:bg-[rgb(var(--aegis-overlay)/0.05)]"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="dc-inbox-page-actions flex items-center gap-2 xl:justify-end">
    {Object.values(triageState.records).some(record => record.plan || record.pending) && <details className="inbox-action-history" ref={reviewHistoryRef} onToggle={event=>setReviewHistoryOpen(event.currentTarget.open)} onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary aria-label="Action reviews" title="Action reviews"><Clock size={17}/><span className="sr-only">Action reviews</span></summary><div>
      {Object.entries(triageState.records).filter(([,record])=>record.plan||record.pending).reverse().map(([id,record])=><div className="inbox-action-history-row" key={id}>
        <button disabled={triageState.busy} onClick={()=>{if(reviewHistoryRef.current)reviewHistoryRef.current.open=false;if(record.plan)host.triage.open(record.plan.id);else void host.triage.check(id).catch(error=>host.addNotification({title:'Review not confirmed',body:error.message,severity:'error'}));}}>{record.plan?.summary??'Recover preparing review'}<small>{record.plan?.resultMessage??record.plan?.status.replaceAll('_',' ')??'Preparing'}{record.pending?' · Check unconfirmed response':''}</small></button>
        {record.error && <span role="status">{record.error}</span>}
      </div>)}
    </div></details>}

              <button
                type="button"
                onClick={(event) => {
                  composeTriggerRef.current = event.currentTarget;
                  openCompose();
                }}
                className="dc-inbox-header-compose inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-aegis-primary/30 bg-aegis-primary px-3 text-[12px] font-bold text-aegis-bg"
                aria-label="Compose"
                title="Compose"
              >
                <Edit3 size={15} />
                <span className="hidden sm:inline">Compose</span>
              </button>
                <details className="dc-inbox-sync"><summary><span className={activeIndexError ? 'dc-sync-warning' : ''}>{folderStatusLabel}</span><ChevronDown size={12}/></summary><div>
                  <p>{activeIndexError || (indexingSnapshots.length > 0 ? 'Older messages are syncing in the background. You can keep reading.' : 'Your loaded messages remain searchable.')}</p>
                  {indexingSnapshots.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void handlePauseIndexing()}
                      disabled={indexControlBusy !== null}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] px-2.5 font-medium text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.06)] disabled:cursor-wait disabled:opacity-55"
                    >
                      {indexControlBusy === 'pause' ? <Loader2 size={12} className="animate-spin" /> : <Pause size={12} />}
                      Pause
                    </button>
                  )}
                  {pausedIndexSnapshots.length > 0 && indexingSnapshots.length === 0 && (
                    <button
                      type="button"
                      onClick={() => void handleResumeIndexing()}
                      disabled={indexControlBusy !== null}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-aegis-primary/35 bg-aegis-primary/10 px-2.5 font-medium text-aegis-primary hover:bg-aegis-primary/15 disabled:cursor-wait disabled:opacity-55"
                    >
                      {indexControlBusy === 'resume' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                      {pausedIndexSnapshots.some((snapshot) => snapshot.indexStatus === 'error') ? 'Retry' : 'Resume'}
                    </button>
                  )}
                  {canLoadMoreFolderMail && (
                    <button
                      type="button"
                      onClick={() => {
                        const nextLimit = Math.min(MAIL_FOLDER_MAX_THREADS, mailFolderThreadLimit + MAIL_FOLDER_LOAD_STEP);
                        setMailFolderThreadLimit(nextLimit);
                        void loadInboxFolder(activeFolder, { force: true, maxThreads: nextLimit });
                      }}
                      disabled={mailBusy}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] px-2.5 font-medium text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.06)] disabled:cursor-wait disabled:opacity-55"
                    >
                      {mailBusy ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> : <ChevronDown size={12} />}
                      Load more
                    </button>
                  )}
                  <button type="button" onClick={() => void loadInbox(true)}>Refresh inboxes</button>
                </div></details>
              <button
                type="button"
                onClick={() => void loadInbox(true)}
                aria-label="Refresh connected inboxes"
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-aegis-border bg-aegis-elevated px-3 text-[12px] font-medium text-aegis-text-muted transition-colors hover:border-aegis-primary/25 hover:text-aegis-text"
              >
                {mailBusy ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" /> : <RefreshCw size={15} />}
                <span className="hidden sm:inline">Refresh</span>
              </button>
              <img
                src={lynxInbox}
                alt=""
                aria-hidden="true"
                className="dc-inbox-header-mascot"
              />
            </div>
          </div>

          {microsoftAuthError && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-3 text-[11px] text-red-200">
              {microsoftAuthError}
            </div>
          )}

          {pendingMicrosoftAuth?.userCode && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sky-500/20 bg-sky-500/10 px-3 py-3 text-[11px] text-sky-100">
              <div className="font-semibold text-sky-100">Finish Microsoft sign-in:</div>
              <div className="font-mono text-[13px] font-semibold tracking-[0.14em]">{pendingMicrosoftAuth.userCode}</div>
              <button
                onClick={() => navigator.clipboard?.writeText(pendingMicrosoftAuth.userCode || '')}
                className="inline-flex items-center gap-2 rounded-lg border border-sky-400/20 px-3 py-1.5 text-[11px] text-sky-100 hover:bg-sky-500/10"
              >
                <Copy size={12} />
                Copy code
              </button>
              {(pendingMicrosoftAuth.verificationUriComplete || pendingMicrosoftAuth.verificationUri) && (
                <a
                  href={pendingMicrosoftAuth.verificationUriComplete || pendingMicrosoftAuth.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-sky-400/20 px-3 py-1.5 text-[11px] text-sky-100 hover:bg-sky-500/10"
                >
                  <Plug size={12} />
                  Open sign-in
                </a>
              )}
              <button
                onClick={() => void handleFinishMicrosoftAuth()}
                disabled={microsoftAuthBusy}
                className="inline-flex items-center gap-2 rounded-lg border border-sky-400/20 px-3 py-1.5 text-[11px] text-sky-100 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {microsoftAuthBusy ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
                Finish sign-in
              </button>
            </div>
          )}

        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-[12px] text-red-200">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}


        <div
          ref={splitPaneRef}
          className="dc-inbox-split min-h-0 flex-1 grid items-stretch gap-0 overflow-hidden"
          data-compact-view={compactReaderOpen ? 'reader' : 'list'}
          data-list-collapsed={isListPaneCollapsed ? 'true' : 'false'}
          style={{ '--dc-inbox-list-width': `${isListPaneCollapsed ? COLLAPSED_LIST_PANE_WIDTH : listPaneWidth}px` } as CSSProperties}
        >
          <div
            id="inbox-conversation-list"
            data-inbox-list-pane
            onWheel={(event) => delegatePaneWheel(event, threadListRef.current)}
            className={clsx(
              'dc-inbox-list-pane min-h-0 h-full overflow-hidden transition-opacity',
              isListPaneCollapsed ? 'pointer-events-none opacity-0' : 'opacity-100',
            )}
          >
          <GlassCard
            noPad
            className="min-h-0 h-full flex flex-col overflow-hidden"
            contentClassName="min-h-0 flex flex-1 flex-col"
          >
            <div className="dc-inbox-list-toolbar border-b border-aegis-border/55 px-3 py-3">
              <div className="flex items-center gap-2">
                <div className="dc-inbox-search flex flex-1 items-center gap-2 rounded-xl border border-aegis-border/70 bg-[rgb(var(--aegis-overlay)/0.03)] px-3 py-2 text-[12px] text-aegis-text-muted transition-colors focus-within:border-aegis-primary/30 focus-within:bg-[rgb(var(--aegis-overlay)/0.05)]">
                  <Search size={14} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={`Search ${activeFolderDefinition.label.toLowerCase()}…`}
                    aria-label={`Search ${activeFolderDefinition.label.toLowerCase()} messages`}
                    className="w-full bg-transparent text-aegis-text outline-none placeholder:text-aegis-text-dim"
                    name="inbox-search"
                  />
                </div>
                <button
                  type="button"
                  onClick={toggleListPaneCollapsed}
                  aria-label="Collapse inbox list"
                  aria-controls="inbox-conversation-list"
                  aria-expanded={!isListPaneCollapsed}
                  className="dc-inbox-desktop-pane-toggle inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.06)]"
                  >
                    <PanelLeftClose size={14} />
                  </button>
                </div>
              <div className="mt-2 text-[11px] text-aegis-text-dim tabular-nums">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="dc-inbox-select-page inline-flex items-center gap-2 text-aegis-text-dim">
                    <input
                      ref={selectPageCheckboxRef}
                      type="checkbox"
                      checked={allCurrentPageSelected}
                      onChange={toggleCurrentPageSelection}
                      disabled={pagedThreadItems.length === 0}
                      className="h-3.5 w-3.5 rounded border-aegis-border bg-transparent"
                    />
                    <span>Select page</span>
                  </label>
                  <div data-inbox-list-controls className="ml-auto flex min-w-0 items-center gap-1.5">
                    <label className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-aegis-border/70 bg-[rgb(var(--aegis-overlay)/0.025)] px-2 py-1 text-aegis-text-muted">
                      <ListTree size={11} aria-hidden="true" />
                      <span className="sr-only">Sort email list</span>
                      <select
                        value={sortOrder}
                        onChange={(event) => setSortOrder(normalizeInboxSortOrder(event.target.value))}
                        aria-label="Sort email list"
                        className="min-w-0 max-w-[106px] bg-transparent text-[10.5px] font-medium text-aegis-text outline-none"
                      >
                        <option value="newest">Newest</option>
                        <option value="oldest">Oldest</option>
                        <option value="sender-asc">Sender A to Z</option>
                        <option value="sender-desc">Sender Z to A</option>
                        <option value="subject-asc">Subject A to Z</option>
                        <option value="subject-desc">Subject Z to A</option>
                        <option value="attention">Needs attention</option>
                      </select>
                    </label>
                    <button
                      ref={inboxOptionsTriggerRef}
                      type="button"
                      onClick={() => setShowInboxOptions((current) => !current)}
                      aria-haspopup="dialog"
                      aria-expanded={showInboxOptions}
                      aria-label="Filter inbox"
                      className={clsx(
                        'inline-flex h-[27px] shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[10.5px] font-semibold transition-colors',
                        showInboxOptions || activeInboxFilterCount > 0
                          ? 'border-aegis-primary/35 bg-aegis-primary/10 text-aegis-primary'
                          : 'border-aegis-border/70 bg-[rgb(var(--aegis-overlay)/0.025)] text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.055)]',
                      )}
                    >
                      <Filter size={11} aria-hidden="true" />
                      <span>Filters</span>
                      {activeInboxFilterCount > 0 && <span className="rounded-full bg-aegis-primary px-1.5 text-[9px] font-bold leading-4 text-aegis-bg" aria-label={`${activeInboxFilterCount} active filters`}>{activeInboxFilterCount}</span>}
                    </button>
                    {inboxFilterPanel}
                  </div>

                </div>
              </div>
            </div>

            <div
              ref={threadListRef}
              data-inbox-list-scroll
              tabIndex={0}
              role="region"
              aria-label={`${activeFolderDefinition.label} conversation list`}
              onScroll={handleThreadListScroll}
              onKeyDown={handleThreadListKeyDown}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin"
            >
              {loading && threadItems.length === 0 ? (
                <div className="flex h-full items-center justify-center text-aegis-text-dim">
                  <Loader2 size={18} className="animate-spin" />
                </div>
              ) : threadItems.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[12px] text-aegis-text-dim">
                  {indexingSnapshots.length > 0 ? (
                    <>
                      <Loader2 size={18} className="animate-spin text-aegis-primary" />
                      <div>
                        <div className="font-medium text-aegis-text">Building your private search index</div>
                        <div className="mt-1">Mail will appear here as each bounded page is secured on this device.</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <ShieldAlert size={18} className="text-aegis-text-dim" />
                      <div>
                        {activeFolder === 'inbox' && (bucketFilter !== 'all' || categoryFilter !== 'all' || search.trim())
                          ? 'No inbox messages match these filters.'
                          : `No messages in ${activeFolderDefinition.label}.`}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="divide-y divide-aegis-border/45">
                  {pagedThreadItems.map((thread, index) => {
                    const threadKey = getInboxThreadKey(thread);
                    const groupKey = inboxGroupKey(thread, effectiveGrouping);
                    const previousGroupKey = index > 0 ? inboxGroupKey(pagedThreadItems[index - 1], effectiveGrouping) : null;
                    const wasPinned = index > 0 && pagedThreadItems[index - 1].isPinned;
                    const showGroupHeader = thread.isPinned ? !wasPinned : (effectiveGrouping !== 'none' && (groupKey !== previousGroupKey || wasPinned));
                    const active = thread.id === selectedThread?.threadId && thread.accountKey === selectedThread?.accountKey;
                    const rowSelected = selectedThreadKeySet.has(threadKey);
                    const canModifyThread = Boolean(accountByKey.get(thread.accountKey)?.canModify);
                    const preview = pickThreadPreviewText(thread);
                    const senderLabel = formatInboxSenderLabel(thread.from);
                    const receivingEmail = accountByKey.get(thread.accountKey)?.email || thread.accountLabel;
                    const unread = showsUnread(thread);
                    return (
                      <Fragment key={threadKey}>
                      {showGroupHeader && (
                        <div className="dc-inbox-group-heading flex items-center justify-between border-y border-aegis-border/55 bg-[rgb(var(--aegis-overlay)/0.025)] px-3 py-1.5 text-[10px] font-semibold text-aegis-text-muted">
                          <span className="truncate">{thread.isPinned ? 'Pinned' : inboxGroupLabel(thread, effectiveGrouping)}</span>
                          <span className="tabular-nums text-aegis-text-dim">{thread.isPinned ? threadItems.filter(item => item.isPinned).length : threadItems.filter(item => !item.isPinned && inboxGroupKey(item, effectiveGrouping) === groupKey).length}</span>
                        </div>
                      )}
                      <div
                        data-inbox-row
                        data-density={density}
                        data-unread={unread ? 'true' : 'false'}
                        data-active={active || rowSelected ? 'true' : 'false'}
                        className={clsx(
                          'w-full transition-colors',
                          density === 'compact' ? 'py-2' : density === 'spacious' ? 'py-3.5' : 'py-2.5',
                          active
                            ? 'bg-aegis-primary/10'
                            : 'hover:bg-[rgb(var(--aegis-overlay)/0.04)]',
                        )}
                      >
                        <div className="dc-mail-row-content flex min-w-0 items-start gap-1.5 px-3">
                          <div className="dc-mail-row-tools">
                            <label className="dc-mail-row-select">
                              <input
                                type="checkbox"
                                checked={rowSelected}
                                onChange={() => toggleThreadSelection(thread)}
                                aria-label={`Select thread ${thread.subject}`}
                                className="mt-1.5 h-3.5 w-3.5 rounded border-aegis-border bg-transparent"
                              />
                            </label>
                            {(canModifyThread || thread.isFlagged) && <button
                              type="button"
                              onClick={async (event) => {
                                event.stopPropagation();
                                await handleToggleRowFlag(thread);
                              }}
                              disabled={!canModifyThread || mutatingThread}
                              data-mail-flag={thread.isFlagged ? 'active' : 'available'}
                              title={thread.provider === 'gmail' ? (thread.isFlagged ? 'Starred in Gmail' : 'Star in Gmail') : (thread.isFlagged ? 'Flagged in Outlook' : 'Flag in Outlook')}
                              aria-label={thread.provider === 'gmail'
                                ? (thread.isFlagged ? 'Unstar thread' : 'Star thread')
                                : (thread.isFlagged ? 'Unflag thread' : 'Flag thread')}
                              className="mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-aegis-text-dim hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {thread.provider === 'gmail' ? (
                                <Star size={13} className={clsx(thread.isFlagged && 'fill-current text-amber-300')} />
                              ) : (
                                <Flag size={13} className={clsx(thread.isFlagged && 'fill-current text-aegis-primary')} />
                              )}
                            </button>}
                          </div>
                          <button
                            type="button"
                            data-inbox-thread
                            data-inbox-thread-date={thread.date}
                            data-inbox-thread-pinned={thread.isPinned ? 'true' : 'false'}
                            aria-current={active ? 'true' : undefined}
                            onClick={() => {
                              setSelectedThread({ provider: thread.provider, accountKey: thread.accountKey, threadId: thread.id });
                              setCompactReaderOpen(true);
                            }}
                            className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                          >
                            <span className="dc-mail-read-state" data-read-state={unread ? 'unread' : 'read'} role="img" aria-label={unread ? 'Unread' : 'Read'} title={unread ? 'Unread' : 'Read'}>
                              {unread ? <Mail size={15} aria-hidden="true" /> : <MailOpen size={15} aria-hidden="true" />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="dc-mail-sender-line flex items-center gap-2 leading-none">
                                <span className="dc-mail-sender truncate text-[12px] font-semibold text-aegis-text">{senderLabel}</span>
                                {thread.bucket === 'safe_review' && <ShieldAlert size={12} className="shrink-0 text-aegis-text-muted" aria-label="Held for safe review" />}
                                {availableAccounts.length > 1 && (
                                  <span title={receivingEmail} aria-label={`Account: ${receivingEmail}`} className="dc-mail-provider truncate text-[9px] uppercase tracking-[0.12em] text-aegis-text-dim">
                                    {receivingEmail.split('@')[0]}
                                  </span>
                                )}
                                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                  <span className="text-[10px] text-aegis-text-dim tabular-nums">
                                    {formatThreadListDate(thread.date)}
                                  </span>
                                </div>
                              </div>
                              <div className="dc-mail-subject-line mt-1 flex min-w-0 items-baseline gap-1.5 text-[12px] leading-[1.35]">
                                <span className="dc-mail-subject truncate font-medium text-aegis-text">{thread.subject}</span>
                                {preview && density === 'compact' && (
                                  <span className="dc-mail-preview-inline min-w-0 flex-1 truncate text-aegis-text-muted">{preview}</span>
                                )}
                              </div>
                              {preview && density !== 'compact' && (
                                <div className={clsx(
                                  'mt-1 text-[11.5px] text-aegis-text-muted',
                                  density === 'spacious' ? 'line-clamp-2 leading-relaxed' : 'truncate',
                                )}>
                                  {preview}
                                </div>
                              )}
                            </div>
                            {thread.messageCount > 1 && (
                              <div className="shrink-0 pt-0.5 text-[9.5px] text-aegis-text-dim">
                                {thread.messageCount}
                              </div>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleRowPin(thread)}
                            aria-label={thread.isPinned ? 'Unpin thread' : 'Pin thread'}
                            title={thread.isPinned ? 'Unpin thread' : 'Pin thread'}
                            className="dc-mail-row-pin"
                            data-pinned={thread.isPinned ? 'true' : 'false'}
                          >
                            {thread.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                          </button>
                        </div>
                      </div>
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </div>

            {!loading && (threadItems.length > 0 || scopedIndexSnapshots.length > 0) && (
              <div className="dc-inbox-list-footer flex items-center justify-between gap-2 border-t border-aegis-border/55 px-3 py-2 text-[11px] text-aegis-text-dim">
                <span className="dc-inbox-page-range">{visibleThreadRange.start}–{visibleThreadRange.end} of {threadItems.length.toLocaleString('en-US')}</span>
                {threadItems.length > 0 && <div className="dc-inbox-pagination flex flex-wrap items-center justify-end gap-1.5">

                  <button
                    type="button"
                    onClick={() => goToThreadPage(threadPage - 1)}
                    disabled={threadPage <= 1}
                    aria-label={`Previous ${activeFolderDefinition.label.toLowerCase()} page`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.06)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronLeft size={12} />
                  </button>
                  <label className="inline-flex h-8 items-center gap-1 rounded-lg border border-aegis-border bg-aegis-elevated px-1.5 text-[10px] text-aegis-text-dim">
                    <span>Page</span>
                    <input
                      type="number"
                      min={1}
                      max={threadPageCount}
                      inputMode="numeric"
                      value={threadPageDraft}
                      onChange={(event) => setThreadPageDraft(event.target.value)}
                      onBlur={() => goToThreadPage(threadPageDraft)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          goToThreadPage(threadPageDraft);
                        }
                        if (event.key === 'Escape') setThreadPageDraft(String(threadPage));
                      }}
                      aria-label="Go to email page"
                      className="h-6 w-10 rounded-md border border-aegis-border/80 bg-transparent px-1 text-center text-[11px] font-semibold tabular-nums text-aegis-text outline-none focus:border-aegis-primary"
                    />
                    <span>/ {threadPageCount}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => goToThreadPage(threadPage + 1)}
                    disabled={threadPage >= threadPageCount}
                    aria-label={`Next ${activeFolderDefinition.label.toLowerCase()} page`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.06)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronRight size={12} />
                  </button>
                </div>}
              </div>
            )}
          </GlassCard>
          </div>

          <div className="dc-inbox-divider flex items-stretch justify-center">
            <button
              type="button"
              onMouseDown={beginSplitResize}
              onDoubleClick={() => {
                setIsListPaneCollapsed(false);
                setListPaneWidth(DEFAULT_LIST_PANE_WIDTH);
                listPaneWidthBeforeCollapseRef.current = DEFAULT_LIST_PANE_WIDTH;
              }}
              aria-label="Resize inbox panes"
              className="group flex h-full w-4 cursor-col-resize items-center justify-center"
            >
              <div className="relative flex h-full w-px items-center justify-center bg-aegis-border/60 transition-colors group-hover:bg-aegis-primary/50">
                <GripVertical size={12} className="rounded-full bg-[rgb(var(--aegis-bg))] text-aegis-text-dim" />
              </div>
            </button>
          </div>

          <div
            data-inbox-reader-pane
            onWheel={(event) => delegatePaneWheel(event, readingPaneRef.current)}
            className="dc-inbox-reader-pane min-h-0 h-full flex flex-col gap-4 overflow-hidden pl-4"
          >
            <GlassCard noPad hover={false} shimmer={false} className="min-h-0 flex-1 flex flex-col overflow-hidden border-aegis-border/50 bg-transparent hover:bg-transparent" contentClassName="min-h-0 flex flex-1 flex-col">
              <div className="dc-inbox-reader-header px-4 py-2.5">
                {selectedThreadItem && selectedAccount ? (
                  <div className="dc-inbox-reader-header-content flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-aegis-border/20 pb-1.5">
                      <div className="flex flex-wrap items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => {
                            setCompactReaderOpen(false);
                            window.requestAnimationFrame(() => threadListRef.current?.querySelector<HTMLButtonElement>('button[data-inbox-thread]')?.focus());
                          }}
                          aria-label="Back to inbox list"
                          className={clsx(threadToolbarButtonClass, 'dc-inbox-mobile-back')}
                        >
                          <ChevronLeft size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={toggleListPaneCollapsed}
                          aria-label={isListPaneCollapsed ? 'Show inbox list' : 'Hide inbox list'}
                          title={isListPaneCollapsed ? 'Show inbox list' : 'Hide inbox list'}
                          aria-controls="inbox-conversation-list"
                          aria-expanded={!isListPaneCollapsed}
                          className={clsx(threadToolbarButtonClass, 'dc-inbox-desktop-pane-toggle')}
                        >
                          {isListPaneCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => navigateToThread(newerThreadItem)}
                          disabled={!newerThreadItem}
                          aria-label="Go to newer thread"
                          title="Previous newer thread"
                          className={threadToolbarButtonClass}
                        >
                          <ChevronUp size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => navigateToThread(olderThreadItem)}
                          disabled={!olderThreadItem}
                          aria-label="Go to older thread"
                          title="Next older thread"
                          className={threadToolbarButtonClass}
                        >
                          <ChevronDown size={12} />
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => void handleThreadMutation(showsUnread(selectedThreadItem) ? 'mark-read' : 'mark-unread')}
                          disabled={mutatingThread || !selectedAccount.canModify}
                          aria-label={showsUnread(selectedThreadItem) ? 'Mark thread read' : 'Mark thread unread'}
                          title={showsUnread(selectedThreadItem) ? 'Mark read' : 'Mark unread'}
                          className={threadToolbarButtonClass}
                        >
                          {showsUnread(selectedThreadItem) ? <MailOpen size={12} /> : <Mail size={12} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleThreadMutation('archive')}
                          disabled={mutatingThread || !selectedAccount.canModify || activeFolder !== 'inbox'}
                          aria-label="Archive thread"
                          title="Archive"
                          className={threadToolbarButtonClass}
                        >
                          <Archive size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleThreadMutation('delete')}
                          disabled={mutatingThread || !selectedAccount.canModify || activeFolder === 'trash'}
                          aria-label="Delete thread"
                          title="Delete"
                          className={threadToolbarDangerButtonClass}
                        >
                          <Trash2 size={12} />
                        </button>
                        <button
                          onClick={() => {
                            setReplyAll(false);
                            setShowReplyComposer(true);
                            setShowActionMenu(false);
                          }}
                          disabled={!selectedAccount.canRead || !replySourceMessage}
                          aria-label="Reply"
                          title={replySourceMessage ? 'Reply' : 'Open this draft to edit it'}
                          className={threadToolbarButtonClass}
                        >
                          <Reply size={12} />
                        </button>
                        <div ref={actionMenuRef} className="relative">
                          <button
                            type="button"
                            onClick={() => setShowActionMenu((current) => !current)}
                            aria-haspopup="menu"
                            aria-expanded={showActionMenu}
                            aria-label="More actions"
                            title="More actions"
                            className={threadToolbarButtonClass}
                          >
                            <MoreHorizontal size={12} />
                          </button>
                          {showActionMenu && (
                            <div className="absolute right-0 z-20 mt-2 min-w-[180px] rounded-xl border border-[rgb(var(--aegis-overlay)/0.16)] bg-aegis-card-solid p-1.5 shadow-2xl">
                              <button
                                onClick={() => {
                                  handleTogglePin();
                                  setShowActionMenu(false);
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] text-aegis-text hover:bg-white/5"
                              >
                                {selectedThreadItem.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                                {selectedThreadItem.isPinned ? 'Unpin' : 'Pin thread'}
                              </button>
                              <button
                                onClick={() => {
                                  void handleToggleFlag();
                                  setShowActionMenu(false);
                                }}
                                disabled={mutatingThread || !selectedAccount.canModify}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] text-aegis-text hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {selectedThreadItem.isFlagged ? <FlagOff size={13} /> : <Flag size={13} />}
                                {selectedThreadItem.isFlagged ? 'Remove flag' : 'Flag thread'}
                              </button>
                              <button
                                onClick={() => {
                                  setReplyAll(true);
                                  setShowReplyComposer(true);
                                  setShowActionMenu(false);
                                }}
                                disabled={!selectedAccount.canRead || !replySourceMessage}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] text-aegis-text hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <ReplyAll size={13} />
                                Reply all
                              </button>
                              <div className="my-1 border-t border-aegis-border/60" />
                              <button
                                onClick={() => {
                                  void handleSenderAction('unsubscribe');
                                  setShowActionMenu(false);
                                }}
                                disabled={mutatingThread || senderActionState.canManage === false}
                                title={senderActionState.canManage === false ? 'This connection does not support unsubscribe yet.' : undefined}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] text-aegis-text hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <Unsubscribe size={13} />
                                Unsubscribe from sender
                              </button>
                              <button
                                onClick={() => {
                                  void handleSenderAction(senderActionState.blocked ? 'unblock-sender' : 'block-sender');
                                  setShowActionMenu(false);
                                }}
                                disabled={mutatingThread || senderActionState.loading || senderActionState.canManage === false}
                                title={senderActionState.error || (senderActionState.canManage === false ? 'This connection does not support sender management yet.' : undefined)}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] text-aegis-text hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {senderActionState.blocked ? <Unblock size={13} /> : <Ban size={13} />}
                                {senderActionState.canManage === false
                                  ? 'Sender management unavailable'
                                  : senderActionState.blocked
                                    ? 'Unblock sender'
                                    : 'Block future mail'}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="min-w-0" style={{ visibility: conversationPrepared ? 'visible' : 'hidden' }} aria-hidden={!conversationPrepared}>
                      <div className="dc-inbox-reader-meta flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-aegis-text-dim">
                        <span translate="no">{selectedThreadItem.provider === 'gmail' ? 'Gmail' : 'Outlook'}</span>
                        <span className="dc-mail-read-label" data-read-state={showsUnread(selectedThreadItem) ? 'unread' : 'read'}>
                          {showsUnread(selectedThreadItem) ? <Mail size={12} aria-hidden="true" /> : <MailOpen size={12} aria-hidden="true" />}
                          {showsUnread(selectedThreadItem) ? 'Unread' : 'Read'}
                        </span>
                        {availableAccounts.length > 1 && (
                          <>
                            <span aria-hidden="true" className="opacity-40">•</span>
                            <span className="max-w-[260px] truncate normal-case tracking-normal text-[11px]" translate="no">{selectedAccount.label}</span>
                          </>
                        )}
                        {selectedThreadItem.bucket !== 'fyi' && (
                          <span className={clsx('rounded-full border px-2 py-0.5 normal-case tracking-normal text-[10px]', bucketTone(selectedThreadItem.bucket))}>
                            {bucketLabel(selectedThreadItem.bucket)}
                          </span>
                        )}
                        <span className={clsx('rounded-full border px-2 py-0.5 normal-case tracking-normal text-[10px]', categoryTone((selectedThreadItem.category || 'other') as InboxCategoryFilter))}>
                          {categoryLabel((selectedThreadItem.category || 'other') as InboxCategoryFilter)}
                        </span>
                        {selectedThreadItem.isPinned && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 normal-case tracking-normal text-[10px] text-amber-300">
                            <Pin size={10} />
                            Pinned
                          </span>
                        )}
                        {selectedThreadItem.isFlagged && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-aegis-primary/20 bg-aegis-primary/10 px-2 py-0.5 normal-case tracking-normal text-[10px] text-aegis-primary">
                            <Flag size={10} />
                            Flagged
                          </span>
                        )}
                        {senderActionState.blocked && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 normal-case tracking-normal text-[10px] text-red-200">
                            <Ban size={10} />
                            Sender blocked
                          </span>
                        )}
                      </div>
                      <h2 className="dc-inbox-reader-subject mt-1.5 text-[17px] font-semibold leading-tight text-aegis-text text-pretty">{selectedThreadItem.subject}</h2>
                      {formatInboxConversationSummary(selectedThreadItem.messageCount) && (
                        <p className="dc-inbox-reader-conversation-summary mt-1 text-[11px] text-aegis-text-dim">
                          {formatInboxConversationSummary(selectedThreadItem.messageCount)}
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-[13px] text-aegis-text-dim">Select a thread to inspect it.</div>
                )}
              </div>

              <div
                ref={readingPaneRef}
                data-inbox-reader-scroll
                tabIndex={0}
                role="region"
                aria-label="Selected conversation"
                onScroll={handleReadingPaneScroll}
                onKeyDown={(event) => delegatePaneKeyboard(event, readingPaneRef.current)}
                className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin px-4 py-3"
                aria-busy={threadLoading || threadMessages.length > 0 && !conversationPrepared}
              >
                {!threadLoading && threadMessages.length > 0 && !conversationPrepared && <div className="dc-email-preparation">
                  {preparationFailed ? <div className="dc-inbox-reader-error" role="alert"><Mail size={24} aria-hidden="true"/><h3>This email couldn’t finish preparing</h3><p>Some content is unavailable. Try again to open the complete email.</p><button onClick={retryPreparation}><RefreshCw size={15}/>Try again</button></div> : <div role="status" aria-label="Preparing email"><Loader2 size={20} className="animate-spin" aria-hidden="true"/></div>}
                </div>}
                {threadLoading ? (
                  <div className="flex h-full items-center justify-center text-aegis-text-dim">
                    <Loader2 size={18} className="animate-spin" />
                  </div>
                ) : threadError && threadMessages.length === 0 ? (
                  <div className="dc-inbox-reader-error" role="alert">
                    <Mail size={24} aria-hidden="true"/><h3>This message couldn’t load</h3>
                    <p>{threadError}</p>
                    <div><button onClick={retrySelectedMessage}><RefreshCw size={15}/>Try again</button><button onClick={host.openSettings}>Account settings</button></div>
                  </div>
                ) : threadMessages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center px-6 text-center text-aegis-text-dim">
                    <IconParkMail size={30} aria-hidden="true" />
                    <h3 className="mt-3 text-[16px] font-extrabold text-aegis-text">Choose a conversation</h3>
                    <p className="mt-1 max-w-[320px] text-[12px] leading-5 text-aegis-text-muted">Select a thread to review the full conversation, safety context, and available actions.</p>
                  </div>
                ) : (
                  <div data-email-prepared={conversationPrepared} aria-hidden={!conversationPrepared} inert={!conversationPrepared} style={{ visibility: conversationPrepared ? 'visible' : 'hidden' }} className="mx-auto w-full max-w-[960px] space-y-3">
                    {threadRefreshing && (
                      <div className="flex items-center gap-2 rounded-lg border border-aegis-border/55 bg-[rgb(var(--aegis-overlay)/0.025)] px-3 py-2 text-[11px] text-aegis-text-dim" role="status">
                        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                        Checking for conversation updates…
                      </div>
                    )}
                    {threadError && (
                      <div className="rounded-lg border border-amber-400/25 bg-amber-400/8 px-3 py-2 text-[11px] text-amber-100" role="status">
                        {threadError}
                      </div>
                    )}
                    <div className="space-y-0 divide-y divide-aegis-border/25">
                    {renderedEmails.map(({ message, sanitized: sanitizedEmail, html: renderedBodyHtml }) => {
                      const isOwn = ownEmailSet.has(extractEmail(message.from));
                      const attachments = message.attachments || [];
                      const allowExternalContent = !selectedThreadItem?.safety.protected;
                      const attachmentBlocks = attachments.filter((attachment) => !(
                        sanitizedEmail.referencedAttachmentIds.has(attachment.id) && buildAttachmentDataUrl(attachment)
                      ));
                      const attachmentSummary = summarizeInboxAttachments(attachmentBlocks);
                      return (
                        <div
                          key={message.id}
                          data-source-message={message.id}
                          data-linked-message={linkedState.target?.messageId === message.id || undefined}
                          className={clsx(
                            'px-1 py-3.5',
                            isOwn
                              ? 'rounded-xl border border-aegis-primary/15 bg-aegis-primary/5 px-4'
                              : '',
                          )}
                        >
                          <div className="flex items-start justify-between gap-3 text-[11px] text-aegis-text-dim">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[12px] font-semibold text-aegis-text-muted">
                                {host.openContact && selectedThreadItem && selectedAccount ? <button type="button" className="dc-inbox-contact-link" title="Open or create Contact" aria-label={`Open Contact for ${formatInboxSenderLabel(message.from)}`} onClick={() => host.openContact?.({ provider: selectedThreadItem.provider === 'gmail' ? 'google' : 'microsoft', accountId: selectedAccount.accountId, threadId: selectedThreadItem.id }, message.id)}>{formatInboxSenderLabel(message.from)}</button> : formatInboxSenderLabel(message.from)}
                              </div>
                              <details className="group mt-0.5 w-fit max-w-full">
                                <summary
                                  aria-label={`Toggle delivery details for ${formatInboxSenderLabel(message.from)}`}
                                  className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-[10px] text-aegis-text-dim outline-none hover:text-aegis-text-muted focus-visible:ring-2 focus-visible:ring-aegis-primary/60 [&::-webkit-details-marker]:hidden"
                                >
                                  <span>Details</span>
                                  <ChevronDown size={10} className="transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                                </summary>
                                <dl className="mt-2 grid max-w-[min(680px,calc(100vw-7rem))] grid-cols-[42px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-lg border border-aegis-border/60 bg-aegis-card-solid px-3 py-2 text-[10px] leading-4 shadow-lg">
                                  <dt className="font-medium text-aegis-text-dim">From</dt>
                                  <dd className="min-w-0 break-words text-aegis-text-muted">{message.from}</dd>
                                  {message.to && (
                                    <>
                                      <dt className="font-medium text-aegis-text-dim">To</dt>
                                      <dd className="min-w-0 break-words text-aegis-text-muted">{message.to}</dd>
                                    </>
                                  )}
                                  {message.cc && (
                                    <>
                                      <dt className="font-medium text-aegis-text-dim">Cc</dt>
                                      <dd className="min-w-0 break-words text-aegis-text-muted">{message.cc}</dd>
                                    </>
                                  )}
                                </dl>
                              </details>
                            </div>
                            {(('labelIds' in message && message.labelIds.includes('DRAFT')) || ('isDraft' in message && message.isDraft)) && <button type="button" className="dc-inbox-edit-provider-draft" onClick={() => void openProviderDraft(message)} disabled={!selectedAccount?.canRead}><Edit3 size={14} aria-hidden="true"/>Edit draft</button>}
                            <time className="shrink-0 text-right tabular-nums" dateTime={message.date || undefined}>
                              {formatMessageDate(message.date)}
                            </time>
                          </div>
                          <EmailMessageFrame
                            key={imageRetry}
                            html={renderedBodyHtml}
                            onPrepared={(html, failed) => setPreparedFrames(old => old[message.id]?.html === html && old[message.id]?.failed === failed ? old : { ...old, [message.id]: { html, failed } })}
                            title={message.subject || `Email message from ${message.from}`}
                            scrollOwnerRef={readingPaneRef}
                            onMeasured={handleReaderContentMeasured}
                          />
                          {attachmentBlocks.length > 0 && (
                            <section data-inbox-attachments className="mt-4 min-w-0" aria-label="Email attachments">
                              <div className="mb-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                <h3 className="text-[11.5px] font-semibold text-aegis-text">Attachments</h3>
                                <span className="text-[10px] tabular-nums text-aegis-text-dim">
                                  {attachmentSummary.countLabel}{attachmentSummary.sizeLabel ? ` · ${attachmentSummary.sizeLabel}` : ''}
                                </span>
                              </div>
                              <div className="dc-inbox-attachments-grid">
                                {attachmentBlocks.map(attachment=><InboxFileCard key={attachment.id} attachment={attachment} allowExternalContent={allowExternalContent} handleOpenAttachment={handleOpenAttachment} handleSaveAttachment={handleSaveAttachment}/>)}
                              </div>
                            </section>
                          )}
                        </div>
                      );
                    })}
                    </div>
                  </div>
                )}
              </div>
            </GlassCard>

            {selectedThreadItem && selectedAccount && showReplyComposer && (
                <GlassCard className="dc-inbox-reply shrink-0" contentClassName="dc-inbox-reply-content">
                  <div className="flex h-full flex-col gap-4">
                    <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <div className="flex items-center gap-2 text-aegis-text">
                          <Reply size={15} className="text-aegis-primary" />
                          <span className="text-[13px] font-semibold">Reply review</span>
                        </div>
                        <div className="mt-1 text-[11px] text-aegis-text-dim">
                          Explicit draft and send actions stay here. Nothing sends without this step.
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-aegis-text-dim">
                        <label className="inline-flex items-center gap-2">
                          <input type="checkbox" checked={replyAll} onChange={(event) => setReplyAll(event.target.checked)} />
                          <ReplyAll size={13} />
                          Reply all
                        </label>
                        {selectedAccount.supportsSignature && (
                          <label className="inline-flex items-center gap-2">
                            <input type="checkbox" checked={includeSignature} onChange={(event) => setIncludeSignature(event.target.checked)} />
                            Include {selectedAccount.provider === 'gmail' ? 'Gmail' : 'Outlook'} signature
                          </label>
                        )}
                        <button
                          onClick={() => setShowReplyComposer(false)}
                          className="inline-flex items-center gap-2 rounded-lg border border-aegis-border px-3 py-1.5 text-[11px] text-aegis-text-dim hover:bg-[rgb(var(--aegis-overlay)/0.06)]"
                        >
                          Hide draft
                        </button>
                      </div>
                    </div>

                    <InboxDeliveryCard key={replyJournalKey} source={replyJournalKey}/>
                    <div style={{ display: replyDelivery && !replyDelivery.editing ? 'none' : undefined }} className="min-h-0 grid gap-3 lg:grid-cols-[minmax(0,1fr),220px]">
                      <div className="min-h-0 space-y-3">
                        {replyError && (
                          <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-[12px] text-red-200">
                            {replyError}
                          </div>
                        )}
                        <div className="space-y-1.5">
                          <label className="text-[11px] uppercase tracking-[0.12em] text-aegis-text-dim">Subject</label>
                          <input
                            value={replySubject}
                            aria-label="Reply subject"
                            onChange={(event) => setReplySubject(event.target.value)}
                            className="w-full rounded-xl border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] px-3 py-2 text-[12px] text-aegis-text outline-none"
                          />
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-[11px] uppercase tracking-[0.12em] text-aegis-text-dim">Reply body</label>
                          <textarea
                            value={replyBody}
                            aria-label="Reply body"
                            onChange={(event) => setReplyBody(event.target.value)}
                            placeholder="Write your reply. Review the complete message before saving or sending."
                            className="min-h-[120px] w-full rounded-xl border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] px-3 py-3 text-[12px] leading-relaxed text-aegis-text outline-none placeholder:text-aegis-text-dim"
                          />
                        </div>
                        <InboxOutgoingFileCards key={replyJournalKey} model={replyFiles} label="Reply files" handleOpenAttachment={handleOpenAttachment} handleSaveAttachment={handleSaveAttachment}/>
                      </div>

                      <div className="space-y-3">
                        {selectedAccount.provider === 'gmail' ? (
                          <div className="space-y-1.5">
                            <label className="text-[11px] uppercase tracking-[0.12em] text-aegis-text-dim">From</label>
                            <select
                              value={selectedFrom}
                              onChange={(event) => setSelectedFrom(event.target.value)}
                              className="w-full rounded-xl border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] px-3 py-2 text-[12px] text-aegis-text outline-none"
                            >
                              {sendAsAliases.map((alias) => (
                                <option key={alias.sendAsEmail} value={alias.sendAsEmail}>
                                  {alias.displayName ? `${alias.displayName} <${alias.sendAsEmail}>` : alias.sendAsEmail}
                                </option>
                              ))}
                              {sendAsAliases.length === 0 && <option value="">No send-as aliases</option>}
                            </select>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <div className="rounded-xl border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] px-3 py-3 text-[11px] text-aegis-text-dim">
                              <div className="font-medium text-aegis-text-muted">From</div>
                              <div className="mt-2 break-words">{selectedAccount.email || 'No account selected'}</div>
                            </div>
                            <div className="rounded-xl border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] px-3 py-3 text-[11px] text-aegis-text-dim">
                              <div className="font-medium text-aegis-text-muted">Outlook signature</div>
                              <div className="mt-2">
                                Edit the signature to include in this reply.
                              </div>
                              <textarea
                                value={microsoftSignatureDraft}
                                onChange={(event) => setMicrosoftSignatureDraft(event.target.value)}
                                placeholder="Type the Outlook signature to append on drafts and sends for this account."
                                className="mt-3 min-h-[72px] w-full rounded-xl border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.04)] px-3 py-2 text-[12px] text-aegis-text outline-none placeholder:text-aegis-text-dim"
                              />
                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                <button
                                  onClick={() => void handleSaveMicrosoftSignature()}
                                  disabled={savingMicrosoftSignature}
                                  className="inline-flex items-center gap-2 rounded-lg border border-aegis-primary/20 bg-aegis-primary/10 px-3 py-1.5 text-[11px] font-medium text-aegis-primary hover:bg-aegis-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {savingMicrosoftSignature ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                                  Save signature
                                </button>
                              </div>
                            </div>
                          </div>
                        )}

                        <div className="rounded-xl border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] px-3 py-3 text-[11px] text-aegis-text-dim">
                          <div className="font-medium text-aegis-text-muted">Recipients</div>
                          <div className="mt-2 break-words">To: {replyRecipients.to.join(', ') || 'No reply recipient inferred yet'}</div>
                          {replyRecipients.cc.length > 0 && <div className="mt-1 break-words">Cc: {replyRecipients.cc.join(', ')}</div>}
                          {selectedAccount.supportsSignature && includeSignature && selectedAlias?.signature && (
                            <div className="mt-2 text-aegis-text-dim">Gmail signature from {selectedAlias.sendAsEmail} will be appended.</div>
                          )}
                          {selectedAccount.provider === 'microsoft' && includeSignature && microsoftSignatureDraft.trim() && (
                            <div className="mt-2 text-aegis-text-dim">Saved Outlook signature will be appended.</div>
                          )}
                        </div>

                        {(!replyDelivery || replyDelivery.editing) && <>
                        <button
                          onClick={() => void handleSaveDraft()}
                          disabled={savingDraft || !selectedAccount.canDraft || !replySourceMessage}
                          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-aegis-border bg-[rgb(var(--aegis-overlay)/0.03)] px-3 py-2.5 text-[12px] font-medium text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.06)] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {savingDraft ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                          Save draft
                        </button>
                        <button
                          onClick={() => void handleSendReply()}
                          disabled={sendingReply || !selectedAccount.canSend || !replySourceMessage}
                          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-aegis-primary/20 bg-aegis-primary/12 px-3 py-2.5 text-[12px] font-medium text-aegis-primary hover:bg-aegis-primary/18 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {sendingReply ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                          Send reply
                        </button>
                        </>}
                      </div>
                    </div>
                  </div>
                </GlassCard>
            )}
          </div>
        </div>
        </main>
      </div>
      {composeOpen && createPortal(
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm sm:p-5" role="presentation">
          <div
            ref={composeDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-mail-title"
            aria-describedby="compose-mail-description"
            className="dc-inbox-compose flex max-h-[min(760px,calc(100vh-2rem))] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-aegis-border bg-aegis-menu-bg shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-aegis-border/70 px-4 py-3.5 sm:px-5">
              <div>
                <h2 id="compose-mail-title" className="text-[16px] font-bold text-aegis-text">{composeDelivery?.review?.openedDraft ? 'Edit draft' : 'New message'}</h2>
                <p id="compose-mail-description" className="mt-1 text-[10.5px] text-aegis-text-dim">
                  Each message stays here when you switch or close. Review before sending.
                </p>
              </div>
              <button
                type="button"
                onClick={() => closeCompose(true)}
                aria-label="Close new message"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-aegis-border text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.06)] disabled:opacity-40"
              >
                <X size={15} />
              </button>
            </div>

            <div className="dc-inbox-compose-switcher">
              <label htmlFor="compose-kept-message" className="sr-only">Kept messages</label>
              <select id="compose-kept-message" value={composeSource} onChange={event => switchCompose(event.target.value)}>
                {composeSources.map((source, index) => {
                  const subject = String(composeWriting[inboxWritingKey(source, 'composeSubject')] || '').trim();
                  const state = deliveryRecords[source]?.review?.state;
                  const status = state && ({saved:'Saved draft',accepted:'Sent to provider',uncertain:deliveryRecords[source]?.review?.mode==='draft'?'Check draft status':'Check send status',interrupted:'Needs attention',running:'In progress',preparing:'Preparing',prepared:'Review ready',failed:'Stopped',cancelled:'Cancelled'} as const)[state];
                  return <option key={source} value={source}>{subject || `Message ${index + 1}`}{status ? ` · ${status}` : ''}</option>;
                })}
              </select>
              <button type="button" onClick={() => switchCompose()}><Edit3 size={16} aria-hidden="true"/>New message</button>
            </div>

            <div ref={composeScrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5 scrollbar-thin">
              <InboxDeliveryCard key={composeSource} source={composeSource}/>
              {composeError && (
                <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-[11px] text-red-200">
                  {composeError}
                </div>
              )}

              <fieldset disabled={composeOpening} className="min-w-0 space-y-3">
              <div className={clsx('grid gap-3', composeSelectedAccount?.provider === 'gmail' && composeAliases.length > 1 && 'sm:grid-cols-2')}>
                <label className="space-y-1.5 text-[10px] font-bold uppercase tracking-[0.11em] text-aegis-text-dim">
                  From
                  <select
                    value={composeAccountKey}
                    onChange={(event) => setComposeAccountKey(event.target.value)}
                    aria-label="From account"
                    disabled={!!composeDelivery?.review?.providerDraftId}
                    className="field-input !min-h-10 !rounded-xl !text-[12px] normal-case tracking-normal"
                  >
                    {availableAccounts.map((account) => (
                      <option key={account.key} value={account.key}>
                        {account.provider === 'gmail' ? 'Gmail' : 'Outlook'} · {account.email}
                      </option>
                    ))}
                    {availableAccounts.length === 0 && <option value="">No connected mail account</option>}
                  </select>
                </label>

                {composeSelectedAccount?.provider === 'gmail' && (composeAliases.length > 1 || (!!composeDelivery?.review?.openedDraft && composeFrom !== composeSelectedAccount.email)) && (
                  <label className="space-y-1.5 text-[10px] font-bold uppercase tracking-[0.11em] text-aegis-text-dim">
                    Send as
                    <select value={composeFrom} onChange={(event) => setComposeFrom(event.target.value)} aria-label="Send as identity" className="field-input !min-h-10 !rounded-xl !text-[12px] normal-case tracking-normal">
                      {composeFrom && !composeAliases.some(alias=>alias.sendAsEmail===composeFrom) && <option value={composeFrom}>Original sender · {composeFrom}</option>}
                      {composeAliases.map((alias) => (
                        <option key={alias.sendAsEmail} value={alias.sendAsEmail}>
                          {alias.displayName ? `${alias.displayName} <${alias.sendAsEmail}>` : alias.sendAsEmail}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div className="rounded-xl border border-aegis-border bg-aegis-elevated px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <label htmlFor="compose-mail-to" className="w-8 shrink-0 text-[10px] font-bold uppercase tracking-[0.1em] text-aegis-text-dim">To</label>
                  <input
                    id="compose-mail-to"
                    value={composeTo}
                    onChange={(event) => setComposeTo(event.target.value)}
                    placeholder="name@example.com, another@example.com"
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-aegis-text outline-none placeholder:text-aegis-text-dim"
                  />
                  <button type="button" onClick={() => setComposeShowCopyFields((current) => !current)} aria-expanded={composeShowCopyFields} className="shrink-0 text-[10px] font-semibold text-aegis-primary hover:text-aegis-primary-hover">
                    Cc / Bcc
                  </button>
                </div>
                {composeShowCopyFields && (
                  <div className="mt-2 space-y-2 border-t border-aegis-border/60 pt-2">
                    <div className="flex items-center gap-2"><label htmlFor="compose-mail-cc" className="w-8 shrink-0 text-[10px] font-bold uppercase text-aegis-text-dim">Cc</label><input id="compose-mail-cc" value={composeCc} onChange={(event) => setComposeCc(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[12px] text-aegis-text outline-none" /></div>
                    <div className="flex items-center gap-2"><label htmlFor="compose-mail-bcc" className="w-8 shrink-0 text-[10px] font-bold uppercase text-aegis-text-dim">Bcc</label><input id="compose-mail-bcc" value={composeBcc} onChange={(event) => setComposeBcc(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[12px] text-aegis-text outline-none" /></div>
                  </div>
                )}
              </div>

              <label className="block space-y-1.5 text-[10px] font-bold uppercase tracking-[0.11em] text-aegis-text-dim">
                Subject
                <input value={composeSubject} onChange={(event) => setComposeSubject(event.target.value)} maxLength={300} className="field-input !min-h-10 !rounded-xl !text-[12px] normal-case tracking-normal" />
              </label>

              {composeDelivery?.review?.openedDraft && composeSelectedAccount?.provider==='microsoft' && composeFrom!==composeSelectedAccount.email && <p className="text-[12px] text-aegis-text-muted">Original sender: {composeFrom}</p>}
              {composeDelivery?.review?.openedDraft && composeSavedMessage?.bodyHtml && <div className="dc-inbox-draft-format">
                <span>{composeKeepFormatting ? 'Saved formatting is kept. Review selected files below.' : 'Plain text replaces the saved formatting. Review selected files below.'}</span>
                <button type="button" onClick={() => setComposeKeepFormatting(current=>!current)}>{composeKeepFormatting ? 'Edit as plain text' : 'Use saved formatting'}</button>
              </div>}
              {composeKeepFormatting && composeSavedMessage?.bodyHtml ? <div className="dc-inbox-draft-preview">
                <EmailMessageFrame title="Saved draft formatting" html={sanitizeEmailHtml(composeSavedMessage.bodyHtml,composeInlineAttachments,false,{allowInlineContent:true,maxInlineImageHeight:320,removedContentIds:(composeSavedMessage.attachments??[]).filter(file=>file.cid&&!composeAttachments.some(item=>normalizeAttachmentContentId(item.contentId)===normalizeAttachmentContentId(file.cid))).map(file=>normalizeAttachmentContentId(file.cid))}).html} scrollOwnerRef={composeScrollRef}/>
              </div> : <label className="block space-y-1.5 text-[10px] font-bold uppercase tracking-[0.11em] text-aegis-text-dim">
                Message
                <textarea
                  value={composeBody}
                  onChange={(event) => setComposeBody(event.target.value)}
                  placeholder="Write your message…"
                  className="min-h-[230px] w-full resize-y rounded-xl border border-aegis-border bg-aegis-elevated px-3 py-3 text-[12.5px] font-normal leading-6 tracking-normal text-aegis-text outline-none placeholder:text-aegis-text-dim focus:border-aegis-primary"
                />
              </label>}

              <InboxOutgoingFileCards key={composeSource} model={composeFiles} label="Files kept with this draft" handleOpenAttachment={handleOpenAttachment} handleSaveAttachment={handleSaveAttachment}/>

              {composeSelectedAccount?.supportsSignature && !composeKeepFormatting && (
                <label className="flex items-start gap-2 rounded-xl border border-aegis-border/70 bg-[rgb(var(--aegis-overlay)/0.025)] px-3 py-2.5 text-[11px] text-aegis-text-muted">
                  <input type="checkbox" checked={composeIncludeSignature} onChange={(event) => setComposeIncludeSignature(event.target.checked)} className="mt-0.5" />
                  <span>
                    Include the saved {composeSelectedAccount.provider === 'gmail' ? 'Gmail' : 'Outlook'} signature
                    <span className="mt-0.5 block text-[9.5px] text-aegis-text-dim">The complete signature is included in your message review.</span>
                  </span>
                </label>
              )}
              </fieldset>
            </div>

            <div className="dc-inbox-compose-footer flex flex-wrap items-center justify-end gap-2 border-t border-aegis-border/70 px-4 py-3 sm:px-5">
              <button type="button" onClick={() => closeCompose(true)} className="inline-flex h-10 items-center justify-center rounded-xl border border-aegis-border px-4 text-[11px] font-semibold text-aegis-text-muted hover:bg-[rgb(var(--aegis-overlay)/0.05)] disabled:opacity-40">Close</button>
              {(!composeDelivery || composeDelivery.editing) && <>
              <button type="button" onClick={() => void handleComposeDelivery('draft')} disabled={composeOpening || !!composeDelivery?.review?.superseded || composeBusy !== null || !composeSelectedAccount?.canDraft} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-aegis-border bg-aegis-elevated px-4 text-[11px] font-semibold text-aegis-text hover:bg-[rgb(var(--aegis-overlay)/0.06)] disabled:opacity-40">
                {composeBusy === 'draft' ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <Save size={14} />}
                Save draft
              </button>
              <button type="button" onClick={() => void handleComposeDelivery('send')} disabled={composeOpening || !!composeDelivery?.review?.superseded || composeBusy !== null || !composeSelectedAccount?.canSend} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-aegis-primary/30 bg-aegis-primary px-5 text-[11px] font-bold text-aegis-bg disabled:opacity-40">
                {composeBusy === 'send' ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <Send size={14} />}
                Send
              </button>
              </>}
            </div>
          </div>
        </div>
      , host.portal)}
      {pendingMailAction && createPortal(
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Review email action"
        >
          <div className="relative max-h-[calc(100vh-2rem)] w-full max-w-[920px] overflow-y-auto rounded-xl border border-aegis-border bg-aegis-card-solid py-4 shadow-2xl">
            <button
              type="button"
              onClick={() => setPendingMailAction(null)}
              className="absolute right-4 top-4 z-10 inline-flex h-11 w-11 items-center justify-center rounded-lg border border-aegis-border bg-aegis-card-solid text-aegis-text-muted hover:text-aegis-text disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Close action review"
            >
              <X size={15} />
            </button>
            <div className="px-5 pb-2 pr-16">
              <div className="text-[13px] font-semibold text-aegis-text">Review provider changes</div>
              <div className="mt-1 text-[11px] text-aegis-text-muted">
                Your review and its results stay available in Action reviews.
              </div>
            </div>
            <MailActionCard
              plan={pendingMailAction}
              onSettled={async (next) => {
                await loadInbox(true);
                if (host.source.store.getState().target) await host.source.load(availableAccounts, host.scopeVersion, true);
                await refreshSelectedSenderState();
                if (next.receipt?.status === 'undone' || next.status === 'completed' || next.status === 'partial') {
                  setSelectedThreadKeys([]);
                }
              }}
            />
          </div>
        </div>
      , host.portal)}
      {previewAttachment && createPortal(
        <ImageLightbox
          src={previewAttachment.src}
          alt={previewAttachment.alt}
          onClose={() => setPreviewAttachment(null)}
        />
      , host.portal)}
    </PageTransition>
  );
}

export default InboxPage;
