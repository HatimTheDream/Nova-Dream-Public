/** Receipt-backed local preparation. Producer filenames and raw hashes are
 * carried into the existing planner; no network, signing, journal or host
 * mutation is performed. A prepared packet never authorizes installation. */
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { planRelease, readEvidenceFile, readReleaseInputFile, RELEASE_PLAN_LIMITS,
  releaseOperationSchema, releasePlanInputSchema, releaseTimelineSchema, sha256 } from './release-plan.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096).refine(v => !v.includes('\0') && !/^[a-z]+:\/\//i.test(v));
const ref = z.object({ path, sha256: digest }).strict();
export const releasePreparationInputSchema = z.object({ format: z.literal(1),
  operation: releaseOperationSchema.refine(v => v.stage === 'frozen', 'Preparation requires frozen identities'),
  timeline: releaseTimelineSchema, remainingEstimates: releasePlanInputSchema.shape.remainingEstimates,
  ci: z.object({ private: ref, public: ref }).strict(),
  package: z.object({ review: ref, bundlePath: path }).strict(),
  dependencies: z.object({ metadata: ref, archivePath: path }).strict(),
  assets: z.object({ receipt: ref, directory: path }).strict().optional(), staging: ref.optional(),
}).strict();

const requireThat = (value, code) => { if (!value) throw Error(code); };
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(value)
  && value !== '.' && value !== '..' && basename(value) === value;
const count = value => Number.isSafeInteger(value) && value >= 0;
const isDigest = value => digest.safeParse(value).success;
const dependencyFields = ['format', 'archiveBytes', 'archiveSha256', 'expandedBytes', 'fileCount',
  'packageLockSha256', 'dependencyGraphSha256', 'platform', 'arch', 'nodeVersion', 'nodeAbi'];
const code = error => /^[a-z][a-z0-9-]{1,100}$/.test(error?.message ?? '') ? error.message
  : error?.code === 'ENOENT' ? 'producer-file-missing' : 'producer-evidence-unverifiable';

export function prepareRelease(raw, { baseDirectory = process.cwd(), nowMs = Date.now() } = {}) {
  const input = releasePreparationInputSchema.parse(raw), root = resolve(baseDirectory);
  const blockers = [], producers = {}, evidence = {};
  let readBytes = 0;
  const absolute = value => ({ ...value, path: resolve(root, value.path) });
  const read = (value, maximum = RELEASE_PLAN_LIMITS.receiptBytes) => {
    const bytes = readEvidenceFile(value, { baseDirectory: root, maximum });
    // Preparation may independently check the archive and its downloaded copy.
    readBytes += bytes.length;
    requireThat(readBytes <= 384 * 1024 ** 2, 'preparation-read-budget-exceeded');
    return bytes;
  };
  const json = value => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(value)));
  const attempt = (phase, action) => {
    try { return action(); } catch (error) { blockers.push({ phase, reason: code(error) }); return null; }
  };
  for (const [key, repository, workflow] of [['private', 'Nova-Dream', 'Nova Dream quality and release history'],
    ['public', 'Nova-Dream-Public', 'Application quality']]) {
    attempt(`${key}-ci`, () => {
      const receipt = absolute(input.ci[key]), value = json(receipt);
      requireThat(value.format === 1 && value.readOnly === true, 'ci-producer-format-unsupported');
      const repositories = value.repositories?.filter(r => r.repository === repository) ?? [];
      requireThat(repositories.length === 1, 'ci-producer-repository-ambiguous');
      const runs = repositories[0].runs?.filter(r => r.name === workflow) ?? [];
      requireThat(runs.length === 1, 'ci-producer-run-ambiguous');
      const jobs = runs[0].jobs?.filter(j => j.name === 'quality') ?? [];
      requireThat(jobs.length === 1, 'ci-producer-job-ambiguous');
      const job = jobs[0];
      requireThat(safeName(job.logFile) && isDigest(job.logSha256), 'ci-producer-log-binding-invalid');
      const log = { path: resolve(dirname(receipt.path), job.logFile), sha256: job.logSha256 };
      read(log, RELEASE_PLAN_LIMITS.logBytes);
      evidence[`${key}-ci`] = { receipt, log };
      producers[`${key}-ci`] = receipt;
    });
  }
  let packagePair;
  attempt('package', () => {
    const review = absolute(input.package.review), value = json(review);
    requireThat(isDigest(value.bundleSha256), 'package-producer-bundle-binding-invalid');
    const bundle = { path: resolve(root, input.package.bundlePath), sha256: value.bundleSha256 };
    const contents = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(bundle, RELEASE_PLAN_LIMITS.bundleBytes)));
    const pairs = contents.files?.filter(f => f.name === 'reviewed-pair.json') ?? [];
    requireThat(pairs.length === 1 && typeof pairs[0].data === 'string'
      && pairs[0].data.length <= 4 * RELEASE_PLAN_LIMITS.receiptBytes / 3 + 4,
      'package-producer-pair-invalid');
    const bytes = Buffer.from(pairs[0].data, 'base64');
    requireThat(bytes.toString('base64') === pairs[0].data && sha256(bytes) === pairs[0].sha256,
      'package-producer-pair-hash-changed');
    packagePair = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    evidence.package = { review, bundle }; producers.package = review;
  });
  let dependencies;
  attempt('dependencies', () => {
    const metadata = absolute(input.dependencies.metadata), value = json(metadata);
    requireThat(Object.keys(value).length === dependencyFields.length && dependencyFields.every(k => Object.hasOwn(value, k))
      && value.format === 1 && value.platform === 'linux' && ['x64', 'arm64'].includes(value.arch)
      && isDigest(value.archiveSha256) && isDigest(value.packageLockSha256) && isDigest(value.dependencyGraphSha256)
      && count(value.archiveBytes) && value.archiveBytes > 0 && value.archiveBytes <= 512 * 1024 ** 2
      && count(value.expandedBytes) && value.expandedBytes > 0 && value.expandedBytes <= 2 * 1024 ** 3
      && count(value.fileCount) && value.fileCount > 0 && value.fileCount <= 200000
      && count(value.nodeAbi) && value.nodeAbi >= 1 && value.nodeAbi <= 10000
      && /^[1-9][0-9]*\.\d+\.\d+$/.test(value.nodeVersion ?? ''), 'dependency-producer-format-unsupported');
    requireThat(packagePair && isDeepStrictEqual(packagePair.applicationDependencies, value),
      'dependency-reviewed-package-changed');
    const archive = { path: resolve(root, input.dependencies.archivePath), sha256: value.archiveSha256 };
    const bytes = read(archive, RELEASE_PLAN_LIMITS.bundleBytes);
    requireThat(bytes.length === value.archiveBytes, 'dependency-archive-size-changed');
    dependencies = { metadata, archive, archiveBytes: value.archiveBytes,
      packageLockSha256: value.packageLockSha256, dependencyGraphSha256: value.dependencyGraphSha256,
      expandedBytes: value.expandedBytes, nodeVersion: value.nodeVersion, nodeAbi: value.nodeAbi };
    producers.dependencies = metadata;
  });
  let assets;
  if (!input.assets) blockers.push({ phase: 'assets', reason: 'authenticated-assets-not-provided' });
  else attempt('assets', () => {
    const receipt = absolute(input.assets.receipt), value = json(receipt);
    requireThat(value.format === 1 && value.privateRepository === true && isDigest(value.proofSha256)
      && value.candidateId === input.operation.candidateId
      && value.sourceCommit === input.operation.sourceCommits.private, 'asset-producer-identity-changed');
    requireThat(Array.isArray(value.assets) && value.assets.length >= 2 && value.assets.length <= 8,
      'asset-producer-count-invalid');
    const names = new Set(), hashes = new Set(), files = [];
    for (const asset of value.assets) {
      requireThat(safeName(asset.name) && !names.has(asset.name) && isDigest(asset.sha256)
        && !hashes.has(asset.sha256) && count(asset.bytes) && asset.bytes > 0
        && asset.authenticatedDownloadVerified === true, 'asset-producer-file-invalid');
      names.add(asset.name); hashes.add(asset.sha256);
      const file = { path: resolve(root, input.assets.directory, asset.name), sha256: asset.sha256 };
      requireThat(read(file, RELEASE_PLAN_LIMITS.bundleBytes).length === asset.bytes, 'asset-download-size-changed');
      files.push({ name: asset.name, ...file, bytes: asset.bytes });
    }
    requireThat(dependencies && files.some(f => f.sha256 === dependencies.archive.sha256 && f.bytes === dependencies.archiveBytes)
      && files.some(f => f.sha256 === input.operation.bundleSha256), 'asset-required-package-missing');
    assets = { receipt, proofSha256: value.proofSha256, files }; producers.assets = receipt;
  });
  let staging;
  if (!input.staging) blockers.push({ phase: 'staging', reason: 'protected-staging-not-provided' });
  else attempt('staging', () => {
    const receipt = absolute(input.staging), value = json(receipt);
    requireThat(dependencies && assets, 'staging-package-evidence-missing');
    requireThat(value.format === 1 && value.verified === true && value.automaticRetry === false
      && value.applicationActivated === false && value.installDispatched === false
      && value.bundleSha256 === input.operation.bundleSha256 && value.stagingIdentity === input.operation.bundleSha256
      && value.dependenciesSha256 === dependencies.archive.sha256 && value.proofSha256 === assets.proofSha256,
      'staging-producer-identity-changed');
    // This validates the existing producer record, not the host's current files.
    requireThat(value.destination === `/var/lib/nova-update/staging/${input.operation.bundleSha256}`,
      'staging-producer-destination-invalid');
    const bundle = assets.files.find(f => f.sha256 === input.operation.bundleSha256);
    requireThat(value.files?.['bundle.json']?.sha256 === bundle.sha256 && value.files['bundle.json'].bytes === bundle.bytes
      && value.files?.['app-dependencies.tgz']?.sha256 === dependencies.archive.sha256
      && value.files['app-dependencies.tgz'].bytes === dependencies.archiveBytes
      && value.bundleBytes === bundle.bytes && value.dependenciesBytes === dependencies.archiveBytes,
      'staging-producer-file-binding-changed');
    staging = { receipt, destination: value.destination }; producers.staging = receipt;
  });
  const plannerInput = releasePlanInputSchema.parse({ format: 1, operation: input.operation,
    timeline: input.timeline, remainingEstimates: input.remainingEstimates, evidence });
  const plan = planRelease(plannerInput, { baseDirectory: root, nowMs });
  for (const phase of plan.phases.filter(p => ['private-ci', 'public-ci', 'package'].includes(p.id))) {
    if (phase.state !== 'passed' && !blockers.some(b => b.phase === phase.id))
      blockers.push({ phase: phase.id, reason: phase.reason });
  }
  return { format: 1, kind: 'nova-release-preparation', readOnly: true,
    installationAuthorized: false, effectsDispatched: false, automaticReplayPermitted: false,
    state: blockers.length ? 'blocked' : 'prepared', plannerInput, plan, dependencies, assets, staging, producers, blockers,
    evidenceScope: 'Local immutable preparation bytes only; producer authenticity, current protected staging, fresh capacity, full rehearsal and live acceptance remain required.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error('Usage: node scripts/release-prepare.mjs INPUT_JSON');
    const file = resolve(process.argv[2]);
    const report = prepareRelease(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readReleaseInputFile(file))),
      { baseDirectory: dirname(file) });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.state === 'prepared' ? 0 : 2;
  } catch {
    process.stdout.write(JSON.stringify({ format: 1, kind: 'nova-release-preparation-error', readOnly: true,
      installationAuthorized: false, effectsDispatched: false, automaticReplayPermitted: false,
      reason: 'invalid-preparation-input' }) + '\n');
    process.exitCode = 1;
  }
}
