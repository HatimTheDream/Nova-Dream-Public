import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeFrontendCompatibility, frontendAssetPath, frontendIdentity, frontendRegular, sha256, validateFrontendManifest } from '../scripts/frontend-contract.mjs';

const gitBinary = process.env.GIT_BINARY ?? 'git';
const write = (root, path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
const json = value => JSON.stringify(value, null, 2) + '\n';
export function compatibilityFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'nova-frontend-contract-')), root = join(parent, 'source'); mkdirSync(root);
  const pkg = { name: 'nova-dream-edition-3', version: '2.3.0', edition3: { buildVersion: '1.0.287', apiVersion: 1, schemaVersion: 1, appId: 'private.novadream.edition3.preview' } };
  write(root, 'package.json', json(pkg)); write(root, 'package-lock.json', json({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version }, 'node_modules/runtime': { version: '1.0.0', integrity: 'original' } } }));
  write(root, 'release.json', json({ version: pkg.version, ...pkg.edition3, channel: 'local-preview', publishing: false, installation: false }));
  for (const [path, bytes] of Object.entries({ '.gitignore': 'dist/\n', 'vite.config.ts': 'export default {};\n', 'scripts/budget.mjs': 'captureInputs();\n', 'scripts/start.mjs': 'start();\n', 'apps/client/src/App.tsx': 'export const App = () => "saved";\n', 'apps/client/src/styles.css': 'body { color: black }\n', 'apps/client/public/icon.png': 'image', 'apps/service/main.ts': 'start();\n', 'apps/desktop/main.cjs': 'desktop();\n', 'deploy/update-runner/install.py': 'install()\n', '.github/workflows/quality.yml': 'canonical\n', 'README.md': 'Version-2.3.0-blue\n', 'CHANGELOG.md': '2.3.0\n', 'docs/process.md': 'read-only\n', 'tests/source.test.ts': 'test();\n', 'dist/service/apps/service/main.js': 'start();\n', 'dist/desktop/main.cjs': 'desktop();\n' })) write(root, path, bytes);
  const git = args => execFileSync(gitBinary, ['-C', root, ...args], { stdio: 'pipe', windowsHide: true });
  git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']); git(['add', '.']); git(['commit', '-qm', 'fixture']);
  return { root, parent, pkg, write: (path, bytes) => write(root, path, bytes), close: () => rmSync(parent, { recursive: true, force: true }) };
}

export function exampleFrontendManifest() {
  const files = [{ path: '.vite/manifest.json', bytes: 2, sha256: sha256('{}') }, { path: 'assets/app.js', bytes: 7, sha256: sha256('start()') }, { path: 'index.html', bytes: 7, sha256: sha256('<html/>') }];
  return { format: 1, kind: 'frontend', channel: 'frontend-stable', sequence: 1, createdAt: '2026-10-05T16:00:00.000Z', expiresAt: '2026-10-12T16:00:00.000Z', frontendId: frontendIdentity(files), frontendVersion: '2.3.0', frontendBuildVersion: '1.0.287', sourceRevision: 'a'.repeat(40), base: { candidateId: 'b'.repeat(64), serviceInputsSha256: 'c'.repeat(64), apiVersion: 1, schemaVersion: 55 }, artifact: { url: 'https://example.invalid/frontend.tgz', bytes: 250, sha256: 'd'.repeat(64) }, files };
}

test('format 2 admits browser behavior, presentation and version bumps while binding nonclient inputs', () => {
  const f = compatibilityFixture();
  try {
    const original = computeFrontendCompatibility(f.root);
    assert.equal(original.format, 2); assert.equal(original.eligibility, 'client-behavior');
    f.write('apps/client/src/styles.css', 'body { color: red }\n'); f.write('apps/client/public/icon.png', 'new image');
    for (const path of ['apps/client/src/App.tsx', 'apps/client/src/action.ts', 'apps/client/src/action.js', 'apps/client/src/action.jsx', 'apps/client/src/action.mjs', 'apps/client/index.html']) {
      f.write(path, 'changed browser behavior');
      assert.equal(computeFrontendCompatibility(f.root).serviceInputsSha256, original.serviceInputsSha256, path);
    }
    f.pkg.version = '2.3.1'; f.pkg.edition3.buildVersion = '1.0.288'; f.write('package.json', json(f.pkg));
    const lock = JSON.parse(readFileSync(join(f.root, 'package-lock.json'))); lock.version = lock.packages[''].version = f.pkg.version; f.write('package-lock.json', json(lock));
    f.write('release.json', json({ version: f.pkg.version, ...f.pkg.edition3, channel: 'local-preview', publishing: false, installation: false }));
    f.write('README.md', 'Version-2.3.1-blue\n'); f.write('CHANGELOG.md', '2.3.1 new colors\n');
    assert.equal(computeFrontendCompatibility(f.root).serviceInputsSha256, original.serviceInputsSha256);
    f.write('updates/stable.json', 'new signed publication output'); assert.equal(computeFrontendCompatibility(f.root).serviceInputsSha256, original.serviceInputsSha256);
    for (const path of ['apps/service/main.ts', 'apps/desktop/main.cjs', 'packages/domain/index.ts', 'scripts/start.mjs', 'deploy/update-runner/install.py', '.github/workflows/quality.yml', 'vite.config.ts', 'hidden-build-input.txt', 'apps/client/config.ts', 'apps/client/src/unknown.json', 'apps/client/public/untrusted.svg', 'updates/release-public.pem', 'updates/unknown.json', ...['api.ts', 'client-identity.ts', 'upload-body.ts', 'conditional-reads.ts'].map(name => 'apps/client/src/' + name)]) {
      const saved = (() => { try { return readFileSync(join(f.root, path)); } catch { return null; } })();
      f.write(path, 'changed behavior'); assert.notEqual(computeFrontendCompatibility(f.root).serviceInputsSha256, original.serviceInputsSha256, path);
      if (saved) f.write(path, saved); else rmSync(join(f.root, path));
    }
  } finally { f.close(); }
});

test('private edition3 layout binds external CI workflows while keeping private operational records outside the capsule', () => {
  const f = compatibilityFixture();
  try {
    const app = join(f.root, 'edition3'); mkdirSync(app);
    for (const entry of readdirSync(f.root)) if (!['.git', 'edition3'].includes(entry)) renameSync(join(f.root, entry), join(app, entry));
    write(f.root, '.github/workflows/release.yml', 'canonical private route');
    const git = args => execFileSync(gitBinary, ['-C', f.root, ...args], { stdio: 'pipe', windowsHide: true }); git(['add', '-A']); git(['commit', '-qm', 'private layout']);
    const original = computeFrontendCompatibility(app).serviceInputsSha256;
    write(f.root, 'docs/edition-3/CURRENT-STATE.md', 'private owner operations');
    assert.equal(computeFrontendCompatibility(app).serviceInputsSha256, original);
    write(f.root, '.github/workflows/release.yml', 'changed CI build'); assert.notEqual(computeFrontendCompatibility(app).serviceInputsSha256, original);
  } finally { f.close(); }
});

test('source input reader refuses hardlinks rather than trusting a second mutable file identity', () => {
  const parent = mkdtempSync(join(tmpdir(), 'nova-frontend-links-'));
  try { writeFileSync(join(parent, 'source'), 'original'); linkSync(join(parent, 'source'), join(parent, 'second')); assert.throws(() => frontendRegular(join(parent, 'source')), /independent regular/); }
  finally { rmSync(parent, { recursive: true, force: true }); }
});

test('compiled and dependency changes are incompatible; version mismatches refuse instead of normalizing', () => {
  const f = compatibilityFixture();
  try {
    const original = computeFrontendCompatibility(f.root).serviceInputsSha256;
    f.write('dist/service/apps/service/main.js', 'different runtime'); assert.notEqual(computeFrontendCompatibility(f.root).serviceInputsSha256, original); f.write('dist/service/apps/service/main.js', 'start();\n');
    f.write('dist/desktop/main.cjs', 'changed desktop'); assert.notEqual(computeFrontendCompatibility(f.root).serviceInputsSha256, original); f.write('dist/desktop/main.cjs', 'desktop();\n');
    f.write('dist/service/imported-client.js', 'client code imported by service'); assert.notEqual(computeFrontendCompatibility(f.root).serviceInputsSha256, original); rmSync(join(f.root, 'dist/service/imported-client.js'));
    const lock = JSON.parse(readFileSync(join(f.root, 'package-lock.json'))); lock.packages['node_modules/runtime'].version = '2.0.0'; f.write('package-lock.json', json(lock)); assert.notEqual(computeFrontendCompatibility(f.root).serviceInputsSha256, original);
    lock.packages[''].version = 'wrong'; f.write('package-lock.json', json(lock)); assert.throws(() => computeFrontendCompatibility(f.root), /root version/);
    lock.packages[''].version = f.pkg.version; f.write('package-lock.json', json(lock));
    const release = JSON.parse(readFileSync(join(f.root, 'release.json'))); release.schemaVersion++; f.write('release.json', json(release)); assert.throws(() => computeFrontendCompatibility(f.root), /compatibility metadata/);
  } finally { f.close(); }
});

test('manifest admission binds exact complete files and rejects unsafe paths, authority fields and expiry', () => {
  const manifest = exampleFrontendManifest(), now = Date.parse('2026-10-05T16:01:00Z');
  assert.equal(validateFrontendManifest(manifest, { now }), manifest);
  for (const path of ['../secret', '/api/key', 'assets/../../key.js', '.env', 'assets/.hidden.js', 'other.html', 'assets/secret.json', 'assets/source.map', 'assets/x\\y.js']) assert.equal(frontendAssetPath(path), false, path);
  assert.throws(() => validateFrontendManifest({ ...manifest, unknown: true }, { now }), /fields/);
  assert.throws(() => validateFrontendManifest({ ...manifest, frontendId: '0'.repeat(64) }, { now }), /identity/);
  assert.throws(() => validateFrontendManifest({ ...manifest, files: [...manifest.files].reverse() }, { now }), /unordered/);
  assert.throws(() => validateFrontendManifest({ ...manifest, artifact: { ...manifest.artifact, url: 'https://example.invalid/file?secret=token' } }, { now }), /HTTPS/);
  assert.throws(() => validateFrontendManifest(manifest, { now: Date.parse('2026-11-01T00:00:00Z') }), /not current/);
  assert.equal(validateFrontendManifest(manifest, { admission: false }), manifest);
});

test('frontend identity canonicalizes file field order without changing the validated inventory', () => {
  const manifest = exampleFrontendManifest(), reordered = manifest.files.map(({ path, bytes, sha256 }) => ({ sha256, bytes, path }));
  assert.equal(frontendIdentity(reordered), manifest.frontendId);
  assert.equal(validateFrontendManifest({ ...manifest, files: reordered }, { now: Date.parse('2026-10-05T16:01:00Z') }).frontendId, manifest.frontendId);
  assert.deepEqual(Object.keys(reordered[0]), ['sha256', 'bytes', 'path']);
});
