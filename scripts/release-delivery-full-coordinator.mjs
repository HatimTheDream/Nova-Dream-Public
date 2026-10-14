/** Derive the existing coordinator's input from verified producer outputs.
 * No install dispatch, manually asserted gate, new journal or replacement plan. */
import { isDeepStrictEqual as equal } from 'node:util';
import { join } from 'node:path';
import { normalizeCoordinatorDescriptor } from './release-coordinate.mjs';
import { describeInstallAdapter, releaseInstallSpecSchema } from './release-adapters.mjs';
import { planRelease, readEvidenceFile, sha256, validateOperationContinuation } from './release-plan.mjs';
import { verifyCandidate } from './candidate.mjs';
import { verifyRetainedCandidate } from './release-delivery-package.mjs';

const need = (v, reason) => { if (!v) throw Error(reason); };
const canonical = v => JSON.stringify(v, (_k,x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k,x[k]])) : x);
const bytes = v => Buffer.from(canonical(v) + '\n');
const packaged = ['install.py','recovery.py','codex_log_retention.py','app_dependencies.py','workspace_key.py','verify-session-bindings.mjs'];

export function buildFullCoordinatorDescriptor(context, verifiedPublication, { transport, base, storeReceipt, clock = Date.now }) {
  const { descriptor, prior, journal, intent } = context, source = descriptor.operation;
  need(prior.route?.route === 'full' && prior.package?.route === 'full' && prior.sign?.route === 'full', 'full-coordinator-verified-route-required');
  const candidates = Object.fromEntries(['private','public'].map(side => [side,
    verifyRetainedCandidate(prior.artifacts.repositories[side], descriptor.sources[side])]));
  need(base.manifest.path === join(base.directory,'dist','candidate.json'), 'full-coordinator-base-path-changed');
  readEvidenceFile(base.manifest); const selected = verifyCandidate(base.directory);
  need(selected.id === base.candidateId && selected.id === source.priorCandidateId
    && candidates.private.id === prior.route.targetCandidateId && candidates.public.id === prior.route.publicCandidateId,
  'full-coordinator-candidate-changed');
  need(prior.package.candidateId === candidates.private.id && prior.package.publicCandidateId === candidates.public.id
    && prior.package.priorCandidateId === selected.id && equal(prior.package.sourceCommits, source.sourceCommits)
    && prior.sign.bundle.sha256 === prior.package.bundle.sha256, 'full-coordinator-package-changed');
  const raw = readEvidenceFile(prior.package.bundle, { maximum: 128 * 1024 ** 2 }), bundle = JSON.parse(raw);
  const metadata = JSON.parse(readEvidenceFile(prior.package.bundleMetadata));
  need(metadata.sha256 === sha256(raw) && metadata.bytes === raw.length && bundle.format === 1 && Array.isArray(bundle.files),
    'full-coordinator-bundle-changed');
  const entries = new Map();
  for (const item of bundle.files) {
    need(typeof item.name === 'string' && !entries.has(item.name) && typeof item.data === 'string', 'full-coordinator-bundle-entry-invalid');
    const content = Buffer.from(item.data,'base64');
    need(content.toString('base64') === item.data && sha256(content) === item.sha256, 'full-coordinator-bundle-entry-changed');
    entries.set(item.name, { bytes: content, sha256: item.sha256 });
  }
  need([...packaged,'app.tgz','reviewed-pair.json'].every(name => entries.has(name)), 'full-coordinator-bundle-incomplete');
  const helperHashes = Object.fromEntries(packaged.map(name => [name,entries.get(name).sha256]));
  const recovery = prior.recovery.evidence, review = JSON.parse(readEvidenceFile(recovery.review));
  helperHashes['operator_rehearsal.py'] = prior.recovery.helperHashes?.['operator_rehearsal.py'];
  need(equal(helperHashes, prior.recovery.helperHashes) && equal(helperHashes, review.helperHashes), 'full-coordinator-rehearsal-helpers-changed');
  for (const side of ['private','public']) for (const [name,digest] of Object.entries(helperHashes))
    need(prior.artifacts.repositories[side].sourceHashes?.['deploy/update-runner/'+name]?.sha256 === digest,
      'full-coordinator-authenticated-helper-changed');
  const operation = { ...source, stage: 'frozen', candidateId: candidates.private.id, publicCandidateId: candidates.public.id,
    bundleSha256: prior.package.bundle.sha256, helperHashes };
  validateOperationContinuation(operation, source);
  need(candidates.private.manifest.version === operation.version && candidates.private.manifest.buildVersion === operation.buildVersion,
    'full-coordinator-target-version-changed');
  const packageReview = { format: 1, candidateId: operation.candidateId, publicCandidateId: operation.publicCandidateId,
    sourceCommits: { 'Nova-Dream': operation.sourceCommits.private, 'Nova-Dream-Public': operation.sourceCommits.public },
    bundleSha256: operation.bundleSha256, archiveSha256: entries.get('app.tgz').sha256 };
  const save = (name,value) => storeReceipt(journal,intent.key,name,bytes(value));
  const packageEvidence = { review: save('full-package-review.json',packageReview), bundle: prior.package.bundle };
  need(equal(verifiedPublication.evidence.feed,prior.sign.signedFeed) && equal(verifiedPublication.evidence.publicKey,prior.sign.publicKey),
    'full-coordinator-published-signature-changed');
  const now = clock(), timeline = journal.deliveryTimeline(source.id,now).timeline;
  const input = { format: 1, operation, timeline, evidence: {
    'private-ci': { receipt: prior['private-ci'].receipt, log: prior['private-ci'].log },
    'public-ci': { receipt: prior['public-ci'].receipt, log: prior['public-ci'].log },
    package: packageEvidence, capacity: verifiedPublication.capacityEvidence, recovery,
    publication: verifiedPublication.evidence } };
  const plan = planRelease(input,{nowMs:now});
  need(['private-ci','public-ci','package','capacity','recovery','publication'].every(name => plan.phases.find(p => p.id === name)?.state === 'passed'),
    'full-coordinator-preparation-not-qualified');
  need(plan.eta.dueReviews.length === 0 && plan.eta.suspendNewAttemptsFor.length === 0, 'full-coordinator-overrun-review-required');
  const spec = releaseInstallSpecSchema.parse({ format: 1, operationId: source.id,
    ...Object.fromEntries(['candidateId','priorCandidateId','workspaceEpoch','version','buildVersion','agentVersion','priorAgentVersion','bundleSha256'].map(k => [k,operation[k]])),
    priorVersion: selected.manifest.version, priorBuildVersion: selected.manifest.buildVersion,
    schemaVersion: candidates.private.manifest.schemaVersion, apiVersion: candidates.private.manifest.apiVersion,
    rehearsalLeaseId: review.leaseId, rehearsalProofSha256: recovery.proof.sha256 });
  const coordinator = normalizeCoordinatorDescriptor({ format: 1, input, adapter: { transport, installSpec: save('full-install-spec.json',spec) } });
  const described = describeInstallAdapter({ ...coordinator.adapter, operation, input: coordinator.input });
  need(described.scopeIdentity === descriptor.targetIdentity, 'full-coordinator-target-changed');
  return coordinator;
}
