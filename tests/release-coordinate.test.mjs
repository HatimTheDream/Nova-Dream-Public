import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ReleaseJournal, normalizeCoordinatorDescriptor, normalizePlanInput, validateJournalDirectory } from '../scripts/release-coordinate.mjs';
import { sha256 } from '../scripts/release-plan.mjs';

const scriptURL = new URL('../scripts/release-coordinate.mjs', import.meta.url).href;
const scriptPath = fileURLToPath(new URL('../scripts/release-coordinate.mjs', import.meta.url));
const digest = value => sha256(String(value)), helpers = ['install.py', 'recovery.py', 'codex_log_retention.py', 'app_dependencies.py', 'workspace_key.py', 'verify-session-bindings.mjs', 'operator_rehearsal.py'];
const flags = { accountsVerified: true, savedWorkVerified: true, healthVerified: true, recoveryVerified: true };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nova-release-coordinate-')), directory = join(root, 'journal'), evidence = join(root, 'evidence'); mkdirSync(evidence);
  const connections = [];
  t.after(() => { for (const journal of connections) journal.close(); rmSync(root, { recursive: true, force: true }); });
  const open = options => { const journal = new ReleaseJournal(directory, options); connections.push(journal); return journal; };
  const now = Date.now(); let sequence = 0;
  const put = value => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); const path = `${++sequence}.json`; writeFileSync(join(evidence, path), bytes); return { path, sha256: sha256(bytes) }; };
  const key = generateKeyPairSync('ed25519'), publicKey = key.publicKey.export({ format: 'pem', type: 'spki' });
  const operation = { id: randomUUID(), stage: 'frozen', candidateId: digest('target'), publicCandidateId: digest('public'), priorCandidateId: digest('prior'), workspaceEpoch: randomUUID(), version: '2.1.5', buildVersion: '1.0.281', agentVersion: '2026.9.6', priorAgentVersion: '2026.9.6', sourceCommits: { private: 'a'.repeat(40), public: 'b'.repeat(40) }, bundleSha256: digest('bundle'), trustedPublicKeySha256: sha256(publicKey), changeClass: 'application', helperHashes: Object.fromEntries(helpers.map(name => [name, digest(name)])) };
  const estimate = { id: randomUUID(), step: 'total', issuedAtMs: now, remainingMs: [600_000, 900_000], confidence: 'low', basis: 'Earlier measured releases.', reason: 'Original estimate.', nextCheckpointAtMs: now + 300_000 };
  const input = { format: 1, operation, evidence: {}, timeline: { startedAtMs: now, original: estimate, revisions: [], reviews: [], lastCheckpointAtMs: now }, remainingEstimates: {} };
  const adapter = { transport: put({ fixture: 'local synthetic transport reference' }), installSpec: put({ fixture: 'local synthetic install reference' }) }, description = { identity: digest('adapter'), scopeIdentity: digest('host') };
  for (const side of ['private', 'public']) {
    const log = put('Run npm run quality\n# fail 0\npython -B tests/update-runner.test.py\n');
    input.evidence[`${side}-ci`] = { log, receipt: put({ format: 1, readOnly: true, sourceVersion: operation.version, repositories: [{ repository: side === 'private' ? 'Nova-Dream' : 'Nova-Dream-Public', sha: operation.sourceCommits[side], runs: [{ id: 1, name: side === 'private' ? 'Nova Dream quality and release history' : 'Application quality', status: 'completed', conclusion: 'success', jobs: [{ id: 2, name: 'quality', status: 'completed', conclusion: 'success', logSha256: log.sha256, steps: ['Run npm run quality', 'Verify Linux update recovery'].map(name => ({ name, status: 'completed', conclusion: 'success' })) }] }] }] }) };
  }
  const archive = Buffer.from('immutable synthetic app archive'), pair = { format: 1, candidateId: operation.candidateId, priorCandidateId: operation.priorCandidateId, archiveBytes: archive.length, archiveSha256: sha256(archive), helpers: Object.fromEntries(helpers.filter(name => !['install.py', 'operator_rehearsal.py'].includes(name)).map(name => [name, digest(name)])) };
  const entries = [...helpers.filter(name => name !== 'operator_rehearsal.py').map(name => [name, Buffer.from(name)]), ['app.tgz', archive], ['reviewed-pair.json', Buffer.from(JSON.stringify(pair))]];
  const bundle = put({ format: 1, files: entries.map(([name, data]) => ({ name, data: data.toString('base64'), sha256: sha256(data) })) }); operation.bundleSha256 = bundle.sha256;
  input.evidence.package = { bundle, review: put({ candidateId: operation.candidateId, publicCandidateId: operation.publicCandidateId, sourceCommits: { 'Nova-Dream': operation.sourceCommits.private, 'Nova-Dream-Public': operation.sourceCommits.public }, bundleSha256: bundle.sha256, archiveSha256: pair.archiveSha256 }) };
  input.evidence.capacity = { observation: put({ observedAtMilliseconds: now, readOnly: true, workspaceEpoch: operation.workspaceEpoch, health: { status: 'ready', candidateId: operation.priorCandidateId, agentVersion: operation.priorAgentVersion }, capacity: { lifecycle: 'online', freeBytes: 20 * 1024 ** 3, candidateBytes: 1000, snapshotCopyBytes: 2000, independentRestoreBytes: 4 * 1024 ** 3, startupGrowthAllowanceBytes: 2 * 1024 ** 3, nativeMigrationBytes: 0, managedCompanionBytes: 0, metadataOverheadBytes: 90 * 1024 ** 2, reserveBytes: 1536 * 1024 ** 2, allowanceBytes: 256 * 1024 ** 2, metadataOverheadMeasured: true, snapshotDeltaMeasured: true } }) };
  const leaseId = randomUUID(), review = put({ candidateId: operation.priorCandidateId, workspaceEpoch: operation.workspaceEpoch, helperHashes: operation.helperHashes, leaseId });
  const proof = { format: 1, kind: 'operator-maintenance-acceptance', outcome: 'rehearsed', candidateId: operation.priorCandidateId, workspaceEpoch: operation.workspaceEpoch, leaseId, ...flags }, proofRef = put(proof);
  input.evidence.recovery = { review, proof: proofRef, observation: put({ observedAtMilliseconds: now, completedProof: { reviewSha256: review.sha256, proofSha256: proofRef.sha256, proof, originalReturned: true, nativeLeaseReleaseSettled: true }, status: { lastPhase: 'complete' }, operator: { id: leaseId, phase: 'released', releaseKind: 'rehearsed', proofSha256: proofRef.sha256 } }) };
  const manifest = { sequence: 1, createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400_000).toISOString(), releases: [{ candidateId: operation.candidateId, fromCandidateId: operation.priorCandidateId, novaVersion: operation.version, agentVersion: operation.agentVersion, compatibility: { reviewed: true, fromAgentVersion: operation.priorAgentVersion }, bundle: { sha256: operation.bundleSha256 } }] }, bytes = Buffer.from(JSON.stringify(manifest));
  const feed = put({ payload: bytes.toString('base64'), signature: sign(null, bytes, key.privateKey).toString('base64') });
  input.evidence.publication = { feed, publicKey: put(publicKey), receipt: put({ publicFeedReadVerified: true, publicFeedSha256: feed.sha256, sequence: 1, repositories: ['Nova-Dream', 'Nova-Dream-Public'].map((repository, i) => ({ repository, sourceCommit: operation.sourceCommits[i ? 'public' : 'private'], pushed: true, sequence: 1, feedSha256: feed.sha256 })) }) };
  const descriptor = () => normalizeCoordinatorDescriptor({ format: 1, input, adapter }, evidence);
  const initialize = () => { const journal = open({ create: true }); journal.initialize(descriptor(), description, now); return journal; };
  const result = (intent, state = 'uncertain', externalJobId = null) => ({ state, externalJobId, observation: null, reasonCode: state === 'uncertain' ? 'transport-timeout' : 'original-controller-job-running', candidateId: operation.candidateId, priorCandidateId: operation.priorCandidateId, workspaceEpoch: operation.workspaceEpoch, idempotencyKey: intent.idempotencyKey });
  return { root, directory, evidence, now, put, input, operation, adapter, description, descriptor, initialize, open, result };
}
function child(code, args) {
  return new Promise((resolvePromise, reject) => {
    const processChild = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; processChild.stdout.on('data', data => stdout += data); processChild.stderr.on('data', data => stderr += data);
    processChild.on('error', reject); processChild.on('exit', code => resolvePromise({ code, stdout, stderr }));
  });
}

test('init stores exact frozen identities and rejects changed reinitialization without replacing records', t => {
  const f = fixture(t), journal = f.initialize(); t.after(() => journal.close());
  assert.equal(journal.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(journal.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(journal.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(journal.initialize(f.descriptor(), f.description, f.now).operationId, f.operation.id);
  assert.equal(journal.status(f.operation.id).events.length, 1);
  f.operation.candidateId = digest('different'); assert.throws(() => journal.initialize(f.descriptor(), f.description, f.now), /existing-operation-input-changed/);
  assert.throws(() => normalizePlanInput({ ...f.input, command: 'run-something' }, f.evidence));
});

test('status and plan are read-only and resolve captured relative evidence independently of cwd', t => {
  const f = fixture(t), journal = f.initialize(), current = journal.load(f.operation.id);
  assert.equal(current.input.evidence.recovery.review.path, resolve(f.evidence, f.input.evidence.recovery.review.path));
  journal.close(); const path = join(f.directory, 'release.sqlite'), before = sha256(readFileSync(path));
  const reader = f.open({ readOnly: true });
  assert.equal(reader.plan(f.operation.id, f.now).phases.find(p => p.id === 'package').state, 'passed');
  assert.equal(reader.status(f.operation.id).events.length, 1); assert.throws(() => reader.reserveInstall(f.operation.id, f.now), /readonly-journal/); reader.close();
  const cli = spawnSync(process.execPath, [scriptPath, 'status', f.directory, f.operation.id], { cwd: f.root, encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).readOnly, true);
  assert.equal(sha256(readFileSync(path)), before);
});

test('missing prerequisites cannot reserve and an expired ETA requires a recorded review', t => {
  const f = fixture(t); delete f.input.evidence.recovery; const journal = f.initialize(); t.after(() => journal.close());
  assert.throws(() => journal.reserveInstall(f.operation.id, f.now), /prerequisites-unverified/); assert.equal(journal.intent(f.operation.id), null);
  const g = fixture(t); g.input.timeline.original.remainingMs = [1, 2]; const second = g.initialize(); t.after(() => second.close());
  assert.throws(() => second.reserveInstall(g.operation.id, g.now + 3), /overrun-review-required/); assert.equal(second.intent(g.operation.id), null);
});

test('two processes reserve one durable intent and exactly one receives initial dispatch eligibility', async t => {
  const f = fixture(t), journal = f.initialize(); journal.close();
  const code = `import {ReleaseJournal} from ${JSON.stringify(scriptURL)};const j=new ReleaseJournal(process.argv[1]);try{console.log(JSON.stringify(j.reserveInstall(process.argv[2])))}finally{j.close()}`;
  const results = await Promise.all([child(code, [f.directory, f.operation.id]), child(code, [f.directory, f.operation.id])]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const reserved = results.map(result => JSON.parse(result.stdout)); assert.equal(reserved.filter(result => result.newlyReserved).length, 1);
  assert.equal(reserved[0].intent.idempotencyKey, reserved[1].intent.idempotencyKey);
  const reopened = f.open({ readOnly: true }); t.after(() => reopened.close());
  assert.equal(reopened.status(f.operation.id).events.filter(event => event.kind === 'install-reserved').length, 1);
});

test('opening a briefly locked journal waits before reading schema without reserving any intent', async t => {
  const f = fixture(t), initialized = f.initialize(); initialized.close();
  const locker = new DatabaseSync(join(f.directory, 'release.sqlite'));
  locker.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; SELECT count(*) FROM operations;');
  let released = false, schemaAttempted = false, releaseTimer;
  const release = () => { if (!released) { locker.exec('ROLLBACK'); locker.close(); released = true; } };
  const deadline = setTimeout(release, 10000);
  t.after(() => { clearTimeout(deadline); clearTimeout(releaseTimer); release(); });
  const code = `import {DatabaseSync} from 'node:sqlite';import {ReleaseJournal} from ${JSON.stringify(scriptURL)};
    const prepare=DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA application_id')process.stdout.write('schema-read\\n');return prepare.call(this,sql)};
    const journal=new ReleaseJournal(process.argv[1],{readOnly:true});
    try{console.log(JSON.stringify({status:journal.status(process.argv[2]),intent:journal.intent(process.argv[2])}))}finally{journal.close()}`;
  const result = await new Promise((resolvePromise, reject) => {
    const opener = spawn(process.execPath, ['--input-type=module', '-e', code, f.directory, f.operation.id],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    opener.stdout.on('data', data => {
      stdout += data;
      if (!schemaAttempted && stdout.includes('schema-read\n')) {
        schemaAttempted = true;
        // The lock remains held after the exact schema-read attempt. Without
        // the constructor timeout this read fails immediately.
        releaseTimer = setTimeout(release, 250);
      }
    });
    opener.stderr.on('data', data => stderr += data);
    opener.on('error', reject);
    opener.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
  assert.equal(schemaAttempted, true);
  assert.equal(result.code, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(observed.intent, null);
  assert.equal(observed.status.events.length, 1);
});

test('a process crash after durable reservation leaves observe-only intent even if no request was sent', async t => {
  const f = fixture(t), journal = f.initialize(); journal.close();
  const code = `import {ReleaseJournal} from ${JSON.stringify(scriptURL)};const j=new ReleaseJournal(process.argv[1]);console.log(JSON.stringify(j.reserveInstall(process.argv[2])));process.exit(73)`;
  const crashed = await child(code, [f.directory, f.operation.id]); assert.equal(crashed.code, 73, crashed.stderr);
  const original = JSON.parse(crashed.stdout).intent, reopened = f.open(); t.after(() => reopened.close());
  const resumed = reopened.reserveInstall(f.operation.id, f.now + 1000);
  assert.equal(resumed.newlyReserved, false); assert.equal(resumed.intent.state, 'reserved'); assert.equal(resumed.intent.idempotencyKey, original.idempotencyKey);
  assert.equal(reopened.context(f.operation.id).intent.inputSha256, original.inputSha256);
});

test('uncertain/no-job responses preserve identity and never create another dispatch on repeated resume', t => {
  const f = fixture(t), journal = f.initialize(); t.after(() => journal.close()); const reserved = journal.reserveInstall(f.operation.id, f.now);
  journal.recordObservation(f.operation.id, f.result(reserved.intent), f.now + 1);
  for (let i = 0; i < 3; i++) {
    const next = journal.reserveInstall(f.operation.id, f.now + 500_000); // freshness and ETA do not block observing an existing intent
    assert.equal(next.newlyReserved, false); assert.equal(next.intent.idempotencyKey, reserved.intent.idempotencyKey); assert.equal(next.intent.state, 'uncertain');
  }
  assert.throws(() => journal.recordObservation(f.operation.id, { ...f.result(reserved.intent), idempotencyKey: randomUUID() }, f.now + 2), /identity-changed/);
  const jobId = randomUUID(); journal.recordObservation(f.operation.id, f.result(reserved.intent, 'uncertain', jobId), f.now + 3);
  const second = f.descriptor(); second.input.operation.id = randomUUID(); journal.initialize(second, { ...f.description, identity: digest('second') }, f.now + 3);
  assert.throws(() => journal.reserveInstall(second.input.operation.id, f.now + 3), /UNIQUE constraint/);
  journal.recordObservation(f.operation.id, f.result(reserved.intent, 'completed', jobId), f.now + 4);
  assert.equal(journal.intent(f.operation.id).state, 'completed'); assert.equal(journal.intent(f.operation.id).idempotencyKey, reserved.intent.idempotencyKey);
});

test('late polls retain terminal evidence, and an observed external job can never be replaced', t => {
  const f = fixture(t), journal = f.initialize(); t.after(() => journal.close()); const { intent } = journal.reserveInstall(f.operation.id, f.now), job = randomUUID();
  journal.recordObservation(f.operation.id, f.result(intent, 'running', job), f.now + 1);
  assert.throws(() => journal.recordObservation(f.operation.id, f.result(intent, 'running', randomUUID()), f.now + 2), /external-job-identity-changed/);
  journal.recordObservation(f.operation.id, f.result(intent, 'completed', job), f.now + 3);
  journal.recordObservation(f.operation.id, f.result(intent, 'running', job), f.now + 4);
  assert.equal(journal.intent(f.operation.id).state, 'completed'); assert.equal(journal.reserveInstall(f.operation.id, f.now + 5).newlyReserved, false);
});

test('host serialization is independent of candidate-specific adapter identity', t => {
  const f = fixture(t), journal = f.initialize(); t.after(() => journal.close()); journal.reserveInstall(f.operation.id, f.now);
  const second = f.descriptor(); second.input.operation.id = randomUUID();
  journal.initialize(second, { ...f.description, identity: digest('other-release-adapter') }, f.now);
  assert.throws(() => journal.reserveInstall(second.input.operation.id, f.now), /UNIQUE constraint/);
  assert.equal(journal.intent(second.input.operation.id), null);
});

test('checkpoint preserves original ETA and captured dispatch input while allowing newer evidence references', t => {
  const f = fixture(t), journal = f.initialize(); t.after(() => journal.close()); const reserved = journal.reserveInstall(f.operation.id, f.now);
  const next = f.descriptor().input; next.timeline.lastCheckpointAtMs = f.now + 10;
  const originalProof = structuredClone(next.evidence.recovery.proof);
  next.evidence.recovery.proof = { path: resolve(f.evidence, f.put({ changed: 'later evidence' }).path), sha256: digest('deliberately-unverified-new-reference') };
  next.timeline.revisions.push({ ...next.timeline.original, id: randomUUID(), issuedAtMs: f.now + 10, remainingMs: [800_000, 1000_000], nextCheckpointAtMs: f.now + 300_000, reason: 'Observed remaining work.' });
  journal.checkpoint(f.operation.id, next, { nowMs: f.now + 10 });
  assert.equal(journal.status(f.operation.id).storedPlan.timeline.revisions.length, 1);
  assert.equal(journal.context(f.operation.id).intent.inputSha256, reserved.intent.inputSha256);
  assert.deepEqual(journal.context(f.operation.id).input.evidence.recovery.proof, originalProof);
  assert.throws(() => journal.recordObservation(f.operation.id, f.result(reserved.intent), f.now + 9), /journal-clock-moved-backwards/);
  assert.equal(journal.intent(f.operation.id).state, 'reserved');
  next.timeline.original.remainingMs = [1, 2]; assert.throws(() => journal.checkpoint(f.operation.id, next, { nowMs: f.now + 11 }), /original-estimate-reset/);
  next.operation.candidateId = digest('new'); assert.throws(() => journal.checkpoint(f.operation.id, next, { nowMs: f.now + 11 }), /checkpoint-operation-changed/);
});

test('journal checkpoints/events are append-only and corrupted stored identities fail closed', t => {
  const f = fixture(t), journal = f.initialize(); t.after(() => journal.close());
  assert.throws(() => journal.db.exec("UPDATE checkpoints SET input_hash='bad'"), /immutable-checkpoint/);
  assert.throws(() => journal.db.exec('DELETE FROM events'), /immutable-event/);
  journal.db.prepare('UPDATE operations SET adapter_hash=? WHERE id=?').run(digest('tampered'), f.operation.id);
  assert.throws(() => journal.status(f.operation.id), /journal-record-hash-mismatch/);
});

test('repository and OneDrive journal paths are rejected before creating a journal', t => {
  const f = fixture(t), repository = join(f.root, 'repo'); mkdirSync(repository); mkdirSync(join(repository, '.git'));
  assert.throws(() => validateJournalDirectory(join(repository, 'journal'), { create: true }), /repository/);
  const synced = join(f.root, 'OneDrive', 'journal'); assert.throws(() => validateJournalDirectory(synced, { create: true }), /synced/);
  assert.deepEqual(readdirSync(repository), ['.git']);
});
