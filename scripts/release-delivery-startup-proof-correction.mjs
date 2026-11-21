import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual as same } from 'node:util';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import {
  buildStartupRetainedProgram, RETAINED_WINDOW_STARTUP_SOURCES, reviewedStartupSources,
  startupRetainedRequest, verifyStartupRetainedProjection,
} from './release-delivery-startup-retained.mjs';

export const startupCorrectionRequest = 'nova-prepackage-startup-proof-request';
export const startupCorrectionGrant = 'nova-prepackage-startup-proof-correction';
export const startupCorrectionBranch = 'operator/prepackage-startup-proof';
export const startupCorrectionEvent = 'prepackage-startup-proof-corrected';
const require = createRequire(import.meta.url);
const refusal = 'actual-startup-proof-observation-unavailable';
const need = (ok, reason) => { if (!ok) throw Error(reason); };
const load = ref => JSON.parse(readEvidenceFile(ref, {maximum: 2 * 1024 ** 2}));

// The read-only Python exception was complete. The SSH adapter reports an
// empty-stdout/nonzero exit as uncertain; the local delivery child records rc=1.
const trace = /^Traceback \(most recent call last\):\n  File "<stdin>", line \d+, in <module>\n  File "fixed-startup-retained-consumer", line \d+, in invoke\n  File "fixed-startup-retained-consumer", line \d+, in consume\n  File "fixed-startup-retained-consumer", line \d+, in parked_seed_antecedent\n  File "fixed-startup-retained-consumer", line \d+, in read_split_warm_donor\n  File "fixed-startup-retained-consumer", line \d+, in need\nRuntimeError: unrelated-or-unchanged-combined-helper\n$/;

export function originalStartupFailure({journal, descriptor, target, failure, status, exit, closed, createdAt, now}) {
  const id = descriptor.operation.id, dependency = target.full?.dependencyTransport;
  need(descriptor.operation.version === '2.28.50' && descriptor.operation.buildVersion === '1.0.423'
    && descriptor.operation.changeClass === 'application' && target.full?.host?.priorVersion === '2.28.39'
    && target.full.host.priorBuildVersion === '1.0.412' && dependency?.format === 6
    && same(reviewedStartupSources(dependency.startupQualification.producer), RETAINED_WINDOW_STARTUP_SOURCES),
  'startup-correction-release-family-changed');
  need(same(status, {kind:'nova-release-delivery-error', reason:refusal, automaticReplayPermitted:false})
    && closed.originalChildClosed === true && closed.returnCode === 1 && closed.logBoundExceeded === false
    && closed.automaticNewOperationPermitted === false && exit.returnCode === 1
    && Number.isSafeInteger(exit.finishedAtMilliseconds) && exit.finishedAtMilliseconds <= now,
  'startup-correction-original-terminal-refusal-required');
  need(failure.path === join(journal.directory, 'delivery-evidence', id + '-startup-failure-' + failure.sha256 + '.json'),
    'startup-correction-original-receipt-location-changed');
  const v = load(failure), stderr = Buffer.from(v.stderrRawBase64, 'base64');
  need(v.format === 1 && v.kind === 'operator-startup-transport-failure' && v.operationId === id
    && v.reason === refusal && v.exitCode === null && v.uncertain === true && v.hostWrites === false
    && v.diagnosticsTruncated === false && v.stdoutTruncated === false && v.stderrTruncated === false
    && v.stdoutBytes === 0 && v.stdoutRawBase64 === '' && stderr.length <= 4096 && stderr.length === v.stderrBytes
    && stderr.toString('base64') === v.stderrRawBase64 && trace.exec(stderr.toString('utf8'))?.[0] === stderr.toString('utf8')
    && Number.isSafeInteger(v.receivedAtMilliseconds) && v.receivedAtMilliseconds >= createdAt
    && v.receivedAtMilliseconds <= exit.finishedAtMilliseconds && same(v.transport, target.transport)
    && /^[a-f0-9]{64}$/.test(v.programSha256), 'startup-correction-original-native-refusal-required');
  return v;
}

// The caller has verified the original graph and its Git blobs in both repos.
// Generate the old read-only program locally; never repeat its host operation.
export function verifyOriginalStartupProgram(originalRows, root, options, failure, descriptor) {
  need(resolve(root) === resolve(descriptor.sources.private.root,'edition3'), 'startup-correction-historical-root-changed');
  for (const name of ['release-delivery-startup-retained.mjs', 'release-startup-retained-proof.py']) {
    const row = originalRows.find(r => r.name === name);
    need(row, 'startup-correction-historical-reader-required');
    readEvidenceFile({path:join(root,'scripts',name),sha256:row.sha256},{maximum:2*1024**2});
  }
  const old = require(join(root,'scripts','release-delivery-startup-retained.mjs'));
  const request = old.startupRetainedRequest(options);
  need(same(request,startupRetainedRequest(options)) && sha256(old.buildStartupRetainedProgram(request)) === failure.programSha256
    && sha256(buildStartupRetainedProgram(request)) !== failure.programSha256, 'startup-correction-original-program-changed');
}

export function verifyCorrectedStartupProof({journal, descriptor, target, prior, reference, since, now}) {
  need(reference.path === join(journal.directory,'delivery-continuation-evidence','startup-proof-'+reference.sha256+'.json'),
    'startup-correction-proof-location-changed');
  const record = load(reference), request = startupRetainedRequest(target.full.dependencyTransport.startupQualification);
  const raw = Buffer.from(record.stdoutRawBase64,'base64');
  need(record.format === 1 && record.kind === 'verified-operator-startup-proof' && record.operationId === descriptor.operation.id
    && same(record.transport,target.transport) && record.programSha256 === sha256(buildStartupRetainedProgram(request))
    && raw.length <= 131072 && raw.toString('base64') === record.stdoutRawBase64 && sha256(raw) === record.stdoutSha256
    && Number.isSafeInteger(record.receivedAtMilliseconds) && record.receivedAtMilliseconds >= since && record.receivedAtMilliseconds <= now,
  'startup-correction-current-response-changed');
  const parsed = JSON.parse(raw);
  need(parsed.ok === true && Number.isSafeInteger(parsed.value?.observedAtMilliseconds)
    && parsed.value.observedAtMilliseconds >= since-30000 && parsed.value.observedAtMilliseconds <= record.receivedAtMilliseconds+30000,
  'startup-correction-current-observation-required');
  const proof = verifyStartupRetainedProjection(parsed.value,request), b = proof.qualificationBinding;
  const op = descriptor.operation, route = prior.route;
  need(route.route === 'full' && route.baseCandidateId === op.priorCandidateId && b.prior.candidateId === route.baseCandidateId
    && b.workspaceEpoch === op.workspaceEpoch && same(b.sourceCommits,op.sourceCommits), 'startup-correction-original-candidate-changed');
  for (const [side, id] of [['private',route.targetCandidateId],['public',route.publicCandidateId]]) {
    const artifact = prior.artifacts.repositories[side], qualified = b.targets[side];
    need(qualified.candidateId === id && artifact.candidateId === id && qualified.version === op.version
      && qualified.buildVersion === op.buildVersion && qualified.archiveSha256 === artifact.archive.sha256
      && qualified.ciSourceSha256 === artifact.ciSourceReceipt.sha256, 'startup-correction-original-candidate-changed');
  }
  return proof;
}
