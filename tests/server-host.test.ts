import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { ServerKeyProtector } from '../apps/service/server-key.js';
import { WorkspaceKeys } from '../apps/service/workspace-keys.js';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import { privateWebOptions, authorizePrivateWeb } from '../apps/service/private-web.js';
import { Providers, readScopes } from '../apps/service/providers.js';

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'nova-server-')), directory = join(root, 'data'), credential = join(root, 'server.key');
  mkdirSync(directory); writeFileSync(credential, randomBytes(32), { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory, credential, protector: new ServerKeyProtector(credential, directory) };
}
test('server credential reopens encrypted records without Electron or a plaintext workspace key', async t => {
  const f = fixture(t), store = new Store(f.directory), keys = new WorkspaceKeys(f.directory, f.protector, 'linux');
  const task = store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, entityId: 'task:server', kind: 'task', expectedRevision: 0, payload: { title: 'Server retained task', notes: 'same saved work', status: 'open', planned: '', due: '' } });
  const original = readFileSync(join(f.directory, 'preview.key'));
  try { await keys.protect(value => store.matchesKey(value)); assert.equal(keys.status().protection, 'server'); assert.equal(keys.status().provider, 'server-secret'); }
  finally { store.close(); }
  assert.equal(existsSync(join(f.directory, 'preview.key')), false);
  const wrapper = readFileSync(join(f.directory, 'workspace-key.json')); assert.equal(wrapper.includes(original.toString('base64')), false);
  const key = await new WorkspaceKeys(f.directory, new ServerKeyProtector(f.credential, f.directory), 'linux').readProtected();
  const reopened = new Store(f.directory, undefined, key); key!.fill(0);
  try { assert.deepEqual(reopened.readEntity('task', task.id), task); } finally { reopened.close(); }
  const credential = readFileSync(f.credential); writeFileSync(f.credential, randomBytes(32));
  await assert.rejects(new WorkspaceKeys(f.directory, f.protector, 'linux').readProtected());
  assert.deepEqual(readFileSync(join(f.directory, 'workspace-key.json')), wrapper);
  writeFileSync(f.credential, credential); assert.deepEqual(await new WorkspaceKeys(f.directory, f.protector, 'linux').readProtected(), original);
});
test('server credential rejects corruption, public permissions, links, wrong size and storage inside data', async t => {
  const f = fixture(t), plain = randomBytes(32), sealed = await f.protector.wrap(plain);
  assert.deepEqual(await f.protector.unwrap(sealed), plain);
  for (const offset of [0, 1, 13, 29, 60]) { const corrupt = Buffer.from(sealed); corrupt[offset] ^= 1; await assert.rejects(f.protector.unwrap(corrupt)); }
  chmodSync(f.credential, 0o644); await assert.rejects(f.protector.wrap(plain), /private/); chmodSync(f.credential, 0o600);
  const link = join(f.root, 'link.key'); symlinkSync(f.credential, link); await assert.rejects(new ServerKeyProtector(link, f.directory).wrap(plain));
  const internal = join(f.directory, 'server.key'); writeFileSync(internal, plain, { mode: 0o600 }); await assert.rejects(new ServerKeyProtector(internal, f.directory).wrap(plain), /outside/);
  writeFileSync(f.credential, Buffer.alloc(31)); await assert.rejects(f.protector.wrap(plain)); rmSync(f.credential); await assert.rejects(f.protector.unwrap(sealed));
});
const web = { origin: 'https://nova.example.ts.net', ownerLogin: 'owner@github', port: 0 };
const identity = { Host: 'nova.example.ts.net', Origin: web.origin, 'Tailscale-User-Login': web.ownerLogin };
const candidateId = 'a'.repeat(64);
async function call(origin: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; cookie?: string; data: any }>((accept, reject) => {
    const req = httpRequest(origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Edition3-Client': '1', 'X-Edition3-Candidate': candidateId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra } }, response => {
      const chunks: Buffer[] = []; response.on('data', bytes => chunks.push(bytes)); response.on('end', () => accept({ status: response.statusCode!, cookie: response.headers['set-cookie']?.[0], data: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test('private owner web access uses exact proxy identity, secure separate sessions and canonical guarded writes across restart', async t => {
  const f = fixture(t);
  const options = { directory: f.directory, port: 0, privateWeb: web, keyProtector: f.protector, candidateId };
  let host = await startServer(options);
  t.after(() => host.close());
  let address = host.privateWebOrigin!;
  assert.equal(existsSync(join(f.directory, 'preview.key')), false);
  for (const headers of ([{}, { ...identity, 'Tailscale-User-Login': 'other@github' }, { Host: identity.Host, 'X-Forwarded-User': web.ownerLogin }, { ...identity, Host: 'wrong.example.ts.net' }, { ...identity, Origin: 'https://elsewhere.example' }, { ...identity, 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[])) assert.equal((await call(address, 'session', {}, headers)).status, 403);
  const session = await call(address, 'session', {}, identity); assert.equal(session.status, 200);
  assert.match(session.cookie!, /^__Host-e3_session_.+_web=/); assert.match(session.cookie!, /Secure; HttpOnly; SameSite=Strict; Path=\//);
  const cookie = session.cookie!.split(';')[0], headers = { ...identity, Cookie: cookie };
  const context = await call(address, 'access/context', undefined, headers); assert.equal(context.data.surface, 'web'); assert.equal(context.data.requiresPairing, false);
  assert.equal((await call(address, 'storage/state', undefined, headers)).data.protection, 'server');
  assert.equal((await call(address, 'assistant/runtime', undefined, headers)).status, 200);
  const task = { requestId: randomUUID(), epoch: host.store.epoch, kind: 'task', entityId: 'task:vps', expectedRevision: 0, payload: { title: 'Private web task', notes: 'Retain across host restart', status: 'open', planned: '', due: '' } };
  const saved = await call(address, 'commands', task, headers); assert.equal(saved.status, 200);
  assert.deepEqual((await call(address, 'commands', task, headers)).data, saved.data);
  assert.equal((await call(address, 'commands', { ...task, requestId: randomUUID(), epoch: randomUUID() }, headers)).data.code, 'epoch_changed');
  assert.equal((await call(address, 'commands', { ...task, requestId: randomUUID() }, { ...headers, 'X-Edition3-Candidate': 'b'.repeat(64) })).data.code, 'client_update');
  assert.equal((await call(address, 'snapshot', undefined, { ...headers, 'Tailscale-User-Login': 'other@github' })).status, 403);
  assert.equal((await call(host.origin, 'snapshot', undefined, { Cookie: cookie })).status, 401);
  await host.close(); host = await startServer(options); address = host.privateWebOrigin!;
  assert.equal((await call(address, 'session', {}, headers)).data.deviceId, session.data.deviceId);
  assert.deepEqual(host.store.readEntity('task', 'task:vps'), saved.data);
  assert.deepEqual((await call(address, 'commands', task, headers)).data, saved.data);
  const local = await call(host.origin, 'session', {}); assert.equal((await call(address, 'snapshot', undefined, { ...identity, Cookie: local.cookie!.split(';')[0] })).status, 401);
});
test('private web configuration is off by default and rejects ambiguous origins, accounts and ports', () => {
  assert.equal(privateWebOptions({}), undefined);
  assert.deepEqual(privateWebOptions({ E3_WEB_ORIGIN: web.origin, E3_WEB_OWNER_LOGIN: web.ownerLogin }), { ...web, port: 4386 });
  for (const change of [{ E3_WEB_ORIGIN: 'http://nova.example.ts.net' }, { E3_WEB_ORIGIN: 'https://nova.example.ts.net/path' }, { E3_WEB_ORIGIN: 'https://nova.example.ts.net:8443' }, { E3_WEB_ORIGIN: 'https://nova.example.ts.net.evil.example' }, { E3_WEB_OWNER_LOGIN: 'owner@github,anyone' }, { E3_WEB_OWNER_LOGIN: '' }, { E3_WEB_PORT: '0' }, { E3_WEB_PORT: '80' }, { E3_WEB_PORT: '04386' }]) assert.throws(() => privateWebOptions({ E3_WEB_ORIGIN: web.origin, E3_WEB_OWNER_LOGIN: web.ownerLogin, ...change }));
  assert.throws(() => authorizePrivateWeb({ socket: { remoteAddress: '10.0.0.2' }, headers: { 'tailscale-user-login': web.ownerLogin } } as never, web));
});

for (const provider of ['google', 'microsoft'] as const) test(`${provider} server OAuth returns to HTTPS and consumes its state once without a local browser callback`, async t => {
  const f = fixture(t), exchanges: URLSearchParams[] = [];
  const providers = new Providers((async (input, init = {}) => {
    const url = String(input), json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/token')) { exchanges.push(new URLSearchParams(String(init.body))); return json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, scope: readScopes[provider].join(' ') }); }
    if (url.includes('userinfo')) return json({ sub: 'server-google', email: 'fixture@example.test', name: 'Server fixture' });
    if (url.includes('/me?$select')) return json({ id: 'server-microsoft', mail: 'fixture@example.test', displayName: 'Server fixture' });
    return json({ items: [], value: [], labels: [] });
  }) as typeof fetch);
  const host = await startServer({ directory: f.directory, port: 0, privateWeb: web, keyProtector: f.protector, providers, candidateId }); t.after(() => host.close());
  const address = host.privateWebOrigin!, session = await call(address, 'session', {}, identity), headers = { ...identity, Cookie: session.cookie!.split(';')[0] };
  const command = () => ({ requestId: randomUUID(), epoch: host.store.epoch });
  const clientSecret = 'private-server-client-fixture';
  const configuration = provider === 'google' ? { provider, clientId: 'server-fixture.apps.googleusercontent.com', clientSecret } : { provider, clientId: randomUUID(), clientSecret, tenant: 'common', callbackPort: 4389 };
  assert.equal((await call(address, 'accounts/configure', { ...command(), expectedRevision: 0, configuration }, headers)).status, 200);
  const state = await call(address, 'accounts', undefined, headers); assert.equal(state.data.callbackUri, web.origin + '/oauth/callback'); assert.equal(JSON.stringify(state.data).includes(clientSecret), false);
  // A blank edit retains the encrypted secret for the same client identity.
  const { clientSecret: _secret, ...kept } = configuration;
  assert.equal((await call(address, 'accounts/configure', { ...command(), expectedRevision: 1, configuration: kept }, headers)).status, 200);
  const attempt = await call(address, 'accounts/start', { ...command(), provider }, headers); assert.equal(attempt.status, 202);
  const auth = new URL(attempt.data.authorizationUrl); assert.equal(auth.searchParams.get('redirect_uri'), web.origin + '/oauth/callback'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256'); assert.equal(auth.href.includes(clientSecret), false);
  const callback = '/oauth/callback?state=' + auth.searchParams.get('state') + '&code=fixture-code';
  const visit = (path: string, extra: Record<string, string> = {}) => new Promise<number>((accept, reject) => {
    const req = httpRequest(address + path, { headers: { ...identity, 'Sec-Fetch-Site': 'cross-site', ...extra } }, res => { res.resume(); res.on('end', () => accept(res.statusCode!)); }); req.on('error', reject); req.end();
  });
  assert.equal(await visit(callback, { 'Tailscale-User-Login': 'other@github' }), 403);
  assert.equal(await visit(callback + '&state=duplicate'), 400);
  assert.equal(exchanges.length, 0);
  assert.equal(await visit(callback), 200);
  for (let i = 0; i < 80 && host.accounts.state(session.data.deviceId).attempts[0].state !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(host.accounts.state(session.data.deviceId).attempts[0].state, 'completed');
  assert.equal(exchanges.length, 1); assert.equal(exchanges[0].get('redirect_uri'), web.origin + '/oauth/callback'); assert.equal(exchanges[0].get('client_secret'), clientSecret);
  assert.equal(await visit(callback), 400); assert.equal(exchanges.length, 1);
  const cancelled = await call(address, 'accounts/start', { ...command(), provider }, headers), cancelledAuth = new URL(cancelled.data.authorizationUrl);
  await call(address, 'accounts/cancel', { ...command(), attemptId: cancelled.data.id }, headers);
  assert.equal(await visit('/oauth/callback?state=' + cancelledAuth.searchParams.get('state') + '&code=late'), 400); assert.equal(exchanges.length, 1);
});
