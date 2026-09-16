import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { UploadTransfers } from '../apps/service/upload-transfers';
import { startServer } from '../apps/service/http';
import { request as browserRequest } from '../apps/client/src/api';

const consume = async (stream: AsyncIterable<Buffer>) => { const parts: Buffer[] = []; for await (const part of stream) parts.push(part); return Buffer.concat(parts); };
test('pieces are encrypted, ordered, owner-bound, replay-safe and removed after exact reassembly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'e3-pieces-')), epoch = randomUUID(), transfers = new UploadTransfers(directory, epoch);
  try {
    const bytes = randomBytes(1024 * 1024 + 73), start = await transfers.begin('web:owner', { epoch, path: '/api/attachments', type: 'application/json', bytes: bytes.length });
    const first = { epoch, id: start.id, index: 0, base64: bytes.subarray(0, start.pieceBytes).toString('base64') };
    await assert.rejects(transfers.piece('web:other', first), /expired/);
    await assert.rejects(transfers.piece('web:owner', { ...first, epoch: randomUUID() }), /workspace changed/);
    await assert.rejects(transfers.piece('web:owner', { ...first, index: 1, base64: bytes.subarray(start.pieceBytes).toString('base64') }), /preceding/);
    assert.deepEqual(await transfers.piece('web:owner', first), { next: 1 });
    assert.deepEqual(await transfers.piece('web:owner', first), { next: 1 });
    await assert.rejects(transfers.piece('web:owner', { ...first, base64: randomBytes(start.pieceBytes).toString('base64') }), /changed/);
    assert.throws(() => transfers.read('web:owner', start.id, '/api/attachments', 'application/json'), /incomplete/);
    await transfers.piece('web:owner', { ...first, index: 1, base64: bytes.subarray(start.pieceBytes).toString('base64') });
    const folder = join(directory, readdirSync(directory)[0]);
    assert.equal(readFileSync(join(folder, start.id + '-0')).includes(bytes.subarray(0, 64)), false);
    assert.throws(() => transfers.read('web:owner', start.id, '/api/commands', 'application/json'), /another operation/);
    const opened = transfers.read('web:owner', start.id, '/api/attachments', 'application/json');
    assert.throws(() => transfers.read('web:owner', start.id, '/api/attachments', 'application/json'), /incomplete/);
    assert.deepEqual(await consume(opened.stream), bytes); assert.equal(readdirSync(folder).length, 0);
    assert.throws(() => transfers.read('web:owner', start.id, '/api/attachments', 'application/json'), /expired/);
  } finally { await transfers.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('corruption, expiry and quota fail closed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'e3-pieces-')), epoch = randomUUID(); let now = 0;
  const transfers = new UploadTransfers(directory, epoch, () => now);
  try {
    const manifest = { epoch, path: '/api/attachments', type: 'application/json', bytes: 3 };
    const start = await transfers.begin('owner', manifest);
    await transfers.piece('owner', { epoch, id: start.id, index: 0, base64: 'YWJj' });
    const folder = join(directory, readdirSync(directory)[0]), file = join(folder, start.id + '-0'), encrypted = readFileSync(file); encrypted[30] ^= 1; writeFileSync(file, encrypted);
    await assert.rejects(consume(transfers.read('owner', start.id, '/api/attachments', 'application/json').stream));
    const old = await transfers.begin('owner', manifest); now = 900001;
    assert.throws(() => transfers.read('owner', old.id, '/api/attachments', 'application/json'), /expired/);
    for (let i = 0; i < 4; i++) await transfers.begin('owner', manifest);
    await assert.rejects(transfers.begin('owner', manifest), /current uploads/);
    await assert.rejects(transfers.begin('else', { ...manifest, path: '/api/session' }), /does not accept/);
    await assert.rejects(transfers.begin('else', { ...manifest, type: 'application/octet-stream' }), /does not accept/);
  } finally { await transfers.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('binary backup transfer reassembles exactly through its original guarded endpoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'e3-transfer-backup-')), server = await startServer({ directory, port: 0 });
  try {
    const login = await fetch(server.origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: '{}' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]; await login.json();
    const epoch = server.store.epoch, bytes = randomBytes(5 * 1024 * 1024), headers = { cookie, 'X-Edition3-Client': '1', 'Content-Type': 'application/json' };
    const post = async (path: string, body: unknown) => { const response = await fetch(server.origin + path, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(response.status, 200); return response.json(); };
    const start = await post('/api/transfers/start', { epoch, path: '/api/storage/backups/upload', type: 'application/octet-stream', bytes: bytes.length });
    for (let i = 0; i < bytes.length / start.pieceBytes; i++) await post('/api/transfers/piece', { epoch, id: start.id, index: i, base64: bytes.subarray(i * start.pieceBytes, (i + 1) * start.pieceBytes).toString('base64') });
    const final = await fetch(server.origin + '/api/storage/backups/upload', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Edition3-Epoch': epoch, 'X-Edition3-Transfer': start.id } });
    assert.equal(final.status, 200); const saved = await final.json(); assert.equal(saved.bytes, bytes.length);
    assert.deepEqual(readFileSync(join(directory, 'workspace-backups', 'upload-' + saved.uploadId)), bytes);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('real HTTP uploads pass through sub-4MB browser requests and preserve original idempotency and guards', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'e3-transfer-http-')), candidate = 'b'.repeat(64);
  const server = await startServer({ directory, port: 0, candidateId: candidate });
  const originalFetch = globalThis.fetch;
  try {
    const login = await originalFetch(server.origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', 'X-Edition3-Candidate': candidate }, body: '{}' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]; await login.json();
    let maxRequestBytes = 0, chunks = 0;
    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers); headers.set('cookie', cookie); headers.set('X-Edition3-Candidate', candidate);
      const length = typeof init?.body === 'string' ? Buffer.byteLength(init.body) : 0; maxRequestBytes = Math.max(maxRequestBytes, length);
      if (String(url).endsWith('/transfers/piece')) chunks++;
      assert(length < 4 * 1024 * 1024);
      return originalFetch(server.origin + url, { ...init, headers });
    }) as typeof fetch;
    const bytes = randomBytes(6 * 1024 * 1024), input = { requestId: randomUUID(), epoch: server.store.epoch, name: 'large.txt', base64: bytes.toString('base64') };
    const saved = await browserRequest<any>('attachments', input);
    assert.equal(saved.size, bytes.length); assert.equal(saved.sha256, createHash('sha256').update(bytes).digest('hex')); assert(chunks > 1); assert(maxRequestBytes < 1500000);
    assert.deepEqual(await browserRequest('attachments', input), saved);
    const manifest = { epoch: server.store.epoch, path: '/api/attachments', type: 'application/json', bytes: 3 };
    const send = (headers: Record<string,string>) => originalFetch(server.origin + '/api/transfers/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', 'X-Edition3-Candidate': candidate, cookie, ...headers }, body: JSON.stringify(manifest) });
    assert.equal((await send({ cookie: '' })).status, 401);
    assert.equal((await send({ origin: 'https://foreign.example' })).status, 403);
    assert.equal((await send({ 'X-Edition3-Candidate': 'c'.repeat(64) })).status, 409);
  } finally { globalThis.fetch = originalFetch; await server.close(); assert.equal(readdirSync(directory).some(n => n.startsWith('.upload-pieces-')), false); rmSync(directory, { recursive: true, force: true }); }
});
