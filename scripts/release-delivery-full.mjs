/** Thin full-bundle/sign consumers. The maintained qualified dependency/pair
 * producer is a required internal capability, never a caller-supplied receipt. */
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { packageUpdateBundle } from './update-bundle.mjs';
import { signUpdateManifest } from './update-manifest.mjs';
import { verifyRetainedCandidate } from './release-delivery-package.mjs';
import { verifyCandidate } from './candidate.mjs';
import { frontendRegular } from './frontend-contract.mjs';
import { readEvidenceFile, sha256 } from './release-plan.mjs';

const need = (value, code) => { if (!value) throw Error(code); };
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const helpers = ['install.py', 'recovery.py', 'codex_log_retention.py', 'app_dependencies.py', 'workspace_key.py', 'verify-session-bindings.mjs'];
const ref = (path, maximum = 128 * 1024 ** 2) => ({ path, sha256: sha256(frontendRegular(path, maximum)) });
const largeArtifact = reference => { const raw = frontendRegular(reference.path, 512 * 1024 ** 2); need(sha256(raw) === reference.sha256, 'full-retained-artifact-changed'); return raw; };
const response = (state, reason, key, output = null) => ({ state, reason, externalId: key, receipt: null, output });
const https = value => { const u = new URL(value); need(u.protocol === 'https:' && !u.username && !u.password && !u.hash, 'full-artifact-url-invalid'); return value; };

function sourceCheck({ descriptor, input }) {
  need(input.route?.route === 'full', 'full-route-required');
  const candidates = Object.fromEntries(['private', 'public'].map(side => [side, verifyRetainedCandidate(input.artifacts[side], descriptor.sources[side])]));
  need(candidates.private.id === input.route.targetCandidateId && candidates.public.id === input.route.publicCandidateId
    && input.route.baseCandidateId === descriptor.operation.priorCandidateId, 'full-candidate-identity-changed');
  for (const c of Object.values(candidates)) need(c.manifest.version === descriptor.operation.version && c.manifest.buildVersion === descriptor.operation.buildVersion, 'full-candidate-version-changed');
  return candidates;
}

/** This verifies the produced flat pair; it does not create a dependency tree,
 * assert qualification, or weaken the required producer's own verification. */
function pairCheck(value, context) {
  const { descriptor, intent } = context, input = intent.input, output = value.output;
  const candidates = sourceCheck({ descriptor, input });
  need(value.state === 'completed' && value.externalId === intent.key && output?.kind === 'maintained-qualified-update-pair'
    && output.operationId === descriptor.operation.id && output.key === intent.key
    && isDeepStrictEqual(output.sourceCommits, descriptor.operation.sourceCommits)
    && output.candidateId === input.route.targetCandidateId && output.publicCandidateId === input.route.publicCandidateId
    && output.priorCandidateId === descriptor.operation.priorCandidateId, 'full-pair-producer-identity-changed');
  need(resolve(output.directory) === output.directory && isDeepStrictEqual(readdirSync(output.directory).sort(), [...helpers, 'app.tgz', 'reviewed-pair.json'].sort()), 'full-pair-file-closure-changed');
  const pairRaw = frontendRegular(join(output.directory, 'reviewed-pair.json'), 1024 ** 2), pair = JSON.parse(pairRaw);
  need(pair.candidateId === output.candidateId && pair.priorCandidateId === output.priorCandidateId
    && pair.archiveSha256 === input.artifacts.private.archive.sha256, 'full-pair-candidate-changed');
  const entries = [];
  for (const name of [...helpers, 'app.tgz', 'reviewed-pair.json'].sort()) {
    const path = join(output.directory, name), raw = frontendRegular(path, name === 'app.tgz' ? 128 * 1024 ** 2 : 2 * 1024 ** 2), digest = sha256(raw);
    if (helpers.includes(name)) {
      need(['private', 'public'].every(side => input.artifacts[side].sourceHashes?.[`deploy/update-runner/${name}`]?.sha256 === digest), 'full-paired-helper-changed');
      if (name !== 'install.py') need(pair.helpers?.[name] === digest, 'full-pair-helper-description-changed');
    }
    if (name === 'app.tgz') need(digest === input.artifacts.private.archive.sha256 && raw.length === pair.archiveBytes, 'full-application-archive-changed');
    entries.push({ name, data: raw.toString('base64'), sha256: digest });
  }
  need(isDeepStrictEqual(pair.applicationDependencies, output.dependencies?.description), 'full-dependency-description-changed');
  const dependencies = largeArtifact(output.dependencies.archive);
  need(dependencies.length === pair.applicationDependencies.archiveBytes && sha256(dependencies) === pair.applicationDependencies.archiveSha256
    && isDeepStrictEqual(JSON.parse(readEvidenceFile(output.dependencies.metadata)), pair.applicationDependencies), 'full-dependency-archive-changed');
  if (descriptor.operation.agentVersion !== descriptor.operation.priorAgentVersion) need(output.runtime && pair.runtime, 'full-runtime-producer-required');
  if (output.runtime) {
    need(isDeepStrictEqual(pair.runtime, output.runtime.description) && pair.runtime.fromVersion === descriptor.operation.priorAgentVersion
      && pair.runtime.toVersion === descriptor.operation.agentVersion && pair.runtime.fromVersion !== pair.runtime.toVersion, 'full-runtime-description-changed');
    const runtime = largeArtifact(output.runtime.archive);
    need(runtime.length === pair.runtime.archiveBytes && sha256(runtime) === pair.runtime.archiveSha256, 'full-runtime-archive-changed');
  } else need(!pair.runtime, 'full-runtime-output-missing');
  need(output.release?.candidateId === output.candidateId && output.release.fromCandidateId === output.priorCandidateId
    && output.release.novaVersion === descriptor.operation.version && output.release.agentVersion === descriptor.operation.agentVersion
    && output.release.compatibility?.fromAgentVersion === descriptor.operation.priorAgentVersion
    && output.release.compatibility?.toSchemaVersion === candidates.private.manifest.schemaVersion,
  'full-release-identity-changed');
  readEvidenceFile(output.preparation);
  return { output, pair, entries };
}

export function createFullBundleAdapter({ options, pairProducer = null, pack = packageUpdateBundle }) {
  const missing = context => response('gap', 'qualified-dependency-pair-producer-not-integrated', context.intent.key);
  const reconcile = async (context, produced) => {
    if (!pairProducer) return missing(context);
    const value = produced ?? await pairProducer.observe(context);
    await pairProducer.verify(value, context);
    need(value.externalId === context.intent.key, 'full-pair-operation-key-changed');
    if (value.state !== 'completed') return value;
    const { output, entries } = pairCheck(value, context);
    const bundlePath = join(context.journal.directory, `delivery-full-${context.intent.key}.json`), metadataPath = bundlePath + '.metadata.json';
    if (!existsSync(bundlePath) || !existsSync(metadataPath)) return response('uncertain', 'original-full-bundle-incomplete', context.intent.key);
    const raw = frontendRegular(bundlePath, 128 * 1024 ** 2), metadata = JSON.parse(frontendRegular(metadataPath, 65536));
    need(raw.equals(Buffer.from(JSON.stringify({ format: 1, files: entries }))) && metadata.bytes === raw.length && metadata.sha256 === sha256(raw)
      && metadata.runnerSha256 === entries.find(x => x.name === 'install.py').sha256, 'full-bundle-output-changed');
    const bundle = { url: https(options.bundleUrl), ...metadata };
    const applicationDependenciesBundle = { url: https(options.dependenciesUrl), bytes: output.dependencies.description.archiveBytes, sha256: output.dependencies.archive.sha256 };
    const release = { ...output.release, bundle, applicationDependenciesBundle,
      ...(output.runtime ? { runtimeBundle: { url: https(options.runtimeUrl), bytes: output.runtime.description.archiveBytes, sha256: output.runtime.archive.sha256 } } : {}) };
    return response('completed', 'maintained-full-bundle-packaged', context.intent.key, { route: 'full', candidateId: output.candidateId,
      publicCandidateId: output.publicCandidateId, priorCandidateId: output.priorCandidateId, sourceCommits: output.sourceCommits,
      bundle: { path: bundlePath, sha256: sha256(raw) }, bundleMetadata: ref(metadataPath, 65536), dependencies: output.dependencies,
      runtime: output.runtime ?? null, release, preparation: output.preparation });
  };
  return { input: async ({ prior }) => ({ route: prior.route, artifacts: prior.artifacts.repositories, options }),
    validate: async context => { need(isDeepStrictEqual(context.input.options, options), 'full-package-options-changed');
      https(options.bundleUrl); https(options.dependenciesUrl); if (options.runtimeUrl) https(options.runtimeUrl);
      sourceCheck(context); await pairProducer?.validate(context); },
    execute: async context => {
      if (!pairProducer) return missing(context);
      const produced = await pairProducer.execute(context); await pairProducer.verify(produced, context);
      need(produced.externalId === context.intent.key, 'full-pair-operation-key-changed');
      if (produced.state !== 'completed') return produced;
      const { output } = pairCheck(produced, context);
      pack(output.directory, join(context.journal.directory, `delivery-full-${context.intent.key}.json`));
      return reconcile(context, produced);
    }, observe: context => reconcile(context),
    verify: async (value, context) => {
      if (value.state !== 'completed') return;
      need(isDeepStrictEqual(value.output, (await reconcile(context)).output), 'full-package-result-changed');
    } };
}

/** Load the selected service's verified feed contract; it is the consumer of
 * this update. Missing installed dependencies are an explicit route gap. */
export async function loadSelectedFeedContract(base, descriptor) {
  need(base.manifest.path === join(base.directory, 'dist', 'candidate.json'), 'selected-feed-contract-path-changed');
  readEvidenceFile(base.manifest);
  const selected = verifyCandidate(base.directory), name = 'dist/service/apps/service/update-feed.js';
  need(selected.id === base.candidateId && selected.id === descriptor.operation.priorCandidateId && selected.bytes.has(name), 'selected-feed-contract-changed');
  const path = join(base.directory, name), module = await import(pathToFileURL(path).href + '?sha256=' + sha256(selected.bytes.get(name)));
  need(module.updateManifestSchema?.parse && module.updateFeedLimits?.maxBytes === 128 * 1024, 'selected-feed-contract-unavailable');
  return module;
}

export function createFullSignAdapter({ signing, feed, base, storeReceipt, contractProvider = loadSelectedFeedContract, sign = signUpdateManifest }) {
  const check = async ({ descriptor, input }) => {
    need(input.package.route === 'full' && isDeepStrictEqual(input.signing, signing) && isDeepStrictEqual(input.feed, feed), 'full-signing-input-changed');
    need(descriptor.operation.trustedPublicKeySha256 === signing.publicKey.sha256, 'trusted-signing-key-changed');
    const publicRaw = readEvidenceFile(signing.publicKey, { maximum: 16384 });
    readEvidenceFile(input.package.bundle, { maximum: 128 * 1024 ** 2 }); readEvidenceFile(input.package.bundleMetadata);
    const release = input.package.release;
    const selectedManifest = JSON.parse(readEvidenceFile(base.manifest));
    need(release.candidateId === input.package.candidateId && release.fromCandidateId === descriptor.operation.priorCandidateId
      && release.novaVersion === descriptor.operation.version && release.agentVersion === descriptor.operation.agentVersion
      && release.bundle.sha256 === input.package.bundle.sha256 && release.compatibility?.fromNovaVersion === selectedManifest.version
      && release.compatibility?.fromSchemaVersion === selectedManifest.schemaVersion, 'full-signing-release-changed');
    const dependencyBytes = largeArtifact(input.package.dependencies.archive);
    need(release.applicationDependenciesBundle?.sha256 === input.package.dependencies.archive.sha256
      && release.applicationDependenciesBundle.bytes === dependencyBytes.length, 'full-signing-dependency-changed');
    if (input.package.runtime) {
      const runtimeBytes = largeArtifact(input.package.runtime.archive);
      need(release.runtimeBundle?.sha256 === input.package.runtime.archive.sha256 && release.runtimeBundle.bytes === runtimeBytes.length, 'full-signing-runtime-changed');
    } else need(!release.runtimeBundle, 'full-signing-runtime-unbound');
    for (const artifact of [release.bundle, release.applicationDependenciesBundle, release.runtimeBundle].filter(Boolean)) https(artifact.url);
    const contract = await contractProvider(base, descriptor), manifest = contract.updateManifestSchema.parse({ format: 1, ...feed, releases: [release] });
    const publicKey = createPublicKey(publicRaw); need(publicKey.asymmetricKeyType === 'ed25519', 'full-public-key-invalid');
    if (signing.previousFeed === 'initial') need(manifest.sequence === 1, 'initial-full-sequence-invalid');
    else {
      const old = JSON.parse(readEvidenceFile(signing.previousFeed, { maximum: contract.updateFeedLimits.maxBytes }));
      const payload = Buffer.from(old.payload ?? '', 'base64'), signature = Buffer.from(old.signature ?? '', 'base64');
      need(payload.toString('base64') === old.payload && signature.length === 64 && signature.toString('base64') === old.signature
        && verify(null, payload, publicKey, signature), 'previous-full-signature-invalid');
      const prior = contract.updateManifestSchema.parse(JSON.parse(payload));
      need(manifest.channel === prior.channel && manifest.sequence > prior.sequence, 'full-feed-sequence-not-advanced');
    }
    return { manifest, contract, publicKey };
  };
  const observe = async context => {
    const { manifest, contract, publicKey } = await check({ descriptor: context.descriptor, input: context.intent.input });
    const path = join(context.journal.directory, `delivery-full-signature-${context.intent.key}.json`);
    if (!existsSync(path)) return response('uncertain', 'original-full-signature-unavailable', context.intent.key);
    const raw = frontendRegular(path, contract.updateFeedLimits.maxBytes), envelope = JSON.parse(raw);
    need(Object.keys(envelope).sort().join(',') === 'payload,signature', 'full-signature-envelope-invalid');
    const payload = Buffer.from(envelope.payload ?? '', 'base64'), signature = Buffer.from(envelope.signature ?? '', 'base64');
    need(payload.toString('base64') === envelope.payload && signature.toString('base64') === envelope.signature && signature.length === 64
      && verify(null, payload, publicKey, signature) && payload.equals(Buffer.from(JSON.stringify(manifest))), 'full-signature-invalid');
    return response('completed', 'full-feed-signed', context.intent.key, { ...context.intent.input.package,
      signedFeed: { path, sha256: sha256(raw) }, publicKey: signing.publicKey, channel: manifest.channel, sequence: manifest.sequence });
  };
  return { input: async ({ prior }) => ({ package: prior.package, signing, feed }), validate: check,
    execute: async context => {
      const { manifest, contract } = await check({ descriptor: context.descriptor, input: context.intent.input });
      const stored = storeReceipt(context.journal, context.intent.key, 'full-manifest.json', json(manifest));
      await sign({ input: stored.path, privateKeyFile: signing.privateKeyPath, publicKeyFile: signing.publicKey.path,
        output: join(context.journal.directory, `delivery-full-signature-${context.intent.key}.json`),
        previous: signing.previousFeed === 'initial' ? 'initial' : signing.previousFeed.path }, contract);
      return observe(context);
    }, observe, verify: async (value, context) => { if (value.state === 'completed') need(isDeepStrictEqual(value.output, (await observe(context)).output), 'full-signature-result-changed'); } };
}
