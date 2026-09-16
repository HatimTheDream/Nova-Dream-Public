import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stageCandidate } from '../scripts/candidate.mjs';
const digest = text => createHash('sha256').update(text).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'edition3-candidate-')));
  const pkg = { name: 'nova-dream-edition-3', type: 'module', version: '0.9.1', edition3: { buildVersion: '1.0.13', schemaVersion: 3, apiVersion: 1, appId: 'private.novadream.edition3.preview' } };
  const files = { 'dist/client/index.html': '<h1>First candidate</h1>', 'dist/service/apps/service/main.js': 'console.log(JSON.stringify({cwd:process.cwd(),data:process.env.E3_DATA_DIR,candidateId:process.env.E3_CANDIDATE_ID}));' };
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  put('package.json', JSON.stringify(pkg));
  const manifest = { version: pkg.version, ...pkg.edition3, artifacts: Object.entries(files).map(([path, text]) => ({ path, sha256: digest(text) })) };
  const saveManifest = () => put('dist/candidate.json', JSON.stringify(manifest));
  for (const [path, text] of Object.entries(files)) put(path, text);
  saveManifest();
  return { root, pkg, manifest, put, saveManifest, close() { rmSync(root, { recursive: true, force: true }); } };
}
test('frozen client and service bytes survive later builds and reuse the same verified candidate', () => {
  const f = fixture(); try {
    const first = stageCandidate(f.root); assert.equal(stageCandidate(f.root).id, first.id);
    f.put('dist/client/index.html', '<h1>Second candidate</h1>');
    assert.throws(() => stageCandidate(f.root), /Rebuild before starting/);
    assert.equal(readFileSync(join(first.root, 'dist/client/index.html'), 'utf8'), '<h1>First candidate</h1>');
    f.manifest.artifacts[0].sha256 = digest('<h1>Second candidate</h1>'); f.saveManifest();
    const second = stageCandidate(f.root); assert.notEqual(first.id, second.id);
    rmSync(join(f.root, 'dist'), { recursive: true });
    assert.equal(readFileSync(join(first.root, 'dist/client/index.html'), 'utf8'), '<h1>First candidate</h1>');
    assert.equal(readFileSync(join(second.root, 'dist/client/index.html'), 'utf8'), '<h1>Second candidate</h1>');
  } finally { f.close(); }
});
test('stale metadata cannot start a mixed version', () => {
  const f = fixture(); try { f.pkg.version = '0.10.0'; f.put('package.json', JSON.stringify(f.pkg)); assert.throws(() => stageCandidate(f.root), /version changed/); } finally { f.close(); }
});
test('an assignment-capable candidate requires the compiled worker and its actual native plugin metadata', () => {
  const f = fixture();
  try {
    f.pkg.edition3.schemaVersion = 20; f.manifest.schemaVersion = 20; f.put('package.json', JSON.stringify(f.pkg)); f.saveManifest();
    assert.throws(() => stageCandidate(f.root), /assignment runtime artifact is missing/);
    const root = 'dist/service/apps/service/worker-plugin/';
    const files = Object.fromEntries(['index.js', 'identity.js', 'journal.js'].map(name => [root + name, 'export {};']));
    Object.assign(files, { [root + 'openclaw.plugin.json']: JSON.stringify({ id: 'edition3-worker' }), [root + 'package.json']: JSON.stringify({ openclaw: { extensions: ['./index.js'] } }), 'dist/service/apps/service/assignments.js': 'export {};', 'dist/service/packages/domain/worker.js': 'export {};' });
    for (const [path, value] of Object.entries(files)) { f.put(path, value); f.manifest.artifacts.push({ path, sha256: digest(value) }); }
    f.saveManifest(); assert.throws(() => stageCandidate(f.root), /runtime-child.js/);
    const ownerPath = 'dist/service/apps/service/runtime-child.js', ownerBytes = 'export {};';
    f.put(ownerPath, ownerBytes); f.manifest.artifacts.push({ path: ownerPath, sha256: digest(ownerBytes) });
    f.saveManifest(); assert.ok(stageCandidate(f.root).id);
    const path = root + 'package.json', value = JSON.stringify({ openclaw: { extensions: ['./wrong.js'] } });
    f.put(path, value); f.manifest.artifacts.find(artifact => artifact.path === path).sha256 = digest(value); f.saveManifest();
    assert.throws(() => stageCandidate(f.root), /plugin entry is not paired/);
  } finally { f.close(); }
});
test('untrusted inventory paths, duplicates and symlinks cannot escape the owned build', () => {
  const f = fixture(); try {
    const original = f.manifest.artifacts[0]; f.manifest.artifacts.push({ path: 'dist/client/../../../outside', sha256: digest('') }); f.saveManifest(); assert.throws(() => stageCandidate(f.root), /Invalid candidate path/);
    f.manifest.artifacts.pop(); f.manifest.artifacts.push(original); f.saveManifest(); assert.throws(() => stageCandidate(f.root), /Duplicate candidate/);
    f.manifest.artifacts.pop(); f.saveManifest(); rmSync(join(f.root, original.path)); f.put('outside', '<h1>First candidate</h1>'); symlinkSync(join(f.root, 'outside'), join(f.root, original.path)); assert.throws(() => stageCandidate(f.root), /symlinks/);
  } finally { f.close(); }
});
test('an altered frozen candidate fails without repairing or overwriting its bytes', () => {
  const f = fixture(); try { const first = stageCandidate(f.root); const path = join(first.root, 'dist/client/index.html'); writeFileSync(path, 'changed'); assert.throws(() => stageCandidate(f.root), /Frozen candidate changed/); assert.equal(readFileSync(path, 'utf8'), 'changed'); } finally { f.close(); }
});
test('production entry imports the frozen service while resolving relative data against the original workspace', () => {
  const f = fixture(); try {
    for (const name of ['candidate.mjs', 'serve.mjs']) { mkdirSync(join(f.root, 'scripts'), { recursive: true }); copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(f.root, 'scripts', name)); }
    const result = spawnSync(process.execPath, ['scripts/serve.mjs'], { cwd: f.root, env: { ...process.env, E3_DATA_DIR: 'owned-data' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); const observed = JSON.parse(result.stdout);
    assert.equal(observed.cwd, stageCandidate(f.root).root); assert.equal(observed.data, resolve(f.root, 'owned-data')); assert.equal(observed.candidateId, stageCandidate(f.root).id);
  } finally { f.close(); }
});

test('desktop shell, preload, policies and icon are immutable required parts of a paired desktop candidate', () => {
  const f = fixture();
  try {
    f.manifest.desktopFormat = 1; f.saveManifest();
    assert.throws(() => stageCandidate(f.root), /Desktop artifact is missing/);
    for (const name of ['main.cjs', 'preload.cjs', 'external.cjs', 'launch-policy.cjs', 'lynx-mark.png', 'lynx-mark.provenance.json']) {
      const path = 'dist/desktop/' + name, value = 'frozen ' + name;
      f.put(path, value); f.manifest.artifacts.push({ path, sha256: digest(value) });
    }
    f.saveManifest(); const first = stageCandidate(f.root);
    f.put('dist/desktop/preload.cjs', 'changed preload');
    assert.throws(() => stageCandidate(f.root), /preload.cjs changed/);
    assert.equal(readFileSync(join(first.root, 'dist/desktop/preload.cjs'), 'utf8'), 'frozen preload.cjs');
    f.put('dist/desktop/preload.cjs', 'frozen preload.cjs');
    f.manifest.desktopFormat = 2; f.saveManifest(); assert.throws(() => stageCandidate(f.root), /Unsupported desktop/);
  } finally { f.close(); }
});
