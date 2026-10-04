import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseTransportSchema, releaseInstallSpecSchema, buildInstallTransportProgram,
  classifyInstallObservation, runInstallTransport, describeInstallAdapter } from '../scripts/release-adapters.mjs';
import { sha256 } from '../scripts/release-plan.mjs';

const digest = c => c.repeat(64);
function fixture() {
  const spec = { format: 1, operationId: randomUUID(), candidateId: digest('a'), priorCandidateId: digest('b'),
    workspaceEpoch: randomUUID(), version: '2.2.0', buildVersion: '1.0.281', priorVersion: '2.1.4',
    priorBuildVersion: '1.0.280', schemaVersion: 55, apiVersion: 1, agentVersion: '2026.9.8',
    priorAgentVersion: '2026.9.6', bundleSha256: digest('c'), rehearsalLeaseId: randomUUID(), rehearsalProofSha256: digest('d') };
  const intent = { idempotencyKey: randomUUID() };
  const operation = { ...spec, id: spec.operationId };
  const observed = { candidateId: spec.candidateId, priorCandidateId: spec.priorCandidateId,
    workspaceEpoch: spec.workspaceEpoch, releaseId: spec.bundleSha256, idempotencyKey: intent.idempotencyKey,
    jobId: randomUUID(), state: 'completed', jobHold: false, controllerHoldFor: null, controllerHoldObserved: true, currentJobMatches: true };
  return { spec, operation, intent, observed };
}

test('typed transport and install inputs reject command injection and unknown authority fields', () => {
  const f = fixture(); assert.equal(releaseInstallSpecSchema.parse(f.spec).candidateId, f.spec.candidateId);
  assert.throws(() => releaseInstallSpecSchema.parse({ ...f.spec, command: 'restart' }));
  assert.throws(() => releaseInstallSpecSchema.parse({ ...f.spec, operationId: '../another-operation' }));
  for (const hostAlias of ['-oProxyCommand=anything', 'host;restart', 'host\nrestart'])
    assert.equal(releaseTransportSchema.safeParse({ format: 1, sshConfig: { path: join(tmpdir(), 'config'), sha256: digest('e') }, hostAlias }).success, false);
});

test('job completion is only installation progress; held, different and absent jobs stay uncertain', () => {
  const f = fixture(), classify = value => classifyInstallObservation(value, f.operation, f.intent);
  assert.equal(classify(f.observed).state, 'completed');
  assert.equal(classify(f.observed).reasonCode, 'controller-job-completed-acceptance-required');
  for (const patch of [{ jobHold: true }, { controllerHoldFor: randomUUID() }, { controllerHoldObserved: false }, { currentJobMatches: false },
    { candidateId: digest('f') }, { idempotencyKey: randomUUID() }, { workspaceEpoch: randomUUID() }, { jobId: null }])
    assert.equal(classify({ ...f.observed, ...patch }).state, 'uncertain');
  assert.equal(classify({ ...f.observed, state: 'restored' }).state, 'failed');
  const heldFailure = classify({ ...f.observed, state: 'failed', jobHold: true });
  assert.equal(heldFailure.state, 'uncertain'); assert.equal(heldFailure.externalJobId, f.observed.jobId);
  assert.equal(classify({ ...f.observed, state: 'restored', controllerHoldObserved: false }).state, 'uncertain');
  assert.equal(classify({ ...f.observed, state: 'checking', jobHold: true }).state, 'running');
  assert.equal(classify({ ...f.observed, state: 'uncertain', jobId: null, reason: 'prior-runtime-changed' }).reasonCode, 'remote-prior-runtime-changed');
  assert.equal(classify({ ...f.observed, state: 'uncertain', jobId: null, reason: 'private-error-details' }).reasonCode, 'original-job-not-observed');
});

test('adapter identity pins exact inputs while host serialization survives a new operation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-release-adapter-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let n = 0;
  const put = value => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const path = join(directory, `input-${++n}.json`); writeFileSync(path, bytes); return { path, sha256: sha256(bytes) }; };
  const f = fixture(), transport = put({ format: 1, hostAlias: 'synthetic-host', sshConfig: put('Host synthetic-host\n  HostName example.invalid\n') });
  const installSpec = put(f.spec), review = put({ leaseId: f.spec.rehearsalLeaseId, workspaceEpoch: f.spec.workspaceEpoch, candidateId: f.spec.priorCandidateId });
  const context = { transport, installSpec, operation: { ...f.operation, stage: 'frozen' },
    input: { evidence: { recovery: { review, proof: { path: join(directory, 'not-opened-proof.json'), sha256: f.spec.rehearsalProofSha256 } } } } };
  const first = describeInstallAdapter(context); assert.match(first.identity, /^[a-f0-9]{64}$/);
  const nextId = randomUUID();
  const next = describeInstallAdapter({ ...context, operation: { ...context.operation, id: nextId }, installSpec: put({ ...f.spec, operationId: nextId }) });
  assert.notEqual(next.identity, first.identity); assert.equal(next.scopeIdentity, first.scopeIdentity);
  assert.throws(() => describeInstallAdapter({ ...context, operation: { ...context.operation, candidateId: digest('f') } }), /mismatch/);
  writeFileSync(installSpec.path, JSON.stringify({ ...f.spec, priorVersion: '0.0.0' }));
  assert.throws(() => describeInstallAdapter(context), /evidence-hash-changed/);
});

test('generated fixed bootstrap compiles and encodes a valid immutable operation file', t => {
  const f = fixture();
  const program = buildInstallTransportProgram({ helper: Buffer.from('print("fixture helper")\n'), spec: f.spec,
    idempotencyKey: f.intent.idempotencyKey, mode: 'observe' });
  const python = process.env.NOVA_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const checker = `import ast,base64,json,sys
tree=ast.parse(sys.stdin.read())
payload=next(n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str) and n.value.startswith('eyJoZWxwZXIi'))
data=json.loads(base64.b64decode(payload))
assert data['mode']=='observe'
assignment=next(n for n in ast.walk(tree) if isinstance(n,ast.Assign) and isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Attribute) and n.value.func.attr=='encode')
value=eval(compile(ast.Expression(assignment.value),'<immutable-input>','eval'),{'json':json,'data':data})
assert json.loads(value)==data['operation']
assert value.endswith(b'\\n')
print('valid')
`;
  const checked = spawnSync(python, ['-B', '-c', checker], { input: program, encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (checked.error?.code === 'ENOENT' && process.platform === 'win32') { t.skip('Set NOVA_TEST_PYTHON to the installed Python executable.'); return; }
  assert.equal(checked.status, 0, checked.stderr); assert.equal(checked.stdout.trim(), 'valid');
});

test('an actual failed SSH client returns uncertainty without retry or remote dispatch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-release-transport-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await runInstallTransport({ hostAlias: 'invalid-synthetic-release-host', sshConfig: { path: join(directory, 'absent-config') } }, 'print("never executed")');
  assert.equal(result.uncertain, true);
  assert.ok(['transport-unavailable', 'transport-response-uncertain', 'transport-write-uncertain'].includes(result.reasonCode));
});
