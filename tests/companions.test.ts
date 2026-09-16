import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createRequire } from 'node:module';
const { CompanionClient } = createRequire(import.meta.url)('../apps/desktop/companion-client.cjs');
import { Store } from '../apps/service/store.js';
import { Companions } from '../apps/service/companions.js';
import { companionLinkData, companionSignedData, type CompanionPacket } from '../packages/domain/companion.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-companion-'));
  let now = 2000000000000, store = new Store(directory), service = new Companions(store, () => now);
  const owner = store.session().deviceId, keys = generateKeyPairSync('ed25519'), deviceId = randomUUID();
  const cmd = () => ({ epoch: store.epoch, requestId: randomUUID() });
  const challenge = service.challenge(owner, cmd());
  const link = { ...cmd(), challengeId: challenge.id, deviceId, name: 'Fixture desktop', platform: 'darwin' as const, publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(), signature: sign(null, Buffer.from(companionLinkData(challenge, deviceId)), keys.privateKey).toString('base64url') };
  const packet = (action: CompanionPacket['action'], payload: Record<string, unknown>) => {
    const value = { protocol: 1 as const, epoch: store.epoch, deviceId, requestId: randomUUID(), issuedAt: ++now, action, payload };
    return { ...value, signature: sign(null, Buffer.from(companionSignedData(value)), keys.privateKey).toString('base64url') };
  };
  const poll = () => service.packet(packet('poll', { enabledUntil: now + 60000, apps: ['Fixture app'] }));
  const enqueue = (authorize = () => {}) => service.enqueue(randomUUID(), 'run-one', { deviceId, tool: 'get_window_state', arguments: { session_id: 'fixture' } }, authorize);
  t.after(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, get service() { return service; }, now: () => now, connection: { deviceId, epoch: store.epoch, privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }, cmd, link, packet, poll, enqueue, owner, deviceId, advance: (ms: number) => { now += ms; }, restart() { service.close(); store.close(); store = new Store(directory); service = new Companions(store, () => now); } };
}

test('link proof binds owner, challenge and key; retries preserve identity and revocation cannot be undone', t => {
  const f = fixture(t);
  assert.throws(() => f.service.link('another-owner', f.link));
  assert.throws(() => f.service.link(f.owner, { ...f.link, deviceId: randomUUID() }));
  const linked = f.service.link(f.owner, f.link);
  assert.deepEqual(f.service.link(f.owner, f.link), linked);
  assert.equal(f.service.devices()[0].connected, false);
  assert.doesNotMatch(JSON.stringify(f.service.devices()), /publicKey|PRIVATE|nonce/);
  f.service.revoke(f.owner, { ...f.cmd(), deviceId: f.deviceId });
  assert.throws(() => f.service.link(f.owner, f.link));
  assert.throws(() => f.poll());
});

test('desktop proof rejects changes, expired requests and replay after a newer packet', t => {
  const f = fixture(t); f.service.link(f.owner, f.link);
  const p = f.packet('poll', { enabledUntil: 2000000060000, apps: ['Fixture'] });
  assert.throws(() => f.service.packet({ ...p, payload: { enabledUntil: 2000000060000, apps: ['Different'] } }));
  const result = f.service.packet(p); assert.deepEqual(f.service.packet(p), result);
  f.poll(); assert.throws(() => f.service.packet(p));
  const expired = f.packet('poll', { enabledUntil: 0, apps: [] }); f.advance(61000);
  assert.throws(() => f.service.packet(expired));
});

test('computer operations require online local enablement and current authorization, and bind results to their run', t => {
  const f = fixture(t); f.service.link(f.owner, f.link);
  assert.throws(() => f.enqueue(), /Open the desktop/); f.poll();
  assert.throws(() => f.enqueue(() => { throw new Error('Read only'); }), /Read only/);
  const op = f.enqueue(); assert.equal(op.state, 'queued');
  assert.throws(() => f.service.result(op.id, 'another-run'));
  assert.throws(() => f.enqueue(), /current action/);
  const claim = f.packet('claim', { id: op.id });
  assert.equal((f.service.packet(claim) as any).claimed, true);
  assert.equal((f.service.packet(claim) as any).claimed, true);
  assert.throws(() => f.service.packet(f.packet('claim', { id: op.id })), /no longer/);
  f.service.packet(f.packet('result', { id: op.id, state: 'completed', result: { content: [{ type: 'text', text: 'Fixture result' }] } }));
  assert.equal(f.service.result(op.id, 'run-one').state, 'completed');
  assert.throws(() => f.service.packet(f.packet('result', { id: op.id, state: 'completed', result: { changed: true } })), /original computer result/);
});

test('restart, disconnect and cancellation never silently rerun an uncertain action', t => {
  const f = fixture(t); f.service.link(f.owner, f.link); f.poll();
  const first = f.enqueue(); f.service.packet(f.packet('claim', { id: first.id }));
  f.restart(); assert.equal(f.service.result(first.id, 'run-one').state, 'unknown');
  assert.equal((f.poll() as any).operation, null);
  f.service.packet(f.packet('result', { id: first.id, state: 'completed', result: { observed: true } }));
  let allowed = true;
  const next = f.enqueue(() => { if (!allowed) throw new Error('Stopped'); }); allowed = false;
  assert.equal((f.poll() as any).operation, null);
  assert.equal(f.service.result(next.id, 'run-one').state, 'cancelled');
  const last = f.enqueue(); f.service.packet(f.packet('disconnect', {}));
  assert.equal(f.service.result(last.id, 'run-one').state, 'cancelled');
  assert.throws(() => f.enqueue(), /Open the desktop/);
});

test('desktop keys do not become browser sessions and duration/challenge limits remain enforced', t => {
  const f = fixture(t); f.service.link(f.owner, f.link);
  assert.throws(() => f.store.authenticate(f.deviceId));
  const p = f.packet('poll', { enabledUntil: 2000007200000, apps: [] });
  assert.throws(() => f.service.packet(p), /one hour/);
  f.advance(6 * 60000); const stale = fixture(t); stale.advance(6 * 60000);
  assert.throws(() => stale.service.link(stale.owner, stale.link));
});

test('persistent desktop access survives elapsed time but never bypasses heartbeat, stop, revocation or per-action deadlines', t => {
  const f=fixture(t);f.service.link(f.owner,f.link);
  const poll=()=>f.service.packet(f.packet('poll',{enabledUntil:null,scope:'desktop',apps:[]}));
  poll();assert.equal(f.service.devices()[0].scope,'desktop');
  f.advance(30*24*60*60000);assert.throws(()=>f.enqueue(),/Open the desktop/);
  poll();const op=f.enqueue();assert.equal(op.expiresAt,f.now()+120000);
  f.advance(120001);assert.equal(f.service.result(op.id,'run-one').state,'cancelled');
  poll();const next=f.enqueue();f.service.packet(f.packet('poll',{enabledUntil:0,scope:'desktop',apps:[]}));
  assert.equal(f.service.result(next.id,'run-one').state,'cancelled');assert.throws(()=>f.enqueue());
  poll();f.service.revoke(f.owner,{...f.cmd(),deviceId:f.deviceId});assert.throws(poll);
  assert.equal(f.service.devices()[0].enabledUntil,0);
});

test('the desktop client executes a reviewed persistent-access operation once and respects local Stop', async t=>{
  const f=fixture(t);f.service.link(f.owner,f.link);
  f.service.packet(f.packet('poll',{enabledUntil:null,scope:'desktop',apps:[]}));
  const op=f.enqueue();f.advance(2);let receipt:any,effects=0,until:number|null=null;
  const client=new CompanionClient({connection:f.connection,now:f.now,request:async(p:CompanionPacket)=>{f.advance(1);return f.service.packet(p);},readReceipt:()=>receipt,saveReceipt:(r:unknown)=>receipt=r,status:()=>({enabledUntil:until,scope:'desktop',apps:[]}),execute:async()=>{effects++;return {content:[]};}});
  await client.tick();assert.equal(effects,1);assert.equal(f.service.result(op.id,'run-one').state,'completed');
  f.enqueue();until=0;await client.tick();assert.equal(effects,1);assert.throws(()=>f.enqueue());
});

for (const point of ['before-claim', 'after-claim', 'after-result'] as const) test(`desktop interrupted ${point} never repeats a native effect`, async t => {
  const f = fixture(t); f.service.link(f.owner, f.link); f.poll(); const op = f.enqueue(); f.advance(2);
  let receipt: any, effects = 0, lose = true;
  const request = async (packet: CompanionPacket) => {
    f.advance(1);
    if (lose && point === 'before-claim' && packet.action === 'claim') { lose = false; throw new Error('Disconnected'); }
    const result = f.service.packet(packet);
    if (lose && (point === 'after-claim' && packet.action === 'claim' || point === 'after-result' && packet.action === 'result')) { lose = false; throw new Error('Lost reply'); }
    return result;
  };
  const options = { connection: f.connection, now: f.now, request, readReceipt: () => receipt, saveReceipt: (next: unknown) => { receipt = next; }, status: () => ({ enabledUntil: f.now() + 60000, apps: ['Fixture'] }), execute: async () => { effects++; return { content: [{ type: 'text', text: 'Observed fixture effect' }] }; } };
  await assert.rejects(new CompanionClient(options).tick());
  f.advance(10); await new CompanionClient(options).tick();
  assert.equal(effects, point === 'after-result' ? 1 : 0);
  assert.equal(f.service.result(op.id, 'run-one').state, point === 'after-result' ? 'completed' : point === 'before-claim' ? 'cancelled' : 'unknown');
  assert.equal(receipt, null);
});

test('restoring a backup does not restore a linked computer’s authority', t => {
  const f = fixture(t); f.service.link(f.owner, f.link); f.poll();
  const directory = mkdtempSync(join(tmpdir(), 'nova-companion-restore-')), target = join(directory, 'restored');
  const restored = Store.restoreBackup(target, f.store.captureBackup('test', { status: 'not-configured', notes: [] }));
  const service = new Companions(restored, f.now);
  try { assert.notEqual(restored.epoch, f.store.epoch); assert.equal(service.devices().length, 0); assert.throws(() => service.packet(f.packet('poll', { enabledUntil: 0, apps: [] }))); }
  finally { service.close(); restored.close(); rmSync(directory, { recursive: true, force: true }); }
});
