import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenExternal, privatePhoneOrigin, openPhoneExternal } from '../apps/desktop/external.cjs';

const origin = 'https://owner.example.ts.net:8443';
const expected = { version: '0.71.1', buildVersion: '1.0.130', apiVersion: 1, schemaVersion: 52, candidateId: 'a'.repeat(64) };
const healthy = { ...expected, application: 'nova-dream-edition-3', status: 'ready' };
const ready = { enabled: true, route: { state: 'ready', origin }, devices: [] };
function fixture() {
  const opened = [], calls = [];
  let state = ready, health = healthy, current = true;
  const context = { expected,
    readHealth: async () => { calls.push('health'); return health; },
    readPhoneState: async () => { calls.push('phone'); return state; },
    isCurrentPage: () => current,
    openExternal: async value => { opened.push(value); }
  };
  return { context, opened, calls, state: value => { state = value; }, health: value => { health = value; }, page: value => { current = value; } };
}
test('desktop permits the exact Tailscale download guide and never arbitrary destinations', () => {
  assert.equal(canOpenExternal('https://tailscale.com/download'), true);
  for (const url of ['https://tailscale.com/download?redirect=elsewhere', 'https://tailscale.com/download#token', 'https://tailscale.com/download/other', 'https://tailscale.com.evil.example/download', 'http://tailscale.com/download', 'https://user@tailscale.com/download', origin]) assert.equal(canOpenExternal(url), false);
});
test('private phone URL admits only an exact HTTPS origin on the dedicated port', () => {
  assert.equal(privatePhoneOrigin(origin), origin); assert.equal(privatePhoneOrigin(origin + '/'), origin);
  for (const url of [origin + '/api/pair', origin + '/?code=1234', origin + '/#secret', origin.replace('https:', 'http:'), origin.replace(':8443', ':443'), origin.replace('.ts.net', '.ts.net.evil.example'), origin.replace('owner.', 'user:password@owner.'), 'file:///tmp/phone', 'javascript:alert(1)', ' ' + origin, origin + '/./', origin + '/%2e', 'https://ts.net:8443']) assert.equal(privatePhoneOrigin(url), undefined, url);
});
test('phone link is revalidated against the current paired service before it opens', async () => {
  const f = fixture();
  assert.equal(await openPhoneExternal(origin + '/', f.context), true);
  assert.deepEqual(f.calls, ['health', 'phone', 'health']); assert.deepEqual(f.opened, [origin]);
  f.state({ ...ready, enabled: false });
  assert.equal(await openPhoneExternal(origin, f.context), false); assert.equal(f.opened.length, 1);
  for (const state of [undefined, { ...ready, route: { state: 'unavailable', origin } }, { ...ready, route: { state: 'ready', origin: 'https://other.example.ts.net:8443' } }]) {
    f.state(state); assert.equal(await openPhoneExternal(origin, f.context), false);
  }
  assert.equal(f.opened.length, 1);
});
test('service replacement, navigation, read failures and malformed links cannot open a stale phone route', async () => {
  for (const health of [{ ...healthy, candidateId: 'b'.repeat(64) }, { ...healthy, status: 'starting' }, undefined]) {
    const f = fixture(); f.health(health); assert.equal(await openPhoneExternal(origin, f.context), false); assert.deepEqual(f.opened, []); assert.deepEqual(f.calls, ['health']);
  }
  const f = fixture();
  f.context.readPhoneState = async () => { f.health({ ...healthy, candidateId: 'b'.repeat(64) }); return ready; };
  assert.equal(await openPhoneExternal(origin, f.context), false); assert.deepEqual(f.opened, []);
  f.health(healthy); f.context.readPhoneState = async () => { f.page(false); return ready; };
  assert.equal(await openPhoneExternal(origin, f.context), false); assert.deepEqual(f.opened, []);
  f.page(true); f.context.readPhoneState = async () => { throw new Error('unavailable'); };
  await assert.rejects(openPhoneExternal(origin, f.context)); assert.deepEqual(f.opened, []);
  const malformed = fixture(); assert.equal(await openPhoneExternal(origin + '/redirect', malformed.context), false); assert.deepEqual(malformed.calls, []);
});
