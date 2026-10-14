import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReleaseJournal } from '../scripts/release-coordinate.mjs';
import { sha256 } from '../scripts/release-plan.mjs';
import { createCoordinatorInstallationAdapter } from '../scripts/release-delivery-install.mjs';
import { createFullInstalledIdentityObserver, originalInstalledIdentityRequest } from '../scripts/release-delivery-installed-identity.mjs';
import { createDeliveryRegistry, deliveryPhaseIntegrationGaps } from '../scripts/release-delivery-adapters.mjs';

const encoded = value => Buffer.from(JSON.stringify(value) + '\n'), now = 1791990000000;
const schema = readFileSync(new URL('../scripts/release-coordinate.mjs', import.meta.url), 'utf8')
  .match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}', String(0x4e56524c));
function fixture(t) {
  const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, 'nova-full-identity-integration-'));
  mkdirSync(join(root, 'delivery-evidence'));
  const put = (name, data) => {
    const path = join(root, name), raw = Buffer.isBuffer(data) ? data : encoded(data);
    if (existsSync(path)) assert.deepEqual(readFileSync(path), raw, 'exclusive fixture receipt must preserve original bytes');
    else writeFileSync(path, raw, { flag: 'wx' });
    return { path, sha256: sha256(raw) };
  };
  const storeReceipt = (_journal, key, name, raw) => put(`delivery-evidence/${key}-${name}`, raw);
  const ssh = put('ssh.conf', Buffer.from('Host fixture\n HostName example.invalid\n'));
  const transport = put('transport.json', { format: 1, sshConfig: ssh, hostAlias: 'fixture' });
  const runtime = { startupReview: { path: '/opt/nova-release-tools/fixture/startup-review.json', sha256: sha256('startup') },
    hostConfig: { path: '/etc/nova-update/config.json', sha256: sha256('config') } };
  const target = { format: 1, transport, assistantHost: runtime, browserCapability: 'unavailable' };
  const op = { id: randomUUID(), stage: 'frozen', candidateId: sha256('new'), publicCandidateId: sha256('public'),
    priorCandidateId: sha256('prior'), workspaceEpoch: randomUUID(), version: '2.3.6', buildVersion: '1.0.293',
    agentVersion: '2026.9.8', priorAgentVersion: '2026.9.8', sourceCommits: { private: 'a'.repeat(40), public: 'b'.repeat(40) },
    bundleSha256: sha256('bundle'), trustedPublicKeySha256: sha256('key'), changeClass: 'application',
    helperHashes: Object.fromEntries(['install.py','recovery.py','codex_log_retention.py','app_dependencies.py','workspace_key.py','verify-session-bindings.mjs','operator_rehearsal.py'].map(name => [name, sha256(name)])) };
  const timeline = { startedAtMs: now, original: { id: randomUUID(), step: 'total', issuedAtMs: now,
    remainingMs: [300000, 300000], confidence: 'low', basis: 'Synthetic integration fixture.', reason: 'Original deadline.', nextCheckpointAtMs: now + 300000 },
    revisions: [], reviews: [], lastCheckpointAtMs: now };
  const descriptor = { format: 1, operation: op, sources: Object.fromEntries(['private','public'].map((side,i) => [side, {
    root: '/' + side, repository: 'Example/' + side, commit: op.sourceCommits[side], baseCommit: (i ? 'd' : 'c').repeat(40), branch: 'main' }])),
    target: put('target.json', target), targetIdentity: sha256('target'), adapterIdentity: sha256('fixture-registry'), observationBudgetMs: 60000, timeline };
  const spec = { format: 1, operationId: op.id, ...Object.fromEntries(['candidateId','priorCandidateId','workspaceEpoch','version','buildVersion','agentVersion','priorAgentVersion','bundleSha256'].map(k => [k,op[k]])),
    priorVersion: '2.3.4', priorBuildVersion: '1.0.291', schemaVersion: 55, apiVersion: 1, rehearsalLeaseId: randomUUID(), rehearsalProofSha256: sha256('proof') };
  const coordinator = { format: 1, input: { format: 1, operation: op, timeline, evidence: { recovery: { proof: { path: join(root,'proof.json'), sha256: spec.rehearsalProofSha256 } } } },
    adapter: { transport, installSpec: put('install-spec.json', spec) } };
  const journal = Object.create(ReleaseJournal.prototype);
  journal.directory = root; journal.readOnly = false; journal.db = new DatabaseSync(join(root, 'fixture.sqlite')); journal.db.exec(schema); journal.initializeDelivery(descriptor, now);
  t.after(() => { journal.close(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const original = { state: 'completed', idempotencyKey: randomUUID(), externalJobId: randomUUID(), lastObservation: null };
  // External coordinator boundary is synthetic; phase reservations/observations
  // use the actual on-disk SQLite implementation and actual integration source.
  journal.intent = () => original;
  const prior = { route: { route: 'full', targetCandidateId: op.candidateId }, publication: { coordinatorDescriptor: coordinator } };
  const intent = journal.reserveDeliveryPhase(op.id, 'installation', { coordinatorDescriptor: coordinator }, now).intent;
  const context = { descriptor, prior, intent, journal };
  const completed = { state: 'completed', reason: 'fixture-completed-controller', externalId: original.externalJobId, receipt: null,
    output: { controllerCompleted: true, coordinatorOperationId: op.id, idempotencyKey: original.idempotencyKey,
      jobId: original.externalJobId, savedReplyAccepted: false, browserAccepted: false } };
  const options = { transport, ...runtime, storeReceipt };
  const request = originalInstalledIdentityRequest(context, completed, options);
  const proof = { format: 1, kind: 'maintained-installed-acceptance-identity', operationId: op.id, candidateId: op.candidateId,
    priorCandidateId: op.priorCandidateId, jobId: request.jobId, idempotencyKey: request.operation.idempotencyKey, request,
    health: { candidateId: op.candidateId, epoch: op.workspaceEpoch, apiVersion: 1, schemaVersion: 55, serviceInputsSha256: sha256('service'), processIdentity: randomUUID(), frontend: { source: 'bundled' } },
    appProcess: { ActiveState: 'active', SubState: 'running', MainPID: '123', ExecMainStartTimestampMonotonic: '456' },
    runtimeProof: { openclawVersion: op.agentVersion, configurationSha256: runtime.hostConfig.sha256 },
    installationProof: { jobId: request.jobId, releaseId: op.bundleSha256, candidateId: op.candidateId,
      candidateFilesSha256: op.candidateId, hostConfigSha256: runtime.hostConfig.sha256 },
    readOnly: true, savedReplyAccepted: false, browserUiVerified: false };
  let reads = 0, observations = 0;
  const run = async (_target, program) => {
    reads++; const payload = JSON.parse(Buffer.from(program.match(/b64decode\('([^']+)'/)[1], 'base64'));
    assert.equal(payload.value.mode, 'identity'); assert.deepEqual(payload.value.binding, request);
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, value: proof }) };
  };
  const resume = async (_directory,id) => { observations++; assert.equal(id, op.id); return { operationId: id, intent: original }; };
  const observer = createFullInstalledIdentityObserver({ ...options, run });
  const adapter = createCoordinatorInstallationAdapter({ resume, identityObserver: observer });
  return { root, put, target, descriptor, runtime, transport, coordinator, original, context, completed, options, request, proof, observer, adapter, run, resume,
    counts: () => ({ reads, observations }), record: value => journal.recordDeliveryObservation(op.id, 'installation', { ...value, key: intent.key }, now + 1) };
}

test('original completed installation obtains retained identity while acceptance remains separate', async t => {
  const f = fixture(t), result = await f.adapter.observe(f.context);
  await f.adapter.verify(result, f.context); f.record(result);
  assert.equal(result.state, 'completed'); assert.deepEqual(result.output.acceptanceIdentity, f.proof);
  assert.equal(result.output.savedReplyAccepted, false); assert.equal(result.output.browserAccepted, false);
  assert.deepEqual(f.counts(), { reads: 1, observations: 1 });
  await f.adapter.verify(result, f.context); assert.deepEqual(f.counts(), { reads: 1, observations: 1 });
  assert.equal(f.context.journal.deliveryPhase(f.descriptor.operation.id, 'assistant'), null);
});

test('lost identity response only re-observes the same original installation', async t => {
  const f = fixture(t); let calls = 0;
  const observer = createFullInstalledIdentityObserver({ ...f.options, run: async (...args) => ++calls === 1
    ? { uncertain: true, stdout: 'original response lost', stderr: '' } : f.run(...args) });
  const adapter = createCoordinatorInstallationAdapter({ resume: f.resume, identityObserver: observer });
  const first = await adapter.observe(f.context); f.record(first);
  assert.equal(first.state, 'uncertain'); assert.equal(first.externalId, f.original.externalJobId);
  assert.equal(first.output.controllerCompleted, true); assert.equal(first.output.identityObserved, false);
  const second = await adapter.observe(f.context); await adapter.verify(second, f.context);
  assert.equal(second.state, 'completed'); assert.equal(second.externalId, first.externalId);
  assert.equal(second.output.idempotencyKey, first.output.idempotencyKey); assert.equal(calls, 2);
});

test('wrong proof identity is a positive failure with retained private diagnostics', async t => {
  const f = fixture(t);
  const observer = createFullInstalledIdentityObserver({ ...f.options, run: async () => ({ exitCode: 0,
    stdout: JSON.stringify({ ok: true, value: { ...f.proof, jobId: randomUUID() } }) }) });
  const result = await observer.observe(f.context, f.completed);
  assert.equal(result.state, 'failed'); assert.equal(result.reason, 'full-actual-installed-identity-changed');
  assert.equal(result.output.acceptanceIdentity, undefined); assert.ok(existsSync(result.receipt.path));
});

test('changed original key, candidate or retained proof cannot satisfy acceptance', async t => {
  const f = fixture(t), result = await f.adapter.observe(f.context);
  const wrong = { ...f.completed, output: { ...f.completed.output, idempotencyKey: randomUUID() } };
  assert.throws(() => originalInstalledIdentityRequest(f.context, wrong, f.options), /completed-coordinator-required/);
  const changed = { ...f.context, prior: { route: { route: 'full', targetCandidateId: sha256('other') } } };
  assert.throws(() => originalInstalledIdentityRequest(changed, f.completed, f.options), /installation-recovery-changed/);
  writeFileSync(result.output.acceptanceIdentityReceipt.path, encoded({ ...f.proof, jobId: randomUUID() }));
  await assert.rejects(f.adapter.verify(result, f.context), /evidence-hash-changed/);
});

test('lost parent observation cannot overwrite an already captured process identity', async t => {
  const f = fixture(t); await f.adapter.observe(f.context);
  f.proof.health.processIdentity = randomUUID();
  const result = await f.adapter.observe(f.context);
  assert.equal(result.state, 'failed'); assert.equal(result.output.acceptanceIdentity, undefined);
});

test('changed install-spec bytes are refused before read-only transport', async t => {
  const f = fixture(t); writeFileSync(f.coordinator.adapter.installSpec.path, '{}');
  const result = await f.adapter.observe(f.context);
  assert.equal(result.state, 'failed'); assert.equal(result.reason, 'evidence-hash-changed');
  assert.equal(f.counts().reads, 0);
});

test('main registry connects full Assistant to original identity and retains its parent deadline', async t => {
  const f = fixture(t), installed = await f.adapter.observe(f.context); f.record(installed);
  const prior = { ...f.context.prior, installation: installed.output }, modes = [];
  const registry = createDeliveryRegistry({ receiptStore: f.options.storeReceipt, clock: () => now + 10, run: async (_target, program) => {
    const value = JSON.parse(Buffer.from(program.match(/b64decode\('([^']+)'/)[1], 'base64')).value;
    modes.push(value.mode); assert.equal(value.binding.fullRequest.jobId, f.request.jobId);
    assert.equal(value.binding.deadlineAtMs, now + 300002);
    return { uncertain: true, stdout: 'synthetic lost session response', stderr: '' };
  } });
  assert.deepEqual(deliveryPhaseIntegrationGaps('assistant', f.target, prior), []);
  // This fixture observes an already completed original install. A new install
  // still requires the separate full host admission configuration.
  assert.equal(registry.adapter('installation', f.descriptor, prior), null);
  assert.ok(deliveryPhaseIntegrationGaps('installation', f.target, prior).includes('full-protected-host-target-not-configured'));
  const adapter = registry.adapter('assistant', f.descriptor, prior), input = await adapter.input({ descriptor: f.descriptor, prior });
  const intent = f.context.journal.reserveDeliveryPhase(f.descriptor.operation.id, 'assistant', input, now + 2).intent;
  const context = { ...f.context, prior, input, intent, beforeNewEffect: async () => {} };
  const first = await adapter.execute(context), second = await adapter.observe(context);
  assert.equal(first.state, 'uncertain'); assert.equal(second.state, 'uncertain'); assert.deepEqual(modes, ['session','session']);
  assert.equal(f.context.journal.deliveryPhase(f.descriptor.operation.id, 'assistant').key, intent.key);
  assert.equal(f.context.journal.deliveryPhase(f.descriptor.operation.id, 'assistant/session').input.deadlineAtMs, now + 300002);
  assert.equal(f.context.journal.deliveryPhase(f.descriptor.operation.id, 'assistant/submit'), null);
  assert.ok(deliveryPhaseIntegrationGaps('browser', f.target, prior).includes('browser-capability-unavailable'));
});
