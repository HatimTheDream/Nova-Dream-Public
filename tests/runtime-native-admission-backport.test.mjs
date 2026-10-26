// Adapted from OpenClaw #162254. Copyright (c) 2026 OpenClaw Foundation.
// MIT license and exact commit attribution are retained in the paired backport script.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  REVIEWED_SECTIONS, REVIEWED_MODULE_NAME, REVIEWED_INPUT_SHA256, REVIEWED_OUTPUT_SHA256,
  UPSTREAM_COMMIT, WINDOWS_COMPATIBILITY_SECTIONS, backportRuntimeNativeAdmission, writeBackportedRuntimeModule,
} from '../scripts/backport-runtime-native-admission.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = process.env.NOVA_REVIEWED_RUNTIME_MODULE;
function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function removeFixture(root) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('nova-upstream-backport-'));
  fs.rmSync(root, { recursive: true, force: true });
}

test('rejects unreviewed input, existing destinations and multiply linked input without writing', () => {
  assert.throws(() => backportRuntimeNativeAdmission('unknown'), /Unreviewed runtime module/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-upstream-backport-refusals-'));
  let passed = false;
  try {
    const inputDir = path.join(root, 'input'), outputDir = path.join(root, 'output');
    fs.mkdirSync(inputDir); fs.mkdirSync(outputDir);
    const input = path.join(inputDir, REVIEWED_MODULE_NAME), output = path.join(outputDir, REVIEWED_MODULE_NAME);
    const receipt = path.join(outputDir, 'receipt.json');
    fs.writeFileSync(input, 'unknown');
    const prepare = () => writeBackportedRuntimeModule({ source: input, output, receipt });
    assert.throws(prepare, /Unreviewed runtime module/);
    assert.equal(fs.existsSync(output), false); assert.equal(fs.existsSync(receipt), false);
    fs.writeFileSync(output, 'keep');
    assert.throws(prepare, /Output already exists/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'keep');
    fs.unlinkSync(output);
    const hardlink = path.join(inputDir, 'input-alias.mjs'); fs.linkSync(input, hardlink);
    assert.throws(prepare, /singly linked/);
    assert.equal(fs.existsSync(output), false); assert.equal(fs.existsSync(receipt), false);
    assert.equal(fs.readFileSync(input, 'utf8'), 'unknown');
    passed = true;
  } finally { if (passed) removeFixture(root); else process.stderr.write(`Preserved failed fixture: ${root}\n`); }
});

test('prepares the exact upstream output once, records its identity and preserves input', { skip: !source }, () => {
  const original = fs.readFileSync(source);
  assert.equal(hash(original), REVIEWED_INPUT_SHA256);
  const outputBytes = backportRuntimeNativeAdmission(original);
  assert.equal(hash(outputBytes), REVIEWED_OUTPUT_SHA256);
  assert.throws(() => backportRuntimeNativeAdmission(outputBytes), /Unreviewed runtime module/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-upstream-backport-writer-'));
  let passed = false;
  try {
    const output = path.join(root, REVIEWED_MODULE_NAME), receipt = path.join(root, 'receipt.json');
    const result = writeBackportedRuntimeModule({ source, output, receipt });
    assert.equal(result.status, 'prepared-not-installed');
    assert.equal(result.backport.upstreamCommit, UPSTREAM_COMMIT);
    assert.equal(hash(fs.readFileSync(output)), REVIEWED_OUTPUT_SHA256);
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), result);
    assert.equal(hash(fs.readFileSync(source)), REVIEWED_INPUT_SHA256);
    assert.throws(() => writeBackportedRuntimeModule({ source, output, receipt }), /Output already exists/);
    passed = true;
  } finally { if (passed) removeFixture(root); else process.stderr.write(`Preserved failed fixture: ${root}\n`); }
});

test('Windows recovery host junction keeps the exact role and refuses changed or unsafe identities', () => {
  const definition = WINDOWS_COMPATIBILITY_SECTIONS[0].after.split('function captureRecoverySource(')[0];
  const p = path.win32, boundary = 'C:\\fixture\\capture', recovery = 'C:\\fixture\\recovery';
  const from = p.join(boundary, 'node_modules', 'openclaw'), to = p.join(recovery, 'node_modules', 'openclaw');
  const host = 'C:\\fixture\\host';
  function fixture(scenario) {
    let next = 1n, reads = 0;
    const entries = new Map(), targets = new Map(), rawTargets = new Map(), effects = [];
    const stat = kind => ({
      dev: 1n, ino: next++, mode: 0o777n, nlink: 1n, uid: 0n, gid: 0n, rdev: 0n,
      size: 0n, blksize: 4096n, blocks: 0n, atimeNs: 1n, mtimeNs: 1n, ctimeNs: 1n, birthtimeNs: 1n,
      isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'junction',
    });
    for (const name of [boundary, p.dirname(from), recovery, p.dirname(to), host]) entries.set(name, stat('directory'));
    entries.set(from, stat('junction')); targets.set(from, host); rawTargets.set(from, '\\\\?\\' + host);
    if (scenario === 'source-file') entries.set(from, stat('file'));
    if (scenario === 'target-file') entries.set(host, stat('file'));
    if (scenario === 'existing-destination') entries.set(to, stat('file'));
    if (scenario === 'redirected-parent') entries.set(p.dirname(to), stat('junction'));
    const fake = {
      lstatSync(filename, options) {
        reads++; assert.equal(options.bigint, true);
        const value = entries.get(filename);
        if (!value && options.throwIfNoEntry !== false) throw new Error('Missing fixture identity');
        return value;
      },
      realpathSync(filename) { reads++; return targets.get(filename) ?? filename; },
      readlinkSync(filename) { reads++; return rawTargets.get(filename); },
      symlinkSync(target, destination, kind) {
        assert.equal(destination, to); assert.equal(kind, 'junction'); assert.equal(target, host);
        assert.equal(entries.has(destination), false);
        effects.push({ target, destination, kind });
        entries.set(destination, stat('junction')); targets.set(destination, target);
        if (scenario === 'changed-target') entries.get(host).ino++;
        if (scenario === 'changed-source') rawTargets.set(from, 'different raw link');
        if (scenario === 'wrong-destination-target') targets.set(destination, 'C:\\fixture\\other-host');
      },
    };
    const run = new Function('fs', 'path', 'process', definition + '\nreturn copyWindowsRecoveryHostJunction;')(fake, p, { platform: 'win32' });
    return { run, effects, reads: () => reads };
  }
  const success = fixture();
  assert.equal(success.run(from, to, boundary, recovery), true);
  assert.deepEqual(success.effects, [{ target: host, destination: to, kind: 'junction' }]);
  for (const scenario of ['source-file', 'target-file', 'existing-destination', 'redirected-parent',
    'changed-target', 'changed-source', 'wrong-destination-target']) {
    const h = fixture(scenario);
    assert.throws(() => h.run(from, to, boundary, recovery), /original recovery host junction/, scenario);
    assert.equal(h.effects.length, ['changed-target', 'changed-source', 'wrong-destination-target'].includes(scenario) ? 1 : 0);
  }
  const outside = fixture();
  assert.equal(outside.run(p.join(boundary, 'unrelated'), to, boundary, recovery), false);
  assert.equal(outside.run(from, p.join(recovery, 'unrelated'), boundary, recovery), false);
  assert.equal(outside.reads(), 0, 'other paths stay with the original cp filter without any junction action');
  assert.equal(outside.effects.length, 0);
});

/** Load the exact patched compiled artifact with its original dependencies.
 * Only module-location expressions are relocated for this in-memory fixture;
 * no installed module, native configuration, credentials or saved records change.
 */
async function loadPatchedArtifact(inputPath) {
  const original = fs.readFileSync(inputPath);
  const patched = backportRuntimeNativeAdmission(original).toString('utf8');
  const require = createRequire(inputPath);
  const relocated = patched.replace(/^(import .+? from )(["'])([^"']+)\2;/gm, (whole, prefix, quote, specifier) => {
    if (specifier.startsWith('node:')) return whole;
    const filename = specifier.startsWith('.') ? path.resolve(path.dirname(inputPath), specifier) : require.resolve(specifier);
    return prefix + JSON.stringify(pathToFileURL(filename).href) + ';';
  }).replaceAll('createRequire(import.meta.url)', 'createRequire(' + JSON.stringify(pathToFileURL(inputPath).href) + ')');
  const artifact = await import('data:text/javascript;base64,' + Buffer.from(relocated).toString('base64'));
  const cache = await import(pathToFileURL(path.join(path.dirname(inputPath), 'plugin-cache-DK2CPN_y.mjs')).href);
  return { capture: artifact.t, inCaptureDirectory: artifact.i, createCache: cache.a, inCache: cache.D, retireCache: cache.C };
}

test('actual compiled upstream capture regression validates repeated preparation, host, successor and recovery', {
  skip: !source, timeout: 120000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-upstream-backport-capture-'));
  const priorEnv = new Map(['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_HOME', 'TMPDIR', 'TEMP', 'TMP'].map(key => [key, process.env[key]]));
  const fixtureTemp = path.join(root, 'tmp'); fs.mkdirSync(fixtureTemp);
  // The native capture sweeper also examines its process temp directory.
  // Bind that namespace before importing upstream code, not just its state root.
  for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = fixtureTemp;
  process.env.OPENCLAW_STATE_DIR = path.join(root, 'state');
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'state', 'openclaw.json');
  process.env.OPENCLAW_HOME = root;
  fs.mkdirSync(process.env.OPENCLAW_STATE_DIR);
  const capturesDir = path.join(root, 'captures'); fs.mkdirSync(capturesDir);
  const plugin = path.join(root, 'plugin'); fs.mkdirSync(plugin);
  fs.writeFileSync(path.join(plugin, 'package.json'), '{"name":"native-reference-fixture"}');
  fs.writeFileSync(path.join(plugin, 'index.cjs'), 'exports.value = 1;');
  fs.writeFileSync(path.join(plugin, 'helper.dat'), 'original companion');
  fs.mkdirSync(path.join(plugin, 'companion-sentinel'));
  for (let index = 0; index < 8; index++) fs.writeFileSync(path.join(plugin, `addon-${index}.node`), `native fixture ${index}`);
  const symlink = fs.symlinkSync, realpath = fs.realpathSync;
  const walks = [];
  let runtime, cache, recovery, passed = false;
  const artifacts = [];
  try {
    runtime = await loadPatchedArtifact(source);
    cache = runtime.createCache();
    fs.symlinkSync = (target, link, type) => {
      if (type === 'file') throw Object.assign(new Error('fixture file symlinks unavailable'), { code: 'EPERM' });
      return symlink(target, link, type);
    };
    fs.realpathSync = Object.assign((filename, ...args) => { walks.push(String(filename)); return realpath(filename, ...args); }, realpath);
    const walkCount = directory => walks.filter(filename => filename === path.join(directory, 'companion-sentinel')).length;
    const capture = () => {
      const artifact = runtime.inCache(cache, () => runtime.inCaptureDirectory(capturesDir, () => runtime.capture(plugin)));
      artifacts.push(artifact);
      assert.ok(within(root, artifact.rootDir), 'capture must stay in the disposable fixture');
      return artifact;
    };
    const first = capture();
    assert.equal(walkCount(first.rootDir), 1);
    walks.length = 0;
    for (let index = 0; index < 8; index++) first.prepareDependency(first.resolve(path.join(plugin, 'index.cjs')), 'node:fs');
    assert.equal(walkCount(first.rootDir), 0, 'unchanged preparation must not rewalk admitted companions');
    const hosts = [path.join(root, 'host-first'), path.join(root, 'host-second')];
    for (const host of hosts) fs.mkdirSync(host);
    walks.length = 0; first.linkHost(hosts[0]);
    assert.equal(walkCount(first.rootDir), 1, 'explicit host selection resets the capture verdict');
    const successor = capture();
    assert.equal(walkCount(successor.rootDir), 1, 'successor capture cannot inherit the original verdict');
    walks.length = 0; successor.linkHost(hosts[1]);
    assert.equal(walkCount(successor.rootDir), 1);
    walks.length = 0;
    recovery = runtime.inCaptureDirectory(capturesDir, () => first.captureRecoverySource());
    assert.ok(within(root, recovery.rootDir));
    assert.equal(walkCount(recovery.rootDir), 1, 'recovery has its own validation verdict');
    assert.equal(fs.readFileSync(path.join(recovery.rootDir, 'helper.dat'), 'utf8'), 'original companion');

    fs.writeFileSync(path.join(plugin, 'helper.dat'), 'replacement companion');
    const replacement = capture();
    assert.notEqual(replacement.sourceDigest, first.sourceDigest);
    assert.notEqual(fs.statSync(replacement.resolve(path.join(plugin, 'addon-0.node'))).ino, fs.statSync(first.resolve(path.join(plugin, 'addon-0.node'))).ino);
    assert.equal(walkCount(replacement.rootDir), 1);
    assert.equal(fs.readFileSync(path.join(first.rootDir, 'helper.dat'), 'utf8'), 'original companion');
    assert.equal(fs.readFileSync(path.join(replacement.rootDir, 'helper.dat'), 'utf8'), 'replacement companion');
    fs.writeFileSync(path.join(replacement.rootDir, 'helper.dat'), 'damaged capture');
    assert.throws(() => replacement.linkHost(hosts[0]), /Native plugin companions cannot be preserved/);
    passed = true;
  } catch (error) {
    // Preserve the meaningful frames without embedding the full data-URL module.
    if (error instanceof Error && error.stack) error.stack = error.stack
      .replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '<reviewed compiled module>')
      .split('\n').slice(0, 16).join('\n').slice(0, 8192);
    throw error;
  } finally {
    fs.symlinkSync = symlink; fs.realpathSync = realpath;
    try {
      await recovery?.disposeAsync();
      for (const artifact of artifacts) await artifact.disposeAsync();
      if (runtime && cache) await runtime.retireCache(cache);
    } catch (error) { passed = false; throw error; }
    finally {
      for (const [key, value] of priorEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      if (passed) removeFixture(root); else process.stderr.write(`Preserved failed fixture: ${root}\n`);
    }
  }
});
