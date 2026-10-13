import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { computeFrontendCompatibility, sha256, walkFrontendFiles } from '../scripts/frontend-contract.mjs';
import { verifyCandidate } from '../scripts/candidate.mjs';
import { packageFrontend, packageRetained, signFrontend } from '../scripts/frontend-package.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const write = (root, path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'nova-frontend-package-'));
  const create = name => {
    const root = join(parent, name); mkdirSync(root);
    const pkg = { name: 'nova-dream-edition-3', version: '2.3.0', edition3: { buildVersion: '1.0.287', apiVersion: 1, schemaVersion: 1, appId: 'private.novadream.edition3.preview' } };
    write(root, 'package.json', json(pkg)); write(root, 'package-lock.json', json({ version: pkg.version, packages: { '': { name: pkg.name, version: pkg.version } } })); write(root, 'release.json', json({ version: pkg.version, ...pkg.edition3 }));
    for (const [path, bytes] of Object.entries({ '.gitignore': 'dist/\n', 'vite.config.ts': 'relativeAssets();\n', 'scripts/budget.mjs': 'compatibility();\n', 'apps/client/src/App.tsx': 'safe();\n', 'apps/client/src/styles.css': 'body{color:black}', 'apps/service/main.ts': 'start();\n', 'apps/desktop/main.cjs': 'desktop();\n', 'dist/service/apps/service/main.js': 'start();\n', 'dist/desktop/main.cjs': 'desktop();\n', 'dist/client/index.html': '<html><script src="./assets/app.js"></script></html>', 'dist/client/.vite/manifest.json': '{}', 'dist/client/assets/app.js': 'start();', 'dist/client/assets/app.css': 'body{color:black}' })) write(root, path, bytes);
    const git = args => execFileSync(process.env.GIT_BINARY ?? 'git', ['-C', root, ...args], { stdio: 'pipe', windowsHide: true });
    git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']); git(['add', '.']); git(['commit', '-qm', 'fixture']);
    const build = (directory = root) => {
      const metadata = JSON.parse(readFileSync(join(directory, 'release.json'))), artifacts = [];
      for (const tree of ['dist/client', 'dist/service', 'dist/desktop']) for (const path of walkFrontendFiles(join(directory, tree))) artifacts.push({ path: `${tree}/${path}`, sha256: sha256(readFileSync(join(directory, tree, path))) });
      write(directory, 'dist/candidate.json', json({ ...metadata, frontendCompatibility: computeFrontendCompatibility(directory), artifacts }));
    };
    const commit = () => { git(['add', '.']); git(['commit', '-qm', 'changed fixture source']); };
    build(); return { root, build, commit, git, write: (path, bytes) => write(root, path, bytes) };
  };
  return { parent, base: create('base'), source: create('source'), close: () => rmSync(parent, { recursive: true, force: true }) };
}
const options = f => ({ workspace: f.source.root, baseWorkspace: f.base.root, outputDirectory: join(f.parent, 'release'), artifactUrl: 'https://example.invalid/frontend.tgz', sequence: 1 });

test('packaging signs changed browser behavior and emits a complete deterministic regular-file archive', () => {
  const f = fixture();
  try {
    f.source.write('apps/client/src/styles.css', 'body{color:red}'); f.source.write('dist/client/assets/app.css', 'body{color:red}');
    f.source.write('apps/client/src/App.tsx', 'newBrowserAction();'); f.source.write('dist/client/assets/app.js', 'newBrowserAction();'); f.source.commit(); f.source.build();
    const result = packageFrontend(options(f)), manifestPath = join(f.parent, 'release/frontend.json'), raw = readFileSync(manifestPath), manifest = JSON.parse(raw), archive = readFileSync(join(f.parent, 'release/frontend.tgz'));
    assert.equal(result.frontendId, manifest.frontendId); assert.equal(sha256(archive), manifest.artifact.sha256); assert.equal(raw.toString(), JSON.stringify(manifest) + '\n');
    const tar = gunzipSync(archive), extracted = [];
    for (let offset = 0; tar[offset];) {
      const header = tar.subarray(offset, offset + 512), path = header.subarray(0, 100).toString().split('\0')[0], bytes = parseInt(header.subarray(124, 136).toString().replace(/\0/g, ''), 8);
      assert.equal(header[156], 48); extracted.push({ path, bytes, sha256: sha256(tar.subarray(offset + 512, offset + 512 + bytes)) }); offset += 512 + Math.ceil(bytes / 512) * 512;
    }
    assert.deepEqual(extracted, manifest.files);
    const again = packageFrontend({ ...options(f), outputDirectory: join(f.parent, 'second'), createdAt: manifest.createdAt, expiresAt: manifest.expiresAt });
    assert.equal(again.archive.sha256, result.archive.sha256); assert.equal(again.manifest.sha256, result.manifest.sha256);
    assert.throws(() => packageFrontend(options(f)), /new frontend output/);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(join(f.parent, 'key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }); writeFileSync(join(f.parent, 'public.pem'), publicKey.export({ format: 'pem', type: 'spki' }));
    const signed = signFrontend({ workspace: f.source.root, input: manifestPath, privateKeyFile: join(f.parent, 'key.pem'), publicKeyFile: join(f.parent, 'public.pem'), output: join(f.parent, 'signature.bin'), previousManifest: 'initial' });
    assert.equal(signed.signatureBytes, 64); assert.ok(verify(null, raw, publicKey, readFileSync(join(f.parent, 'signature.bin'))));
    assert.throws(() => signFrontend({ workspace: f.source.root, input: manifestPath, privateKeyFile: join(f.parent, 'key.pem'), publicKeyFile: join(f.parent, 'public.pem'), output: join(f.parent, 'replayed.bin'), previousManifest: manifestPath, previousSignature: join(f.parent, 'signature.bin') }), /Advance/);
    assert.equal(existsSync(join(f.parent, 'replayed.bin')), false);
  } finally { f.close(); }
});

test('backend changes and stale or unverified build bytes refuse before output', () => {
  const f = fixture();
  try {
    f.source.write('apps/service/main.ts', 'different behavior'); f.source.commit(); f.source.build();
    assert.throws(() => packageFrontend(options(f)), /full delivery route/); assert.equal(existsSync(join(f.parent, 'release')), false);
    f.source.write('apps/service/main.ts', 'start();\n'); f.source.commit(); f.source.build(); f.source.write('dist/client/extra.js', 'not included');
    assert.throws(() => packageFrontend(options(f)), /unverified or missing/); rmSync(join(f.source.root, 'dist/client/extra.js'));
    f.source.write('dist/client/assets/app.js', 'different hash'); assert.throws(() => packageFrontend(options(f)), /Rebuild before/);
    f.source.write('dist/client/assets/app.js', 'start();'); f.source.build(); f.source.write('scripts/budget.mjs', 'changed build');
    assert.throws(() => packageFrontend(options(f)), /clean committed/); assert.equal(existsSync(join(f.parent, 'release')), false);
  } finally { f.close(); }
});

test('the expanded route never reinterprets a presentation-only base capsule', () => {
  const f = fixture();
  try {
    const path = join(f.base.root, 'dist/candidate.json'), manifest = JSON.parse(readFileSync(path));
    manifest.frontendCompatibility.format = 1; manifest.frontendCompatibility.eligibility = 'presentation-only';
    writeFileSync(path, json(manifest));
    assert.throws(() => packageFrontend(options(f)), /compatibility capsule/);
    assert.equal(existsSync(join(f.parent, 'release')), false);
  } finally { f.close(); }
});

test('signing requires exact canonical bytes, current admission and the provisioned external key', () => {
  const f = fixture();
  try {
    packageFrontend(options(f)); const input = join(f.parent, 'release/frontend.json'), raw = readFileSync(input), manifest = JSON.parse(raw);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
    writeFileSync(join(f.parent, 'key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }); writeFileSync(join(f.parent, 'public.pem'), publicKey.export({ format: 'pem', type: 'spki' })); writeFileSync(join(f.parent, 'other.pem'), other.publicKey.export({ format: 'pem', type: 'spki' }));
    const call = extra => signFrontend({ workspace: f.source.root, input, privateKeyFile: join(f.parent, 'key.pem'), publicKeyFile: join(f.parent, 'public.pem'), output: join(f.parent, 'refused.bin'), previousManifest: 'initial', ...extra });
    assert.throws(() => call({ publicKeyFile: join(f.parent, 'other.pem') }), /does not match/);
    writeFileSync(input, json(manifest)); assert.throws(() => call(), /canonical/);
    manifest.sequence = 2; writeFileSync(input, JSON.stringify(manifest) + '\n'); assert.throws(() => call(), /sequence1/);
    assert.equal(existsSync(join(f.parent, 'refused.bin')), false);
    writeFileSync(input, raw); f.source.write('private-key.pem', privateKey.export({ format: 'pem', type: 'pkcs8' })); assert.throws(() => call({ privateKeyFile: join(f.source.root, 'private-key.pem') }), /outside application/);
  } finally { f.close(); }
});

test('retained canonical CI mode binds operator-reviewed raw receipt, original archive and exact candidate without Git/rebuild', () => {
  const f = fixture();
  try {
    for (const source of [f.base, f.source]) { source.write('scripts/candidate.mjs', 'fixture canonical verifier'); source.build(); }
    const candidate = verifyCandidate(f.source.root), archive = Buffer.from('synthetic canonical archive fixture'), archivePath = join(f.parent, 'app.tgz'), receiptPath = join(f.parent, 'ci-source.json'); writeFileSync(archivePath, archive);
    const receipt = { format: 1, kind: 'canonical-ci-built-candidate', sourceCommit: candidate.manifest.frontendCompatibility.sourceRevision, repository: 'HatimTheDream/Nova-Dream', runId: '123456', runAttempt: '1', toolchain: { nodeVersion: '22.23.2', platform: 'linux', arch: 'x64' }, nodeSha256: 'a'.repeat(64), packagerSha256: 'b'.repeat(64), candidateVerifierSha256: sha256('fixture canonical verifier'), application: { format: 1, candidateId: candidate.id, archiveBytes: archive.length, archiveSha256: sha256(archive), expandedBytes: 1024, fileCount: 12, packageLockSha256: sha256(readFileSync(join(f.source.root, 'package-lock.json'))), version: candidate.manifest.version, buildVersion: candidate.manifest.buildVersion, schemaVersion: candidate.manifest.schemaVersion, apiVersion: candidate.manifest.apiVersion }, rebuilt: false, deliveryQualification: false };
    const saveReceipt = value => { const raw = Buffer.from(json(value)); writeFileSync(receiptPath, raw); return sha256(raw); };
    const receiptSha = saveReceipt(receipt), call = extra => packageRetained({ ...options(f), applicationArchive: archivePath, ciSourceReceipt: receiptPath, approvedReceiptSha256: receiptSha, ...extra });
    assert.throws(() => call({ approvedReceiptSha256: '0'.repeat(64) }), /operator-reviewed/);
    for (const mutation of [value => { value.sourceCommit = 'f'.repeat(40); }, value => { value.application.candidateId = 'f'.repeat(64); }, value => { value.toolchain.nodeVersion = '24.0.0'; }, value => { value.deliveryQualification = true; }, value => { value.runAttempt = 1; }, value => { value.repository = 'someone/other'; }]) {
      const changed = structuredClone(receipt); mutation(changed); const approvedReceiptSha256 = saveReceipt(changed); assert.throws(() => call({ approvedReceiptSha256 })); assert.equal(existsSync(join(f.parent, 'release')), false);
    }
    saveReceipt(receipt); writeFileSync(archivePath, 'changed original archive'); assert.throws(() => call(), /original canonical/); writeFileSync(archivePath, archive);
    f.source.write('dist/service/unverified.js', 'extra'); assert.throws(() => call(), /compiled closure/); rmSync(join(f.source.root, 'dist/service/unverified.js'));
    rmSync(join(f.source.root, '.git'), { recursive: true });
    const result = call(); assert.equal(result.verification.mode, 'retained-canonical-ci'); assert.equal(result.verification.deliveryQualification, false); assert.equal(result.verification.receiptSha256, receiptSha); assert.equal(result.frontendId.length, 64);
  } finally { f.close(); }
});

test('source mode refuses unstaged, staged, untracked and CI workflow changes before any package output', () => {
  for (const mutation of ['unstaged', 'staged', 'untracked', 'workflow']) {
    const f = fixture();
    try {
      if (mutation === 'untracked') f.source.write('new-build-input.txt', 'uncommitted input');
      else if (mutation === 'workflow') f.source.write('.github/workflows/quality.yml', 'uncommitted CI input');
      else f.source.write('apps/client/src/styles.css', 'body{color:red}');
      if (mutation === 'staged') f.source.git(['add', 'apps/client/src/styles.css']);
      assert.throws(() => packageFrontend(options(f)), /clean committed/, mutation);
      assert.equal(existsSync(join(f.parent, 'release')), false, mutation);
    } finally { f.close(); }
  }
});

test('private source packaging preserves outer operational staging while refusing root CI workflow changes', () => {
  const f = fixture();
  try {
    const repository = f.source.root, app = join(repository, 'edition3'); mkdirSync(app);
    for (const entry of readdirSync(repository)) if (!['.git', 'edition3'].includes(entry)) renameSync(join(repository, entry), join(app, entry));
    write(repository, 'docs/CURRENT-STATE.md', 'private operation record'); f.source.commit(); f.source.root = app; f.source.build(app);
    write(repository, 'docs/CURRENT-STATE.md', 'unrelated staged owner work'); f.source.git(['add', 'docs/CURRENT-STATE.md']);
    const staged = f.source.git(['diff', '--cached', '--', 'docs/CURRENT-STATE.md']);
    assert.equal(packageFrontend(options(f)).verification.mode, 'source-verified');
    assert.deepEqual(f.source.git(['diff', '--cached', '--', 'docs/CURRENT-STATE.md']), staged);
    write(repository, '.github/workflows/release.yml', 'changed root CI workflow');
    const outputDirectory = join(f.parent, 'blocked'); assert.throws(() => packageFrontend({ ...options(f), outputDirectory }), /clean committed/); assert.equal(existsSync(outputDirectory), false);
    f.source.git(['add', '.github/workflows/release.yml']); assert.throws(() => packageFrontend({ ...options(f), outputDirectory }), /clean committed/); assert.deepEqual(f.source.git(['diff', '--cached', '--', 'docs/CURRENT-STATE.md']), staged);
  } finally { f.close(); }
});
