import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { startServer } from '../apps/service/http.js';
import { companionLinkData, companionSignedData } from '../packages/domain/companion.js';
import { CompanionDownloads, companionChunkBytes } from '../apps/service/companion-downloads.js';

test('desktop transport requires signed proof and retains origin, recovery and browser-session boundaries', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-companion-http-'));
  const service = await startServer({ directory, port: 0, candidateId: 'a'.repeat(64) });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const send = (path: string, value?: unknown, headers = {}) => fetch(service.origin + '/api/' + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', 'X-Edition3-Candidate': 'a'.repeat(64), ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
  assert.equal((await send('companions/state')).status, 401);
  const session = await send('session', {}), cookie = session.headers.get('set-cookie')!.split(';')[0];
  const owner = { Cookie: cookie }, command = () => ({ epoch: service.store.epoch, requestId: randomUUID() });
  assert.equal((await send('companions/challenge', command(), { ...owner, 'X-Edition3-Candidate': 'old' })).status, 409);
  const challenge = await (await send('companions/challenge', command(), owner)).json();
  const keys = generateKeyPairSync('ed25519'), deviceId = randomUUID();
  const link = { ...command(), challengeId: challenge.id, deviceId, name: 'HTTP fixture', platform: 'darwin', publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(), signature: sign(null, Buffer.from(companionLinkData(challenge, deviceId)), keys.privateKey).toString('base64url') };
  assert.equal((await send('companions/link', link, owner)).status, 200);
  const packet = { protocol: 1 as const, epoch: service.store.epoch, deviceId, requestId: randomUUID(), issuedAt: Date.now(), action: 'poll' as const, payload: { enabledUntil: 0, apps: [] } };
  const signed = { ...packet, signature: sign(null, Buffer.from(companionSignedData(packet)), keys.privateKey).toString('base64url') };
  assert.equal((await send('companions/transport', signed, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await send('companions/transport', { ...signed, deviceId: randomUUID() })).status, 403);
  assert.equal((await send('companions/transport', signed, { 'X-Edition3-Candidate': 'different-web-build' })).status, 200);
  assert.equal((await send('companions/state', undefined, { Cookie: `unrelated=${deviceId}` })).status, 401);
  service.store.internalWrite('recovery:state', { held: true });
  assert.equal((await send('companions/transport', signed)).status, 409);
  service.store.internalDelete('recovery:state');
  assert.equal((await send('companions/revoke', { ...command(), deviceId }, owner)).status, 200);
  assert.equal((await send('companions/transport', signed)).status, 403);
});

test('download chunks match the archive, reject changed bytes and never resolve arbitrary files', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-download-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(companionChunkBytes + 10, 4), hash = (b: Buffer) => createHash('sha256').update(b).digest('hex'), name = 'Nova-Dream-Desktop-1.2.0-darwin-arm64.zip';
  const file = { platform: 'darwin', arch: 'arm64', version: '1.2.0', name, bytes: bytes.length, sha256: hash(bytes), chunks: [hash(bytes.subarray(0, companionChunkBytes)), hash(bytes.subarray(companionChunkBytes))], signing: 'local-ad-hoc' };
  writeFileSync(join(directory, name), bytes); writeFileSync(join(directory, 'downloads.json'), JSON.stringify({ format: 1, files: [file] }));
  const downloads = new CompanionDownloads(directory);
  assert.deepEqual(Buffer.concat([await downloads.chunk(name, 0), await downloads.chunk(name, 1)]), bytes);
  await assert.rejects(downloads.chunk('../secret', 0)); await assert.rejects(downloads.chunk(name, -1));
  writeFileSync(join(directory, name), Buffer.alloc(bytes.length, 7)); await assert.rejects(downloads.chunk(name, 0), /integrity/);
  await t.test('terminal archive links cannot substitute otherwise valid download bytes', {
    skip: typeof constants.O_NOFOLLOW !== 'number' ? 'Requires native O_NOFOLLOW file-link protection; exercised in Linux CI.' : false,
  }, async linkTest => {
    const target = join(directory, 'linked-archive.zip'); writeFileSync(target, bytes); rmSync(join(directory, name));
    try { symlinkSync(target, join(directory, name)); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        linkTest.skip('Windows file-symlink privilege is unavailable; the real terminal-link security check runs in Linux CI.'); return;
      }
      throw error;
    }
    await assert.rejects(downloads.chunk(name, 0));
  });
  assert.deepEqual(await new CompanionDownloads().list(), []);
});
