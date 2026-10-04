import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PHASES, assessCapacity, assessTimeline, planRelease, readEvidenceFile, releaseOperationIdentity, sha256, validateOperationContinuation } from '../scripts/release-plan.mjs';

const now = 2_000_000_000_000, hash = letter => letter.repeat(64), commit = letter => letter.repeat(40);
const helpers = ['install.py', 'recovery.py', 'codex_log_retention.py', 'app_dependencies.py', 'workspace_key.py', 'verify-session-bindings.mjs', 'operator_rehearsal.py'];
const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const flags = { savedWorkVerified: true, accountsVerified: true, recoveryVerified: true, healthVerified: true };
const estimate = (step = 'total', issuedAtMs = now, remainingMs = [600_000, 900_000]) => ({ id: randomUUID(), step, issuedAtMs, remainingMs, confidence: remainingMs ? 'low' : 'unknown', basis: 'Measured earlier operation; not a guarantee.', reason: 'Initial checkpoint.', nextCheckpointAtMs: issuedAtMs + 300_000 });
const capacity = () => ({ lifecycle: 'online', freeBytes: 12 * 1024 ** 3, candidateBytes: 1000, snapshotCopyBytes: 2000, independentRestoreBytes: 4 * 1024 ** 3, startupGrowthAllowanceBytes: 2 * 1024 ** 3, nativeMigrationBytes: 0, managedCompanionBytes: 0, metadataOverheadBytes: 90 * 1024 ** 2, reserveBytes: 1536 * 1024 ** 2, allowanceBytes: 256 * 1024 ** 2, metadataOverheadMeasured: true, snapshotDeltaMeasured: true });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-release-plan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let counter = 0;
  const put = (value, suffix = 'json') => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); const path = `${++counter}.${suffix}`; writeFileSync(join(directory, path), bytes); return { path, sha256: sha256(bytes) }; };
  const operation = { id: randomUUID(), stage: 'frozen', candidateId: hash('a'), publicCandidateId: hash('b'), priorCandidateId: hash('c'), workspaceEpoch: randomUUID(), version: '2.1.5', buildVersion: '1.0.281', agentVersion: '2026.9.8', priorAgentVersion: '2026.9.6', sourceCommits: { private: commit('d'), public: commit('e') }, bundleSha256: hash('f'), trustedPublicKeySha256: sha256(publicKey), changeClass: 'runtime', helperHashes: Object.fromEntries(helpers.map(name => [name, sha256(name)])) };
  const input = { format: 1, operation, evidence: {}, timeline: { startedAtMs: now, original: estimate(), revisions: [], reviews: [], lastCheckpointAtMs: now }, remainingEstimates: {} };
  const run = (at = now) => planRelease(input, { baseDirectory: directory, nowMs: at });
  const get = ref => JSON.parse(readFileSync(join(directory, ref.path)));
  const phase = id => run().phases.find(item => item.id === id);
  function ci(id) {
    const privateRepo = id === 'private-ci', log = put('Run npm run quality\n# tests 12\n# fail 0\npython -B tests/update-runner.test.py\n', 'log');
    const job = { id: 42, name: 'quality', status: 'completed', conclusion: 'success', steps: ['Run npm run quality', 'Verify Linux update recovery'].map(name => ({ name, status: 'completed', conclusion: 'success' })), logSha256: log.sha256 };
    input.evidence[id] = { log, receipt: put({ format: 1, readOnly: true, sourceVersion: operation.version, repositories: [{ repository: privateRepo ? 'Nova-Dream' : 'Nova-Dream-Public', sha: operation.sourceCommits[privateRepo ? 'private' : 'public'], runs: [{ id: 24, name: privateRepo ? 'Nova Dream quality and release history' : 'Application quality', status: 'completed', conclusion: 'success', jobs: [job] }] }] }) };
  }
  function pack() {
    const archive = Buffer.from('Test archive bytes; this planner does not extract archives.');
    const pair = { format: 1, candidateId: operation.candidateId, priorCandidateId: operation.priorCandidateId, archiveBytes: archive.length, archiveSha256: sha256(archive), helpers: Object.fromEntries(helpers.filter(name => !['install.py', 'operator_rehearsal.py'].includes(name)).map(name => [name, operation.helperHashes[name]])) };
    const files = [...helpers.filter(name => name !== 'operator_rehearsal.py').map(name => [name, Buffer.from(name)]), ['app.tgz', archive], ['reviewed-pair.json', Buffer.from(JSON.stringify(pair))]].map(([name, bytes]) => ({ name, data: bytes.toString('base64'), sha256: sha256(bytes) }));
    const bundle = put({ format: 1, files }); operation.bundleSha256 = bundle.sha256;
    input.evidence.package = { bundle, review: put({ candidateId: operation.candidateId, publicCandidateId: operation.publicCandidateId, sourceCommits: { 'Nova-Dream': operation.sourceCommits.private, 'Nova-Dream-Public': operation.sourceCommits.public }, bundleSha256: bundle.sha256, archiveSha256: pair.archiveSha256 }) };
  }
  function observeCapacity() { input.evidence.capacity = { observation: put({ observedAtMilliseconds: now, readOnly: true, workspaceEpoch: operation.workspaceEpoch, health: { status: 'ready', candidateId: operation.priorCandidateId, agentVersion: operation.priorAgentVersion }, capacity: capacity() }) }; }
  function recovery(outcome = 'rehearsed') {
    const leaseId = randomUUID(), review = put({ candidateId: operation.priorCandidateId, workspaceEpoch: operation.workspaceEpoch, helperHashes: operation.helperHashes, leaseId });
    const proof = { kind: 'operator-maintenance-acceptance', outcome, candidateId: operation.priorCandidateId, workspaceEpoch: operation.workspaceEpoch, leaseId, ...flags }, proofRef = put(proof);
    input.evidence.recovery = { review, proof: proofRef, observation: put({ observedAtMilliseconds: now, readOnlyObservation: true, completedProof: { proof, proofSha256: proofRef.sha256, reviewSha256: review.sha256, originalReturned: true, nativeLeaseReleaseSettled: true }, status: { lastPhase: 'complete' }, operator: { id: leaseId, phase: 'released', releaseKind: outcome, proofSha256: proofRef.sha256 } }) };
  }
  function publication() {
    const manifest = { sequence: 2, createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400_000).toISOString(), releases: [{ candidateId: operation.candidateId, fromCandidateId: operation.priorCandidateId, novaVersion: operation.version, agentVersion: operation.agentVersion, bundle: { sha256: operation.bundleSha256 }, compatibility: { reviewed: true, fromAgentVersion: operation.priorAgentVersion } }] };
    const bytes = Buffer.from(JSON.stringify(manifest)), feed = put({ payload: bytes.toString('base64'), signature: sign(null, bytes, keys.privateKey).toString('base64') });
    input.evidence.publication = { feed, publicKey: put(publicKey, 'pem'), receipt: put({ sequence: 2, publicFeedReadVerified: true, publicFeedSha256: feed.sha256, repositories: ['Nova-Dream', 'Nova-Dream-Public'].map((repository, index) => ({ repository, pushed: true, feedSha256: feed.sha256, sequence: 2, sourceCommit: operation.sourceCommits[index ? 'public' : 'private'] })) }) };
  }
  function install() {
    const result = { format: 1, jobId: randomUUID(), outcome: 'completed', candidateId: operation.candidateId, priorCandidateId: operation.priorCandidateId, ...flags };
    input.evidence.installation = { result: put(result), observation: put({ observedAtMilliseconds: now, readOnly: true, installerResult: result, job: { id: result.jobId, state: 'completed', hold: false, candidateId: operation.candidateId, fromCandidateId: operation.priorCandidateId, releaseId: operation.bundleSha256, epoch: operation.workspaceEpoch }, controller: { holdFor: null, currentJobId: result.jobId, currentJobMatches: true }, health: { status: 'ready', candidateId: operation.candidateId, version: operation.version, buildVersion: operation.buildVersion, agentVersion: operation.agentVersion } }) };
    const reply = { candidateId: operation.candidateId, epoch: operation.workspaceEpoch, status: 'verified', operationState: 'completed', genuineReplyVerified: true, savedReplyVerified: true, noToolsUsed: true, oldUnknownsUnchanged: true, maintenanceReleased: true, nativeModelAuthReady: true, replySha256: hash('1'), savedMessageId: randomUUID(), operationId: randomUUID(), installationProof: { jobId: result.jobId, installerResultSha256: input.evidence.installation.result.sha256, releaseId: operation.bundleSha256 } };
    const receipt = put(reply);
    input.evidence.acceptance = { receipt, observation: put({ observedAtMilliseconds: now, files: { 'assistant-acceptance-verified.json': { sha256: receipt.sha256 } }, diagnostic: { operationId: reply.operationId } }) };
  }
  const all = () => { ci('private-ci'); ci('public-ci'); pack(); observeCapacity(); recovery(); publication(); install(); };
  return { directory, put, get, operation, input, run, phase, ci, pack, observeCapacity, recovery, publication, install, all };
}

test('missing evidence blocks readiness and a draft never needs invented candidate hashes', t => {
  const f = fixture(t), report = f.run();
  assert.equal(report.evidenceComplete, false); assert.equal(report.phases.length, 8); assert.ok(report.phases.every(p => p.state === 'missing'));
  assert.equal(report.installationAuthorized, false); assert.equal(report.effectsDispatched, false); assert.equal(report.fullRehearsalRequired, true);
  Object.assign(f.operation, { stage: 'draft', candidateId: null, publicCandidateId: null, bundleSha256: null, helperHashes: null, sourceCommits: { private: null, public: null } });
  assert.equal(f.run().blockers[0].reason, 'release-not-frozen');
  f.ci('private-ci'); assert.equal(f.phase('private-ci').state, 'unknown');
  assert.throws(() => planRelease({ ...f.input, command: 'delete everything' }));
});

test('bounded reads reject changed hashes, oversize files and symlink redirection', t => {
  const f = fixture(t), ref = f.put('receipt');
  assert.equal(readEvidenceFile(ref, { baseDirectory: f.directory }).toString(), 'receipt');
  assert.throws(() => readEvidenceFile({ ...ref, sha256: hash('0') }, { baseDirectory: f.directory }), /hash-changed/);
  assert.throws(() => readEvidenceFile(ref, { baseDirectory: f.directory, maximum: 3 }), /oversized/);
  try { symlinkSync(join(f.directory, ref.path), join(f.directory, 'linked')); } catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.throws(() => readEvidenceFile({ ...ref, path: 'linked' }, { baseDirectory: f.directory }), /symlink/);
});

test('CI reuse binds exact paired sources and actual required successful job steps/logs', t => {
  const f = fixture(t); f.ci('private-ci'); f.ci('public-ci');
  assert.equal(f.phase('private-ci').state, 'passed'); assert.equal(f.phase('public-ci').state, 'passed');
  const value = f.get(f.input.evidence['private-ci'].receipt); value.repositories[0].runs[0].jobs[0].steps.pop();
  f.input.evidence['private-ci'].receipt = f.put(value); assert.equal(f.phase('private-ci').reason, 'ci-required-step-missing');
  f.operation.sourceCommits.public = commit('0'); assert.equal(f.phase('public-ci').state, 'stale');
});

test('package verifies all six install helpers, embedded pair and actual artifact bytes', t => {
  const f = fixture(t); f.pack(); assert.equal(f.phase('package').state, 'passed');
  const bundle = f.get(f.input.evidence.package.bundle); bundle.files = bundle.files.filter(file => file.name !== 'workspace_key.py');
  const ref = f.put(bundle); f.operation.bundleSha256 = ref.sha256; f.input.evidence.package.bundle = ref;
  const review = f.get(f.input.evidence.package.review); review.bundleSha256 = ref.sha256; f.input.evidence.package.review = f.put(review);
  assert.equal(f.phase('package').reason, 'package-required-entry-missing');
  f.pack(); const pairBundle = f.get(f.input.evidence.package.bundle); pairBundle.files.find(file => file.name === 'app.tgz').data = Buffer.from('tampered').toString('base64');
  const bad = f.put(pairBundle); f.operation.bundleSha256 = bad.sha256; f.input.evidence.package.bundle = bad;
  const nextReview = f.get(f.input.evidence.package.review); nextReview.bundleSha256 = bad.sha256; f.input.evidence.package.review = f.put(nextReview);
  assert.equal(f.phase('package').reason, 'package-entry-hash-changed');
});

test('capacity includes measured metadata, independent restore, growth and full reserves', t => {
  const value = capacity(), expected = Object.entries(value).filter(([key]) => key.endsWith('Bytes') && key !== 'freeBytes').reduce((sum, [, n]) => sum + n, 0);
  assert.equal(assessCapacity(value).requiredFreeBytes, expected);
  assert.equal(assessCapacity(value).allowanceAccounting, 'aggregate-two-allowances');
  assert.throws(() => assessCapacity({ ...value, allowanceBytes: 128 * 1024 ** 2 }), /reserve-reduced/);
  assert.equal(assessCapacity({ ...value, freeBytes: expected - 1 }).fits, false);
  assert.throws(() => assessCapacity({ ...value, reserveBytes: 0 }), /reserve-reduced/);
  assert.throws(() => assessCapacity({ ...value, snapshotDeltaMeasured: false }), /not-measured/);
  const f = fixture(t); f.observeCapacity(); assert.equal(f.phase('capacity').state, 'passed');
  const observation = f.get(f.input.evidence.capacity.observation); delete observation.capacity.metadataOverheadBytes; observation.expectedCleanupReclaim = 10 ** 12;
  f.input.evidence.capacity.observation = f.put(observation); assert.equal(f.phase('capacity').state, 'unknown');
});

test('capacity requires explicit native migration storage and includes it before admitting fit', t => {
  const value = capacity(), base = assessCapacity(value).requiredFreeBytes, migration = 512 * 1024 ** 2;
  const migrated = { ...value, nativeMigrationBytes: migration, freeBytes: base + migration };
  assert.equal(assessCapacity(migrated).requiredFreeBytes, base + migration);
  assert.equal(assessCapacity(migrated).fits, true);
  assert.equal(assessCapacity({ ...migrated, freeBytes: base + migration - 1 }).fits, false);
  const missing = { ...value }; delete missing.nativeMigrationBytes;
  assert.throws(() => assessCapacity(missing), /capacity-components-missing/);
  assert.throws(() => assessCapacity({ ...value, nativeMigrationBytes: -1 }), /capacity-components-missing/);
  for (const invalid of [missing, { ...value, nativeMigrationBytes: -1 }]) {
    const f = fixture(t); f.observeCapacity();
    const observation = f.get(f.input.evidence.capacity.observation); observation.capacity = invalid;
    f.input.evidence.capacity.observation = f.put(observation);
    assert.equal(f.phase('capacity').state, 'unknown');
    assert.equal(f.phase('capacity').reason, 'capacity-components-missing');
  }
});

test('capacity includes separate managed companion estimate and refuses omission', () => {
  const value = capacity(), base = assessCapacity(value).requiredFreeBytes;
  const managedCompanionBytes = 2 * 1024 ** 3;
  assert.equal(assessCapacity({ ...value, managedCompanionBytes, freeBytes: base + managedCompanionBytes }).fits, true);
  assert.equal(assessCapacity({ ...value, managedCompanionBytes, freeBytes: base + managedCompanionBytes - 1 }).fits, false);
  const missing = { ...value }; delete missing.managedCompanionBytes;
  assert.throws(() => assessCapacity(missing), /capacity-components-missing/);
});

test('a manual unchanged return cannot stand in for full rehearsal, and missing freshness blocks', t => {
  const f = fixture(t); f.recovery(); assert.equal(f.phase('recovery').state, 'passed');
  f.recovery('unchanged'); assert.equal(f.phase('recovery').reason, 'full-rehearsal-required');
  f.recovery(); const observation = f.get(f.input.evidence.recovery.observation); delete observation.observedAtMilliseconds;
  f.input.evidence.recovery.observation = f.put(observation); assert.equal(f.phase('recovery').reason, 'observation-time-missing');
  f.recovery(); f.operation.helperHashes['recovery.py'] = hash('0'); assert.equal(f.phase('recovery').state, 'stale');
});

test('publication verifies trusted signature, paired push/readback and runtime identities', t => {
  const f = fixture(t); f.publication(); assert.equal(f.phase('publication').state, 'passed');
  f.operation.trustedPublicKeySha256 = hash('0'); assert.equal(f.phase('publication').reason, 'feed-trust-key-changed');
  f.operation.trustedPublicKeySha256 = sha256(publicKey); f.operation.agentVersion = '2026.9.9'; assert.equal(f.phase('publication').reason, 'feed-runtime-changed');
  f.operation.agentVersion = '2026.9.8'; const feed = f.get(f.input.evidence.publication.feed); feed.signature = Buffer.alloc(64).toString('base64'); f.input.evidence.publication.feed = f.put(feed);
  assert.equal(f.phase('publication').reason, 'feed-signature-invalid');
});

test('complete local evidence is advisory and missing runtime or acceptance cannot pass', t => {
  const f = fixture(t); f.all(); const report = f.run();
  assert.deepEqual(report.blockers, []); assert.equal(report.evidenceComplete, true); assert.equal(report.installationAuthorized, false);
  assert.equal(report.readiness, 'completed-operation-currently-verified');
  const observation = f.get(f.input.evidence.installation.observation); delete observation.health.agentVersion;
  f.input.evidence.installation.observation = f.put(observation); assert.equal(f.phase('installation').state, 'unknown');
  delete f.input.evidence.acceptance; assert.equal(f.run().evidenceComplete, false);
});

test('acceptance is tied to the exact installation and stale observations stop verification', t => {
  const f = fixture(t); f.install(); assert.equal(f.phase('acceptance').state, 'passed');
  const receipt = f.get(f.input.evidence.acceptance.receipt); receipt.installationProof.jobId = randomUUID();
  const ref = f.put(receipt), observation = f.get(f.input.evidence.acceptance.observation); observation.files['assistant-acceptance-verified.json'].sha256 = ref.sha256;
  f.input.evidence.acceptance = { receipt: ref, observation: f.put(observation) };
  assert.equal(f.phase('acceptance').reason, 'reply-installation-changed');
  assert.equal(f.run(now + 300_001).phases.find(p => p.id === 'installation').state, 'stale');
});

test('ETA overlaps only independent preparation and adds packaging after CI', t => {
  const f = fixture(t); f.input.remainingEstimates = Object.fromEntries(PHASES.map((id, i) => [id, { rangeMs: [(i + 1) * 10, (i + 1) * 20], basis: 'Measured', confidence: 'low' }]));
  assert.deepEqual(f.run().eta.remainingRangeMs, [330, 660]); // max(10,20,40)+30+50+60+70+80
  delete f.input.remainingEstimates.recovery; assert.equal(f.run().eta.remainingRangeMs, null);
});

test('extending a forecast preserves earlier overdue checkpoints; two misses suspend only new attempts', t => {
  const f = fixture(t), timeline = f.input.timeline; timeline.original = estimate('recovery', now, [10, 20]);
  timeline.revisions.push(estimate('recovery', now + 10, [100, 200])); timeline.lastCheckpointAtMs = now + 25;
  let result = assessTimeline(timeline, { nowMs: now + 30 });
  assert.equal(result.dueReviews.length, 1); assert.equal(result.dueReviews[0].deadlineId, timeline.original.id);
  result = assessTimeline(timeline, { nowMs: now + 211 });
  assert.deepEqual(result.suspendNewAttemptsFor, ['recovery']); assert.equal(result.cancelRunningOperation, false);
  timeline.reviews.push({ deadlineId: timeline.original.id, reviewedAtMs: now + 30, action: 'continue-observing', reason: 'Worker still progressing.', evidenceSha256: hash('0') });
  assert.equal(assessTimeline(timeline, { nowMs: now + 211 }).dueReviews.length, 1);
  timeline.reviews.push(timeline.reviews[0]); assert.throws(() => assessTimeline(timeline, { nowMs: now + 211 }), /deadline-review-invalid/);
});

test('early completion is not a miss, unobserved completion time is unknown, and actual prior misses remain', t => {
  const f = fixture(t), timeline = f.input.timeline; timeline.original = estimate('package', now, [10, 20]);
  const early = [{ id: 'package', state: 'passed', verifiedAtMs: now + 10 }], late = [{ id: 'package', state: 'passed', verifiedAtMs: now + 30 }];
  assert.equal(assessTimeline(timeline, { nowMs: now + 30, phases: early }).deadlineAssessments[0].state, 'completed-on-time');
  assert.equal(assessTimeline(timeline, { nowMs: now + 30, phases: late }).deadlineAssessments[0].state, 'completion-time-unknown');
  const overdue = assessTimeline(timeline, { nowMs: now + 21, phases: [{ id: 'package', state: 'missing' }] });
  const completed = assessTimeline(timeline, { nowMs: now + 30, phases: late, previousAssessments: overdue.deadlineAssessments });
  assert.equal(completed.deadlineMisses.package, 1); assert.equal(completed.suspendNewAttemptsFor.length, 0);
  const observedOnTime = assessTimeline(timeline, { nowMs: now + 30, phases: early });
  const laterExpired = assessTimeline(timeline, { nowMs: now + 3600_000, phases: [{ id: 'package', state: 'stale' }], previousAssessments: observedOnTime.deadlineAssessments });
  assert.equal(laterExpired.deadlineAssessments[0].state, 'completed-on-time'); assert.equal(laterExpired.dueReviews.length, 0);
});

test('a 40-minute completed release retains historical gaps without treating them as new admission authority', t => {
  const f = fixture(t); f.all(); const later = now + 40 * 60_000;
  const capacityReceipt = f.input.evidence.capacity.observation;
  for (const id of ['installation', 'acceptance']) {
    const observation = f.get(f.input.evidence[id].observation); observation.observedAtMilliseconds = later;
    f.input.evidence[id].observation = f.put(observation);
  }
  const result = f.run(later);
  assert.equal(result.phases.find(p => p.id === 'capacity').state, 'stale');
  assert.equal(result.phases.find(p => p.id === 'capacity').requiredForRemainingOperation, false);
  assert.equal(result.operationComplete, true); assert.equal(result.evidenceComplete, false);
  assert.deepEqual(result.eta.remainingRangeMs, [0, 0]);
  assert.equal(result.eta.deadlineAssessments[0].state, 'completion-time-unknown');
  assert.equal(result.eta.dueReviews.length, 0);
  assert.equal(result.readiness, 'completed-operation-currently-verified'); assert.equal(result.nextPhase, null);
  assert.equal(result.installationAuthorized, false); assert.equal(result.fullRehearsalRequired, true);
  assert.deepEqual(f.input.evidence.capacity.observation, capacityReceipt);
  // A readied host or stale completed job alone never excuses preflight.
  delete f.input.evidence.acceptance;
  assert.equal(f.run(later).operationComplete, false); assert.equal(f.run(later).readiness, 'blocked');
  assert.equal(f.run(later).phases.find(p => p.id === 'capacity').requiredForRemainingOperation, true);
});

test('resume preserves a previously verified completion even if freshness expires before the deadline is reviewed', t => {
  const f = fixture(t); f.observeCapacity(); f.input.timeline.original = estimate('capacity', now, [1000, 400_000]);
  const first = f.run(); assert.equal(first.eta.deadlineAssessments.length, 0);
  f.input.previousReport = f.put(first);
  const expired = f.run(now + 500_000);
  assert.equal(expired.phases.find(p => p.id === 'capacity').state, 'stale');
  assert.equal(expired.eta.deadlineAssessments[0].state, 'completed-on-time');
  assert.equal(expired.eta.dueReviews.length, 0);
});

test('hash-bound resume preserves original deadline and accepts only unknown draft identities becoming known', t => {
  const f = fixture(t), frozen = structuredClone(f.operation);
  Object.assign(f.operation, { stage: 'draft', candidateId: null, publicCandidateId: null, bundleSha256: null, helperHashes: null, sourceCommits: { private: null, public: null } });
  const first = f.run(); f.input.previousReport = f.put(first); f.input.operation = frozen;
  assert.equal(f.run().eta.historyVerifiedAgainstPrevious, true);
  f.input.timeline.original.remainingMs = [900_000, 1800_000]; assert.throws(() => f.run(), /original-estimate-reset/);
  f.input.timeline = structuredClone(first.timeline); f.input.operation.priorCandidateId = hash('0'); assert.throws(() => f.run(), /draft-identity-replaced/);
  assert.throws(() => validateOperationContinuation({ ...frozen, candidateId: hash('0') }, frozen), /operation-changed/);
  assert.notEqual(releaseOperationIdentity(first.operation), releaseOperationIdentity(frozen));
});

test('phase transitions request a checkpoint, and read-only CLI never follows command fields', t => {
  const f = fixture(t); f.input.previousReport = f.put(f.run()); f.ci('private-ci');
  assert.equal(f.run().eta.phaseChanged, true); assert.equal(f.run().eta.checkpointDue, true);
  // The CLI owns its real clock. Do not ask it to accept a future test epoch.
  delete f.input.previousReport; const liveNow = Date.now();
  f.input.timeline = { startedAtMs: liveNow, original: estimate('total', liveNow), revisions: [], reviews: [], lastCheckpointAtMs: liveNow };
  const path = join(f.directory, 'input.json'); writeFileSync(path, JSON.stringify(f.input));
  const before = readdirSync(f.directory).sort(), script = fileURLToPath(new URL('../scripts/release-plan.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr); assert.equal(JSON.parse(result.stdout).effectsDispatched, false); assert.deepEqual(readdirSync(f.directory).sort(), before);
  writeFileSync(path, JSON.stringify({ ...f.input, command: 'echo should-never-run' }));
  const rejected = spawnSync(process.execPath, [script, path], { encoding: 'utf8' }); assert.equal(rejected.status, 1); assert.equal(JSON.parse(rejected.stdout).reason, 'invalid-input-or-resume-history');
});

test('internal SQLite report handoff matches file-bound resume and rejects ambiguous or changed history', t => {
  const f = fixture(t), previous = f.run();
  f.input.previousReport = f.put(previous);
  const fromFile = f.run(); delete f.input.previousReport;
  assert.deepEqual(planRelease(f.input, { baseDirectory: f.directory, nowMs: now, previousReport: previous }), fromFile);
  f.input.previousReport = f.put(previous);
  assert.throws(() => planRelease(f.input, { baseDirectory: f.directory, nowMs: now, previousReport: previous }), /ambiguous-previous-report/);
  delete f.input.previousReport; const bad = structuredClone(previous); bad.operationIdentity = hash('0');
  assert.throws(() => planRelease(f.input, { nowMs: now, previousReport: bad }), /previous-operation-identity-invalid/);
});
