import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { canonical } from '../packages/domain/contracts';
import { phonePairSchema } from '../packages/domain/phone';
import { PairingJournal, PhoneCommandJournal, phoneResultValid } from '../apps/client/src/phone-request-journal';
const epoch = randomUUID(), deviceId = randomUUID();
const input = { requestId: randomUUID(), code: '12345678', name: 'Original Phone', expiresAt: 3000000 };
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function storage() {
  const values = new Map<string, string>(); let full = false, noReadback = false, writes = 0;
  const port = { getItem: (key: string) => { if (noReadback && writes) throw Error('Readback'); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (full) throw Error('Full'); values.set(key, value); writes++; } };
  return { values, port, full: (value: boolean) => { full = value; }, noReadback: (value: boolean) => { noReadback = value; } };
}
test('pairing keeps exact normalized original across reload and does not replace unknown fields', () => {
  const f = storage(), journal = new PairingJournal(f.port);
  assert.equal(journal.begin(input, digest(input)), true);
  const restored = new PairingJournal(f.port);
  assert.deepEqual(restored.current?.request, input);
  assert.equal(restored.begin({ ...input, code: '87654321' }, digest(input)), false);
  assert.equal(restored.reviewNewCode(), false);
  assert.equal(restored.settle(input, digest(input), { deviceId, apiVersion: 1 }), true);
  assert.equal(restored.current?.state, 'confirmed'); assert.equal(restored.begin(input, digest(input)), false);
});
test('a full store or failed readback keeps the complete original in memory and preserves legacy raw bytes', () => {
  const f = storage(), legacy = JSON.stringify({ requestId: input.requestId, name: input.name, code: '1234-5678' });
  f.values.set('e3:phone-pair', legacy);
  const journal = new PairingJournal(f.port), original = phonePairSchema.parse(JSON.parse(legacy));
  f.full(true); assert.equal(journal.begin(original, digest(original)), false); assert.deepEqual(journal.current?.request, original);
  f.full(false); f.noReadback(true); assert.equal(journal.begin(original, digest(original)), false);
  f.noReadback(false); assert.equal(journal.retryRetention(), true);
  assert.equal(f.values.get('e3:phone-pair'), legacy);
});
test('new pairing review requires exact terminal proof and archives the entire original before clearing it', () => {
  const f = storage(), journal = new PairingJournal(f.port), sha256 = digest(input);
  journal.begin(input, sha256);
  const proof = { format: 1, requestId: input.requestId, sha256, state: 'rejected', reason: 'code_unavailable' };
  assert.equal(journal.settle(input, sha256, { ...proof, sha256: 'b'.repeat(64) }, true), false);
  assert.equal(journal.settle(input, sha256, { ...proof, requestId: randomUUID() }, true), false);
  assert.equal(journal.current?.state, 'pending');
  assert.equal(journal.settle(input, sha256, proof, true), true);
  f.full(true); assert.equal(journal.reviewNewCode(), false); assert.deepEqual(journal.current?.request, input);
  f.full(false); assert.equal(journal.reviewNewCode(), true); assert.equal(journal.current, undefined);
  const restored = new PairingJournal(f.port);
  assert.deepEqual(restored.value.history[0].request, input); assert.deepEqual(restored.value.history[0].proof, proof);
});
test('late acknowledgement cannot replace newer attempt and unverified result cannot mark paired', () => {
  const f = storage(), journal = new PairingJournal(f.port), hash = digest(input);
  journal.begin(input, hash); assert.equal(journal.settle(input, hash, { apiVersion: 1 }), false);
  journal.settle(input, hash, { deviceId, apiVersion: 1 }); journal.reviewNewCode();
  const next = { ...input, requestId: randomUUID() }; journal.begin(next, digest(next));
  assert.equal(journal.settle(input, hash, { deviceId, apiVersion: 1 }), false);
  assert.equal(journal.current?.request.requestId, next.requestId);
});
test('unreadable and foreign pairing storage remains unchanged; competing journals cannot overwrite each other', () => {
  const f = storage(); f.values.set('e3:phone-pair:v2', '{broken');
  const invalid = new PairingJournal(f.port); assert.equal(invalid.begin(input, digest(input)), false); assert.equal(f.values.get(invalid.key), '{broken');
  const other = storage(), one = new PairingJournal(other.port), two = new PairingJournal(other.port);
  one.begin(input, digest(input));
  assert.equal(two.begin({ ...input, requestId: randomUUID() }, digest(input)), false);
  assert.equal(new PairingJournal(other.port).current?.request.requestId, input.requestId);
});
test('failed acknowledgement storage keeps known success in this window and blocks repeating pairing', () => {
  const f = storage(), journal = new PairingJournal(f.port); journal.begin(input, digest(input)); f.full(true);
  assert.equal(journal.settle(input, digest(input), { deviceId, apiVersion: 1 }), false);
  assert.equal(journal.current?.state, 'confirmed'); assert.equal(journal.begin(input, digest(input)), false);
  f.full(false); assert.equal(journal.retryRetention(), true); assert.equal(new PairingJournal(f.port).current?.state, 'confirmed');
});
test('owner phone requests adopt only their exact legacy epoch and preserve source bytes', () => {
  const f = storage(), command = { path: 'phone/revoke' as const, body: { requestId: randomUUID(), epoch, deviceId } };
  const raw = canonical(command); f.values.set(`e3:phone-command:${deviceId}`, raw);
  const journal = new PhoneCommandJournal(f.port, epoch, deviceId); assert.deepEqual(journal.pending, command);
  assert.equal(journal.keep(command), true); assert.equal(f.values.get(`e3:phone-command:${deviceId}`), raw);
  const other = new PhoneCommandJournal(f.port, randomUUID(), deviceId); assert.equal(other.pending, undefined);
  assert.equal(journal.keep({ ...command, body: { ...command.body, requestId: randomUUID() } }), false);
  assert.equal(journal.keep({ ...command, confirmed: true }), true); assert.equal(journal.pending, undefined);
});
test('owner request readback and exact-current checks protect unknown commands and reject untrusted paths', () => {
  const f = storage(), journal = new PhoneCommandJournal(f.port, epoch, deviceId);
  const command = { path: 'phone/enable' as const, body: { requestId: randomUUID(), epoch } };
  f.noReadback(true); assert.equal(journal.keep(command), false); f.noReadback(false); assert.equal(journal.keep(command), true);
  const before = f.values.get(journal.key); f.values.set(journal.key, '{changed');
  assert.equal(journal.keep({ ...command, confirmed: true }), false); assert.equal(f.values.get(journal.key), '{changed');
  f.values.set(journal.key, before!); assert.equal(new PhoneCommandJournal(f.port, epoch, deviceId).keep({ ...command, path: 'https://elsewhere.invalid' as never }), false);
});
test('phone command acknowledgements must match the expected result shape', () => {
  assert.equal(phoneResultValid('phone/revoke', { revoked: true }), true);
  assert.equal(phoneResultValid('phone/pairing', { code: '1234-5678', expiresAt: 123 }), true);
  assert.equal(phoneResultValid('phone/enable', { enabled: true, route: { state: 'ready', message: 'Ready' }, devices: [] }), true);
  assert.equal(phoneResultValid('phone/revoke', {}), false);
  assert.equal(phoneResultValid('phone/pairing', { code: 'wrong' }), false);
});

test('full pairing history preserves all attempts instead of evicting the oldest to unlock another code', () => {
  const f = storage(), journal = new PairingJournal(f.port);
  for (let n = 0; n < 17; n++) {
    const attempt = { ...input, requestId: randomUUID() };
    assert.equal(journal.begin(attempt, digest(attempt)), true);
    assert.equal(journal.settle(attempt, digest(attempt), { deviceId, apiVersion: 1 }), true);
    if (n < 16) assert.equal(journal.reviewNewCode(), true);
  }
  const before = f.values.get(journal.key);
  assert.equal(journal.reviewNewCode(), false); assert.equal(journal.value.history.length, 16);
  assert.equal(f.values.get(journal.key), before); assert.equal(journal.current?.state, 'confirmed');
});
