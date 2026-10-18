/** Fixed signed frontend publication bridge. Production registration stays closed
 * until the host prerequisite and acceptance producers are independently qualified. */
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { frontendRegular, validateFrontendManifest } from './frontend-contract.mjs';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { verificationOnce, verificationEffect } from './release-verification-pass.mjs';

const need = (v, why) => { if (!v) throw Error(why); };
const roles = ['archive', 'manifest', 'signature'];
const extensions = { archive: 'tgz', manifest: 'json', signature: 'sig' };
export const frontendPublicationHelpers = () => Object.fromEntries([
  'release-delivery-frontend.py', 'release-frontend-publication-primitives.py',
  'release-frontend-github-primitives.py', 'release-delivery-ci.py', 'release-ci-primitives.py',
].map(name => [name, sha256(readFileSync(new URL(name, import.meta.url)))]));

export function frontendPublicationInput({ descriptor, prior, tools, releaseIds }) {
  need(prior.route?.route === 'frontend' && prior.sign?.route === 'frontend', 'frontend-publication-route-required');
  need(isDeepStrictEqual(prior.sign.manifest, prior.package?.manifest) && isDeepStrictEqual(prior.sign.archive, prior.package?.archive), 'signed-package-input-changed');
  return { format: 1, operationId: descriptor.operation.id, version: descriptor.operation.version,
    buildVersion: descriptor.operation.buildVersion, sourceCommits: Object.fromEntries(['private', 'public'].map(side => [side, descriptor.sources[side].commit])),
    baseCandidateId: descriptor.operation.priorCandidateId, serviceInputsSha256: prior.route.serviceInputsSha256,
    trustedPublicKeySha256: descriptor.operation.trustedPublicKeySha256, signed: prior.sign,
    tools, releaseIds, helperHashes: frontendPublicationHelpers() };
}

const publicationNamespace = {};
export function verifyFrontendPublicationInput(input, descriptor, { admission = false } = {}, context = {}) {
  const checked = verificationOnce(context, publicationNamespace, { input, descriptor, directory: context.journal?.directory ?? null }, () => {
  need(input.operationId === descriptor.operation.id && input.version === descriptor.operation.version && input.buildVersion === descriptor.operation.buildVersion
    && input.baseCandidateId === descriptor.operation.priorCandidateId && input.trustedPublicKeySha256 === descriptor.operation.trustedPublicKeySha256,
  'frontend-publication-operation-changed');
  for (const side of ['private', 'public']) need(input.sourceCommits[side] === descriptor.sources[side].commit
    && Number.isSafeInteger(input.releaseIds[side]) && input.releaseIds[side] > 0, 'frontend-publication-source-changed');
  need(isDeepStrictEqual(input.helperHashes, frontendPublicationHelpers()), 'frontend-publication-helper-changed');
  for (const name of ['git', 'python', 'node']) readEvidenceFile(input.tools[name], { maximum: 128 * 1024 ** 2 });
  const manifestRaw = readEvidenceFile(input.signed.manifest, { maximum: 128 * 1024 });
  const manifest = validateFrontendManifest(JSON.parse(manifestRaw), { admission: false });
  const archive = readEvidenceFile(input.signed.archive, { maximum: 128 * 1024 ** 2 });
  const signature = readEvidenceFile(input.signed.signature, { maximum: 64 });
  const key = createPublicKey(readEvidenceFile(input.signed.publicKey, { maximum: 16384 }));
  need(input.signed.publicKey.sha256 === input.trustedPublicKeySha256 && key.asymmetricKeyType === 'ed25519'
    && signature.length === 64 && verify(null, manifestRaw, key, signature), 'frontend-publication-signature-invalid');
  need(manifest.base.candidateId === input.baseCandidateId && manifest.base.serviceInputsSha256 === input.serviceInputsSha256
    && manifest.sourceRevision === input.sourceCommits.private && manifest.frontendVersion === input.version && manifest.frontendBuildVersion === input.buildVersion
    && manifest.frontendId === input.signed.frontendId && manifest.sequence === input.signed.sequence
    && manifest.artifact.sha256 === sha256(archive) && manifest.artifact.bytes === archive.length, 'frontend-publication-contract-changed');
  need(manifest.artifact.url === `https://github.com/HatimTheDream/Nova-Dream-Public/releases/download/v${input.version}/nova-${input.version}-frontend.tgz`, 'frontend-publication-origin-changed');
  return { manifest, specs: roles.map(role => ({ role, name: `nova-${input.version}-frontend.${extensions[role]}`, ...input.signed[role],
    bytes: role === 'archive' ? archive.length : role === 'manifest' ? manifestRaw.length : signature.length })) };
  });
  // Time-sensitive admission is always evaluated at the actual call time.
  validateFrontendManifest(checked.manifest, { admission });
  return structuredClone(checked.specs);
}

export function createFrontendPublicationAdapter({ tools, releaseIds, command, storeReceipt }) {
  const expected = ({ descriptor, prior }) => frontendPublicationInput({ descriptor, prior, tools, releaseIds });
  const validate = context => {
    need(isDeepStrictEqual(context.input, expected(context)), 'frontend-publication-input-changed');
    return verifyFrontendPublicationInput(context.input, context.descriptor, {}, context);
  };
  const run = async context => {
    const input = context.intent.input, specs = verifyFrontendPublicationInput(input, context.descriptor, {}, context), assets = [];
    // The aggregate may be durable even when its parent observation was lost.
    // Preserve its original readback paths instead of rewriting it with new ones.
    const retained = retainedFrontendPublication(context, specs, releaseIds);
    if (retained) return retained;
    for (const spec of specs) {
      const outputDirectory = join(context.journal.directory, `frontend-publication-${context.intent.key}-${spec.role}`);
      // A prior dispatch, even one without a response, is observation only.
      // New asset intents may continue the original parent after interruption.
      const original = join(outputDirectory, 'dispatch.json'), mode = existsSync(original) ? 'observe' : 'execute';
      if (mode === 'execute') {
        need(typeof context.beforeNewEffect === 'function', 'frontend-fresh-prerequisite-verification-required');
        await context.beforeNewEffect(); verifyFrontendPublicationInput(input, context.descriptor, { admission: true });
      }
      const request = { ...input, key: context.intent.key, inputSha256: context.intent.inputSha256, spec,
        outputDirectory, ledgerDirectory: fileURLToPath(new URL('../frontend-publication-ledger', import.meta.url)) };
      const bytes = Buffer.from(JSON.stringify(request) + '\n');
      const ref = storeReceipt(context.journal, context.intent.key, `frontend-${spec.role}-request.json`, bytes);
      const response = JSON.parse(await command(tools.python.path, ['-B', fileURLToPath(new URL('release-delivery-frontend.py', import.meta.url)), mode,
        '--request', ref.path, '--request-sha256', ref.sha256], { maximum: 1024 ** 2, timeoutMs: 600000, acceptJsonFailure: true, gitExecPath: tools.gitExecPath }));
      need(response.externalId === `${releaseIds.public}:${context.intent.key}`, 'frontend-publication-external-id-changed');
      if (response.state !== 'completed') return response;
      verifyAsset(response.output, spec, context); assets.push(response.output);
    }
    const output = { kind: 'nova-delivery-frontend-publication', operationId: input.operationId, key: context.intent.key,
      inputSha256: context.intent.inputSha256, frontendId: input.signed.frontendId, releaseIds, assets,
      hostEffects: false, savedReplyAccepted: false, browserAccepted: false };
    const bytes = Buffer.from(JSON.stringify(output) + '\n'), receipt = storeReceipt(context.journal, context.intent.key, 'frontend-publication.json', bytes);
    return { state: 'completed', reason: 'signed-frontend-assets-published', externalId: `${releaseIds.public}:${context.intent.key}`, receipt, output };
  };
  // Both paths can continue a never-started asset effect; no read-only cache
  // may survive a publication write or an uncertain/lost response.
  const advance = context => verificationEffect(context, run);
  return { input: async context => expected(context), validate, execute: advance, observe: advance,
    verify: async (result, context) => {
      if (result.externalId) need(result.externalId === `${releaseIds.public}:${context.intent.key}`, 'frontend-publication-external-id-changed');
      if (result.state !== 'completed') return;
      const specs = verifyFrontendPublicationInput(context.intent.input, context.descriptor, {}, context);
      verifyPublicationResult(result, context, specs, releaseIds);
    } };
}

function verifyPublicationResult(result, context, specs, releaseIds) {
  const out = result.output;
  need(isDeepStrictEqual(JSON.parse(readEvidenceFile(result.receipt)), out) && out.kind === 'nova-delivery-frontend-publication'
    && out.operationId === context.descriptor.operation.id && out.key === context.intent.key && out.inputSha256 === context.intent.inputSha256
    && out.frontendId === context.intent.input.signed.frontendId && isDeepStrictEqual(out.releaseIds, releaseIds)
    && out.hostEffects === false && out.savedReplyAccepted === false && out.browserAccepted === false && out.assets.length === 3, 'frontend-publication-result-changed');
  specs.forEach((spec, i) => verifyAsset(out.assets[i], spec, context));
}

/** Reads only a producer's original deterministic aggregate. It is never a
 * standalone admission: run/verify revalidate signed inputs before calling. */
export function retainedFrontendPublication(context, specs, releaseIds) {
  const path = join(context.journal.directory, 'delivery-evidence', `${context.intent.key}-frontend-publication.json`);
  if (!existsSync(path)) return null;
  const bytes = frontendRegular(path, 1024 ** 2), receipt = { path, sha256: sha256(bytes) }, output = JSON.parse(bytes);
  const result = { state: 'completed', reason: 'signed-frontend-assets-published', externalId: `${releaseIds.public}:${context.intent.key}`, receipt, output };
  verifyPublicationResult(result, context, specs, releaseIds); return result;
}

function verifyAsset(value, spec, context) {
  need(value?.operationId === context.descriptor.operation.id && value.key === context.intent.key && value.inputSha256 === context.intent.inputSha256
    && value.role === spec.role && value.asset?.name === spec.name && value.asset.bytes === spec.bytes && value.asset.sha256 === spec.sha256
    && Number.isSafeInteger(value.asset.id) && value.asset.id > 0 && value.asset.authenticatedDownloadVerified === true, 'frontend-published-asset-changed');
  const expected = join(context.journal.directory, `frontend-publication-${context.intent.key}-${spec.role}`);
  const local = relative(expected, value.asset.localPath).replaceAll('\\', '/');
  need(new RegExp(`^(first|observe-[a-f0-9-]{36})/0-readback/${spec.name.replaceAll('.', '\\.')}$$`).test(local), 'frontend-readback-path-changed');
  readEvidenceFile({ path: value.asset.localPath, sha256: spec.sha256 }, { maximum: 128 * 1024 ** 2 });
}
