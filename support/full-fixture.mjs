import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../scripts/release-plan.mjs';
import { verifyCandidate } from '../scripts/candidate.mjs';
import { createFullBundleAdapter, createFullSignAdapter } from '../scripts/release-delivery-full.mjs';
import { signUpdateManifest } from '../scripts/update-manifest.mjs';

const rawJson = value => Buffer.from(JSON.stringify(value) + '\n');
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nova-m2-full-substep-'));
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); const raw = Buffer.isBuffer(value) ? value : rawJson(value); writeFileSync(path, raw); return { path, sha256: sha256(raw) }; };
  const candidate = (side, base = false) => {
    const directory = join(root, side + (base ? '-base' : '-target')), commit = (side === 'private' ? 'a' : 'b').repeat(40);
    const pkg = { name: 'nova-dream-edition-3', type: 'module', version: base ? '2.3.0' : '2.4.0', edition3: { buildVersion: base ? '1.0.287' : '1.0.289', schemaVersion: 1, apiVersion: 1, appId: 'nova' } };
    put(join(directory, 'package.json'), pkg); put(join(directory, 'package-lock.json'), { version: pkg.version });
    const files = { 'dist/client/index.html': Buffer.from('<html/>'), 'dist/service/apps/service/main.js': Buffer.from(base ? 'old()' : 'changedBackend()'),
      'dist/service/apps/service/update-feed.js': readFileSync(new URL('../support/full-contract/apps/service/update-feed.js', import.meta.url)),
      'dist/service/packages/domain/software-update.js': readFileSync(new URL('../support/full-contract/packages/domain/software-update.js', import.meta.url)) };
    const artifacts = Object.entries(files).map(([name, raw]) => ({ path: name, sha256: put(join(directory, name), raw).sha256 }));
    const manifest = put(join(directory, 'dist/candidate.json'), { version: pkg.version, ...pkg.edition3, artifacts,
      frontendCompatibility: { format: 2, eligibility: 'client-behavior', sourceRevision: commit, serviceInputsSha256: (base ? 'c' : 'd').repeat(64) } });
    const verified = verifyCandidate(directory), archive = put(join(root, side + (base ? '-base' : '') + '.tgz'), Buffer.from('synthetic retained CI app archive'));
    const repository = 'HatimTheDream/Nova-Dream' + (side === 'public' ? '-Public' : ''), metadata = { candidateId: verified.id, archiveSha256: archive.sha256 };
    return { directory, applicationDirectory: directory, candidateId: verified.id, manifest, sourceCommit: commit, repository, archive,
      metadata: put(join(directory, 'metadata.json'), metadata), ciSourceReceipt: put(join(directory, 'ci.json'), { sourceCommit: commit, repository, application: metadata }), sourceHashes: {} };
  };
  const artifacts = { private: candidate('private'), public: candidate('public') }, base = candidate('private', true);
  const descriptor = { operation: { id: randomUUID(), version: '2.4.0', buildVersion: '1.0.289', priorCandidateId: base.candidateId,
    agentVersion: '2026.9.8', priorAgentVersion: '2026.9.8', sourceCommits: { private: artifacts.private.sourceCommit, public: artifacts.public.sourceCommit } },
    sources: Object.fromEntries(Object.entries(artifacts).map(([side, artifact]) => [side, { commit: artifact.sourceCommit, repository: artifact.repository }])) };
  const route = { route: 'full', baseCandidateId: base.candidateId, targetCandidateId: artifacts.private.candidateId, publicCandidateId: artifacts.public.candidateId };
  const directory = join(root, 'reviewed'), helperNames = ['install.py', 'recovery.py', 'codex_log_retention.py', 'app_dependencies.py', 'workspace_key.py', 'verify-session-bindings.mjs'];
  const helperHashes = Object.fromEntries(helperNames.map(name => {
    const reference = put(join(directory, name), Buffer.from('synthetic exact helper ' + name));
    for (const artifact of Object.values(artifacts)) artifact.sourceHashes['deploy/update-runner/' + name] = { sha256: reference.sha256 };
    return [name, reference.sha256];
  }));
  put(join(directory, 'app.tgz'), readFileSync(artifacts.private.archive.path));
  const archive = put(join(root, 'app-dependencies.tgz'), Buffer.from('synthetic dependency archive; producer is mocked'));
  const description = { format: 1, archiveBytes: readFileSync(archive.path).length, archiveSha256: archive.sha256 };
  const dependencies = { archive, description, metadata: put(join(root, 'app-dependencies.metadata.json'), description) };
  put(join(directory, 'reviewed-pair.json'), { format: 1, candidateId: artifacts.private.candidateId, priorCandidateId: base.candidateId,
    archiveSha256: artifacts.private.archive.sha256, archiveBytes: readFileSync(artifacts.private.archive.path).length,
    helpers: Object.fromEntries(Object.entries(helperHashes).filter(([name]) => name !== 'install.py')), applicationDependencies: description });
  const release = { candidateId: artifacts.private.candidateId, fromCandidateId: base.candidateId, novaVersion: '2.4.0', agentVersion: '2026.9.8', platform: 'linux', arch: 'x64', nodeMajor: 22,
    notes: ['Synthetic backend release'], compatibility: { reviewed: true, gatewayProtocol: 4, fromNovaVersion: '2.3.0', fromAgentVersion: '2026.9.8', fromSchemaVersion: 1, toSchemaVersion: 1, pluginVersion: '2.4.0' },
    recovery: { pairedSnapshot: true, independentRestore: true, readinessTimeoutSeconds: 300 } };
  const counts = { execute: 0, observe: 0 };
  const preparation = put(join(root, 'synthetic-preparation.json'), { fixtureOnly: true });
  const pairProducer = { validate: async () => {}, verify: async () => {},
    execute: async context => { counts.execute++; return pairProducer.result(context); }, observe: async context => { counts.observe++; return pairProducer.result(context); },
    result: context => ({ state: 'completed', externalId: context.intent.key, reason: 'fixture-pair', receipt: null, output: {
      kind: 'maintained-qualified-update-pair', operationId: descriptor.operation.id, key: context.intent.key, sourceCommits: descriptor.operation.sourceCommits,
      candidateId: artifacts.private.candidateId, publicCandidateId: artifacts.public.candidateId, priorCandidateId: base.candidateId, directory, dependencies, release,
      preparation } }) };
  const options = { bundleUrl: 'https://example.invalid/bundle.json', dependenciesUrl: 'https://example.invalid/dependencies.tgz' };
  const prior = { artifacts: { repositories: artifacts }, route };
  return { root, put, descriptor, artifacts, base, route, directory, dependencies, pairProducer, counts, options, prior };
}
