import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import { Accounts } from '../apps/service/accounts.js';
import { MailService } from '../apps/service/mail.js';
import { Providers, accountCapabilities, ProviderError } from '../apps/service/providers.js';
import { startServer } from '../apps/service/http.js';
import type { ConnectedAccount, Provider } from '../packages/domain/accounts.js';
import type { MailReadSelector } from '../packages/domain/mail.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function seed(store: Store, provider: Provider, now = Date.now()): ConnectedAccount {
  const scopes = provider === 'google' ? ['https://www.googleapis.com/auth/gmail.readonly'] : ['Mail.Read'];
  const account: ConnectedAccount = { id: randomUUID(), generation: randomUUID(), provider, subject: 'fixture-subject', email: 'mail-fixture@example.test', label: 'Mail fixture', revision: 1, state: 'connected', scopes, capabilities: accountCapabilities(provider, scopes), connectedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
  store.internalWrite(`accounts:item:${account.id}`, account);
  store.internalWrite(`accounts:credential:${account.id}`, { generation: account.generation, configuration: { provider, clientId: provider === 'google' ? 'fixture.apps.googleusercontent.com' : randomUUID(), ...(provider === 'microsoft' ? { tenant: 'common', callbackPort: 4389 } : {}) }, tokens: { accessToken: 'isolated-mail-fixture-token', expiresAt: now + 3600000, scopes } });
  return account;
}
function fixture(provider: Provider, respond: (url: URL) => Promise<Response> | Response) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-mail-')); let now = Date.now();
  const calls: { url: URL; headers: Headers }[] = [];
  const providers = new Providers((async (input, init) => { const url = new URL(String(input)); assert.equal(init?.method ?? 'GET', 'GET'); assert.equal(init?.redirect, 'error'); const headers = new Headers(init?.headers); assert.equal(headers.get('Authorization'), 'Bearer isolated-mail-fixture-token'); calls.push({ url, headers }); return respond(url); }) as typeof fetch);
  let store = new Store(directory), accounts = new Accounts(store, providers, () => now), mail = new MailService(store, accounts, () => now);
  const account = seed(store, provider, now);
  return { directory, calls, account, get store() { return store; }, get accounts() { return accounts; }, get now() { return now; }, advance(ms: number) { now += ms; }, read(selector: MailReadSelector, cursor?: string, device = 'fixture-device') { return mail.read(device, { epoch: store.epoch, accountId: account.id, generation: account.generation, selector, ...(cursor ? { cursor } : {}) }); }, async restart() { await accounts.close(); store.close(); store = new Store(directory); accounts = new Accounts(store, providers, () => now); mail = new MailService(store, accounts, () => now); }, async close() { await accounts.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const gmailThread = (id: string) => ({ id, messages: [{ id: id + '-older', threadId: id, internalDate: '1700000000000', labelIds: ['INBOX', 'UNREAD'], payload: { headers: [{ name: 'Subject', value: 'Original subject' }], mimeType: 'text/plain', body: { data: 'b2xk', size: 3 } } }, { id: id + '-latest', threadId: id, snippet: 'A real message preview', internalDate: '1800000000000', labelIds: ['INBOX', 'Label_Work'], payload: { headers: [{ name: 'Subject', value: 'Latest subject' }, { name: 'From', value: 'Sender <sender@example.test>' }, { name: 'Date', value: 'Tue, 8 Sep 2026 09:00:00 -0700' }], mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: 'SGVsbG8', size: 5 } }, { mimeType: 'text/html', body: { data: 'PHA-SGVsbG88L3A-', size: 12 } }] } }] });
const graphMessage = (id: string, changes: object = {}) => ({ id, conversationId: 'conversation-one', subject: 'Meeting availability', from: { emailAddress: { name: 'Sender', address: 'sender@example.test' } }, toRecipients: [{ emailAddress: { address: 'me@example.test' } }], ccRecipients: [], receivedDateTime: '2026-09-08T09:00:00Z', isRead: false, bodyPreview: 'Please reply with your availability.', flag: { flagStatus: 'flagged' }, categories: ['Work'], ...changes });

test('Gmail read bridge retains original summary inputs, MIME source and bounded attachment bytes with mail-only scopes', async () => {
  const f = fixture('google', url => {
    if (url.pathname.endsWith('/threads')) return json({ threads: [{ id: url.searchParams.has('pageToken') ? 'thread-two' : 'thread-one' }], ...(url.searchParams.has('pageToken') ? {} : { nextPageToken: 'private-provider-page', resultSizeEstimate: 2 }) });
    if (url.pathname.includes('/threads/')) return json(gmailThread(url.pathname.split('/').pop()!));
    if (url.pathname.includes('/attachments/')) return json({ data: 'AAH-_w', size: 4 });
    throw new Error('Unexpected URL');
  });
  try {
    const selector = { kind: 'gmail.threads' as const, query: 'in:inbox', max: 25 };
    const first = await f.read(selector); const value = first.value as { threads: { subject: string; snippet: string; labels: string[]; sourceMessageId: string; messageCount: number }[] };
    assert.equal(first.coverage, 'page'); assert.ok(first.nextCursor); assert.doesNotMatch(JSON.stringify(first), /private-provider-page|isolated-mail-fixture-token/);
    assert.equal(value.threads[0].snippet, 'A real message preview'); assert.equal(value.threads[0].subject, 'Latest subject'); assert.equal(value.threads[0].sourceMessageId, 'thread-one-latest'); assert.equal(value.threads[0].messageCount, 2); assert.deepEqual(value.threads[0].labels, ['INBOX', 'UNREAD', 'Label_Work']);
    const second = await f.read(selector, first.nextCursor); assert.equal(second.coverage, 'complete');
    const full = await f.read({ kind: 'gmail.thread', threadId: 'thread-one' }); assert.deepEqual((full.value as { thread: unknown }).thread, gmailThread('thread-one'));
    const bytes = await f.read({ kind: 'gmail.attachment', messageId: 'thread-one-latest', attachmentId: 'file-one' }); assert.deepEqual(bytes.value, { base64: 'AAH+/w==', bytes: 4 });
    assert.equal(f.account.capabilities.calendarRead, false); assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/threads')).length, 2);
  } finally { await f.close(); }
});

test('mail cursors survive service restart but reject a different device, query, account generation or expiry', async () => {
  const f = fixture('google', url => url.pathname.endsWith('/threads') ? json({ threads: [], nextPageToken: 'provider-page' }) : json({}));
  try {
    const selector = { kind: 'gmail.threads' as const, query: 'in:inbox', max: 25 }; const first = await f.read(selector);
    await f.restart(); const repeated = await f.read(selector, first.nextCursor); assert.equal(repeated.coverage, 'partial'); assert.match(repeated.message!, /repeated a mail page/); assert.equal(repeated.nextCursor, undefined);
    const before = f.calls.length;
    await assert.rejects(f.read({ ...selector, query: 'in:trash' }, first.nextCursor), /older view/);
    await assert.rejects(f.read(selector, first.nextCursor, 'another-device'), /older view/);
    assert.equal(f.calls.length, before);
    f.advance(31 * 60000); await assert.rejects(f.read(selector, first.nextCursor), /older view/);
    f.store.internalWrite(`accounts:item:${f.account.id}`, { ...f.account, generation: randomUUID() });
    await assert.rejects(f.read(selector), /connection changed/); assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test('Outlook reuses original digest and reader transformations, immutable source identity, paging and literal text bodies', async () => {
  const f = fixture('microsoft', url => {
    if (url.pathname.includes('/mailFolders/')) { const next = new URL(url); next.searchParams.set('$skip', '2'); return json({ value: [graphMessage('immutable-old'), graphMessage('immutable-new', { receivedDateTime: '2026-09-08T10:00:00Z' })], ...(url.searchParams.has('$skip') ? {} : { '@odata.nextLink': next.href }) }); }
    return json({ value: [graphMessage('immutable-new', { receivedDateTime: undefined, sentDateTime: '2026-09-08T10:00:00Z', body: { contentType: 'text', content: '1 < 2 & 3 > 2' } }), graphMessage('immutable-html', { body: { contentType: 'html', content: '<p>Hello &amp; welcome</p><script>hidden()</script>' } })] });
  });
  try {
    const selector = { kind: 'microsoft.threads' as const, folder: 'inbox' as const, max: 25, unreadOnly: false };
    const first = await f.read(selector), digest = (first.value as { threads: { sourceMessageId: string; messageCount: number; category: string; providerTags: string[] }[] }).threads[0];
    assert.equal(digest.sourceMessageId, 'immutable-new'); assert.equal(digest.messageCount, 2); assert.equal(digest.category, 'calendar_logistics'); assert.deepEqual(digest.providerTags, ['Work']);
    await f.read(selector, first.nextCursor); assert.ok(f.calls[1].url.searchParams.has('$skip'));
    const detail = await f.read({ kind: 'microsoft.conversation', conversationId: 'conversation-one', messageId: 'immutable-new' });
    const messages = (detail.value as { messages: { id: string; idType: string; bodyText: string; bodyHtml?: string; date: string }[] }).messages;
    assert.equal(messages.find(m => m.id === 'immutable-new')?.bodyText, '1 < 2 & 3 > 2'); assert.equal(messages.find(m => m.id === 'immutable-new')?.date, '2026-09-08T10:00:00Z'); assert.equal(messages.find(m => m.id === 'immutable-html')?.bodyText, 'Hello & welcome'); assert.ok(messages.every(m => m.idType === 'immutable'));
    assert.ok(f.calls.every(call => call.headers.get('Prefer') === 'IdType="ImmutableId"')); assert.equal(f.calls[2].url.searchParams.get('$orderby'), null);
  } finally { await f.close(); }
});

test('Outlook inline-only messages still request their image attachments', async () => {
  const f = fixture('microsoft', () => json({ value: [graphMessage('inline-message', { hasAttachments: false, body: { contentType: 'html', content: '<p>Logo</p><img src="cid:logo@example.test">' } })] }));
  try {
    const read = await f.read({ kind: 'microsoft.conversation', conversationId: 'conversation-one', messageId: 'inline-message' });
    assert.deepEqual((read.value as {attachmentMessageIds:string[]}).attachmentMessageIds, ['inline-message']);
  } finally { await f.close(); }
});

test('Outlook continuation and fallback cannot change folder, filter, mailbox or selected conversation', async () => {
  let mode = 'foreign';
  const f = fixture('microsoft', url => {
    if (url.pathname.includes('/mailFolders/')) { const next = new URL(url); if (mode === 'foreign') next.hostname = 'external.example'; if (mode === 'folder') next.pathname = next.pathname.replace('inbox', 'sentitems'); if (mode === 'filter') next.searchParams.set('$filter', 'isRead eq true'); return json({ value: [], '@odata.nextLink': next.href }); }
    if (url.pathname.endsWith('/messages')) return json({ value: [] });
    return json(graphMessage('selected-message', { conversationId: mode === 'mismatch' ? 'another-conversation' : 'conversation-one', body: { contentType: 'text', content: 'Only this source.' } }));
  });
  try {
    for (mode of ['foreign', 'folder', 'filter']) await assert.rejects(f.read({ kind: 'microsoft.threads', folder: 'inbox', max: 25, unreadOnly: false }), /different resource/);
    assert.ok(f.calls.every(call => call.url.hostname === 'graph.microsoft.com'));
    mode = 'mismatch'; await assert.rejects(f.read({ kind: 'microsoft.conversation', conversationId: 'conversation-one', messageId: 'selected-message' }), /another conversation/);
    mode = 'match'; const result = await f.read({ kind: 'microsoft.conversation', conversationId: 'conversation-one', messageId: 'selected-message' }); assert.equal(result.coverage, 'partial'); assert.match(result.message!, /full conversation has not been verified/);
  } finally { await f.close(); }
});

test('Outlook resolves an exact selected message outside the first page and rejects substituted IDs', async () => {
  let wrong = false;
  const f = fixture('microsoft', url => {
    if (url.pathname.endsWith('/messages')) { const next = new URL(url); next.searchParams.set('$skip', '100'); return json({ value: [graphMessage('newer')], '@odata.nextLink': next.href }); }
    assert.equal(url.pathname, '/v1.0/me/messages/older-selected');
    return json(graphMessage(wrong ? 'substituted' : 'older-selected'));
  });
  try {
    const selector = { kind: 'microsoft.conversation' as const, conversationId: 'conversation-one', messageId: 'older-selected' };
    const first = await f.read(selector);
    assert.deepEqual((first.value as {messages: {id:string}[]}).messages.map(item => item.id), ['newer', 'older-selected']);
    assert.ok(first.nextCursor); assert.equal(first.coverage, 'page');
    wrong = true; await assert.rejects(f.read(selector), /does not match the selected message/);
  } finally { await f.close(); }
});

test('late mail results are discarded after disconnect, and missing read permission makes no provider request', async () => {
  let release: ((response: Response) => void) | undefined;
  const f = fixture('google', () => new Promise(resolve => { release = resolve; }));
  try {
    const reading = f.read({ kind: 'gmail.threads', query: 'in:inbox', max: 25 });
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    f.accounts.disconnect('fixture-device', { requestId: randomUUID(), epoch: f.store.epoch, accountId: f.account.id, expectedRevision: 1 });
    release(json({ threads: [], nextPageToken: 'late-private-page' }));
    await assert.rejects(reading, /connection changed/); assert.equal(f.store.internalList('mail:cursor:').length, 0);
    const limited = { ...f.account, capabilities: accountCapabilities('google', []), scopes: [] }; f.store.internalWrite(`accounts:item:${limited.id}`, limited);
    f.store.internalWrite(`accounts:credential:${limited.id}`, { generation: limited.generation, tokens: { accessToken: 'isolated-mail-fixture-token', expiresAt: f.now + 3600000, scopes: [] } });
    await assert.rejects(f.read({ kind: 'gmail.labels' }), /mail read permission/);
    assert.equal(f.calls.length, 1);
  } finally { release?.(json({ threads: [] })); await f.close(); }
});

test('malformed attachment sizes and mismatched thread identity never become successful mail reads', async () => {
  const f = fixture('google', url => url.pathname.includes('/attachments/') ? json({ data: 'AAH-_w', size: 9 }) : json(gmailThread('another-thread')));
  try {
    await assert.rejects(f.read({ kind: 'gmail.attachment', messageId: 'm', attachmentId: 'a' }), /size did not match/);
    await assert.rejects(f.read({ kind: 'gmail.thread', threadId: 'selected-thread' }), /does not match/);
    await assert.rejects(f.read({ kind: 'microsoft.stats', folder: 'inbox' }), /another provider/);
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test('real HTTP mail route requires its local session and strict read selector; it exposes no credential', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-mail-http-')); const calls: string[] = [];
  const providers = new Providers((async input => { calls.push(String(input)); return json({ id: 'INBOX', messagesTotal: 12, threadsTotal: 8, threadsUnread: 2 }); }) as typeof fetch);
  const service = await startServer({ directory, port: 0, providers });
  try {
    const account = seed(service.store, 'google');
    const session = await fetch(service.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1' } }); const cookie = session.headers.get('set-cookie')!.split(';')[0]; await session.json();
    const request = { epoch: service.store.epoch, accountId: account.id, generation: account.generation, selector: { kind: 'gmail.stats' } };
    const send = (value: unknown, authenticated = true) => fetch(service.origin + '/api/mail/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', ...(authenticated ? { Cookie: cookie } : {}) }, body: JSON.stringify(value) });
    const denied = await send(request, false); assert.equal(denied.status, 401); await denied.json();
    const bad = await send({ ...request, selector: { kind: 'gmail.send', to: 'never@example.test' } }); assert.equal(bad.status, 400); await bad.json(); assert.equal(calls.length, 0);
    const success = await send(request); assert.equal(success.status, 200); const result = await success.json() as { coverage: string; value: { threadsTotal: number } }; assert.equal(result.coverage, 'complete'); assert.equal(result.value.threadsTotal, 8); assert.doesNotMatch(JSON.stringify(result), /fixture-token|accessToken|authorization/i); assert.equal(calls.length, 1);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Outlook accepts its real OData folder continuation without changing mailbox or query', async () => {
  let replacement = "mailFolders('inbox')";
  const f = fixture('microsoft', url => {
    const next = new URL(url); next.pathname = next.pathname.replace('mailFolders/inbox', replacement); next.searchParams.set('$skip', '1');
    return json({value: [graphMessage('immutable-one')], ...(!url.searchParams.has('$skip') ? {'@odata.nextLink':next.href} : {})});
  });
  try {
    const selector = {kind:'microsoft.threads' as const, folder:'inbox' as const, max:1, unreadOnly:false};
    const first = await f.read(selector); assert.ok(first.nextCursor);
    const second = await f.read(selector,first.nextCursor); assert.equal(second.coverage,'complete');
    assert.equal(f.calls[1].url.pathname,"/v1.0/me/mailFolders('inbox')/messages");
    replacement = "mailFolders('sentitems')"; await assert.rejects(f.read(selector),/different resource/);
  } finally { await f.close(); }
});

test('Gmail distinguishes temporary request limits from permission and daily-quota failures', async () => {
  for (const reason of ['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded','domainPolicy']) {
    const providers = new Providers(async () => json({error:{errors:[{reason,message:'untrusted provider text'}]}},403));
    await assert.rejects(providers.mailFolders('google','fixture'), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code,['rateLimitExceeded','userRateLimitExceeded'].includes(reason)?'throttled':'permission');
      assert.doesNotMatch(error.message,/untrusted/);
      if(error.code==='throttled')assert.equal(error.retryAfterSeconds,5);
      return true;
    });
  }
});
