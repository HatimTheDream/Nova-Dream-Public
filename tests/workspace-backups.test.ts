import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store';
import { encryptBackup, decryptBackup } from '../apps/service/backup-crypto';
import { WorkspaceBackups } from '../apps/service/workspace-backups';
import { startServer } from '../apps/service/http';
import { startWorkspaceHost } from '../apps/service/workspace-host';
import { summarizeBackup } from '../packages/domain/workspace-backup';
const password = 'A separate backup password 2026';
function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'e3-backup-')), store = new Store(join(root, 'source'));
  const command = { requestId: randomUUID(), epoch: store.epoch, kind: 'task' as const, entityId: 'task:backup-proof', expectedRevision: 0, payload: { title: 'Private recovery proof', notes: 'Keep this exact writing', status: 'done' as const, planned: '', due: '' } };
  const task = store.mutate('owner', command);
  store.internalWrite('private:future-record', { unknownField: ['preserve', 42], secret: 'private-credential-fixture' });
  const file = store.upload('owner', randomUUID(), store.epoch, 'proof.txt', Buffer.from('Exact attachment bytes\n').toString('base64'));
  const native = { status: 'not-configured' as const, notes: ['No managed Assistant.'] };
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, task, command, file, snapshot: () => store.captureBackup('0.62.0', native) };
}
test('encrypted backup reopens every saved row and file without exposing plaintext or a workspace key', async t => {
  const f = fixture(t), snapshot = f.snapshot(), bytes = await encryptBackup(snapshot, password);
  assert(!bytes.includes(Buffer.from('Private recovery proof'))); assert(!bytes.includes(Buffer.from('private-credential-fixture'))); assert(!bytes.includes(readFileSync(join(f.store.directory, 'preview.key'))));
  assert.deepEqual(await decryptBackup(bytes, password), snapshot);
  assert.notDeepEqual(bytes, await encryptBackup(snapshot, password));
});
test('wrong passwords, tampered headers/ciphertext and unsupported archives fail closed', async t => {
  const f = fixture(t), bytes = await encryptBackup(f.snapshot(), password);
  await assert.rejects(decryptBackup(bytes, 'Wrong password for this archive'), /password|damaged/);
  for (const index of [0, 20, 52, bytes.length - 1]) { const changed = Buffer.from(bytes); changed[index] ^= 1; await assert.rejects(decryptBackup(changed, password)); }
  await assert.rejects(encryptBackup(f.snapshot(), 'short'), /password/);
  assert.equal(f.store.readEntity('task', f.task.id)!.value.title, 'Private recovery proof');
});
test('restoring reencrypts exact records, preserves XP and receipts, fences old epochs and refuses existing directories', async t => {
  const f = fixture(t), source = f.snapshot(), target = join(f.root, 'restored');
  let recovered = Store.restoreBackup(target, source);
  try {
    assert.notEqual(recovered.epoch, f.store.epoch); assert(recovered.recoveryHeld);
    assert.deepEqual(recovered.readEntity('task', f.task.id), f.task);
    assert.deepEqual(recovered.download(f.file.id), f.store.download(f.file.id));
    assert.deepEqual(recovered.internalRead('private:future-record'), f.store.internalRead('private:future-record'));
    assert.equal(recovered.profileProgress().earnedXp, f.store.profileProgress().earnedXp);
    assert.throws(() => recovered.mutate('owner', f.command), /recovered|replaced/);
    assert.throws(() => Store.restoreBackup(target, source), /Existing work/);
    assert.notDeepEqual(readFileSync(join(target, 'preview.key')), readFileSync(join(f.store.directory, 'preview.key')));
    const restoredSnapshot = recovered.captureBackup('0.62.0', source.native);
    assert.deepEqual(restoredSnapshot.entities, source.entities); assert.deepEqual(restoredSnapshot.history, source.history); assert.deepEqual(restoredSnapshot.receipts, source.receipts);
    recovered.close(); recovered = new Store(target);
    assert.equal(recovered.profileProgress().earnedXp, f.store.profileProgress().earnedXp); assert(recovered.recoveryHeld);
  } finally { recovered.close(); }
});
test('duplicate identities, bad references, corrupt attachments and future schemas are rejected before writing', t => {
  const f = fixture(t), original = f.snapshot();
  for (const change of [
    (s: any) => s.entities.push(s.entities[0]),
    (s: any) => s.files[0].base64 = Buffer.from('Different bytes').toString('base64'),
    (s: any) => s.files[0].id = '../../outside',
    (s: any) => s.references.push({ entityId: 'missing', fileId: s.files[0].id }),
    (s: any) => s.schema = 999,
    (s: any) => s.services.push({ id: 'backup:job:outside', revision: 1, value: { id: '../../outside', state: 'working' } }),
    (s: any) => s.cursor = 0,
  ]) { const snapshot = structuredClone(original); change(snapshot); const target = join(f.root, randomUUID()); assert.throws(() => Store.restoreBackup(target, snapshot)); assert(!existsSync(target)); }
});
test('backup jobs reconcile lost responses and service restart without repeated exports or restoration', async t => {
  const f = fixture(t); let manager = new WorkspaceBackups(f.store, '0.62.0');
  const create = { requestId: randomUUID(), epoch: f.store.epoch, passphrase: password };
  manager.create('owner', create); await manager.close();
  manager = new WorkspaceBackups(f.store, '0.62.0');
  const job = manager.create('owner', create); assert.equal(job.state, 'ready');
  assert.throws(() => manager.create('other', create)); assert.throws(() => manager.create('owner', { ...create, passphrase: 'A changed backup password' }));
  const file = await manager.download('owner', job.id);
  const upload = await manager.upload('owner', f.store.epoch, (async function* () { yield file.bytes.subarray(0,100); yield file.bytes.subarray(100); })(), () => {});
  const inspect = { requestId: randomUUID(), epoch: f.store.epoch, passphrase: password, uploadId: upload.uploadId };
  manager.inspect('owner', inspect); await manager.close(); manager = new WorkspaceBackups(f.store, '0.62.0');
  assert.equal(manager.inspect('owner', inspect).state, 'ready');
  const restore = { ...inspect, requestId: randomUUID(), reviewId: inspect.requestId };
  manager.restore('owner', restore); await manager.close(); manager = new WorkspaceBackups(f.store, '0.62.0');
  assert.equal(manager.restore('owner', restore).state, 'ready');
  assert.equal(readdirSync(join(f.store.directory, 'recovered-workspaces')).length, 1);
  const completed = f.store.internalRead<any>('backup:job:' + restore.requestId);
  f.store.internalWrite('backup:job:' + restore.requestId, { ...completed, state: 'working', restoreName: undefined });
  await manager.close(); manager = new WorkspaceBackups(f.store, '0.62.0');
  assert.equal(manager.list('owner').find(job => job.id === restore.requestId)?.state, 'ready');
  assert(!JSON.stringify(f.snapshot()).includes(password));
  await manager.remove('owner', { requestId: randomUUID(), epoch: f.store.epoch, backupId: job.id });
  await assert.rejects(manager.download('owner', job.id));
  assert((await decryptBackup(file.bytes, password)).entities.some(entity => entity.id === f.task.id));
  assert.equal(f.store.profileProgress().earnedXp, 10); await manager.close();
});
test('reauthorization failure removes the incomplete upload and creates no usable upload receipt', async t => {
  const f = fixture(t), manager = new WorkspaceBackups(f.store, '0.62.0');
  await assert.rejects(manager.upload('owner', f.store.epoch, (async function* () { yield Buffer.from('not saved'); })(), () => { throw new Error('revoked'); }), /revoked/);
  assert.equal(f.store.internalList('backup:upload:').length, 0); assert.equal(readdirSync(join(f.store.directory, 'workspace-backups')).length, 0); await manager.close();
});
test('restored HTTP workspace exposes saved work but cannot mutate, reconnect providers or start an agent', async t => {
  const f = fixture(t), target = join(f.root, 'http-copy'), recovered = Store.restoreBackup(target, f.snapshot()); recovered.close();
  const service = await startServer({ directory: target, port: 0 });
  try {
    const login = await fetch(service.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1' } });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const context = await fetch(service.origin + '/api/access/context'); assert.equal((await context.json()).recovery, true);
    const snapshot = await fetch(service.origin + '/api/snapshot', { headers: { Cookie: cookie } }); assert.equal((await snapshot.json()).tasks[0].value.title, 'Private recovery proof');
    for (const path of ['commands', 'phone/enable', 'accounts/connect', 'assignments/start', 'assistant/connection', 'storage/backups/create']) {
      const response = await fetch(service.origin + '/api/' + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: '{}' }); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'recovery_held');
    }
    assert.equal(service.gateway.status().state, 'unconfigured'); assert.equal(service.store.profileProgress().earnedXp, 10);
  } finally {
    // Close SQLite before the fixture's after hook removes its directory. After
    // hooks run in registration order, and Windows keeps open databases locked.
    await service.close();
  }
});

test('failed native verification removes staging, preserves the live workspace and never publishes a recovery', async t => {
  const f = fixture(t), bytes = Buffer.from('native archive fixture');
  const { createHash } = await import('node:crypto');
  const native = { capture: async () => ({ status: 'included' as const, archive: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), notes: [] }), restore: async () => { throw new Error('native verification failed'); } };
  let manager = new WorkspaceBackups(f.store, '0.62.0', native);
  const create = { requestId: randomUUID(), epoch: f.store.epoch, passphrase: password };
  manager.create('owner', create); await manager.close(); manager = new WorkspaceBackups(f.store, '0.62.0', native);
  const file = await manager.download('owner', create.requestId);
  const upload = await manager.upload('owner', f.store.epoch, (async function* () { yield file.bytes; })(), () => {});
  const review = { ...create, requestId: randomUUID(), uploadId: upload.uploadId };
  manager.inspect('owner', review); await manager.close(); manager = new WorkspaceBackups(f.store, '0.62.0', native);
  const restore = { ...review, requestId: randomUUID(), reviewId: review.requestId };
  manager.restore('owner', restore); await manager.close();
  assert.equal(manager.list('owner').find(job => job.id === restore.requestId)?.state, 'failed');
  assert.deepEqual(readdirSync(join(f.store.directory, 'recovered-workspaces')), []);
  assert.deepEqual(f.store.readEntity('task', f.task.id), f.task);
});

test('workspace activation survives restart, permits local edits, keeps effects paused and returns to the unchanged original', async t => {
  const root = mkdtempSync(join(tmpdir(), 'e3-recovery-host-')), source = new Store(root);
  const originalEpoch = source.epoch;
  source.mutate('owner', { requestId: randomUUID(), epoch: source.epoch, kind: 'task', entityId: 'task:host-proof', expectedRevision: 0, payload: { title: 'Original saved task', notes: '', status: 'open', planned: '', due: '' } });
  const snapshot = source.captureBackup('0.62.0', { status: 'not-configured', notes: [] }); source.close();
  const id = randomUUID(), directory = join(root, 'recovered-workspaces', id);
  const copy = Store.restoreBackup(directory, snapshot), recoveredEpoch = copy.epoch; copy.close();
  writeFileSync(join(directory, 'recovery-complete.json'), JSON.stringify({ jobId: id, sourceHash: 'a'.repeat(64), summary: summarizeBackup(snapshot) }));
  let host = await startWorkspaceHost({ directory: root, port: 0 });
  t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
  // This fixture deliberately replaces the listener on the same port. Keep its
  // requests off Undici's idle pool so restart checks reach the new listener.
  const session = async () => {
    const response = await fetch(host.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1', Connection: 'close' } });
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  let cookie = await session();
  host.current.store.internalWrite('backup:job:' + id, { id, kind: 'restore', state: 'ready', deviceId: host.current.store.authenticate(cookie.slice(cookie.indexOf('=') + 1)), epoch: originalEpoch, createdAt: new Date().toISOString(), restoreName: id });
  const post = (path: string, data: unknown) => fetch(host.origin + '/api/' + path, { method: 'POST', headers: { Cookie: cookie, 'X-Edition3-Client': '1', 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(data) });
  const response = await post('storage/backups/activate', { requestId: randomUUID(), epoch: originalEpoch, recoveryId: id }); assert.equal(response.status, 202);
  await host.waitForSwitch(); assert.equal(host.current.store.epoch, recoveredEpoch); assert(host.current.store.recoveryEffectsPaused); assert(!host.current.store.recoveryHeld);
  cookie = await session();
  for (const path of ['assistant/runtime/start', 'assignments/start', 'mail/delivery/confirm', 'phone/enable']) assert.equal((await post(path, {})).status, 409);
  const updated = await post('commands', { requestId: randomUUID(), epoch: recoveredEpoch, kind: 'task', entityId: 'task:host-proof', expectedRevision: 1, payload: { ...snapshot.entities.find(row => row.kind === 'task')!.value as object, title: 'Edited recovered task' } }); assert.equal(updated.status, 200);
  const preview = await startServer({ directory, port: 0, recoveryPreview: true });
  try { assert(preview.store.recoveryHeld); assert(!host.current.store.recoveryHeld); assert.equal((await (await fetch(preview.origin + '/api/access/context')).json()).recovery, true); }
  finally { await preview.close(); }
  const origin = host.origin; await host.close();
  host = await startWorkspaceHost({ directory: root, port: Number(new URL(origin).port) });
  assert(host.status().active); assert.equal(host.current.store.readEntity('task', 'task:host-proof')?.value.title, 'Edited recovered task');
  cookie = await session();
  assert.equal((await post('storage/backups/return', { requestId: randomUUID(), epoch: recoveredEpoch })).status, 202);
  await host.waitForSwitch(); assert.equal(host.current.store.epoch, originalEpoch); assert(!host.status().active);
  assert.equal(host.current.store.readEntity('task', 'task:host-proof')?.value.title, 'Original saved task');
  const retained = new Store(directory); try { assert.equal(retained.readEntity('task', 'task:host-proof')?.value.title, 'Edited recovered task'); } finally { retained.close(); }
});

test('a multi-megabyte native archive survives encrypted export and separate restoration', async t => {
  const f = fixture(t), { createHash } = await import('node:crypto');
  const archive = Buffer.alloc(4 * 1024 * 1024 + 1, 173), sha256 = createHash('sha256').update(archive).digest('hex');
  const snapshot = f.store.captureBackup('0.63.5', { status: 'included', archive: archive.toString('base64'), bytes: archive.length, sha256, notes: [] });
  const encrypted = await encryptBackup(snapshot, password), checked = await decryptBackup(encrypted, password);
  assert.equal(checked.native.sha256, sha256); assert.equal(Buffer.from(checked.native.archive!, 'base64').length, archive.length);
  const restored = Store.restoreBackup(join(f.root, 'large-native-copy'), checked);
  try { assert(restored.recoveryHeld); assert.equal(restored.internalRead<any>('recovery:state').nativeHash, sha256); assert.deepEqual(restored.readEntity('task', f.task.id), f.task); }
  finally { restored.close(); }
});
