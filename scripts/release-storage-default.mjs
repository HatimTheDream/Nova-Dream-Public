/** Default private storage route. This guards CLI dispatch, not library imports.
 * The reviewed private runner owns storage work and the original release request;
 * this module only verifies its exact local session before opening a journal. */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { readEvidenceFile, readReleaseInputFile, sha256 } from './release-plan.mjs';

const need = (value, code) => { if (!value) throw Error(code); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const MAX_JSON = 2 * 1024 ** 2;
const encoded = value => Buffer.from(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) + '\n');
function absolute(path) {
  need(typeof path === 'string' && path.length <= 4096 && isAbsolute(path) && !path.includes('\0'), 'storage-absolute-path-required');
  return resolve(path);
}
function canonical(path) {
  const resolved = absolute(path);
  need(resolve(realpathSync(resolved)) === resolved, 'storage-canonical-path-required');
  return resolved;
}
function reference(value) {
  need(value && typeof value === 'object' && Object.keys(value).length === 2 && hash(value.sha256), 'storage-reference-required');
  absolute(value.path); return value;
}
function document(ref, maximum = MAX_JSON) {
  reference(ref); return JSON.parse(readEvidenceFile(ref, { maximum }));
}
function inputReference(path) {
  const resolved = canonical(path), bytes = readReleaseInputFile(resolved);
  return { path: resolved, sha256: sha256(bytes) };
}
function contained(root, path) {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith('..\\') && !child.startsWith('../') && !isAbsolute(child);
}
function reviewed(ref, kind) {
  const review = document(ref);
  need(review.format === 1 && review.kind === kind && review.status === 'passed' && review.independentReview === true,
    'storage-independent-source-review-required');
  need(review.files && !Array.isArray(review.files) && typeof review.files === 'object' && Object.keys(review.files).length >= 1
    && Object.keys(review.files).length <= 512, 'storage-reviewed-files-required');
  for (const [path, digest] of Object.entries(review.files)) {
    reference({ path, sha256: digest }); readEvidenceFile({ path, sha256: digest }, { maximum: 128 * 1024 ** 2 });
  }
  return review;
}
function reviewedFile(review, ref) {
  reference(ref);
  need(Object.entries(review.files).some(([path, digest]) => absolute(path) === absolute(ref.path) && digest === ref.sha256),
    'storage-runner-source-not-reviewed');
}
export function storageDefaultConfiguration({ env = process.env } = {}) {
  const path = env.NOVA_RELEASE_STORAGE_CONFIG ?? join(homedir(), '.codex', 'nova-release', 'storage-default.json');
  absolute(path); need(existsSync(path), 'storage-default-configuration-required');
  const ref = inputReference(path), config = document(ref);
  need(config.format === 1 && config.kind === 'nova-storage-default', 'storage-default-configuration-required');
  for (const role of ['python', 'runner', 'sourceReview', 'storageReview']) reference(config[role]);
  readEvidenceFile(config.python, { maximum: 128 * 1024 ** 2 });
  const sourceReview = reviewed(config.sourceReview, 'nova-storage-default-source-review');
  reviewedFile(sourceReview, config.runner);
  reviewedFile(sourceReview, inputReference(join(dirname(config.runner.path), 'default_identity.mjs')));
  reviewed(config.storageReview, 'independent-storage-source-review');
  canonical(config.operationsRoot);
  need(Array.isArray(config.applicationRoots) && config.applicationRoots.length === 2
    && new Set(config.applicationRoots.map(canonical)).size === 2, 'storage-application-roots-required');
  for (const root of config.applicationRoots) {
    need(!contained(canonical(root), canonical(config.operationsRoot)) && canonical(root) !== canonical(config.operationsRoot)
      && !contained(canonical(config.operationsRoot), canonical(root)), 'storage-operations-overlap-source');
    for (const name of ['release-deliver.mjs', 'release-coordinate.mjs', 'release-storage-default.mjs', 'release-delivery-adapters.mjs'])
      reviewedFile(sourceReview, inputReference(join(root, 'scripts', name)));
  }
  return { ref, config, sourceReview };
}

function verifyCapacityProof(checked, storageInput, budget) {
  let proof = document(checked.result);
  if (checked.cleanupPerformed === true) {
    const { result: _reference, ...retained } = checked;
    need(same(proof, retained) && proof.kind === 'private-storage-maintenance-result'
      && proof.protectedRolesVerified === true && proof.cleanupPerformed === true, 'storage-cleanup-result-changed');
    const cleanup = document(proof.cleanup);
    need(cleanup.cleanupComplete === true && cleanup.protectedRolesVerified === true && cleanup.originalWorkerClosed === true,
      'storage-cleanup-worker-not-closed');
    proof = document(proof.finalPreflight);
  } else need(checked.cleanupPerformed === false, 'storage-cleanup-disposition-required');
  const assessment = proof.assessment;
  need(proof.format === 1 && proof.kind === 'private-storage-preflight' && proof.state === 'ready'
    && proof.phase === storageInput.phase && storageInput.phase === 'before-allocation'
    && proof.originalDeadline === storageInput.originalDeadline && assessment?.format === 1
    && assessment.kind === 'storage-lifecycle-budget-result' && assessment.phase === storageInput.phase
    && assessment.fits === true && assessment.allocationBudgetAdmissionOnly === true
    && assessment.releaseAdmission === false && assessment.stoppedAndPostStartChecksStillRequired === true
    && assessment.observationExpiresAtMilliseconds === checked.observationExpiresAtMilliseconds,
  'storage-capacity-proof-changed');
  const inventory = document(proof.inventory), rows = assessment.filesystems;
  need(same(inventory.sourceEvidence?.profile, storageInput.profile) && same(inventory.sourceEvidence?.configuration, storageInput.configuration)
    && inventory.readOnly === true && inventory.observedAtMilliseconds + 120000 === assessment.observationExpiresAtMilliseconds,
  'storage-capacity-inventory-context-changed');
  need(Array.isArray(rows) && rows.length > 0 && rows.length <= 64 && rows.every(row => Number.isSafeInteger(row.availableBytes)
    && Number.isSafeInteger(row.requiredFreeBytes) && row.requiredFreeBytes >= 0 && row.availableBytes >= row.requiredFreeBytes
    && row.deficitBytes === 0 && Array.isArray(row.allocations)), 'storage-capacity-shortfall');
  const order = values => [...values].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  need(Array.isArray(budget.allocations) && same(order(rows.flatMap(row => row.allocations)), order(budget.allocations)),
    'storage-capacity-allocation-budget-changed');
}

/** Stable evidence is required even on resume; only the old capacity admission's
 * age may be retained. The maintained producers refresh their effect-time checks. */
export async function verifyStorageSession(args, entry, { env = process.env, clock = Date.now, now = clock(), executable = process.execPath } = {}) {
  need(typeof env.NOVA_RELEASE_STORAGE_SESSION === 'string' && env.NOVA_RELEASE_STORAGE_SESSION.length > 0,
    'storage-session-required-use-release-deliver');
  const loaded = storageDefaultConfiguration({ env }), { config } = loaded;
  const sessionRef = inputReference(env.NOVA_RELEASE_STORAGE_SESSION), session = document(sessionRef);
  need(session.format === 1 && session.kind === 'nova-storage-default-session' && uuid(session.operationId)
    && ['start', 'resume'].includes(session.mode) && session.mode === args[0], 'storage-session-shape-invalid');
  need(same(session.config, loaded.ref) && same(session.sourceReview, config.sourceReview) && same(session.storageReview, config.storageReview),
    'storage-session-configuration-changed');
  need(Number.isSafeInteger(session.issuedAtMilliseconds) && session.issuedAtMilliseconds <= now + 5000
    && now - session.issuedAtMilliseconds <= 300000, 'storage-session-expired');
  const root = join(canonical(config.operationsRoot), 'release-' + session.operationId);
  const match = /^session-(observation-\d{4,})\.json$/.exec(relative(root, sessionRef.path));
  need(match, 'storage-session-location-invalid');
  for (const [role, path] of Object.entries({ request: join(root, 'request.json'), dispatch: join(root, 'release-dispatch.json'),
    observationIntent: join(root, 'observations', match[1], 'intent.json'), sourceGraph: join(root, 'source-graph-' + match[1] + '.json') })) {
    reference(session[role]); need(absolute(session[role].path) === path, 'storage-session-reference-location-changed');
  }
  const request = document(session.request), dispatch = document(session.dispatch), intent = document(session.observationIntent);
  const initialization = document(session.initialization), descriptor = document(session.descriptor), graph = document(session.sourceGraph);
  const start = document(request.releaseInput), profile = document(start.profile), target = document(profile.target);
  need(request.format === 1 && request.operationId === session.operationId && start.operationId === session.operationId
    && same(request.independentSourceReview, config.storageReview), 'storage-original-request-changed');
  need(dispatch.format === 1 && same(dispatch.request, session.request) && dispatch.automaticNewOperationPermitted === false
    && same(intent.request, session.request) && intent.sameReleaseOperation === true, 'storage-original-dispatch-changed');
  const storageInput = document(dispatch.storageInput), budget = document(request.storageBudget);
  need(same(storageInput.profile, start.profile) && same(storageInput.budget, request.storageBudget), 'storage-budget-context-changed');
  need(dispatch.storageResult?.state === 'ready' && dispatch.storageResult.historical !== true
    && Number.isSafeInteger(dispatch.startedAtMilliseconds) && Number.isSafeInteger(dispatch.storageResult.observationExpiresAtMilliseconds)
    && dispatch.startedAtMilliseconds <= dispatch.storageResult.observationExpiresAtMilliseconds,
  'storage-original-admission-required');
  verifyCapacityProof(dispatch.storageResult, storageInput, budget);
  if (session.mode === 'start') need(now <= dispatch.storageResult.observationExpiresAtMilliseconds
    && dispatch.startedAtMilliseconds <= now + 5000, 'fresh-storage-required-before-start');
  const initDirectory = join(absolute(start.outputRoot), 'request-' + session.operationId);
  need(absolute(session.initialization.path) === join(initDirectory, 'initialization.json')
    && initialization.format === 1 && initialization.kind === 'nova-delivery-initialization'
    && same(initialization.input, start) && same(initialization.profile, start.profile)
    && initialization.inputSha256 === sha256(encoded(start)) && absolute(initialization.directory) === initDirectory
    && absolute(initialization.journalDirectory) === join(absolute(start.outputRoot), 'journal-' + session.operationId)
    && same(initialization.descriptor.reference, session.descriptor) && same(initialization.descriptor.value, descriptor)
    && absolute(session.descriptor.path) === join(initDirectory, 'descriptor.json'), 'storage-original-initialization-changed');
  need(descriptor.operation?.id === session.operationId && same(descriptor.operation.sourceCommits, start.sourceCommits)
    && same(descriptor.timeline, start.timeline) && descriptor.observationBudgetMs === start.observationBudgetMs
    && same(descriptor.target, initialization.target.reference) && same(document(descriptor.target), initialization.target.value),
  'storage-original-descriptor-changed');
  const privateRoot = canonical(join(profile.sources.private.root, 'edition3'));
  const publicRoot = canonical(profile.sources.public.root), actualEntry = canonical(entry);
  need(same(config.applicationRoots.map(canonical), [privateRoot, publicRoot])
    && actualEntry === join(privateRoot, 'scripts', 'release-deliver.mjs')
    && absolute(request.deliveryEntry.path) === actualEntry, 'storage-current-delivery-entry-changed');
  readEvidenceFile(request.deliveryEntry); readEvidenceFile(request.node, { maximum: 128 * 1024 ** 2 });
  need(same(request.node, target.artifactTools.node) && canonical(request.node.path) === canonical(executable), 'storage-node-identity-changed');
  const expectedArgs = session.mode === 'start'
    ? ['start', initialization.journalDirectory, session.descriptor.path]
    : ['resume', initialization.journalDirectory, session.operationId];
  need(same(args, expectedArgs) && same(session.argv, intent.argv) && same(session.argv, [request.node.path, request.deliveryEntry.path, ...args]),
    'storage-session-argv-changed');
  const { deliveryAdapterIdentity, deliveryAdapterSourceFiles } = await import('./release-delivery-adapters.mjs');
  const adapterIdentity = deliveryAdapterIdentity();
  need(hash(session.adapterIdentity) && session.adapterIdentity === adapterIdentity && descriptor.adapterIdentity === adapterIdentity
    && initialization.adapterIdentity === adapterIdentity && graph.format === 1 && graph.adapterIdentity === adapterIdentity,
  'storage-adapter-identity-changed');
  const expectedGraph = deliveryAdapterSourceFiles().map(name => inputReference(fileURLToPath(new URL(name, import.meta.url))));
  need(Array.isArray(graph.sourceFiles) && graph.sourceFiles.length === expectedGraph.length
    && graph.sourceFiles.every((ref, index) => absolute(reference(ref).path) === expectedGraph[index].path && ref.sha256 === expectedGraph[index].sha256),
  'storage-source-graph-changed');
  // A retained first-start capability cannot open a new journal or replay effects.
  if (session.mode === 'start') need(!existsSync(initialization.journalDirectory), 'storage-start-already-dispatched-use-resume');
  else need(existsSync(initialization.journalDirectory), 'storage-original-journal-unavailable');
  // Source verification takes real time. Recheck immediately before returning
  // the permit to the CLI's journal-open boundary, never using its entry clock.
  const finishedAt = clock();
  need(Number.isSafeInteger(finishedAt) && session.issuedAtMilliseconds <= finishedAt + 5000
    && finishedAt - session.issuedAtMilliseconds <= 300000, 'storage-session-expired');
  if (session.mode === 'start') need(finishedAt <= dispatch.storageResult.observationExpiresAtMilliseconds
    && dispatch.startedAtMilliseconds <= finishedAt + 5000, 'fresh-storage-required-before-start');
  return { operationId: session.operationId, journalDirectory: initialization.journalDirectory, descriptor: session.descriptor };
}

function runRunner(executable, args) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let length = 0, oversized = false;
    child.stdout.on('data', bytes => { length += bytes.length; if (length <= MAX_JSON) chunks.push(bytes); else oversized = true; });
    child.stderr.on('data', bytes => process.stderr.write(bytes));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (oversized) return reject(Error('storage-runner-response-too-large-observe-original-operation'));
      if (signal || ![0, 2].includes(code)) return reject(Error('storage-runner-stopped-observe-original-operation'));
      try { accept({ code, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { reject(Error('storage-runner-response-unavailable-observe-original-operation')); }
    });
  });
}

export async function routeStorageDelivery(args, entry, { env = process.env, launch = runRunner } = {}) {
  if (!['start', 'resume'].includes(args[0])) return { handled: false };
  if (env.NOVA_RELEASE_STORAGE_SESSION !== undefined) {
    await verifyStorageSession(args, entry, { env }); return { handled: false };
  }
  const mode = args[0];
  need(mode === 'start' ? (args.length === 2 || (args.length === 4 && args[2] === '--storage-budget')) : args.length === 3,
    'storage-required-use-release-deliver-start-input');
  const { ref, config } = storageDefaultConfiguration({ env }), actualEntry = canonical(entry);
  need(config.applicationRoots.some(root => join(canonical(root), 'scripts', 'release-deliver.mjs') === actualEntry), 'storage-entry-not-configured');
  const argv = ['-I', '-B', config.runner.path, '--config', ref.path, '--entry', actualEntry, '--mode', mode];
  if (mode === 'start') {
    argv.push('--input', absolute(resolve(args[1])));
    if (args.length === 4) argv.push('--budget', absolute(resolve(args[3])));
  } else {
    need(uuid(args[2]), 'storage-original-operation-required'); argv.push('--journal', absolute(resolve(args[1])), '--operation', args[2]);
  }
  const { code, value } = await launch(config.python.path, argv);
  need(value && typeof value === 'object' && ['complete', 'release-pending', 'acceptance-or-storage-gap', 'original-start-not-observed', 'stopped'].includes(value.state),
    'storage-runner-result-invalid');
  const complete = value.state === 'complete' && value.release?.complete === true && value.storageCloseoutPerformed === true;
  need(code !== 0 || complete, 'storage-runner-incomplete-success-rejected');
  return { handled: true, result: { ...value, complete } };
}
