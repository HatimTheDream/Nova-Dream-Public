import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Accounts } from '../apps/service/accounts.js';
import { Providers, authorizationUrl, accountCapabilities, accountScopes, readScopes } from '../apps/service/providers.js';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import { MailService } from '../apps/service/mail.js';
import { MailIndexService } from '../apps/service/mail-index.js';
import { MailDeliveryService } from '../apps/service/mail-delivery.js';
import { createRequire } from 'node:module';
import type { ClientConfiguration, Provider } from '../packages/domain/accounts.js';

const google: ClientConfiguration = { provider: 'google', clientId: 'edition3-fixture.apps.googleusercontent.com', clientSecret: 'private-configuration-fixture' };
const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
async function availablePort() { const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const port = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return port; }
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('Expected state did not settle'); }
function fixture(provider: Provider = 'google') {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-accounts-')); let now = Date.parse('2026-09-08T12:00:00Z');
  let store = new Store(directory, () => now); const calls: { url: string; method: string; form: URLSearchParams; headers: Headers }[] = [];
  let responder: (url: string, init: RequestInit) => Promise<Response> = async (url, init) => {
    if (url.endsWith('/token')) return respond({ access_token: 'private-access-fixture', refresh_token: 'private-refresh-fixture', token_type: 'Bearer', expires_in: 3600, scope: readScopes[provider].join(' ') });
    if (url.includes('userinfo')) return respond({ sub: 'google-subject-fixture', email: 'fixture@example.test', name: 'Fixture account' });
    if (url.includes('/me?$select')) return respond({ id: 'microsoft-subject-fixture', mail: 'fixture@example.test', displayName: 'Fixture account' });
    if (url.includes('calendarList')) return respond({ kind: 'calendar#calendarList', items: [{ id: 'calendar-one', summary: 'Private calendar', accessRole: 'owner' }], nextPageToken: 'more' });
    if (url.includes('/calendars?')) return respond({ value: [{ id: 'calendar-one', name: 'Private calendar', canEdit: true }], '@odata.nextLink': 'https://untrusted.example/never-follow' });
    if (url.endsWith('/labels')) return respond({ labels: [{ id: 'INBOX', name: 'INBOX' }] });
    if (url.includes('/mailFolders?')) return respond({ value: [{ id: 'immutable-folder', displayName: 'Inbox', totalItemCount: 5, unreadItemCount: 2 }] });
    throw new Error('Unexpected fixture request');
  };
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => { const url = String(input); calls.push({ url, method: init.method ?? 'GET', form: new URLSearchParams(String(init.body ?? '')), headers: new Headers(init.headers) }); assert.equal(init.redirect, 'error'); return responder(url, init); }) as typeof fetch;
  const providers = new Providers(fetcher, () => now); let accounts = new Accounts(store, providers, () => now);
  const command = () => ({ requestId: randomUUID(), epoch: store.epoch });
  return { directory, calls, providers, command, get now() { return now; }, time(n: number) { now = n; }, get store() { return store; }, get accounts() { return accounts; }, get responder() { return responder; }, set responder(fn: typeof responder) { responder = fn; }, async restart() { await accounts.close(); store.close(); store = new Store(directory, () => now); accounts = new Accounts(store, providers, () => now); }, async close() { await accounts.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function connect(f: ReturnType<typeof fixture>, configuration: ClientConfiguration = google) {
  f.accounts.configure('device-a', { ...f.command(), expectedRevision: 0, configuration });
  const cmd = { ...f.command(), provider: configuration.provider }, attempt = await f.accounts.start('device-a', cmd);
  const url = new URL(attempt.authorizationUrl!), callback = new URL(url.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('code', 'private-code-fixture');
  const response = await fetch(callback); assert.equal(response.status, 200); await response.text();
  await until(() => f.accounts.state('device-a').attempts[0].state === 'completed');
  return { account: f.accounts.state('device-a').accounts[0], cmd, url, attempt, callback };
}

test('provider scope and PKCE requests keep read, draft, send and calendar permission separate', () => {
  const g = new URL(authorizationUrl(google, 'http://127.0.0.1:12345/oauth/callback', 'state', 'challenge'));
  assert.equal(g.searchParams.get('code_challenge_method'), 'S256'); assert.equal(g.searchParams.get('access_type'), 'offline'); assert.ok(!g.href.includes('private-configuration-fixture'));
  const microsoft: ClientConfiguration = { provider: 'microsoft', clientId: randomUUID(), tenant: 'common', callbackPort: 4389 };
  assert.equal(new URL(authorizationUrl(microsoft, 'http://127.0.0.1:4389/oauth/callback', 'state', 'challenge')).origin, 'https://login.microsoftonline.com');
  assert.deepEqual(accountCapabilities('microsoft', ['https://graph.microsoft.com/Mail.ReadWrite']), { mailRead: true, mailDraft: true, mailSend: false, mailModify: true, calendarRead: false, calendarWrite: false, contactsRead: false, contactsWrite: false });
  assert.equal(accountCapabilities('google', readScopes.google).mailSend, false); assert.equal(accountCapabilities('google', readScopes.google).calendarWrite, false);
});
async function finishAttempt(f:ReturnType<typeof fixture>,attempt:{id:string;authorizationUrl?:string},outcome='completed') {
  const auth=new URL(attempt.authorizationUrl!),callback=new URL(auth.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state',auth.searchParams.get('state')!);callback.searchParams.set('code','permission-fixture');
  const response=await fetch(callback);assert.equal(response.status,200);await response.text();
  await until(()=>f.accounts.state('device-a').attempts.find(a=>a.id===attempt.id)?.state===outcome);
  return f.accounts.state('device-a').attempts.find(a=>a.id===attempt.id)!;
}
for(const provider of ['google','microsoft'] as const) {
  test(`${provider}: actual OAuth account identity reaches original mail reads, index and delivery without a UUID substitution`,async()=>{
    const f=fixture(provider);let index:MailIndexService|undefined,delivery:MailDeliveryService|undefined;
    try{
      const original=f.responder,scopes=accountScopes(provider,['mailDraft','mailSend']);
      f.responder=(url,init)=>url.endsWith('/token')?Promise.resolve(respond({access_token:'mail-connected',refresh_token:'mail-refresh',token_type:'Bearer',expires_in:3600,scope:scopes.join(' ')})):url.includes('/settings/sendAs')?Promise.resolve(respond({sendAs:[{sendAsEmail:'fixture@example.test',verificationStatus:'accepted',isPrimary:true}]})):url.includes('/masterCategories')?Promise.resolve(respond({value:[]})):original(url,init);
      const config=provider==='google'?google:{provider,clientId:randomUUID(),tenant:'common',callbackPort:await availablePort()};
      const {account}=await connect(f,config);assert.match(account.id,new RegExp('^'+provider+':[a-f0-9]{40}$'));
      const identity={epoch:f.store.epoch,accountId:account.id,generation:account.generation};
      const mail=new MailService(f.store,f.accounts);const read=await mail.read('device-a',{...identity,selector:{kind:provider==='google'?'gmail.labels':'microsoft.categories'}});assert.equal(read.accountId,account.id);
      index=new MailIndexService(f.store,f.accounts);assert.equal((await index.read('device-a',identity)).accountId,account.id);
      delivery=new MailDeliveryService(f.store,f.accounts);const review=await delivery.prepare('device-a',{...identity,requestId:randomUUID(),writerId:randomUUID(),mode:'draft',message:{from:account.email,to:['maya@example.test'],cc:[],bcc:[],subject:'Actual sign-in identity',bodyText:'Keep the real account boundary.',attachments:[]}});
      assert.equal(review.state,'prepared');assert.equal(review.accountId,account.id);
    }finally{await delivery?.close();await index?.close();await f.close();}
  });
  test(`${provider}: explicit permission upgrade preserves the account generation, carries existing grants and retains exact retry`,async()=>{
    const f=fixture(provider);try{
      const config=provider==='google'?google:{provider,clientId:randomUUID(),tenant:'common',callbackPort:await availablePort()};
      const {account}=await connect(f,config),original=f.responder;
      const scopes=accountScopes(provider,['mailDraft','mailSend'],account.scopes);
      const command={...f.command(),provider,accountId:account.id,expectedRevision:account.revision,permissions:['mailDraft','mailSend']};
      const attempt=await f.accounts.start('device-a',command),again=await f.accounts.start('device-a',command);
      assert.equal(again.id,attempt.id);const auth=new URL(attempt.authorizationUrl!);
      assert.deepEqual(new Set(auth.searchParams.get('scope')!.split(' ')),new Set(scopes));
      assert.equal(auth.searchParams.get('login_hint'),account.email);assert.equal(auth.searchParams.has('include_granted_scopes'),false);
      f.responder=(url,init)=>url.endsWith('/token')?Promise.resolve(respond({access_token:'upgraded-access',refresh_token:'upgraded-refresh',token_type:'Bearer',expires_in:3600,scope:scopes.join(' ')})):original(url,init);
      const completed=await finishAttempt(f,attempt),after=f.accounts.state('device-a').accounts[0];
      assert.equal(after.id,account.id);assert.equal(after.generation,account.generation);assert.equal(after.connectedAt,account.connectedAt);assert.equal(after.revision,account.revision+1);
      assert.equal(after.capabilities.mailDraft,true);assert.equal(after.capabilities.mailSend,true);assert.equal(after.capabilities.calendarRead,true);assert.deepEqual(completed.missingPermissions,[]);
      assert.equal((await f.accounts.start('device-a',command)).state,'completed');
      if(provider==='microsoft')assert.equal(f.calls.filter(call=>call.url.endsWith('/token')).at(-1)!.form.get('scope'),scopes.join(' '));
      await f.restart();assert.equal(f.accounts.state('device-a').accounts[0].generation,account.generation);
      const reconnect=await f.accounts.start('device-a',{...f.command(),provider,accountId:after.id,expectedRevision:after.revision});
      const requested=new URL(reconnect.authorizationUrl!).searchParams.get('scope')!.split(' ');
      assert.equal(accountCapabilities(provider,requested).mailSend,true);assert.equal(accountCapabilities(provider,requested).mailDraft,true);
    }finally{await f.close();}
  });
  test(`${provider}: partial consent reports missing permissions and never merges the old grant into the new token`,async()=>{
    const f=fixture(provider);try{
      const config=provider==='google'?google:{provider,clientId:randomUUID(),tenant:'common',callbackPort:await availablePort()};
      const {account}=await connect(f,config),original=f.responder;
      const scope=provider==='google'?'openid email https://www.googleapis.com/auth/gmail.readonly':'User.Read Mail.Read';
      f.responder=(url,init)=>url.endsWith('/token')?Promise.resolve(respond({access_token:'partial-access',refresh_token:'partial-refresh',token_type:'Bearer',expires_in:3600,scope})):original(url,init);
      const attempt=await f.accounts.start('device-a',{...f.command(),provider,accountId:account.id,expectedRevision:account.revision,permissions:['mailDraft','mailSend','mailModify']});
      const completed=await finishAttempt(f,attempt),after=f.accounts.state('device-a').accounts[0];
      assert.equal(after.generation,account.generation);assert.equal(after.capabilities.mailRead,true);assert.equal(after.capabilities.calendarRead,false);assert.equal(after.capabilities.mailSend,false);assert.equal(after.capabilities.mailModify,false);
      assert.deepEqual(completed.missingPermissions,['mailDraft','mailSend','mailModify']);assert.match(completed.message,/not granted/);
      assert.deepEqual(f.store.internalRead<any>('accounts:credential:'+account.id).tokens.scopes,scope.split(' '));
      await assert.rejects(f.accounts.mailOperation(account.id,account.generation,['mailSend'],new AbortController().signal,async()=>assert.fail('Unapproved write')),/additional account permission/);
    }finally{await f.close();}
  });
}
test('the token scope fallback binds to the exact requested upgrade, never the old read-only default',async()=>{
  const f=fixture();try{
    const {account}=await connect(f),original=f.responder;
    f.responder=(url,init)=>url.endsWith('/token')?Promise.resolve(respond({access_token:'no-scope-field',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600})):original(url,init);
    const attempt=await f.accounts.start('device-a',{...f.command(),provider:'google',accountId:account.id,expectedRevision:account.revision,permissions:['mailSend']});
    await finishAttempt(f,attempt);const after=f.accounts.state('device-a').accounts[0];assert.equal(after.capabilities.mailSend,true);assert.equal(after.capabilities.mailDraft,false);
  }finally{await f.close();}
});
test('cancelled, denied and interrupted permission requests preserve the connected account and credential',async()=>{
  const f=fixture();try{
    const {account}=await connect(f),credential=f.store.internalRead('accounts:credential:'+account.id);
    const start=()=>f.accounts.start('device-a',{...f.command(),provider:'google',accountId:account.id,expectedRevision:account.revision,permissions:['mailModify']});
    const cancelled=await start();f.accounts.cancel('device-a',{...f.command(),attemptId:cancelled.id});
    const denied=await start(),auth=new URL(denied.authorizationUrl!),callback=new URL(auth.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state',auth.searchParams.get('state')!);callback.searchParams.set('error','access_denied');const response=await fetch(callback);await response.text();
    assert.equal(f.accounts.state('device-a').attempts.find(a=>a.id===denied.id)?.state,'failed');
    const interrupted=await start();await f.restart();assert.equal(f.accounts.state('device-a').attempts.find(a=>a.id===interrupted.id)?.state,'expired');
    assert.deepEqual(f.accounts.state('device-a').accounts,[account]);assert.deepEqual(f.store.internalRead('accounts:credential:'+account.id),credential);
  }finally{await f.close();}
});
test('permission upgrade rejects stale revisions, mismatched identity and arbitrary scopes without replacing credentials',async()=>{
  const f=fixture();try{
    const {account}=await connect(f),credential=f.store.internalRead('accounts:credential:'+account.id),original=f.responder;
    const input={...f.command(),provider:'google',accountId:account.id,expectedRevision:account.revision,permissions:['mailSend']};
    await assert.rejects(f.accounts.start('device-a',{...input,expectedRevision:0}),/current account/);
    await assert.rejects(f.accounts.start('device-a',{...input,permissions:['https://mail.google.com/']}));
    f.responder=(url,init)=>url.includes('userinfo')?Promise.resolve(respond({sub:'wrong-subject',email:'someoneelse@example.test'})):original(url,init);
    await finishAttempt(f,await f.accounts.start('device-a',input),'failed');
    assert.deepEqual(f.accounts.state('device-a').accounts,[account]);assert.deepEqual(f.store.internalRead('accounts:credential:'+account.id),credential);
  }finally{await f.close();}
});
test('mail operations fence a replaced credential even when an approved upgrade keeps the account generation',async()=>{
  const f=fixture();try{
    const {account}=await connect(f),key='accounts:credential:'+account.id;
    await assert.rejects(f.accounts.mailOperation(account.id,account.generation,['mailRead'],new AbortController().signal,async(_account,_request,check)=>{
      f.store.internalWrite(key,{...f.store.internalRead<any>(key),version:randomUUID()});check();assert.fail('Old credentials reached another provider dispatch');
    }),/credentials changed/);
  }finally{await f.close();}
});
test('real loopback callback verifies PKCE, retains one sign-in and stores no tokens in public state', async () => {
  const f = fixture(); try {
    const { account, cmd, url } = await connect(f);
    assert.equal((await f.accounts.start('device-a', cmd)).state, 'completed'); assert.equal(f.calls.filter(c => c.url.endsWith('/token')).length, 1);
    const exchange = f.calls.find(c => c.url.endsWith('/token'))!;
    assert.equal(createHash('sha256').update(exchange.form.get('code_verifier')!).digest('base64url'), url.searchParams.get('code_challenge'));
    assert.equal(exchange.form.get('code'), 'private-code-fixture'); assert.equal(account.subject, 'google-subject-fixture');
    const state = JSON.stringify(f.accounts.state('device-a')), snapshot = JSON.stringify(f.store.snapshot('device-a'));
    for (const secret of ['private-access-fixture', 'private-refresh-fixture', 'private-configuration-fixture', 'private-code-fixture', exchange.form.get('code_verifier')!]) { assert.ok(!state.includes(secret)); assert.ok(!snapshot.includes(secret)); for (const file of readdirSync(f.directory).filter(x => x.startsWith('workspace.sqlite'))) assert.ok(!readFileSync(join(f.directory, file)).includes(Buffer.from(secret))); }
    const probe = await f.accounts.probe('device-a', { ...f.command(), accountId: account.id, expectedRevision: account.revision });
    assert.equal(probe.calendars.limited, true); assert.equal(probe.calendars.items[0].providerCanWrite, true); assert.equal(account.capabilities.calendarWrite, false); assert.equal(probe.mail.folders[0].id, 'INBOX');
    await f.restart(); assert.equal(f.accounts.state('device-a').accounts[0].id, account.id); assert.equal(f.accounts.state('device-a').probes[0].accountId, account.id);
  } finally { await f.close(); }
});
test('Microsoft callback identifies the actual account and reads bounded immutable folders without following links', async () => {
  const f = fixture('microsoft'); try {
    const configuration: ClientConfiguration = { provider: 'microsoft', clientId: randomUUID(), tenant: 'common', callbackPort: await availablePort() };
    const { account, url } = await connect(f, configuration);
    assert.equal(new URL(url.searchParams.get('redirect_uri')!).port, String(configuration.callbackPort));
    const probe = await f.accounts.probe('device-a', { ...f.command(), accountId: account.id, expectedRevision: account.revision });
    assert.equal(account.subject, 'microsoft-subject-fixture'); assert.equal(probe.mail.folders[0].unread, 2); assert.equal(probe.calendars.limited, true);
    assert.ok(f.calls.every(c => !c.url.includes('untrusted.example'))); assert.ok(f.calls.filter(c => c.url.startsWith('https://graph.microsoft.com')).every(c => c.headers.get('prefer') === 'IdType="ImmutableId"'));
  } finally { await f.close(); }
});
test('invalid, duplicated and multibyte callback state cannot consume the pending sign-in', async () => {
  const f = fixture(); try {
    f.accounts.configure('device-a', { ...f.command(), expectedRevision: 0, configuration: google });
    const cmd = { ...f.command(), provider: 'google' }, a = await f.accounts.start('device-a', cmd), b = await f.accounts.start('device-a', cmd);
    assert.equal(a.authorizationUrl, b.authorizationUrl); assert.equal(f.accounts.state('device-b').attempts.length, 0);
    const auth = new URL(a.authorizationUrl!), redirect = auth.searchParams.get('redirect_uri')!;
    for (const query of [new URLSearchParams({ code: 'x', state: 'é'.repeat(auth.searchParams.get('state')!.length) }), new URLSearchParams([['code', 'x'], ['code', 'y'], ['state', auth.searchParams.get('state')!]])]) {
      const r = await fetch(redirect + '?' + query); assert.equal(r.status, 400); await r.text();
    }
    assert.equal(f.calls.length, 0); assert.equal(f.accounts.state('device-a').attempts[0].state, 'waiting');
    const cancel = { ...f.command(), attemptId: a.id }; assert.equal(f.accounts.cancel('device-a', cancel).state, 'cancelled'); assert.equal(f.accounts.cancel('device-a', cancel).state, 'cancelled');
  } finally { await f.close(); }
});
test('cancel during code exchange fences late tokens and avoids even the later account read', async () => {
  const f = fixture(); let release!: (r: Response) => void;
  try {
    f.responder = () => new Promise<Response>(r => { release = r; });
    f.accounts.configure('device-a', { ...f.command(), expectedRevision: 0, configuration: google });
    const a = await f.accounts.start('device-a', { ...f.command(), provider: 'google' }), auth = new URL(a.authorizationUrl!), callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('code', 'fixture'); const r = await fetch(callback); await r.text();
    await until(() => !!release); f.accounts.cancel('device-a', { ...f.command(), attemptId: a.id });
    release(respond({ access_token: 'late-private-token', token_type: 'Bearer', expires_in: 3600 }));
    await f.restart(); assert.equal(f.accounts.state('device-a').accounts.length, 0); assert.equal(f.accounts.state('device-a').attempts[0].state, 'cancelled'); assert.equal(f.calls.length, 1);
  } finally { if (release) release(respond({})); await f.close(); }
});
test('interrupted waiting sign-in expires through restart and cannot restart from its old request', async () => {
  const f = fixture(); try {
    f.accounts.configure('device-a', { ...f.command(), expectedRevision: 0, configuration: google });
    const cmd = { ...f.command(), provider: 'google' }; await f.accounts.start('device-a', cmd); await f.restart();
    const result = await f.accounts.start('device-a', cmd); assert.equal(result.state, 'expired'); assert.equal(result.authorizationUrl, undefined); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('refresh rotation preserves identity, updates reduced scopes and never probes ungranted mail', async () => {
  const f = fixture(); try {
    const { account } = await connect(f); const original = f.responder; f.time(f.now + 3600000);
    f.responder = async (url, init) => url.endsWith('/token') ? respond({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'openid email https://www.googleapis.com/auth/calendar.readonly' }) : original(url, init);
    const beforeLabels = f.calls.filter(c => c.url.endsWith('/labels')).length;
    const probe = await f.accounts.probe('device-a', { ...f.command(), accountId: account.id, expectedRevision: account.revision });
    assert.equal(probe.calendars.state, 'available'); assert.equal(probe.mail.state, 'unavailable'); assert.equal(f.calls.filter(c => c.url.endsWith('/labels')).length, beforeLabels);
    assert.equal(f.accounts.state('device-a').accounts[0].capabilities.mailRead, false);
    assert.equal(f.store.internalRead<any>(`accounts:credential:${account.id}`).tokens.refreshToken, 'rotated-refresh');
  } finally { await f.close(); }
});
test('unknown refresh requires a new sign-in and cannot discard unrelated saved work', async () => {
  const f = fixture(); try {
    const { account } = await connect(f); const task = f.store.mutate('device-a', { ...f.command(), kind: 'task', entityId: `task:${randomUUID()}`, expectedRevision: 0, payload: { title: 'Keep this task', notes: '', planned: '', due: '', status: 'open' } });
    f.time(f.now + 3600000); f.responder = async () => { throw new Error('private-provider-error-token'); };
    await assert.rejects(f.accounts.probe('device-a', { ...f.command(), accountId: account.id, expectedRevision: account.revision }), /not confirmed/);
    const current = f.accounts.state('device-a').accounts[0]; assert.equal(current.state, 'reconnect'); const count = f.calls.length;
    await assert.rejects(f.accounts.probe('device-a', { ...f.command(), accountId: account.id, expectedRevision: current.revision }), /connection changed/); assert.equal(f.calls.length, count);
    assert.equal(JSON.stringify(f.accounts.state('device-a')).includes('private-provider-error-token'), false); assert.deepEqual(f.store.snapshot('device-a').tasks[0], task);
  } finally { await f.close(); }
});
test('reconnecting with a different provider subject preserves the original account and credentials', async () => {
  const f = fixture(); try {
    const { account } = await connect(f), before = f.store.internalRead(`accounts:credential:${account.id}`), original = f.responder;
    f.responder = (url, init) => url.includes('userinfo') ? Promise.resolve(respond({ sub: 'other-subject', email: 'other@example.test' })) : original(url, init);
    const a = await f.accounts.start('device-a', { ...f.command(), provider: 'google', accountId: account.id, expectedRevision: account.revision }), auth = new URL(a.authorizationUrl!), callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('code', 'other-account'); const r = await fetch(callback); await r.text();
    await until(() => f.accounts.state('device-a').attempts.find(x => x.id === a.id)?.state === 'failed');
    assert.deepEqual(f.accounts.state('device-a').accounts, [account]); assert.deepEqual(f.store.internalRead(`accounts:credential:${account.id}`), before);
  } finally { await f.close(); }
});
test('disconnect during refresh fences late tokens before any further account read', async () => {
  const f = fixture(); let release!: (r: Response) => void;
  try {
    const { account } = await connect(f); f.time(f.now + 3600000); f.responder = () => new Promise<Response>(r => { release = r; });
    const probe = f.accounts.probe('device-a', { ...f.command(), accountId: account.id, expectedRevision: account.revision });
    const failure = assert.rejects(probe, /connection changed/); await until(() => !!release);
    const refreshing = f.accounts.state('device-a').accounts[0]; f.accounts.disconnect('device-a', { ...f.command(), accountId: account.id, expectedRevision: refreshing.revision });
    const calls = f.calls.length; release(respond({ access_token: 'late-refresh', refresh_token: 'late-rotation', token_type: 'Bearer', expires_in: 3600 })); await failure;
    assert.equal(f.calls.length, calls); assert.equal(f.accounts.state('device-a').accounts[0].state, 'disconnected'); assert.deepEqual(f.store.internalRead(`accounts:credential:${account.id}`), { disconnected: true });
  } finally { if (release) release(respond({})); await f.close(); }
});
test('configuration receipt reconciles a lost reply without exposing a secret or crossing devices', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-account-http-')); const service = await startServer({ directory, port: 0 });
  try {
    const session = async () => { const r = await fetch(service.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1' } }); return r.headers.get('set-cookie')!.split(';')[0]; };
    const cookie = await session(), other = await session();
    const call = (path: string, body?: unknown, auth = cookie) => fetch(service.origin + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: auth, Origin: service.origin, 'X-Edition3-Client': '1', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await fetch(service.origin + '/api/accounts')).status, 401);
    const cmd = { requestId: randomUUID(), epoch: service.store.epoch, expectedRevision: 0, configuration: google }; assert.equal((await call('accounts/configure', cmd)).status, 200);
    const receipt = await call(`accounts/configuration-receipts/${cmd.requestId}`); assert.equal(receipt.status, 200); const result = await receipt.json(); assert.deepEqual(result, { provider: 'google', revision: 1, configured: true });
    assert.equal((await call(`accounts/configuration-receipts/${cmd.requestId}`, undefined, other)).status, 404); assert.equal((await call('accounts/configure', cmd)).status, 200);
    assert.equal((await call('accounts/configure', { ...cmd, requestId: randomUUID(), configuration: { ...google, clientId: 'changed.apps.googleusercontent.com' } })).status, 409);
    const view = await (await call('accounts')).text(); assert.ok(!view.includes('private-configuration-fixture')); assert.ok(view.includes('hasClientSecret'));
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('native external links allow only supported sign-in with a local callback and explicit guides', () => {
  const { canOpenExternal } = createRequire(import.meta.url)('../apps/desktop/external.cjs');
  const url = authorizationUrl(google, 'http://127.0.0.1:45000/oauth/callback', 'a'.repeat(43), 'b'.repeat(43)); assert.equal(canOpenExternal(url), true);
  const bad = new URL(url); bad.searchParams.set('redirect_uri', 'https://untrusted.example/callback'); assert.equal(canOpenExternal(bad.href), false);
  bad.searchParams.set('redirect_uri', 'http://127.0.0.1:45000/oauth/callback'); bad.searchParams.append('state', 'c'.repeat(43)); assert.equal(canOpenExternal(bad.href), false);
  assert.equal(canOpenExternal('https://accounts.google.com.untrusted.example/o/oauth2/v2/auth'), false); assert.equal(canOpenExternal('file:///tmp/example'), false); assert.equal(canOpenExternal('https://auth.openai.com/codex/device'), true);
  const guide = 'https://support.google.com/cloud/answer/15549945?hl=en'; assert.equal(canOpenExternal(guide), true);
  for (const unsupported of [guide + '&redirect=https://untrusted.example', guide + '#untrusted', guide.replace('support.google.com', 'support.google.com.untrusted.example'), guide.replace('15549945', '15549946'), guide.replace('https:', 'http:')]) assert.equal(canOpenExternal(unsupported), false);
});

test('partial provider reads retain the working source and never expose raw provider errors', async () => {
  const f = fixture(); try {
    const { account } = await connect(f), original = f.responder;
    f.responder = async (url, init) => url.endsWith('/labels') ? new Response('private proxy error with token', { status: 403 }) : original(url, init);
    const result = await f.accounts.probe('device-a', { ...f.command(), accountId: account.id, expectedRevision: account.revision });
    assert.equal(result.calendars.state, 'available'); assert.equal(result.mail.state, 'unavailable');
    assert.match(result.mail.message!, /permission/); assert.ok(!JSON.stringify(result).includes('private proxy'));
    assert.equal(f.accounts.state('device-a').accounts[0].state, 'connected');
    f.responder = async () => new Response('', { status: 401 });
    await f.accounts.probe('device-a', { ...f.command(), accountId: account.id, expectedRevision: account.revision });
    assert.equal(f.accounts.state('device-a').accounts[0].state, 'reconnect');
  } finally { await f.close(); }
});
test('provider malformed identity, throttling and oversized content stay bounded and sanitized', async () => {
  let response = respond({ email: 'missing-subject@example.test' });
  const providers = new Providers((async () => response) as typeof fetch);
  await assert.rejects(providers.profile('google', 'fixture'), { code: 'invalid_response' });
  response = new Response('private proxy details', { status: 429, headers: { 'Retry-After': '90' } });
  await assert.rejects(providers.mailFolders('google', 'fixture'), { code: 'throttled', retryAfterSeconds: 90 });
  response = new Response('x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(providers.calendars('google', 'fixture'), { code: 'unavailable', message: 'The provider response was incomplete.' });
});

test('occupied Microsoft callback port fails without stopping its current listener', async () => {
  const f = fixture('microsoft'), listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  try {
    const callbackPort = (listener.address() as { port: number }).port;
    f.accounts.configure('device-a', { ...f.command(), expectedRevision: 0, configuration: { provider: 'microsoft', clientId: randomUUID(), tenant: 'common', callbackPort } });
    const result = await f.accounts.start('device-a', { ...f.command(), provider: 'microsoft' });
    assert.equal(result.state, 'failed'); assert.match(result.message, /no other service was stopped/);
    assert.equal(listener.listening, true); assert.equal(f.calls.length, 0);
  } finally { await f.close(); await new Promise<void>(resolve => listener.close(() => resolve())); }
});
test('provider consent refusal finishes without exchanging or reflecting private error details', async () => {
  const f = fixture(); try {
    f.accounts.configure('device-a', { ...f.command(), expectedRevision: 0, configuration: google });
    const command = { ...f.command(), provider: 'google' }, a = await f.accounts.start('device-a', command), auth = new URL(a.authorizationUrl!);
    const callback = new URL(auth.searchParams.get('redirect_uri')!); callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('error', 'access_denied'); callback.searchParams.set('error_description', 'private-error-fixture');
    const response = await fetch(callback); assert.equal(response.status, 200); assert.ok(!(await response.text()).includes('private-error-fixture'));
    assert.equal((await f.accounts.start('device-a', command)).state, 'failed'); assert.equal(f.calls.length, 0); assert.equal(f.accounts.state('device-a').accounts.length, 0);
  } finally { await f.close(); }
});

test('OAuth refusals classify only known codes, keep connected accounts and never infer Testing from access_denied', async () => {
  const f = fixture(); try {
    const { account } = await connect(f), credential = f.store.internalRead('accounts:credential:' + account.id), calls = f.calls.length;
    const cases = [
      ['access_denied', /not approved/],
      ['org_internal', /organization.*Google sign-in/],
      ['admin_policy_enforced', /Workspace administrator/],
      ['invalid_client', /app’s sign-in setup/],
      ['temporarily_unavailable', /temporarily unable/],
      ['private-unknown-error-fixture', /did not complete/],
    ] as const;
    for (const [error, expected] of cases) {
      const command = { ...f.command(), provider: 'google', accountId: account.id, expectedRevision: account.revision };
      const attempt = await f.accounts.start('device-a', command), auth = new URL(attempt.authorizationUrl!), callback = new URL(auth.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', auth.searchParams.get('state')!);
      callback.searchParams.set('error', error);
      callback.searchParams.set('error_description', '<script>private-provider-details</script>');
      const response = await fetch(callback); assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), /private-provider-details|private-unknown-error-fixture/);
      const result = await f.accounts.start('device-a', command);
      assert.equal(result.id, attempt.id); assert.equal(result.state, 'failed'); assert.match(result.message, expected);
      assert.doesNotMatch(JSON.stringify(result), /private-provider-details|private-unknown-error-fixture|test users|testing|try again/i);
      assert.deepEqual(f.accounts.state('device-a').accounts, [account]);
      assert.deepEqual(f.store.internalRead('accounts:credential:' + account.id), credential);
      assert.equal(f.calls.length, calls, 'A denied callback cannot reach token exchange or replace credentials');
    }
  } finally { await f.close(); }
});

test('invalid-state and mixed error/code refusals keep the original waiting sign-in usable', async () => {
  const f = fixture(); try {
    f.accounts.configure('device-a', { ...f.command(), expectedRevision: 0, configuration: google });
    const attempt = await f.accounts.start('device-a', { ...f.command(), provider: 'google' }), auth = new URL(attempt.authorizationUrl!), callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', 'wrong-state'); callback.searchParams.set('error', 'org_internal');
    let response = await fetch(callback); assert.equal(response.status, 400); await response.text();
    callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('code', 'untrusted-code');
    response = await fetch(callback); assert.equal(response.status, 400); await response.text();
    assert.equal(f.accounts.state('device-a').attempts[0].state, 'waiting'); assert.equal(f.calls.length, 0);
    assert.equal(f.accounts.state('device-a').attempts[0].authorizationUrl, attempt.authorizationUrl);
    callback.searchParams.delete('code');
    response = await fetch(callback); assert.equal(response.status, 200); await response.text();
    assert.equal(f.accounts.state('device-a').attempts[0].state, 'failed'); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('calendar reads recheck reduced permissions after token refresh before requesting events', async () => {
  const f = fixture(); try {
    const { account } = await connect(f), original = f.responder; f.time(f.now + 3600000);
    f.responder = async (url, init) => url.endsWith('/token') ? respond({ access_token: 'reduced-calendar-fixture', refresh_token: 'rotated-fixture', expires_in: 3600, token_type: 'Bearer', scope: 'openid email' }) : original(url, init);
    await assert.rejects(f.accounts.calendarEvents(account.id, account.generation, 'calendar-one', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'), /calendar read permission/);
    assert.equal(f.calls.some(c => c.url.includes('/events?')), false);
  } finally { await f.close(); }
});
test('calendar source reads cannot publish after disconnect and shutdown aborts an outstanding calendar read', async () => {
  const f = fixture(); let release!: (response: Response) => void;
  try {
    const { account } = await connect(f);
    f.responder = (url, init) => new Promise((resolve, reject) => { release = resolve; init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    const reading = f.accounts.calendarSources(account.id, account.generation); const rejected = assert.rejects(reading, /connection changed/); await until(() => !!release);
    f.accounts.disconnect('device-a', { ...f.command(), accountId: account.id, expectedRevision: account.revision }); release(respond({ kind: 'calendar#calendarList', items: [] })); await rejected;
    // Use a fresh connected fixture account generation to prove authority shutdown aborts its own read.
    f.store.internalWrite(`accounts:item:${account.id}`, account); f.store.internalWrite(`accounts:credential:${account.id}`, { generation: account.generation, configuration: google, tokens: { accessToken: 'fixture', scopes: readScopes.google, expiresAt: f.now + 3600000 } });
    release = undefined!; const pending = f.accounts.calendarSources(account.id, account.generation); const aborted = assert.rejects(pending); await until(() => !!release); await f.accounts.close(); await aborted;
  } finally { await f.close(); }
});
