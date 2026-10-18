/** Fixed frontend route/pack/sign producers. Canonical retained candidates and
 * the existing cryptographic/archive primitives remain the authority. */
import { createPublicKey, verify } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyCandidate } from './candidate.mjs';
import { packageRetained, signFrontend, frontendArchive } from './frontend-package.mjs';
import { frontendIdentity, frontendRegular, validateFrontendManifest } from './frontend-contract.mjs';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { verificationOnce, verificationEffect } from './release-verification-pass.mjs';
const need = (v, code) => { if (!v) throw Error(code); };
const result = (reason, output) => ({ state: 'completed', reason, output, receipt: null, externalId: output.frontendId ?? output.route });
const regularRef = (path, maximum) => { const bytes = frontendRegular(path, maximum); return { path, sha256: sha256(bytes) }; };

export function verifyRetainedCandidate(repository, source) {
  const metadata = JSON.parse(readEvidenceFile(repository.metadata)), receipt = JSON.parse(readEvidenceFile(repository.ciSourceReceipt));
  readEvidenceFile(repository.archive, { maximum: 128 * 1024 ** 2 });
  need(repository.sourceCommit === source.commit && receipt.sourceCommit === source.commit && receipt.repository === source.repository
    && receipt.application?.candidateId === metadata.candidateId && receipt.application?.archiveSha256 === repository.archive.sha256
    && metadata.archiveSha256 === repository.archive.sha256, 'retained-candidate-source-changed');
  const candidate = verifyCandidate(repository.applicationDirectory);
  need(candidate.id === metadata.candidateId && candidate.id === repository.candidateId, 'retained-candidate-changed');
  need(candidate.manifest.frontendCompatibility?.sourceRevision === source.commit, 'candidate-source-capsule-changed');
  return candidate;
}
function baseCandidate(input) {
  need(input.manifest.path === join(input.directory, 'dist', 'candidate.json'), 'base-manifest-path-changed');
  readEvidenceFile(input.manifest); const value = verifyCandidate(input.directory);
  need(value.id === input.candidateId, 'base-candidate-changed'); return value;
}
export function classifyVerifiedCandidates({ base, target, publicBase, publicTarget }) {
  const compatible = (a, b) => {
    const x = a.manifest.frontendCompatibility, y = b.manifest.frontendCompatibility;
    return x?.format === 2 && y?.format === 2 && x.eligibility === 'client-behavior' && y.eligibility === 'client-behavior'
      && /^[a-f0-9]{64}$/.test(x.serviceInputsSha256 ?? '') && x.serviceInputsSha256 === y.serviceInputsSha256
      && ['apiVersion', 'schemaVersion', 'appId'].every(key => a.manifest[key] !== undefined && a.manifest[key] === b.manifest[key]);
  };
  return compatible(base, target) && compatible(publicBase, publicTarget) ? 'frontend' : 'full';
}
export function createRouteAdapter(bases) {
  const namespace = {};
  const check = context => verificationOnce(context, namespace, { descriptor: context.descriptor, input: context.input }, () => {
    const { descriptor, input } = context;
    const target = verifyRetainedCandidate(input.artifacts.private, descriptor.sources.private), publicTarget = verifyRetainedCandidate(input.artifacts.public, descriptor.sources.public);
    const base = baseCandidate(input.bases.private), publicBase = baseCandidate(input.bases.public);
    need(base.id === descriptor.operation.priorCandidateId, 'selected-service-candidate-changed');
    for (const value of [target, publicTarget]) need(value.manifest.version === descriptor.operation.version && value.manifest.buildVersion === descriptor.operation.buildVersion, 'target-version-changed');
    return { route: classifyVerifiedCandidates({ base, target, publicBase, publicTarget }), baseCandidateId: base.id, targetCandidateId: target.id,
      publicCandidateId: publicTarget.id, serviceInputsSha256: target.manifest.frontendCompatibility?.serviceInputsSha256 ?? null };
  });
  const observe = async context => result('verified-candidate-route', structuredClone(check({ ...context, input: context.intent.input })));
  return { input: async ({ prior }) => { need(prior.artifacts?.authenticatedGithubCollection === true, 'authenticated-artifacts-required'); return { bases, artifacts: prior.artifacts.repositories }; },
    validate: async context => { check(context); }, execute: observe, observe,
    verify: async (value, context) => need(isDeepStrictEqual(value.output, check({ ...context, input: context.intent.input })), 'route-result-changed') };
}
export function createFrontendPackageAdapter({ frontend, bases }) {
  const inputNamespace = {}, outputNamespace = {};
  const check = context => verificationOnce(context, inputNamespace, { descriptor: context.descriptor, input: context.input }, () => {
    const { descriptor, input } = context;
    need(input.route.route === 'frontend', 'full-package-producer-required');
    const candidate = verifyRetainedCandidate(input.artifact, descriptor.sources.private), base = baseCandidate(input.base);
    need(base.id === descriptor.operation.priorCandidateId && candidate.id === input.route.targetCandidateId, 'frontend-package-candidate-changed');
    return { candidate, base };
  });
  const observe = async context => structuredClone(verificationOnce(context, outputNamespace,
    { descriptor: context.descriptor, intent: context.intent, directory: context.journal.directory }, () => {
    const { candidate, base } = check({ ...context, input: context.intent.input });
    const directory = join(context.journal.directory, `delivery-package-${context.intent.key}`), manifestPath = join(directory, 'frontend.json');
    const raw = frontendRegular(manifestPath, 128 * 1024), manifest = validateFrontendManifest(JSON.parse(raw), { admission: false });
    const entries = [...candidate.bytes].filter(([path]) => path.startsWith('dist/client/')).map(([path, bytes]) => [path.slice(12), bytes]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const files = entries.map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }));
    const expectedArchive = frontendArchive(entries), archivePath = join(directory, 'frontend.tgz'), actualArchive = frontendRegular(archivePath, 128 * 1024 ** 2);
    const options = context.intent.input.options;
    need(raw.equals(Buffer.from(JSON.stringify(manifest) + '\n')) && actualArchive.equals(expectedArchive) && isDeepStrictEqual(manifest.files, files)
      && manifest.frontendId === frontendIdentity(files) && manifest.base.candidateId === base.id && manifest.sourceRevision === context.descriptor.sources.private.commit
      && manifest.base.serviceInputsSha256 === base.manifest.frontendCompatibility.serviceInputsSha256 && manifest.base.apiVersion === base.manifest.apiVersion && manifest.base.schemaVersion === base.manifest.schemaVersion
      && manifest.frontendVersion === candidate.manifest.version && manifest.frontendBuildVersion === candidate.manifest.buildVersion
      && manifest.sequence === options.sequence && manifest.createdAt === options.createdAt && manifest.expiresAt === options.expiresAt && manifest.artifact.url === options.artifactUrl
      && manifest.artifact.sha256 === sha256(actualArchive) && manifest.artifact.bytes === actualArchive.length, 'frontend-package-output-changed');
    return result('retained-frontend-packaged', { route: 'frontend', frontendId: manifest.frontendId, baseCandidateId: base.id,
      manifest: { path: manifestPath, sha256: sha256(raw) }, archive: { path: archivePath, sha256: sha256(actualArchive) }, sequence: manifest.sequence });
  }));
  return { input: async ({ prior }) => ({ route: prior.route, artifact: prior.artifacts.repositories.private, base: bases.private, options: frontend }), validate: async context => { check(context); },
    execute: context => verificationEffect(context, async context => {
      const value = context.intent.input;
      packageRetained({ workspace: value.artifact.applicationDirectory, baseWorkspace: value.base.directory, applicationArchive: value.artifact.archive.path,
        ciSourceReceipt: value.artifact.ciSourceReceipt.path, approvedReceiptSha256: value.artifact.ciSourceReceipt.sha256,
        outputDirectory: join(context.journal.directory, `delivery-package-${context.intent.key}`), ...value.options });
      return observe(context);
    }), observe, verify: async (value, context) => need(isDeepStrictEqual(value.output, (await observe(context)).output), 'package-result-changed') };
}
export function createFrontendSignAdapter(signing) {
  const outputNamespace = {};
  const inputs = input => {
    readEvidenceFile(input.package.manifest); readEvidenceFile(signing.publicKey, { maximum: 16384 });
    if (signing.previousManifest !== 'initial') { readEvidenceFile(signing.previousManifest); readEvidenceFile(signing.previousSignature, { maximum: 64 }); }
  };
  const observe = async context => structuredClone(verificationOnce(context, outputNamespace,
    { descriptor: context.descriptor, intent: context.intent, directory: context.journal.directory, signing }, () => {
    const input = context.intent.input; inputs(input);
    const manifestRaw = readEvidenceFile(input.package.manifest), manifest = validateFrontendManifest(JSON.parse(manifestRaw), { admission: false }), signaturePath = join(context.journal.directory, `delivery-signature-${context.intent.key}.sig`);
    const signature = frontendRegular(signaturePath, 64), publicKey = createPublicKey(readEvidenceFile(signing.publicKey, { maximum: 16384 }));
    need(signature.length === 64 && publicKey.asymmetricKeyType === 'ed25519' && verify(null, manifestRaw, publicKey, signature), 'frontend-signature-invalid');
    if (signing.previousManifest === 'initial') need(manifest.sequence === 1, 'initial-frontend-sequence-invalid');
    else {
      const before = readEvidenceFile(signing.previousManifest), previous = validateFrontendManifest(JSON.parse(before), { admission: false });
      need(verify(null, before, publicKey, readEvidenceFile(signing.previousSignature, { maximum: 64 })) && manifest.sequence > previous.sequence, 'previous-frontend-signature-invalid');
    }
    return result('frontend-signed', { ...input.package, signature: { path: signaturePath, sha256: sha256(signature) }, publicKey: signing.publicKey });
  }));
  return { input: async ({ prior }) => ({ package: prior.package, signing }), validate: async ({ descriptor, input }) => {
    need(descriptor.operation.trustedPublicKeySha256 === signing.publicKey.sha256, 'trusted-signing-key-changed'); need(isDeepStrictEqual(input.signing, signing), 'signing-input-changed'); inputs(input); },
    execute: context => verificationEffect(context, async context => {
      signFrontend({ input: context.intent.input.package.manifest.path, privateKeyFile: signing.privateKeyPath, publicKeyFile: signing.publicKey.path,
        output: join(context.journal.directory, `delivery-signature-${context.intent.key}.sig`), previousManifest: signing.previousManifest === 'initial' ? 'initial' : signing.previousManifest.path,
        previousSignature: signing.previousSignature?.path });
      return observe(context);
    }), observe, verify: async (value, context) => need(isDeepStrictEqual(value.output, (await observe(context)).output), 'signature-result-changed') };
}
