/** Fixed producer registry. Missing maintained producer integration is a gap,
 * never permission to run a caller-supplied command or accept hand-made proof. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, constants, openSync, closeSync, fsyncSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { releaseTransportSchema, runInstallTransport } from './release-adapters.mjs';
import { validateJournalDirectory } from './release-coordinate.mjs';
import { createCoordinatorInstallationAdapter } from './release-delivery-install.mjs';
import { createArtifactAdapter } from './release-delivery-artifact-adapter.mjs';
import { createCiAdapter } from './release-delivery-ci-adapter.mjs';
import { createFullSignAdapter } from './release-delivery-full.mjs';
import { createDurableFullBundleAdapter, createDependencyPairProducer } from './release-delivery-dependencies.mjs';
import { createMaintainedDependencyTransport, dependencyTransportSchema } from './release-delivery-dependency-transport.mjs';
import { classifyVerifiedCandidates, createRouteAdapter, createFrontendPackageAdapter, createFrontendSignAdapter } from './release-delivery-package.mjs';
import { createFrontendPublicationAdapter } from './release-delivery-frontend.mjs';
import { createFrontendStageCapacityAdapter, createFrontendBoundRecoveryAdapter } from './release-delivery-frontend-stage.mjs';
import { createFrontendExecutionAdapter } from './release-delivery-frontend-executor.mjs';
import { createAssistantAcceptanceAdapter } from './release-delivery-assistant.mjs';
import { createAssistantHostTransport } from './release-delivery-assistant-transport.mjs';
import { createFullAssistantHostTransport } from './release-delivery-assistant-full.mjs';
import { createFullInstalledIdentityObserver } from './release-delivery-installed-identity.mjs';
import { createFullInstallationAdmission } from './release-delivery-install-admission.mjs';
import { fullHostOptionsSchema, FULL_HELPERS, createFullCapacityAdapter, createFullRehearsalAdapter, collectFullOnlineCapacity } from './release-delivery-full-host.mjs';
import { createFullPublicationAdapter } from './release-delivery-full-publication.mjs';
import { verifyFullProtectedAssets } from './release-delivery-full-prestage.mjs';
import { runtimeAdmissionCapability } from './release-delivery-runtime-qualification.mjs';
import {createRuntimeRetainedCollector} from './release-delivery-runtime-retained.mjs';
import {fullHostPrerequisiteGaps} from './release-delivery-host-preflight.mjs';

const need = (v, code) => { if (!v) throw Error(code); };
const canonical = v => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const ref = z.object({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const deliveryTargetSchema = z.object({ format: z.literal(1), transport: ref,
  sourceTools: z.object({ git: ref, python: ref, gitExecPath: z.string().min(1).max(4096) }).strict().optional(),
  // Trusted executable identities are private configuration. No command text,
  // arbitrary arguments or replaceable producer scripts are accepted.
  artifactTools: z.object({ git: ref, node: ref, python: ref, ciNodeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    nodeToolchain: z.object({ nodeVersion: z.literal('22.23.2'), platform: z.enum(['win32', 'linux']), arch: z.literal('x64') }).strict() }).strict().optional(),
  bases: z.object({ private: z.object({ directory: z.string(), candidateId: z.string().regex(/^[a-f0-9]{64}$/), manifest: ref }).strict(),
    public: z.object({ directory: z.string(), candidateId: z.string().regex(/^[a-f0-9]{64}$/), manifest: ref }).strict() }).strict().optional(),
  frontend: z.object({ artifactUrl: z.url(), sequence: z.number().int().positive(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime() }).strict().optional(),
  frontendHost: z.object({ baseVersion: z.string().regex(/^\d+\.\d+\.\d+$/), worker: ref, config: ref,
    workerInstallation: z.object({ version:z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),candidateId:z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict().optional(),
  assistantHost: z.object({ startupReview: ref, hostConfig: ref }).strict().optional(),
  signing: z.object({ privateKeyPath: z.string().min(1), publicKey: ref, previousManifest: z.union([z.literal('initial'), ref]), previousSignature: ref.optional() }).strict().optional(),
  full: z.object({ bundleUrl: z.url(), dependenciesUrl: z.url(), runtimeUrl: z.url().optional(),
    dependencyTransport: dependencyTransportSchema.optional(),
    host: fullHostOptionsSchema.optional(),
    publicationLedgerDirectory:z.string().min(1).max(4096).refine(isAbsolute),
    feed: z.object({ channel: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), sequence: z.number().int().positive(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime() }).strict(),
    signing: z.object({ privateKeyPath: z.string().min(1), publicKey: ref, previousFeed: z.union([z.literal('initial'), ref]) }).strict() }).strict().optional(),
  browserCapability: z.enum(['available', 'unavailable']) }).strict();
const executeFile = promisify(execFile);
export async function fixedCommand(executable, args, { cwd, maximum = 8 * 1024 ** 2, binary = false, timeoutMs = 120000, acceptJsonFailure = false, gitExecPath } = {}) {
  need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000, 'invalid-producer-timeout');
  try {
    const result = await executeFile(executable, args, { cwd, encoding: binary ? 'buffer' : 'utf8', shell: false, windowsHide: true,
      timeout: timeoutMs, maxBuffer: maximum, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...(gitExecPath ? { GIT_EXEC_PATH: gitExecPath } : {}) } });
    return result.stdout;
  } catch (error) {
    if (acceptJsonFailure && !error.killed && error.code === 2 && typeof error.stdout === 'string' && Buffer.byteLength(error.stdout) <= maximum) {
      let value; try { value = JSON.parse(error.stdout); } catch {}
      if (['failed', 'uncertain'].includes(value?.state) && /^[a-z][a-z0-9-]{0,99}$/.test(value.reason ?? '')) return error.stdout;
    }
    throw Error('producer-response-unavailable');
  }
}
const result = (state, reason, output = null, externalId = null, receipt = null) => ({ state, reason, output, externalId, receipt });
function targetInput(descriptor) {
  const target = deliveryTargetSchema.parse(JSON.parse(readEvidenceFile(descriptor.target)));
  const transport = releaseTransportSchema.parse(JSON.parse(readEvidenceFile(target.transport)));
  readEvidenceFile(transport.sshConfig, { maximum: 65536 });
  return { target, transport };
}
export function deliveryAdapterSourceFiles() {
  // Include implementation and all directly delegated authority/validation code.
  const files = ['release-delivery-adapters.mjs', 'release-delivery-ci-adapter.mjs', 'release-delivery-ci.py', 'release-ci-primitives.py', 'release-delivery-install.mjs', 'release-delivery-artifact-adapter.mjs', 'release-delivery-artifacts.py', 'release-artifact-primitives.py',
    'release-delivery-package.mjs', 'release-delivery-full.mjs', 'release-delivery-dependencies.mjs', 'release-verification-pass.mjs', 'release-observation-clock.mjs', 'release-delivery-dependency-transport.mjs', 'release-dependency-local-worker.py', 'release-dependency-metadata-successor.py', 'release-delivery-runtime-qualification.mjs', 'release-runtime-qualification.py', 'release-delivery-runtime-retained.mjs', 'release-runtime-retained-proof.py', 'release-delivery-host-preflight.mjs', 'full-host-primitives/preflight.py', 'release-runtime-artifact.mjs', 'update-bundle.mjs', 'update-manifest.mjs', 'frontend-package.mjs', 'frontend-contract.mjs', 'candidate.mjs',
    'release-delivery-frontend.mjs', 'release-delivery-frontend.py', 'release-frontend-publication-primitives.py', 'release-frontend-github-primitives.py',
    'release-delivery-frontend-stage.mjs', 'release-frontend-stage.py', 'release-delivery-frontend-plan.mjs', 'release-frontend-plan.py', 'release-delivery-frontend-executor.mjs', 'release-frontend-executor.py', 'release-delivery-frontend-refresh.mjs', 'release-frontend-refresh.py',
    'release-delivery-assistant.mjs', 'release-delivery-assistant-transport.mjs', 'release-assistant-transport.py',
    'release-delivery-assistant-full.mjs', 'release-delivery-installed-identity.mjs', 'release-delivery-full-coordinator.mjs', 'release-installed-identity.py', '../deploy/update-runner/request_install.py',
    'release-delivery-install-admission.mjs', 'release-delivery-full-host.mjs',
    'full-host-primitives/collect-facts.py', 'full-host-primitives/metadata-stage.py', 'full-host-primitives/launch-plan-template.py', 'full-host-primitives/observe-plan-template.py',
    'full-host-primitives/launch-execute-template-r2.py', 'full-host-primitives/observe-execute-template.py', 'full-host-primitives/collect-completion-template.py', 'full-host-primitives/online-capacity.py',
    'release-delivery-full-publication.mjs', 'release-delivery-full-publication.py', 'release-full-publication-primitives.py', 'release-full-feed-publication.py',
    'release-delivery-full-prestage.mjs', 'release-delivery-full-prestage.py', 'full-host-primitives/asset-stage.py', 'full-host-primitives/install-facts.py',
    'release-deliver.mjs', 'release-delivery-initialize.mjs', 'release-delivery-journal.mjs', 'release-delivery-disposition.mjs', 'release-coordinate.mjs', 'release-plan.mjs', 'release-adapters.mjs'];
  return files;
}
export function deliveryAdapterIdentity() {
  return sha256(canonical(deliveryAdapterSourceFiles().map(name => ({ name, sha256: sha256(readFileSync(new URL(name, import.meta.url))) }))));
}
export function deliveryTargetIdentity(descriptor) {
  const { transport } = targetInput(descriptor);
  return sha256(canonical({ hostAlias: transport.hostAlias, sshConfig: transport.sshConfig.sha256 }));
}
function storeReceipt(journal, key, name, bytes) {
  const parent = validateJournalDirectory(join(journal.directory, 'delivery-evidence'), { create: true });
  const path = join(parent, `${key}-${name}`), digest = sha256(bytes);
  if (existsSync(path)) { readEvidenceFile({ path, sha256: digest }, { maximum: 8 * 1024 ** 2 }); return { path, sha256: digest }; }
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  return { path, sha256: digest };
}
export function validateSourceTools(tools) {
  for (const name of ['git', 'python']) readEvidenceFile(tools[name], { maximum: 128 * 1024 ** 2 });
  need(isAbsolute(tools.gitExecPath) && resolve(realpathSync(tools.gitExecPath)) === resolve(tools.gitExecPath), 'source-git-exec-path-changed');
  for (let part = resolve(tools.gitExecPath); ; part = dirname(part)) {
    need(lstatSync(part).isDirectory() && !lstatSync(part).isSymbolicLink(), 'source-git-exec-path-changed');
    if (dirname(part) === part) break;
  }
}
export function createSourceAdapter(side, command, tools) {
  const local = async source => {
    need(source.branch === 'main', 'unsupported-source-branch');
    validateSourceTools(tools);
    const git = args => command(tools.git.path, ['-C', source.root, ...args], { gitExecPath: tools.gitExecPath });
    const remote = (await git(['remote', 'get-url', '--push', 'origin'])).trim();
    need([`https://github.com/${source.repository}.git`, `https://github.com/${source.repository}`, `git@github.com:${source.repository}.git`].includes(remote), 'source-remote-mismatch');
    need((await git(['rev-parse', '--verify', `${source.commit}^{commit}`])).trim() === source.commit, 'source-commit-missing');
    need((await git(['rev-parse', '--verify', `${source.baseCommit}^{commit}`])).trim() === source.baseCommit, 'source-base-missing');
    await git(['merge-base', '--is-ancestor', source.baseCommit, source.commit]);
    return git;
  };
  const observe = async ({ intent }) => {
    const source = intent.input.source, git = await local(source);
    const rows = (await git(['ls-remote', '--exit-code', 'origin', `refs/heads/${source.branch}`])).trim().split(/\r?\n/);
    if (rows.length !== 1 || rows[0].split(/\s+/)[0] !== source.commit)
      return result('uncertain', 'exact-source-publication-not-observed', null, intent.externalId);
    return result('completed', 'exact-source-published', { sourceCommit: source.commit, repository: source.repository, pushed: true }, source.commit);
  };
  return { input: async ({ descriptor }) => ({ source: descriptor.sources[side], tools }),
    validate: async ({ descriptor, input }) => { need(canonical(input) === canonical({ source: descriptor.sources[side], tools }), 'source-input-changed'); await local(input.source); },
    execute: async context => {
      const source = context.intent.input.source, git = await local(source);
      // Normal fast-forward push only; no force, reset, tag creation or history copy.
      await git(['push', 'origin', `${source.commit}:refs/heads/${source.branch}`]);
      return observe(context);
    }, observe,
    verify: async (r, { intent }) => { if (r.state === 'completed') need(r.output?.sourceCommit === intent.input.source.commit && r.output?.repository === intent.input.source.repository && r.output?.pushed === true, 'source-observation-changed'); },
  };
}
/** Candidate verification happens in the retained-artifact producer before this
 * pure decision. Old presentation-only capsules cannot certify React changes. */
export function chooseDeliveryRoute({ base, target, publicBase, publicTarget }) {
  return classifyVerifiedCandidates(Object.fromEntries(Object.entries({ base, target, publicBase, publicTarget }).map(([key, manifest]) => [key, { manifest }])));
}

export function deliveryPhaseIntegrationGaps(phase,target,prior={}) {
  if (phase === 'assistant') {
    if (!['frontend','full'].includes(prior.route?.route)) return ['verified-delivery-route-required'];
    return target.assistantHost ? [] : ['assistant-host-target-not-configured'];
  }
  if (phase === 'browser') return target.browserCapability === 'unavailable' ? ['browser-capability-unavailable','browser-reload-producer-not-integrated'] : ['browser-reload-producer-not-integrated'];
  if (['private-source','public-source','private-ci','public-ci','artifacts','route'].includes(phase)) return [];
  if (!['frontend','full'].includes(prior.route?.route)) return ['verified-delivery-route-required'];
  if (prior.route.route === 'full') return [...(target.full?.dependencyTransport && target.bases ? [] : ['qualified-dependency-worker-transport-not-integrated']),
    ...(target.full?.host ? [] : ['full-protected-host-target-not-configured']),
    ...(target.full?.host && target.assistantHost && canonical(target.full.host.hostConfiguration)!==canonical(target.assistantHost.hostConfig) ? ['full-assistant-host-configuration-mismatch'] : []),
    ...(target.full?.signing?.previousFeed && target.full.signing.previousFeed !== 'initial' ? [] : ['existing-full-feed-predecessor-required']),
    ...(target.assistantHost ? [] : ['assistant-host-target-not-configured']),
    ...(['private','public'].every(side=>Number.isSafeInteger(prior[side+'-ci']?.release?.id) && prior[side+'-ci'].release.id>0)?[]:['verified-ci-source-releases-required'])];
  return [...(target.frontend && target.signing ? [] : ['frontend-package-target-not-configured']),
    ...(target.frontendHost ? [] : ['frontend-protected-host-target-not-configured']),
    ...(['private','public'].every(side=>Number.isSafeInteger(prior[side+'-ci']?.release?.id) && prior[side+'-ci'].release.id>0)?[]:['verified-ci-source-releases-required'])];
}
export function createDeliveryRegistry({ command = fixedCommand, run = runInstallTransport, receiptStore = storeReceipt, clock = Date.now } = {}) {
  const dependency = target => createMaintainedDependencyTransport({ options:target.full.dependencyTransport,
    base:target.bases.private,storeReceipt:receiptStore,run:command,clock,
    ...(target.full.dependencyTransport.format===3?{runtimeCollector:createRuntimeRetainedCollector({transport:target.transport,options:target.full.dependencyTransport.runtimeQualification,run,clock})}: {}) });
  // This command currently has the maintained schema55/API1 host closure.
  // Actual candidate schema/runtime comparisons still run after authenticated
  // artifact retrieval; declared operation fields cannot override those bytes.
  const runtimeGaps = async (descriptor,target) => {
    const op=descriptor.operation;
    if(op.priorAgentVersion==='2026.9.6'&&op.agentVersion==='2026.9.8'&&target.full?.dependencyTransport?.format===3){
      if(!target.full.runtimeUrl)return ['runtime-artifact-publication-url-required'];
      const proof=await createRuntimeRetainedCollector({transport:target.transport,options:target.full.dependencyTransport.runtimeQualification,run,clock})();
      need(proof.prior.candidateId===op.priorCandidateId&&proof.workspaceEpoch===op.workspaceEpoch,'actual-runtime-selected-prior-binding-changed');
      return [];
    }
    return runtimeAdmissionCapability({fromVersion:op.priorAgentVersion,toVersion:op.agentVersion,schemaVersion:55,apiVersion:1}).gaps.map(gap=>gap.code);
  };
  const sourceCapabilityGaps = async (descriptor,target,prior) => {
    // Reuse the maintained source-only validator before any package reservation.
    // Only known unsupported transitions become capability gaps. Corrupt or
    // substituted evidence still fails verification rather than being waived.
    const capabilities=new Set(['changed-runtime-qualification-producer-required','changed-schema-qualification-producer-required',
      'changed-startup-qualification-producer-required','changed-updater-qualification-producer-required','changed-dependency-qualification-producer-required']);
    try { await dependency(target).validate({descriptor,input:{route:prior.route,artifacts:prior.artifacts.repositories}}); }
    catch(error) { if(capabilities.has(error?.message))return [error.message];throw error; }
    for(const side of ['private','public'])for(const [name,digest] of Object.entries(FULL_HELPERS)) {
      const artifact=prior.artifacts.repositories[side],claimed=artifact.sourceHashes?.['deploy/update-runner/'+name];
      if(claimed?.sha256!==digest)return ['full-helper-qualification-capability-required'];
      readEvidenceFile({path:join(artifact.frozenSourceDirectory,'deploy','update-runner',name),sha256:digest},{maximum:2*1024**2});
    }
    return (['application','presentation'].includes(descriptor.operation.changeClass)||(descriptor.operation.changeClass==='runtime'&&target.full.dependencyTransport.format===3))?[]:['full-changed-recovery-qualification-capability-required'];
  };
  const installationAdmission = (target,descriptor) => {
    need(canonical(target.full.host.hostConfiguration)===canonical(target.assistantHost.hostConfig),'full-assistant-host-configuration-changed');
    const admission=createFullInstallationAdmission({collectCapacity:context=>collectFullOnlineCapacity(context,
      {transport:target.transport,options:target.full.host,storeReceipt:receiptStore,run,clock}),storeReceipt:receiptStore,clock});
    const protectedAssets=context=>{
      const row=context.journal.deliveryPhase(descriptor.operation.id,'publication');
      need(row?.state==='completed'&&row.validation?.state!=='failed'&&row.key===context.prior.publication?.key
        &&canonical(row.current.output)===canonical(context.prior.publication),'full-install-original-publication-required');
      verifyFullProtectedAssets(context.prior.publication.protectedStage,{operationId:descriptor.operation.id,
        publicationKey:row.key,bundle:context.prior.sign.bundle,dependencies:context.prior.sign.dependencies,runtime:context.prior.sign.runtime??null});
    };
    return Object.fromEntries(['prepare','validate','apply'].map(method=>[method,async context=>{protectedAssets(context);return admission[method](context);} ]));
  };
  return { identity: async () => deliveryAdapterIdentity(), targetIdentity: async descriptor => deliveryTargetIdentity(descriptor),
    preflight: async descriptor => { const { target } = targetInput(descriptor); return [...(target.sourceTools ? [] : ['source-toolchain-not-configured']), ...(target.artifactTools ? [] : ['artifact-toolchain-not-configured']),
      ...(target.bases ? [] : ['verified-base-candidates-not-configured']),...await runtimeGaps(descriptor,target)]; },
    phasePreflight: async (phase,descriptor,prior) => {
      const {target}=targetInput(descriptor),gaps=deliveryPhaseIntegrationGaps(phase,target,prior);
      if(gaps.length||phase!=='package'||prior.route?.route!=='full')return gaps;
      const sourceGaps=await sourceCapabilityGaps(descriptor,target,prior);
      return sourceGaps.length?sourceGaps:fullHostPrerequisiteGaps({transport:target.transport,options:target.full.host,run});
    },
    // Report unsupported acceptance separately from route admission. Neither a
    // capability flag nor completed installation can satisfy these phases.
    capabilityGaps: async descriptor => { const { target }=targetInput(descriptor);return [
      ...(target.assistantHost?[]:['assistant-host-target-not-configured']),...(target.browserCapability==='unavailable'?['browser-capability-unavailable']:[]),'browser-reload-producer-not-integrated']; },
    adapter(phase, descriptor, prior = {}) {
      if (['private-source', 'public-source', 'private-ci', 'public-ci'].includes(phase)) {
        const { target } = targetInput(descriptor); if (!target.sourceTools) return null;
        const side = phase.split('-')[0];
        return phase.endsWith('-source') ? createSourceAdapter(side, command, target.sourceTools)
          : createCiAdapter(side, { tools: target.sourceTools, command, storeReceipt:receiptStore, validateTools: validateSourceTools });
      }
      if (phase === 'artifacts') { const { target } = targetInput(descriptor); return target.artifactTools ? createArtifactAdapter({ tools: target.artifactTools, command, storeReceipt:receiptStore }) : null; }
      if (phase === 'route') { const { target } = targetInput(descriptor); return target.bases ? createRouteAdapter(target.bases) : null; }
      if (phase === 'package' && prior.route?.route === 'frontend') { const { target } = targetInput(descriptor); return target.frontend && target.bases ? createFrontendPackageAdapter(target) : null; }
      if (phase === 'sign' && prior.route?.route === 'frontend') { const { target } = targetInput(descriptor); return target.signing ? createFrontendSignAdapter(target.signing) : null; }
      if (phase === 'capacity' && prior.route?.route === 'frontend') { const { target }=targetInput(descriptor); return target.frontendHost ? createFrontendStageCapacityAdapter({ transport:target.transport,options:target.frontendHost,storeReceipt:receiptStore,run }) : null; }
      if (phase === 'recovery' && prior.route?.route === 'frontend') { const { target }=targetInput(descriptor); return createFrontendBoundRecoveryAdapter({ transport:target.transport,storeReceipt:receiptStore,run }); }
      if (phase === 'publication' && prior.route?.route === 'frontend') { const { target }=targetInput(descriptor); const releaseIds=Object.fromEntries(['private','public'].map(side=>[side,prior[side+'-ci']?.release?.id])); return Object.values(releaseIds).every(id=>Number.isSafeInteger(id)&&id>0) && target.sourceTools && target.artifactTools ? createFrontendPublicationAdapter({ tools:{...target.sourceTools,node:target.artifactTools.node},releaseIds,command,storeReceipt:receiptStore }) : null; }
      if (phase === 'installation' && prior.route?.route === 'frontend') { const { target }=targetInput(descriptor);return createFrontendExecutionAdapter({transport:target.transport,storeReceipt:receiptStore,run}); }
      if (phase === 'assistant' && prior.route?.route === 'frontend') {
        const { target }=targetInput(descriptor);return target.assistantHost ? createAssistantAcceptanceAdapter({
          transport:createAssistantHostTransport({transport:target.transport,...target.assistantHost,storeReceipt:receiptStore,run}),
          storeReceipt:receiptStore,clock }) : null;
      }
      if (phase === 'assistant' && prior.route?.route === 'full') {
        const { target }=targetInput(descriptor);return target.assistantHost ? createAssistantAcceptanceAdapter({
          transport:createFullAssistantHostTransport({transport:target.transport,...target.assistantHost,storeReceipt:receiptStore,run}),
          storeReceipt:receiptStore,clock }) : null;
      }
      if (phase === 'package' && prior.route?.route === 'full') {
        const { target } = targetInput(descriptor);
        if (!target.full) return null;
        const maintained = target.full.dependencyTransport && target.bases ? dependency(target) : null;
        const pairProducer = maintained ? createDependencyPairProducer({ maintained, clock }) : null;
        return createDurableFullBundleAdapter({ options: target.full, pairProducer, clock });
      }
      if (phase === 'sign' && prior.route?.route === 'full') { const { target } = targetInput(descriptor); return target.full && target.bases ? createFullSignAdapter({ signing: target.full.signing, feed: target.full.feed, base: target.bases.private, storeReceipt:receiptStore }) : null; }
      if (phase === 'capacity' && prior.route?.route === 'full') { const {target}=targetInput(descriptor);return target.full?.host ? createFullCapacityAdapter({transport:target.transport,options:target.full.host,storeReceipt:receiptStore,run,clock}) : null; }
      if (phase === 'recovery' && prior.route?.route === 'full') { const {target}=targetInput(descriptor);return target.full?.host ? createFullRehearsalAdapter({transport:target.transport,options:target.full.host,storeReceipt:receiptStore,run,clock}) : null; }
      if (phase === 'publication' && prior.route?.route === 'full') {
        const {target}=targetInput(descriptor),releaseIds=Object.fromEntries(['private','public'].map(side=>[side,prior[side+'-ci']?.release?.id]));
        return target.full?.host && target.sourceTools && target.artifactTools && target.bases && Object.values(releaseIds).every(id=>Number.isSafeInteger(id)&&id>0)
          ? createFullPublicationAdapter({tools:{...target.sourceTools,node:target.artifactTools.node},releaseIds,options:target.full,
            transport:target.transport,base:target.bases.private,command,storeReceipt:receiptStore,run,clock}) : null;
      }
      if (phase === 'installation' && prior.route?.route === 'full') {
        const { target }=targetInput(descriptor);return target.assistantHost && target.full?.host ? createCoordinatorInstallationAdapter({clock,
          identityObserver:createFullInstalledIdentityObserver({transport:target.transport,...target.assistantHost,storeReceipt:receiptStore,run}),
          admission:installationAdmission(target,descriptor) }) : null;
      }
      // Do not substitute local receipt ingestion for these effect producers.
      // Integrate the already maintained collector/packager/rehearsal/publisher,
      // coordinator and acceptance callers before calling this an end-to-end tool.
      return null;
    } };
}
