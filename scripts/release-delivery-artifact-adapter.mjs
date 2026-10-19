import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
const need = (v, code) => { if (!v) throw Error(code); };
const helperNames = ['release-delivery-artifacts.py', 'release-artifact-primitives.py'];
const helperHashes = () => Object.fromEntries(helperNames.map(name => [name, sha256(readFileSync(new URL(name, import.meta.url)))]));

export function createArtifactAdapter({ tools, command, storeReceipt }) {
  const validate = ({ descriptor, input }) => {
    need(input.operationId === descriptor.operation.id && input.version === descriptor.operation.version && input.buildVersion === descriptor.operation.buildVersion, 'artifact-operation-changed');
    for (const side of ['private', 'public']) need(input.sources[side].commit === descriptor.sources[side].commit && input.ci[side].sourceCommit === descriptor.sources[side].commit
      && Number.isSafeInteger(input.ci[side].runId) && Number.isSafeInteger(input.ci[side].runAttempt)
      && input.ci[side].transport === (side === 'private' ? 'private-release-asset' : 'actions-artifact')
      && (side !== 'private' || Number.isSafeInteger(input.ci[side].releaseId) && input.ci[side].releaseId > 0), 'artifact-ci-input-changed');
    for (const [name, digest] of Object.entries(helperHashes())) need(input.helperHashes[name] === digest, 'artifact-helper-changed');
    for (const name of ['git', 'node', 'python']) readEvidenceFile(input.tools[name], { maximum: 128 * 1024 ** 2 });
  };
  const invoke = mode => async context => {
    const { intent, journal } = context;
    const request = { format: 1, ...intent.input, key: intent.key, inputSha256: intent.inputSha256, outputDirectory: join(journal.directory, `delivery-artifacts-${intent.key}`) };
    const bytes = Buffer.from(JSON.stringify(request) + '\n');
    let ref;
    if (mode === 'execute') ref = storeReceipt(journal, intent.key, 'artifacts-request.json', bytes);
    else {
      ref = { path: join(journal.directory, 'delivery-evidence', `${intent.key}-artifacts-request.json`), sha256: sha256(bytes) };
      readEvidenceFile(ref);
    }
    const raw = await command(intent.input.tools.python.path, ['-B', fileURLToPath(new URL('release-delivery-artifacts.py', import.meta.url)), mode, ref.path], { maximum: 2 * 1024 ** 2, timeoutMs: 600000, acceptJsonFailure: true });
    return JSON.parse(raw);
  };
  return { input: async ({ descriptor, prior }) => ({ operationId: descriptor.operation.id, version: descriptor.operation.version, buildVersion: descriptor.operation.buildVersion,
    sources: descriptor.sources, ci: Object.fromEntries(['private', 'public'].map(side => { const ci = prior[`${side}-ci`]; need(ci, 'canonical-ci-result-required');
      return [side, { sourceCommit: ci.sourceCommit, runId: ci.runId, runAttempt: ci.runAttempt,
        transport: side === 'private' ? 'private-release-asset' : 'actions-artifact', ...(side === 'private' ? { releaseId: ci.release?.id } : {}) }]; })), tools, helperHashes: helperHashes() }),
    validate, execute: invoke('execute'), observe: invoke('observe'),
    verify: async (result, context) => {
      if (result.state !== 'completed') return;
      need(result.output?.kind === 'nova-delivery-authenticated-artifacts' && result.output.key === context.intent.key && result.output.operationId === context.descriptor.operation.id
        && result.output.inputSha256 === context.intent.inputSha256 && result.output.authenticatedGithubCollection === true && result.output.rebuilt === false, 'artifact-producer-result-changed');
      const raw = JSON.parse(readEvidenceFile(result.receipt)); need(isDeepStrictEqual(raw, result.output), 'artifact-result-receipt-changed');
      for (const side of ['private', 'public']) {
        const repo = result.output.repositories[side]; need(repo.sourceCommit === context.descriptor.sources[side].commit
          && repo.repository === context.descriptor.sources[side].repository && repo.runId === context.intent.input.ci[side].runId
          && repo.runAttempt === context.intent.input.ci[side].runAttempt, 'artifact-source-changed');
        for (const name of ['archive', 'metadata', 'ciSourceReceipt', 'zip']) readEvidenceFile(repo[name], { maximum: 128 * 1024 ** 2 });
        if (side === 'private') {
          const transport = repo.transport, receipt = JSON.parse(readEvidenceFile(transport?.receipt, { maximum: 64 * 1024 }));
          const zip = readEvidenceFile(repo.zip, { maximum: 16 * 1024 ** 2 });
          need(!Object.hasOwn(repo, 'artifactId') && transport.kind === 'private-release-asset'
            && Number.isSafeInteger(repo.releaseAssetId) && repo.releaseAssetId > 0 && repo.releaseAssetId === transport.releaseAssetId
            && transport.releaseId === context.intent.input.ci.private.releaseId && receipt.release?.id === transport.releaseId
            && transport.authenticatedDownloadVerified === true && transport.buildOrigin === 'same-run-release-job'
            && receipt.buildOrigin === transport.buildOrigin && receipt.sourceCommit === repo.sourceCommit
            && receipt.repository?.fullName === repo.repository && receipt.repository.private === true
            && receipt.run?.id === repo.runId && receipt.run?.attempt === repo.runAttempt
            && receipt.qualityJob?.id === transport.qualityJobId && receipt.producerJob?.id === transport.producerJobId
            && transport.qualityJobId !== transport.producerJobId && receipt.ciSourceSha256 === repo.ciSourceReceipt.sha256
            && receipt.archive?.sha256 === repo.zip.sha256 && receipt.archive.bytes === zip.length
            && receipt.archive.name === transport.assetName && transport.assetApiDigest === `sha256:${repo.zip.sha256}`
            && transport.zipBytes === zip.length, 'artifact-release-transport-changed');
        } else need(Number.isSafeInteger(repo.artifactId) && repo.artifactId > 0 && !Object.hasOwn(repo, 'releaseAssetId'), 'artifact-public-transport-changed');
      }
    } };
}
