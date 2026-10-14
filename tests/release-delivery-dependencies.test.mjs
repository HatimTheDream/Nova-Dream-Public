import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ReleaseJournal } from '../scripts/release-coordinate.mjs';
import { sha256, readEvidenceFile } from '../scripts/release-plan.mjs';
import { PACKAGE_SUBSTEPS } from '../scripts/release-delivery-journal.mjs';
import { advancePackageSubstep, createDependencyPairProducer, createDurableFullBundleAdapter } from '../scripts/release-delivery-dependencies.mjs';
import { packageUpdateBundle } from '../scripts/update-bundle.mjs';
import { stepDelivery } from '../scripts/release-deliver.mjs';
import { fixture as fullFixture } from '../support/full-fixture.mjs';

const steps = PACKAGE_SUBSTEPS.filter(name => name !== 'bundle');
const digest = x => sha256(String(x));
const schema = readFileSync(new URL('../scripts/release-coordinate.mjs', import.meta.url), 'utf8')
  .match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}', String(0x4e56524c));
function fixture(t, full = null) {
  const tempParent = resolve(tmpdir()), root = mkdtempSync(join(tempParent, 'nova-m2-substeps-'));
  t.after(() => { journal.close(); assert.equal(dirname(root), tempParent); assert.ok(root.startsWith(tempParent + sep)); rmSync(root, { recursive: true, force: true });
    if (full) { assert.equal(dirname(full.root), tempParent); assert.ok(full.root.startsWith(join(tempParent, 'nova-m2-full-substep-'))); rmSync(full.root, { recursive: true, force: true }); } });
  const journal = Object.create(ReleaseJournal.prototype); journal.directory = full?.root ?? root; journal.readOnly = false;
  journal.db = new DatabaseSync(join(root, 'journal.sqlite')); journal.db.exec(schema);
  const targetPath = join(root, 'target.json'); writeFileSync(targetPath, '{}');
  const now = Date.now(), id = full?.descriptor.operation.id ?? randomUUID();
  const operation = { id, stage: 'draft', candidateId: null, publicCandidateId: null, priorCandidateId: digest('prior'), workspaceEpoch: randomUUID(), version: '2.3.0', buildVersion: '1.0.287',
    agentVersion: '2026.9.8', priorAgentVersion: '2026.9.8', sourceCommits: { private: 'a'.repeat(40), public: 'b'.repeat(40) }, bundleSha256: null,
    trustedPublicKeySha256: digest('key'), changeClass: 'application', helperHashes: null, ...full?.descriptor.operation };
  const original = { id: randomUUID(), step: 'total', issuedAtMs: now, remainingMs: [600000, 1200000], confidence: 'low', basis: 'Synthetic bound.', reason: 'Original estimate.', nextCheckpointAtMs: now + 300000 };
  const descriptor = { format: 1, operation, sources: Object.fromEntries(['private', 'public'].map((side, i) => [side, {
    root: '/' + side, repository: full?.descriptor.sources[side].repository ?? 'Example/' + side, commit: operation.sourceCommits[side], baseCommit: (i ? 'd' : 'c').repeat(40), branch: 'main' }])),
    target: { path: targetPath, sha256: digest('{}') }, targetIdentity: digest('target'), adapterIdentity: digest('adapter'),
    observationBudgetMs: 14400000, timeline: { startedAtMs: now, original, revisions: [], reviews: [], lastCheckpointAtMs: now } };
  journal.initializeDelivery(descriptor, now);
  const input = full ? { route: full.route, artifacts: full.artifacts, options: full.options } : { route: { targetCandidateId: digest('target'), publicCandidateId: digest('public') } };
  const intent = journal.reserveDeliveryPhase(id, 'package', input, now).intent;
  const calls = {}, outputs = {}, workers = {}, context = { descriptor, journal, intent, beforeNewEffect: async () => { calls.admission = (calls.admission ?? 0) + 1; } };
  const output = c => ({ phase: c.intent.phase, worker: c.worker, nonce: c.intent.key });
  const maintained = { validate: async () => {}, steps: {}, normalizePair: async value => ({ kind: 'maintained-qualified-update-pair', operationId: id, key: intent.key,
    sourceCommits: operation.sourceCommits, candidateId: input.route.targetCandidateId, publicCandidateId: input.route.publicCandidateId, priorCandidateId: operation.priorCandidateId, pair: value }), verifyPair: async () => {} };
  for (const name of steps) maintained.steps[name] = {
    input: async c => ({ name, previous: Object.keys(c.priorSubsteps) }), validate: async () => {},
    execute: async c => { calls[name] = (calls[name] ?? 0) + 1; workers[name] = c.worker; outputs[name] = output(c);
      return { state: 'completed', externalId: 'unit-' + c.intent.key, reason: 'fixture-completed', receipt: null, output: outputs[name] }; },
    observe: async c => { calls[name + ':observe'] = (calls[name + ':observe'] ?? 0) + 1;
      return { state: outputs[name] ? 'completed' : 'uncertain', externalId: outputs[name] ? 'unit-' + c.intent.key : null,
        reason: 'fixture-observed', receipt: null, output: outputs[name] ?? null }; },
    verify: async (value, c) => { if (value.state === 'completed') assert.equal(value.output.nonce, c.intent.key); } };
  return { root, journal, descriptor, context, now, calls, outputs, workers, maintained, producer: () => createDependencyPairProducer({ maintained, clock: () => now }) };
}

test('lost response at every dependency substep resumes original worker without duplicate effects', async t => {
  for (const lost of steps) await t.test(lost, async t => {
    const f = fixture(t), old = f.maintained.steps[lost].execute;
    f.maintained.steps[lost].execute = async c => { await old(c); throw Error('lost'); };
    const first = await f.producer().execute(f.context); assert.equal(first.state, 'uncertain');
    const key = f.journal.deliveryPhase(f.descriptor.operation.id, 'package/' + lost).key;
    const second = await f.producer().observe(f.context); assert.equal(second.state, 'completed');
    for (const name of steps) assert.equal(f.calls[name], 1);
    assert.equal(f.calls[lost + ':observe'], 1); assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id, 'package/' + lost).key, key);
    assert.equal(f.workers[lost].deadlineAtMs, f.now + 615000);
    assert.equal(f.journal.deliveryStatus(f.descriptor.operation.id, f.now).originalDeadlineAtMs, f.now + 1200000);
  });
});
test('reservation before dispatch remains uncertain and never starts that worker on resume', async t => {
  const f = fixture(t), payload = await f.maintained.steps['dependency-stage'].input({ ...f.context, priorSubsteps: {} });
  f.journal.reserveDeliveryPhase(f.descriptor.operation.id, 'package/dependency-stage', { parentKey: f.context.intent.key,
    parentInputSha256: f.context.intent.inputSha256, priorResultsSha256: digest('{}'), payload }, f.now);
  assert.equal((await f.producer().observe(f.context)).state, 'uncertain');
  assert.equal(f.calls['dependency-stage'], undefined); assert.equal(f.calls['dependency-plan'], undefined);
});
test('concurrent resumes have one transaction winner for every child effect', async t => {
  const f = fixture(t), second = Object.create(ReleaseJournal.prototype); second.directory = f.journal.directory; second.readOnly = false;
  second.db = new DatabaseSync(join(f.root, 'journal.sqlite'));
  try { await Promise.all([f.producer().execute(f.context), f.producer().observe({ ...f.context, journal: second })]); }
  finally { second.close(); }
  assert.equal((await f.producer().inspect(f.context)).state, 'completed');
  for (const name of steps) assert.equal(f.calls[name], 1);
  assert.equal(f.journal.db.prepare("SELECT count(*) n FROM delivery_phases WHERE phase LIKE 'package/%'").get().n, 6);
});
test('closing and reopening the journal preserves a lost worker response and original reservation', async t => {
  const f = fixture(t), originalExecute = f.maintained.steps['dependency-execute'].execute;
  f.maintained.steps['dependency-execute'].execute = async c => { await originalExecute(c); throw Error('lost'); };
  await f.producer().execute(f.context);
  const original = f.journal.deliveryPhase(f.descriptor.operation.id, 'package/dependency-execute');
  f.journal.db.close(); f.journal.db = new DatabaseSync(join(f.root, 'journal.sqlite'));
  const completed = await f.producer().observe(f.context);
  assert.equal(completed.state, 'completed'); assert.equal(f.calls['dependency-execute'], 1);
  assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id, 'package/dependency-execute').key, original.key);
  assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id, 'package/dependency-execute').createdAtMs, original.createdAtMs);
});
test('tampered completed prerequisite blocks a new child before its reservation', async t => {
  const f = fixture(t), proof = join(f.root, 'proof'); writeFileSync(proof, 'original'); const reference = { path: proof, sha256: digest('original') };
  f.maintained.steps['dependency-stage'].verify = async () => readEvidenceFile(reference);
  f.maintained.steps['dependency-plan'].input = async () => { writeFileSync(proof, 'changed'); return {}; };
  await assert.rejects(f.producer().execute(f.context), /hash|changed/i);
  assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id, 'package/dependency-plan'), null);
  assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id, 'package/dependency-stage').validation.state, 'failed');
});
test('original trusted worker identity cannot change on observation', async t => {
  const f = fixture(t), step = f.maintained.steps['dependency-stage'];
  step.execute = async () => ({ state: 'running', externalId: 'unit-original', reason: 'running', receipt: null, output: null });
  step.observe = async () => ({ state: 'running', externalId: 'unit-replacement', reason: 'running', receipt: null, output: null });
  await f.producer().execute(f.context); const value = await f.producer().observe(f.context);
  assert.equal(value.state, 'failed'); assert.equal(value.reason, 'dependency-external-identity-changed');
  assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id, 'package/dependency-stage').externalId, 'unit-original');
});
test('inspection and missing maintained transport never create substeps', async t => {
  const f = fixture(t); assert.equal((await f.producer().inspect(f.context)).state, 'uncertain');
  assert.equal((await createDependencyPairProducer().execute(f.context)).state, 'gap');
  assert.equal(f.journal.db.prepare('SELECT count(*) n FROM delivery_phases').get().n, 1);
});
test('descriptor and parent mutations are refused before any child effects', async t => {
  const f = fixture(t), changed = structuredClone(f.descriptor); changed.operation.version = '9.9.9';
  await assert.rejects(f.producer().execute({ ...f.context, descriptor: changed }), /descriptor-changed/);
  await assert.rejects(f.producer().execute({ ...f.context, intent: { ...f.context.intent, key: randomUUID() } }), /parent-changed/);
  assert.equal(f.calls['dependency-stage'], undefined);
});

test('asynchronous pair completion permits the never-started bundle once and resumes it read-only', async t => {
  const full = fullFixture(), f = fixture(t, full); let ready = false, packs = 0;
  const pair = { validate: async () => {}, inspect: async c => ready ? full.pairProducer.result(c)
    : { state: 'running', externalId: c.intent.key, reason: 'pair-running', receipt: null, output: null }, verify: full.pairProducer.verify };
  pair.observe = pair.inspect;
  const adapter = createDurableFullBundleAdapter({ options: full.options, pairProducer: pair, clock: () => f.now,
    pack: (...args) => { packs++; return packageUpdateBundle(...args); } });
  assert.equal((await adapter.execute(f.context)).state, 'running'); assert.equal(packs, 0);
  ready = true; const completed = await adapter.observe(f.context); assert.equal(completed.state, 'completed'); assert.equal(packs, 1);
  await adapter.verify(completed, f.context); assert.deepEqual((await adapter.observe(f.context)).output, completed.output); assert.equal(packs, 1);
});
test('lost bundle response verifies existing bytes, while partial output is not repackaged', async t => {
  for (const partial of [false, true]) await t.test(String(partial), async t => {
    const full = fullFixture(), f = fixture(t, full); let packs = 0;
    const pair = { ...full.pairProducer, inspect: full.pairProducer.result };
    const adapter = createDurableFullBundleAdapter({ options: full.options, pairProducer: pair, clock: () => f.now,
      pack: (directory, path) => { packs++; if (partial) writeFileSync(path, 'partial'); else packageUpdateBundle(directory, path); throw Error('lost response'); } });
    assert.equal((await adapter.execute(f.context)).state, 'uncertain');
    const value = await adapter.observe(f.context); assert.equal(value.state, partial ? 'uncertain' : 'completed'); assert.equal(packs, 1);
  });
});
test('unreserved bundle output blocks fresh packaging and is preserved', async t => {
  const full = fullFixture(), f = fixture(t, full); let packs = 0;
  const path = join(full.root, `delivery-full-${f.context.intent.key}.json`); writeFileSync(path, 'untracked');
  const pair = { ...full.pairProducer, inspect: full.pairProducer.result };
  const adapter = createDurableFullBundleAdapter({ options: full.options, pairProducer: pair, clock: () => f.now, pack: () => { packs++; } });
  assert.equal((await adapter.observe(f.context)).reason, 'unreserved-full-bundle-output-present');
  assert.equal(packs, 0); assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id, 'package/bundle'), null);
  assert.equal(readFileSync(path, 'utf8'), 'untracked');
});
test('outer completed prerequisites are reverified before an existing package starts a new child', async t => {
  const f = fixture(t); let corrupt = false, effects = 0;
  const adapter = { input: async () => ({}), validate: async () => {}, verify: async () => {}, execute: async () => { throw Error('not expected'); },
    observe: async c => { corrupt = true; await c.beforeNewEffect(); effects++; return { state: 'running', externalId: c.intent.key, reason: 'running', receipt: null, output: null }; } };
  const registry = { identity: async () => f.descriptor.adapterIdentity, targetIdentity: async () => f.descriptor.targetIdentity,
    adapter: phase => phase === 'package' ? adapter : { input: async () => ({}), validate: async () => {},
      execute: async () => ({ state: 'completed', externalId: phase, reason: 'fixture-completed', receipt: null, output: {} }), observe: async () => {},
      verify: async () => { if (corrupt) throw Error('changed-prerequisite'); } } };
  const status = await stepDelivery(f.journal, f.descriptor.operation.id, registry, { clock: () => f.now });
  assert.equal(status.complete, false); assert.equal(effects, 0);
  assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id, 'private-source').validation.reason, 'changed-prerequisite');
});

test('stepDelivery persists durable bundle completed and uncertain observations without leaking child metadata', async t => {
  for (const partial of [false, true]) await t.test(partial ? 'uncertain partial output' : 'completed bundle', async t => {
    const full = fullFixture(), f = fixture(t, full); let packs = 0;
    const pair = { ...full.pairProducer, inspect: full.pairProducer.result };
    const adapter = createDurableFullBundleAdapter({ options: full.options, pairProducer: pair, clock: () => f.now,
      pack: (directory, path) => { packs++; if (partial) { writeFileSync(path, 'partial'); throw Error('lost response'); }
        return packageUpdateBundle(directory, path); } });
    const registry = { identity: async () => f.descriptor.adapterIdentity, targetIdentity: async () => f.descriptor.targetIdentity,
      adapter: phase => {
        if (phase === 'package') return adapter;
        if (phase === 'sign') return null;
        const output = phase === 'artifacts' ? { repositories: full.artifacts } : phase === 'route' ? full.route : {};
        const value = { state: 'completed', externalId: phase, reason: 'fixture-completed', receipt: null, output };
        return { input: async () => ({}), validate: async () => {}, execute: async () => value, observe: async () => value, verify: async () => {} };
      } };
    await stepDelivery(f.journal, f.descriptor.operation.id, registry, { clock: () => f.now });
    const parent = f.journal.deliveryPhase(f.descriptor.operation.id, 'package');
    const child = f.journal.deliveryPhase(f.descriptor.operation.id, 'package/bundle');
    assert.equal(parent.state, partial ? 'uncertain' : 'completed');
    assert.equal(parent.externalId, f.context.intent.key);
    assert.equal(parent.current.receipt, child.current.receipt);
    assert.deepEqual(parent.current.output, child.current.output);
    assert.equal(parent.current.reason, child.current.reason);
    assert.notEqual(parent.key, child.key);
    const raw = JSON.parse(f.journal.db.prepare("SELECT observation_json FROM delivery_observations WHERE operation_id=? AND phase='package' ORDER BY id DESC LIMIT 1").get(f.descriptor.operation.id).observation_json);
    assert.deepEqual(Object.keys(raw).sort(), ['externalId', 'key', 'output', 'reason', 'receipt', 'state']);
    await stepDelivery(f.journal, f.descriptor.operation.id, registry, { clock: () => f.now });
    assert.equal(packs, 1);
    assert.equal(f.journal.deliveryPhase(f.descriptor.operation.id, 'package/bundle').key, child.key);
    if (partial) assert.equal(readFileSync(join(full.root, `delivery-full-${parent.key}.json`), 'utf8'), 'partial');
  });
});
