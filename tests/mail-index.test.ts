import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay, setImmediate as yieldTurn } from 'node:timers/promises';
import { Store } from '../apps/service/store.js';
import { MailIndexService } from '../apps/service/mail-index.js';
import { Providers, accountCapabilities, ProviderError } from '../apps/service/providers.js';
import { startServer } from '../apps/service/http.js';
import type { ConnectedAccount } from '../packages/domain/accounts.js';
import type { MailReadSelector } from '../packages/domain/mail.js';
import type { ProviderMailPage } from '../apps/service/provider-mail.js';
import type { MailIndexResult } from '../packages/domain/mail-index.js';

const summary = (id: string, patch: object = {}) => ({ id, sourceMessageId: id + '-source', subject: 'Confidential planning ' + id, from: 'Alex <alex@example.test>', date: '2026-09-08T10:00:00Z', labels: ['INBOX'], messageCount: 1, ...patch });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 5000;
  while (true) { const value = await read(); if (accept(value)) return value; if (Date.now() >= until) throw Error('Expected index state did not arrive'); await delay(2); }
}
function fixture(respond: (selector: MailReadSelector, cursor: string | undefined, signal: AbortSignal) => Promise<ProviderMailPage> | ProviderMailPage, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-index-')); let store = new Store(directory);
  let account: ConnectedAccount = { id: randomUUID(), generation: randomUUID(), provider: 'google', subject: randomUUID(), email: 'index@example.test', label: 'Index fixture', revision: 1, state: 'connected', scopes: [], capabilities: accountCapabilities('google', ['https://www.googleapis.com/auth/gmail.readonly']), connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const calls: { selector: MailReadSelector; cursor?: string }[] = [];
  const accounts = { state: () => ({ clients: [], accounts: [account], attempts: [], probes: [] }), mailRead: async (_id: string, _generation: string, selector: MailReadSelector, cursor?: string, signal?: AbortSignal) => { calls.push({ selector, cursor }); return respond(selector, cursor, signal!); } };
  let index = new MailIndexService(store, accounts, { pageDelayMs: 0, retryDelayMs: 0, ...options });
  const input = () => ({ epoch: store.epoch, accountId: account.id, generation: account.generation });
  return { directory, calls, get store() { return store; }, get account() { return account; }, get index() { return index; }, input,
    changeAccount(patch: Partial<ConnectedAccount>) { account = { ...account, ...patch }; },
    read(revision?: string) { return index.read('device-a', { ...input(), ...(revision ? { revision } : {}) }); },
    sync(mode: 'resume' | 'refresh' | 'rebuild' = 'resume', extra: object = {}) { return index.command('device-a', { ...input(), requestId: randomUUID(), action: 'sync', mode, ...extra }); },
    async restart() { await index.close(); store.close(); store = new Store(directory); index = new MailIndexService(store, accounts, { pageDelayMs: 0, retryDelayMs: 0, ...options }); index.start(); },
    async close() { await index.close(); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
const complete = (result: MailIndexResult) => result.snapshot?.status === 'complete';

test('update hold discards an in-flight mail page without writes and release resumes its saved cursor',async()=>{
  const entered=deferred<void>(),late=deferred<ProviderMailPage>();let released=false;
  const f=fixture((selector,cursor)=>{
    if(selector.kind==='gmail.stats')return {value:{}};
    if(!cursor)return {value:{threads:[summary('first')]},next:'saved-cursor'};
    assert.equal(cursor,'saved-cursor');
    if(released)return {value:{threads:[summary('second')]}};
    entered.resolve();return late.promise;
  });
  try{
    await f.sync();await entered.promise;
    const before=f.store.internalPage('mail:index:'),runId=(await f.read()).runId,calls=f.calls.length;
    f.store.setUpdateMaintenanceHeld(true);late.resolve({value:{threads:[summary('must-not-publish')]}});
    await yieldTurn();await yieldTurn();f.index.start();await f.read();
    await assert.rejects(f.index.providerChanged(f.input(),'first',true),/update/i);
    await assert.rejects(f.sync(),/update/i);
    assert.deepEqual(f.store.internalPage('mail:index:'),before);assert.equal(f.calls.length,calls);
    released=true;f.store.setUpdateMaintenanceHeld(false);f.index.start();
    const after=await eventually(()=>f.read(),complete);
    assert.equal(after.runId,runId);assert.deepEqual(after.snapshot?.threads.map(thread=>thread.id).sort(),['first','second']);
    assert.equal(f.calls.filter(call=>call.cursor==='saved-cursor').length,2);
  }finally{late.resolve({value:{threads:[]}});await f.close();}
});

test('held startup and index reads preserve paused heads and retired pages until release',async()=>{
  const f=fixture(selector=>selector.kind==='gmail.stats'?{value:{}}:{value:{threads:[summary('saved')]}});
  try{
    await f.sync();await eventually(()=>f.read(),complete);
    const head=f.store.internalList<any>('mail:index:head:')[0],retired=randomUUID();
    f.store.internalBatch([
      {id:'mail:index:head:'+head.scope,value:{...head,status:'paused',retired:[retired]}},
      {id:`mail:index:data:${head.scope}:${retired}:p:00000000`,value:[summary('retired')]},
    ]);
    const before=f.store.internalPage('mail:index:'),calls=f.calls.length;
    f.store.setUpdateMaintenanceHeld(true);f.index.start();assert.equal((await f.read()).snapshot?.status,'paused');await yieldTurn();
    assert.deepEqual(f.store.internalPage('mail:index:'),before);assert.equal(f.calls.length,calls);
    f.store.setUpdateMaintenanceHeld(false);f.index.start();
    await eventually(()=>f.store.internalList<any>('mail:index:head:')[0].retired.length,count=>count===0);
    assert.equal((await f.read()).snapshot?.status,'paused');assert.equal(f.calls.length,calls);
    assert.equal(f.store.internalPage(`mail:index:data:${head.scope}:${retired}:`).length,0);
  }finally{await f.close();}
});

test('background Gmail indexing reserves foreground quota and pause cancels the paced next page', async () => {
  let threadReads = 0, pages = 0, elapsed = 0;
  const waits: { ms: number; finish: () => void }[] = [];
  const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    waits.push({ ms, finish: () => { signal.removeEventListener('abort', abort); elapsed += ms; resolve(); } });
  });
  const f = fixture(selector => {
    if (selector.kind === 'gmail.stats') return { value: {} };
    if (selector.kind !== 'gmail.threads') throw Error('Unexpected selector');
    threadReads += selector.max; pages++;
    return { value: { threads: Array.from({ length: selector.max }, (_, i) => summary(`${pages}-${i}`)) }, next: `page-${pages}` };
  }, { pageDelayMs: undefined, wait });
  try {
    await f.sync(); await yieldTurn();
    assert.equal((await f.read()).snapshot?.pagesIndexed, 1);
    assert.equal(pages, 1); assert.ok(waits[0].ms >= 15000);
    while (elapsed < 60000) { waits.shift()!.finish(); await yieldTurn(); }
    assert.ok(threadReads * 40 + pages * 10 < 6000, 'Background reads must leave quota for opening messages');
    const current = await f.read();
    await f.index.command('device-a', { ...f.input(), requestId: randomUUID(), action: 'pause', expectedRunId: current.runId });
    const pausedPages = pages; await yieldTurn();
    assert.equal(pages, pausedPages); assert.equal((await f.read()).snapshot?.status, 'paused');
  } finally { await f.close(); }
});

test('provider changes queue a fresh index after an active crawl and preserve a manually paused crawl',async()=>{
  const tail=deferred<ProviderMailPage>();let first=true,changed=false;
  const f=fixture((selector,cursor)=>{
    if(selector.kind==='gmail.stats')return {value:{messagesTotal:1,threadsTotal:1}};
    if(cursor)return tail.promise;
    if(first){first=false;return {value:{threads:[summary('old')]},next:'tail'};}
    return {value:{threads:[summary(changed?'new':'old')]}};
  });
  try{
    await f.sync();const active=await eventually(()=>f.read(),r=>r.snapshot?.pagesIndexed===1);
    await f.index.command('device-a',{...f.input(),requestId:randomUUID(),action:'pause',expectedRunId:active.runId});changed=true;
    await f.index.providerChanged(f.input());assert.equal((await f.read()).snapshot?.status,'paused');
    tail.resolve({value:{threads:[]}});await f.sync('resume');
    const result=await eventually(()=>f.read(),r=>complete(r)&&r.snapshot?.threads[0]?.id==='new');assert.equal(result.snapshot?.threads.length,1);
  }finally{await f.close();}
});

test('original index resumes encrypted pages after pause/restart with stable source IDs and private cursors', async () => {
  let second = false;
  const f = fixture(async (selector, cursor, signal) => {
    if (selector.kind === 'gmail.stats') throw new ProviderError('permission', 'Count permission unavailable');
    assert.deepEqual(selector, { kind: 'gmail.threads', query: 'in:inbox', max: 25 });
    if (!cursor) return { value: { threads: [summary('one')] }, next: 'private-next-page' };
    assert.equal(cursor, 'private-next-page');
    if (!second) { await delay(30000, undefined, { signal }); throw Error('Unreachable'); }
    return { value: { threads: [summary('one', { sourceMessageId: 'latest-source', date: '2026-09-08T12:00:00Z', labels: ['INBOX', 'IMPORTANT'] }), summary('two')] } };
  });
  try {
    await f.sync(); const first = await eventually(() => f.read(), value => value.snapshot?.pagesIndexed === 1);
    const pause = { ...f.input(), requestId: randomUUID(), action: 'pause', expectedRunId: first.runId };
    assert.equal((await f.index.command('device-a', pause)).snapshot?.status, 'paused');
    await f.restart(); assert.equal((await f.read()).snapshot?.status, 'paused');
    const before = f.calls.filter(call => call.selector.kind === 'gmail.threads' && !call.cursor).length;
    second = true; await f.sync(); const final = await eventually(() => f.read(), complete);
    assert.equal(final.snapshot?.pagesIndexed, 2); assert.equal(final.snapshot?.threads.length, 2);
    assert.equal(final.snapshot?.threads[0].sourceMessageId, 'latest-source');
    assert.equal(f.calls.filter(call => call.selector.kind === 'gmail.threads' && !call.cursor).length, before);
    assert.doesNotMatch(JSON.stringify(final), /private-next-page/);
    assert.equal((await f.read(final.revision)).unchanged, true); assert.equal((await f.read(final.revision)).snapshot, undefined);
    for (const file of readdirSync(f.directory).filter(name => name.startsWith('workspace.sqlite'))) assert.equal(readFileSync(join(f.directory, file)).includes(Buffer.from('Confidential planning')), false);
  } finally { await f.close(); }
});

test('refresh keeps cached mail until the full new crawl succeeds, then removes stale rows and labels', async () => {
  let refresh = false; const tail = deferred<ProviderMailPage>();
  const f = fixture((selector, cursor) => {
    if (selector.kind === 'gmail.stats') return { value: { messagesTotal: 2, threadsTotal: 2 } };
    if (!refresh) return { value: { threads: [summary('removed'), summary('kept', { labels: ['INBOX', 'STARRED'] })] } };
    if (!cursor) return { value: { threads: [summary('kept', { date: '2026-09-08T12:00:00Z' }), summary('new')] }, next: 'refresh-tail' };
    return tail.promise;
  });
  try {
    await f.sync(); await eventually(() => f.read(), complete); refresh = true; await f.sync('refresh');
    const partial = await eventually(() => f.read(), value => value.snapshot?.pagesIndexed === 1);
    assert.equal(partial.snapshot?.exhausted, false); assert.deepEqual(partial.snapshot?.threads.map(thread => thread.id).sort(), ['kept', 'new', 'removed']);
    assert.deepEqual(partial.snapshot?.threads.find(thread => thread.id === 'kept')?.labels, ['INBOX']);
    tail.resolve({ value: { threads: [] } }); const final = await eventually(() => f.read(), complete);
    assert.deepEqual(final.snapshot?.threads.map(thread => thread.id).sort(), ['kept', 'new']);
    await f.restart(); assert.deepEqual((await f.read()).snapshot?.threads.map(thread => thread.id).sort(), ['kept', 'new']);
  } finally { tail.resolve({ value: { threads: [] } }); await f.close(); }
});

test('exact pause receipts do not pause a later rebuild and pause/resume cannot strand an aborting job', async () => {
  const f = fixture(async (selector, _cursor, signal) => {
    if (selector.kind === 'gmail.stats') return { value: {} };
    await delay(30000, undefined, { signal }); return { value: { threads: [] } };
  });
  try {
    const first = await f.sync(), pause = { ...f.input(), requestId: randomUUID(), action: 'pause', expectedRunId: first.runId };
    await f.index.command('device-a', pause); await f.sync('resume'); await eventually(() => f.calls.length, count => count > 0);
    const rebuilt = await f.sync('rebuild'); assert.notEqual(rebuilt.runId, first.runId);
    const replay = await f.index.command('device-a', pause); assert.equal(replay.runId, rebuilt.runId); assert.equal(replay.snapshot?.status, 'indexing');
    await assert.rejects(f.index.command('device-a', { ...pause, requestId: randomUUID() }), /Another index job/);
    await assert.rejects(f.index.command('another-device', pause), /request|operation/i);
  } finally { await f.close(); }
});

test('repeated, incomplete and limited pages stay searchable without claiming completion', async () => {
  for (const mode of ['repeat', 'partial', 'limit'] as const) {
    const f = fixture(selector => selector.kind === 'gmail.stats' ? { value: {} } : {
      value: { threads: mode === 'limit' ? [summary('one'), summary('two'), summary('three')] : [summary('one')] },
      ...(mode === 'repeat' ? { next: 'same-page' } : mode === 'partial' ? { message: 'Provider returned partial mail' } : {}),
    }, { maxThreads: 2 });
    try {
      await f.sync(); const result = await eventually(() => f.read(), value => value.snapshot?.status === 'paused');
      assert.equal(result.snapshot?.exhausted, false); assert.ok(result.snapshot?.error);
      assert.equal(result.snapshot?.threads.length, mode === 'limit' ? 2 : 1); assert.equal(result.snapshot?.pagesIndexed, mode === 'repeat' ? 2 : 1);
    } finally { await f.close(); }
  }
});

test('disconnect fences late provider pages and old account generations cannot expose the index', async () => {
  const page = deferred<ProviderMailPage>(), entered = deferred<void>(); const f = fixture(() => { entered.resolve(); return page.promise; });
  try {
    const old = f.input(); await f.sync(); await entered.promise; f.changeAccount({ generation: randomUUID(), state: 'disconnected' });
    page.resolve({ value: { threads: [summary('late-secret')] } });
    await eventually(() => f.store.internalList<{ status: string }>('mail:index:head:')[0].status, state => state === 'error');
    await assert.rejects(f.index.read('device-a', old), /connection changed/); assert.equal(f.store.internalPage('mail:index:data:').length, 0);
    f.changeAccount({ state: 'connected' }); assert.equal((await f.read()).snapshot?.threads.length, 0);
  } finally { page.resolve({ value: { threads: [] } }); await f.close(); }
});

test('shutdown drains late work without publishing it; interrupted indexing resumes its saved next page', async () => {
  let reopening = false; const entered = deferred<void>(), late = deferred<ProviderMailPage>();
  const f = fixture((selector, cursor) => {
    if (selector.kind === 'gmail.stats') return { value: {} };
    if (!cursor) return { value: { threads: [summary('first')] }, next: 'next-after-restart' };
    if (reopening) return { value: { threads: [summary('second')] } };
    entered.resolve(); return late.promise;
  });
  try {
    await f.sync(); await entered.promise; let stopped = false; const closing = f.index.close().then(() => { stopped = true; });
    await delay(1); assert.equal(stopped, false); late.resolve({ value: { threads: [summary('must-not-publish')] } }); await closing;
    const head = f.store.internalList<{ status: string; pagesIndexed: number }>('mail:index:head:')[0]; assert.equal(head.status, 'indexing'); assert.equal(head.pagesIndexed, 1);
    reopening = true; await f.restart(); const final = await eventually(() => f.read(), complete);
    assert.deepEqual(final.snapshot?.threads.map(thread => thread.id).sort(), ['first', 'second']);
  } finally { late.resolve({ value: { threads: [] } }); await f.close(); }
});

test('account changes during large index decoding prevent stale responses leaving the service', async () => {
  const f = fixture((selector, cursor) => {
    if (selector.kind === 'gmail.stats') return { value: {} };
    const n = Number(cursor ?? 0); return { value: { threads: [summary(String(n))] }, ...(n < 10 ? { next: String(n + 1) } : {}) };
  });
  try { await f.sync(); await eventually(() => f.read(), complete); const pending = f.read(); f.changeAccount({ generation: randomUUID() }); await assert.rejects(pending, /connection changed/); }
  finally { await f.close(); }
});

test('failed encrypted batches commit neither page nor metadata and bounded reads stay inside their prefix', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-index-batch-')), store = new Store(directory);
  try {
    assert.throws(() => store.internalBatch([{ id: 'index:a', value: 'one' }, { id: 'index:b', value: 1n }])); assert.equal(store.internalRead('index:a'), undefined);
    store.internalBatch([{ id: 'index:a', value: 'one' }, { id: 'index:b', value: 'two' }, { id: 'other:a', value: 'private' }]);
    assert.deepEqual(store.internalPage('index:', '', 1), [{ id: 'index:a', value: 'one' }]);
    assert.deepEqual(store.internalPage('index:', 'index:a', 1), [{ id: 'index:b', value: 'two' }]); assert.deepEqual(store.internalPage('index:', 'index:b', 1), []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('authenticated HTTP index API uses real account/provider reads and rejects missing authority or extra fields', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-index-http-'));
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const providers = new Providers((async (input, init) => {
    assert.equal(init?.method ?? 'GET', 'GET'); const url = new URL(String(input));
    if (url.pathname.endsWith('/threads')) return json({ threads: [{ id: 'real-boundary' }] });
    if (url.pathname.endsWith('/threads/real-boundary')) return json({ id: 'real-boundary', messages: [{ id: 'verified-source', threadId: 'real-boundary', labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'Private provider subject' }] } }] });
    if (url.pathname.endsWith('/labels/INBOX')) return json({ id: 'INBOX', threadsTotal: 1, messagesTotal: 1 });
    throw Error('Unexpected provider URL');
  }) as typeof fetch);
  const service = await startServer({ directory, port: 0, providers });
  try {
    const id = randomUUID(), generation = randomUUID(), scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
    service.store.internalWrite(`accounts:item:${id}`, { id, generation, provider: 'google', subject: 'fixture', email: 'fixture@example.test', label: 'Fixture', revision: 1, state: 'connected', scopes, capabilities: accountCapabilities('google', scopes), connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    service.store.internalWrite(`accounts:credential:${id}`, { generation, configuration: { provider: 'google', clientId: 'fixture.apps.googleusercontent.com' }, tokens: { accessToken: 'fixture-only', expiresAt: Date.now() + 3600000, scopes } });
    const session = await fetch(service.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1' } }); const cookie = session.headers.get('set-cookie')!.split(';')[0]; await session.json();
    const input = { epoch: service.store.epoch, accountId: id, generation };
    const post = (path: string, body: unknown, authenticated = true) => fetch(service.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', ...(authenticated ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('/api/mail/index/read', input, false)).status, 401);
    assert.equal((await post('/api/mail/index/read', { ...input, providerCursor: 'untrusted' })).status, 400);
    assert.equal((await post('/api/mail/index/command', { ...input, requestId: randomUUID(), action: 'sync', mode: 'resume' })).status, 200);
    const result = await eventually(async () => (await post('/api/mail/index/read', input)).json() as Promise<MailIndexResult>, complete);
    assert.equal(result.snapshot?.threads[0].sourceMessageId, 'verified-source'); assert.equal(result.snapshot?.totalThreadCount, 1);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('provider retry-after waits remain cancellable and never spin after pause', async () => {
  let fetched = 0;
  const f = fixture(() => { fetched++; throw new ProviderError('throttled', 'Please wait', 60); });
  try {
    const started = await f.sync();
    await eventually(() => fetched, value => value === 1);
    await delay(15); assert.equal(fetched, 1);
    await f.index.command('device-a', { ...f.input(), requestId: randomUUID(), action: 'pause', expectedRunId: started.runId });
    await f.restart(); assert.equal((await f.read()).snapshot?.status, 'paused'); assert.equal(fetched, 1);
  } finally { await f.close(); }
});

test('confirmed read flags update saved pages immediately and survive an older in-flight page and restart',async()=>{
 const tail=deferred<ProviderMailPage>();
 const f=fixture((selector,cursor)=>selector.kind==='gmail.stats'?{value:{}}:cursor?tail.promise:{value:{threads:[summary('one',{labels:['INBOX','UNREAD','IMPORTANT']})]},next:'tail'});
 try{
  await f.sync();await eventually(()=>f.calls.length,c=>c>=3);
  await f.index.providerChanged(f.input(),'one',false);
  assert.deepEqual((await f.read()).snapshot?.threads[0].labels,['INBOX','IMPORTANT']);
  tail.resolve({value:{threads:[summary('one',{labels:['INBOX','UNREAD','IMPORTANT']})]}});
  const done=await eventually(()=>f.read(),complete);assert.ok(!done.snapshot?.threads[0].labels.includes('UNREAD'));
  await f.restart();assert.ok(!(await f.read()).snapshot?.threads[0].labels.includes('UNREAD'));
  await f.index.providerChanged(f.input(),'one',true);assert.ok((await f.read()).snapshot?.threads[0].labels.includes('UNREAD'));
 }finally{await f.close();}
});
