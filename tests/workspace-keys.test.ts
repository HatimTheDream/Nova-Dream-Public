import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import { WorkspaceKeys, type KeyProtector } from '../apps/service/workspace-keys.js';
import { startServer } from '../apps/service/http.js';

// Exercise the host's filesystem durability behavior while supplying a fixture
// OS vault on platforms without an OS-protection provider.
const protectedPlatform = process.platform === 'win32' ? 'win32' : 'darwin';
const otherPlatform = protectedPlatform === 'win32' ? 'darwin' : 'win32';

class FixtureVault implements KeyProtector {
  private key = randomBytes(32);
  wraps = 0; reads = 0; failRead = 0;
  async wrap(key: Buffer) { this.wraps++; const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); const body = Buffer.concat([cipher.update(key), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); }
  async unwrap(value: Buffer) { this.reads++; if (this.reads === this.failRead) throw new Error('Fixture OS locked'); const decipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]); }
}
function fixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-key-')), vault = new FixtureVault();
  const store = new Store(directory), keys = new WorkspaceKeys(directory, vault, protectedPlatform);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, vault, keys, legacy: join(directory, 'preview.key'), wrapper: join(directory, 'workspace-key.json') };
}

test('protected wrapper reopens exact saved data without retaining a plaintext workspace key', async t => {
  const f = fixture(t), key = readFileSync(f.legacy);
  const saved = f.store.mutate('owner', { requestId: randomUUID(), epoch: f.store.epoch, entityId: 'task:key-test', kind: 'task', expectedRevision: 0, payload: { title: 'Key protection fixture', notes: '', status: 'open', planned: '', due: '' } });
  await Promise.all([f.keys.protect(value => f.store.matchesKey(value)), f.keys.protect(value => f.store.matchesKey(value))]);
  assert.equal(f.vault.wraps, 1); assert.equal(existsSync(f.legacy), false);
  assert.equal(f.keys.status().protection, 'os'); assert.equal(f.keys.status().verified, true);
  assert.equal(readFileSync(f.wrapper).includes(key.toString('base64')), false);
  const recovered = await new WorkspaceKeys(f.directory, f.vault, protectedPlatform).readProtected(); assert.deepEqual(recovered, key);
  const reopened = new Store(f.directory, undefined, recovered); recovered!.fill(0);
  try { assert.deepEqual(reopened.readEntity('task', saved.id), saved); } finally { reopened.close(); }
  assert.equal(existsSync(f.legacy), false); await f.keys.protect(value => f.store.matchesKey(value)); assert.equal(f.vault.wraps, 1);
});

test('failed durable unwrap preserves both the original key and authenticated database for safe retry', async t => {
  const f = fixture(t), key = readFileSync(f.legacy), database = readFileSync(join(f.directory, 'workspace.sqlite'));
  f.vault.failRead = 2;
  await assert.rejects(f.keys.protect(value => f.store.matchesKey(value)), /operating system/);
  assert.deepEqual(readFileSync(f.legacy), key); assert.deepEqual(readFileSync(join(f.directory, 'workspace.sqlite')), database);
  assert.equal(existsSync(f.wrapper), true); assert.equal(f.keys.status().protection, 'file');
  await f.keys.protect(value => f.store.matchesKey(value)); assert.equal(existsSync(f.legacy), false); assert.equal(f.vault.wraps, 1);
});

test('wrong key, corrupt wrapper and a different OS never fall back or replace existing material', async t => {
  const f = fixture(t), original = readFileSync(f.legacy);
  writeFileSync(f.legacy, randomBytes(32)); await assert.rejects(f.keys.protect(value => f.store.matchesKey(value)), /operating system/);
  assert.equal(existsSync(f.wrapper), false); writeFileSync(f.legacy, original);
  await f.keys.protect(value => f.store.matchesKey(value)); const wrapper = readFileSync(f.wrapper);
  writeFileSync(f.legacy, original); writeFileSync(f.wrapper, '{broken');
  await assert.rejects(f.keys.readProtected(), /operating system/); await assert.rejects(f.keys.protect(value => f.store.matchesKey(value)), /operating system/);
  assert.deepEqual(readFileSync(f.legacy), original); assert.equal(readFileSync(f.wrapper, 'utf8'), '{broken');
  writeFileSync(f.wrapper, wrapper);
  await assert.rejects(new WorkspaceKeys(f.directory, f.vault, otherPlatform).readProtected(), /operating system/);
  assert.deepEqual(readFileSync(f.wrapper), wrapper);
});

test('OS-protected service can restart and reconcile the exact protection request', { skip: !['darwin', 'win32'].includes(process.platform) }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-key-http-')), vault = new FixtureVault();
  let service = await startServer({ directory, port: 0, keyProtector: vault });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const login = await fetch(service.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1' } });
  const cookie = login.headers.get('set-cookie')!.split(';')[0], operation = { requestId: randomUUID(), epoch: service.store.epoch };
  const protect = () => fetch(service.origin + '/api/storage/protect', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: JSON.stringify(operation) });
  const response = await protect(); assert.equal(response.status, 200); assert.equal((await response.json()).protection, 'os');
  await service.close(); service = await startServer({ directory, port: 0, keyProtector: vault });
  const retry = await protect(); assert.equal(retry.status, 200); assert.equal((await retry.json()).protection, 'os'); assert.equal(vault.wraps, 1);
  assert.equal(existsSync(join(directory, 'preview.key')), false);
});
