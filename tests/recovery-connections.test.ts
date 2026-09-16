import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import { WorkspaceRecovery } from '../apps/service/workspace-recovery.js';
import { WorkspaceBackups } from '../apps/service/workspace-backups.js';
import { withRetainedNative } from '../apps/service/retained-native.js';
import { startWorkspaceHost } from '../apps/service/workspace-host.js';
import { decryptBackup } from '../apps/service/backup-crypto.js';
import { summarizeBackup } from '../packages/domain/workspace-backup.js';
import type { ConnectedAccount } from '../packages/domain/accounts.js';
import type { AgentRoutine } from '../packages/domain/agent-routines.js';
import type { QueuedMessage } from '../packages/domain/assistant.js';

const native = (text: string) => { const bytes = Buffer.from(text); return { status: 'included' as const, archive: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), notes: [] }; };
function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'e3-recovery-connect-')), original = new Store(join(root, 'source'));
  const task = original.mutate('owner', { requestId: randomUUID(), epoch: original.epoch, kind: 'task', entityId: 'task:kept', expectedRevision: 0, payload: { title: 'Kept task', notes: 'Keep this writing', status: 'open', planned: '', due: '' } });
  original.mutate('owner', { requestId: randomUUID(), epoch: original.epoch, kind: 'routine', entityId: 'routine:10000000-0000-4000-8000-000000000001', expectedRevision: 0, payload: { title: 'Kept schedule', notes: '', kind: 'task', state: 'active', startsOn: '2099-01-01', timezone: 'UTC', cadence: 'daily', weekdays: [], projectId: null, plannedTime: '', priority: 'normal', estimateMinutes: 0 } });
  original.internalWrite('accounts:item:google:fixture', { id: 'google:fixture', provider: 'google', email: 'fixture@example.test', state: 'connected', generation: randomUUID(), revision: 1, scopes: [], capabilities: {} });
  original.internalWrite('accounts:credential:google:fixture', { preservedCredential: true });
  original.internalWrite('gateway:configuration', { url: 'ws://127.0.0.1:1', token: 'fixture-token', generation: randomUUID() });
  original.internalWrite('runtime:configuration', { port: 1, token: 'fixture-token' });
  original.internalWrite('agent-routines:item:fixture', { id: 'fixture', revision: 1, epoch: original.epoch, value: { enabled: true }, nextAt: 1 });
  original.internalWrite('assistant:queue:fixture', { id: 'fixture', revision: 1, state: 'paused', automatic: true, epoch: original.epoch });
  original.internalWrite('assistant:operation:fixture', { id: 'fixture', state: 'unknown', input: 'Do not repeat me', epoch: original.epoch });
  const archive = native('Original verified native fixture'), snapshot = original.captureBackup('0.73.0', archive);
  const copy = Store.restoreBackup(join(root, 'copy'), snapshot);
  writeFileSync(join(copy.directory, 'assistant.tar.gz'), Buffer.from(archive.archive, 'base64'), { mode: 0o600 });
  t.after(() => { original.close(); copy.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, original, copy, snapshot, task, archive };
}
test('reviewed recovery allows new setup without reconnecting old identities, replaying jobs or losing records', t => {
  const f = fixture(t), recovery = new WorkspaceRecovery(f.copy);
  const command = () => ({ requestId: randomUUID(), epoch: f.copy.epoch, fingerprint: recovery.review().fingerprint, confirmNewConnections: true });
  assert.equal(recovery.review().available, false); assert.throws(() => recovery.resume('reviewer', command()), /Open the recovered/);
  f.copy.activateRecoveredLocal(); const stale = command();
  f.copy.internalWrite('assistant:queue:fixture', { ...f.copy.internalRead<object>('assistant:queue:fixture'), revision: 2 });
  assert.throws(() => recovery.resume('reviewer', stale), /changed/);
  assert(f.copy.recoveryEffectsPaused); assert(f.copy.internalRead('gateway:configuration'));
  const input = command(), result = recovery.resume('reviewer', input); assert(result.fresh);
  assert(!f.copy.recoveryEffectsPaused); assert(recovery.review().completed);
  assert.equal(f.copy.internalRead('gateway:configuration'), undefined); assert.equal(f.copy.internalRead('runtime:configuration'), undefined);
  assert.deepEqual(f.copy.internalRead('recovery:prior:gateway:configuration'), f.original.internalRead('gateway:configuration'));
  assert.equal(f.copy.internalRead<ConnectedAccount>('accounts:item:google:fixture')?.state, 'reconnect');
  assert.deepEqual(f.copy.internalRead('accounts:credential:google:fixture'), f.original.internalRead('accounts:credential:google:fixture'));
  assert.equal(f.copy.readEntity('routine', 'routine:10000000-0000-4000-8000-000000000001')?.value.state, 'paused');
  assert.equal(f.copy.internalRead<AgentRoutine>('agent-routines:item:fixture')?.value.enabled, false);
  assert.equal(f.copy.internalRead<QueuedMessage>('assistant:queue:fixture')?.automatic, false);
  assert.deepEqual(f.copy.internalRead('assistant:operation:fixture'), f.original.internalRead('assistant:operation:fixture'));
  assert.deepEqual(f.copy.readEntity('task', f.task.id), f.task); assert.equal(f.copy.profileProgress().earnedXp, 0);
  const after = f.copy.captureBackup('0.73.0', f.archive);
  assert.equal(recovery.resume('reviewer', input).fresh, false);
  assert.deepEqual(f.copy.captureBackup('0.73.0', f.archive).entities, after.entities);
  assert.throws(() => recovery.resume('reviewer', { ...input, fingerprint: 'a'.repeat(64) }), /different|changed|request/i);
  f.copy.activateRecoveredLocal(); assert(!f.copy.recoveryEffectsPaused, 'Returning to a prepared copy must not silently pause it again.');
  assert.equal(f.original.readEntity('routine', 'routine:10000000-0000-4000-8000-000000000001')?.value.state, 'active');
  assert.equal(f.original.internalRead<ConnectedAccount>('accounts:item:google:fixture')?.state, 'connected');
});

test('new native backups retain earlier archives through encryption and a second separate recovery', async t => {
  const f = fixture(t); f.copy.activateRecoveredLocal();
  const recovery = new WorkspaceRecovery(f.copy); recovery.resume('owner', { requestId: randomUUID(), epoch: f.copy.epoch, fingerprint: recovery.review().fingerprint, confirmNewConnections: true });
  const fresh = native('New Assistant fixture history'), restores: string[] = [];
  const provider = { capture: async () => fresh, restore: async (archive: string) => { restores.push(createHash('sha256').update(readFileSync(archive)).digest('hex')); } };
  const backups = new WorkspaceBackups(f.copy, '0.73.0', provider), input = { requestId: randomUUID(), epoch: f.copy.epoch, passphrase: 'Recovery fixture password' };
  backups.create('owner', input); await backups.close();
  const exported = await backups.download('owner', input.requestId), checked = await decryptBackup(exported.bytes, input.passphrase);
  assert.equal(checked.native.sha256, fresh.sha256); assert.equal(checked.native.retained?.[0].sha256, f.archive.sha256);
  const manager = new WorkspaceBackups(f.copy, '0.73.0', provider);
  async function* bytes() { yield exported.bytes; }
  const upload = await manager.upload('owner', f.copy.epoch, bytes(), () => {});
  const inspect = { requestId: randomUUID(), epoch: f.copy.epoch, passphrase: input.passphrase, uploadId: upload.uploadId };
  manager.inspect('owner', inspect); await manager.close();
  const second = new WorkspaceBackups(f.copy, '0.73.0', provider), restore = { ...inspect, requestId: randomUUID(), reviewId: inspect.requestId };
  second.restore('owner', restore); await second.close();
  const directory = second.recoveredDirectory('owner', restore.requestId), again = new Store(directory);
  try {
    assert.deepEqual(new Set(restores), new Set([fresh.sha256, f.archive.sha256]));
    const carried = await withRetainedNative(again, { status: 'not-configured', notes: [] });
    assert.deepEqual(new Set([carried.sha256, ...(carried.retained ?? []).map(a => a.sha256)]), new Set(restores));
    assert.deepEqual(again.readEntity('task', f.task.id), f.task);
  } finally { again.close(); }
  writeFileSync(join(f.copy.directory, 'assistant.tar.gz'), 'corrupted');
  await assert.rejects(withRetainedNative(f.copy, fresh), /changed|verification/);
});

test('the actual recovery HTTP transition restarts once, retains its receipt and never resumes the source connection', async t => {
  const root = mkdtempSync(join(tmpdir(), 'e3-recovery-http-')), source = new Store(root);
  const snapshot = source.captureBackup('0.73.0', { status: 'not-configured', notes: [] }); source.close();
  const id = randomUUID(), directory = join(root, 'recovered-workspaces', id), copy = Store.restoreBackup(directory, snapshot);
  copy.activateRecoveredLocal(); copy.close();
  writeFileSync(join(directory, 'recovery-complete.json'), JSON.stringify({ jobId: id, sourceHash: 'a'.repeat(64), summary: summarizeBackup(snapshot) }));
  writeFileSync(join(root, 'workspace-selection.json'), JSON.stringify({ format: 1, recoveryId: id }));
  const vault = { provider: 'server-secret' as const, wrap: async (key: Buffer) => Buffer.from(key).reverse(), unwrap: async (key: Buffer) => Buffer.from(key).reverse() };
  let host = await startWorkspaceHost({ directory: root, port: 0, keyProtector: vault });
  t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
  const session = await fetch(host.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1', Connection: 'close' } });
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const call = (path: string, body?: unknown) => fetch(host.origin + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Edition3-Client': '1', 'Content-Type': 'application/json', Connection: 'close' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const review = (await (await call('storage/backups')).json()).recovery;
  const input = { requestId: randomUUID(), epoch: host.current.store.epoch, fingerprint: review.fingerprint, confirmNewConnections: true };
  assert.equal((await call('storage/recovery/resume', { ...input, fingerprint: 'b'.repeat(64) })).status, 409);
  const result = await call('storage/recovery/resume', input); assert.equal(result.status, 202);
  await host.waitForSwitch(); assert(!host.current.store.recoveryEffectsPaused);
  assert.equal(existsSync(join(directory, 'preview.key')), false);
  assert.equal((await call('storage/recovery/resume', input)).status, 202);
  assert(!host.status().switching, 'A replay must not restart the service twice.');
  const origin = host.origin; await host.close(); host = await startWorkspaceHost({ directory: root, port: Number(new URL(origin).port), keyProtector: vault });
  assert(!host.current.store.recoveryEffectsPaused); assert.equal((await call('storage/backups')).status, 200);
  assert.equal((await call('storage/backups/return', { requestId: randomUUID(), epoch: input.epoch })).status, 202); await host.waitForSwitch();
  assert.equal(host.current.store.epoch, snapshot.epoch);
});

test('connection setup and backup preparation exclude each other and shutdown waits for the active check', async t => {
  const f = fixture(t), manager = new WorkspaceBackups(f.copy, '0.73.0');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const check = manager.whileIdle(async () => { await held; return 'verified'; });
  await assert.rejects(manager.whileIdle(async () => {}), /Wait for the current/);
  assert.throws(() => manager.create('owner', { requestId: randomUUID(), epoch: f.copy.epoch, passphrase: 'Fixture backup password' }), /Wait for the current/);
  let closed = false; const closing = manager.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert(!closed);
  release(); assert.equal(await check, 'verified'); await closing; assert(closed);
});
