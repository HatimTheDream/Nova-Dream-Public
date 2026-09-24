import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageUpdateBundle } from '../scripts/update-bundle.mjs';
import { signUpdateManifest } from '../scripts/update-manifest.mjs';
import * as contract from '../apps/service/update-feed.ts';

test('reviewed flat bundle binds its fixed runner and helper bytes without overwriting an existing artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-update-bundle-'));
  try {
    const source = join(root, 'reviewed'); mkdirSync(source);
    writeFileSync(join(source, 'install.py'), '# synthetic runner fixture\n'); writeFileSync(join(source, 'helper.py'), '# synthetic helper fixture\n');
    const output = join(root, 'bundle.json'), metadata = packageUpdateBundle(source, output), bytes = readFileSync(output), bundle = JSON.parse(bytes);
    assert.equal(metadata.bytes, bytes.length); assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(metadata.runnerSha256, bundle.files.find(file => file.name === 'install.py').sha256);
    assert.throws(() => packageUpdateBundle(source, output)); assert(readFileSync(output).equals(bytes));
    mkdirSync(join(source, 'subdirectory')); assert.throws(() => packageUpdateBundle(source, join(root, 'other.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('manifest signing uses an existing matching external key and advances the verified previous sequence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-update-signing-fixture-'));
  try {
    // Throwaway synthetic keys exercise signing; no production key is generated or published.
    const keys = generateKeyPairSync('ed25519');
    const privateKeyFile = join(directory, 'fixture-private.pem'), publicKeyFile = join(directory, 'fixture-public.pem');
    writeFileSync(privateKeyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(publicKeyFile, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const input = join(directory, 'review.json'), first = join(directory, 'first.json');
    const manifest = { format: 1, channel: 'stable', sequence: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), releases: [], currentCandidates: [{ candidateId: 'a'.repeat(64), novaVersion: '1.13.0', agentVersion: '2026.9.2', platform: 'linux', arch: 'x64', nodeMajor: 24, schemaVersion: 55, protocolVersion: 4 }] };
    writeFileSync(input, JSON.stringify(manifest));
    const request = { input, privateKeyFile, publicKeyFile, output: first, previous: 'initial' };
    const result = await signUpdateManifest(request, contract); assert.equal(result.sequence, 1);
    const envelope = JSON.parse(readFileSync(first)); assert(verify(null, Buffer.from(envelope.payload, 'base64'), keys.publicKey, Buffer.from(envelope.signature, 'base64')));
    assert.deepEqual(JSON.parse(Buffer.from(envelope.payload, 'base64')).currentCandidates, manifest.currentCandidates);
    await assert.rejects(signUpdateManifest({ ...request, output: join(directory, 'replay.json'), previous: first }, contract));
    writeFileSync(input, JSON.stringify({ ...manifest, sequence: 2 }));
    assert.equal((await signUpdateManifest({ ...request, output: join(directory, 'second.json'), previous: first }, contract)).sequence, 2);
    const other = generateKeyPairSync('ed25519'); writeFileSync(publicKeyFile, other.publicKey.export({ type: 'spki', format: 'pem' }));
    await assert.rejects(signUpdateManifest({ ...request, output: join(directory, 'wrong-key.json') }, contract));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
