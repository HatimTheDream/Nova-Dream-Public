/** Fixed transport for the maintained installation requester. No input becomes
 * a shell command. A lost transport response is uncertain and never retried. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { readEvidenceFile } from './release-plan.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().min(1).max(4096).refine(p => isAbsolute(p) && !p.includes('\0'));
const reference = z.object({ path: absolute, sha256: digest }).strict();
const version = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[A-Za-z0-9.-]{1,40})?$/);
export const releaseTransportSchema = z.object({ format: z.literal(1), sshConfig: reference,
  hostAlias: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/) }).strict();
export const releaseInstallSpecSchema = z.object({ format: z.literal(1), operationId: z.uuid(),
  candidateId: digest, priorCandidateId: digest, workspaceEpoch: z.uuid(), version, buildVersion: version,
  priorVersion: version, priorBuildVersion: version, schemaVersion: z.number().int().min(1).max(100000),
  apiVersion: z.number().int().min(1).max(100000), agentVersion: version, priorAgentVersion: version,
  bundleSha256: digest, rehearsalLeaseId: z.uuid(), rehearsalProofSha256: digest }).strict();
const helperPath = fileURLToPath(new URL('../deploy/update-runner/request_install.py', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function requireValue(condition, message) { if (!condition) throw Error(message); }
function jsonRef(ref) { return JSON.parse(readEvidenceFile(reference.parse(ref), { maximum: 65536 })); }

function adapterInputs({ transport, installSpec, operation, input }) {
  const target = releaseTransportSchema.parse(jsonRef(transport));
  // Bind the actual SSH configuration, not just the path to a mutable alias.
  readEvidenceFile(target.sshConfig, { maximum: 65536 });
  const spec = releaseInstallSpecSchema.parse(jsonRef(installSpec));
  for (const name of ['candidateId', 'priorCandidateId', 'workspaceEpoch', 'version', 'buildVersion', 'agentVersion', 'priorAgentVersion', 'bundleSha256'])
    requireValue(spec[name] === operation[name], 'install-spec-operation-mismatch');
  requireValue(spec.operationId === operation.id && operation.stage === 'frozen', 'install-operation-not-frozen');
  requireValue(input.evidence?.recovery?.proof?.sha256 === spec.rehearsalProofSha256, 'install-rehearsal-proof-mismatch');
  const review = jsonRef(input.evidence.recovery.review);
  requireValue(review.leaseId === spec.rehearsalLeaseId && review.workspaceEpoch === operation.workspaceEpoch
    && review.candidateId === operation.priorCandidateId, 'install-rehearsal-review-mismatch');
  const info = lstatSync(helperPath);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= 256 * 1024, 'install-helper-unavailable');
  const helper = readFileSync(helperPath);
  requireValue(helper.length === info.size, 'install-helper-changed');
  const identity = hash(canonical({ transport: transport.sha256, sshConfig: target.sshConfig.sha256,
    installSpec: installSpec.sha256, helper: hash(helper) }));
  const scopeIdentity = hash(canonical({ hostAlias: target.hostAlias, sshConfig: target.sshConfig.sha256 }));
  return { target, spec, helper, identity, scopeIdentity };
}

export function describeInstallAdapter(context) { const { identity, scopeIdentity } = adapterInputs(context); return { identity, scopeIdentity }; }

/** Source is fixed; the only substituted bytes are canonical base64 data. The
 * bootstrap stages immutable helper/input bytes and delegates to that helper.
 * Observe mode performs no staging writes, and absence never authorizes replay. */
export function buildInstallTransportProgram({ helper, spec, idempotencyKey, mode }) {
  requireValue(['execute', 'observe'].includes(mode) && z.uuid().safeParse(idempotencyKey).success, 'invalid-install-mode');
  const payload = Buffer.from(canonical({ helper: helper.toString('base64'), helperSha256: hash(helper),
    operation: { ...releaseInstallSpecSchema.parse(spec), idempotencyKey }, mode })).toString('base64');
  return `import base64,hashlib,json,os,pathlib,stat,sys
P=pathlib.Path
data=json.loads(base64.b64decode('${payload}'))
def require(v):
 if not v: raise RuntimeError('authority-or-identity-mismatch')
def protected(path,directory=False,private=False):
 require(path.is_absolute() and path.resolve(strict=True)==path)
 for part in (path,*path.parents):
  s=part.lstat();require(not stat.S_ISLNK(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022)
 s=path.lstat();require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink==1)
 if private: require(not s.st_mode&0o077)
 return s
def read(path,bound=65536,private=False):
 s=protected(path,private=private);require(s.st_size<=bound)
 with path.open('rb') as f: value=f.read(bound+1)
 after=path.lstat();require(len(value)==s.st_size and (s.st_dev,s.st_ino,s.st_mtime_ns,s.st_size)==(after.st_dev,after.st_ino,after.st_mtime_ns,after.st_size))
 return value
def sync(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 try: os.fsync(fd)
 finally: os.close(fd)
def directory(path):
 protected(path.parent,True)
 if not os.path.lexists(path): path.mkdir(mode=0o700);sync(path.parent)
 protected(path,True,True)
def exact(path,value):
 if os.path.lexists(path): require(read(path,262144,True)==value);return
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f: f.write(value);f.flush();os.fsync(f.fileno())
 sync(path.parent)
try:
 require(os.geteuid()==0 and sys.platform=='linux')
 config=json.loads(read(P('/etc/nova-update/config.json')))
 state=P(config['stateDirectory']);protected(state,True,True)
 helper=base64.b64decode(data['helper'],validate=True);require(hashlib.sha256(helper).hexdigest()==data['helperSha256'])
 toolroot=P('/opt/nova-release-tools');toolversion=toolroot/data['helperSha256'];tool=toolversion/'request_install.py'
 root=state/'release-coordinator';inputs=root/'inputs';operation=inputs/(data['operation']['operationId']+'.json')
 value=(json.dumps(data['operation'],sort_keys=True,separators=(',',':'))+'\\n').encode()
 if data['mode']=='execute':
  for path in (toolroot,toolversion,root,inputs): directory(path)
  exact(tool,helper);exact(operation,value)
 else:
  require(read(tool,262144,True)==helper and read(operation,65536,True)==value)
 os.execv('/usr/bin/python3',['/usr/bin/python3','-B',str(tool),'--operation',str(operation),'--'+data['mode']])
except Exception:
 print(json.dumps({'kind':'nova-release-adapter-error','reasonCode':'remote-request-unavailable','automaticResubmissionPermitted':False}))
 sys.exit(2)
`;
}

export function runInstallTransport(target, program) {
  const args = ['-F', target.sshConfig.path, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1',
    '-T', target.hostAlias, 'sudo -n /usr/bin/python3 -B -'];
  return new Promise(resolve => {
    let child, settled = false, total = 0, stdout = '', oversized = false;
    const done = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child?.kill(); done({ uncertain: true, reasonCode: 'transport-timeout' }); }, 120000);
    try { child = spawn('ssh', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { done({ uncertain: true, reasonCode: 'transport-unavailable' }); return; }
    child.on('error', () => done({ uncertain: true, reasonCode: 'transport-unavailable' }));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      total += chunk.length;
      if (total > 131072) { oversized = true; child.kill(); }
      else if (stream === child.stdout) stdout += chunk.toString('utf8');
    });
    child.on('close', code => done(oversized ? { uncertain: true, reasonCode: 'transport-response-too-large' }
      : code !== 0 && !stdout.trim() ? { uncertain: true, reasonCode: 'transport-response-uncertain' } : { stdout, exitCode: code }));
    child.stdin.on('error', () => { child.kill(); done({ uncertain: true, reasonCode: 'transport-write-uncertain' }); });
    child.stdin.end(program);
  });
}

export function classifyInstallObservation(value, operation, intent) {
  const base = { candidateId: operation.candidateId, priorCandidateId: operation.priorCandidateId,
    workspaceEpoch: operation.workspaceEpoch, idempotencyKey: intent.idempotencyKey, externalJobId: null, observation: null };
  const uncertain = reasonCode => ({ ...base, state: 'uncertain', reasonCode });
  if (!value || value.candidateId !== operation.candidateId || value.priorCandidateId !== operation.priorCandidateId
    || value.workspaceEpoch !== operation.workspaceEpoch || value.releaseId !== operation.bundleSha256
    || value.idempotencyKey !== intent.idempotencyKey) return uncertain('observation-identity-mismatch');
  const refusalCodes = new Set(['fresh-real-heartbeat-not-observed', 'full-rehearsal-not-released', 'full-rehearsal-proof-mismatch',
    'exact-signed-offer-unavailable', 'prior-live-identity-changed', 'prior-runtime-changed', 'installation-held-or-unsupported',
    'installation-readiness-blocked', 'intent-exists-observe-only', 'idempotency-already-recorded-observe-only',
    'invocation-deadline', 'observation-deadline', 'request-not-recorded-or-reply-uncertain', 'original-request-identity-mismatch',
    'request-client-unavailable', 'authority-not-private', 'operation-or-config-changed']);
  if (!z.uuid().safeParse(value.jobId).success) return uncertain(refusalCodes.has(value.reason) ? `remote-${value.reason}` : 'original-job-not-observed');
  base.externalJobId = value.jobId;
  if (value.state === 'completed' && value.jobHold === false && value.controllerHoldObserved === true
    && value.controllerHoldFor === null && value.currentJobMatches === true)
    return { ...base, state: 'completed', reasonCode: 'controller-job-completed-acceptance-required' };
  if (['restored', 'failed', 'cancelled'].includes(value.state)) {
    if (value.jobHold !== false || value.controllerHoldObserved !== true || value.controllerHoldFor !== null)
      return { ...base, state: 'uncertain', reasonCode: 'controller-failure-still-held' };
    return { ...base, state: 'failed', reasonCode: 'controller-job-terminal-not-installed' };
  }
  if (['waiting', 'downloading', 'verifying', 'preparing', 'installing', 'restarting', 'checking'].includes(value.state))
    return { ...base, state: 'running', reasonCode: 'original-controller-job-running' };
  return uncertain('original-job-unsettled');
}

async function invoke(context, mode) {
  const inputs = adapterInputs({ ...context.adapter, operation: context.operation, input: context.input });
  requireValue(inputs.identity === context.adapter.identity, 'install-adapter-changed');
  const result = await runInstallTransport(inputs.target, buildInstallTransportProgram({ ...inputs, idempotencyKey: context.intent.idempotencyKey, mode }));
  if (result.uncertain) return { candidateId: context.operation.candidateId, priorCandidateId: context.operation.priorCandidateId,
    workspaceEpoch: context.operation.workspaceEpoch, idempotencyKey: context.intent.idempotencyKey,
    externalJobId: null, observation: null, state: 'uncertain', reasonCode: result.reasonCode };
  let value;
  try { value = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)); } catch { value = null; }
  if (value && result.exitCode !== 0) value.state = 'uncertain';
  return classifyInstallObservation(value, context.operation, context.intent);
}
export const dispatchInstall = context => invoke(context, 'execute');
export const observeInstall = context => invoke(context, 'observe');
