import { z } from 'zod';
import { MAX_MAIL_ATTACHMENT_BYTES, type MailReadSelector } from '../../packages/domain/mail.js';
import type { Provider } from '../../packages/domain/accounts.js';
import { originalMicrosoftMessageViews, originalMicrosoftThreadDigests } from './dreamclaw/microsoft-mail.js';
import { ProviderError } from './providers.js';

type Get = (url: string, signal: AbortSignal, maximumBytes?: number) => Promise<unknown>;
export type ProviderMailPage = { value: unknown; next?: string; message?: string };
const id = z.string().min(1).max(2000), text = z.string().max(100000), short = z.string().max(5000);
const count = z.number().int().nonnegative();
const headers = z.array(z.object({ name: short, value: text })).max(2000);
type GmailPart = { partId?: string; mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GmailPart[] };
const gmailPart: z.ZodType<GmailPart> = z.lazy(() => z.object({ partId: short.optional(), mimeType: short.optional(), filename: short.optional(), headers: headers.optional(), body: z.object({ data: z.string().max(2 * 1024 * 1024).optional(), size: count.optional(), attachmentId: id.optional() }).optional(), parts: z.array(gmailPart).max(1000).optional() }));
const gmailMessage = z.object({ id, threadId: id.optional(), snippet: text.optional(), labelIds: z.array(short).max(1000).optional(), internalDate: z.string().regex(/^\d+$/).max(20).optional(), payload: gmailPart.optional() });
const gmailThread = z.object({ id, historyId: short.optional(), messages: z.array(gmailMessage).min(1).max(1000) });
const address = z.object({ emailAddress: z.object({ name: short.nullish(), address: short.nullish() }) });
const graphMessage = z.object({ id, conversationId: id.optional(), subject: text.nullish(), from: address.nullish(), toRecipients: z.array(address).max(1000).optional(), ccRecipients: z.array(address).max(1000).optional(), receivedDateTime: short.optional(), sentDateTime: short.optional(), createdDateTime: short.optional(), lastModifiedDateTime: short.optional(), isRead: z.boolean(), isDraft: z.boolean().optional(), bodyPreview: text.nullish(), body: z.object({ contentType: z.string().max(20), content: z.string().max(2 * 1024 * 1024) }).optional(), hasAttachments: z.boolean().optional(), flag: z.object({ flagStatus: short.optional() }).optional(), categories: z.array(short).max(1000).optional() });
const graphPage = z.object({ value: z.array(graphMessage).max(1000), '@odata.nextLink': z.string().max(30000).optional() });
const attachment = z.object({ id, name: short, contentType: short.nullish(), size: count, isInline: z.boolean().optional(), contentId: short.nullish(), '@odata.type': short.optional() });

function verified<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ProviderError('invalid_response', 'The mail provider response could not be verified. Previous mail is kept.');
  return parsed.data;
}
function endpoint(base: string, path: string, query?: Record<string, string>) {
  const url = new URL(base + path); if (query) url.search = new URLSearchParams(query).toString(); return url;
}
const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me';
const graph = 'https://graph.microsoft.com/v1.0/me';
const listFields = 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,createdDateTime,lastModifiedDateTime,isRead,bodyPreview,flag,categories';
const messageFields = listFields + ',body,hasAttachments,isDraft';

// Graph continuations keep the same mailbox, resource and query. The service
// replaces them with bounded opaque cursors before anything reaches the UI.
function graphContinuation(value: string | undefined, first: URL, subject: string): string | undefined {
  if (!value) return;
  let next: URL;
  try { next = new URL(value); } catch { throw new ProviderError('invalid_response', 'The mail continuation could not be verified. Refresh this folder.'); }
  // Graph uses OData key syntax in real continuation links even when the
  // original request used slash syntax. Only accept the same exact resource.
  const paths = [first.pathname, first.pathname.replace('/v1.0/me/', `/v1.0/users/${encodeURIComponent(subject)}/`)];
  const equivalentPaths = paths.flatMap(path => [path, path.replace(/\/(mailFolders|messages)\/([^/]+)/g, (_match, collection, key) => `/${collection}('${key}')`)]);
  const valid = next.origin === first.origin && !next.username && !next.password && !next.hash && equivalentPaths.includes(next.pathname)
    && ['$select', '$filter', '$orderby'].every(key => next.searchParams.get(key) === first.searchParams.get(key));
  if (!valid) throw new ProviderError('invalid_response', 'The mail continuation belongs to a different resource. Refresh this folder.');
  return next.href;
}
async function mapBounded<T, R>(values: T[], run: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []; let cursor = 0, bytes = 0, failed = false;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(values.length, 6) }, async () => {
    try {
      while (!failed && cursor < values.length) {
        const index = cursor++, value = await run(values[index]);
        bytes += Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
        if (bytes > 16 * 1024 * 1024) throw new ProviderError('invalid_response', 'This mail page is too large. Choose a smaller page size.');
        results[index] = value;
      }
    } catch (error) { failed = true; throw error; }
  }));
  const failure = settled.find(item => item.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
  return results;
}
function decodedAttachment(value: string, declared: number) {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) || value.length % 4 === 1) throw new ProviderError('invalid_response', 'The attachment bytes could not be verified.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length > MAX_MAIL_ATTACHMENT_BYTES || bytes.length !== declared) throw new ProviderError('invalid_response', 'The attachment size did not match its contents or exceeded the 10 MB limit.');
  return { base64: bytes.toString('base64'), bytes: bytes.length };
}

export async function readProviderMail(get: Get, provider: Provider, subject: string, selector: MailReadSelector, cursor: string | undefined, signal: AbortSignal): Promise<ProviderMailPage> {
  if (selector.kind.startsWith('gmail.') !== (provider === 'google')) throw new ProviderError('invalid_response', 'This mail view belongs to another provider.');
  const abort = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const readThread = async (threadId: string, format: 'full' | 'metadata') => {
    const url = endpoint(gmail, `/threads/${encodeURIComponent(threadId)}`, { format });
    if (format === 'metadata') for (const name of ['Subject', 'From', 'Date']) url.searchParams.append('metadataHeaders', name);
    const thread = verified(gmailThread, await get(url.href, abort));
    if (thread.id !== threadId || thread.messages.some(message => message.threadId && message.threadId !== threadId)) throw new ProviderError('invalid_response', 'The returned mail does not match the selected thread.');
    return thread;
  };
  switch (selector.kind) {
    case 'gmail.threads': {
      const first = endpoint(gmail, '/threads', { q: selector.query, maxResults: String(selector.max), includeSpamTrash: 'true', ...(cursor ? { pageToken: cursor } : {}) });
      const page = verified(z.object({ threads: z.array(z.object({ id })).max(100).default([]), nextPageToken: z.string().min(1).max(20000).optional(), resultSizeEstimate: count.optional() }), await get(first.href, abort));
      const threads = await mapBounded(page.threads, async ({ id }) => {
        const thread = await readThread(id, 'metadata');
        const messages = thread.messages.slice().sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
        const latest = messages[messages.length - 1];
        const header = (name: string) => latest.payload?.headers?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value;
        return { id, sourceMessageId: latest.id, subject: header('Subject') ?? '(no subject)', from: header('From') ?? '', date: header('Date') ?? '', snippet: latest.snippet ?? '', labels: [...new Set(messages.flatMap(message => message.labelIds ?? []))], messageCount: messages.length };
      });
      return { value: { threads, resultSizeEstimate: page.resultSizeEstimate }, next: page.nextPageToken };
    }
    case 'gmail.thread': return { value: { thread: await readThread(selector.threadId, 'full') } };
    case 'gmail.labels': return { value: verified(z.object({ labels: z.array(z.object({ id, name: short, type: short.optional(), labelListVisibility: short.optional(), messageListVisibility: short.optional(), color: z.object({ backgroundColor: short.optional(), textColor: short.optional() }).optional() })).max(10000) }), await get(gmail + '/labels', abort)) };
    case 'gmail.stats': return { value: verified(z.object({ id: z.literal('INBOX'), messagesTotal: count.optional(), messagesUnread: count.optional(), threadsTotal: count.optional(), threadsUnread: count.optional() }), await get(gmail + '/labels/INBOX', abort)) };
    case 'gmail.aliases': return { value: verified(z.object({ sendAs: z.array(z.object({ sendAsEmail: short, displayName: short.optional(), replyToAddress: short.optional(), signature: text.optional(), isPrimary: z.boolean().optional(), isDefault: z.boolean().optional(), treatAsAlias: z.boolean().optional(), verificationStatus: short.optional() })).max(1000) }), await get(gmail + '/settings/sendAs', abort)) };
    case 'gmail.attachment': {
      const raw = verified(z.object({ data: z.string().max(Math.ceil(MAX_MAIL_ATTACHMENT_BYTES * 4 / 3) + 4), size: count }), await get(endpoint(gmail, `/messages/${encodeURIComponent(selector.messageId)}/attachments/${encodeURIComponent(selector.attachmentId)}`).href, abort, 14 * 1024 * 1024));
      return { value: decodedAttachment(raw.data, raw.size) };
    }
    case 'microsoft.threads': {
      const order = selector.folder === 'drafts' ? 'lastModifiedDateTime' : selector.folder === 'sentitems' ? 'sentDateTime' : 'receivedDateTime';
      const first = endpoint(graph, `/mailFolders/${selector.folder}/messages`, { '$select': listFields, '$top': String(selector.max), '$orderby': `${order} desc`, ...(selector.unreadOnly ? { '$filter': 'isRead eq false' } : {}) });
      const page = verified(graphPage, await get(graphContinuation(cursor, first, subject) ?? first.href, abort));
      return { value: { threads: originalMicrosoftThreadDigests(page) }, next: graphContinuation(page['@odata.nextLink'], first, subject) };
    }
    case 'microsoft.conversation': {
      const first = endpoint(graph, '/messages', { '$select': messageFields, '$top': '100', '$filter': `conversationId eq '${selector.conversationId.replaceAll("'", "''")}'` });
      const page = verified(graphPage, await get(graphContinuation(cursor, first, subject) ?? first.href, abort));
      let raw = page.value; let message: string | undefined;
      if (selector.messageId && !cursor && !raw.some(item => item.id === selector.messageId)) {
        const selected = verified(graphMessage, await get(endpoint(graph, `/messages/${encodeURIComponent(selector.messageId)}`, { '$select': messageFields }).href, abort));
        if (selected.id !== selector.messageId) throw new ProviderError('invalid_response', 'The returned Outlook message does not match the selected message.');
        if (!raw.length) message = 'Only the selected Outlook message is available. The full conversation has not been verified.';
        else if (!page['@odata.nextLink']) message = 'The selected Outlook message was read separately. The full conversation has not been verified.';
        raw = [...raw, selected];
      }
      if (!raw.length && !cursor && !page['@odata.nextLink']) throw new ProviderError('not_found', 'This Outlook conversation is no longer available. Refresh the mailbox.');
      if (raw.some(item => item.conversationId !== selector.conversationId)) throw new ProviderError('invalid_response', 'The returned Outlook message belongs to another conversation.');
      return { value: { messages: originalMicrosoftMessageViews(raw, selector.conversationId), threads: originalMicrosoftThreadDigests({ value: raw }), attachmentMessageIds: raw.filter(item => item.hasAttachments || /cid:/i.test(item.body?.content ?? '')).map(item => item.id) }, next: graphContinuation(page['@odata.nextLink'], first, subject), ...(message ? { message } : {}) };
    }
    case 'microsoft.stats': return { value: verified(z.object({ id, totalItemCount: count.optional(), unreadItemCount: count.optional() }), await get(endpoint(graph, `/mailFolders/${selector.folder}`, { '$select': 'id,totalItemCount,unreadItemCount' }).href, abort)) };
    case 'microsoft.categories': {
      const first = endpoint(graph, '/outlook/masterCategories', { '$top': '100', '$select': 'id,displayName,color' });
      const page = verified(z.object({ value: z.array(z.object({ id, displayName: short, color: short.optional() })).max(1000), '@odata.nextLink': z.string().max(30000).optional() }), await get(graphContinuation(cursor, first, subject) ?? first.href, abort));
      return { value: { categories: page.value.map(item => ({ name: item.displayName, color: item.color })) }, next: graphContinuation(page['@odata.nextLink'], first, subject) };
    }
    case 'microsoft.attachments': {
      const first = endpoint(graph, `/messages/${encodeURIComponent(selector.messageId)}/attachments`, { '$top': '100', '$select': 'id,name,contentType,size,isInline,contentId' });
      const page = verified(z.object({ value: z.array(attachment).max(1000), '@odata.nextLink': z.string().max(30000).optional() }), await get(graphContinuation(cursor, first, subject) ?? first.href, abort));
      return { value: { attachments: page.value.map(item => ({ id: item.id, name: item.name, mimeType: item.contentType ?? 'application/octet-stream', size: item.size, isInline: !!item.isInline, contentId: item.contentId, type: item['@odata.type'] })) }, next: graphContinuation(page['@odata.nextLink'], first, subject) };
    }
    case 'microsoft.attachment': {
      const raw = verified(attachment.extend({ contentBytes: z.string().max(Math.ceil(MAX_MAIL_ATTACHMENT_BYTES * 4 / 3) + 4) }), await get(endpoint(graph, `/messages/${encodeURIComponent(selector.messageId)}/attachments/${encodeURIComponent(selector.attachmentId)}`).href, abort, 14 * 1024 * 1024));
      if (raw.id !== selector.attachmentId) throw new ProviderError('invalid_response', 'The returned attachment does not match your selection.');
      return { value: { ...decodedAttachment(raw.contentBytes, raw.size), contentId: raw.contentId, mimeType: raw.contentType, name: raw.name, isInline: raw.isInline } };
    }
  }
}
