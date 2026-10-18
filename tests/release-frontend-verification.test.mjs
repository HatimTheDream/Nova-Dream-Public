import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontendPublicationInput, verifyFrontendPublicationInput, createFrontendPublicationAdapter, retainedFrontendPublication } from '../scripts/release-delivery-frontend.mjs';
import { withVerificationPass, verificationEffect } from '../scripts/release-verification-pass.mjs';
import { sha256 } from '../scripts/release-plan.mjs';

function fixture(t) {
  const root = fileURLToPath(new URL(`../support/fixtures/frontend-verify-${randomUUID()}/`, import.meta.url));
  fs.mkdirSync(root, { recursive: true });
  t.after(() => { assert.equal(dirname(root), fileURLToPath(new URL('../support/fixtures', import.meta.url))); fs.rmSync(root, { recursive: true, force: true }); });
  const put = (name, bytes) => {
    const path = join(root, name); fs.writeFileSync(path, bytes); return { path, sha256: sha256(bytes) };
  };
  const keys = generateKeyPairSync('ed25519');
  const publicKey = put('public.pem', Buffer.from(keys.publicKey.export({ format: 'pem', type: 'spki' })));
  const tool = put('tool', Buffer.from('test executable identity; never executed'));
  const archive = put('archive.tgz', Buffer.from('archive fixture'));
  const files = [{ path: '.vite/manifest.json', bytes: 2, sha256: sha256('{}') }, { path: 'index.html', bytes: 7, sha256: sha256('<html/>') }];
  const frontendId = sha256(JSON.stringify(files)), now = Date.now(), expires = now + 60000;
  const manifest = put('manifest.json', Buffer.from(JSON.stringify({ format: 1, kind: 'frontend', channel: 'frontend-stable', sequence: 1,
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(expires).toISOString(), frontendId, frontendVersion: '2.3.1', frontendBuildVersion: '1.0.288',
    sourceRevision: 'a'.repeat(40), base: { candidateId: 'b'.repeat(64), serviceInputsSha256: 'c'.repeat(64), apiVersion: 1, schemaVersion: 55 },
    artifact: { url: 'https://github.com/HatimTheDream/Nova-Dream-Public/releases/download/v2.3.1/nova-2.3.1-frontend.tgz', sha256: archive.sha256, bytes: fs.statSync(archive.path).size }, files }) + '\n'));
  const signed = { route: 'frontend', manifest, archive, signature: put('signature.sig', sign(null, fs.readFileSync(manifest.path), keys.privateKey)), publicKey, sequence: 1, frontendId };
  const descriptor = { operation: { id: randomUUID(), version: '2.3.1', buildVersion: '1.0.288', priorCandidateId: 'b'.repeat(64), trustedPublicKeySha256: publicKey.sha256 }, sources: { private: { commit: 'a'.repeat(40) }, public: { commit: 'd'.repeat(40) } } };
  const prior = { route: { route: 'frontend', serviceInputsSha256: 'c'.repeat(64) }, package: { manifest, archive }, sign: signed };
  const context = { descriptor, prior, tools: { git: tool, node: tool, python: tool, gitExecPath: root }, releaseIds: { private: 1, public: 2 }, journal: { directory: root } };
  return { ...context, root, now, expires, put, input: frontendPublicationInput(context) };
}

function countOpens(t, paths) {
  const original = fs.openSync, counts = new Map(paths.map(path => [resolve(path), 0]));
  fs.openSync = function(path, ...args) {
    const key = typeof path === 'string' ? resolve(path) : null;
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports(); t.after(() => { fs.openSync = original; syncBuiltinESMExports(); });
  return path => counts.get(resolve(path));
}

test('frontend publication authenticates each archive once in a pure pass and each next pass reads again', async t => {
  const f = fixture(t), paths = ['archive', 'manifest', 'signature'].map(role => f.input.signed[role].path), reads = countOpens(t, paths);
  const check = c => verifyFrontendPublicationInput(f.input, f.descriptor, {}, c);
  await withVerificationPass(f, async c => {
    const first = check(c); for (let i = 0; i < 10; i++) assert.deepEqual(check(c), first);
    for (const path of paths) assert.equal(reads(path), 1);
    first[0].bytes = -1; assert.notEqual(check(c)[0].bytes, -1);
    await verificationEffect(c, async () => {}); check(c);
    for (const path of paths) assert.equal(reads(path), 2);
  });
  await withVerificationPass(f, async c => check(c));
  for (const path of paths) assert.equal(reads(path), 3);
});

test('frontend admission still checks the current clock after earlier signature verification', async t => {
  const f = fixture(t); let now = f.now; t.mock.method(Date, 'now', () => now);
  await withVerificationPass(f, async c => {
    verifyFrontendPublicationInput(f.input, f.descriptor, { admission: true }, c);
    now = f.expires;
    assert.throws(() => verifyFrontendPublicationInput(f.input, f.descriptor, { admission: true }, c), /admission is not current/);
    assert.equal(verifyFrontendPublicationInput(f.input, f.descriptor, { admission: false }, c).length, 3,
      'observing an original publication is separate from admitting a new effect');
  });
});

test('changed frontend operation, signature, tool and archive cannot reuse earlier verification', async t => {
  const f = fixture(t), archive = f.input.signed.archive.path, reads = countOpens(t, [archive]);
  await withVerificationPass(f, async c => {
    verifyFrontendPublicationInput(f.input, f.descriptor, {}, c);
    verifyFrontendPublicationInput(f.input, f.descriptor, {}, { ...c, journal: { directory: f.root + '-different' } });
    assert.equal(reads(archive), 2, 'the exact journal remains part of the verification scope');
    const descriptor = structuredClone(f.descriptor); descriptor.operation.id = randomUUID();
    assert.throws(() => verifyFrontendPublicationInput(f.input, descriptor, {}, c), /operation-changed/);
    const tool = structuredClone(f.input); tool.tools.node.sha256 = '0'.repeat(64);
    assert.throws(() => verifyFrontendPublicationInput(tool, f.descriptor, {}, c), /hash|changed/i);
    const signature = structuredClone(f.input); signature.signed.signature = f.put('invalid.sig', Buffer.alloc(64));
    assert.throws(() => verifyFrontendPublicationInput(signature, f.descriptor, {}, c), /signature-invalid/);
    await assert.rejects(verificationEffect(c, async () => {
      fs.writeFileSync(archive, 'corrupt'); throw Error('lost effect response');
    }), /lost effect response/);
    assert.throws(() => verifyFrontendPublicationInput(f.input, f.descriptor, {}, c), /hash|changed/i);
  });
  await assert.rejects(withVerificationPass(f, async c => verifyFrontendPublicationInput(f.input, f.descriptor, {}, c)), /hash|changed/i);
});

test('actual publication adapter validates and verifies within one pass without replaying a completed publication', async t => {
  const f = fixture(t), key = randomUUID(), input = f.input;
  const intent = { key, input, inputSha256: sha256(JSON.stringify(input)) }, context = { ...f, intent };
  const specs = verifyFrontendPublicationInput(input, f.descriptor);
  const assets = specs.map((spec, i) => {
    const directory = join(f.root, `frontend-publication-${key}-${spec.role}`, 'first', '0-readback'); fs.mkdirSync(directory, { recursive: true });
    const path = join(directory, spec.name); fs.writeFileSync(path, fs.readFileSync(spec.path));
    return { operationId: f.descriptor.operation.id, key, inputSha256: intent.inputSha256, role: spec.role,
      asset: { id: i + 100, name: spec.name, bytes: spec.bytes, sha256: spec.sha256, authenticatedDownloadVerified: true, adoptedExisting: false, localPath: path } };
  });
  const output = { kind: 'nova-delivery-frontend-publication', operationId: f.descriptor.operation.id, key, inputSha256: intent.inputSha256,
    frontendId: input.signed.frontendId, releaseIds: f.releaseIds, assets, hostEffects: false, savedReplyAccepted: false, browserAccepted: false };
  const directory = join(f.root, 'delivery-evidence'); fs.mkdirSync(directory);
  const path = join(directory, `${key}-frontend-publication.json`), bytes = Buffer.from(JSON.stringify(output) + '\n'); fs.writeFileSync(path, bytes);
  const reads = countOpens(t, [input.signed.archive.path]); let commands = 0, writes = 0;
  const adapter = createFrontendPublicationAdapter({ tools: f.tools, releaseIds: f.releaseIds,
    command: async () => { commands++; throw Error('must not republish'); }, storeReceipt: () => { writes++; throw Error('must not rewrite'); } });
  await withVerificationPass(context, async c => {
    await adapter.validate(c); const value = retainedFrontendPublication(c, specs, f.releaseIds); await adapter.verify(value, c);
    assert.equal(reads(input.signed.archive.path), 1); assert.equal(value.receipt.sha256, sha256(bytes));
    assert.deepEqual(fs.readFileSync(path), bytes); assert.equal(commands, 0); assert.equal(writes, 0);
    const observed = await adapter.observe(c); await adapter.verify(observed, c);
    assert.equal(reads(input.signed.archive.path), 3, 'observation may reconcile receipts, so its boundary invalidates both sides');
  });
  await withVerificationPass(context, async c => { const resumed = await adapter.observe(c); await adapter.verify(resumed, c); });
  assert.equal(reads(input.signed.archive.path), 5); assert.equal(commands, 0); assert.equal(writes, 0);
});
