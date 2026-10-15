import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../scripts/release-plan.mjs';
import { verifyCandidate } from '../scripts/candidate.mjs';
import { createFullBundleAdapter, createFullSignAdapter } from '../scripts/release-delivery-full.mjs';
import { signUpdateManifest } from '../scripts/update-manifest.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { withVerificationPass,verificationEffect } from '../scripts/release-verification-pass.mjs';

const rawJson = value => Buffer.from(JSON.stringify(value) + '\n');
function fixture() {
  const root = fileURLToPath(new URL(`../support/fixtures/full-${randomUUID()}/`, import.meta.url)); mkdirSync(root, { recursive: true });
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); const raw = Buffer.isBuffer(value) ? value : rawJson(value); writeFileSync(path, raw); return { path, sha256: sha256(raw) }; };
  const candidate = (side, base = false) => {
    const directory = join(root, side + (base ? '-base' : '-target')), commit = (side === 'private' ? 'a' : 'b').repeat(40);
    const pkg = { name: 'nova-dream-edition-3', type: 'module', version: base ? '2.3.0' : '2.4.0', edition3: { buildVersion: base ? '1.0.287' : '1.0.289', schemaVersion: 1, apiVersion: 1, appId: 'nova' } };
    put(join(directory, 'package.json'), pkg); put(join(directory, 'package-lock.json'), { version: pkg.version });
    const files = { 'dist/client/index.html': Buffer.from('<html/>'), 'dist/service/apps/service/main.js': Buffer.from(base ? 'old()' : 'changedBackend()'),
      'dist/service/apps/service/update-feed.js': readFileSync(new URL('../support/full-contract/apps/service/update-feed.js', import.meta.url)),
      'dist/service/packages/domain/software-update.js': readFileSync(new URL('../support/full-contract/packages/domain/software-update.js', import.meta.url)) };
    const artifacts = Object.entries(files).map(([name, raw]) => ({ path: name, sha256: put(join(directory, name), raw).sha256 }));
    const manifest = put(join(directory, 'dist/candidate.json'), { version: pkg.version, ...pkg.edition3, artifacts,
      frontendCompatibility: { format: 2, eligibility: 'client-behavior', sourceRevision: commit, serviceInputsSha256: (base ? 'c' : 'd').repeat(64) } });
    const verified = verifyCandidate(directory), archive = put(join(root, side + (base ? '-base' : '') + '.tgz'), Buffer.from('synthetic retained CI app archive'));
    const repository = 'HatimTheDream/Nova-Dream' + (side === 'public' ? '-Public' : ''), metadata = { candidateId: verified.id, archiveSha256: archive.sha256 };
    return { directory, applicationDirectory: directory, candidateId: verified.id, manifest, sourceCommit: commit, repository, archive,
      metadata: put(join(directory, 'metadata.json'), metadata), ciSourceReceipt: put(join(directory, 'ci.json'), { sourceCommit: commit, repository, application: metadata }), sourceHashes: {} };
  };
  const artifacts = { private: candidate('private'), public: candidate('public') }, base = candidate('private', true);
  const descriptor = { operation: { id: randomUUID(), version: '2.4.0', buildVersion: '1.0.289', priorCandidateId: base.candidateId,
    agentVersion: '2026.9.8', priorAgentVersion: '2026.9.8', sourceCommits: { private: artifacts.private.sourceCommit, public: artifacts.public.sourceCommit } },
    sources: Object.fromEntries(Object.entries(artifacts).map(([side, artifact]) => [side, { commit: artifact.sourceCommit, repository: artifact.repository }])) };
  const route = { route: 'full', baseCandidateId: base.candidateId, targetCandidateId: artifacts.private.candidateId, publicCandidateId: artifacts.public.candidateId };
  const directory = join(root, 'reviewed'), helperNames = ['install.py', 'recovery.py', 'codex_log_retention.py', 'app_dependencies.py', 'workspace_key.py', 'verify-session-bindings.mjs'];
  const helperHashes = Object.fromEntries(helperNames.map(name => {
    const reference = put(join(directory, name), Buffer.from('synthetic exact helper ' + name));
    for (const artifact of Object.values(artifacts)) artifact.sourceHashes['deploy/update-runner/' + name] = { sha256: reference.sha256 };
    return [name, reference.sha256];
  }));
  put(join(directory, 'app.tgz'), readFileSync(artifacts.private.archive.path));
  const archive = put(join(root, 'app-dependencies.tgz'), Buffer.from('synthetic dependency archive; producer is mocked'));
  const description = { format: 1, archiveBytes: readFileSync(archive.path).length, archiveSha256: archive.sha256 };
  const dependencies = { archive, description, metadata: put(join(root, 'app-dependencies.metadata.json'), description) };
  put(join(directory, 'reviewed-pair.json'), { format: 1, candidateId: artifacts.private.candidateId, priorCandidateId: base.candidateId,
    archiveSha256: artifacts.private.archive.sha256, archiveBytes: readFileSync(artifacts.private.archive.path).length,
    helpers: Object.fromEntries(Object.entries(helperHashes).filter(([name]) => name !== 'install.py')), applicationDependencies: description });
  const release = { candidateId: artifacts.private.candidateId, fromCandidateId: base.candidateId, novaVersion: '2.4.0', agentVersion: '2026.9.8', platform: 'linux', arch: 'x64', nodeMajor: 22,
    notes: ['Synthetic backend release'], compatibility: { reviewed: true, gatewayProtocol: 4, fromNovaVersion: '2.3.0', fromAgentVersion: '2026.9.8', fromSchemaVersion: 1, toSchemaVersion: 1, pluginVersion: '2.4.0' },
    recovery: { pairedSnapshot: true, independentRestore: true, readinessTimeoutSeconds: 300 } };
  const counts = { execute: 0, observe: 0 };
  const preparation = put(join(root, 'synthetic-preparation.json'), { fixtureOnly: true });
  const pairProducer = { validate: async () => {}, verify: async () => {},
    execute: async context => { counts.execute++; return pairProducer.result(context); }, observe: async context => { counts.observe++; return pairProducer.result(context); },
    result: context => ({ state: 'completed', externalId: context.intent.key, reason: 'fixture-pair', receipt: null, output: {
      kind: 'maintained-qualified-update-pair', operationId: descriptor.operation.id, key: context.intent.key, sourceCommits: descriptor.operation.sourceCommits,
      candidateId: artifacts.private.candidateId, publicCandidateId: artifacts.public.candidateId, priorCandidateId: base.candidateId, directory, dependencies, release,
      preparation } }) };
  const options = { bundleUrl: 'https://example.invalid/bundle.json', dependenciesUrl: 'https://example.invalid/dependencies.tgz' };
  const prior = { artifacts: { repositories: artifacts }, route };
  return { root, put, descriptor, artifacts, base, route, directory, dependencies, pairProducer, counts, options, prior };
}
async function packageFull(f) {
  const adapter = createFullBundleAdapter({ options: f.options, pairProducer: f.pairProducer }), input = await adapter.input({ prior: f.prior });
  const context = { descriptor: f.descriptor, intent: { input, key: randomUUID() }, journal: { directory: f.root } };
  await adapter.validate({ descriptor: f.descriptor, input }); const result = await adapter.execute(context); await adapter.verify(result, context);
  return { adapter, context, result };
}

test('full bundle calls the maintained packager and reconciles without repeating the pair producer', async () => {
  const f = fixture(), { adapter, context, result } = await packageFull(f);
  assert.equal(result.state, 'completed'); assert.equal(result.output.release.bundle.sha256, result.output.bundle.sha256);
  const resumed = await adapter.observe(context); assert.deepEqual(resumed, result); assert.equal(f.counts.execute, 1);
  const envelope = JSON.parse(readFileSync(result.output.bundle.path)); assert.ok(envelope.files.some(file => file.name === 'install.py'));
  assert.ok(!envelope.files.some(file => file.name === 'app-dependencies.tgz'));
  writeFileSync(result.output.bundle.path, 'corrupt'); await assert.rejects(adapter.observe(context), /full-bundle-output-changed/);
  assert.equal(f.counts.execute, 1);
});
test('missing qualified dependency producer stays an explicit gap and creates no bundle', async () => {
  const f = fixture(), adapter = createFullBundleAdapter({ options: f.options }), input = await adapter.input({ prior: f.prior });
  const key = randomUUID(), context = { descriptor: f.descriptor, intent: { input, key }, journal: { directory: f.root } };
  const value = await adapter.execute(context); assert.equal(value.state, 'gap'); assert.equal(value.reason, 'qualified-dependency-pair-producer-not-integrated');
  assert.equal(existsSync(join(f.root, `delivery-full-${key}.json`)), false);
});
test('changed paired helper and missing runtime block full bundle generation', async () => {
  const f = fixture(); f.artifacts.public.sourceHashes['deploy/update-runner/install.py'].sha256 = '0'.repeat(64);
  await assert.rejects(packageFull(f), /full-paired-helper-changed/);
  const runtime = fixture(); runtime.descriptor.operation.agentVersion = '2026.10.1';
  await assert.rejects(packageFull(runtime), /full-runtime-producer-required/);
});
test('retained dependency tampering blocks full bundle reconciliation without another producer effect', async () => {
  const f = fixture(), { adapter, context } = await packageFull(f);
  writeFileSync(f.dependencies.archive.path, 'tampered dependencies');
  await assert.rejects(adapter.observe(context), /full-retained-artifact-changed/); assert.equal(f.counts.execute, 1);
});
test('lost partial bundle remains uncertain and is not regenerated during observation', async () => {
  const f = fixture(), adapter = createFullBundleAdapter({ options: f.options, pairProducer: f.pairProducer }), input = await adapter.input({ prior: f.prior });
  const context = { descriptor: f.descriptor, intent: { input, key: randomUUID() }, journal: { directory: f.root } };
  const value = await adapter.observe(context); assert.equal(value.state, 'uncertain'); assert.equal(value.reason, 'original-full-bundle-incomplete');
  assert.equal(f.counts.execute, 0);
});
test('full signing uses selected maintained contract, binds actual package and never retries a missing signature', async () => {
  const f = fixture(), { result: packaged } = await packageFull(f), { publicKey } = generateKeyPairSync('ed25519');
  const publicRef = f.put(join(f.root, 'public.pem'), Buffer.from(publicKey.export({ format: 'pem', type: 'spki' })));
  const signing = { publicKey: publicRef, privateKeyPath: 'never-opened-in-this-test', previousFeed: 'initial' }, now = Date.now();
  const feed = { channel: 'stable', sequence: 1, createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400000).toISOString() };
  let signCalls = 0, observed;
  const adapter = createFullSignAdapter({ signing, feed, base: f.base, storeReceipt: (_journal, key, name, bytes) => f.put(join(f.root, key + '-' + name), bytes),
    sign: async (arguments_, contract) => { signCalls++; observed = arguments_; assert.equal(contract.updateFeedLimits.maxBytes, 131072); throw Error('synthetic-sign-call-stopped'); } });
  const input = await adapter.input({ prior: { package: packaged.output } }), key = randomUUID(), context = { descriptor: f.descriptor, intent: { input, key }, journal: { directory: f.root } };
  f.descriptor.operation.trustedPublicKeySha256 = '0'.repeat(64); await assert.rejects(adapter.validate({ descriptor: f.descriptor, input }), /trusted-signing-key-changed/);
  assert.equal(signCalls, 0); f.descriptor.operation.trustedPublicKeySha256 = publicRef.sha256;
  await adapter.validate({ descriptor: f.descriptor, input });
  await assert.rejects(adapter.execute(context), /synthetic-sign-call-stopped/);
  assert.equal(signCalls, 1); assert.equal(observed.privateKeyFile, signing.privateKeyPath); assert.equal(observed.previous, 'initial');
  const absent = await adapter.observe(context); assert.equal(absent.state, 'uncertain'); assert.equal(signCalls, 1);
  const manifest = JSON.parse(readFileSync(observed.input));
  f.put(join(f.root, `delivery-full-signature-${key}.json`), { payload: Buffer.from(JSON.stringify(manifest)).toString('base64'), signature: Buffer.alloc(64).toString('base64') });
  await assert.rejects(adapter.observe(context), /full-signature-invalid/); assert.equal(signCalls, 1);
  input.package.release.novaVersion = '9.9.9';
  await assert.rejects(adapter.validate({ descriptor: f.descriptor, input }), /full-signing-release-changed/); assert.equal(signCalls, 1);
  input.package.release.novaVersion = f.descriptor.operation.version;
  writeFileSync(join(f.base.directory, 'dist/service/apps/service/update-feed.js'), 'changed selected contract');
  await assert.rejects(adapter.validate({ descriptor: f.descriptor, input }), /Rebuild before starting/); assert.equal(signCalls, 1);
});
test('actual maintained signing with disposable Ed25519 keys verifies and observes without resigning', async t => {
  const f = fixture(), { result: packaged } = await packageFull(f), parent = resolve(tmpdir());
  const owned = mkdtempSync(join(parent, 'nova-m2-disposable-sign-'));
  t.after(() => { assert.equal(dirname(owned), parent); assert.ok(resolve(owned).startsWith(parent + sep)); rmSync(owned, { recursive: true, force: true }); });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPath = join(owned, 'disposable-only.pem');
  writeFileSync(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
  const publicRef = f.put(join(f.root, 'disposable-public.pem'), Buffer.from(publicKey.export({ format: 'pem', type: 'spki' })));
  const signing = { publicKey: publicRef, privateKeyPath, previousFeed: 'initial' }, now = Date.now();
  const feed = { channel: 'stable', sequence: 1, createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400000).toISOString() };
  f.descriptor.operation.trustedPublicKeySha256 = publicRef.sha256;
  let signingCalls = 0;
  const storeReceipt = (_journal, key, name, bytes) => f.put(join(f.root, key + '-' + name), bytes);
  const sign = async (options, contract) => { signingCalls++; return signUpdateManifest(options, contract); };
  const adapter = createFullSignAdapter({ signing, feed, base: f.base, storeReceipt, sign });
  const input = await adapter.input({ prior: { package: packaged.output } }), key = randomUUID();
  const context = { descriptor: f.descriptor, intent: { input, key }, journal: { directory: f.root } };
  const completed = await adapter.execute(context); await adapter.verify(completed, context);
  assert.equal(completed.state, 'completed'); assert.equal(signingCalls, 1);
  const open=fs.openSync,readCounts=new Map([[resolve(packaged.output.bundle.path),0],[resolve(packaged.output.dependencies.archive.path),0]]);
  fs.openSync=function(path,...args){const key=typeof path==='string'?resolve(path):null;if(readCounts.has(key))readCounts.set(key,readCounts.get(key)+1);return open.call(this,path,...args);};syncBuiltinESMExports();
  try{
   await withVerificationPass({...context,input},async c=>{
    await adapter.validate(c);await adapter.verify(completed,c);
    assert.deepEqual([...readCounts.values()],[1,1]);
    await verificationEffect(c,async()=>{});await adapter.validate(c);await adapter.verify(completed,c);
    assert.deepEqual([...readCounts.values()],[2,2]);
   });
   await adapter.observe(context);assert.deepEqual([...readCounts.values()],[3,3]);
  }finally{fs.openSync=open;syncBuiltinESMExports();}
  const signedBytes = readFileSync(completed.output.signedFeed.path);
  unlinkSync(privateKeyPath);
  const observed = await adapter.observe(context); assert.deepEqual(observed, completed); assert.equal(signingCalls, 1);
  const changed = JSON.parse(signedBytes); changed.signature = Buffer.alloc(64).toString('base64');
  writeFileSync(completed.output.signedFeed.path, rawJson(changed));
  await assert.rejects(adapter.observe(context), /full-signature-invalid/); assert.equal(signingCalls, 1);
  writeFileSync(completed.output.signedFeed.path, signedBytes);
  const wrong = generateKeyPairSync('ed25519'), wrongPath = join(owned, 'wrong-disposable.pem');
  writeFileSync(wrongPath, wrong.privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
  const wrongSigning = { ...signing, privateKeyPath: wrongPath };
  const wrongAdapter = createFullSignAdapter({ signing: wrongSigning, feed, base: f.base, storeReceipt, sign });
  const wrongInput = await wrongAdapter.input({ prior: { package: packaged.output } }), wrongKey = randomUUID();
  await assert.rejects(wrongAdapter.execute({ ...context, intent: { input: wrongInput, key: wrongKey } }), /does not match the provisioned public key/);
  assert.equal(signingCalls, 2); assert.equal(existsSync(join(f.root, `delivery-full-signature-${wrongKey}.json`)), false);
  await adapter.verify(completed, context); assert.equal(signingCalls, 2);
});
