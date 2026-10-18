import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidate } from '../scripts/candidate.mjs';
import { sha256 } from '../scripts/release-plan.mjs';
import { createRouteAdapter, createFrontendPackageAdapter, createFrontendSignAdapter } from '../scripts/release-delivery-package.mjs';
import { withVerificationPass, verificationEffect } from '../scripts/release-verification-pass.mjs';

const json = x => Buffer.from(JSON.stringify(x) + '\n');
function fixture(t) {
  const root = fileURLToPath(new URL(`../support/fixtures/package-${randomUUID()}/`, import.meta.url)); mkdirSync(root, { recursive: true });
  t?.after(() => { assert.equal(dirname(root), fileURLToPath(new URL('../support/fixtures', import.meta.url))); fs.rmSync(root, { recursive: true, force: true }); });
  const put = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); const raw = Buffer.isBuffer(bytes) ? bytes : json(bytes); writeFileSync(path, raw); return { path, sha256: sha256(raw) }; };
  const source = (side, base = false) => {
    const path = join(root, `${side}-${base ? 'base' : 'target'}`), commit = (side === 'private' ? 'a' : 'b').repeat(40);
    const pkg = { name: 'nova-dream-edition-3', version: base ? '2.3.0' : '2.3.1', edition3: { buildVersion: base ? '1.0.287' : '1.0.288', schemaVersion: 1, apiVersion: 1, appId: 'nova' } };
    put(join(path, 'package.json'), pkg); put(join(path, 'package-lock.json'), { version: pkg.version, packages: { '': { name: pkg.name, version: pkg.version } } });
    put(join(path, 'scripts/candidate.mjs'), Buffer.from('synthetic immutable verifier bytes'));
    const files = { 'dist/client/index.html': '<html/>', 'dist/client/.vite/manifest.json': '{}', 'dist/client/assets/app.js': base ? 'oldBehavior()' : 'laterAction()', 'dist/service/apps/service/main.js': 'sameService()', 'dist/desktop/main.cjs': 'sameDesktop()' };
    const artifacts = Object.entries(files).map(([name, text]) => ({ path: name, sha256: put(join(path, name), Buffer.from(text)).sha256 }));
    const manifest = put(join(path, 'dist/candidate.json'), { version: pkg.version, ...pkg.edition3, artifacts, frontendCompatibility: { format: 2, eligibility: 'client-behavior', sourceRevision: commit, serviceInputsSha256: 'c'.repeat(64), sourceFiles: 10, compiledFiles: 2 } });
    const candidate = verifyCandidate(path), archive = put(join(root, `${side}-${base ? 'base' : 'target'}.tgz`), Buffer.from('synthetic retained CI archive fixture'));
    const metadata = { format: 1, candidateId: candidate.id, archiveSha256: archive.sha256, archiveBytes: readFileSync(archive.path).length, expandedBytes: 512, fileCount: 10,
      packageLockSha256: sha256(readFileSync(join(path, 'package-lock.json'))), version: pkg.version, buildVersion: pkg.edition3.buildVersion, schemaVersion: 1, apiVersion: 1 };
    const repository = `HatimTheDream/Nova-Dream${side === 'public' ? '-Public' : ''}`;
    const receipt = { format: 1, kind: 'canonical-ci-built-candidate', sourceCommit: commit, repository, runId: '123', runAttempt: '1', toolchain: { nodeVersion: '22.23.2', platform: 'linux', arch: 'x64' }, nodeSha256: 'd'.repeat(64), packagerSha256: 'e'.repeat(64),
      candidateVerifierSha256: sha256(readFileSync(join(path, 'scripts/candidate.mjs'))), application: metadata, rebuilt: false, deliveryQualification: false };
    return { directory: path, candidateId: candidate.id, manifest, repository, sourceCommit: commit, applicationDirectory: path, archive,
      metadata: put(join(root, `${side}-${base ? 'base' : 'target'}-metadata.json`), metadata), ciSourceReceipt: put(join(root, `${side}-${base ? 'base' : 'target'}-receipt.json`), receipt) };
  };
  const targets = { private: source('private'), public: source('public') }, bases = { private: source('private', true), public: source('public', true) };
  const descriptor = { operation: { id: randomUUID(), priorCandidateId: bases.private.candidateId, version: '2.3.1', buildVersion: '1.0.288' },
    sources: Object.fromEntries(Object.entries(targets).map(([side, value]) => [side, { commit: value.sourceCommit, repository: value.repository }])) };
  const now = Date.now(), frontend = { artifactUrl: 'https://example.invalid/frontend.tgz', sequence: 1, createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400000).toISOString() };
  return { root, put, descriptor, targets, bases, frontend, prior: { artifacts: { authenticatedGithubCollection: true, repositories: targets } } };
}
async function route(f) {
  const adapter = createRouteAdapter(f.bases), input = await adapter.input({ prior: f.prior }), context = { descriptor: f.descriptor, intent: { input } };
  await adapter.validate({ descriptor: f.descriptor, input }); const value = await adapter.execute(context); await adapter.verify(value, context); return value.output;
}
test('actual candidate verification routes retained React behavior and packages without Git or rebuild', async () => {
  const f = fixture(); f.prior.route = await route(f); assert.equal(f.prior.route.route, 'frontend');
  const adapter = createFrontendPackageAdapter(f), input = await adapter.input({ prior: f.prior }), context = { descriptor: f.descriptor, intent: { input, key: randomUUID() }, journal: { directory: f.root } };
  await adapter.validate({ descriptor: f.descriptor, input }); const value = await adapter.execute(context); await adapter.verify(value, context);
  assert.equal(value.output.route, 'frontend'); assert.equal(value.output.baseCandidateId, f.bases.private.candidateId);
  const resumed = await adapter.observe(context); assert.deepEqual(resumed, value);
  writeFileSync(value.output.archive.path, 'corrupt'); await assert.rejects(adapter.observe(context), /package-output-changed/);
});
test('retained candidate tampering refuses routing before any package output', async () => {
  const f = fixture(); writeFileSync(join(f.targets.private.directory, 'dist/client/assets/app.js'), 'tampered');
  await assert.rejects(route(f), /Rebuild before starting/);
});
test('invalid signature and a different trusted signing key are rejected without signing', async () => {
  const f = fixture(); f.prior.route = await route(f);
  const pack = createFrontendPackageAdapter(f), packageInput = await pack.input({ prior: f.prior });
  const packaged = await pack.execute({ descriptor: f.descriptor, intent: { input: packageInput, key: randomUUID() }, journal: { directory: f.root } });
  const { publicKey } = generateKeyPairSync('ed25519'), publicRef = f.put(join(f.root, 'public.pem'), Buffer.from(publicKey.export({ format: 'pem', type: 'spki' })));
  const signing = { privateKeyPath: 'not-opened-by-this-test', publicKey: publicRef, previousManifest: 'initial' }, adapter = createFrontendSignAdapter(signing);
  f.descriptor.operation.trustedPublicKeySha256 = '0'.repeat(64);
  const input = await adapter.input({ prior: { package: packaged.output } });
  await assert.rejects(adapter.validate({ descriptor: f.descriptor, input }), /trusted-signing-key-changed/);
  f.descriptor.operation.trustedPublicKeySha256 = publicRef.sha256; await adapter.validate({ descriptor: f.descriptor, input });
  const key = randomUUID(); writeFileSync(join(f.root, `delivery-signature-${key}.sig`), Buffer.alloc(64));
  await assert.rejects(adapter.observe({ descriptor: f.descriptor, intent: { key, input }, journal: { directory: f.root } }), /signature-invalid/);
});

function countOpens(t, paths) {
  const original = fs.openSync, counts = new Map(paths.map(path => [resolve(path), 0]));
  fs.openSync = function(path, ...args) {
    const key = typeof path === 'string' ? resolve(path) : null;
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.openSync = original; syncBuiltinESMExports(); });
  return path => counts.get(resolve(path));
}

test('route validation and result verification share exact retained reads only within one pure pass', async t => {
  const f = fixture(t), adapter = createRouteAdapter(f.bases), input = await adapter.input({ prior: f.prior });
  const context = { descriptor: f.descriptor, input, intent: { input, key: randomUUID() }, journal: { directory: f.root } };
  const archives = [f.targets.private.archive.path, f.targets.public.archive.path], reads = countOpens(t, archives);
  await withVerificationPass(context, async c => {
    await adapter.validate(c); const value = await adapter.observe(c); await adapter.verify(value, c);
    for (const archive of archives) assert.equal(reads(archive), 1);
    value.output.route = 'full'; await assert.rejects(adapter.verify(value, c), /route-result-changed/);
    assert.equal((await adapter.observe(c)).output.route, 'frontend');
    const changed = { ...c, descriptor: { ...f.descriptor, operation: { ...f.descriptor.operation, id: randomUUID() } } };
    await adapter.validate(changed);
    for (const archive of archives) assert.equal(reads(archive), 2, 'another operation cannot borrow verified bytes');
  });
  await withVerificationPass(context, async c => adapter.validate(c));
  for (const archive of archives) assert.equal(reads(archive), 3, 'resume starts with a fresh read');
});

test('package and signature observation reuse complete verification without retaining caller mutations', async t => {
  const f = fixture(t); f.prior.route = await route(f);
  const pack = createFrontendPackageAdapter(f), input = await pack.input({ prior: f.prior });
  const context = { descriptor: f.descriptor, input, intent: { input, key: randomUUID() }, journal: { directory: f.root } };
  const packaged = await pack.execute(context);
  const keys = generateKeyPairSync('ed25519'), publicKey = f.put(join(f.root, 'public.pem'), Buffer.from(keys.publicKey.export({ format: 'pem', type: 'spki' })));
  f.descriptor.operation.trustedPublicKeySha256 = publicKey.sha256;
  const signing = { privateKeyPath: 'never-opened', publicKey, previousManifest: 'initial' }, signer = createFrontendSignAdapter(signing);
  const signInput = await signer.input({ prior: { package: packaged.output } }), key = randomUUID();
  const signaturePath = join(f.root, `delivery-signature-${key}.sig`);
  writeFileSync(signaturePath, sign(null, readFileSync(packaged.output.manifest.path), keys.privateKey));
  const signContext = { descriptor: f.descriptor, input: signInput, intent: { input: signInput, key }, journal: { directory: f.root } };
  const paths = [f.targets.private.archive.path, packaged.output.archive.path, signaturePath], reads = countOpens(t, paths);
  await withVerificationPass(context, async c => {
    await pack.validate(c); const value = await pack.observe(c); await pack.verify(value, c);
    assert.equal(reads(paths[0]), 1); assert.equal(reads(paths[1]), 1);
    value.output.archive.sha256 = '0'.repeat(64); await assert.rejects(pack.verify(value, c), /package-result-changed/);
    assert.equal((await pack.observe(c)).output.archive.sha256, packaged.output.archive.sha256);
  });
  await withVerificationPass(signContext, async c => {
    await signer.validate(c); const value = await signer.observe(c); await signer.verify(value, c);
    assert.equal(reads(signaturePath), 1);
    value.output.signature.sha256 = '0'.repeat(64); await assert.rejects(signer.verify(value, c), /signature-result-changed/);
    assert.notEqual((await signer.observe(c)).output.signature.sha256, '0'.repeat(64));
  });
  await withVerificationPass(signContext, async c => signer.observe(c)); assert.equal(reads(signaturePath), 2);
  writeFileSync(signaturePath, Buffer.alloc(64));
  await assert.rejects(withVerificationPass(signContext, c => signer.observe(c)), /signature-invalid/);
});

test('lost effect responses invalidate package verification and a resumed operation rejects changed artifacts', async t => {
  const f = fixture(t); f.prior.route = await route(f);
  const adapter = createFrontendPackageAdapter(f), input = await adapter.input({ prior: f.prior });
  const context = { descriptor: f.descriptor, input, intent: { input, key: randomUUID() }, journal: { directory: f.root } };
  const packaged = await adapter.execute(context);
  await withVerificationPass(context, async c => {
    await adapter.observe(c);
    await assert.rejects(verificationEffect(c, async () => {
      writeFileSync(packaged.output.archive.path, 'corrupt'); throw Error('lost original response');
    }), /lost original response/);
    await assert.rejects(adapter.observe(c), /package-output-changed/);
  });
  await assert.rejects(withVerificationPass(context, c => adapter.observe(c)), /package-output-changed/);
});
