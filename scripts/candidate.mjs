import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const regular = path => { assert.ok(lstatSync(path).isFile(), 'Candidate entries must be regular files.'); return readFileSync(path); };

/** Validate the complete built candidate without creating files. */
export function verifyCandidate(workspace) {
  const root = resolve(workspace), pkgBytes = regular(join(root, 'package.json'));
  const pkg = JSON.parse(pkgBytes), manifestBytes = regular(join(root, 'dist/candidate.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(pkg.name, 'nova-dream-edition-3');
  for (const key of ['version', 'buildVersion', 'schemaVersion', 'apiVersion', 'appId']) assert.equal(manifest[key], key === 'version' ? pkg.version : pkg.edition3[key], `Rebuild before starting: ${key} changed.`);
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, 'Build a paired candidate first.');
  const bytes = new Map([['package.json', pkgBytes], ['dist/candidate.json', manifestBytes]]);
  for (const artifact of manifest.artifacts) {
    assert.ok(typeof artifact.path === 'string' && /^dist\/(client|service|desktop)\/[a-zA-Z0-9_./-]+$/.test(artifact.path) && !artifact.path.split('/').some(p => p === '..' || p === '.' || !p), 'Invalid candidate path.');
    assert.ok(!bytes.has(artifact.path), 'Duplicate candidate path.');
    // Every path component must remain inside the owned build tree, without symlinks.
    const parts = artifact.path.split('/');
    for (let n = 1; n <= parts.length; n++) assert.ok(!lstatSync(join(root, ...parts.slice(0, n))).isSymbolicLink(), 'Candidate symlinks are unsupported.');
    const data = regular(join(root, artifact.path));
    assert.equal(sha(data), artifact.sha256, `Rebuild before starting: ${artifact.path} changed.`);
    bytes.set(artifact.path, data);
  }
  assert.ok(bytes.has('dist/client/index.html') && bytes.has('dist/service/apps/service/main.js'), 'Both client and service are required.');
  if (manifest.desktopFormat !== undefined) {
    assert.equal(manifest.desktopFormat, 1, 'Unsupported desktop candidate format.');
    for (const name of ['main.cjs', 'preload.cjs', 'external.cjs', 'launch-policy.cjs', 'lynx-mark.png', 'lynx-mark.provenance.json']) assert.ok(bytes.has('dist/desktop/' + name), `Desktop artifact is missing: ${name}`);
  }
  if (pkg.edition3.schemaVersion >= 20) {
    const plugin = 'dist/service/apps/service/worker-plugin/';
    for (const path of ['index.js', 'identity.js', 'journal.js', 'openclaw.plugin.json', 'package.json'].map(name => plugin + name).concat(['dist/service/apps/service/assignments.js', 'dist/service/apps/service/runtime-child.js', 'dist/service/packages/domain/worker.js'])) assert.ok(bytes.has(path), `Rebuild before starting: assignment runtime artifact is missing: ${path}`);
    const metadata = JSON.parse(bytes.get(plugin + 'openclaw.plugin.json')), packageMetadata = JSON.parse(bytes.get(plugin + 'package.json'));
    assert.equal(metadata.id, 'edition3-worker', 'The assignment plugin identity changed.');
    assert.deepEqual(packageMetadata.openclaw?.extensions, ['./index.js'], 'The assignment plugin entry is not paired with this candidate.');
  }
  const id = sha(Buffer.concat([pkgBytes, manifestBytes]));
  return { root, id, manifest, bytes };
}

/** Freeze verified build bytes; never overwrite a previously frozen candidate. */
export function stageCandidate(workspace) {
  const { root, id, manifest, bytes } = verifyCandidate(workspace);
  const parent = join(root, '.launcher/candidates'), target = join(parent, id);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const verify = () => {
    assert.ok(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink(), 'Invalid frozen candidate directory.');
    for (const [path, expected] of bytes) {
      const parts = path.split('/');
      for (let n = 1; n <= parts.length; n++) assert.ok(!lstatSync(join(target, ...parts.slice(0, n))).isSymbolicLink(), 'Frozen candidate symlinks are unsupported.');
      assert.ok(regular(join(target, path)).equals(expected), `Frozen candidate changed: ${path}. It was left untouched.`);
    }
  };
  if (existsSync(target)) { verify(); return { root: target, id, manifest }; }
  const staging = join(parent, `.staging-${randomUUID()}`);
  try {
    mkdirSync(staging, { mode: 0o700 });
    for (const [path, data] of bytes) { mkdirSync(dirname(join(staging, path)), { recursive: true, mode: 0o700 }); writeFileSync(join(staging, path), data, { flag: 'wx', mode: 0o600 }); }
    try { renameSync(staging, target); } catch (error) { if (!existsSync(target)) throw error; }
    verify();
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return { root: target, id, manifest };
}
