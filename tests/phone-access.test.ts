import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import { PhoneAccess } from '../apps/service/phone-access.js';

const cmd = (store: Store) => ({ requestId: randomUUID(), epoch: store.epoch });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-phone-'));
  let now = 1000000, store = new Store(directory), access = new PhoneAccess(store, () => now);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, get access() { return access; }, advance(ms: number) { now += ms; }, restart() { store.close(); store = new Store(directory); access = new PhoneAccess(store, () => now); } };
}

test('phone pairing is one-use, exact-retry safe across restart, and never accepts desktop cookies', t => {
  const f = fixture(t);
  assert.throws(() => f.access.startPairing('owner', cmd(f.store)), /Enable private phone/);
  f.access.setEnabled('owner', cmd(f.store), true);
  const request = cmd(f.store), challenge = f.access.startPairing('owner', request);
  assert.deepEqual(f.access.startPairing('owner', request), challenge);
  const pairing = { requestId: randomUUID(), code: challenge.code, name: 'My phone' };
  const result = f.access.pair(pairing);
  assert.equal(f.access.authenticate(result.token), result.deviceId);
  assert.throws(() => f.access.authenticate(f.store.session().token!), /Pair this phone/);
  assert.throws(() => f.store.authenticate(result.token), /Reconnect this browser/);
  f.restart(); assert.deepEqual(f.access.pair(pairing), result);
  assert.throws(() => f.access.pair({ ...pairing, name: 'Another device' }), /different details/);
  assert.throws(() => f.access.pair({ ...pairing, requestId: randomUUID() }), /Pair this phone/);
  assert.equal(f.access.devices().length, 1);
  assert.doesNotMatch(JSON.stringify(f.access.devices()), /token|Digest|epoch/);
  const database = readFileSync(join(f.directory, 'workspace.sqlite'));
  assert.equal(database.includes(result.token), false); assert.equal(database.includes(challenge.code), false);
});

test('revocation blocks future requests and lost pairing responses cannot resurrect the device', t => {
  const f = fixture(t); f.access.setEnabled('owner', cmd(f.store), true);
  const first = { requestId: randomUUID(), code: f.access.startPairing('owner', cmd(f.store)).code, name: 'First' };
  const a = f.access.pair(first), b = f.access.pair({ requestId: randomUUID(), code: f.access.startPairing('owner', cmd(f.store)).code, name: 'Second' });
  const revoke = { ...cmd(f.store), deviceId: a.deviceId };
  f.access.revoke('owner', revoke); f.restart(); f.access.revoke('owner', revoke);
  assert.throws(() => f.access.authenticate(a.token), /Pair this phone/);
  assert.throws(() => f.access.pair(first), /Pair this phone/);
  assert.equal(f.access.authenticate(b.token), b.deviceId);
  f.access.setEnabled('owner', cmd(f.store), false);
  assert.throws(() => f.access.authenticate(b.token), /Pair this phone/);
  f.access.setEnabled('owner', cmd(f.store), true);
  assert.throws(() => f.access.authenticate(b.token), /Pair this phone/);
});

test('pairing expiry and persisted attempt limits survive restart, including malformed submissions', t => {
  const f = fixture(t); f.access.setEnabled('owner', cmd(f.store), true);
  const challenge = f.access.startPairing('owner', cmd(f.store));
  f.advance(5 * 60000);
  assert.throws(() => f.access.pair({ requestId: randomUUID(), code: challenge.code, name: 'Phone' }), /Pair this phone/);
  const next = f.access.startPairing('owner', cmd(f.store));
  for (let n = 0; n < 7; n++) assert.throws(() => f.access.pair({ code: '' }), /Pair this phone/);
  f.restart(); assert.throws(() => f.access.pair({ requestId: randomUUID(), code: next.code, name: 'Phone' }), /Too many/);
  f.advance(5 * 60000 + 1);
  const result = f.access.pair({ requestId: randomUUID(), code: f.access.startPairing('owner', cmd(f.store)).code, name: 'Phone' });
  f.advance(30 * 86400000); assert.throws(() => f.access.authenticate(result.token), /Pair this phone/);
});

test('new code invalidates the older challenge and pairing cannot exceed twelve active devices', t => {
  const f = fixture(t); f.access.setEnabled('owner', cmd(f.store), true);
  const old = f.access.startPairing('owner', cmd(f.store));
  f.access.startPairing('owner', cmd(f.store));
  assert.throws(() => f.access.pair({ requestId: randomUUID(), code: old.code, name: 'Older' }), /Pair this phone/);
  for (let n = 0; n < 12; n++) {
    f.advance(5 * 60000 + 1);
    f.access.pair({ requestId: randomUUID(), code: f.access.startPairing('owner', cmd(f.store)).code, name: `Device ${n}` });
  }
  assert.throws(() => f.access.startPairing('owner', cmd(f.store)), /Remove a paired device/);
  f.access.revoke('owner', { ...cmd(f.store), deviceId: f.access.devices()[0].id });
  assert.ok(f.access.startPairing('owner', cmd(f.store)).code);
});

test('a fresh owner code re-pairs the same browser identity while rotating and fencing old credentials', t => {
  const f = fixture(t); f.access.setEnabled('owner', cmd(f.store), true);
  const input = { requestId: randomUUID(), code: f.access.startPairing('owner', cmd(f.store)).code, name: 'Phone' };
  const first = f.access.pair(input);
  f.access.revoke('owner', { ...cmd(f.store), deviceId: first.deviceId });
  assert.throws(() => f.access.pair(input, first.token), /Pair this phone/);
  const fresh = { requestId: randomUUID(), code: f.access.startPairing('owner', cmd(f.store)).code, name: 'My reconnected phone' };
  const second = f.access.pair(fresh, first.token);
  assert.equal(second.deviceId, first.deviceId); assert.notEqual(second.token, first.token);
  assert.throws(() => f.access.authenticate(first.token), /Pair this phone/);
  assert.throws(() => f.access.pair(input, second.token), /Pair this phone/);
  assert.equal(f.access.authenticate(second.token), first.deviceId); assert.equal(f.access.devices().length, 1);
  f.restart(); assert.deepEqual(f.access.pair(fresh, second.token), second);
});
