import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayRequest } from '../deploy/vercel/gateway.mjs';

const env = { VERCEL_ENV: 'production', NOVA_GATEWAY_ENABLED: 'verified', NOVA_PUBLIC_ORIGIN: 'https://nova-owner.vercel.app', NOVA_ORIGIN: 'https://nova-vps.example.com', NOVA_PROXY_KEY: 'ab'.repeat(32) };
test('gateway is disabled until explicitly configured for the exact production owner URL', () => {
  const request = new Request(env.NOVA_PUBLIC_ORIGIN + '/');
  for (const change of [ { NOVA_GATEWAY_ENABLED: '' }, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'development' }, { NOVA_PROXY_KEY: '' }, { NOVA_PROXY_KEY: 'x'.repeat(64) }, { NOVA_PUBLIC_ORIGIN: 'https://nova-owner.vercel.app.evil.example' }, { NOVA_ORIGIN: 'http://origin.example.com' }, { NOVA_ORIGIN: 'https://user:password@origin.example.com' }, { NOVA_ORIGIN: 'https://origin.example.com/path' }, { NOVA_ORIGIN: 'https://origin.example.com:444' }, { NOVA_ORIGIN: 'https://nova-owner.vercel.app' }, { NOVA_ORIGIN: 'https://127.0.0.1' }, { NOVA_ORIGIN: 'https://server.localhost' } ]) assert.throws(() => gatewayRequest(request, { ...env, ...change }));
  assert.throws(() => gatewayRequest(request, {}));
  for (const url of ['https://preview.vercel.app/', 'http://nova-owner.vercel.app/', 'https://nova-owner.vercel.app.evil.example/']) assert.throws(() => gatewayRequest(new Request(url), env));
  assert.throws(() => gatewayRequest(new Request(request.url, { method: 'DELETE' }), env));
});
test('gateway preserves Nova request guards and cookie while stripping caller identity and Vercel credentials', () => {
  const request = new Request(env.NOVA_PUBLIC_ORIGIN + '/api/commands?q=a%2Fb&repeat=1&repeat=2', { method: 'POST', body: '{}', headers: {
    'Content-Type': 'application/json', Origin: env.NOVA_PUBLIC_ORIGIN,
    'X-Edition3-Candidate': 'c'.repeat(64), 'X-Edition3-Client': '1', 'X-Edition3-Epoch': 'epoch', 'X-Edition3-Transfer': 'bound-transfer',
    'If-None-Match': '"e3-' + 'd'.repeat(64) + '"',
    'Sec-Fetch-Site': 'cross-site', 'X-Nova-Proxy-Key': 'forged', 'X-Nova-Public-Origin': 'https://evil.example',
    'Tailscale-User-Login': 'owner@github', Authorization: 'Bearer forged', 'X-Forwarded-User': 'owner', 'X-Middleware-Next': '1',
    Cookie: '_vercel_jwt=private-vercel-cookie; __Host-e3_session_abc123_web=owned-session; __Host-e3_session_abc123_phone=phone; e3_session=desktop',
  }});
  const result = gatewayRequest(request, env);
  assert.equal(result.destination.href, env.NOVA_ORIGIN + '/api/commands?q=a%2Fb&repeat=1&repeat=2');
  assert.equal(result.headers.get('cookie'), '__Host-e3_session_abc123_web=owned-session');
  assert.equal(result.headers.get('x-nova-proxy-key'), env.NOVA_PROXY_KEY);
  assert.equal(result.headers.get('x-nova-public-origin'), env.NOVA_PUBLIC_ORIGIN);
  assert.equal(result.headers.get('sec-fetch-site'), 'cross-site');
  assert.equal(result.headers.get('x-edition3-candidate'), 'c'.repeat(64));
  assert.equal(result.headers.get('x-edition3-transfer'), 'bound-transfer');
  assert.equal(result.headers.get('if-none-match'), '"e3-' + 'd'.repeat(64) + '"');
  assert.equal(result.headers.get('origin'), env.NOVA_PUBLIC_ORIGIN);
  for (const name of ['authorization', 'tailscale-user-login', 'x-forwarded-user', 'x-middleware-next']) assert.equal(result.headers.has(name), false);
  assert.equal(request.bodyUsed, false);
});
test('gateway keeps hostile paths on the configured origin and preserves binary uploads without reading them', async () => {
  for (const path of ['//evil.example/steal', '/%2F%2Fevil.example/steal', '/oauth/callback?code=example&state=one-use']) assert.equal(gatewayRequest(new Request(env.NOVA_PUBLIC_ORIGIN + path), env).destination.origin, env.NOVA_ORIGIN);
  const bytes = new Uint8Array(5 * 1024 * 1024); bytes[0] = 17; bytes[bytes.length - 1] = 53;
  const upload = new Request(env.NOVA_PUBLIC_ORIGIN + '/api/storage/backups/upload', { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Edition3-Epoch': 'epoch' } });
  const result = gatewayRequest(upload, env);
  assert.equal(result.headers.get('content-type'), 'application/octet-stream');
  assert.equal(upload.bodyUsed, false);
  assert.deepEqual(new Uint8Array(await upload.arrayBuffer()), bytes);
});
