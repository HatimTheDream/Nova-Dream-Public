/** Restricted recovery of the nativeInput envelope before package reservation. */
import { join, resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { readEvidenceFile } from './release-plan.mjs';
import { dependencyPackReceiptSchema, verifyQualifiedApplicationDependencies } from './release-delivery-qualified-dependencies.mjs';

export const correctionRequestKind = 'nova-prepackage-dependency-correction-request';
export const correctionGrantKind = 'nova-prepackage-dependency-correction';
export const correctionBranch = 'operator/prepackage-dependency-correction';
export const graphRefusal = 'selected-native-dependency-graph-changed';
const need = (ok, reason) => { if (!ok) throw Error(reason); };
const load = ref => JSON.parse(readEvidenceFile(ref, { maximum: 2 * 1024 ** 2 }));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.object({ path: z.string().min(1).max(4096), sha256: digest }).strict();
export const dependencyCorrectionSchema = z.object({originalNativeInput: file, correctedNativeInput: file}).strict();
const envelope = z.object({
  format: z.literal(1), kind: z.literal('metadata-only-dependency-successor'),
  helper:file, oldArchive:file, oldMetadata:file, nativeReceipt:file, acceptedPair:file, acceptedInstaller:file, acceptedBundle:file,
  acceptedCandidate:digest, targetPackage:file, targetLock:file,
  transition:z.object({fromVersion:z.string(),fromBuild:z.string(),toVersion:z.string(),toBuild:z.string()}).strict()
}).strict();

export function requireCorrectionExit(status, exit, closed, now) {
  need(same(status, {kind:'nova-release-delivery-error',reason:graphRefusal,automaticReplayPermitted:false})
    && closed.originalChildClosed === true && closed.returnCode === 1 && closed.logBoundExceeded === false
    && closed.automaticNewOperationPermitted === false && exit.returnCode === 1
    && Number.isSafeInteger(exit.finishedAtMilliseconds) && exit.finishedAtMilliseconds <= now,
    'dependency-correction-original-terminal-refusal-required');
}

/** Only this single field is projected. All identities and downstream checks keep using the original descriptor. */
export function correctedDependencyTarget(target, descriptor, prior, rawCorrection) {
  if (!rawCorrection) return target;
  const correction=dependencyCorrectionSchema.parse(rawCorrection), dep=target.full?.dependencyTransport;
  need(dep?.format===6 && same(dep.nativeInput,correction.originalNativeInput)
    && correction.originalNativeInput.sha256!==correction.correctedNativeInput.sha256,
    'dependency-correction-original-envelope-changed');
  const replacement=envelope.parse(load(correction.correctedNativeInput)), legacy=load(correction.originalNativeInput);
  const pair=load(dep.selectedPair), old=load(replacement.oldMetadata), execution=dependencyPackReceiptSchema.parse(load(replacement.nativeReceipt));
  const qualified=load(dep.qualifiedDependencies.metadata), targetExec=dependencyPackReceiptSchema.parse(load(dep.qualifiedDependencies.execution));
  const art=prior.artifacts?.repositories?.private;
  need(art && prior.route?.route==='full' && prior.route.baseCandidateId===descriptor.operation.priorCandidateId
    && replacement.acceptedCandidate===pair.candidateId && pair.candidateId===descriptor.operation.priorCandidateId
    && same(replacement.acceptedPair,dep.selectedPair) && same(replacement.acceptedBundle,dep.selectedBundle)
    && same(replacement.acceptedInstaller,dep.selectedInstaller) && same(replacement.helper,dep.helper),
    'dependency-correction-accepted-selection-changed');
  need(legacy.kind==='metadata-only-dependency-successor' && load(legacy.oldMetadata).dependencyGraphSha256!==pair.applicationDependencies.dependencyGraphSha256
    && same(old,pair.applicationDependencies) && old.platform==='linux' && old.arch==='x64' && old.nodeVersion==='22.23.2' && old.nodeAbi===127
    && old.archiveSha256===replacement.oldArchive.sha256 && old.dependencyGraphSha256===qualified.dependencyGraphSha256,
    'dependency-correction-original-and-accepted-graphs-required');
  const binding=pair.startupQualification?.binding, accepted=binding?.targets.private;
  need(binding && same(binding.applicationDependencies,old) && binding.dependencyGraphSha256===old.dependencyGraphSha256
    && accepted.candidateId===pair.candidateId && accepted.packageSha256===execution.source.packageSha256
    && accepted.packageLockSha256===execution.source.packageLockSha256 && binding.runtime.node===execution.node.path
    && binding.runtime.nodeSha256===execution.node.sha256,'dependency-correction-original-native-source-changed');
  for (const [record,metadata,refs] of [[execution,old,{metadata:replacement.oldMetadata,archive:replacement.oldArchive}],
                                        [targetExec,qualified,dep.qualifiedDependencies]]) {
    need(record.format===1 && record.kind==='qualified-application-dependency-pack' && record.execution?.exitCode===0
      && record.producerSha256===dep.helper.sha256 && record.metadataSha256===refs.metadata.sha256
      && same(record.description,metadata) && same(record.archive,{bytes:metadata.archiveBytes,sha256:refs.archive.sha256})
      && record.source?.dependencyGraphSha256===metadata.dependencyGraphSha256 && record.source.packageLockSha256===metadata.packageLockSha256
      && record.source.inventoryBeforeSha256===record.source.inventoryAfterSha256 && digest.safeParse(record.source.inventoryBeforeSha256).success,
      'dependency-correction-native-execution-changed');
  }
  need(same(replacement.transition,{fromVersion:target.full.host.priorVersion,fromBuild:target.full.host.priorBuildVersion,
    toVersion:descriptor.operation.version,toBuild:descriptor.operation.buildVersion})
    && resolve(replacement.targetPackage.path)===join(art.applicationDirectory,'package.json')
    && resolve(replacement.targetLock.path)===join(art.applicationDirectory,'package-lock.json')
    && replacement.targetPackage.sha256===targetExec.source.packageSha256 && replacement.targetLock.sha256===targetExec.source.packageLockSha256,
    'dependency-correction-target-artifacts-changed');
  // The maintained package adapter hashes the archives and validates the entire
  // candidate, dependency/runtime metadata and startup proof before reservation.
  return {...target,full:{...target.full,dependencyTransport:{...dep,nativeInput:correction.correctedNativeInput}}};
}

export function correctionForPhase(journal, operationId) {
  const proof=journal?.deliveryOperatorContinuation?.(operationId)?.proof;
  return proof?.kind===correctionGrantKind ? proof.correction : undefined;
}

/** Export a qualified accepted pack as the starting basis for a later release. */
export function acceptedDependencyBasis({transport,accepted,sign,base,packageRef,lockRef}) {
  const pair=load(accepted.pair),binding=pair.startupQualification?.binding,selected=binding?.targets.private;
  const deps=sign.dependencies,refs=transport.qualifiedDependencies;
  need(pair.candidateId===base.candidateId && sign.candidateId===base.candidateId && selected?.candidateId===base.candidateId
    && same(sign.bundle,accepted.bundle) && deps.newNativeDependenciesQualified===true && deps.unchangedNativeDependencies===false
    && same(deps.execution,deps.qualification) && same(refs,{archive:deps.archive,metadata:deps.metadata,execution:deps.execution})
    && packageRef.path===join(base.directory,'package.json') && lockRef.path===join(base.directory,'package-lock.json')
    && selected.packageSha256===packageRef.sha256 && selected.packageLockSha256===lockRef.sha256,'successor-accepted-native-pack-changed');
  const verified=verifyQualifiedApplicationDependencies(refs,binding,{
    producerSha256:transport.helper.sha256,packageSha256:packageRef.sha256,packageLockSha256:lockRef.sha256
  });
  need(same(verified.description,pair.applicationDependencies) && same(verified.description,deps.description),'successor-signed-native-description-changed');
  // No future version is known yet. At preparation the producer supplies the new
  // target version and retains this installation as the "from" side.
  return envelope.parse({format:1,kind:'metadata-only-dependency-successor',helper:transport.helper,
    oldArchive:refs.archive,oldMetadata:refs.metadata,nativeReceipt:refs.execution,
    acceptedPair:accepted.pair,acceptedInstaller:accepted.result,acceptedBundle:accepted.bundle,acceptedCandidate:base.candidateId,
    targetPackage:packageRef,targetLock:lockRef,transition:{fromVersion:selected.version,fromBuild:selected.buildVersion,
      toVersion:selected.version,toBuild:selected.buildVersion}});
}
