import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
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

test('application migration is an exact optional55-to60 contract, never a widened target schema', () => {
  const {spec}=fixture();
  const migration={...spec,schemaVersion:60,priorAgentVersion:'2026.9.8',applicationQualification:{priorSchemaVersion:55,
    reviewedPairSha256:digest('e'),projectionSha256:digest('f')}};
  assert.deepEqual(releaseInstallSpecSchema.parse(migration),migration);
  for(const change of [s=>delete s.applicationQualification,s=>s.applicationQualification.priorSchemaVersion=60,
    s=>s.schemaVersion=55,s=>s.apiVersion=2,s=>s.priorAgentVersion='2026.9.6',
    s=>s.applicationQualification.path='/untrusted/path',s=>s.applicationQualification=null]){
    const changed=structuredClone(migration);change(changed);assert.throws(()=>releaseInstallSpecSchema.parse(changed));
  }
});

test('migration bootstrap binds original bounded sidecars outside compact operation for execute and observe', t => {
  const f=fixture(), pair=Buffer.from(JSON.stringify({synthetic:true,padding:'x'.repeat(300000)})),
    projection=Buffer.from(JSON.stringify({synthetic:true,padding:'y'.repeat(280000)}));
  const spec={...f.spec,schemaVersion:60,priorAgentVersion:'2026.9.8',applicationQualification:{priorSchemaVersion:55,
    reviewedPairSha256:sha256(pair),projectionSha256:sha256(projection)}};
  const input={helper:Buffer.from('# synthetic helper\n'),spec,idempotencyKey:f.intent.idempotencyKey,applicationEvidence:{pair,projection}};
  const python=process.env.NOVA_TEST_PYTHON??(process.platform==='win32'?'python':'python3');
  for(const mode of ['execute','observe']){
    const program=buildInstallTransportProgram({...input,mode});
    const data=JSON.parse(Buffer.from(program.match(/data=json.loads\(base64.b64decode\('([^']+)'/)[1],'base64'));
    assert.deepEqual(Buffer.from(data.applicationEvidence.pair,'base64'),pair);
    assert.deepEqual(Buffer.from(data.applicationEvidence.projection,'base64'),projection);
    assert.deepEqual(data.operation,{...spec,idempotencyKey:f.intent.idempotencyKey});
    assert.ok(Buffer.byteLength(JSON.stringify(data.operation))<8192);
    assert.match(program,/exact\(path,content,bound\)/);assert.match(program,/read\(path,bound,True\)==content/);
    const checked=spawnSync(python,['-B','-c','import ast,sys; ast.parse(sys.stdin.read())'],{input:program,encoding:'utf8',timeout:10000,windowsHide:true});
    if(checked.error?.code==='ENOENT'&&process.platform==='win32'){t.skip('Set NOVA_TEST_PYTHON to installed Python.');return;}
    assert.equal(checked.status,0,checked.stderr);
  }
  for(const applicationEvidence of [undefined,{pair:Buffer.concat([pair,Buffer.from(' ')]),projection},
    {pair,projection:Buffer.alloc(512*1024+1)}])
    assert.throws(()=>buildInstallTransportProgram({...input,mode:'execute',applicationEvidence}),/application-evidence/);
  assert.throws(()=>buildInstallTransportProgram({...input,spec:f.spec,mode:'execute'}),/unexpected-application-evidence/);
});

test('Linux protected bootstrap stages once and observes immutable sidecars without writing', t => {
  if(process.platform!=='linux'||process.getuid?.()!==0||!process.env.NOVA_TEST_PROTECTED_ROOT){
    t.skip('Needs explicit disposable root-owned Linux NOVA_TEST_PROTECTED_ROOT.');return;
  }
  const root=mkdtempSync(join(process.env.NOVA_TEST_PROTECTED_ROOT,'requester-bootstrap-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const state=join(root,'state'),config=join(root,'config.json'),tools=join(root,'tools');
  mkdirSync(state,{mode:0o700});writeFileSync(config,JSON.stringify({stateDirectory:state}),{mode:0o600});
  const f=fixture(),pair=Buffer.from(JSON.stringify({synthetic:true,padding:'x'.repeat(300000)})),
    projection=Buffer.from(JSON.stringify({synthetic:true,padding:'y'.repeat(280000)}));
  const spec={...f.spec,schemaVersion:60,priorAgentVersion:'2026.9.8',applicationQualification:{priorSchemaVersion:55,
    reviewedPairSha256:sha256(pair),projectionSha256:sha256(projection)}};
  const input={helper:Buffer.from('# synthetic requester, never executed\n'),spec,idempotencyKey:f.intent.idempotencyKey,applicationEvidence:{pair,projection}};
  // Only the fixed configuration/tools locations and final exec are redirected
  // into this explicit fixture. Generated authority, I/O and mode branches run.
  const wrapper=`import ast,json,os,sys
tree=ast.parse(sys.stdin.read())
replacement={'/etc/nova-update/config.json':sys.argv[1],'/opt/nova-release-tools':sys.argv[2]}
class FixturePaths(ast.NodeTransformer):
 def visit_Constant(self,node):
  if isinstance(node.value,str) and node.value in replacement: return ast.copy_location(ast.Constant(replacement[node.value]),node)
  return node
def captured(executable,args):
 assert executable=='/usr/bin/python3' and args[-1] in ('--execute','--observe')
 print(json.dumps({'fixtureExec':args[-1]}));raise SystemExit(0)
os.execv=captured
exec(compile(ast.fix_missing_locations(FixturePaths().visit(tree)),'generated-protected-bootstrap','exec'))
`;
  const run=mode=>spawnSync(process.env.NOVA_TEST_PYTHON??'python3',['-B','-c',wrapper,config,tools],
    {input:buildInstallTransportProgram({...input,mode}),encoding:'utf8',timeout:10000});
  const executed=run('execute');assert.equal(executed.status,0,executed.stdout+executed.stderr);
  const sidecar=join(state,'release-coordinator','inputs',spec.operationId+'.qualification'),pairPath=join(sidecar,'reviewed-pair.json'),proofPath=join(sidecar,'startup-qualification.json');
  assert.deepEqual(readFileSync(pairPath),pair);assert.deepEqual(readFileSync(proofPath),projection);
  assert.equal(statSync(pairPath).mode&0o777,0o600);assert.equal(statSync(sidecar).mode&0o777,0o700);
  const before=[statSync(pairPath).mtimeMs,statSync(proofPath).mtimeMs];
  assert.equal(run('observe').status,0);assert.deepEqual([statSync(pairPath).mtimeMs,statSync(proofPath).mtimeMs],before);
  writeFileSync(pairPath,Buffer.concat([pair,Buffer.from(' ')]));
  assert.equal(run('execute').status,2);assert.equal(run('observe').status,2);assert.equal(readFileSync(pairPath).length,pair.length+1);
  writeFileSync(pairPath,pair);unlinkSync(proofPath);
  assert.equal(run('observe').status,2);assert.throws(()=>readFileSync(proofPath),{code:'ENOENT'});
});
