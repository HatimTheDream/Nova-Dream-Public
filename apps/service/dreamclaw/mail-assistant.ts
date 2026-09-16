import { createHash, randomUUID } from 'crypto';
import type { IndexedMailThread, MailIndexProvider, MailIndexSnapshot } from '../../../packages/domain/dreamclaw/mail-index.js';

import type { MailAssistantAction, MailAssistantPlanStatus, MailAssistantUndoStatus, MailAssistantCriteria, ParsedMailAssistantIntent, MailAssistantTarget, MailAssistantScope, MailAssistantApprovalReceipt, MailAssistantStoredReceipt, MailAssistantSelectionRequest, MailAssistantPlan, MailAssistantPrepareResult, MailAssistantApplyResult, MailAssistantUndoResult } from '../../../packages/domain/dreamclaw/mail-actions.js';
export type { MailAssistantAction, MailAssistantPlanStatus, MailAssistantUndoStatus, MailAssistantCriteria, ParsedMailAssistantIntent, MailAssistantTarget, MailAssistantScope, MailAssistantApprovalReceipt, MailAssistantStoredReceipt, MailAssistantSelectionRequest, MailAssistantPlan, MailAssistantPrepareResult, MailAssistantApplyResult, MailAssistantUndoResult } from '../../../packages/domain/dreamclaw/mail-actions.js';

export interface MailAssistantServiceDependencies {
  listIndexes: () => MailIndexSnapshot[];
  prepareTarget?: (
    target: MailAssistantTarget,
    action: MailAssistantAction,
  ) => Promise<{ target: MailAssistantTarget; executionToken: string }>;
  applyTarget: (
    target: MailAssistantTarget,
    action: MailAssistantAction,
    organization?: string,
    executionToken?: string,
  ) => Promise<{ undoToken?: string; undoUnsupportedReason?: string; completionDetail?: string } | void>;
  undoTarget?: (provider: MailIndexProvider, token: string) => Promise<void>;
  loadReceipt?: (receiptId: string) => MailAssistantStoredReceipt | null;
  saveReceipt?: (record: MailAssistantStoredReceipt) => void;
  now?: () => number;
}

const PLAN_TTL_MS = 10 * 60 * 1_000;
const MAX_PLAN_TARGETS = 500;
const APPLY_CONCURRENCY = 3;
const UNDO_TTL_MS = 15 * 60 * 1_000;
const EMAIL_ADDRESS_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/i;

function clean(value: unknown, maxLength = 1_000): string {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function durationMs(amount: number, unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith('day')) return amount * 24 * 60 * 60 * 1_000;
  if (normalized.startsWith('week')) return amount * 7 * 24 * 60 * 60 * 1_000;
  if (normalized.startsWith('month')) return amount * 30 * 24 * 60 * 60 * 1_000;
  return amount * 365 * 24 * 60 * 60 * 1_000;
}

function extractOrganization(request: string, action: MailAssistantAction): string | undefined {
  const source = clean(request);
  const patterns = action === 'remove-organization'
    ? [
        /\bremove\s+(?:the\s+)?(?:label|category|tag|folder)\s+["']?(.+?)["']?(?=\s+from\b|\s+on\b|\s+for\b|[,.!?]|$)/i,
        /\bremove\s+["']?(.+?)["']?\s+(?:label|category|tag|folder)(?=\s+from\b|\s+on\b|\s+for\b|[,.!?]|$)/i,
      ]
    : [
        /\b(?:apply|add)\s+(?:the\s+)?["']?(.+?)["']?\s+(?:label|category|tag|folder)\s+to\b/i,
        /\b(?:organize|categorize|file|put|move)\b[\s\S]*?\b(?:as|into|under|to)\s+["']?(.+?)["']?(?=\s+(?:from|sent|whose|with|that|older|newer|before|after|in\s+(?:gmail|outlook)|on\s+(?:gmail|outlook))\b|[,.!?]|$)/i,
        /\b(?:label|tag)\s+(?:them|it|the\s+(?:emails?|messages?))?\s*(?:as|with)?\s*["']?(.+?)["']?(?=\s+(?:from|sent|whose|older|newer|before|after)\b|[,.!?]|$)/i,
      ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const candidate = clean(match?.[1], 120)
      .replace(/^(?:the\s+)?(?:label|category|tag|folder)\s+/i, '')
      .replace(/^the\s+/i, '')
      .replace(/["']+$/g, '')
      .trim();
    if (!candidate) continue;
    if (/^(?:archive|archived|trash|deleted?|read|unread|starred?|flagged?)$/i.test(candidate)) continue;
    return candidate;
  }
  return undefined;
}

function extractSender(request: string): string | undefined {
  const directSender = request.match(new RegExp(`\\b(?:unsubscribe(?:\\s+from)?|block|unblock)\\s+(?:emails?\\s+from\\s+|mail\\s+from\\s+|sender\\s+)?(${EMAIL_ADDRESS_RE.source})`, 'i'));
  if (directSender?.[1]) return clean(directSender[1], 320).toLowerCase();
  const emailSender = request.match(new RegExp(`\\b(?:from|sent\\s+by)\\s+(${EMAIL_ADDRESS_RE.source})`, 'i'));
  if (emailSender?.[1]) return clean(emailSender[1], 320).toLowerCase();
  const patterns = [
    /\b(?:emails?|mail|messages?|threads?)\s+(?:sent\s+)?from\s+["']?(.+?)["']?(?=\s+(?:with|whose|that|which|older|newer|before|after|into|under|as|to)\b|[,.!?]|$)/i,
    /\bsent\s+by\s+["']?(.+?)["']?(?=\s+(?:with|whose|that|which|older|newer|before|after|into|under|as)\b|[,.!?]|$)/i,
    /\bfrom\s+["']?(.+?)["']?(?=\s+(?:with|whose|that|which|older|newer|before|after|into|under|as|to)\b|[,.!?]|$)/i,
    /\b(?:delete|trash|archive|mark|star|flag|pin|organize|categorize)\s+(?:all\s+)?["']?(.+?)["']?\s+(?:emails?|messages?|threads?)(?=\s+(?:as|into|under|older|newer|before|after|read|unread)\b|[,.!?]|$)/i,
  ];
  for (const pattern of patterns) {
    const candidate = clean(request.match(pattern)?.[1], 160).replace(/["']+$/g, '').trim();
    if (candidate && !/^(?:my|all|every|read|unread|old|new|the|my\s+)?(?:gmail|outlook|microsoft|inbox|mailbox|account)?$/i.test(candidate)) return candidate;
  }
  return undefined;
}

function extractTextFilter(request: string): string | undefined {
  const patterns = [
    /\b(?:subject|subjects)\s+(?:is|are|contains?|containing|about|matching)?\s*["'](.+?)["']/i,
    /\b(?:subject|subjects)\s+(?:is|are|contains?|containing|about|matching)\s+(.+?)(?=\s+(?:from|older|newer|before|after|into|under|as)\b|[,.!?]|$)/i,
    /\b(?:containing|mentioning|about)\s+["'](.+?)["']/i,
  ];
  for (const pattern of patterns) {
    const candidate = clean(request.match(pattern)?.[1], 200);
    if (candidate) return candidate;
  }
  return undefined;
}

function inferCategory(request: string): string | undefined {
  const lower = request.toLowerCase();
  if (/\b(newsletters?|promotions?|promotional|marketing|sales?|coupons?|social)\b/.test(lower)) return 'promo_social';
  if (/\b(receipts?|invoices?|billing|bills?|payments?|account alerts?|action required)\b/.test(lower)) return 'account_billing_action_required';
  if (/\b(calendar|meetings?|appointments?|invites?|logistics)\b/.test(lower)) return 'calendar_logistics';
  if (/\b(updates?|notifications?|digests?|reports?|tools?)\b/.test(lower)) return 'updates_tools';
  if (/\b(personal|outreach|people)\b/.test(lower)) return 'personal_outreach';
  return undefined;
}

function extractAccountSelector(request: string): string | undefined {
  const match = request.match(new RegExp(`\\b(?:in|on|using)\\s+(?:my\\s+)?(?:(?:gmail|outlook|microsoft)\\s+)?(?:account|mailbox|inbox)?\\s*(${EMAIL_ADDRESS_RE.source})`, 'i'));
  return clean(match?.[1], 320).toLowerCase() || undefined;
}

function extractDateCriteria(request: string, now: number): Pick<MailAssistantCriteria, 'before' | 'after'> {
  const relative = request.match(/\b(older|newer)\s+than\s+(\d{1,4})\s*(days?|weeks?|months?|years?)\b/i);
  if (relative) {
    const point = new Date(now - durationMs(Number(relative[2]), relative[3])).toISOString();
    return relative[1].toLowerCase() === 'older' ? { before: point } : { after: point };
  }
  const last = request.match(/\b(?:from|within|in)\s+the\s+last\s+(\d{1,4})\s*(days?|weeks?|months?|years?)\b/i);
  if (last) return { after: new Date(now - durationMs(Number(last[1]), last[2])).toISOString() };
  const absolute = request.match(/\b(before|after)\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (absolute) {
    const timestamp = Date.parse(`${absolute[2]}T00:00:00.000Z`);
    if (Number.isFinite(timestamp)) {
      return absolute[1].toLowerCase() === 'before'
        ? { before: new Date(timestamp).toISOString() }
        : { after: new Date(timestamp).toISOString() };
    }
  }
  return {};
}

function hasExplicitMailMutationRequest(source: string): boolean {
  return source.split(/[\r\n!?;]+/).some((segment) => {
    const lower = segment.toLowerCase();
    if (/\bunsubscribe\b/.test(lower)) return true;
    if (/\b(?:block|unblock)\b[\s\S]{0,60}\b(?:sender|emails?|mail|messages?)\b/.test(lower)) return true;
    if (new RegExp(`\\b(?:block|unblock)\\b[\\s\\S]{0,80}${EMAIL_ADDRESS_RE.source}`, 'i').test(segment)) return true;

    const actionMatches = [...lower.matchAll(/\b(?:delete|trash|archive|mark|set|make|star|flag|pin|unstar|unflag|unpin|organize|categorize|file|label|tag|apply|add|remove|move|put)\b/g)];
    const objectPattern = new RegExp(`\\b(?:emails?|mail|mailbox|inbox|gmail|outlook|messages?|threads?|newsletters?|receipts?|invoices?|sender)\\b|${EMAIL_ADDRESS_RE.source}`, 'gi');
    const objectMatches = [...segment.matchAll(objectPattern)];
    return actionMatches.some((action) => objectMatches.some((object) => (
      Math.abs((action.index || 0) - (object.index || 0)) <= 120
    )));
  });
}

export function parseMailAssistantIntent(request: string, now = Date.now()): ParsedMailAssistantIntent | null {
  const structuredSource = String(request || '').trim().slice(0, 4_000);
  const source = clean(structuredSource, 4_000);
  const lower = source.toLowerCase();
  if (!source || !/\b(emails?|mail|inbox|gmail|outlook|messages?|threads?|newsletters?|receipts?|invoices?|unsubscribe|block|unblock)\b/i.test(source)) return null;
  if (!hasExplicitMailMutationRequest(structuredSource)) return null;

  const requestsDelete = /\b(?:delete|trash|move\s+to\s+(?:the\s+)?trash)\b/.test(lower);
  const requestsArchive = /\b(?:archive|move\s+to\s+(?:the\s+)?archive)\b/.test(lower);
  const requestsUnsubscribe = /\bunsubscribe\b/.test(lower);
  const requestsUnblock = /\bunblock\b/.test(lower);
  const requestsBlock = !requestsUnblock && /\bblock\b[\s\S]{0,50}\b(?:sender|emails?|mail|messages?)\b|\bblock\s+(?:this|the)\s+sender\b/.test(lower);
  const requestedFamilies = [
    requestsDelete,
    requestsArchive,
    /\b(?:mark|set|make)\b[\s\S]*?\b(?:read|unread)\b/.test(lower),
    /\b(?:star|flag|pin|unstar|unflag|unpin)\b/.test(lower),
    /\b(?:organize|categorize|file|label|tag|apply\s+(?:a|the)?\s*(?:label|category|tag)|add\s+(?:a|the)?\s*(?:label|category|tag)|put)\b/.test(lower)
      || (/\bmove\b/.test(lower) && !requestsDelete && !requestsArchive),
    requestsUnsubscribe,
    requestsBlock || requestsUnblock,
  ].filter(Boolean).length;
  if (requestedFamilies > 1) {
    return {
      action: 'organize',
      criteria: { explicitAll: false },
      clarification: 'I found more than one mailbox operation in that request. Give me one action at a time so I can show an exact preview and confirmation for each change.',
    };
  }

  let action: MailAssistantAction | undefined;
  if (requestsUnsubscribe) action = 'unsubscribe';
  else if (requestsUnblock) action = 'unblock-sender';
  else if (requestsBlock) action = 'block-sender';
  else if (/\b(?:delete|trash|move\s+to\s+(?:the\s+)?trash)\b/.test(lower)) action = 'delete';
  else if (/\b(?:archive|move\s+to\s+(?:the\s+)?archive)\b/.test(lower)) action = 'archive';
  else if (/\b(?:mark|set|make)\b[\s\S]*?\bunread\b/.test(lower)) action = 'mark-unread';
  else if (/\b(?:mark|set|make)\b[\s\S]*?\bread\b/.test(lower)) action = 'mark-read';
  else if (/\b(?:unstar|unflag|unpin|remove\s+(?:the\s+)?(?:star|flag|pin))\b/.test(lower)) action = 'unflag';
  else if (/\b(?:star|flag|pin)\b/.test(lower)) action = 'flag';
  else if (/\bremove\b[\s\S]*?\b(?:label|category|tag|folder)\b/.test(lower)) action = 'remove-organization';
  else if (/\b(?:organize|categorize|file|label|tag|apply\s+(?:a|the)?\s*(?:label|category|tag)|add\s+(?:a|the)?\s*(?:label|category|tag)|move|put)\b/.test(lower)) action = 'organize';
  if (!action) return null;

  if (/\b(?:do\s+not|don't|never)\b[\s\S]{0,40}\b(?:delete|trash|archive|mark|star|flag|pin|organize|categorize|file|label|tag|move|put|unsubscribe|block|unblock)\b/.test(lower)) {
    return {
      action,
      criteria: { explicitAll: false },
      clarification: 'Understood. I will not change any email from that request.',
    };
  }

  const organization = action === 'organize' || action === 'remove-organization'
    ? extractOrganization(source, action)
    : undefined;
  if ((action === 'organize' || action === 'remove-organization') && !organization) {
    return {
      action,
      criteria: { explicitAll: false },
      clarification: 'Which Gmail label or Outlook category should I use? For example: “Organize newsletters as Subscriptions.”',
    };
  }

  const provider = /\bgmail\b/i.test(source)
    ? 'gmail'
    : /\b(?:outlook|microsoft|live\.com|hotmail)\b/i.test(source)
      ? 'microsoft'
      : undefined;
  const readState = /\bunread\b/i.test(source) && action !== 'mark-unread'
    ? 'unread'
    : /\bread\b/i.test(source) && action !== 'mark-read'
      ? 'read'
      : undefined;
  const criteria: MailAssistantCriteria = {
    provider,
    accountId: extractAccountSelector(source),
    sender: extractSender(source),
    text: extractTextFilter(source),
    category: inferCategory(source),
    readState,
    ...extractDateCriteria(source, now),
    explicitAll: /\b(?:all|every|everything)\b/i.test(source),
  };

  if ((action === 'unsubscribe' || action === 'block-sender' || action === 'unblock-sender') && !criteria.sender) {
    return {
      action,
      criteria,
      clarification: 'Name one exact sender address, or use the sender action from an open Inbox conversation so I can verify it against a fresh provider message.',
    };
  }

  if (/\bold\b/i.test(source) && !criteria.before && !criteria.after) {
    return {
      action,
      organization,
      criteria,
      clarification: 'How old should the emails be? Give me a concrete boundary such as “older than 90 days” or “before 2026-01-01.”',
    };
  }

  const hasFilter = Boolean(
    criteria.provider
    || criteria.accountId
    || criteria.sender
    || criteria.text
    || criteria.category
    || criteria.readState
    || criteria.before
    || criteria.after,
  );
  if (!hasFilter && !criteria.explicitAll) {
    return {
      action,
      organization,
      criteria,
      clarification: 'Which emails should I change? Name a sender, subject, account, category, read state, or date range. Say “all emails” only if you truly mean the whole indexed inbox.',
    };
  }

  return { action, organization, criteria };
}

function includesNormalized(haystack: string, needle: string): boolean {
  const normalizedNeedle = needle.toLowerCase().replace(/^['"]|['"]$/g, '').trim();
  if (!normalizedNeedle) return true;
  return haystack.toLowerCase().includes(normalizedNeedle);
}

function matchesThread(thread: IndexedMailThread, criteria: MailAssistantCriteria): boolean {
  if (criteria.sender && !includesNormalized(thread.from, criteria.sender)) return false;
  const haystack = [
    thread.subject,
    thread.from,
    thread.summary,
    thread.latestSnippet,
    thread.latestBody,
    thread.category,
    ...thread.labels,
    ...thread.providerTags,
  ].join(' ');
  if (criteria.text && !includesNormalized(haystack, criteria.text)) return false;
  if (criteria.category && thread.category !== criteria.category) return false;
  const unread = thread.labels.some((label) => /^UNREAD$/i.test(label));
  if (criteria.readState === 'unread' && !unread) return false;
  if (criteria.readState === 'read' && unread) return false;
  const timestamp = Date.parse(thread.date || '');
  if (criteria.before && (!Number.isFinite(timestamp) || timestamp >= Date.parse(criteria.before))) return false;
  if (criteria.after && (!Number.isFinite(timestamp) || timestamp < Date.parse(criteria.after))) return false;
  return true;
}

function actionLabel(action: MailAssistantAction, organization?: string): string {
  switch (action) {
    case 'delete': return 'Move to trash';
    case 'archive': return 'Archive';
    case 'mark-read': return 'Mark as read';
    case 'mark-unread': return 'Mark as unread';
    case 'flag': return 'Star or flag';
    case 'unflag': return 'Remove star or flag';
    case 'organize': return `Organize as ${organization || 'the requested label'}`;
    case 'remove-organization': return `Remove ${organization || 'the requested label'}`;
    case 'unsubscribe': return 'Unsubscribe';
    case 'block-sender': return 'Block sender';
    case 'unblock-sender': return 'Unblock sender';
  }
}

function hasValue(values: string[], value: string): boolean {
  return values.some((candidate) => candidate.toLowerCase() === value.toLowerCase());
}

function threadActionPreview(
  thread: IndexedMailThread,
  action: MailAssistantAction,
  organization?: string,
): { before: string; after: string; changes: boolean } {
  const unread = hasValue(thread.labels, 'UNREAD');
  const flagged = hasValue(thread.labels, 'STARRED') || hasValue(thread.labels, 'FLAGGED');
  const organized = Boolean(organization) && (
    hasValue(thread.labels, organization || '') || hasValue(thread.providerTags, organization || '')
  );
  switch (action) {
    case 'delete': return { before: 'In mailbox', after: 'Trash', changes: true };
    case 'archive': return { before: 'Inbox', after: 'Archive', changes: true };
    case 'mark-read': return { before: unread ? 'Unread' : 'Read', after: 'Read', changes: unread };
    case 'mark-unread': return { before: unread ? 'Unread' : 'Read', after: 'Unread', changes: !unread };
    case 'flag': return { before: flagged ? 'Flagged' : 'Not flagged', after: 'Flagged', changes: !flagged };
    case 'unflag': return { before: flagged ? 'Flagged' : 'Not flagged', after: 'Not flagged', changes: flagged };
    case 'organize': return {
      before: organized ? `${organization} applied` : `${organization} not applied`,
      after: `${organization} applied`,
      changes: !organized,
    };
    case 'remove-organization': return {
      before: organized ? `${organization} applied` : `${organization} not applied`,
      after: `${organization} removed`,
      changes: organized,
    };
    case 'unsubscribe': return { before: 'Subscribed', after: 'Unsubscribe requested', changes: true };
    case 'block-sender': return { before: 'Future mail allowed', after: 'Future mail routed away', changes: true };
    case 'unblock-sender': return { before: 'Future mail routed away', after: 'Future mail allowed', changes: true };
  }
}

function toTarget(
  snapshot: MailIndexSnapshot,
  thread: IndexedMailThread,
  action: MailAssistantAction,
  organization?: string,
): MailAssistantTarget | null {
  const preview = threadActionPreview(thread, action, organization);
  if (!preview.changes) return null;
  return {
    provider: snapshot.provider,
    accountId: snapshot.accountId,
    threadId: thread.id,
    sourceMessageId: thread.sourceMessageId,
    subject: clean(thread.subject, 500) || '(no subject)',
    from: clean(thread.from, 500) || '(unknown sender)',
    date: clean(thread.date, 100),
    messageCount: Math.max(1, Math.round(Number(thread.messageCount) || 1)),
    before: preview.before,
    after: preview.after,
  };
}

function buildScopes(targets: MailAssistantTarget[]): MailAssistantScope[] {
  const scopes = new Map<string, MailAssistantScope>();
  for (const target of targets) {
    const key = `${target.provider}:${target.accountId}`;
    const current = scopes.get(key);
    if (current) {
      current.targetCount += 1;
      current.messageCount += target.messageCount;
      if (current.before !== target.before) current.before = 'Current provider state';
      if (current.after !== target.after) current.after = 'Requested provider state';
      continue;
    }
    scopes.set(key, {
      provider: target.provider,
      accountId: target.accountId,
      targetCount: 1,
      messageCount: target.messageCount,
      before: target.before,
      after: target.after,
    });
  }
  return [...scopes.values()];
}

function planDigest(plan: Omit<MailAssistantPlan, 'digest' | 'status'>): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function undoDigest(receiptId: string, approvalDigest: string, expiresAt: string, nonce: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ receiptId, approvalDigest, expiresAt, nonce }))
    .digest('hex');
}

function publicApplyError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error || '');
  if (/reconnect|authorization|credential|token|401|403/i.test(detail)) return 'An account needs to be reconnected before it can be changed.';
  if (/network|offline|timed? ?out|ECONN|ENOTFOUND/i.test(detail)) return 'The mail provider was temporarily unreachable.';
  if (/not found|no longer available|404/i.test(detail)) return 'An item was no longer available and was skipped.';
  return 'The provider did not accept this change.';
}

export class MailAssistantService {
  private readonly plans = new Map<string, { plan: MailAssistantPlan; used: boolean; executionTokens: Map<string, string> }>();
  private readonly receipts = new Map<string, MailAssistantStoredReceipt>();
  private readonly now: () => number;
  private readonly dependencies: MailAssistantServiceDependencies;

  constructor(dependencies: MailAssistantServiceDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now || Date.now;
  }

  async prepare(request: string): Promise<MailAssistantPrepareResult> {
    const intent = parseMailAssistantIntent(request, this.now());
    if (!intent) return { handled: false, success: false };
    if (intent.clarification) {
      return { handled: true, success: false, clarification: intent.clarification };
    }

    const snapshots = this.dependencies.listIndexes()
      .filter((snapshot) => !intent.criteria.provider || snapshot.provider === intent.criteria.provider)
      .filter((snapshot) => !intent.criteria.accountId || snapshot.accountId.toLowerCase() === intent.criteria.accountId);
    if (snapshots.length === 0) {
      return {
        handled: true,
        success: false,
        clarification: 'I cannot see a matching connected mailbox index yet. Open Inbox once so Dream Claw can sync it, or reconnect the account in Settings.',
      };
    }

    const incompleteAccounts = snapshots
      .filter((snapshot) => snapshot.status !== 'complete' || !snapshot.exhausted)
      .map((snapshot) => snapshot.accountId);
    if (intent.criteria.explicitAll && incompleteAccounts.length > 0) {
      return {
        handled: true,
        success: false,
        clarification: `I will not apply an “all email” action while ${incompleteAccounts.length} mailbox index${incompleteAccounts.length === 1 ? ' is' : 'es are'} incomplete. Let Inbox finish syncing, then ask again.`,
      };
    }

    const candidates = snapshots.flatMap((snapshot) => snapshot.threads
      .filter((thread) => matchesThread(thread, intent.criteria))
      .map((thread) => ({ snapshot, thread })));
    if (candidates.length === 0) {
      return {
        handled: true,
        success: false,
        clarification: 'I did not find any matching conversations in the connected indexed inboxes. Try a broader sender or subject, or refresh Inbox first.',
      };
    }
    return this.createPlan({
      request,
      action: intent.action,
      organization: intent.organization,
      candidates,
      incompleteAccounts,
    });
  }

  /** E3 reads exact provider messages first; reuse the original plan and scope
   * construction with their verified before/after summaries. */
  prepareVerifiedSelection(selection: MailAssistantSelectionRequest, targets: MailAssistantTarget[]) {
    return this.createPlan({ request: `Inbox selection: ${actionLabel(selection.action, selection.organization)}`, action: selection.action, organization: selection.organization, candidates: [], incompleteAccounts: [], verifiedTargets: targets });
  }

  async prepareSelection(selection: MailAssistantSelectionRequest): Promise<MailAssistantPrepareResult> {
    const action = selection?.action;
    const organization = clean(selection?.organization, 120) || undefined;
    if (!['delete', 'archive', 'mark-read', 'mark-unread', 'flag', 'unflag', 'organize', 'remove-organization', 'unsubscribe', 'block-sender', 'unblock-sender'].includes(action)) {
      return { handled: true, success: false, error: 'This email action is not supported.' };
    }
    if ((action === 'organize' || action === 'remove-organization') && !organization) {
      return { handled: true, success: false, clarification: 'Choose a Gmail label or Outlook category first.' };
    }
    const requestedTargets = Array.isArray(selection.targets) ? selection.targets.slice(0, MAX_PLAN_TARGETS + 1) : [];
    if (requestedTargets.length === 0) {
      return { handled: true, success: false, clarification: 'Select at least one conversation first.' };
    }
    if (requestedTargets.length > MAX_PLAN_TARGETS) {
      return { handled: true, success: false, clarification: `Select ${MAX_PLAN_TARGETS} or fewer conversations for one reviewed action.` };
    }

    const snapshots = this.dependencies.listIndexes();
    const seen = new Set<string>();
    const candidates: Array<{ snapshot: MailIndexSnapshot; thread: IndexedMailThread }> = [];
    let missing = 0;
    for (const requested of requestedTargets) {
      const provider = requested?.provider;
      const accountId = clean(requested?.accountId, 320);
      const threadId = clean(requested?.threadId, 1_000);
      const key = `${provider}:${accountId}:${threadId}`;
      if ((provider !== 'gmail' && provider !== 'microsoft') || !accountId || !threadId || seen.has(key)) continue;
      seen.add(key);
      const snapshot = snapshots.find((candidate) => candidate.provider === provider && candidate.accountId === accountId);
      const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
      if (!snapshot || !thread) {
        missing += 1;
        continue;
      }
      candidates.push({ snapshot, thread });
    }
    if (candidates.length === 0) {
      return {
        handled: true,
        success: false,
        clarification: 'Those conversations are no longer present in the trusted local index. Refresh Inbox and select them again.',
      };
    }
    const selectedSnapshots = [...new Map(candidates.map(({ snapshot }) => [`${snapshot.provider}:${snapshot.accountId}`, snapshot])).values()];
    const incompleteAccounts = selectedSnapshots
      .filter((snapshot) => snapshot.status !== 'complete' || !snapshot.exhausted)
      .map((snapshot) => snapshot.accountId);
    return this.createPlan({
      request: `Inbox selection: ${actionLabel(action, organization)}`,
      action,
      organization,
      candidates,
      incompleteAccounts,
      warning: missing > 0
        ? `${missing} selected conversation${missing === 1 ? ' was' : 's were'} no longer available and will not be changed.`
        : undefined,
    });
  }

  private async createPlan(input: {
    request: string;
    action: MailAssistantAction;
    organization?: string;
    candidates: Array<{ snapshot: MailIndexSnapshot; thread: IndexedMailThread }>;
    incompleteAccounts: string[];
    warning?: string;
    verifiedTargets?: MailAssistantTarget[];
  }): Promise<MailAssistantPrepareResult> {
    let targets = input.verifiedTargets ?? input.candidates
      .map(({ snapshot, thread }) => toTarget(snapshot, thread, input.action, input.organization))
      .filter((target): target is MailAssistantTarget => Boolean(target));
    const senderAction = input.action === 'unsubscribe' || input.action === 'block-sender' || input.action === 'unblock-sender';
    const executionTokens = new Map<string, string>();
    if (senderAction) {
      if (!this.dependencies.prepareTarget) {
        return { handled: true, success: false, error: 'Verified sender actions are unavailable in this build.' };
      }
      const preparedTargets: MailAssistantTarget[] = [];
      const seenSenders = new Set<string>();
      for (const target of targets) {
        if (!target.sourceMessageId) continue;
        try {
          const prepared = await this.dependencies.prepareTarget(target, input.action);
          const senderKey = `${prepared.target.provider}:${prepared.target.accountId}:${prepared.target.senderAddress || prepared.target.from}`;
          if (seenSenders.has(senderKey)) continue;
          seenSenders.add(senderKey);
          preparedTargets.push(prepared.target);
          executionTokens.set(`${prepared.target.provider}:${prepared.target.accountId}:${prepared.target.threadId}`, prepared.executionToken);
        } catch (error) {
          if (targets.length === 1) {
            return {
              handled: true,
              success: false,
              clarification: error instanceof Error ? error.message : 'Dream Claw could not verify this sender with the provider.',
            };
          }
        }
      }
      targets = preparedTargets;
    }
    if (targets.length === 0) {
      return {
        handled: true,
        success: false,
        clarification: 'The matching conversations already have the requested state, so there is nothing to change.',
      };
    }
    if (targets.length > MAX_PLAN_TARGETS) {
      return {
        handled: true,
        success: false,
        clarification: `I found ${targets.length.toLocaleString()} matching conversations, which is too many for one safe operation. Narrow the sender, date range, account, or category and I will prepare a smaller batch.`,
      };
    }

    const now = this.now();
    const messageCount = targets.reduce((sum, target) => sum + target.messageCount, 0);
    const accountCount = new Set(targets.map((target) => `${target.provider}:${target.accountId}`)).size;
    const core: Omit<MailAssistantPlan, 'digest' | 'status'> = {
      id: randomUUID(),
      request: clean(input.request, 4_000),
      action: input.action,
      organization: input.organization,
      destructive: input.action === 'delete' || input.action === 'unsubscribe' || input.action === 'block-sender',
      summary: `${actionLabel(input.action, input.organization)} ${targets.length.toLocaleString()} conversation${targets.length === 1 ? '' : 's'} (${messageCount.toLocaleString()} message${messageCount === 1 ? '' : 's'}) across ${accountCount} account${accountCount === 1 ? '' : 's'}.`,
      targetCount: targets.length,
      messageCount,
      targets,
      scopes: buildScopes(targets),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
      incompleteAccounts: input.incompleteAccounts,
      warning: input.warning || (input.incompleteAccounts.length > 0
        ? `The index is still syncing for ${input.incompleteAccounts.join(', ')}; this plan covers the matches currently indexed.`
        : undefined),
    };
    const plan: MailAssistantPlan = {
      ...core,
      digest: planDigest(core),
      status: 'awaiting_confirmation',
    };
    this.plans.set(plan.id, { plan, used: false, executionTokens });
    this.pruneExpired();
    return { handled: true, success: true, plan };
  }

  cancel(planId: string, digest: string): { success: boolean; status: 'cancelled' | 'expired'; error?: string } {
    const record = this.plans.get(clean(planId, 200));
    if (!record || record.plan.digest !== clean(digest, 128) || record.used || Date.parse(record.plan.expiresAt) <= this.now()) {
      return { success: false, status: 'expired', error: 'This email action plan is no longer available.' };
    }
    record.used = true;
    record.plan.status = 'cancelled';
    return { success: true, status: 'cancelled' };
  }

  async apply(planId: string, digest: string): Promise<MailAssistantApplyResult> {
    const record = this.plans.get(clean(planId, 200));
    if (!record || record.plan.digest !== clean(digest, 128) || record.used || Date.parse(record.plan.expiresAt) <= this.now()) {
      return {
        success: false,
        status: 'expired',
        succeeded: 0,
        failed: 0,
        message: 'This email action plan expired or was already used. Ask me to prepare it again so the matches can be rechecked.',
      };
    }

    record.used = true;
    record.plan.status = 'applying';
    const approvedAt = new Date(this.now()).toISOString();
    const receipt: MailAssistantApprovalReceipt = {
      id: randomUUID(),
      planId: record.plan.id,
      approvalDigest: record.plan.digest,
      action: record.plan.action,
      organization: record.plan.organization,
      decision: 'approved',
      status: 'applying',
      approvedAt,
      scopes: record.plan.scopes,
      targetCount: record.plan.targetCount,
      messageCount: record.plan.messageCount,
      succeeded: 0,
      failed: 0,
      summary: `Approved ${actionLabel(record.plan.action, record.plan.organization)} for ${record.plan.targetCount.toLocaleString()} conversation${record.plan.targetCount === 1 ? '' : 's'}.`,
      undo: { status: 'unsupported', reason: 'Waiting for the mail providers to confirm rollback support.' },
    };
    try {
      this.writeReceipt({ receipt, undoTokens: [], undoUsed: false });
    } catch {
      record.plan.status = 'partial';
      return {
        success: false,
        status: 'partial',
        succeeded: 0,
        failed: 0,
        message: 'Dream Claw could not create the required approval receipt, so no email was changed.',
      };
    }

    let nextIndex = 0;
    let succeeded = 0;
    const errors: string[] = [];
    const receiptErrors: string[] = [];
    const undoTokens: Array<{ provider: MailIndexProvider; token: string }> = [];
    const undoUnsupportedReasons: string[] = [];
    const completionDetails: string[] = [];
    const workers = Array.from({ length: Math.min(APPLY_CONCURRENCY, record.plan.targets.length) }, async () => {
      while (nextIndex < record.plan.targets.length) {
        const target = record.plan.targets[nextIndex];
        nextIndex += 1;
        try {
          const execution = await this.dependencies.applyTarget(
            target,
            record.plan.action,
            record.plan.organization,
            record.executionTokens.get(`${target.provider}:${target.accountId}:${target.threadId}`),
          );
          succeeded += 1;
          if (execution?.undoToken) undoTokens.push({ provider: target.provider, token: execution.undoToken });
          else undoUnsupportedReasons.push(execution?.undoUnsupportedReason || `${target.provider === 'gmail' ? 'Gmail' : 'Outlook'} did not provide a safe rollback for this change.`);
          if (execution?.completionDetail) completionDetails.push(execution.completionDetail);
        } catch (error) {
          const publicError = publicApplyError(error);
          if (errors.length < 5) errors.push(`${target.subject}: ${publicError}`);
          if (receiptErrors.length < 5 && !receiptErrors.includes(publicError)) receiptErrors.push(publicError);
        }
      }
    });
    await Promise.all(workers);

    const failed = record.plan.targets.length - succeeded;
    const status = failed === 0 ? 'completed' : 'partial';
    record.plan.status = status;
    const completedAt = new Date(this.now()).toISOString();
    const canUndo = succeeded > 0
      && Boolean(this.dependencies.undoTarget)
      && undoTokens.length === succeeded
      && undoUnsupportedReasons.length === 0;
    const undoExpiresAt = new Date(this.now() + UNDO_TTL_MS).toISOString();
    const finalReceipt: MailAssistantApprovalReceipt = {
      ...receipt,
      status: succeeded === 0 ? 'failed' : status,
      completedAt,
      succeeded,
      failed,
      summary: failed === 0
        ? completionDetails.length === succeeded && new Set(completionDetails).size === 1
          ? completionDetails[0]
          : `${actionLabel(record.plan.action, record.plan.organization)} completed for ${succeeded.toLocaleString()} conversation${succeeded === 1 ? '' : 's'}.`
        : `${succeeded.toLocaleString()} conversation${succeeded === 1 ? '' : 's'} changed; ${failed.toLocaleString()} could not be changed.`,
      ...(receiptErrors.length > 0 ? { errors: receiptErrors } : {}),
      undo: canUndo
        ? {
            status: 'available',
            expiresAt: undoExpiresAt,
            digest: undoDigest(receipt.id, record.plan.digest, undoExpiresAt, randomUUID()),
          }
        : {
            status: 'unsupported',
            reason: succeeded === 0
              ? 'No provider change completed, so there is nothing to undo.'
              : undoUnsupportedReasons[0] || 'This provider action cannot be reversed safely from Dream Claw.',
          },
    };
    try {
      this.writeReceipt({
        receipt: finalReceipt,
        undoTokens: canUndo ? undoTokens : [],
        undoUsed: false,
      });
    } catch {
      return {
        success: false,
        status: 'partial',
        succeeded,
        failed,
        message: `${finalReceipt.summary} The durable receipt could not be finalized; no automatic retry was attempted.`,
        ...(errors.length > 0 ? { errors } : {}),
        receipt: { ...finalReceipt, undo: { status: 'unsupported', reason: 'The rollback record could not be stored safely.' } },
      };
    }
    return {
      success: failed === 0,
      status,
      succeeded,
      failed,
      message: finalReceipt.summary,
      ...(errors.length > 0 ? { errors } : {}),
      receipt: finalReceipt,
    };
  }

  async undo(receiptId: string, digest: string): Promise<MailAssistantUndoResult> {
    const record = this.readReceipt(clean(receiptId, 200));
    const suppliedDigest = clean(digest, 128);
    if (!record) {
      return { success: false, status: 'expired', succeeded: 0, failed: 0, message: 'This undo receipt is no longer available.' };
    }
    if (record.receipt.undo.status === 'unsupported') {
      return {
        success: false,
        status: 'unsupported',
        succeeded: 0,
        failed: 0,
        message: record.receipt.undo.reason || 'This provider action cannot be reversed safely from Dream Claw.',
        receipt: record.receipt,
      };
    }
    if (
      record.undoUsed
      || record.receipt.undo.status !== 'available'
      || record.receipt.undo.digest !== suppliedDigest
      || !record.receipt.undo.expiresAt
      || Date.parse(record.receipt.undo.expiresAt) <= this.now()
    ) {
      const expiredReceipt: MailAssistantApprovalReceipt = record.receipt.undo.status === 'available'
        ? { ...record.receipt, undo: { status: 'expired', reason: 'The protected undo window expired.' } }
        : record.receipt;
      return {
        success: false,
        status: 'expired',
        succeeded: 0,
        failed: 0,
        message: 'This undo expired, was already used, or does not match the approved receipt.',
        receipt: expiredReceipt,
      };
    }
    if (!this.dependencies.undoTarget || record.undoTokens.length === 0) {
      return {
        success: false,
        status: 'unsupported',
        succeeded: 0,
        failed: 0,
        message: 'The provider rollback adapter is unavailable.',
        receipt: record.receipt,
      };
    }

    record.undoUsed = true;
    record.receipt = { ...record.receipt, undo: { ...record.receipt.undo, status: 'applying' } };
    this.writeReceipt(record);
    let nextIndex = 0;
    let succeeded = 0;
    const errors: string[] = [];
    const workers = Array.from({ length: Math.min(APPLY_CONCURRENCY, record.undoTokens.length) }, async () => {
      while (nextIndex < record.undoTokens.length) {
        const token = record.undoTokens[nextIndex];
        nextIndex += 1;
        try {
          await this.dependencies.undoTarget!(token.provider, token.token);
          succeeded += 1;
        } catch (error) {
          const publicError = publicApplyError(error);
          if (errors.length < 5 && !errors.includes(publicError)) errors.push(publicError);
        }
      }
    });
    await Promise.all(workers);
    const failed = record.undoTokens.length - succeeded;
    const undoStatus: Extract<MailAssistantUndoStatus, 'completed' | 'partial' | 'failed'> = failed === 0
      ? 'completed'
      : succeeded > 0
        ? 'partial'
        : 'failed';
    const finalReceipt: MailAssistantApprovalReceipt = {
      ...record.receipt,
      status: failed === 0 ? 'undone' : record.receipt.status,
      completedAt: new Date(this.now()).toISOString(),
      summary: failed === 0
        ? `Undid ${succeeded.toLocaleString()} provider change${succeeded === 1 ? '' : 's'} from receipt ${record.receipt.id.slice(0, 8)}.`
        : `${succeeded.toLocaleString()} provider change${succeeded === 1 ? '' : 's'} rolled back; ${failed.toLocaleString()} could not be rolled back.`,
      undo: {
        status: undoStatus,
        reason: failed > 0 ? 'Some mailbox state changed after approval or the provider rejected the rollback.' : undefined,
      },
      ...(errors.length > 0 ? { errors } : {}),
    };
    this.writeReceipt({ ...record, receipt: finalReceipt });
    return {
      success: failed === 0,
      status: undoStatus,
      succeeded,
      failed,
      message: finalReceipt.summary,
      ...(errors.length > 0 ? { errors } : {}),
      receipt: finalReceipt,
    };
  }

  private readReceipt(receiptId: string): MailAssistantStoredReceipt | null {
    const current = this.receipts.get(receiptId);
    if (current) return current;
    const loaded = this.dependencies.loadReceipt?.(receiptId) || null;
    if (loaded) this.receipts.set(receiptId, loaded);
    return loaded;
  }

  private writeReceipt(record: MailAssistantStoredReceipt): void {
    this.dependencies.saveReceipt?.(record);
    this.receipts.set(record.receipt.id, record);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [id, record] of this.plans) {
      if (record.used || Date.parse(record.plan.expiresAt) <= now) this.plans.delete(id);
    }
  }
}

export function mailAssistantMatchesForTest(
  thread: IndexedMailThread,
  criteria: MailAssistantCriteria,
): boolean {
  return matchesThread(thread, criteria);
}

export function mailAssistantActionLabel(action: MailAssistantAction, organization?: string): string {
  return actionLabel(action, organization);
}

export function mailAssistantSenderPatternForTest(value: string): RegExp {
  return new RegExp(escapeRegex(value), 'i');
}
