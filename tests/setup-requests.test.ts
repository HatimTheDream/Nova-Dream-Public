import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { SetupRequests } from '../apps/service/setup-requests.js';
import { canonical } from '../packages/domain/contracts.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';
import type { SetupRequestReference } from '../packages/domain/setup-request.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-setup-requests-'));
  const store = new Store(directory), service = new SetupRequests(store), device = store.session().deviceId;
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, service, device };
}
const reference = (input: { requestId: string; epoch: string }, kind: SetupRequestReference['kind'] = 'runtime-start'): SetupRequestReference =>
  ({ requestId: input.requestId, epoch: input.epoch, kind, sha256: createHash('sha256').update(canonical(input)).digest('hex') });
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
test('setup admits one original effect, keeps working distinct from readiness and replays only its receipt', async t => {
  const f = fixture(t), input = { requestId: randomUUID(), epoch: f.store.epoch };
  let effects = 0, finish!: (value: { applied: boolean }) => void;
  const effect = async () => { effects++; return new Promise<{ applied: boolean }>(resolve => { finish = resolve; }); };
  const first = f.service.start(f.device, 'runtime-start', input, effect);
  assert.equal(first.state, 'working'); assert.equal(f.service.updateMaintenanceBusy, 1);
  assert.deepEqual(f.service.start(f.device, 'runtime-start', input, effect), first);
  await settle(); assert.equal(effects, 1);
  assert.throws(() => f.service.start(f.device, 'runtime-start', { ...input, requestId: randomUUID() }, effect), /original host setup/);
  assert.equal(f.service.read(f.device, reference(input)).state, 'working');
  assert.throws(() => f.service.closeRequest(f.device, { requestId: randomUUID(), epoch: input.epoch, original: reference(input), revision: 1 }), /still running/);
  finish({ applied: true }); await settle();
  assert.equal(f.service.read(f.device, reference(input)).state, 'applied'); assert.equal(f.service.updateMaintenanceBusy, 0);
  assert.equal(f.service.start(f.device, 'runtime-start', input, effect).state, 'applied'); assert.equal(effects, 1);
});
test('missing GET is not admission proof; closing fences a delayed original POST forever', async t => {
  const f = fixture(t), input = { requestId: randomUUID(), epoch: f.store.epoch }, ref = reference(input);
  assert.equal(f.service.read(f.device, ref).state, 'not-found');
  const command = { requestId: randomUUID(), epoch: input.epoch, original: ref, revision: 0 };
  const closed = f.service.closeRequest(f.device, command);
  assert.equal(closed.state, 'closed'); assert.equal(closed.closedFrom, 'not-found');
  assert.deepEqual(f.service.closeRequest(f.device, command), closed);
  let calls = 0;
  assert.deepEqual(f.service.start(f.device, 'runtime-start', input, async () => { calls++; return { applied: true }; }), closed);
  await settle(); assert.equal(calls, 0);
});
test('changed digest, kind, epoch or device cannot read, close or replace the original request', async t => {
  const f = fixture(t), input = { requestId: randomUUID(), epoch: f.store.epoch, url: 'wss://fixture.invalid', token: 'fixture-secret-keep-private' };
  f.service.start(f.device, 'gateway-connect', input, async () => ({ applied: true })); await settle();
  const ref = reference(input, 'gateway-connect'), before = f.service.read(f.device, ref);
  for (const changed of [{ ...ref, kind: 'runtime-start' }, { ...ref, sha256: 'a'.repeat(64) }, { ...ref, epoch: randomUUID() }])
    assert.throws(() => f.service.read(f.device, changed));
  assert.throws(() => f.service.read('other-device', ref));
  assert.throws(() => f.service.start(f.device, 'gateway-connect', { ...input, token: 'different-secret' }, async () => assert.fail('No changed effect')));
  assert.deepEqual(f.service.read(f.device, ref), before);
  assert.doesNotMatch(JSON.stringify(before), /ownerId|ownerPid|fixture-secret|token|fixture.invalid/);
  assert.equal(readFileSync(join(f.directory, 'workspace.sqlite')).includes('fixture-secret-keep-private'), false);
});
test('lost final write becomes unknown and explicit review cannot close a still-present original owner', async t => {
  const f = fixture(t), input = { requestId: randomUUID(), epoch: f.store.epoch }, ref = reference(input);
  const write = f.store.internalWrite.bind(f.store);
  let refuseFinish = true, effects = 0;
  t.mock.method(f.store, 'internalWrite', (id: string, value: any) => {
    if (refuseFinish && id === `assistant:setup-request:${input.requestId}` && value.revision > 1) throw Error('Synthetic final-write refusal');
    return write(id, value);
  });
  f.service.start(f.device, 'runtime-start', input, async () => { effects++; return { applied: true }; }); await settle();
  assert.equal(f.service.read(f.device, ref).state, 'unknown');
  const liveReplacement = new SetupRequests(f.store, () => true);
  const close = { requestId: randomUUID(), epoch: input.epoch, original: ref, revision: 1 };
  assert.throws(() => liveReplacement.closeRequest(f.device, close), /owner is still present/);
  refuseFinish = false;
  const restarted = new SetupRequests(f.store, () => false);
  assert.equal(restarted.read(f.device, ref).state, 'unknown'); assert.equal(effects, 1);
  const result = restarted.closeRequest(f.device, close);
  assert.equal(result.reviewedUnknown, true); assert.equal(result.closedFrom, 'working'); assert.equal(result.state, 'closed');
  assert.equal(restarted.start(f.device, 'runtime-start', input, async () => assert.fail('Never redispatch')).state, 'closed');
  await liveReplacement.close(); await restarted.close();
});
test('effect failure is a retained outcome and never leaks credentials or repeats itself', async t => {
  const f = fixture(t), input = { requestId: randomUUID(), epoch: f.store.epoch };
  let calls = 0;
  f.service.start(f.device, 'runtime-start', input, async () => { calls++; throw Error('secret-output'); }); await settle();
  const view = f.service.read(f.device, reference(input)); assert.equal(view.state, 'failed'); assert.doesNotMatch(view.message, /secret/);
  assert.equal(f.service.start(f.device, 'runtime-start', input, async () => assert.fail()).state, 'failed'); assert.equal(calls, 1);
});
test('setup closes admission during shutdown and waits for its existing worker without interrupting it', async t => {
  const f = fixture(t), input = { requestId: randomUUID(), epoch: f.store.epoch };
  let finish!: (value: { applied: boolean }) => void, closed = false;
  f.service.start(f.device, 'runtime-start', input, async () => new Promise(resolve => { finish = resolve; })); await settle();
  const closing = f.service.close().then(() => { closed = true; }); await settle(); assert.equal(closed, false);
  assert.throws(() => f.service.start(f.device, 'runtime-start', { ...input, requestId: randomUUID() }, async () => assert.fail()), /closing/);
  finish({ applied: true }); await closing; assert.equal(closed, true); assert.equal(f.service.read(f.device, reference(input)).state, 'applied');
});
test('maintenance and recovery gates reject setup before effect; paired phones gain no setup routes', async t => {
  const f = fixture(t), input = { requestId: randomUUID(), epoch: f.store.epoch };
  f.store.setUpdateMaintenanceHeld(true);
  assert.throws(() => f.service.start(f.device, 'runtime-start', input, async () => assert.fail()), /update/i);
  f.store.setUpdateMaintenanceHeld(false); f.store.internalWrite('recovery:state', { held: true });
  assert.throws(() => f.service.start(f.device, 'runtime-start', input, async () => assert.fail()), /recovery/i);
  for (const [path, method] of [['/api/assistant/setup-request', 'GET'], ['/api/assistant/setup-request/close', 'POST'], ['/api/assistant/runtime/start', 'POST']])
    assert.equal(phoneRouteAllowed(path, method), false);
});
