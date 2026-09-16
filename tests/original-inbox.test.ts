import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ConnectedAccount } from '../packages/domain/accounts';
import type { MailReadRequest, MailReadResult } from '../packages/domain/mail';
import { createInboxMailApi, installInboxMailApi, selectInboxHydration, type InboxMailContext } from '../apps/client/src/dreamclaw/inbox-transport';
import { buildNativeGmailSummaryDigests, describeNativeGmailThread, getNativeGmailThread, getNativeGmailSendAsAliases, type NativeGmailThread } from '../apps/client/src/dreamclaw/services/native/gmail';
import { buildNativeMicrosoftMailboxSnapshot, getNativeMicrosoftConversation, type NativeMicrosoftMailThreadDigest } from '../apps/client/src/dreamclaw/services/native/microsoftMail';
import { loadInboxFolder, setInboxReaderSession, setInboxScrollPosition, useInboxSessionStore } from '../apps/client/src/dreamclaw/services/inbox/inboxSession';
import { gmailQueryForInboxFolder, microsoftFolderForInboxFolder } from '../apps/client/src/dreamclaw/services/inbox/mailWorkspace';
import { inboxThreadLoadKey } from '../apps/client/src/dreamclaw/services/inbox/threadLoadIdentity';
import { Store } from '../apps/service/store';
import { Accounts } from '../apps/service/accounts';
import { Providers } from '../apps/service/providers';
import { MailService } from '../apps/service/mail';

function owner(provider: ConnectedAccount['provider'], email = `${provider}@example.test`): ConnectedAccount {
  return { id: randomUUID(), generation: randomUUID(), provider, subject: randomUUID(), email, label: email, revision: 1, state: 'connected', scopes: [], capabilities: { mailRead: true, mailDraft: false, mailSend: false, calendarRead: false, calendarWrite: false, contactsRead: false }, connectedAt: '2026-09-08T10:00:00Z', updatedAt: '2026-09-08T10:00:00Z' };
}
function context(accounts: ConnectedAccount[]): InboxMailContext {
  return { epoch: randomUUID(), deviceId: randomUUID(), accounts: { clients: [], accounts, attempts: [], probes: [] } };
}
function result(input: MailReadRequest, value: unknown, patch: Partial<MailReadResult> = {}): MailReadResult {
  return { accountId: input.accountId, generation: input.generation, kind: input.selector.kind, readAt: '2026-09-08T10:00:00Z', coverage: 'complete', value, ...patch };
}
function outlook(id: string, sourceMessageId = `${id}-message`, date = '2026-09-08T10:00:00Z'): NativeMicrosoftMailThreadDigest {
  return { id, conversationId: id, sourceMessageId, subject: id, from: 'sender@example.test', date, labels: ['INBOX'], providerTags: ['Planning'], messageCount: 1, category: 'calendar_logistics', summary: 'Meeting', latestBody: 'Meeting', latestSnippet: 'Meeting', attentionScore: 10 };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }

test('original Gmail digests keep source identities and stable page selectors; ambiguous email cannot select an account', async () => {
  const first = owner('google', 'same@example.test'), second = owner('google', 'same@example.test');
  const calls: MailReadRequest[] = [], page = randomUUID();
  const api = createInboxMailApi(context([first, second]), async input => {
    calls.push(input); assert.equal(input.accountId, second.id);
    assert.equal(input.selector.kind, 'gmail.threads');
    if (input.selector.kind !== 'gmail.threads') throw new Error('Unexpected read');
    assert.equal(input.selector.max, 50);
    const start = input.cursor ? 50 : 0, length = input.cursor ? 20 : 50;
    return result(input, { threads: Array.from({ length }, (_, i) => ({ id: `thread-${start + i}`, sourceMessageId: `source-${start + i}`, subject: 'Planning', labels: ['INBOX', 'Label_123'], messageCount: 3 })) }, input.cursor ? {} : { coverage: 'page', nextCursor: page });
  });
  const close = installInboxMailApi(api);
  try {
    const ambiguous = await api.gmail.searchThreads({ query: 'in:inbox', account: first.email });
    assert.equal(ambiguous.success, false); assert.match(ambiguous.error ?? '', /exact/); assert.equal(calls.length, 0);
    const digest = await buildNativeGmailSummaryDigests('in:inbox', { account: second.id, maxThreads: 60 });
    assert.equal(digest.threads.length, 60); assert.equal(digest.truncated, true); assert.equal(digest.account, second.id);
    assert.equal(digest.threads[59].sourceMessageId, 'source-59'); assert.equal(digest.threads[59].messageCount, 3);
    assert.deepEqual(digest.threads[59].providerTags, ['INBOX', 'Label_123']);
    assert.equal(calls.length, 2); assert.equal(calls[1].cursor, page); assert.deepEqual(calls[0].selector, calls[1].selector);
  } finally { close(); }
});

test('both original mailbox crawlers stop on an incomplete terminal page without claiming exhaustion or requesting page one again', async () => {
  const google = owner('google'), microsoft = owner('microsoft'); let lists = 0;
  const close = installInboxMailApi(createInboxMailApi(context([google, microsoft]), async input => {
    if (input.selector.kind === 'microsoft.stats') return result(input, { totalItemCount: 99 });
    lists += 1;
    return result(input, { threads: input.selector.kind === 'gmail.threads' ? [{ id: 'gmail-kept', labels: [] }] : [outlook('outlook-kept')] }, { coverage: 'partial', message: 'This view is incomplete.' });
  }));
  try {
    const gmail = await buildNativeGmailSummaryDigests('in:inbox', { account: google.id });
    const outlook = await buildNativeMicrosoftMailboxSnapshot({ accountId: microsoft.id });
    assert.equal(gmail.truncated, true); assert.equal(outlook.truncated, true); assert.equal(lists, 2);
    assert.equal(gmail.threads[0].id, 'gmail-kept'); assert.equal(outlook.threads[0].id, 'outlook-kept');
    assert.match(gmail.warning ?? '', /incomplete/); assert.match(outlook.warning ?? '', /incomplete/);
  } finally { close(); }
});

test('later page failures keep original summaries with partial coverage and latest Outlook source identity', async () => {
  const google = owner('google'), microsoft = owner('microsoft'), cursor = randomUUID();
  const close = installInboxMailApi(createInboxMailApi(context([google, microsoft]), async input => {
    if (input.selector.kind === 'microsoft.stats') throw new Error('Counts unavailable');
    if (input.cursor === cursor) throw new Error('The next page is unavailable.');
    if (input.selector.kind === 'gmail.threads') return result(input, { threads: [{ id: 'kept', labels: [] }] }, { coverage: 'page', nextCursor: cursor });
    return result(input, { threads: [outlook('kept', 'old-source'), outlook('kept', 'latest-source', '2026-09-08T11:00:00Z')] }, { coverage: 'page', nextCursor: cursor });
  }));
  try {
    const gmail = await buildNativeGmailSummaryDigests('in:inbox', { account: google.id });
    const ms = await buildNativeMicrosoftMailboxSnapshot({ accountId: microsoft.id });
    assert.equal(gmail.threads.length, 1); assert.equal(ms.threads.length, 1); assert.equal(ms.threads[0].sourceMessageId, 'latest-source');
    assert.equal(gmail.truncated, true); assert.equal(ms.truncated, true); assert.equal(ms.totalItemCount, undefined);
  } finally { close(); }
});

test('original Gmail reader preserves full literal text, MIME alternatives, text attachments and bytes independently of aliases', async () => {
  const google = owner('google'), body = 'Hello <team> — café\n\n  Keep spacing\n' + 'a'.repeat(8500) + '\nhttps://example.test/' + 'b'.repeat(100);
  const thread: NativeGmailThread = { id: 'thread', messages: [{ id: 'message', internalDate: '1788880000000', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Writer <writer@example.test>' }], parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } },
    { mimeType: 'text/html', body: { data: Buffer.from('<p>Original <strong>HTML</strong></p>').toString('base64url') } },
    { mimeType: 'text/plain', filename: 'notes.txt', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: 'text-file', size: 4 } },
    { mimeType: 'image/png', filename: 'missing.png', body: { attachmentId: 'missing', size: 2 } },
  ] } }] };
  const close = installInboxMailApi(createInboxMailApi(context([google]), async input => {
    switch (input.selector.kind) {
      case 'gmail.thread': return result(input, { thread: structuredClone(thread) });
      case 'gmail.aliases': throw new Error('Aliases require separate permission.');
      case 'gmail.attachment': if (input.selector.attachmentId === 'missing') throw new Error('File unavailable'); return result(input, { base64: 'AAH+/w==', bytes: 4 });
      default: throw new Error('Unexpected read');
    }
  }));
  try {
    const [read, aliases] = await Promise.all([getNativeGmailThread({ account: google.id, threadId: 'thread' }), getNativeGmailSendAsAliases({ account: google.id })]);
    assert.equal(read.success, true); assert.equal(aliases.success, false);
    const message = describeNativeGmailThread(read.thread!)[0];
    assert.equal(message.bodyText, body); assert.equal(message.bodyHtml, '<p>Original <strong>HTML</strong></p>');
    assert.equal(message.attachments?.length, 2); assert.equal(message.attachments?.[0].name, 'notes.txt');
    assert.deepEqual([...Buffer.from(message.attachments![0].base64!, 'base64')], [0, 1, 254, 255]);
    assert.equal(message.attachments?.[1].base64, undefined); assert.equal(message.attachments?.[1].size, 2);
  } finally { close(); }
});

test('Outlook conversation pages keep message order/source and partial fallback while attachment failures remain local', async () => {
  const microsoft = owner('microsoft'), cursor = randomUUID(), calls: MailReadRequest[] = [];
  const message = (id: string, date: string) => ({ id, idType: 'immutable', conversationId: 'conversation', from: 'sender', to: 'reader', cc: '', subject: 'Planning', date, bodyText: `Text ${id}`, bodyHtml: '<p>HTML</p>', snippet: id, isRead: false });
  const close = installInboxMailApi(createInboxMailApi(context([microsoft]), async input => {
    calls.push(input);
    switch (input.selector.kind) {
      case 'microsoft.conversation': return input.cursor ? result(input, { messages: [message('older', '2026-09-07T10:00:00Z')], attachmentMessageIds: [] }, { coverage: 'partial', message: 'Full conversation is unverified.' }) : result(input, { messages: [message('newer', '2026-09-08T10:00:00Z')], attachmentMessageIds: ['newer'] }, { coverage: 'page', nextCursor: cursor });
      case 'microsoft.attachments': return result(input, { attachments: [
        { id: 'good', name: 'notes.txt', size: 4, mimeType: 'text/plain', isInline: false, type: '#microsoft.graph.fileAttachment' },
        { id: 'bad', name: 'broken.pdf', size: 3, mimeType: 'application/pdf', isInline: false, type: '#microsoft.graph.fileAttachment' },
        { id: 'link', name: 'Shared document', size: 0, mimeType: 'application/octet-stream', isInline: false, type: '#microsoft.graph.referenceAttachment' },
      ] });
      case 'microsoft.attachment': if (input.selector.attachmentId === 'good') return result(input, { bytes: 4, base64: 'dGVzdA==' }); throw new Error('Missing attachment');
      default: throw new Error('Unexpected read');
    }
  }));
  try {
    const read = await getNativeMicrosoftConversation({ accountId: microsoft.id, conversationId: 'conversation', messageId: 'newer' });
    assert.equal(read.success, true); assert.equal(read.partial, true); assert.ok(read.error);
    assert.deepEqual(read.messages.map(item => item.id), ['newer', 'older']);
    assert.equal(read.messages[0].attachments?.[0].base64, 'dGVzdA=='); assert.equal(read.messages[0].attachments?.[1].base64, undefined);
    assert.equal(read.messages[0].attachments?.length, 3);
    assert.equal(calls.filter(item => item.selector.kind === 'microsoft.attachment').length, 2);
    assert.deepEqual(calls[0].selector, calls[1].selector);
  } finally { close(); }
});

test('attachment reservations bound concurrent hydration per file, message and reader', () => {
  const mb = 1024 * 1024;
  const targets = [
    { id: 'a', messageId: 'first', size: 10 * mb }, { id: 'b', messageId: 'first', size: 10 * mb },
    { id: 'too-much-first', messageId: 'first', size: 6 * mb }, { id: 'c', messageId: 'first', size: 5 * mb },
    { id: 'too-large', messageId: 'second', size: 11 * mb }, { id: 'unknown', messageId: 'second' },
    { id: 'd', messageId: 'second', size: 10 * mb }, { id: 'e', messageId: 'second', size: 5 * mb },
    { id: 'reader-full', messageId: 'third', size: 1 },
  ];
  assert.deepEqual(selectInboxHydration(targets).map(item => item.id), ['a', 'b', 'c', 'unknown', 'd', 'e']);
});

test('reconnecting during an original reader load discards old bytes and invalidates alias caches', async () => {
  const google = owner('google'), started = deferred<void>(), delayed = deferred<MailReadResult>();
  let request: MailReadRequest | undefined;
  const old = createInboxMailApi(context([google]), async input => {
    if (input.selector.kind === 'gmail.aliases') return result(input, { sendAs: [{ sendAsEmail: 'old@example.test' }] });
    if (input.selector.kind === 'gmail.thread') return result(input, { thread: { id: 'thread', messages: [{ id: 'message', payload: { mimeType: 'image/png', filename: 'image.png', body: { attachmentId: 'file', size: 4 } } }] } });
    request = input; started.resolve(); return delayed.promise;
  });
  const closeOld = installInboxMailApi(old);
  let closeNew = () => {};
  try {
    assert.equal((await getNativeGmailSendAsAliases({ account: google.id })).sendAs[0].sendAsEmail, 'old@example.test');
    const pending = getNativeGmailThread({ account: google.id, threadId: 'thread' });
    const rejected = assert.rejects(pending, /connection changed/);
    await started.promise;
    closeNew = installInboxMailApi(createInboxMailApi(context([{ ...google, generation: randomUUID() }]), async input => result(input, { sendAs: [{ sendAsEmail: 'new@example.test' }] })));
    delayed.resolve(result(request!, { base64: 'dGVzdA==', bytes: 4 })); await rejected;
    assert.equal((await getNativeGmailSendAsAliases({ account: google.id })).sendAs[0].sendAsEmail, 'new@example.test');
    closeOld(); // An old component's cleanup cannot dispose the replacement.
    assert.equal((await getNativeGmailSendAsAliases({ account: google.id })).sendAs[0].sendAsEmail, 'new@example.test');
  } finally { closeNew(); closeOld(); }
});

test('original retained folder sessions use stable account IDs, keep independent scroll, and reject old forced loads after scope change', async () => {
  const google = owner('google'), microsoft = owner('microsoft'), pending = deferred<MailReadResult>(), started = deferred<void>();
  let delayedInput: MailReadRequest | undefined, delay = false;
  const calls: MailReadRequest[] = [];
  const closeOld = installInboxMailApi(createInboxMailApi(context([google, microsoft]), async input => {
    calls.push(input);
    if (input.selector.kind === 'gmail.stats') return result(input, { threadsTotal: 17 });
    if (input.selector.kind === 'microsoft.stats') return result(input, { totalItemCount: 18 });
    if (delay && input.selector.kind === 'gmail.threads') { delayedInput = input; started.resolve(); return pending.promise; }
    return result(input, { threads: input.selector.kind === 'gmail.threads' ? [{ id: 'gmail-thread', labels: ['INBOX'] }] : [outlook('outlook-thread')] });
  }));
  let closeNew = () => {};
  try {
    await loadInboxFolder('inbox');
    const state = useInboxSessionStore.getState();
    assert.deepEqual(state.folders.inbox.snapshots.map(item => item.account.accountId), [google.id, microsoft.id]);
    assert.equal(state.folders.inbox.snapshots[0].totalThreadCount, 17);
    assert.equal(state.folders.inbox.snapshots[1].microsoftIdType, 'immutable');
    setInboxScrollPosition('inbox', { listTop: 77 }); setInboxScrollPosition('sent', { listTop: 14 });
    await loadInboxFolder('sent'); assert.equal(useInboxSessionStore.getState().scrollPositions.inbox.listTop, 77);
    assert.ok(calls.some(input => input.selector.kind === 'gmail.threads' && input.selector.query === 'in:sent'));
    assert.ok(calls.some(input => input.selector.kind === 'microsoft.threads' && input.selector.folder === 'sentitems'));
    setInboxReaderSession('inbox', { loadKey: 'old-reader', threadKey: 'old', status: 'ready', messages: [], sendAsAliases: [], selectedFrom: google.email, microsoftSignatureDraft: '', error: null });
    delay = true; const active = loadInboxFolder('inbox', { force: true }); await started.promise;
    const forced = loadInboxFolder('inbox', { force: true });
    closeNew = installInboxMailApi(createInboxMailApi(context([]), async () => { throw new Error('Disconnected scope must not read mail'); }));
    pending.resolve(result(delayedInput!, { threads: [{ id: 'stale', labels: [] }] }));
    await Promise.all([active, forced]);
    const fresh = useInboxSessionStore.getState();
    assert.equal(fresh.folders.inbox.snapshots.length, 0); assert.equal(fresh.folders.inbox.reader.loadKey, null);
    assert.equal(fresh.folders.inbox.loaded, false); assert.equal(fresh.gmailAccounts.length, 0); assert.equal(fresh.scrollPositions.inbox.listTop, 0);
  } finally { closeNew(); closeOld(); }
});

test('original folder mapping and reader identity distinguish reconnects without depending on display labels', () => {
  assert.equal(gmailQueryForInboxFolder('archive'), '-in:inbox -in:sent -in:drafts -in:trash -in:spam');
  assert.equal(microsoftFolderForInboxFolder('trash'), 'deleteditems');
  const identity = { provider: 'gmail' as const, accountId: randomUUID(), generation: randomUUID(), accountEmail: 'mail@example.test', threadId: 'thread', sourceMessageId: 'message', subject: 'Subject', sender: 'sender', messageCount: 1, latestAt: '2026-09-08' };
  assert.notEqual(inboxThreadLoadKey(identity), inboxThreadLoadKey({ ...identity, generation: randomUUID() }));
});

test('the actual original folder and reader adapters consume both providers through the real encrypted account and mail service', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-original-inbox-'));
  const store = new Store(directory), google = owner('google'), microsoft = owner('microsoft');
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const thread = { id: 'gmail-thread', messages: [{ id: 'gmail-message', threadId: 'gmail-thread', internalDate: '1788880000000', labelIds: ['INBOX', 'UNREAD'], payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Meeting <planning>' }], body: { data: Buffer.from('Literal <message> with café').toString('base64url') } } }] };
  const graphMessage = { id: 'immutable-message', conversationId: 'outlook-conversation', subject: 'Meeting', receivedDateTime: '2026-09-08T10:00:00Z', isRead: false, body: { contentType: 'text', content: 'Literal 1 < 2' }, hasAttachments: false };
  const providers = new Providers((async (input, init) => {
    const url = new URL(String(input)); assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer original-inbox-fixture');
    if (url.hostname === 'gmail.googleapis.com') {
      if (url.pathname.endsWith('/labels/INBOX')) return json({ id: 'INBOX', threadsTotal: 1 });
      if (url.pathname.endsWith('/threads')) return json({ threads: [{ id: 'gmail-thread' }] });
      if (url.pathname.endsWith('/threads/gmail-thread')) return json(thread);
    } else {
      assert.match(new Headers(init?.headers).get('Prefer') ?? '', /ImmutableId/);
      if (url.pathname.endsWith('/mailFolders/inbox')) return json({ id: 'inbox', totalItemCount: 1 });
      if (url.pathname.endsWith('/messages')) return json({ value: [graphMessage] });
    }
    throw new Error('Unexpected provider resource');
  }) as typeof fetch);
  const accounts = new Accounts(store, providers), mail = new MailService(store, accounts);
  let close = () => {};
  try {
    for (const item of [google, microsoft]) {
      item.scopes = item.provider === 'google' ? ['https://www.googleapis.com/auth/gmail.readonly'] : ['Mail.Read'];
      store.internalWrite(`accounts:item:${item.id}`, item);
      store.internalWrite(`accounts:credential:${item.id}`, { generation: item.generation, configuration: { provider: item.provider, clientId: item.provider === 'google' ? 'fixture.apps.googleusercontent.com' : randomUUID(), ...(item.provider === 'microsoft' ? { tenant: 'common', callbackPort: 4389 } : {}) }, tokens: { accessToken: 'original-inbox-fixture', expiresAt: Date.now() + 3600000, scopes: item.scopes } });
    }
    const deviceId = randomUUID();
    close = installInboxMailApi(createInboxMailApi({ epoch: store.epoch, deviceId, accounts: accounts.state(deviceId) }, input => mail.read(deviceId, input)));
    await loadInboxFolder('inbox');
    const folder = useInboxSessionStore.getState().folders.inbox;
    assert.equal(folder.error, null); assert.equal(folder.snapshots.length, 2);
    const googleSnapshot = folder.snapshots.find(item => item.provider === 'gmail')!, msSnapshot = folder.snapshots.find(item => item.provider === 'microsoft')!;
    assert.equal(googleSnapshot.threads[0].subject, 'Meeting <planning>'); assert.equal(googleSnapshot.threads[0].sourceMessageId, 'gmail-message');
    assert.equal(msSnapshot.threads[0].sourceMessageId, 'immutable-message'); assert.equal(msSnapshot.microsoftIdType, 'immutable');
    assert.equal(googleSnapshot.truncated, false); assert.equal(msSnapshot.truncated, false);
    const gmailRead = await getNativeGmailThread({ account: google.id, threadId: googleSnapshot.threads[0].id });
    assert.equal(describeNativeGmailThread(gmailRead.thread!)[0].bodyText, 'Literal <message> with café');
    const outlookRead = await getNativeMicrosoftConversation({ accountId: microsoft.id, conversationId: msSnapshot.threads[0].id, messageId: msSnapshot.threads[0].sourceMessageId });
    assert.equal(outlookRead.messages[0].bodyText, 'Literal 1 < 2'); assert.equal(outlookRead.messages[0].idType, 'immutable');
    assert.doesNotMatch(JSON.stringify(folder), /original-inbox-fixture|accessToken/);
  } finally { close(); await accounts.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('startup-warmed mail is consumed by the reader once, then refresh goes back to the provider', async () => {
  const account = owner('google'); let reads = 0;
  const api = createInboxMailApi(context([account]), async input => { reads++; return result(input, { thread: { id: 'warm-thread', messages: [] } }); });
  await api.preloadThread({ provider: 'google', accountId: account.id, threadId: 'warm-thread' });
  assert.equal(reads, 1);
  assert.equal((await api.gmail.getThread({ account: account.id, threadId: 'warm-thread' })).success, true); assert.equal(reads, 1);
  await api.gmail.getThread({ account: account.id, threadId: 'warm-thread' }); assert.equal(reads, 2);
  api.dispose(); await assert.rejects(api.gmail.getThread({ account: account.id, threadId: 'warm-thread' }), /connection changed/);
});

test('opening a warming message shares its request and a different account never consumes it', async () => {
  const first = owner('google'), second = owner('google'); const wait = deferred<void>(); let reads = 0;
  const api = createInboxMailApi(context([first, second]), async input => { reads++; await wait.promise; return result(input, { thread: { id: 'shared', messages: [] } }); });
  const warming = api.preloadThread({ provider: 'google', accountId: first.id, threadId: 'shared' });
  const opening = api.gmail.getThread({ account: first.id, threadId: 'shared' });
  assert.equal(reads, 1); wait.resolve(); await Promise.all([warming, opening]);
  await api.gmail.getThread({ account: first.id, threadId: 'shared' }); assert.equal(reads, 2);
  await api.gmail.getThread({ account: second.id, threadId: 'shared' }); assert.equal(reads, 3);
  api.dispose();
});
