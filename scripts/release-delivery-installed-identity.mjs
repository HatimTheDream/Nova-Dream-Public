/** Read-only identity bridge after the original full coordinator completes.
 * A missing/lost observation never dispatches an installation or Assistant call. */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual as equal } from 'node:util';
import { normalizeCoordinatorDescriptor } from './release-coordinate.mjs';
import { readEvidenceFile, sha256, validateOperationContinuation } from './release-plan.mjs';
import { releaseInstallSpecSchema, releaseTransportSchema, runInstallTransport } from './release-adapters.mjs';
import { buildInstalledIdentityProgram, validateInstalledIdentityRequest } from './release-delivery-assistant-full.mjs';

const need = (v, reason) => { if (!v) throw Error(reason); };
const canonical = v => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const bytes = v => Buffer.from(canonical(v) + '\n');
const safeReason = e => /^[a-z][a-z0-9-]{0,99}$/.test(e?.message ?? '') ? e.message : 'full-installed-identity-rejected';

export function originalInstalledIdentityRequest(context, completed, { transport, startupReview, hostConfig }) {
  const { descriptor, intent, journal } = context;
  const frozen = normalizeCoordinatorDescriptor(intent.input.coordinatorDescriptor);
  validateOperationContinuation(frozen.input.operation, descriptor.operation);
  const op = frozen.input.operation, original = journal.intent(descriptor.operation.id);
  need(op.id === descriptor.operation.id && op.stage === 'frozen' && equal(frozen.adapter.transport, transport), 'full-original-installation-target-changed');
  need(original?.state === 'completed' && completed.state === 'completed' && completed.output?.controllerCompleted === true
    && completed.output.coordinatorOperationId === op.id && completed.output.idempotencyKey === original.idempotencyKey
    && completed.output.jobId === original.externalJobId && completed.externalId === original.externalJobId,
  'full-original-completed-coordinator-required');
  const spec = releaseInstallSpecSchema.parse(JSON.parse(readEvidenceFile(frozen.adapter.installSpec, { maximum: 65536 })));
  need(spec.operationId === op.id && ['candidateId','priorCandidateId','workspaceEpoch','version','buildVersion','agentVersion','priorAgentVersion','bundleSha256']
    .every(k => spec[k] === op[k]), 'full-original-installation-spec-changed');
  need(spec.candidateId === context.prior.route.targetCandidateId
    && frozen.input.evidence.recovery.proof.sha256 === spec.rehearsalProofSha256, 'full-original-installation-recovery-changed');
  const helper = sha256(readFileSync(new URL('../deploy/update-runner/request_install.py', import.meta.url)));
  return validateInstalledIdentityRequest({ format: 1, operation: { ...spec, idempotencyKey: original.idempotencyKey },
    jobId: original.externalJobId, requester: { path: `/opt/nova-release-tools/${helper}/request_install.py`, sha256: helper },
    runtime: { startupReview, hostConfig } });
}

export function verifyInstalledIdentity(proof, request) {
  const op = request.operation;
  need(proof?.format === 1 && proof.kind === 'maintained-installed-acceptance-identity' && proof.readOnly === true
    && proof.savedReplyAccepted === false && proof.browserUiVerified === false && equal(proof.request, request)
    && proof.operationId === op.operationId && proof.candidateId === op.candidateId && proof.priorCandidateId === op.priorCandidateId
    && proof.jobId === request.jobId && proof.idempotencyKey === op.idempotencyKey, 'full-actual-installed-identity-changed');
  need(proof.health?.candidateId === op.candidateId && proof.health.epoch === op.workspaceEpoch
    && proof.health.apiVersion === op.apiVersion && proof.health.schemaVersion === op.schemaVersion
    && /^[a-f0-9]{64}$/.test(proof.health.serviceInputsSha256 ?? '')
    && /^[a-f0-9-]{36}$/.test(proof.health.processIdentity ?? '') && proof.health.frontend,
  'full-actual-installed-health-changed');
  need(proof.installationProof?.jobId === request.jobId && proof.installationProof.releaseId === op.bundleSha256
    && proof.installationProof.candidateId === op.candidateId && proof.installationProof.candidateFilesSha256 === op.candidateId
    && proof.installationProof.hostConfigSha256 === request.runtime.hostConfig.sha256
    && proof.runtimeProof?.openclawVersion === op.agentVersion
    && proof.runtimeProof.configurationSha256 === request.runtime.hostConfig.sha256
    && proof.appProcess?.ActiveState === 'active' && proof.appProcess.SubState === 'running' && Number(proof.appProcess.MainPID) > 1,
  'full-actual-installed-runtime-or-result-changed');
  if(Object.hasOwn(proof.installationProof,'installerResultBytesBase64')){
    const value=proof.installationProof.installerResultBytesBase64;
    need(typeof value==='string'&&value.length<=5464,'full-original-result-bytes-invalid');
    const raw=Buffer.from(value,'base64');
    need(raw.length<=4096&&raw.toString('base64')===value&&sha256(raw)===proof.installationProof.installerResult?.sha256
      &&equal(JSON.parse(raw),{format:1,jobId:request.jobId,candidateId:op.candidateId,priorCandidateId:op.priorCandidateId,
        outcome:'completed',savedWorkVerified:true,accountsVerified:true,recoveryVerified:true,healthVerified:true}),
      'full-original-result-bytes-invalid');
  }
  return proof;
}

export function createFullInstalledIdentityObserver({ transport, startupReview, hostConfig, storeReceipt, run = runInstallTransport }) {
  const options = { transport, startupReview, hostConfig };
  const binding = (context, completed) => {
    need(typeof storeReceipt === 'function', 'full-identity-private-receipt-store-required');
    const target = releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport, { maximum: 65536 })));
    readEvidenceFile(target.sshConfig, { maximum: 65536 });
    return { target, request: originalInstalledIdentityRequest(context, completed, options) };
  };
  const diagnose = (context, completed, raw, reason, state) => {
    const diagnostic = { format: 1, kind: 'private-full-installed-identity-failure', operationId: context.descriptor.operation.id,
      jobId: completed.output.jobId, reason, uncertain: raw.uncertain === true, exitCode: raw.exitCode ?? null,
      stdout: String(raw.stdout ?? '').slice(0, 131072), stderr: String(raw.stderr ?? '').slice(0, 131072) };
    const data = bytes(diagnostic), receipt = storeReceipt(context.journal, context.intent.key, `full-identity-failure-${sha256(data)}.json`, data);
    return { state, reason, externalId: completed.externalId, receipt, output: { ...completed.output, identityObserved: false } };
  };
  return {
    observe: async (context, completed) => {
      let target, request;
      try { ({ target, request } = binding(context, completed)); }
      catch (error) { return diagnose(context, completed, {}, safeReason(error), 'failed'); }
      let raw;
      try { raw = await run(target, buildInstalledIdentityProgram(request), { captureDiagnostics: true }); }
      catch { raw = { uncertain: true, stdout: '', stderr: '' }; }
      let value; try { value = JSON.parse(raw.stdout); } catch {}
      if (raw.uncertain || raw.exitCode !== 0 || value?.ok !== true || !Object.hasOwn(value, 'value'))
        return diagnose(context, completed, raw, 'full-original-installed-identity-unavailable', 'uncertain');
      let proof;
      try { proof = verifyInstalledIdentity(value.value, request); }
      catch (error) { return diagnose(context, completed, raw, safeReason(error), 'failed'); }
      // Re-observation is read-only. A lost response cannot replace previously
      // captured identity: the existing receipt store accepts identical bytes only.
      let receipt;
      try { receipt = storeReceipt(context.journal, context.intent.key, 'full-installed-identity.json', bytes(proof)); }
      catch (error) { return diagnose(context, completed, raw, safeReason(error), 'failed'); }
      return { ...completed, reason: 'original-installation-identity-observed',
        output: { ...completed.output, acceptanceIdentity: proof, acceptanceIdentityReceipt: receipt } };
    },
    verify: async (value, context) => {
      if (value.state !== 'completed') return;
      const { request } = binding(context, value), receipt = value.output.acceptanceIdentityReceipt;
      need(receipt && equal(JSON.parse(readEvidenceFile(receipt, { maximum: 1024 * 1024 })), value.output.acceptanceIdentity),
        'full-retained-installed-identity-changed');
      verifyInstalledIdentity(value.output.acceptanceIdentity, request);
    },
  };
}
