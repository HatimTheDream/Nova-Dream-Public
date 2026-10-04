/** Read-only release planning. Evidence is operator-selected, hash-bound local
 * material, not a substitute for the maintained controller's live verification.
 * No input field is interpreted as a command, no network request is made, and
 * nothing is persisted. The caller must retain the returned timeline and pass
 * the previous report by hash when resuming; this tool is not yet a journal.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const PHASES = Object.freeze(['private-ci', 'public-ci', 'package', 'capacity', 'recovery', 'publication', 'installation', 'acceptance']);
export const RELEASE_PLAN_LIMITS = Object.freeze({ inputBytes: 256 * 1024, receiptBytes: 2 * 1024 ** 2, logBytes: 8 * 1024 ** 2, bundleBytes: 128 * 1024 ** 2, totalBytes: 160 * 1024 ** 2, freshMs: 5 * 60_000 });
const hash = z.string().regex(/^[a-f0-9]{64}$/), commit = z.string().regex(/^[a-f0-9]{40}$/);
const text = z.string().trim().min(1).max(500), timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const duration = z.number().int().nonnegative().max(31 * 86400_000);
const range = z.tuple([duration, duration]).refine(([a, b]) => a <= b, 'Invalid duration range');
const reference = z.object({ path: z.string().min(1).max(4096).refine(v => !v.includes('\0') && !/^[a-z]+:\/\//i.test(v)), sha256: hash }).strict();
const runtimeVersion = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
const packagedHelpers = ['install.py', 'recovery.py', 'codex_log_retention.py', 'app_dependencies.py', 'workspace_key.py', 'verify-session-bindings.mjs'];
const helperNames = [...packagedHelpers, 'operator_rehearsal.py'];
export const releaseOperationSchema = z.object({
  id: z.uuid(), stage: z.enum(['draft', 'frozen']).default('frozen'),
  candidateId: hash.nullable(), publicCandidateId: hash.nullable(), priorCandidateId: hash, workspaceEpoch: z.uuid(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/), buildVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  agentVersion: runtimeVersion, priorAgentVersion: runtimeVersion,
  sourceCommits: z.object({ private: commit.nullable(), public: commit.nullable() }).strict(), bundleSha256: hash.nullable(),
  trustedPublicKeySha256: hash.nullable().default(null),
  changeClass: z.enum(['presentation', 'application', 'runtime', 'dependency', 'schema', 'updater', 'security', 'unknown']),
  helperHashes: z.record(z.enum(helperNames), hash).nullable(),
}).strict().refine(v => v.stage === 'draft' || [v.candidateId, v.publicCandidateId, v.bundleSha256, v.sourceCommits.private, v.sourceCommits.public, v.helperHashes].every(Boolean), 'Frozen identities must be known');
const estimate = z.object({ id: z.uuid(), step: z.enum(['total', ...PHASES]), issuedAtMs: timestamp,
  remainingMs: range.nullable(), confidence: z.enum(['low', 'medium', 'high', 'unknown']), basis: text,
  reason: text, nextCheckpointAtMs: timestamp }).strict().refine(v => v.nextCheckpointAtMs > v.issuedAtMs && v.nextCheckpointAtMs <= v.issuedAtMs + 300_000,
  'Checkpoint must be within five minutes').refine(v => v.remainingMs !== null || v.confidence === 'unknown', 'Unknown ETA needs unknown confidence');
const review = z.object({ deadlineId: z.uuid(), reviewedAtMs: timestamp,
  action: z.enum(['continue-observing', 'change-approach', 'supported-recovery', 'blocked']), reason: text,
  evidenceSha256: hash }).strict();
export const releaseTimelineSchema = z.object({ startedAtMs: timestamp, original: estimate,
  revisions: z.array(estimate).max(128).default([]), reviews: z.array(review).max(128).default([]),
  lastCheckpointAtMs: timestamp }).strict();
export const releasePlanInputSchema = z.object({ format: z.literal(1), operation: releaseOperationSchema,
  evidence: z.partialRecord(z.enum(PHASES), z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), reference).refine(v => Object.keys(v).length <= 8)).default({}),
  timeline: releaseTimelineSchema, previousReport: reference.optional(),
  remainingEstimates: z.partialRecord(z.enum(PHASES), z.object({ rangeMs: range.nullable(), basis: text, confidence: z.enum(['low', 'medium', 'high', 'unknown']) }).strict()).default({}),
}).strict();

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function releaseOperationIdentity(operation) { return sha256(canonical(releaseOperationSchema.parse(operation))); }
class EvidenceError extends Error { constructor(state, code) { super(code); this.state = state; this.code = code; } }
const need = (value, code, state = 'unknown') => { if (!value) throw new EvidenceError(state, code); };
const same = (a, b, code) => need(canonical(a) === canonical(b), code, 'stale');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const identity = info => [info.dev, info.ino, info.size, info.mode, info.mtimeMs, info.nlink].join(':');
/** Only a previously unknown draft identity may become known on resume. */
export function validateOperationContinuation(current, previous) {
  const next = releaseOperationSchema.parse(current), before = releaseOperationSchema.parse(previous);
  if (before.stage === 'frozen') return same(next, before, 'operation-changed-on-resume');
  const merge = (oldValue, newValue) => {
    if (oldValue === null) return;
    if (oldValue && typeof oldValue === 'object') for (const key of Object.keys(oldValue)) merge(oldValue[key], newValue?.[key]);
    else same(oldValue, newValue, 'draft-identity-replaced');
  };
  const { stage: _old, ...oldFields } = before, { stage: _new, ...newFields } = next;
  merge(oldFields, newFields);
}

/** Bounded stable read, including ancestors; never follows an input symlink.
 * Paths in receipts are never opened implicitly: only explicit input references.
 */
export function readEvidenceFile(ref, { baseDirectory = process.cwd(), maximum = RELEASE_PLAN_LIMITS.receiptBytes } = {}) {
  reference.parse(ref);
  return stableRead(resolve(baseDirectory, ref.path), maximum, ref.sha256);
}
function stableRead(path, maximum, expectedHash) {
  need(Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= RELEASE_PLAN_LIMITS.bundleBytes, 'invalid-read-limit');
  for (let part = path; ; part = dirname(part)) {
    const info = lstatSync(part);
    need(!info.isSymbolicLink(), 'symlink-evidence');
    if (part !== path) need(info.isDirectory(), 'non-directory-evidence-ancestor');
    if (dirname(part) === part) break;
  }
  need(resolve(realpathSync(path)) === path, 'redirected-evidence-path');
  const before = lstatSync(path);
  need(before.isFile() && before.size <= maximum, 'unsafe-or-oversized-evidence');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd); need(identity(before) === identity(opened), 'evidence-replaced');
    // The allocation is bounded even if another process grows the file after stat.
    const buffer = Buffer.alloc(Math.min(opened.size + 1, maximum + 1)); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
    const bytes = buffer.subarray(0, length);
    need(bytes.length <= maximum && identity(opened) === identity(fstatSync(fd)) && identity(before) === identity(lstatSync(path)), 'evidence-changed-during-read');
    if (expectedHash) need(sha256(bytes) === expectedHash, 'evidence-hash-changed', 'stale');
    return bytes;
  } finally { closeSync(fd); }
}

function reader(baseDirectory) {
  let total = 0;
  return (files, name, maximum, json = true) => {
    need(files[name], `missing-${name}`, 'missing');
    const bytes = readEvidenceFile(files[name], { baseDirectory, maximum });
    total += bytes.length; need(total <= RELEASE_PLAN_LIMITS.totalBytes, 'evidence-budget-exceeded');
    if (!json) return bytes;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  };
}
function fresh(value, now, maxAge = RELEASE_PLAN_LIMITS.freshMs) {
  const at = value.observedAtMilliseconds ?? (Number.isSafeInteger(value.observedAtUnixSeconds) ? value.observedAtUnixSeconds * 1000 : undefined);
  need(nonnegative(at), 'observation-time-missing');
  need(at <= now && now - at <= maxAge, 'observation-stale', 'stale');
  return at;
}
function flags(value) { need(['savedWorkVerified', 'accountsVerified', 'recoveryVerified', 'healthVerified'].every(k => value[k] === true), 'acceptance-incomplete'); }

/** Same reserve as recovery.py; allowanceBytes is the aggregate TWO allowances
 * (at least 2 * 128 MiB), matching maintained closedCapacity receipts. Online projections never
 * replace stopped admission, and no expected cleanup reclaim is counted.
 */
export function assessCapacity(value) {
  const fields = ['freeBytes', 'candidateBytes', 'snapshotCopyBytes', 'independentRestoreBytes', 'startupGrowthAllowanceBytes', 'nativeMigrationBytes', 'managedCompanionBytes', 'metadataOverheadBytes', 'reserveBytes', 'allowanceBytes'];
  need(fields.every(k => nonnegative(value[k])), 'capacity-components-missing');
  need(value.reserveBytes >= 1536 * 1024 ** 2 && value.allowanceBytes >= 256 * 1024 ** 2, 'capacity-reserve-reduced');
  need(value.independentRestoreBytes > 0 && value.metadataOverheadMeasured === true && value.snapshotDeltaMeasured === true, 'capacity-not-measured');
  need(['online', 'closed'].includes(value.lifecycle), 'capacity-lifecycle-missing');
  const requiredFreeBytes = fields.filter(k => k !== 'freeBytes').reduce((sum, key) => sum + value[key], 0);
  need(Number.isSafeInteger(requiredFreeBytes), 'capacity-overflow');
  return { requiredFreeBytes, freeBytes: value.freeBytes, marginBytes: value.freeBytes - requiredFreeBytes,
    fits: value.freeBytes >= requiredFreeBytes, lifecycle: value.lifecycle, authoritativeAdmission: false,
    allowanceAccounting: 'aggregate-two-allowances', stoppedAndPostStartChecksRequired: true, expectedCleanupReclaimCounted: false };
}

function qualify(phase, files, operation, read, now) {
  const json = name => read(files, name, RELEASE_PLAN_LIMITS.receiptBytes);
  const requireKnown = (...values) => need(values.every(v => v !== null && v !== undefined), 'identity-not-frozen');
  if (phase.endsWith('-ci')) {
    const receipt = json('receipt'), privateRepo = phase === 'private-ci';
    const name = privateRepo ? 'Nova-Dream' : 'Nova-Dream-Public', source = operation.sourceCommits[privateRepo ? 'private' : 'public'];
    requireKnown(source);
    same(receipt.sourceVersion, operation.version, 'ci-version-changed');
    need(receipt.format === 1 && receipt.readOnly === true, 'ci-observation-required');
    const repos = list(receipt.repositories).filter(r => r.repository === name); need(repos.length === 1, 'ci-repository-ambiguous');
    same(repos[0].sha, source, 'ci-source-changed');
    const runs = list(repos[0].runs).filter(r => r.name === (privateRepo ? 'Nova Dream quality and release history' : 'Application quality'));
    need(runs.length === 1 && runs[0].status === 'completed' && runs[0].conclusion === 'success', 'ci-run-not-successful');
    const jobs = list(runs[0].jobs).filter(j => j.name === 'quality');
    need(jobs.length === 1 && jobs[0].status === 'completed' && jobs[0].conclusion === 'success', 'ci-job-not-successful');
    for (const name of ['Run npm run quality', 'Verify Linux update recovery']) {
      const steps = list(jobs[0].steps).filter(s => s.name === name);
      need(steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success', 'ci-required-step-missing');
    }
    same(files.log?.sha256, jobs[0].logSha256, 'ci-log-binding-changed');
    const log = read(files, 'log', RELEASE_PLAN_LIMITS.logBytes, false).toString('utf8');
    need(log.includes('Run npm run quality') && log.includes('tests/update-runner.test.py') && /# fail 0\b/.test(log), 'ci-log-incomplete');
    return { reuse: 'exact-source', sourceCommit: source, runId: runs[0].id, jobId: jobs[0].id };
  }
  if (phase === 'package') {
    requireKnown(operation.candidateId, operation.publicCandidateId, operation.bundleSha256, operation.helperHashes, ...Object.values(operation.sourceCommits));
    const review = json('review');
    same(review.candidateId, operation.candidateId, 'package-candidate-changed');
    same(review.publicCandidateId, operation.publicCandidateId, 'package-public-candidate-changed');
    same(review.sourceCommits, { 'Nova-Dream': operation.sourceCommits.private, 'Nova-Dream-Public': operation.sourceCommits.public }, 'package-source-changed');
    same(review.bundleSha256, operation.bundleSha256, 'package-bundle-changed');
    same(files.bundle?.sha256, operation.bundleSha256, 'package-artifact-changed');
    const bundle = read(files, 'bundle', RELEASE_PLAN_LIMITS.bundleBytes);
    need(bundle.format === 1 && Array.isArray(bundle.files) && bundle.files.length > 0 && bundle.files.length <= 64, 'package-format-unsupported');
    const names = new Set(), contents = new Map();
    const excluded = new Set(['bundle.json', 'runtime.tgz', 'app-dependencies.tgz', 'request.json', 'result.json', 'runner.log', 'attempts']);
    for (const file of bundle.files) {
      need(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(file.name) && !names.has(file.name) && !excluded.has(file.name) && !file.name.startsWith('preflight-'), 'package-entry-invalid'); names.add(file.name);
      need(typeof file.data === 'string', 'package-entry-missing');
      const data = Buffer.from(file.data, 'base64');
      need(data.toString('base64') === file.data && sha256(data) === file.sha256, 'package-entry-hash-changed', 'stale');
      contents.set(file.name, data);
      if (operation.helperHashes[file.name]) same(file.sha256, operation.helperHashes[file.name], 'package-helper-changed');
    }
    need([...packagedHelpers, 'app.tgz', 'reviewed-pair.json'].every(name => names.has(name)), 'package-required-entry-missing');
    const pair = JSON.parse(contents.get('reviewed-pair.json').toString('utf8'));
    need(pair.format === 1 && nonnegative(pair.archiveBytes), 'package-pair-unsupported');
    same(pair.candidateId, operation.candidateId, 'package-pair-candidate-changed'); same(pair.priorCandidateId, operation.priorCandidateId, 'package-pair-prior-changed');
    same(pair.archiveSha256, sha256(contents.get('app.tgz')), 'package-archive-changed'); same(pair.archiveBytes, contents.get('app.tgz').length, 'package-archive-size-changed');
    same(review.archiveSha256, pair.archiveSha256, 'package-review-archive-changed');
    same(pair.helpers, Object.fromEntries(packagedHelpers.filter(name => name !== 'install.py').map(name => [name, operation.helperHashes[name]])), 'package-pair-helpers-changed');
    return { reuse: 'exact-source-artifacts', bundleSha256: operation.bundleSha256 };
  }
  if (phase === 'capacity') {
    const observation = json('observation'); fresh(observation, now);
    same(observation.workspaceEpoch, operation.workspaceEpoch, 'capacity-workspace-changed');
    same(observation.health?.candidateId, operation.priorCandidateId, 'capacity-prior-changed');
    requireKnown(observation.health?.agentVersion ?? observation.runtime?.agentVersion);
    same(observation.health?.agentVersion ?? observation.runtime?.agentVersion, operation.priorAgentVersion, 'capacity-runtime-changed');
    need(observation.readOnly === true && observation.health?.status === 'ready', 'capacity-host-not-ready');
    // Normalized measured capacity uses the maintained components. Older online
    // estimates with an unmeasured delta are deliberately unknown, not upgraded.
    const assessment = assessCapacity(object(observation.capacity));
    need(assessment.fits, 'insufficient-capacity');
    return assessment;
  }
  if (phase === 'recovery') {
    requireKnown(operation.helperHashes);
    const observation = json('observation'), review = json('review'), proof = json('proof'); fresh(observation, now, 3600_000);
    same(review.candidateId, operation.priorCandidateId, 'recovery-prior-changed');
    same(review.workspaceEpoch, operation.workspaceEpoch, 'recovery-workspace-changed');
    same(review.helperHashes, operation.helperHashes, 'recovery-helpers-changed');
    const completed = object(observation.completedProof);
    same(completed.reviewSha256, files.review.sha256, 'recovery-review-changed');
    same(completed.proofSha256, files.proof.sha256, 'recovery-proof-changed');
    same(completed.proof, proof, 'recovery-embedded-proof-changed');
    same(proof.candidateId, operation.priorCandidateId, 'recovery-proof-prior-changed');
    same(proof.workspaceEpoch, operation.workspaceEpoch, 'recovery-proof-workspace-changed');
    same(proof.leaseId, review.leaseId, 'recovery-lease-changed');
    need(proof.kind === 'operator-maintenance-acceptance' && proof.outcome === 'rehearsed', 'full-rehearsal-required'); flags(proof);
    need(completed.originalReturned === true && completed.nativeLeaseReleaseSettled === true && observation.status?.lastPhase === 'complete', 'recovery-not-settled');
    need(observation.operator?.phase === 'released' && observation.operator?.releaseKind === 'rehearsed', 'recovery-not-released');
    same(observation.operator?.id, review.leaseId, 'recovery-released-lease-changed');
    same(observation.operator?.proofSha256, files.proof.sha256, 'recovery-released-proof-changed');
    return { reuse: 'bounded-observation-only', fullRehearsalRequired: true, proofSha256: files.proof.sha256 };
  }
  if (phase === 'publication') {
    requireKnown(operation.candidateId, operation.bundleSha256, operation.trustedPublicKeySha256, ...Object.values(operation.sourceCommits));
    const receipt = json('receipt'), envelope = json('feed');
    same(files.publicKey?.sha256, operation.trustedPublicKeySha256, 'feed-trust-key-changed');
    const key = createPublicKey(read(files, 'publicKey', 16 * 1024, false));
    need(key.asymmetricKeyType === 'ed25519' && typeof envelope.payload === 'string' && typeof envelope.signature === 'string', 'feed-envelope-invalid');
    const bytes = Buffer.from(envelope.payload, 'base64');
    need(bytes.length <= 128 * 1024 && bytes.toString('base64') === envelope.payload && verify(null, bytes, key, Buffer.from(envelope.signature, 'base64')), 'feed-signature-invalid');
    const manifest = JSON.parse(bytes.toString('utf8'));
    need(Number.isSafeInteger(manifest.sequence) && manifest.sequence > 0 && Date.parse(manifest.createdAt) <= now && Date.parse(manifest.expiresAt) > now, 'feed-stale', 'stale');
    const releases = list(manifest.releases).filter(r => r.candidateId === operation.candidateId);
    need(releases.length === 1, 'feed-candidate-missing'); same(releases[0].fromCandidateId, operation.priorCandidateId, 'feed-prior-changed');
    same(releases[0].agentVersion, operation.agentVersion, 'feed-runtime-changed');
    same(releases[0].novaVersion, operation.version, 'feed-app-version-changed');
    same(releases[0].compatibility?.fromAgentVersion, operation.priorAgentVersion, 'feed-prior-runtime-changed');
    need(releases[0].compatibility?.reviewed === true, 'feed-compatibility-missing');
    same(releases[0].bundle?.sha256, operation.bundleSha256, 'feed-artifact-changed');
    need(receipt.publicFeedReadVerified === true && receipt.publicFeedSha256 === files.feed.sha256 && receipt.sequence === manifest.sequence, 'feed-readback-missing');
    for (const [name, commit] of [['Nova-Dream', operation.sourceCommits.private], ['Nova-Dream-Public', operation.sourceCommits.public]]) {
      const repos = list(receipt.repositories).filter(r => r.repository === name);
      need(repos.length === 1 && repos[0].pushed === true && repos[0].feedSha256 === files.feed.sha256 && repos[0].sequence === manifest.sequence, 'paired-feed-publication-missing');
      same(repos[0].sourceCommit, commit, 'feed-source-changed');
    }
    return { signatureChecked: true, controllerTrustAndSequenceCheckStillRequired: true };
  }
  if (phase === 'installation') {
    requireKnown(operation.candidateId, operation.bundleSha256);
    const observation = json('observation'), result = json('result'); fresh(observation, now);
    same(observation.installerResult, result, 'installer-result-changed');
    same(result.candidateId, operation.candidateId, 'installed-candidate-changed');
    same(result.priorCandidateId, operation.priorCandidateId, 'installed-prior-changed');
    same(observation.job?.epoch, operation.workspaceEpoch, 'installed-workspace-changed');
    same(observation.job?.candidateId, operation.candidateId, 'installed-job-candidate-changed');
    same(observation.job?.fromCandidateId, operation.priorCandidateId, 'installed-job-prior-changed');
    same(observation.job?.releaseId, operation.bundleSha256, 'installed-job-artifact-changed');
    need(result.outcome === 'completed' && observation.job?.id === result.jobId && observation.job?.state === 'completed' && observation.job?.hold === false, 'installation-not-complete'); flags(result);
    need(observation.controller?.holdFor === null && observation.controller?.currentJobId === result.jobId && observation.controller?.currentJobMatches === true, 'installation-hold-unsettled');
    need(observation.health?.status === 'ready' && observation.health?.candidateId === operation.candidateId, 'installed-health-unverified');
    same(observation.health?.version, operation.version, 'installed-version-changed'); same(observation.health?.buildVersion, operation.buildVersion, 'installed-build-changed');
    requireKnown(observation.health?.agentVersion ?? observation.runtime?.agentVersion);
    same(observation.health?.agentVersion ?? observation.runtime?.agentVersion, operation.agentVersion, 'installed-runtime-changed');
    return { jobId: result.jobId, installerResultSha256: files.result.sha256, freshAcceptanceStillRequired: true };
  }
  requireKnown(operation.candidateId, operation.bundleSha256);
  const receipt = json('receipt'), observation = json('observation'); fresh(observation, now);
  same(receipt.candidateId, operation.candidateId, 'reply-candidate-changed'); same(receipt.epoch, operation.workspaceEpoch, 'reply-workspace-changed');
  same(observation.files?.['assistant-acceptance-verified.json']?.sha256, files.receipt.sha256, 'reply-receipt-unobserved');
  need(receipt.status === 'verified' && receipt.operationState === 'completed' && ['genuineReplyVerified', 'savedReplyVerified', 'noToolsUsed', 'oldUnknownsUnchanged', 'maintenanceReleased', 'nativeModelAuthReady'].every(k => receipt[k] === true), 'reply-acceptance-incomplete');
  need(hash.safeParse(receipt.replySha256).success && typeof receipt.savedMessageId === 'string' && typeof receipt.operationId === 'string', 'reply-identity-missing');
  same(observation.diagnostic?.operationId, receipt.operationId, 'reply-operation-changed');
  need(z.uuid().safeParse(receipt.installationProof?.jobId).success && hash.safeParse(receipt.installationProof?.installerResultSha256).success, 'reply-installation-binding-missing');
  same(receipt.installationProof?.releaseId, operation.bundleSha256, 'reply-release-changed');
  return { operationId: receipt.operationId, installationProof: receipt.installationProof, browserUiVerified: receipt.browserUiVerified === true };
}

export function assessTimeline(raw, { nowMs = Date.now(), previous, previousAssessments = [], phases = [], remainingEstimates = {}, operationCompletedAtMs } = {}) {
  const timeline = releaseTimelineSchema.parse(raw), forecasts = [timeline.original, ...timeline.revisions];
  need(timeline.startedAtMs <= timeline.original.issuedAtMs && timeline.original.issuedAtMs <= nowMs && timeline.lastCheckpointAtMs <= nowMs, 'timeline-time-invalid');
  need(timeline.lastCheckpointAtMs >= timeline.startedAtMs, 'checkpoint-before-start');
  const ids = new Set(); let last = timeline.original.issuedAtMs;
  for (const item of forecasts) {
    need(!ids.has(item.id) && item.issuedAtMs >= last && item.issuedAtMs <= nowMs, 'forecast-order-invalid'); ids.add(item.id); last = item.issuedAtMs;
  }
  if (previous) {
    same(timeline.startedAtMs, previous.startedAtMs, 'timeline-start-reset'); same(timeline.original, previous.original, 'original-estimate-reset');
    same(timeline.revisions.slice(0, previous.revisions.length), previous.revisions, 'forecast-history-reset');
    same(timeline.reviews.slice(0, previous.reviews.length), previous.reviews, 'review-history-reset');
    need(timeline.lastCheckpointAtMs >= previous.lastCheckpointAtMs, 'checkpoint-reset', 'stale');
  }
  const expired = forecasts.filter(e => e.remainingMs !== null && e.issuedAtMs + e.remainingMs[1] <= nowMs);
  const deadlineAssessments = expired.map(e => {
    const deadlineAtMs = e.issuedAtMs + e.remainingMs[1], old = previousAssessments.find(item => item.deadlineId === e.id);
    const completedPhase = p => p.state === 'passed' || nonnegative(p.firstVerifiedAtMs);
    const completed = e.step === 'total' ? nonnegative(operationCompletedAtMs) || PHASES.every(id => phases.some(p => p.id === id && completedPhase(p))) : phases.some(p => p.id === e.step && completedPhase(p));
    const completedAtMs = e.step === 'total' ? operationCompletedAtMs ?? Math.max(...phases.map(p => p.firstVerifiedAtMs ?? p.verifiedAtMs ?? Infinity)) : (phases.find(p => p.id === e.step)?.firstVerifiedAtMs ?? phases.find(p => p.id === e.step)?.verifiedAtMs);
    const state = ['missed', 'completed-on-time'].includes(old?.state) ? old.state : !completed ? 'missed' : completedAtMs <= deadlineAtMs ? 'completed-on-time' : 'completion-time-unknown';
    return { deadlineId: e.id, step: e.step, deadlineAtMs, state };
  });
  const reviewed = new Set();
  for (const item of timeline.reviews) {
    const target = deadlineAssessments.find(e => e.deadlineId === item.deadlineId);
    need(target?.state === 'missed' && !reviewed.has(item.deadlineId) && item.reviewedAtMs >= target.deadlineAtMs && item.reviewedAtMs <= nowMs, 'deadline-review-invalid'); reviewed.add(item.deadlineId);
  }
  const dueReviews = deadlineAssessments.filter(e => e.state === 'missed' && !reviewed.has(e.deadlineId));
  const misses = Object.fromEntries(['total', ...PHASES].map(step => [step, deadlineAssessments.filter(e => e.step === step && e.state === 'missed').length]));
  const suspendNewAttemptsFor = Object.entries(misses).filter(([step, count]) => count >= 2 && (step === 'total' ? !PHASES.every(id => phases.some(p => p.id === id && p.state === 'passed')) : !phases.some(p => p.id === step && p.state === 'passed'))).map(([step]) => step);
  const groups = [['private-ci', 'public-ci', 'capacity'], ['package'], ['recovery'], ['publication'], ['installation'], ['acceptance']];
  let remainingRangeMs = [0, 0];
  for (const group of groups) {
    const needed = group.filter(id => !phases.some(p => p.id === id && p.state === 'passed'));
    if (needed.some(id => !remainingEstimates[id]?.rangeMs)) { remainingRangeMs = null; break; }
    remainingRangeMs = remainingRangeMs.map((sum, index) => sum + Math.max(0, ...needed.map(id => remainingEstimates[id].rangeMs[index])));
  }
  const future = forecasts.flatMap(e => [e.nextCheckpointAtMs, ...(e.remainingMs ? [e.issuedAtMs + e.remainingMs[1]] : [])]).filter(t => t > timeline.lastCheckpointAtMs);
  const nextCheckpointAtMs = Math.min(timeline.lastCheckpointAtMs + 300_000, ...future);
  return { elapsedMs: nowMs - timeline.startedAtMs, original: timeline.original, latest: forecasts.at(-1),
    remainingRangeMs, expectedFinishMs: remainingRangeMs?.map(n => nowMs + n) ?? null,
    nextCheckpointAtMs, checkpointDue: nowMs >= nextCheckpointAtMs || dueReviews.length > 0, dueReviews,
    deadlineAssessments, deadlineMisses: misses, suspendNewAttemptsFor, cancelRunningOperation: false, parallelPreparationAccounted: true,
    historyVerifiedAgainstPrevious: !!previous };
}

export function planRelease(raw, { baseDirectory = process.cwd(), nowMs = Date.now(), previousReport } = {}) {
  const input = releasePlanInputSchema.parse(raw); need(nonnegative(nowMs), 'invalid-clock');
  const operationIdentity = releaseOperationIdentity(input.operation), read = reader(baseDirectory);
  need(!(input.previousReport && previousReport !== undefined), 'ambiguous-previous-report');
  let previous = previousReport;
  if (input.previousReport) previous = JSON.parse(readEvidenceFile(input.previousReport, { baseDirectory }));
  if (previous !== undefined) {
    need(Buffer.byteLength(canonical(previous)) <= RELEASE_PLAN_LIMITS.receiptBytes, 'previous-report-too-large');
    need(previous.format === 1 && previous.kind === 'nova-release-plan', 'previous-report-invalid');
    same(previous.operationIdentity, releaseOperationIdentity(previous.operation), 'previous-operation-identity-invalid');
    validateOperationContinuation(input.operation, previous.operation);
    need(nonnegative(previous.generatedAtMs) && previous.generatedAtMs <= nowMs, 'previous-report-time-invalid');
    need(previous.firstOperationCompleteAtMs === undefined || nonnegative(previous.firstOperationCompleteAtMs) && previous.firstOperationCompleteAtMs <= previous.generatedAtMs, 'previous-operation-completion-invalid');
    releaseTimelineSchema.parse(previous.timeline);
    need(Array.isArray(previous.phases) && previous.phases.length === PHASES.length && PHASES.every(id => previous.phases.filter(p => p.id === id).length === 1), 'previous-phases-invalid');
    need(previous.phases.every(p => ['passed', 'missing', 'stale', 'unknown'].includes(p.state) && (p.state !== 'passed' || nonnegative(p.verifiedAtMs) && p.verifiedAtMs <= previous.generatedAtMs)), 'previous-phase-time-invalid');
    need(previous.phases.every(p => p.firstVerifiedAtMs === undefined || nonnegative(p.firstVerifiedAtMs) && p.firstVerifiedAtMs <= previous.generatedAtMs), 'previous-completion-time-invalid');
    need(Array.isArray(previous.eta?.deadlineAssessments), 'previous-deadlines-missing');
    const forecasts = [previous.timeline.original, ...previous.timeline.revisions];
    need(previous.eta.deadlineAssessments.every(item => {
      const forecast = forecasts.find(f => f.id === item.deadlineId);
      return forecast?.remainingMs && item.step === forecast.step && item.deadlineAtMs === forecast.issuedAtMs + forecast.remainingMs[1] && item.deadlineAtMs <= previous.generatedAtMs && ['missed', 'completed-on-time', 'completion-time-unknown'].includes(item.state);
    }), 'previous-deadlines-invalid');
  }
  const phases = PHASES.map(id => {
    if (!input.evidence[id]) return { id, state: 'missing', reason: 'evidence-not-provided' };
    try { const detail = qualify(id, input.evidence[id], input.operation, read, nowMs);
      const before = previous?.phases?.find(p => p.id === id && p.state === 'passed');
      need(!before || nonnegative(before.verifiedAtMs) && before.verifiedAtMs <= previous.generatedAtMs, 'previous-phase-time-invalid');
      return { id, state: 'passed', verifiedAtMs: before?.verifiedAtMs ?? nowMs, detail }; }
    catch (error) { return { id, state: error instanceof EvidenceError ? error.state : error.code === 'ENOENT' ? 'missing' : 'unknown', reason: error instanceof EvidenceError ? error.code : error.code === 'ENOENT' ? 'evidence-file-missing' : 'evidence-not-verifiable' }; }
  });
  const installation = phases.find(p => p.id === 'installation'), acceptance = phases.find(p => p.id === 'acceptance');
  if (acceptance.state === 'passed' && installation.state === 'passed' &&
    (acceptance.detail.installationProof.jobId !== installation.detail.jobId || acceptance.detail.installationProof.installerResultSha256 !== installation.detail.installerResultSha256)) {
    Object.assign(acceptance, { state: 'stale', reason: 'reply-installation-changed' }); delete acceptance.detail; delete acceptance.verifiedAtMs;
  }
  for (const phase of phases) {
    const before = previous?.phases.find(p => p.id === phase.id), first = before?.firstVerifiedAtMs ?? before?.verifiedAtMs ?? phase.verifiedAtMs;
    if (first !== undefined) phase.firstVerifiedAtMs = first;
  }
  const operationComplete = input.operation.stage === 'frozen' && installation.state === 'passed' && acceptance.state === 'passed';
  const firstOperationCompleteAtMs = previous?.firstOperationCompleteAtMs ?? (operationComplete ? nowMs : undefined);
  const eta = assessTimeline(input.timeline, { nowMs, previous: previous?.timeline, previousAssessments: previous?.eta?.deadlineAssessments, phases, remainingEstimates: input.remainingEstimates, operationCompletedAtMs: firstOperationCompleteAtMs });
  const phaseChanged = !!previous && phases.some(p => previous.phases?.find(before => before.id === p.id)?.state !== p.state);
  eta.phaseChanged = phaseChanged; eta.checkpointDue ||= phaseChanged;
  const blockers = phases.filter(p => p.state !== 'passed').map(p => ({ phase: p.id, state: p.state, reason: p.reason }));
  if (input.operation.stage !== 'frozen') blockers.unshift({ phase: 'identity', state: 'unknown', reason: 'release-not-frozen' });
  for (const phase of phases) {
    const required = phase.id === 'public-ci' || phase.id === 'capacity' ? [] : PHASES.slice(0, PHASES.indexOf(phase.id));
    phase.blockedBy = required.filter(id => phases.find(p => p.id === id)?.state !== 'passed');
  }
  // A completed job has already crossed admission. Its exact result and fresh
  // saved-reply acceptance establish completion, not reusable admission proof.
  // Do not invent a link from the installer result to an old capacity receipt.
  if (operationComplete) { eta.remainingRangeMs = [0, 0]; eta.expectedFinishMs = [nowMs, nowMs]; eta.suspendNewAttemptsFor = []; }
  for (const phase of phases) {
    phase.requiredForRemainingOperation = !operationComplete;
    if (operationComplete && phase.state !== 'passed') phase.disposition = 'historical-evidence-gap-not-new-admission-authority';
  }
  const remainingBlockers = operationComplete ? [] : blockers;
  return { format: 1, kind: 'nova-release-plan', generatedAtMs: nowMs, operationIdentity, operation: input.operation,
    readOnly: true, installationAuthorized: false, effectsDispatched: false, fullRehearsalRequired: true,
    evidenceComplete: blockers.length === 0, operationComplete, firstOperationCompleteAtMs,
    readiness: operationComplete ? 'completed-operation-currently-verified' : blockers.length ? 'blocked' : 'evidence-complete-live-validation-required',
    phases, blockers, remainingBlockers, timeline: input.timeline, eta,
    evidenceScope: 'Local receipts and bytes checked; origin authenticity and current host state require maintained live verification.',
    nextPhase: remainingBlockers[0]?.phase ?? null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error('Usage: node scripts/release-plan.mjs INPUT_JSON');
    const path = resolve(process.argv[2]), info = lstatSync(path);
    need(info.isFile() && !info.isSymbolicLink() && info.size <= RELEASE_PLAN_LIMITS.inputBytes, 'unsafe-plan-input');
    const bytes = stableRead(path, RELEASE_PLAN_LIMITS.inputBytes);
    const report = planRelease(JSON.parse(bytes), { baseDirectory: dirname(path) });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.evidenceComplete || report.operationComplete ? 0 : 2;
  } catch {
    process.stdout.write(JSON.stringify({ format: 1, kind: 'nova-release-plan-error', readOnly: true, installationAuthorized: false, reason: 'invalid-input-or-resume-history' }) + '\n');
    process.exitCode = 1;
  }
}
