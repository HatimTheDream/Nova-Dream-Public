import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReleaseJournal } from '../scripts/release-coordinate.mjs';
import { ensureDeliverySchema, DELIVERY_PHASES } from '../scripts/release-delivery-journal.mjs';
import { sha256 } from '../scripts/release-plan.mjs';
import { stepDelivery, deliver } from '../scripts/release-deliver.mjs';
import { chooseDeliveryRoute, createSourceAdapter, fixedCommand } from '../scripts/release-delivery-adapters.mjs';
import { createCiAdapter } from '../scripts/release-delivery-ci-adapter.mjs';
import { createCoordinatorInstallationAdapter } from '../scripts/release-delivery-install.mjs';

const digest = text => sha256(String(text));
const root = fileURLToPath(new URL('../support/fixtures', import.meta.url)); if (!existsSync(root)) mkdirSync(root);
const targetPath = join(root, 'synthetic-target.json'); writeFileSync(targetPath, '{"fixture":true}\n');
const target = { path: targetPath, sha256: sha256(readFileSync(targetPath)) };
const baseline = readFileSync(new URL('../scripts/release-coordinate.mjs', import.meta.url), 'utf8');
const baseSchema = baseline.match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}', String(0x4e56524c));
function fixture(t, overrides = {}) {
  const journal = Object.create(ReleaseJournal.prototype); journal.db = new DatabaseSync(':memory:'); journal.readOnly = false; journal.directory = root;
  journal.db.exec(baseSchema); t.after(() => journal.close());
  const now = 1791406800000, id = randomUUID();
  const operation = { id, stage: 'draft', candidateId: null, publicCandidateId: null, priorCandidateId: digest('prior'), workspaceEpoch: randomUUID(), version: '2.3.1', buildVersion: '1.0.288',
    agentVersion: '2026.9.8', priorAgentVersion: '2026.9.8', sourceCommits: { private: 'a'.repeat(40), public: 'b'.repeat(40) }, bundleSha256: null, trustedPublicKeySha256: digest('public-key'), changeClass: 'application', helperHashes: null };
  const original = { id: randomUUID(), step: 'total', issuedAtMs: now, remainingMs: [10000, 20000], confidence: 'low', basis: 'Synthetic bound.', reason: 'Original estimate.', nextCheckpointAtMs: now + 300000 };
  const descriptor = { format: 1, operation, sources: { private: { root: '/private', repository: 'Example/Private', commit: operation.sourceCommits.private, baseCommit: 'c'.repeat(40), branch: 'main' },
    public: { root: '/public', repository: 'Example/Public', commit: operation.sourceCommits.public, baseCommit: 'd'.repeat(40), branch: 'main' } }, target,
    targetIdentity: digest('target'), adapterIdentity: digest('registry'), timeline: { startedAtMs: now, original, revisions: [], reviews: [], lastCheckpointAtMs: now }, ...overrides };
  journal.initializeDelivery(descriptor, now); return { journal, descriptor, id, now };
}
function syntheticRegistry(f, behaviors = {}) {
  const counts = {}, keys = {};
  const registry = { identity: async () => f.descriptor.adapterIdentity, targetIdentity: async () => f.descriptor.targetIdentity,
    adapter(phase) {
      if (behaviors[phase] === null) return null;
      const input = async () => ({ phase, source: f.descriptor.operation.sourceCommits });
      const run = mode => async context => {
        counts[`${phase}:${mode}`] = (counts[`${phase}:${mode}`] ?? 0) + 1; (keys[phase] ??= []).push(context.intent.key);
        if (behaviors[phase]?.[mode]) return behaviors[phase][mode](context);
        return { state: 'completed', externalId: `${phase}-original`, reason: 'fixture-completed', receipt: null, output: { phase } };
      };
      return { input, validate: async () => {}, execute: run('execute'), observe: run('observe'), verify: async () => {} };
    } };
  return { registry, counts, keys };
}
const observation = (intent, state, externalId = null) => ({ key: intent.key, state, externalId, reason: `fixture-${state}`, receipt: null, output: state === 'completed' ? { done: true } : null });

test('additive schema preserves version-one coordinator records and refuses changed descriptors', t => {
  const f = fixture(t); const oldCount = f.journal.db.prepare('SELECT count(*) AS n FROM operations').get().n;
  assert.equal(f.journal.db.prepare('PRAGMA user_version').get().user_version, 1); ensureDeliverySchema(f.journal);
  assert.equal(f.journal.db.prepare('SELECT count(*) AS n FROM operations').get().n, oldCount);
  assert.equal(f.journal.initializeDelivery(f.descriptor, f.now).operationId, f.id);
  assert.throws(() => f.journal.initializeDelivery({ ...f.descriptor, adapterIdentity: digest('changed') }, f.now), /existing-delivery-input-changed/);
  assert.equal(f.journal.deliveryStatus(f.id, f.now + 123).elapsedMs, 123);
});
test('crash after reservation resumes original key by observation with no dispatch', async t => {
  const f = fixture(t), g = syntheticRegistry(f), phase = 'private-source';
  const reserved = f.journal.reserveDeliveryPhase(f.id, phase, { phase, source: f.descriptor.operation.sourceCommits }, f.now);
  const result = await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now + 1 });
  assert.equal(result.complete, true); assert.equal(g.counts[`${phase}:execute`], undefined); assert.equal(g.counts[`${phase}:observe`], 1);
  assert.deepEqual(g.keys[phase], [reserved.intent.key]);
});
test('lost response never repeats publication or Assistant effects and retains original identities', async t => {
  for (const phase of ['publication', 'installation', 'assistant']) {
    const f = fixture(t), g = syntheticRegistry(f, { [phase]: { execute: async () => { throw Error('lost-response'); } } });
    const first = await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now + 1 });
    assert.equal(first.complete, false); assert.equal(first.phases.find(p => p.phase === phase).state, 'uncertain');
    const second = await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now + 2 });
    assert.equal(second.complete, true); assert.equal(g.counts[`${phase}:execute`], 1); assert.equal(g.counts[`${phase}:observe`], 1);
    assert.equal(new Set(g.keys[phase]).size, 1);
  }
});
test('both CI observations complete; one failure prevents artifacts and every dependent action', async t => {
  const f = fixture(t), g = syntheticRegistry(f, { 'private-ci': { execute: async () => ({ state: 'failed', externalId: 'failed-run:1', reason: 'canonical-ci-failed', receipt: null, output: null }) } });
  const r = await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now });
  assert.equal(r.complete, false); assert.equal(g.counts['public-ci:execute'], 1); assert.equal(g.counts['artifacts:execute'], undefined);
});
test('conflicting operation cannot reserve the target and missing browser remains an acceptance gap', async t => {
  const f = fixture(t), changed = structuredClone(f.descriptor); changed.operation.id = randomUUID();
  assert.throws(() => f.journal.initializeDelivery(changed, f.now), /UNIQUE constraint failed/);
  const g = syntheticRegistry(f, { browser: null }); const r = await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now });
  assert.equal(r.complete, false); assert.equal(r.acceptanceGap, 'missing-browser-adapter');
  assert.equal(r.phases.find(p => p.phase === 'assistant').state, 'completed');
  assert.throws(() => f.journal.completeDelivery(f.id, f.now), /acceptance-incomplete/);
});

test('read-only admission finishes after prerequisites and before a new parent reservation',async t=>{
  const f=fixture(t),g=syntheticRegistry(f),original=g.registry.adapter;let attempts=0;
  g.registry.adapter=(phase,...args)=>{
    const a=original.call(g.registry,phase,...args);
    if(phase==='installation')a.admit=async context=>{
      attempts++;assert.equal(context.journal.deliveryPhase(f.id,'installation'),null);
      assert.equal(context.journal.deliveryPhase(f.id,'publication').state,'completed');
      if(attempts===1)throw Error('fresh-readonly-capacity-unavailable');
      return {...context.input,admission:{fixtureOnly:true}};
    };
    return a;
  };
  await assert.rejects(stepDelivery(f.journal,f.id,g.registry,{clock:()=>f.now+1}),/fresh-readonly-capacity-unavailable/);
  assert.equal(f.journal.deliveryPhase(f.id,'installation'),null);assert.equal(g.counts['installation:execute'],undefined);
  assert.equal((await stepDelivery(f.journal,f.id,g.registry,{clock:()=>f.now+2})).complete,true);
  assert.equal(g.counts['publication:execute'],1);assert.equal(g.counts['installation:execute'],1);assert.equal(attempts,2);
  assert.equal(f.journal.deliveryPhase(f.id,'installation').input.admission.fixtureOnly,true);
  await stepDelivery(f.journal,f.id,g.registry,{clock:()=>f.now+3});assert.equal(attempts,2);
});

test('unknown original parent never receives another admission or effect dispatch',async t=>{
  const f=fixture(t),g=syntheticRegistry(f,{installation:{execute:async()=>{throw Error('original-response-lost');}}}),original=g.registry.adapter;let admissions=0;
  g.registry.adapter=(phase,...args)=>{const a=original.call(g.registry,phase,...args);if(phase==='installation')a.admit=async c=>{admissions++;return c.input;};return a;};
  await stepDelivery(f.journal,f.id,g.registry,{clock:()=>f.now+1});const key=f.journal.deliveryPhase(f.id,'installation').key;
  await stepDelivery(f.journal,f.id,g.registry,{clock:()=>f.now+2});
  assert.equal(admissions,1);assert.equal(g.counts['installation:execute'],1);assert.equal(g.counts['installation:observe'],1);
  assert.equal(f.journal.deliveryPhase(f.id,'installation').key,key);
});
test('wrong target, changed helper and corrupt retained input stop before producers', async t => {
  const f = fixture(t), g = syntheticRegistry(f); g.registry.targetIdentity = async () => digest('wrong');
  await assert.rejects(stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now }), /target-changed/); assert.deepEqual(g.counts, {});
  g.registry.targetIdentity = async () => f.descriptor.targetIdentity; g.registry.identity = async () => digest('wrong');
  await assert.rejects(stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now }), /adapter-changed/);
  f.journal.db.prepare("UPDATE deliveries SET descriptor_json='{}' WHERE id=?").run(f.id);
  assert.throws(() => f.journal.deliveryStatus(f.id, f.now), /record-hash-mismatch/);
});
test('external IDs, terminal evidence and original deadlines survive repeated resumes', t => {
  const f = fixture(t), r = f.journal.reserveDeliveryPhase(f.id, 'installation', { immutable: true }, f.now);
  f.journal.recordDeliveryObservation(f.id, 'installation', observation(r.intent, 'running', 'job1'), f.now + 1);
  assert.throws(() => f.journal.recordDeliveryObservation(f.id, 'installation', observation(r.intent, 'running', 'job2'), f.now + 2), /external-job-identity-changed/);
  f.journal.recordDeliveryObservation(f.id, 'installation', observation(r.intent, 'completed', 'job1'), f.now + 2);
  f.journal.recordDeliveryObservation(f.id, 'installation', observation(r.intent, 'uncertain'), f.now + 3);
  assert.equal(f.journal.deliveryPhase(f.id, 'installation').state, 'completed');
  const status = f.journal.deliveryStatus(f.id, f.now + 100000); assert.equal(status.originalDeadlineAtMs, f.now + 20000);
  assert.deepEqual(status.originalEstimate, f.descriptor.timeline.original);
  assert.throws(() => f.journal.reserveDeliveryPhase(f.id, 'installation', { immutable: false }, f.now + 4), /phase-input-changed/);
});
test('partial observation window returns resumable state without resetting elapsed time', async t => {
  const f = fixture(t); let now = f.now; const g = syntheticRegistry(f, { 'private-ci': { execute: async () => ({ state: 'running', externalId: 'run1:1', reason: 'canonical-ci-running', receipt: null, output: null }),
    observe: async () => ({ state: 'running', externalId: 'run1:1', reason: 'canonical-ci-running', receipt: null, output: null }) } });
  const r = await deliver(f.journal, f.id, g.registry, { clock: () => now, wait: async ms => { now += ms; }, invocationMs: 5, pollMs: 1 });
  assert.equal(r.elapsedMs, 5); assert.equal(r.complete, false); assert.equal(g.counts['private-ci:execute'], 1); assert.equal(g.counts['private-ci:observe'], 5);
});
test('format-two React-compatible artifacts select frontend; backend/dependency/shared changes and legacy capsules select full', () => {
  const item = { frontendCompatibility: { format: 2, eligibility: 'client-behavior', serviceInputsSha256: digest('same') }, appId: 'nova', apiVersion: 1, schemaVersion: 55 };
  assert.equal(chooseDeliveryRoute({ base: item, target: structuredClone(item), publicBase: item, publicTarget: item }), 'frontend');
  for (const change of ['backend', 'dependency', 'shared-contract']) {
    const target = structuredClone(item); target.frontendCompatibility.serviceInputsSha256 = digest(change);
    assert.equal(chooseDeliveryRoute({ base: item, target, publicBase: item, publicTarget: item }), 'full');
  }
  const legacy = structuredClone(item); legacy.frontendCompatibility.format = 1;
  assert.equal(chooseDeliveryRoute({ base: legacy, target: item, publicBase: item, publicTarget: item }), 'full');
});
test('actual source adapter validates frozen sources and reconciles lost push without a second push', async t => {
  const f = fixture(t); let pushed = false, pushes = 0; const command = async (_bin, args) => {
    if (args.includes('get-url')) return 'https://github.com/Example/Private.git\n';
    if (args.includes('rev-parse')) return args.at(-1).replace('^{commit}', '') + '\n';
    if (args.includes('merge-base')) return '';
    if (args.includes('push')) { pushes++; pushed = true; throw Error('lost-transport-response'); }
    if (args.includes('ls-remote')) return `${pushed ? 'a' : 'c'}`.repeat(40) + '\trefs/heads/main\n';
    throw Error('unexpected command');
  };
  const a = createSourceAdapter('private', command, { git: target, python: target, gitExecPath: root });
  const input = await a.input({ descriptor: f.descriptor }); await a.validate({ descriptor: f.descriptor, input });
  const intent = f.journal.reserveDeliveryPhase(f.id, 'private-source', input, f.now).intent;
  await assert.rejects(a.execute({ intent }), /lost-transport-response/); const r = await a.observe({ intent });
  assert.equal(r.state, 'completed'); assert.equal(pushes, 1);
});

test('draft attaches to the unchanged frozen coordinator only with original source, target and timeline', t => {
  const f = fixture(t), helperNames = ['install.py', 'recovery.py', 'codex_log_retention.py', 'app_dependencies.py', 'workspace_key.py', 'verify-session-bindings.mjs', 'operator_rehearsal.py'];
  const operation = { ...f.descriptor.operation, stage: 'frozen', candidateId: digest('candidate'), publicCandidateId: digest('public-candidate'), bundleSha256: digest('bundle'), helperHashes: Object.fromEntries(helperNames.map(n => [n, digest(n)])) };
  const d = { format: 1, input: { format: 1, operation, timeline: f.descriptor.timeline, evidence: {}, remainingEstimates: {} }, adapter: { transport: target, installSpec: target } };
  const description = { identity: digest('adapter'), scopeIdentity: f.descriptor.targetIdentity };
  assert.throws(() => f.journal.attachDeliveryCoordinator(f.id, d, { ...description, scopeIdentity: digest('other') }, f.now), /target-changed/);
  const changed = structuredClone(d); changed.input.operation.sourceCommits.public = 'e'.repeat(40);
  assert.throws(() => f.journal.attachDeliveryCoordinator(f.id, changed, description, f.now));
  const frozen = f.journal.attachDeliveryCoordinator(f.id, d, description, f.now);
  assert.equal(frozen.operationId, f.id); assert.equal(f.journal.load(f.id).input.operation.candidateId, operation.candidateId);
  assert.equal(f.journal.loadDelivery(f.id).descriptor.operation.stage, 'draft');
  const rows = f.journal.db.prepare('SELECT * FROM operations').all(); const checkpoints = f.journal.db.prepare('SELECT * FROM checkpoints').all();
  ensureDeliverySchema(f.journal); assert.deepEqual(f.journal.db.prepare('SELECT * FROM operations').all(), rows); assert.deepEqual(f.journal.db.prepare('SELECT * FROM checkpoints').all(), checkpoints);
});
test('overdue deadlines stop new effects, allow observation, and cannot be reset by a newer forecast', async t => {
  const f = fixture(t), g = syntheticRegistry(f), deadline = f.now + 20000;
  await assert.rejects(stepDelivery(f.journal, f.id, g.registry, { clock: () => deadline + 1 }), /overrun-review-required/); assert.deepEqual(g.counts, {});
  const timeline = structuredClone(f.descriptor.timeline); timeline.original.issuedAtMs = deadline;
  assert.throws(() => f.journal.checkpointDelivery(f.id, timeline, deadline + 1), /original-estimate-reset/);
  const good = structuredClone(f.descriptor.timeline); good.lastCheckpointAtMs = deadline + 1;
  good.revisions.push({ ...good.original, id: randomUUID(), issuedAtMs: deadline + 1, nextCheckpointAtMs: deadline + 300001 });
  f.journal.checkpointDelivery(f.id, good, deadline + 1);
  assert.equal(f.journal.deliveryStatus(f.id, deadline + 1).eta.dueReviews.length, 1);
  good.reviews.push({ deadlineId: good.original.id, reviewedAtMs: deadline + 2, action: 'change-approach', reason: 'Synthetic evidence-supported correction.', evidenceSha256: digest('evidence') });
  f.journal.checkpointDelivery(f.id, good, deadline + 2);
  assert.equal(f.journal.deliveryStatus(f.id, deadline + 2).eta.dueReviews.length, 0);
});
test('known missing producer integration stops before source publication', async t => {
  const f = fixture(t), g = syntheticRegistry(f); g.registry.preflight = async () => ['retained-artifact-producer-not-integrated'];
  const result = await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now });
  assert.equal(result.complete, false); assert.deepEqual(g.counts, {}); assert.equal(result.integrationGaps[0], 'retained-artifact-producer-not-integrated');
});
test('CI adapter binds maintained helper and configured tools and rejects a replacement attempt', async t => {
  const f = fixture(t), tools = { git: target, python: target, gitExecPath: root };
  const a = createCiAdapter('private', { tools, command: async () => { throw Error('must-not-execute'); }, validateTools: () => {} });
  const input = await a.input({ descriptor: f.descriptor });
  assert.deepEqual(input.tools, tools); assert.equal(Object.keys(input.helperHashes).length, 2);
  const intent = f.journal.reserveDeliveryPhase(f.id, 'private-ci', input, f.now).intent;
  await assert.rejects(a.verify({ state: 'running', externalId: '123:2' }, { descriptor: f.descriptor, intent: { ...intent, externalId: '123:1' } }), /ci-run-attempt-changed/);
  await assert.rejects(a.validate({ descriptor: f.descriptor, input: { ...input, tools: { ...tools, gitExecPath: '/ambient' } } }), /ci-input-changed/);
});
test('independent source histories and late corrupt artifact references are refused', t => {
  const f = fixture(t), same = structuredClone(f.descriptor); same.sources.public.root = same.sources.private.root;
  assert.throws(() => f.journal.initializeDelivery(same, f.now));
  const intent = f.journal.reserveDeliveryPhase(f.id, 'artifacts', {}, f.now).intent;
  assert.throws(() => f.journal.recordDeliveryObservation(f.id, 'artifacts', { ...observation(intent, 'completed'), receipt: { ...target, sha256: digest('corrupt') } }, f.now), /evidence-hash-changed/);
  assert.equal(f.journal.deliveryPhase(f.id, 'artifacts').state, 'reserved');
});
test('installation bridge never dispatches from an uncertain outer reservation with no coordinator intent', async () => {
  let calls = 0; const adapter = createCoordinatorInstallationAdapter({ resume: async () => { calls++; throw Error('unexpected'); } });
  const result = await adapter.observe({ descriptor: { operation: { id: randomUUID() } }, journal: { intent: () => null } });
  assert.equal(result.state, 'uncertain'); assert.equal(result.reason, 'original-install-reservation-not-recorded'); assert.equal(calls, 0);
});
test('installation bridge observes the original coordinator key and keeps both acceptance results pending', async () => {
  const operationId = randomUUID(), key = randomUUID(), job = randomUUID(); let calls = 0;
  const stored = { state: 'completed', idempotencyKey: key, externalJobId: job, lastObservation: null };
  const adapter = createCoordinatorInstallationAdapter({ resume: async (_directory, id) => { assert.equal(id, operationId); calls++; return { operationId, intent: stored }; } });
  const context = { descriptor: { operation: { id: operationId } }, journal: { directory: 'synthetic-only', intent: () => stored } };
  const result = await adapter.observe(context); await adapter.verify(result, context);
  assert.equal(calls, 1); assert.equal(result.state, 'completed'); assert.equal(result.output.idempotencyKey, key);
  assert.equal(result.output.savedReplyAccepted, false); assert.equal(result.output.browserAccepted, false);
});
test('durable phase intent survives closing and reopening the original SQLite journal file', async t => {
  const f = fixture(t), path = join(root, `journal-${randomUUID()}.sqlite`);
  const original = Object.create(ReleaseJournal.prototype); original.db = new DatabaseSync(path); original.readOnly = false; original.directory = root;
  original.db.exec(baseSchema); original.initializeDelivery(f.descriptor, f.now);
  const reservation = original.reserveDeliveryPhase(f.id, 'private-source', { phase: 'private-source', source: f.descriptor.operation.sourceCommits }, f.now);
  assert.equal(original.db.prepare('PRAGMA synchronous').get().synchronous, 2); assert.equal(original.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal'); original.close();
  const reopened = Object.create(ReleaseJournal.prototype); reopened.db = new DatabaseSync(path); reopened.readOnly = false; reopened.directory = root; t.after(() => reopened.close());
  reopened.db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  const g = syntheticRegistry({ ...f, journal: reopened });
  const result = await stepDelivery(reopened, f.id, g.registry, { clock: () => f.now + 1 });
  assert.equal(result.complete, true); assert.equal(g.counts['private-source:execute'], undefined); assert.equal(g.keys['private-source'][0], reservation.intent.key);
});
test('positive producer verification failure is failed with its exact bounded reason, not transport uncertainty', async t => {
  const f = fixture(t), g = syntheticRegistry(f), original = g.registry.adapter;
  g.registry.adapter = (...args) => { const adapter = original(...args); if (args[0] === 'private-source') adapter.verify = async () => { throw Error('signature-invalid'); }; return adapter; };
  const result = await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now });
  const phase = result.phases.find(p => p.phase === 'private-source'); assert.equal(phase.state, 'failed'); assert.equal(phase.reason, 'signature-invalid');
  assert.equal(g.counts['public-source:execute'], undefined); assert.equal(f.journal.deliveryPhase(f.id, 'private-source').current.output.verificationFailed, true);
});
test('rejected producer claims survive durably without admitting their identity or opening their receipt', async t => {
  const f = fixture(t), claim = { state: 'completed', externalId: 'untrusted-new-job-123', reason: 'fixture-completed',
    receipt: { path: 'must-not-open-this-path', sha256: 'invalid-claimed-digest' }, output: { reply: 'x'.repeat(90000) } };
  const g = syntheticRegistry(f, { 'private-source': { execute: async () => claim } }), original = g.registry.adapter;
  g.registry.adapter = (...args) => { const adapter = original(...args); if (args[0] === 'private-source') adapter.verify = async () => { throw Error('receipt-corrupt'); }; return adapter; };
  const result = await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now });
  assert.equal(result.phases[0].state, 'failed');
  const phase = f.journal.deliveryPhase(f.id, 'private-source'); assert.equal(phase.externalId, null); assert.equal(phase.current.receipt, null);
  const row = f.journal.db.prepare("SELECT payload_json FROM delivery_events WHERE operation_id=? AND kind='rejected-producer-observation'").get(f.id);
  const evidence = JSON.parse(row.payload_json); assert.equal(evidence.claim.authority, 'untrusted-rejected-producer-claim');
  assert.equal(evidence.claim.externalId.value, claim.externalId); assert.equal(evidence.claim.receipt.path.value, claim.receipt.path);
  assert.equal(evidence.claim.receipt.sha256.value, claim.receipt.sha256); assert.equal(evidence.claim.output.truncated, true);
  assert.ok(row.payload_json.length < 70000);
  await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now + 1 });
  assert.equal(g.counts['private-source:execute'], 1); assert.equal(g.counts['private-source:observe'], undefined);
  assert.equal(g.counts['public-source:execute'], undefined);
});
test('source transport uses only configured executable and rejects changed bytes before commands', async t => {
  const f = fixture(t), seen = [], tools = { git: target, python: target, gitExecPath: root };
  const a = createSourceAdapter('private', async (bin, args, options) => {
    seen.push({ bin, options });
    if (args.includes('get-url')) return 'https://github.com/Example/Private.git';
    if (args.includes('rev-parse')) return args.at(-1).replace('^{commit}', '');
    return '';
  }, tools);
  const input = await a.input({ descriptor: f.descriptor }); await a.validate({ descriptor: f.descriptor, input });
  assert.ok(seen.length > 0 && seen.every(call => call.bin === target.path && call.options.gitExecPath === root));
  const bad = createSourceAdapter('private', async () => { throw Error('must-not-run'); }, { ...tools, git: { ...target, sha256: digest('tampered') } });
  await assert.rejects(bad.validate({ descriptor: f.descriptor, input: await bad.input({ descriptor: f.descriptor }) }), /evidence-hash-changed/);
});
test('rejected replacement identity retains the prior trusted external job and the new untrusted claim', async t => {
  const f = fixture(t), phase = 'private-source', originalIntent = f.journal.reserveDeliveryPhase(f.id, phase, { phase, source: f.descriptor.operation.sourceCommits }, f.now).intent;
  f.journal.recordDeliveryObservation(f.id, phase, observation(originalIntent, 'running', 'original-trusted-job'), f.now);
  const g = syntheticRegistry(f, { [phase]: { observe: async () => ({ state: 'completed', externalId: 'rejected-new-job', reason: 'fixture-completed', receipt: null, output: {} }) } });
  const original = g.registry.adapter;
  g.registry.adapter = (...args) => { const a = original(...args); if (args[0] === phase) a.verify = async () => { throw Error('service-identity-mismatch'); }; return a; };
  await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now + 1 });
  const retained = f.journal.deliveryPhase(f.id, phase); assert.equal(retained.externalId, 'original-trusted-job'); assert.equal(retained.state, 'failed');
  const event = JSON.parse(f.journal.db.prepare("SELECT payload_json FROM delivery_events WHERE operation_id=? AND kind='rejected-producer-observation'").get(f.id).payload_json);
  assert.equal(event.trustedExternalId, 'original-trusted-job'); assert.equal(event.claim.externalId.value, 'rejected-new-job');
  assert.equal(g.counts[`${phase}:execute`], undefined); assert.equal(g.counts[`${phase}:observe`], 1);
});
test('tampered completed receipt blocks resume before dependent effects without repeating the completed producer', async t => {
  const f = fixture(t), g = syntheticRegistry(f, { 'public-source': null }), path = join(root, `completed-${randomUUID()}.json`);
  writeFileSync(path, 'original'); const retained = { path, sha256: sha256(readFileSync(path)) }, original = g.registry.adapter;
  g.registry.adapter = (...args) => { const adapter = original(...args); if (args[0] === 'private-source') {
    const execute = adapter.execute; adapter.execute = async context => ({ ...await execute(context), receipt: retained });
    adapter.verify = async value => { if (value.state === 'completed') { const { readEvidenceFile } = await import('../scripts/release-plan.mjs'); readEvidenceFile(value.receipt); } };
  } return adapter; };
  const first = await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now }); assert.equal(first.acceptanceGap, 'missing-public-source-adapter');
  writeFileSync(path, 'tampered'); const resumed = await stepDelivery(f.journal, f.id, g.registry, { clock: () => f.now + 1 });
  const phase = resumed.phases.find(p => p.phase === 'private-source'); assert.equal(phase.state, 'failed'); assert.equal(phase.reason, 'evidence-hash-changed');
  assert.equal(g.counts['private-source:execute'], 1); assert.equal(g.counts['private-source:observe'], undefined); assert.equal(g.counts['public-source:execute'], undefined);
  assert.equal(f.journal.deliveryPhase(f.id, 'private-source').current.state, 'completed');
});
test('one invocation observes CI beyond sixty seconds and completes without manual resume or duplicate effects', async t => {
  const f = fixture(t); let now = f.now;
  const timeline = structuredClone(f.descriptor.timeline); timeline.original.remainingMs = [60000, 120000];
  // A distinct fixture with this original estimate; never rewrite a stored ETA.
  const g = fixture(t, { timeline }); const registry = syntheticRegistry(g, { 'private-ci': {
    execute: async () => ({ state: 'running', externalId: 'run1:1', reason: 'canonical-ci-running', receipt: null, output: null }),
    observe: async () => now - g.now < 65000 ? { state: 'running', externalId: 'run1:1', reason: 'canonical-ci-running', receipt: null, output: null }
      : { state: 'completed', externalId: 'run1:1', reason: 'canonical-ci-passed', receipt: null, output: { runId: 1 } },
  } });
  const result = await deliver(g.journal, g.id, registry.registry, { invocationMs: 120000, pollMs: 5000, clock: () => now, wait: async ms => { now += ms; } });
  assert.equal(result.complete, true); assert.equal(result.elapsedMs, 65000); assert.equal(registry.counts['private-ci:execute'], 1);
  assert.equal(registry.counts['private-ci:observe'], 13); assert.equal(registry.counts['installation:execute'], 1);
});
test('fixed transport accepts only bounded structured producer refusals on its designated exit code', async () => {
  const body = JSON.stringify({ state: 'failed', reason: 'retained-archive-corrupt', receipt: null, output: { verificationFailed: true }, externalId: null });
  const args = ['-e', `process.stdout.write(${JSON.stringify(body)});process.exit(2)`];
  const value = await fixedCommand(process.execPath, args, { acceptJsonFailure: true, maximum: 8192 });
  assert.equal(JSON.parse(value).reason, 'retained-archive-corrupt');
  await assert.rejects(fixedCommand(process.execPath, args, { maximum: 8192 }), /producer-response-unavailable/);
  await assert.rejects(fixedCommand(process.execPath, ['-e', "process.stdout.write('private unstructured details');process.exit(2)"], { acceptJsonFailure: true, maximum: 8192 }), /producer-response-unavailable/);
});
test('fixed transport carries configured Git execution directory into the local child process', async () => {
  const value = await fixedCommand(process.execPath, ['-e', "process.stdout.write(JSON.stringify({git:process.env.GIT_EXEC_PATH,prompt:process.env.GIT_TERMINAL_PROMPT}))"], { gitExecPath: root });
  assert.deepEqual(JSON.parse(value), { git: root, prompt: '0' });
});
test('one invocation skips repeated completed hashing during polls but rechecks before the next effect', async t => {
  const f = fixture(t), path = join(root, `poll-retained-${randomUUID()}.json`); writeFileSync(path, 'original');
  const receipt = { path, sha256: sha256(readFileSync(path)) }; let now = f.now, hashes = 0, atFirstWait;
  const g = syntheticRegistry(f, { capacity: {
    execute: async () => ({ state: 'running', externalId: 'capacity1', reason: 'fixture-running', receipt: null, output: null }),
    observe: async () => ({ state: now - f.now >= 15000 ? 'completed' : 'running', externalId: 'capacity1', reason: 'fixture-capacity', receipt: null, output: { capacity: true } }),
  } });
  const original = g.registry.adapter;
  g.registry.adapter = (...args) => { const adapter = original(...args); if (args[0] === 'artifacts') {
    const execute = adapter.execute; adapter.execute = async context => ({ ...await execute(context), receipt });
    adapter.verify = async value => { if (value.state === 'completed') { hashes++; const { readEvidenceFile } = await import('../scripts/release-plan.mjs'); readEvidenceFile(value.receipt); } };
  } return adapter; };
  const result = await deliver(f.journal, f.id, g.registry, { invocationMs: 19000, pollMs: 5000, clock: () => now, wait: async ms => {
    if (atFirstWait === undefined) atFirstWait = hashes; else assert.equal(hashes, atFirstWait, 'pure observation must not repeat completed hashing');
    now += ms; if (now - f.now === 15000) writeFileSync(path, 'tampered');
  } });
  assert.equal(result.phases.find(p => p.phase === 'artifacts').state, 'failed');
  assert.equal(result.phases.find(p => p.phase === 'artifacts').reason, 'evidence-hash-changed');
  assert.equal(hashes, atFirstWait + 1);
  assert.equal(g.counts['artifacts:execute'], 1); assert.equal(g.counts['recovery:execute'], undefined);
});
