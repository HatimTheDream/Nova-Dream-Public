import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonical } from '../packages/domain/contracts';
import { phonePairSchema } from '../packages/domain/phone';
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


function rejectedPair(run: () => unknown) {
  try { run(); assert.fail('Expected a terminal rejection'); } catch (error: any) {
    assert.equal(error.code, 'phone_pair_rejected'); return error.current;
  }
}
test('a rejected pairing has an exact durable fence, including if a later challenge has the same digits', t => {
  const f = fixture(t); f.access.setEnabled('owner', cmd(f.store), true);
  const input = { requestId: randomUUID(), code: '1234-5678', name: 'Original', expiresAt: 1300000 };
  const proof = rejectedPair(() => f.access.pair(input));
  assert.equal(proof.sha256, createHash('sha256').update(canonical(phonePairSchema.parse(input))).digest('hex'));
  assert.equal(proof.reason, 'code_unavailable');
  f.store.internalWrite('phone:challenge', { epoch: f.store.epoch, codeDigest: createHash('sha256').update('12345678').digest('hex'), expiresAt: 1300000 });
  f.restart(); assert.deepEqual(rejectedPair(() => f.access.pair(input)), proof); assert.equal(f.access.devices().length, 0);
  assert.throws(() => f.access.pair({ ...input, name: 'Changed' }), /different details/);
});
test('expired finite fences may be pruned because the original deadline independently prevents late admission', t => {
  const f = fixture(t); f.access.setEnabled('owner', cmd(f.store), true);
  const input = { requestId: randomUUID(), code: '12345678', name: 'Original', expiresAt: 1300000 };
  rejectedPair(() => f.access.pair(input)); f.advance(300001);
  rejectedPair(() => f.access.pair({ ...input, requestId: randomUUID(), expiresAt: 1600000 }));
  assert.equal(f.store.internalRead('phone:pair-rejection:' + input.requestId), undefined);
  f.store.internalWrite('phone:challenge', { epoch: f.store.epoch, codeDigest: createHash('sha256').update(input.code).digest('hex'), expiresAt: 1600000 });
  assert.equal(rejectedPair(() => f.access.pair(input)).reason, 'request_expired'); assert.equal(f.access.devices().length, 0);
});
test('a confirmed original receipt remains recoverable after its new-admission deadline', t => {
  const f = fixture(t); f.access.setEnabled('owner', cmd(f.store), true);
  const input = { requestId: randomUUID(), code: f.access.startPairing('owner', cmd(f.store)).code, name: 'Phone', expiresAt: 1300000 };
  const original = f.access.pair(input); f.advance(300001); f.restart();
  assert.deepEqual(f.access.pair(input), original); assert.equal(f.access.devices().length, 1);
  f.access.revoke('owner', { ...cmd(f.store), deviceId: original.deviceId });
  assert.equal(rejectedPair(() => f.access.pair(input)).reason, 'session_revoked');
});
test('pairing access reason distinguishes a known expired or revoked cookie without granting access', t => {
  const f = fixture(t); assert.equal(f.access.pairingReason(''), 'disabled'); f.access.setEnabled('owner', cmd(f.store), true);
  assert.equal(f.access.pairingReason('unknown'), 'required');
  const original = f.access.pair({ requestId: randomUUID(), code: f.access.startPairing('owner', cmd(f.store)).code, name: 'Phone' });
  assert.equal(f.access.pairingReason(original.token), undefined); f.advance(30 * 86400000);
  assert.equal(f.access.pairingReason(original.token), 'expired'); assert.throws(() => f.access.authenticate(original.token));
  f.access.revoke('owner', { ...cmd(f.store), deviceId: original.deviceId });
  assert.equal(f.access.pairingReason(original.token), 'revoked'); assert.throws(() => f.access.authenticate(original.token));
});
test('legacy pairing rejection stays fenced permanently and excessive future deadlines never become later admission', t => {
  const f = fixture(t); f.access.setEnabled('owner', cmd(f.store), true);
  const legacy = { requestId: randomUUID(), code: '12345678', name: 'Legacy' };
  const proof = rejectedPair(() => f.access.pair(legacy)); f.advance(600001); f.restart();
  assert.deepEqual(rejectedPair(() => f.access.pair(legacy)), proof);
  const future = { ...legacy, requestId: randomUUID(), expiresAt: 9999999999999 };
  assert.equal(rejectedPair(() => f.access.pair(future)).reason, 'clock_mismatch');
  assert.equal(f.access.devices().length, 0);
});

test('permanent pairing fences have a finite cap without removing originals or blocking finite new requests', t => {
  const f = fixture(t); f.access.setEnabled('owner', cmd(f.store), true);
  for (let i = 0; i < 512; i++) f.store.internalWrite('phone:pair-rejection:fixture-' + i, { requestId: 'fixture-' + i });
  assert.throws(() => f.access.pair({ requestId: randomUUID(), code: '12345678', name: 'Legacy' }), /earlier pairing requests are kept/);
  assert.equal(f.store.internalList('phone:pair-rejection:').length, 512);
  const finite = { requestId: randomUUID(), code: '12345678', name: 'Finite', expiresAt: 1300000 };
  assert.equal(rejectedPair(() => f.access.pair(finite)).reason, 'code_unavailable');
  assert.equal(f.store.internalList('phone:pair-rejection:').length, 513);
});
