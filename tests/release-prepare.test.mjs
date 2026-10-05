import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRelease } from '../scripts/release-prepare.mjs';
import { sha256 } from '../scripts/release-plan.mjs';

const now = 2_000_000_000_000;
const digest = value => value.repeat(64), commit = value => value.repeat(40);
const helpers = ['install.py', 'recovery.py', 'codex_log_retention.py', 'app_dependencies.py', 'workspace_key.py', 'verify-session-bindings.mjs', 'operator_rehearsal.py'];

function fixture(t, dependencyOverrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-release-prepare-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (path, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), bytes);
    return { path, sha256: sha256(bytes) };
  };
  const get = ref => JSON.parse(readFileSync(join(directory, ref.path)));
  const operation = { id: randomUUID(), stage: 'frozen', candidateId: digest('a'), publicCandidateId: digest('b'),
    priorCandidateId: digest('c'), workspaceEpoch: randomUUID(), version: '2.3.0', buildVersion: '1.0.286',
    agentVersion: '2026.9.8', priorAgentVersion: '2026.9.8', sourceCommits: { private: commit('d'), public: commit('e') },
    bundleSha256: digest('f'), trustedPublicKeySha256: digest('0'), changeClass: 'presentation',
    helperHashes: Object.fromEntries(helpers.map(name => [name, sha256(name)])) };
  const timeline = { startedAtMs: now, original: { id: randomUUID(), step: 'total', issuedAtMs: now,
    remainingMs: [600_000, 900_000], confidence: 'low', basis: 'Synthetic measured preparation range.',
    reason: 'Original estimate.', nextCheckpointAtMs: now + 300_000 }, revisions: [], reviews: [], lastCheckpointAtMs: now };
  const ci = {};
  for (const [side, id] of [['private', 4172], ['public', 5134]]) {
    const logFile = `actual-quality-${id}-attempt-3.log`;
    const log = put(`ci/${side}/${logFile}`, 'Run npm run quality\n# tests 12\n# fail 0\npython -B tests/update-runner.test.py\n');
    ci[side] = put(`ci/${side}/producer.json`, { format: 1, readOnly: true, sourceVersion: operation.version,
      repositories: [{ repository: side === 'private' ? 'Nova-Dream' : 'Nova-Dream-Public', sha: operation.sourceCommits[side],
        runs: [{ id, name: side === 'private' ? 'Nova Dream quality and release history' : 'Application quality',
          status: 'completed', conclusion: 'success', run_attempt: 3,
          jobs: [{ id: id + 1, name: 'quality', status: 'completed', conclusion: 'success', logFile, logSha256: log.sha256,
            steps: ['Run npm run quality', 'Verify Linux update recovery'].map(name => ({ name, status: 'completed', conclusion: 'success' })) }] }] }] });
  }
  const dependencyBytes = Buffer.from('Synthetic offline dependency archive; no extraction or execution.');
  const dependencyArchive = put('dependencies/closure.tgz', dependencyBytes);
  const dependencyMetadata = { format: 1, archiveBytes: dependencyBytes.length, archiveSha256: dependencyArchive.sha256,
    expandedBytes: 2000, fileCount: 12, packageLockSha256: digest('1'), dependencyGraphSha256: digest('2'),
    platform: 'linux', arch: 'x64', nodeVersion: '22.23.2', nodeAbi: 127, ...dependencyOverrides };
  const metadata = put('dependencies/actual-closure.metadata.json', dependencyMetadata);
  const archive = Buffer.from('Synthetic reviewed application archive.');
  const pair = { format: 1, candidateId: operation.candidateId, priorCandidateId: operation.priorCandidateId,
    archiveBytes: archive.length, archiveSha256: sha256(archive), applicationDependencies: dependencyMetadata,
    helpers: Object.fromEntries(helpers.filter(name => !['install.py', 'operator_rehearsal.py'].includes(name)).map(name => [name, operation.helperHashes[name]])) };
  const contents = [...helpers.filter(name => name !== 'operator_rehearsal.py').map(name => [name, Buffer.from(name)]),
    ['app.tgz', archive], ['reviewed-pair.json', Buffer.from(JSON.stringify(pair))]];
  const bundleValue = { format: 1, files: contents.map(([name, bytes]) => ({ name, sha256: sha256(bytes), data: bytes.toString('base64') })) };
  const bundle = put('package/actual-bundle.json', bundleValue);
  operation.bundleSha256 = bundle.sha256;
  const review = put('package/actual-review.json', { candidateId: operation.candidateId, publicCandidateId: operation.publicCandidateId,
    sourceCommits: { 'Nova-Dream': operation.sourceCommits.private, 'Nova-Dream-Public': operation.sourceCommits.public },
    bundleSha256: bundle.sha256, archiveSha256: pair.archiveSha256, applicationDependencies: dependencyMetadata });
  const assetsDirectory = 'downloads';
  const assetInputs = [
    ['producer-app.tgz', archive], ['producer-operator.json', readFileSync(join(directory, bundle.path))],
    ['producer-dependencies.tgz', dependencyBytes], ['producer-feed.json', Buffer.from('Synthetic signed feed bytes; not publication evidence.')],
  ];
  const assets = assetInputs.map(([name, bytes], index) => {
    const ref = put(`${assetsDirectory}/${name}`, bytes);
    return { name, id: 600 + index, bytes: bytes.length, sha256: ref.sha256, authenticatedDownloadVerified: true };
  });
  const proofSha256 = digest('3');
  const assetReceipt = put('publication/assets-verified.json', { format: 1, privateRepository: true, releaseId: 400,
    sourceCommit: operation.sourceCommits.private, candidateId: operation.candidateId, proofSha256, assets });
  const staging = put('host-receipts/private-assets-staged.json', { format: 1, verified: true,
    bundleSha256: bundle.sha256, dependenciesSha256: dependencyArchive.sha256, proofSha256,
    bundleBytes: readFileSync(join(directory, bundle.path)).length, dependenciesBytes: dependencyBytes.length,
    stagingIdentity: bundle.sha256, destination: `/var/lib/nova-update/staging/${bundle.sha256}`,
    files: { 'bundle.json': { sha256: bundle.sha256, bytes: readFileSync(join(directory, bundle.path)).length },
      'app-dependencies.tgz': { sha256: dependencyArchive.sha256, bytes: dependencyBytes.length } },
    applicationActivated: false, installDispatched: false, automaticRetry: false });
  const input = { format: 1, operation, timeline, remainingEstimates: {}, ci,
    package: { review, bundlePath: bundle.path }, dependencies: { metadata, archivePath: dependencyArchive.path },
    assets: { receipt: assetReceipt, directory: assetsDirectory }, staging };
  const run = () => prepareRelease(input, { baseDirectory: directory, nowMs: now });
  const rewrite = (ref, value) => put(ref.path, value);
  return { directory, input, operation, put, get, run, rewrite, dependencyMetadata, bundleValue };
}

function rejected(run) {
  let report;
  try { report = run(); } catch (error) { assert.ok(error instanceof Error); return; }
  assert.equal(report.state, 'blocked');
  assert.ok(report.blockers.length > 0, 'A refusal must retain a concrete preparation blocker.');
  assert.equal(report.installationAuthorized, false);
  assert.equal(report.effectsDispatched, false);
}

function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const path = join(entry.parentPath ?? entry.path, entry.name);
      return [path, readFileSync(path).toString('base64')];
    }));
}

test('actual producer filenames generate deterministic preparation without rewriting raw evidence', t => {
  const f = fixture(t), before = snapshot(f.directory), original = structuredClone(f.input);
  const first = f.run(), second = f.run();
  assert.equal(first.kind, 'nova-release-preparation');
  assert.equal(first.state, 'prepared', JSON.stringify(first.blockers));
  assert.equal(first.readOnly, true);
  assert.equal(first.installationAuthorized, false);
  assert.equal(first.effectsDispatched, false);
  assert.equal(first.automaticReplayPermitted, false);
  assert.deepEqual(first, second);
  assert.deepEqual(f.input, original);
  assert.deepEqual(snapshot(f.directory), before);
  for (const [side, id] of [['private', 4172], ['public', 5134]]) {
    const refs = first.plannerInput.evidence[`${side}-ci`];
    assert.equal(resolve(f.directory, refs.log.path), join(f.directory, `ci/${side}/actual-quality-${id}-attempt-3.log`));
    assert.equal(refs.receipt.sha256, f.input.ci[side].sha256);
    assert.equal(first.plan.phases.find(phase => phase.id === `${side}-ci`).state, 'passed');
  }
  assert.equal(first.plan.phases.find(phase => phase.id === 'package').state, 'passed');
});

test('a preparation pass does not manufacture mutable, rehearsal, installation or browser acceptance evidence', t => {
  const f = fixture(t), report = f.run();
  for (const phase of ['capacity', 'recovery', 'publication', 'installation', 'acceptance']) {
    assert.equal(report.plannerInput.evidence[phase], undefined);
    assert.equal(report.plan.phases.find(value => value.id === phase).state, 'missing');
  }
  assert.equal(report.plan.operationComplete, false);
  assert.equal(report.plan.installationAuthorized, false);
  assert.equal(report.plan.fullRehearsalRequired, true);
  assert.deepEqual(report.plannerInput.timeline, f.input.timeline);
});

test('paired CI identity, successful gate and unique repository/job selection remain mandatory', t => {
  for (const mutate of [
    receipt => { receipt.repositories[0].sha = commit('0'); },
    receipt => { receipt.repositories[0].runs[0].jobs[0].steps.pop(); },
    receipt => { receipt.repositories.push(structuredClone(receipt.repositories[0])); },
    receipt => { receipt.repositories[0].runs[0].jobs.push(structuredClone(receipt.repositories[0].runs[0].jobs[0])); },
  ]) {
    const f = fixture(t), receipt = f.get(f.input.ci.private);
    mutate(receipt); f.input.ci.private = f.rewrite(f.input.ci.private, receipt);
    rejected(f.run);
  }
});

test('missing preparation prerequisites and dependency identity mismatches fail before effects', t => {
  const missing = fixture(t); delete missing.input.staging; rejected(missing.run);
  const absentAssets = fixture(t); delete absentAssets.input.assets; rejected(absentAssets.run);
  const f = fixture(t), value = f.get(f.input.dependencies.metadata);
  value.packageLockSha256 = digest('4');
  f.input.dependencies.metadata = f.rewrite(f.input.dependencies.metadata, value);
  rejected(f.run);
});

test('internally consistent dependency receipts still require the maintained metadata bounds', t => {
  for (const overrides of [{ nodeAbi: 0 }, { nodeAbi: 10001 }, { nodeVersion: '0.23.2' },
    { expandedBytes: 0 }, { expandedBytes: 2 * 1024 ** 3 + 1 }, { fileCount: 200001 }]) {
    const f = fixture(t, overrides);
    rejected(f.run);
  }
});

test('tampered raw producer, archive and bundle bytes cannot pass through display reformatting', t => {
  for (const select of [
    f => f.input.ci.private.path,
    f => f.input.package.bundlePath,
    f => f.input.dependencies.archivePath,
    f => f.input.staging.path,
  ]) {
    const f = fixture(t), path = join(f.directory, select(f));
    const bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from('\n')]));
    rejected(f.run);
  }
  const f = fixture(t);
  f.input.package.review.sha256 = digest('0'); rejected(f.run);
});

test('asset verification binds exact roles and source and refuses duplicate roles or names', t => {
  for (const mutate of [
    receipt => { receipt.sourceCommit = commit('0'); },
    receipt => { receipt.candidateId = digest('0'); },
    receipt => { receipt.assets[1].authenticatedDownloadVerified = false; },
    receipt => { receipt.assets.push({ ...receipt.assets[1] }); },
    (receipt, f) => {
      const original = receipt.assets[1], name = 'second-bundle.json';
      f.put(`${f.input.assets.directory}/${name}`, readFileSync(join(f.directory, f.input.package.bundlePath)));
      receipt.assets.push({ ...original, name, id: 999 });
    },
  ]) {
    const f = fixture(t), receipt = f.get(f.input.assets.receipt);
    mutate(receipt, f); f.input.assets.receipt = f.rewrite(f.input.assets.receipt, receipt);
    rejected(f.run);
  }
});

test('staging proof binds protected destinations, exact bytes and a non-activated preparation boundary', t => {
  for (const mutate of [
    value => { value.bundleSha256 = digest('0'); },
    value => { value.files['app-dependencies.tgz'].bytes += 1; },
    value => { value.proofSha256 = digest('4'); },
    value => { value.destination = '/var/tmp/unreviewed'; },
    value => { value.destination = `/var/tmp/${value.bundleSha256}`; },
    value => { value.applicationActivated = true; },
    value => { value.installDispatched = true; },
    value => { value.automaticRetry = true; },
  ]) {
    const f = fixture(t), value = f.get(f.input.staging);
    mutate(value); f.input.staging = f.rewrite(f.input.staging, value);
    rejected(f.run);
  }
});

test('unsafe producer filenames cannot escape the explicit receipt or asset directory', t => {
  for (const name of ['../outside.log', 'subdir/quality.log', 'subdir\\quality.log', '/absolute.log', 'C:\\absolute.log', '.']) {
    const f = fixture(t), receipt = f.get(f.input.ci.private);
    receipt.repositories[0].runs[0].jobs[0].logFile = name;
    f.input.ci.private = f.rewrite(f.input.ci.private, receipt); rejected(f.run);
    const assets = fixture(t), value = assets.get(assets.input.assets.receipt);
    value.assets[0].name = name;
    assets.input.assets.receipt = assets.rewrite(assets.input.assets.receipt, value); rejected(assets.run);
  }
});

test('symlink redirection remains a bounded input failure', t => {
  const f = fixture(t), target = join(f.directory, f.input.dependencies.metadata.path), linked = join(f.directory, 'metadata-link.json');
  try { symlinkSync(target, linked); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows test account cannot create symlinks.'); return; }
    throw error;
  }
  f.input.dependencies.metadata = { ...f.input.dependencies.metadata, path: 'metadata-link.json' };
  rejected(f.run);
});

test('oversized dependency metadata cannot become preparation evidence', t => {
  const oversized = fixture(t);
  oversized.input.dependencies.metadata = oversized.put('dependencies/oversized.json', Buffer.alloc(2 * 1024 ** 2 + 1, 32));
  rejected(oversized.run);
});

test('unfrozen identities, changed authority fields and incomplete dependency inputs cannot become prepared', t => {
  const draft = fixture(t); draft.operation.stage = 'draft'; rejected(draft.run);
  const extra = fixture(t); extra.input.command = 'restart'; rejected(extra.run);
  const absent = fixture(t); delete absent.input.dependencies; rejected(absent.run);
});

test('actual CLI resolves producer files beside its input and reports preparation without writes or effects', t => {
  const f = fixture(t), started = Date.now(), inputFile = join(f.directory, 'prepare-input.json');
  Object.assign(f.input.timeline, { startedAtMs: started, lastCheckpointAtMs: started });
  Object.assign(f.input.timeline.original, { issuedAtMs: started, nextCheckpointAtMs: started + 300_000 });
  const script = fileURLToPath(new URL('../scripts/release-prepare.mjs', import.meta.url));
  const run = (input, status, state) => {
    writeFileSync(inputFile, JSON.stringify(input));
    const before = snapshot(f.directory);
    const result = spawnSync(process.execPath, [script, inputFile], {
      cwd: tmpdir(), encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.readOnly, true);
    assert.equal(report.installationAuthorized, false);
    assert.equal(report.effectsDispatched, false);
    assert.equal(report.automaticReplayPermitted, false);
    if (state) assert.equal(report.state, state, result.stdout);
    else assert.equal(report.kind, 'nova-release-preparation-error');
    assert.deepEqual(snapshot(f.directory), before);
    return report;
  };
  const prepared = run(f.input, 0, 'prepared');
  assert.equal(prepared.plannerInput.evidence['private-ci'].log.path,
    join(f.directory, 'ci/private/actual-quality-4172-attempt-3.log'));
  const missing = structuredClone(f.input); delete missing.staging;
  const blocked = run(missing, 2, 'blocked');
  assert.ok(blocked.blockers.some(value => value.phase === 'staging'));
  run({ ...f.input, command: 'restart' }, 1);
});
