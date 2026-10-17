import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Both independent repository layouts exercise the same real private-app
// contract. Only maintained operator sources and zod are copied; no app build,
// installation, configured host or user records enter this isolated fixture.
const sourceApp = fileURLToPath(new URL('..', import.meta.url));
const project = mkdtempSync(join(tmpdir(), 'nova-storage-default-project-'));
after(() => { assert.equal(dirname(project), resolve(tmpdir())); rmSync(project, { recursive: true, force: true }); });
const app = join(project, 'private', 'edition3');
mkdirSync(app, { recursive: true });
cpSync(join(sourceApp, 'scripts'), join(app, 'scripts'), { recursive: true });
cpSync(join(sourceApp, 'deploy', 'update-runner'), join(app, 'deploy', 'update-runner'), { recursive: true });
const zodRoot = process.env.NOVA_TEST_ZOD_ROOT ?? dirname(createRequire(import.meta.url).resolve('zod/package.json'));
assert.equal(JSON.parse(readFileSync(join(zodRoot, 'package.json'))).name, 'zod');
cpSync(zodRoot, join(app, 'node_modules', 'zod'), { recursive: true });
writeFileSync(join(app, 'package.json'), '{"type":"module"}\n');
const { sha256 } = await import(pathToFileURL(join(app, 'scripts', 'release-plan.mjs')));
const { deliveryAdapterIdentity, deliveryAdapterSourceFiles } = await import(pathToFileURL(join(app, 'scripts', 'release-delivery-adapters.mjs')));
const { routeStorageDelivery, verifyStorageSession, storageDefaultConfiguration } = await import(pathToFileURL(join(app, 'scripts', 'release-storage-default.mjs')));
const entry = join(app, 'scripts', 'release-deliver.mjs');
const coordinate = join(app, 'scripts', 'release-coordinate.mjs');
const ref = path => ({ path: resolve(path), sha256: sha256(readFileSync(path)) });
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const sourceFiles = () => deliveryAdapterSourceFiles().map(name => ref(join(app, 'scripts', name)));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nova-storage-default-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const put = (path, value) => { path = join(root, path); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n'); return ref(path); };
  const id = randomUUID(), now = Date.now(), operationsRoot = join(root, 'operations'), outputRoot = join(root, 'output');
  mkdirSync(operationsRoot); mkdirSync(outputRoot);
  const op = 'operations/release-' + id, publicRoot = join(root, 'public');
  const publicEntries = ['release-deliver.mjs', 'release-coordinate.mjs', 'release-storage-default.mjs', 'release-delivery-adapters.mjs']
    .map(name => put('public/scripts/' + name, Buffer.from('// inert public CLI fixture\n')));
  const runner = put('runner.py', Buffer.from('# inert runner; tests never execute it\n'));
  const identity = put('default_identity.mjs', Buffer.from('// inert identity fixture\n'));
  const storageHelper = put('storage-helper.py', Buffer.from('# reviewed inert storage source\n'));
  const sourceReview = put('source-review.json', { format: 1, kind: 'nova-storage-default-source-review', status: 'passed', independentReview: true,
    files: Object.fromEntries([runner, identity, ...publicEntries, ...['release-deliver.mjs', 'release-coordinate.mjs', 'release-storage-default.mjs', 'release-delivery-adapters.mjs']
      .map(name => ref(join(app, 'scripts', name)))].map(r => [r.path, r.sha256])) });
  const storageReview = put('storage-review.json', { format: 1, kind: 'independent-storage-source-review', status: 'passed', independentReview: true,
    files: { [storageHelper.path]: storageHelper.sha256 } });
  const config = { format: 1, kind: 'nova-storage-default', python: ref(process.execPath), runner, sourceReview, storageReview,
    operationsRoot, applicationRoots: [app, publicRoot] };
  const configRef = put('config.json', config), env = { NOVA_RELEASE_STORAGE_CONFIG: configRef.path };
  const target = put('target.json', { artifactTools: { node: ref(process.execPath) } });
  const profile = put('profile.json', { target, sources: { private: { root: dirname(app) }, public: { root: publicRoot } } });
  const start = { format: 1, operationId: id, profile, sourceCommits: { private: 'a'.repeat(40), public: 'b'.repeat(40) }, outputRoot,
    timeline: { startedAtMs: now - 1000, original: { issuedAtMs: now - 1000 } }, observationBudgetMs: 60000 };
  const startRef = put('input.json', start), budget = put('budget.json', { format: 1, reserveBytes: 100, allocations: [] });
  const adapterIdentity = deliveryAdapterIdentity(), descriptor = { format: 1, operation: { id, sourceCommits: start.sourceCommits },
    timeline: start.timeline, observationBudgetMs: start.observationBudgetMs, adapterIdentity, target };
  const descriptorRef = put('output/request-' + id + '/descriptor.json', descriptor);
  const journalDirectory = join(outputRoot, 'journal-' + id);
  const initialization = { format: 1, kind: 'nova-delivery-initialization', input: start, inputSha256: sha256(canonical(start) + '\n'), profile,
    adapterIdentity, directory: join(outputRoot, 'request-' + id), journalDirectory,
    descriptor: { reference: descriptorRef, value: descriptor }, target: { reference: target, value: JSON.parse(readFileSync(target.path)) } };
  const initializationRef = put('output/request-' + id + '/initialization.json', initialization);
  const request = { format: 1, releaseInput: startRef, storageBudget: budget, independentSourceReview: storageReview, deliveryEntry: ref(entry),
    node: ref(process.execPath), operationId: id };
  const requestRef = put(op + '/request.json', request), configuration = put('storage-configuration.json', { fixture: true });
  const storageInputValue = { profile, budget, configuration, phase: 'before-allocation', originalDeadline: new Date(now + 600000).toISOString() };
  const storageInput = put(op + '/before-delivery/input.json', storageInputValue);
  const inventoryValue = { sourceEvidence: { profile, configuration }, readOnly: true, observedAtMilliseconds: now };
  const inventory = put(op + '/before-delivery/inventory.json', inventoryValue);
  const proof = { format: 1, kind: 'private-storage-preflight', state: 'ready', phase: 'before-allocation',
    originalDeadline: storageInputValue.originalDeadline, inventory, assessment: { format: 1, kind: 'storage-lifecycle-budget-result', phase: 'before-allocation',
      fits: true, observationExpiresAtMilliseconds: now + 120000, allocationBudgetAdmissionOnly: true, releaseAdmission: false,
      stoppedAndPostStartChecksStillRequired: true, filesystems: [{ availableBytes: 1000, requiredFreeBytes: 100, deficitBytes: 0, allocations: [] }] } };
  const proofRef = put(op + '/before-delivery/preflight.json', proof);
  const dispatch = { format: 1, request: requestRef, storageInput, storageResult: { state: 'ready', historical: false, cleanupPerformed: false,
    result: proofRef, observationExpiresAtMilliseconds: now + 120000 }, startedAtMilliseconds: now, automaticNewOperationPermitted: false };
  const dispatchRef = put(op + '/release-dispatch.json', dispatch), args = ['start', journalDirectory, descriptorRef.path];
  const intent = { request: requestRef, argv: [process.execPath, entry, ...args], sameReleaseOperation: true };
  const intentRef = put(op + '/observations/observation-0001/intent.json', intent);
  const graph = { format: 1, adapterIdentity, sourceFiles: sourceFiles() }, graphRef = put(op + '/source-graph-observation-0001.json', graph);
  const session = { format: 1, kind: 'nova-storage-default-session', config: configRef, request: requestRef, dispatch: dispatchRef,
    initialization: initializationRef, observationIntent: intentRef, descriptor: descriptorRef, adapterIdentity, argv: intent.argv,
    operationId: id, mode: 'start', sourceReview, storageReview, sourceGraph: graphRef, issuedAtMilliseconds: now };
  const saveSession = () => { const r = put(op + '/session-observation-0001.json', session); env.NOVA_RELEASE_STORAGE_SESSION = r.path; return r; };
  saveSession();
  return { root, op, put, id, now, env, config, configRef, args, session, saveSession, start, request, dispatch, initialization, intent, graph, journalDirectory,
    proof, inventoryValue };
}
function child(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 20000,
    env: { ...process.env, NOVA_RELEASE_STORAGE_SESSION: '', ...env } });
}
test('raw delivery CLI refuses before creating a journal, without reading descriptor', t => {
  const f = fixture(t), environment = { ...process.env, NOVA_RELEASE_STORAGE_CONFIG: f.configRef.path };
  delete environment.NOVA_RELEASE_STORAGE_SESSION;
  const run = spawnSync(process.execPath, [entry, 'start', f.journalDirectory, join(f.root, 'missing-descriptor.json')],
    { env: environment, encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(run.status, 1); assert.equal(JSON.parse(run.stdout).reason, 'storage-required-use-release-deliver-start-input');
  assert.equal(existsSync(f.journalDirectory), false);
});
test('legacy coordinator CLI cannot dispatch without a verified storage session', t => {
  const f = fixture(t), run = child(coordinate, ['resume', f.journalDirectory, f.id], {});
  assert.equal(run.status, 1); assert.equal(JSON.parse(run.stdout).reason, 'storage-delivery-resume-required');
  assert.match(JSON.parse(run.stdout).hint, /release:deliver -- resume/);
  assert.equal(existsSync(f.journalDirectory), false);
});
test('boolean session environment is not a bypass', t => {
  const f = fixture(t), run = child(entry, f.args, { ...f.env, NOVA_RELEASE_STORAGE_SESSION: 'true' });
  assert.equal(run.status, 1); assert.equal(JSON.parse(run.stdout).reason, 'storage-absolute-path-required');
  assert.equal(existsSync(f.journalDirectory), false);
});
test('fresh exact session validates without opening a journal', async t => {
  const f = fixture(t), result = await verifyStorageSession(f.args, entry, { env: f.env, now: f.now });
  assert.equal(result.operationId, f.id); assert.equal(existsSync(f.journalDirectory), false);
});
test('capacity and session expiry are rechecked after graph verification', async t => {
  for (const elapsed of [120001, 300001]) {
    const f = fixture(t); let reads = 0;
    await assert.rejects(verifyStorageSession(f.args, entry, { env: f.env, clock: () => f.now + (reads++ === 0 ? 0 : elapsed) }),
      elapsed === 120001 ? /fresh-storage-required-before-start/ : /storage-session-expired/);
    assert.equal(reads, 2); assert.equal(existsSync(f.journalDirectory), false);
  }
});
test('stale first admission refuses; original resume retains dispatch and deadlines', async t => {
  const f = fixture(t); f.dispatch.storageResult.observationExpiresAtMilliseconds = f.now - 1;
  f.dispatch.startedAtMilliseconds = f.now - 1000;
  f.inventoryValue.observedAtMilliseconds = f.now - 120001;
  f.proof.inventory = f.put(f.op + '/before-delivery/inventory.json', f.inventoryValue);
  f.proof.assessment.observationExpiresAtMilliseconds = f.now - 1;
  f.dispatch.storageResult.result = f.put(f.op + '/before-delivery/preflight.json', f.proof);
  f.session.dispatch = f.put(f.op + '/release-dispatch.json', f.dispatch); f.saveSession();
  await assert.rejects(verifyStorageSession(f.args, entry, { env: f.env, now: f.now }), /fresh-storage-required-before-start/);
  mkdirSync(f.journalDirectory); f.args = ['resume', f.journalDirectory, f.id];
  f.session.mode = 'resume'; f.session.argv = [process.execPath, entry, ...f.args]; f.intent.argv = f.session.argv;
  f.session.observationIntent = f.put(f.op + '/observations/observation-0001/intent.json', f.intent); f.saveSession();
  assert.equal((await verifyStorageSession(f.args, entry, { env: f.env, now: f.now })).operationId, f.id);
  assert.equal(JSON.parse(readFileSync(f.session.initialization.path)).input.timeline.startedAtMs, f.start.timeline.startedAtMs);
});
test('original resume without a journal stops rather than recreating the operation', async t => {
  const f = fixture(t); f.args = ['resume', f.journalDirectory, f.id]; f.session.mode = 'resume';
  f.intent.argv = f.session.argv = [process.execPath, entry, ...f.args];
  f.session.observationIntent = f.put(f.op + '/observations/observation-0001/intent.json', f.intent); f.saveSession();
  await assert.rejects(verifyStorageSession(f.args, entry, { env: f.env }), /storage-original-journal-unavailable/);
  assert.equal(existsSync(f.journalDirectory), false);
});
test('swapped operation, argv, dispatch, source graph and descriptor are rejected', async t => {
  for (const change of ['operation', 'argv', 'dispatch', 'graph', 'descriptor']) {
    const f = fixture(t);
    if (change === 'operation') f.session.operationId = randomUUID();
    if (change === 'argv') f.session.argv = [...f.session.argv.slice(0, -1), 'replacement'];
    if (change === 'dispatch') { f.dispatch.request = f.put('other-request.json', f.request); f.session.dispatch = f.put(f.op + '/release-dispatch.json', f.dispatch); }
    if (change === 'graph') { f.graph.sourceFiles[0].sha256 = 'f'.repeat(64); f.session.sourceGraph = f.put(f.op + '/source-graph-observation-0001.json', f.graph); }
    if (change === 'descriptor') { const value = JSON.parse(readFileSync(f.session.descriptor.path)); value.operation.id = randomUUID(); f.session.descriptor = f.put('other-descriptor.json', value); }
    f.saveSession(); await assert.rejects(verifyStorageSession(f.args, entry, { env: f.env }), /storage-/);
    assert.equal(existsSync(f.journalDirectory), false);
  }
});
test('changed source review bytes and changed runner bytes cannot launch', async t => {
  const f = fixture(t); delete f.env.NOVA_RELEASE_STORAGE_SESSION;
  writeFileSync(f.config.runner.path, '# changed\n');
  await assert.rejects(routeStorageDelivery(['start', join(f.root, 'input.json')], entry, { env: f.env, launch: () => assert.fail('must not launch') }), /evidence-hash-changed/);
});
test('embedded ready cannot replace the actual capacity proof', async t => {
  const f = fixture(t); f.proof.assessment.fits = false;
  f.dispatch.storageResult.result = f.put(f.op + '/before-delivery/preflight.json', f.proof);
  f.session.dispatch = f.put(f.op + '/release-dispatch.json', f.dispatch); f.saveSession();
  await assert.rejects(verifyStorageSession(f.args, entry, { env: f.env }), /storage-capacity-proof-changed/);
  assert.equal(existsSync(f.journalDirectory), false);
});
test('cleanup admission requires closed worker and final measured capacity', async t => {
  const f = fixture(t), cleanup = f.put('cleanup.json', { cleanupComplete: true, protectedRolesVerified: true, originalWorkerClosed: true });
  const result = { format: 1, kind: 'private-storage-maintenance-result', state: 'ready', historical: false,
    cleanupPerformed: true, protectedRolesVerified: true, cleanup, finalPreflight: f.dispatch.storageResult.result,
    observationExpiresAtMilliseconds: f.dispatch.storageResult.observationExpiresAtMilliseconds };
  f.dispatch.storageResult = { ...result, result: f.put('maintenance.json', result) };
  f.session.dispatch = f.put(f.op + '/release-dispatch.json', f.dispatch); f.saveSession();
  assert.equal((await verifyStorageSession(f.args, entry, { env: f.env })).operationId, f.id);
  const bad = { ...result, cleanup: f.put('unclosed-cleanup.json', { cleanupComplete: true, protectedRolesVerified: true, originalWorkerClosed: false }) };
  f.dispatch.storageResult = { ...bad, result: f.put('maintenance-unclosed.json', bad) };
  f.session.dispatch = f.put(f.op + '/release-dispatch.json', f.dispatch); f.saveSession();
  await assert.rejects(verifyStorageSession(f.args, entry, { env: f.env }), /storage-cleanup-worker-not-closed/);
});
test('start and resume route fixed argv and propagate pending/completed state', async t => {
  const f = fixture(t); delete f.env.NOVA_RELEASE_STORAGE_SESSION;
  const calls = [], launch = async (executable, argv) => { calls.push({ executable, argv }); return { code: 2, value: { state: 'release-pending', release: { complete: false } } }; };
  const start = await routeStorageDelivery(['start', join(f.root, 'input.json'), '--storage-budget', join(f.root, 'budget.json')], entry, { env: f.env, launch });
  assert.equal(start.result.complete, false); assert.deepEqual(calls[0], { executable: process.execPath, argv: ['-I', '-B', f.config.runner.path,
    '--config', f.configRef.path, '--entry', entry, '--mode', 'start', '--launcher-pid', String(process.pid), '--launcher-cwd', process.cwd(),
    '--input', join(f.root, 'input.json'), '--budget', join(f.root, 'budget.json')] });
  const complete = await routeStorageDelivery(['resume', f.journalDirectory, f.id], entry, { env: f.env,
    launch: async (executable, argv) => { calls.push({ executable, argv }); return { code: 0, value: { state: 'complete', release: { complete: true }, storageCloseoutPerformed: true } }; } });
  assert.equal(complete.result.complete, true); assert.deepEqual(calls[1].argv.slice(-4), ['--journal', f.journalDirectory, '--operation', f.id]);
});
test('success exit cannot conceal pending storage or delivery acceptance', async t => {
  const f = fixture(t); delete f.env.NOVA_RELEASE_STORAGE_SESSION;
  await assert.rejects(routeStorageDelivery(['start', join(f.root, 'input.json')], entry, { env: f.env,
    launch: async () => ({ code: 0, value: { state: 'complete', release: { complete: true }, storageCloseoutPerformed: false } }) }), /storage-runner-incomplete-success-rejected/);
});
test('read-only/checkpoint/reconcile modes do not load storage config; module is in source identity', async () => {
  for (const mode of ['status', 'checkpoint', 'reconcile-failure']) assert.deepEqual(await routeStorageDelivery([mode], entry,
    { env: { NOVA_RELEASE_STORAGE_CONFIG: 'invalid' } }), { handled: false });
  assert.ok(deliveryAdapterSourceFiles().includes('release-storage-default.mjs'));
  assert.throws(() => storageDefaultConfiguration({ env: { NOVA_RELEASE_STORAGE_CONFIG: 'relative.json' } }), /storage-absolute-path-required/);
});
