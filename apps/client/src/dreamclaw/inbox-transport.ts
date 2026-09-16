import type { AccountsState, ConnectedAccount } from '../../../../packages/domain/accounts';
import type { MailReadRequest, MailReadResult, MailReadSelector } from '../../../../packages/domain/mail';
import { request } from '../api';
import type { EmailImages } from '../../../../packages/domain/email-images';
import { createInboxIndexApi, inboxIndexTransport, type InboxIndexTransport } from './inbox-index-transport';
import type { NativeGmailLabel, NativeGmailSendAsAlias, NativeGmailStatus, NativeGmailThread, NativeGmailThreadSummary } from './services/native/gmail';
import type { NativeMicrosoftMailCategoryOption, NativeMicrosoftMailFolder, NativeMicrosoftMailMessageView, NativeMicrosoftMailStatus, NativeMicrosoftMailThreadDigest } from './services/native/microsoftMail';

export type InboxMailContext = { epoch: string; deviceId: string; accounts: AccountsState };
type Read = (input: MailReadRequest, signal: AbortSignal) => Promise<MailReadResult>;
type Failure = { success: false; error: string; account?: never; result?: never };
type Attachment = NonNullable<NativeMicrosoftMailMessageView['attachments']>[number] & { type?: string };
type AttachmentBytes = { base64: string; bytes: number };
type Page<T> = { data: T; coverage: MailReadResult['coverage']; next?: string; message?: string };
export const INBOX_FILE_BYTES = 10 * 1024 * 1024;
export const INBOX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const INBOX_READER_BYTES = 50 * 1024 * 1024;

/** Reserve before concurrent reads, including unknown-size parts at their maximum. */
export function selectInboxHydration<T extends { messageId: string; size?: number }>(targets: T[]): T[] {
  let total = 0;
  const perMessage = new Map<string, number>();
  return targets.filter(target => {
    const size = target.size ?? INBOX_FILE_BYTES, used = perMessage.get(target.messageId) ?? 0;
    if (!Number.isSafeInteger(size) || size < 0 || size > INBOX_FILE_BYTES || used + size > INBOX_MESSAGE_BYTES || total + size > INBOX_READER_BYTES) return false;
    perMessage.set(target.messageId, used + size); total += size; return true;
  });
}

const defaultRead: Read = (input, signal) => request('mail/read', input, signal, 35000);

/** One immutable account/device generation. A reconnect replaces and aborts it. */
export function createInboxMailApi(context: InboxMailContext, transport: Read = defaultRead, indexTransport: InboxIndexTransport | null = transport === defaultRead ? inboxIndexTransport : null) {
  const captured = structuredClone(context), controller = new AbortController();
  const assertCurrent = () => { if (controller.signal.aborted) throw new Error('The mail connection changed. Reopen this folder.'); };
  const account = (provider: ConnectedAccount['provider'], identity?: string) => {
    assertCurrent();
    const candidates = captured.accounts.accounts.filter(item => item.provider === provider && ['connected', 'refreshing'].includes(item.state));
    const matches = identity ? candidates.filter(item => item.id === identity || item.email.toLowerCase() === identity.toLowerCase()) : candidates;
    if (matches.length !== 1) throw new Error(identity ? 'Select the exact connected mail account again.' : 'Choose a mail account first.');
    if (!matches[0].capabilities.mailRead) throw new Error('This account needs permission to read mail.');
    return matches[0];
  };
  // Startup reads are consumed once by the real reader, so an explicit later
  // refresh still reaches the provider. Scope replacement retires all warm work.
  const warmed = new Map<string, { result: MailReadResult; expires: number; bytes: number }>();
  const warming = new Map<string, Promise<MailReadResult>>();
  let warmedBytes = 0;
  const forget = (key: string) => { warmedBytes -= warmed.get(key)?.bytes ?? 0; warmed.delete(key); };
  const read = async <T>(owner: ConnectedAccount, selector: MailReadSelector, cursor?: string, warm = false): Promise<Page<T>> => {
    assertCurrent();
    const input = { epoch: captured.epoch, accountId: owner.id, generation: owner.generation, selector, ...(cursor ? { cursor } : {}) };
    const key = JSON.stringify(input);
    for (const [key, entry] of warmed) if (entry.expires <= Date.now()) forget(key);
    let result = warmed.get(key)?.result;
    if (!result) {
      let pendingRead = warming.get(key);
      if (!pendingRead) {
        pendingRead = transport(input, controller.signal);
        if (warm) warming.set(key, pendingRead);
      }
      try { result = await pendingRead; } finally { if (warm) warming.delete(key); }
    }
    if (!warm) forget(key);
    assertCurrent();
    if (result.accountId !== owner.id || result.generation !== owner.generation || result.kind !== selector.kind) throw new Error('The returned mail belongs to a different view. Reopen this folder.');
    if (warm && result.coverage === 'complete' && !result.message) {
      const bytes = JSON.stringify(result).length * 2;
      forget(key);
      if (bytes <= 8 * 1024 * 1024) {
        while (warmed.size && (warmedBytes + bytes > 32 * 1024 * 1024 || warmed.size >= 64)) forget(warmed.keys().next().value!);
        warmed.set(key, { result, bytes, expires: Date.now() + 120000 }); warmedBytes += bytes;
      }
    }
    return { data: result.value as T, coverage: result.coverage, next: result.nextCursor, message: result.message };
  };
  const safe = async <T extends object>(run: () => Promise<T>, fallback: T): Promise<T & { error?: string }> => {
    try { const value = await run(); assertCurrent(); return { error: undefined, ...value }; } catch (error) {
      assertCurrent();
      return { ...fallback, success: false, error: error instanceof Error ? error.message : 'Mail could not be loaded.' };
    }
  };
  const pending = async (..._args: unknown[]): Promise<Failure> => ({ success: false, error: 'This original mail action is still being connected to Nova Dream. Your message has not been changed or sent.' });
  const settings = async (..._args: unknown[]): Promise<Failure> => ({ success: false, error: 'Open Settings → Connections to manage this Nova Dream account.' });
  const collect = async <T>(owner: ConnectedAccount, selector: MailReadSelector, key: string, maximum = 1000): Promise<{ items: T[]; partial: boolean; message?: string }> => {
    const items: T[] = [], seen = new Set<string>();
    let cursor: string | undefined, partial = false, message: string | undefined;
    do {
      let page: Page<Record<string, T[]>>;
      try { page = await read<Record<string, T[]>>(owner, selector, cursor); }
      catch (error) {
        assertCurrent(); if (!items.length) throw error;
        partial = true; message = 'Some later items could not load. The items already read remain available.'; break;
      }
      items.push(...page.data[key]); message = page.message ?? message;
      partial ||= page.coverage === 'partial' || (page.coverage === 'page' && !page.next); cursor = page.next;
      if (!cursor) break;
      if (seen.has(cursor) || items.length >= maximum || seen.size >= 250) { partial = true; break; }
      seen.add(cursor);
    } while (true);
    if (items.length > maximum) partial = true;
    return { items: items.slice(0, maximum), partial, ...(message ? { message } : partial ? { message: 'Only part of this mail view is available. Refresh to try again.' } : {}) };
  };
  const statusAccounts = (provider: ConnectedAccount['provider']) => captured.accounts.accounts.filter(item => item.provider === provider && ['connected', 'refreshing'].includes(item.state));
  const gmail = {
    async getStatus(): Promise<NativeGmailStatus> {
      assertCurrent();
      const accounts = statusAccounts('google').map(item => ({ id: item.id, generation: item.generation, email: item.email, client: 'Nova Dream', auth: 'OAuth', createdAt: item.connectedAt, services: ['gmail'], scopes: item.scopes, canRead: item.capabilities.mailRead, canSend: item.capabilities.mailSend, canDraft: item.capabilities.mailDraft, canModify: item.scopes.some(scope => scope.endsWith('/gmail.modify') || scope === 'https://mail.google.com/') }));
      return { success: true, available: accounts.length > 0, credentialsConfigured: !!captured.accounts.clients.find(item => item.provider === 'google')?.configured, accounts, defaultAccount: accounts.length === 1 ? accounts[0].id : undefined };
    },
    async searchThreads(input: { query: string; max?: number; account?: string; page?: string }) {
      return safe(async () => {
        const owner = account('google', input.account), page = await read<{ threads: NativeGmailThreadSummary[] }>(owner, { kind: 'gmail.threads', query: input.query, max: input.max ?? 25 }, input.page);
        return { success: true, account: owner.id, threads: page.data.threads, nextPageToken: page.next, exhausted: page.coverage === 'complete', error: page.message };
      }, { success: false, account: input.account, threads: [] as NativeGmailThreadSummary[], nextPageToken: undefined as string | undefined, exhausted: false, error: undefined as string | undefined });
    },
    async getThread(input: { threadId: string; account?: string }) {
      return safe(async () => {
        const owner = account('google', input.account), page = await read<{ thread: NativeGmailThread }>(owner, { kind: 'gmail.thread', threadId: input.threadId });
        return { success: true, account: owner.id, thread: page.data.thread };
      }, { success: false, account: input.account, thread: undefined as NativeGmailThread | undefined });
    },
    async getAttachment(input: { messageId: string; attachmentId: string; account?: string }) {
      const owner = account('google', input.account), page = await read<AttachmentBytes>(owner, { kind: 'gmail.attachment', messageId: input.messageId, attachmentId: input.attachmentId });
      return { success: true, account: owner.id as string | undefined, ...page.data };
    },
    async getSendAsAliases(input?: { account?: string }) {
      return safe(async () => {
        const owner = account('google', input?.account), page = await read<{ sendAs: NativeGmailSendAsAlias[] }>(owner, { kind: 'gmail.aliases' });
        return { success: true, account: owner.id, sendAs: page.data.sendAs };
      }, { success: false, account: input?.account, sendAs: [] as NativeGmailSendAsAlias[] });
    },
    async listLabels(input?: { account?: string }) {
      return safe(async () => {
        const owner = account('google', input?.account), page = await read<{ labels: NativeGmailLabel[] }>(owner, { kind: 'gmail.labels' });
        return { success: true, account: owner.id, labels: page.data.labels };
      }, { success: false, account: input?.account, labels: [] as NativeGmailLabel[] });
    },
    async getInboxStats(input?: { account?: string }) {
      return safe(async () => {
        const owner = account('google', input?.account), page = await read<{ messagesTotal?: number; messagesUnread?: number; threadsTotal?: number; threadsUnread?: number }>(owner, { kind: 'gmail.stats' });
        return { success: true, account: owner.id as string | undefined, ...page.data };
      }, { success: false, account: input?.account, messagesTotal: undefined as number | undefined, messagesUnread: undefined as number | undefined, threadsTotal: undefined as number | undefined, threadsUnread: undefined as number | undefined });
    },
    modifyThread: pending, trashThread: pending, createDraft: pending, sendEmail: pending,
  };
  const microsoftMail = {
    async getStatus(): Promise<NativeMicrosoftMailStatus> {
      assertCurrent();
      const client = captured.accounts.clients.find(item => item.provider === 'microsoft');
      return { success: true, available: statusAccounts('microsoft').length > 0, clientConfigured: !!client?.configured, tenant: client?.tenant ?? 'common', accounts: statusAccounts('microsoft').map(item => ({ id: item.id, generation: item.generation, provider: 'microsoft', email: item.email, displayName: item.label, hasSignature: false, createdAt: item.connectedAt, updatedAt: item.updatedAt, scopes: item.scopes, canRead: item.capabilities.mailRead, canSend: item.capabilities.mailSend, canDraft: item.capabilities.mailDraft, canModify: item.scopes.some(scope => /(^|\/)mail\.readwrite$/i.test(scope)), canUseCalendar: item.capabilities.calendarRead })) };
    },
    async listInboxThreads(input: { accountId: string; folder?: NativeMicrosoftMailFolder; maxMessages?: number; nextLink?: string; unreadOnly?: boolean }) {
      return safe(async () => {
        const owner = account('microsoft', input.accountId), page = await read<{ threads: NativeMicrosoftMailThreadDigest[] }>(owner, { kind: 'microsoft.threads', folder: input.folder ?? 'inbox', max: input.maxMessages ?? 25, unreadOnly: input.unreadOnly ?? false }, input.nextLink);
        return { success: true, accountId: owner.id, threads: page.data.threads, nextLink: page.next, exhausted: page.coverage === 'complete', error: page.message };
      }, { success: false, accountId: input.accountId, threads: [] as NativeMicrosoftMailThreadDigest[], nextLink: undefined as string | undefined, exhausted: false, error: undefined as string | undefined });
    },
    async getInboxStats(input: { accountId: string; folder?: NativeMicrosoftMailFolder }) {
      return safe(async () => {
        const owner = account('microsoft', input.accountId), page = await read<{ totalItemCount?: number; unreadItemCount?: number }>(owner, { kind: 'microsoft.stats', folder: input.folder ?? 'inbox' });
        return { success: true, accountId: owner.id, ...page.data };
      }, { success: false, accountId: input.accountId, totalItemCount: undefined as number | undefined, unreadItemCount: undefined as number | undefined });
    },
    async listCategories(input: { accountId: string }) {
      return safe(async () => {
        const owner = account('microsoft', input.accountId), result = await collect<NativeMicrosoftMailCategoryOption>(owner, { kind: 'microsoft.categories' }, 'categories');
        return { success: true, accountId: owner.id, categories: result.items, partial: result.partial, error: result.message };
      }, { success: false, accountId: input.accountId, categories: [] as NativeMicrosoftMailCategoryOption[], partial: true, error: undefined as string | undefined });
    },
    async getConversation(input: { accountId: string; conversationId: string; messageId?: string }) {
      return safe(async () => {
        const owner = account('microsoft', input.accountId), threads: NativeMicrosoftMailThreadDigest[] = [], messages: NativeMicrosoftMailMessageView[] = [], attachmentIds = new Set<string>(), seen = new Set<string>();
        const selector: MailReadSelector = { kind: 'microsoft.conversation', conversationId: input.conversationId, ...(input.messageId ? { messageId: input.messageId } : {}) };
        let cursor: string | undefined, partial = false, warning: string | undefined;
        do {
          let page: Page<{ messages: NativeMicrosoftMailMessageView[]; threads?: NativeMicrosoftMailThreadDigest[]; attachmentMessageIds: string[] }>;
          try { page = await read(owner, selector, cursor); }
          catch (error) {
            assertCurrent(); if (!messages.length) throw error;
            partial = true; warning = 'Some later messages could not load. The messages already read remain available.'; break;
          }
          messages.push(...page.data.messages); threads.push(...(page.data.threads ?? [])); page.data.attachmentMessageIds.forEach(id => attachmentIds.add(id));
          partial ||= page.coverage === 'partial' || (page.coverage === 'page' && !page.next); warning = page.message ?? warning; cursor = page.next;
          if (!cursor) break;
          if (seen.has(cursor) || messages.length >= 1000 || seen.size >= 250) { partial = true; break; }
          seen.add(cursor);
        } while (true);
        const byId = new Map(messages.slice(0, 1000).map(message => [message.id, { ...message }]));
        if (messages.length > 1000) partial = true;
        // Preserve surrounding mail and metadata when a particular file cannot load.
        const targets: (Attachment & { messageId: string })[] = [];
        let attachmentMessages = 0;
        for (const message of byId.values()) {
          if (!attachmentIds.has(message.id)) continue;
          if (++attachmentMessages > 50) { warning = 'Some attachment lists have not loaded. Open a smaller conversation to load more.'; break; }
          try {
            const result = await collect<Attachment>(owner, { kind: 'microsoft.attachments', messageId: message.id }, 'attachments', 100);
            message.attachments = result.items; warning = result.message ?? warning;
            targets.push(...result.items.filter(item => item.type === '#microsoft.graph.fileAttachment').map(item => ({ ...item, messageId: message.id })));
          } catch { assertCurrent(); warning = 'Some attachments could not be loaded. The message remains available.'; }
        }
        for (const target of selectInboxHydration(targets)) {
          try {
            const page = await read<AttachmentBytes>(owner, { kind: 'microsoft.attachment', messageId: target.messageId, attachmentId: target.id });
            if (page.data.bytes !== target.size) throw new Error('The attachment changed while loading.');
            const attachment = byId.get(target.messageId)?.attachments?.find(item => item.id === target.id);
            if (attachment) attachment.base64 = page.data.base64;
          } catch { assertCurrent(); warning = 'Some attachments could not be loaded. The message remains available.'; }
        }
        assertCurrent();
        return { success: true, accountId: owner.id, messages: [...byId.values()], threads, partial, error: [partial ? 'Only part of this conversation is available.' : undefined, warning].filter(Boolean).join(' ') || undefined };
      }, { success: false, accountId: input.accountId, messages: [] as NativeMicrosoftMailMessageView[], threads: [] as NativeMicrosoftMailThreadDigest[], partial: true, error: undefined as string | undefined });
    },
    startDeviceAuth: async () => ({ ...await settings(), clientConfigured: !!captured.accounts.clients.find(item => item.provider === 'microsoft')?.configured, tenant: 'common' }),
    completeDeviceAuth: settings, disconnectAccount: settings, updateSignature: pending,
    modifyConversation: pending, updateConversationCategories: pending, createDraft: pending, sendEmail: pending, createReplyDraft: pending, sendReply: pending,
  };
  const loadImages = async (input: { provider: ConnectedAccount['provider']; accountId: string; threadId: string; messageId: string }) => {
    const owner = account(input.provider, input.accountId);
    const result = await request<EmailImages>('mail/images', { epoch: captured.epoch, accountId: owner.id, generation: owner.generation, threadId: input.threadId, messageId: input.messageId }, controller.signal, 50000);
    assertCurrent();
    if (result.accountId !== owner.id || result.generation !== owner.generation || result.threadId !== input.threadId || result.messageId !== input.messageId) throw Error('The images belong to another message.');
    return result;
  };
  const preloadThread = async (input: { provider: ConnectedAccount['provider']; accountId: string; threadId: string; messageId?: string }) => {
    const owner = account(input.provider, input.accountId);
    const page = await read<any>(owner, input.provider === 'google' ? { kind: 'gmail.thread', threadId: input.threadId } : { kind: 'microsoft.conversation', conversationId: input.threadId, ...(input.messageId ? { messageId: input.messageId } : {}) }, undefined, true);
    const messages = input.provider === 'google' ? page.data.thread?.messages : page.data.messages;
    // Only the recent conversation set is warmed. Old mail continues indexing
    // independently, and image fetches retain the service's host/size boundaries.
    for (const message of (messages ?? []).slice(-20)) {
      assertCurrent();
      await loadImages({ ...input, messageId: message.id }).catch(() => { assertCurrent(); });
    }
  };
  return { gmail, microsoftMail, loadImages, preloadThread, mailIndex: indexTransport ? createInboxIndexApi(captured.epoch, account, controller.signal, indexTransport) : undefined, assertCurrent, dispose: () => { controller.abort(); warmed.clear(); warming.clear(); warmedBytes = 0; } };
}

export type InboxMailApi = ReturnType<typeof createInboxMailApi>;
let current: InboxMailApi | undefined;
const listeners = new Set<() => void>();
export function installInboxMailApi(next: InboxMailApi): () => void {
  current?.dispose(); current = next; listeners.forEach(listener => listener());
  return () => { if (current === next) { next.dispose(); current = undefined; listeners.forEach(listener => listener()); } };
}
export const getInboxMailApi = () => current;
export function captureInboxMailScope() {
  const captured = current;
  const assertCurrent = () => { if (!captured || current !== captured) throw new Error('The mail connection changed. Reopen this folder.'); captured.assertCurrent(); };
  assertCurrent(); return { assertCurrent };
}
export function subscribeInboxMailScope(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
