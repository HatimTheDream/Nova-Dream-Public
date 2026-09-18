import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { startServer } from '../apps/service/http.js';
import { ServerKeyProtector } from '../apps/service/server-key.js';
import { authorizePrivateWeb, privateWebOptions } from '../apps/service/private-web.js';
const canonical = 'https://nova-owner.vercel.app', candidateId = 'd'.repeat(64);
const posixCredential = { skip: process.platform === 'win32' ? 'Requires POSIX private-file modes and ownership; exercised in Linux CI.' : false };
function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'nova-vercel-')), directory = join(root, 'data'), serverKey = join(root, 'server.key'), proxyKey = join(root, 'proxy.key'), key = randomBytes(32);
  mkdirSync(directory); writeFileSync(serverKey, randomBytes(32), { mode: 0o600 }); writeFileSync(proxyKey, key, { mode: 0o600 });
  const env = { E3_WEB_AUTH: 'vercel', E3_WEB_ORIGIN: canonical, E3_WEB_PROXY_KEY_FILE: proxyKey, E3_SERVER_KEY_FILE: serverKey, E3_DATA_DIR: directory };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory, serverKey, proxyKey, key, env, web: privateWebOptions(env)! };
}
function call(origin: string, path: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; cookie?: string; tag?: string; bytes: number; data: any }>((resolve, reject) => {
    const req = httpRequest(origin + path, { agent: false, method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', 'X-Edition3-Candidate': candidateId, ...headers } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!, cookie: response.headers['set-cookie']?.[0], tag: response.headers.etag, bytes: Buffer.byteLength(text), data: text && response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text }); });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test('Vercel setup rejects mixed modes, shared encryption keys and unsafe credential files', posixCredential, t => {
  const f = fixture(t);
  for (const change of [{ E3_WEB_AUTH: 'headers' }, { E3_WEB_OWNER_LOGIN: 'owner@github' }, { E3_WEB_AUTH: 'tailscale' }, { E3_WEB_ORIGIN: 'https://nova-owner.vercel.app.evil.example' }, { E3_WEB_ORIGIN: 'http://nova-owner.vercel.app' }, { E3_WEB_ORIGIN: canonical + '/' }, { E3_WEB_ORIGIN: canonical + ':8443' }, { E3_WEB_PROXY_KEY_FILE: '' }, { E3_WEB_PROXY_KEY_FILE: 'relative.key' }, { E3_SERVER_KEY_FILE: f.proxyKey }]) assert.throws(() => privateWebOptions({ ...f.env, ...change }));
  const internal = join(f.directory, 'proxy.key'); writeFileSync(internal, f.key, { mode: 0o600 }); assert.throws(() => privateWebOptions({ ...f.env, E3_WEB_PROXY_KEY_FILE: internal }));
  chmodSync(f.proxyKey, 0o644); assert.throws(() => privateWebOptions(f.env)); chmodSync(f.proxyKey, 0o600);
  const linked = join(f.root, 'link.key'); symlinkSync(f.proxyKey, linked); assert.throws(() => privateWebOptions({ ...f.env, E3_WEB_PROXY_KEY_FILE: linked }));
  assert.throws(() => authorizePrivateWeb({ socket: { remoteAddress: '192.0.2.1' }, headers: { 'x-nova-proxy-key': f.key.toString('hex'), 'x-nova-public-origin': canonical } } as never, f.web));
});
test('Vercel owner sessions retain guarded writes across restart and reject direct-origin or stale credentials', posixCredential, async t => {
  const f = fixture(t), clientDirectory = join(f.root, 'client'); mkdirSync(clientDirectory); writeFileSync(join(clientDirectory, 'index.html'), '<html><head><title>Nova fixture</title></head><body>Owner landing</body></html>');
  const options = { directory: f.directory, port: 0, privateWeb: { ...f.web, port: 0 }, keyProtector: new ServerKeyProtector(f.serverKey, f.directory), candidateId, clientDirectory };
  let host = await startServer(options); t.after(() => host.close());
  let address = host.privateWebOrigin!;
  const identity = { Host: new URL(canonical).host, Origin: canonical, 'X-Nova-Proxy-Key': f.key.toString('hex'), 'X-Nova-Public-Origin': canonical };
  for (const headers of [{ Host: identity.Host }, { Host: identity.Host, 'Tailscale-User-Login': 'owner@github' }, { ...identity, 'X-Nova-Proxy-Key': '0'.repeat(64) }, { ...identity, 'X-Nova-Public-Origin': 'https://other.vercel.app' }, { ...identity, Host: 'vps.example.com' }, { ...identity, Origin: 'https://evil.example.com' }, { ...identity, 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) assert.equal((await call(address, '/api/session', headers, {})).status, 403);
  const session = await call(address, '/api/session', identity, {}); assert.equal(session.status, 200);
  assert.match(session.cookie!, /Secure; HttpOnly; SameSite=Strict; Path=\//);
  const headers = { ...identity, Cookie: session.cookie!.split(';')[0] };
  const landing = { ...identity, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal((await call(address, '/', landing)).status, 200);
  assert.equal((await call(address, '/', { ...landing, 'X-Nova-Proxy-Key': '' })).status, 403);
  assert.equal((await call(address, '/', { ...landing, 'Sec-Fetch-Dest': 'iframe' })).status, 403);
  assert.equal((await call(address, '/api/health', landing)).status, 403);
  assert.equal((await call(address, '/api/session', landing, {})).status, 403);
  const context = await call(address, '/api/access/context', headers); assert.equal(context.data.surface, 'web'); assert.equal(context.data.requiresPairing, false);
  const command = { requestId: randomUUID(), epoch: host.store.epoch, kind: 'task', entityId: 'task:vercel-proof', expectedRevision: 0, payload: { title: 'Remote owner proof', notes: 'Retained', status: 'open', planned: '', due: '' } };
  const saved = await call(address, '/api/commands', headers, command); assert.equal(saved.status, 200);
  for (const path of ['/api/snapshot', '/api/assistant/state', '/api/assistant/outputs']) {
    const first = await call(address, path, headers); assert.equal(first.status, 200); assert.match(first.tag!, /^"e3-[a-f0-9]{64}"$/);
    const conditional = { ...headers, 'If-None-Match': first.tag! };
    const unchanged = await call(address, path, conditional); assert.equal(unchanged.status, 304); assert.equal(unchanged.bytes, 0);
    assert.equal((await call(address, path, { ...conditional, 'X-Nova-Proxy-Key': '0'.repeat(64) })).status, 403);
    assert.equal((await call(address, path, { ...conditional, Cookie: '' })).status, 401);
  }
  const initialSnapshot = await call(address, '/api/snapshot', headers);
  const changed = { ...command, entityId: 'task:vercel-changed', requestId: randomUUID() };
  assert.equal((await call(address, '/api/commands', headers, changed)).status, 200);
  const changedSnapshot = await call(address, '/api/snapshot', { ...headers, 'If-None-Match': initialSnapshot.tag! });
  assert.equal(changedSnapshot.status, 200); assert.notEqual(changedSnapshot.tag, initialSnapshot.tag);
  assert.deepEqual((await call(address, '/api/commands', headers, command)).data, saved.data);
  assert.equal((await call(address, '/api/commands', { ...headers, 'X-Edition3-Candidate': 'e'.repeat(64) }, { ...command, requestId: randomUUID() })).data.code, 'client_update');
  assert.equal((await call(address, '/api/commands', headers, { ...command, requestId: randomUUID(), epoch: randomUUID() })).data.code, 'epoch_changed');
  await host.close(); host = await startServer(options); address = host.privateWebOrigin!;
  assert.equal((await call(address, '/api/session', headers, {})).data.deviceId, session.data.deviceId);
  assert.deepEqual(host.store.readEntity('task', command.entityId), saved.data);
  assert.equal((await call(host.origin, '/api/snapshot', { Cookie: headers.Cookie })).status, 401);
  const replacement = randomBytes(32); writeFileSync(f.proxyKey, replacement);
  assert.equal((await call(address, '/api/snapshot', headers)).status, 403);
  assert.equal((await call(address, '/api/snapshot', { ...headers, 'X-Nova-Proxy-Key': replacement.toString('hex') })).status, 200);
  rmSync(f.proxyKey); assert.equal((await call(address, '/api/snapshot', headers)).status, 403);
});
