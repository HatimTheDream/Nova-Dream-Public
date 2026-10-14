/** One execution owner, resumable fixed producer phases around ReleaseJournal.
 * An already-reserved phase is ALWAYS observed, including reservation/dispatch
 * crashes. Only a new transaction winner is allowed to make its first effect. */
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReleaseJournal } from './release-coordinate.mjs';
import { DELIVERY_PHASES, deliveryDescriptorSchema } from './release-delivery-journal.mjs';
import { readEvidenceFile, readReleaseInputFile, sha256 } from './release-plan.mjs';
import { reconcileFailedDelivery } from './release-delivery-disposition.mjs';

const need = (v, code) => { if (!v) throw Error(code); };
const verificationReason = error => /^[a-z][a-z0-9-]{0,99}$/.test(error?.message ?? '') ? error.message : 'producer-verification-rejected';
const groups = [['private-source'], ['public-source'], ['private-ci', 'public-ci'], ...DELIVERY_PHASES.slice(4).map(p => [p])];
export async function stepDelivery(journal, operationId, registry, { clock = Date.now, progress = () => {}, verificationScope = new Map() } = {}) {
  if (journal.deliveryDisposition(operationId)) return journal.deliveryStatus(operationId,clock());
  const descriptor = journal.loadDelivery(operationId).descriptor;
  readEvidenceFile(descriptor.target, { maximum: 256 * 1024 });
  need(await registry.identity(descriptor) === descriptor.adapterIdentity, 'delivery-adapter-changed');
  need(await registry.targetIdentity(descriptor) === descriptor.targetIdentity, 'delivery-target-changed');
  const integrationGaps = await registry.preflight?.(descriptor) ?? [];
  const capabilityGaps = await registry.capabilityGaps?.(descriptor) ?? [];
  if (integrationGaps.length) return { ...journal.deliveryStatus(operationId, clock()), integrationGaps, capabilityGaps, acceptanceGap: integrationGaps[0] };
  const fingerprint = intent => sha256(JSON.stringify({ operationId, phase: intent.phase, key: intent.key, inputSha256: intent.inputSha256,
    current: intent.current, validation: intent.validation }));
  const advance = async (phase, forceVerification = false) => {
    const existing = journal.deliveryPhase(operationId, phase);
    if (existing?.state === 'failed') return existing;
    const prior = Object.fromEntries(DELIVERY_PHASES.filter(p => p !== phase).map(p => [p, journal.deliveryPhase(operationId, p)]).filter(([, p]) => p?.state === 'completed').map(([p, v]) => [p, v.current.output]));
    const phaseGaps = await registry.phasePreflight?.(phase,descriptor,prior) ?? [];
    if (phaseGaps.length) return { state:'gap',reason:phaseGaps[0],integrationGaps:phaseGaps };
    const adapter = registry.adapter(phase, descriptor, prior);
    if (!adapter) return { state: 'gap', reason: `missing-${phase}-adapter` };
    // Computing/validating immutable input is read-only and precedes reservation.
    let input = existing?.input ?? await adapter.input({ descriptor, prior });
    if (existing?.state === 'completed') {
      // This cache only avoids rereading immutable completed output during
      // observation polls. Every new effect below forces content verification
      // again; a new invocation has an empty cache. It never admits an effect.
      const identity = fingerprint(existing);
      if (!forceVerification && existing.validation?.state !== 'failed' && verificationScope.get(phase) === identity) return existing;
      try {
        await adapter.validate({ descriptor, prior, input, journal });
        await adapter.verify(existing.current, { descriptor, prior, intent: existing, journal });
        if (existing.validation?.state === 'failed') journal.recordDeliveryRevalidation(operationId, phase, { state: 'passed', reason: 'retained-producer-result-reverified' }, clock());
        verificationScope.set(phase, fingerprint(journal.deliveryPhase(operationId, phase)));
        return existing;
      } catch (error) {
        verificationScope.delete(phase);
        const reason = verificationReason(error); journal.recordDeliveryRevalidation(operationId, phase, { state: 'failed', reason }, clock());
        return { ...existing, state: 'failed', reason };
      }
    }
    await adapter.validate({ descriptor, prior, input, journal });
    if (!existing) {
      // Fresh admission uses actual hashes, even if an earlier observation poll
      // cached this exact journal record. A changed artifact stops reservation.
      for (const dependency of DELIVERY_PHASES.filter(p => p !== phase && journal.deliveryPhase(operationId, p)?.state === 'completed')) {
        const verified = await advance(dependency, true);
        if (verified.state !== 'completed') return verified;
      }
      // This hook may only produce read-only admission evidence. Run after
      // prerequisite verification, before the first outer effect reservation.
      if (adapter.admit) {
        input = await adapter.admit({ descriptor, prior, input, journal });
        readEvidenceFile(descriptor.target, { maximum:256*1024 });
        need(await registry.identity(descriptor) === descriptor.adapterIdentity, 'delivery-adapter-changed');
        need(await registry.targetIdentity(descriptor) === descriptor.targetIdentity, 'delivery-target-changed');
        await adapter.validate({ descriptor, prior, input, journal });
      }
    }
    const reservation = journal.reserveDeliveryPhase(operationId, phase, input, clock());
    const context = { descriptor, prior, intent: reservation.intent, journal,
      // An existing parent may advance a never-started child after interruption.
      // Child effects must reverify outer dependencies, even on an observe call.
      beforeNewEffect: async () => {
        readEvidenceFile(descriptor.target, { maximum: 256 * 1024 });
        need(await registry.identity(descriptor) === descriptor.adapterIdentity, 'delivery-adapter-changed');
        need(await registry.targetIdentity(descriptor) === descriptor.targetIdentity, 'delivery-target-changed');
        need((await registry.phasePreflight?.(phase,descriptor,prior) ?? []).length===0,'delivery-phase-capability-unavailable');
        for (const dependency of DELIVERY_PHASES.filter(p => p !== phase && journal.deliveryPhase(operationId, p)?.state === 'completed')) {
          const verified = await advance(dependency, true);
          need(verified.state === 'completed', 'delivery-prerequisite-verification-failed');
        }
      } };
    let result, rejectedObservation;
    try {
      result = await (reservation.newlyReserved ? adapter.execute(context) : adapter.observe(context));
    } catch {
      result = { state: 'uncertain', externalId: reservation.intent.externalId, reason: 'producer-response-unavailable', receipt: null, output: null };
    }
    try { await adapter.verify(result, context); }
    catch (error) {
      rejectedObservation = result;
      result = { state: 'failed', externalId: reservation.intent.externalId, reason: verificationReason(error), receipt: null,
        output: { verificationFailed: true, originalKey: reservation.intent.key } };
    }
    const recorded = journal.recordDeliveryObservation(operationId, phase, { ...result, key: reservation.intent.key }, clock(), { rejectedObservation });
    if (recorded.state === 'completed') verificationScope.set(phase, fingerprint(recorded));
    progress(journal.deliveryStatus(operationId, clock()));
    return recorded;
  };
  for (const group of groups) {
    // allSettled lets the second CI observation finish even if the first fails.
    const results = await Promise.allSettled(group.map(phase => advance(phase)));
    const failed = results.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
    const pending = results.map(r => r.value).find(r => r.state !== 'completed');
    if (pending) return { ...journal.deliveryStatus(operationId, clock()), capabilityGaps, ...(pending.integrationGaps?{integrationGaps:pending.integrationGaps}:{}), acceptanceGap: pending.state === 'gap' ? pending.reason ?? pending.current?.reason : null };
  }
  return journal.completeDelivery(operationId, clock());
}
export async function deliver(journal, operationId, registry, { clock = Date.now, wait = ms => new Promise(r => setTimeout(r, ms)), progress = () => {}, invocationMs = 60_000, pollMs = 5000 } = {}) {
  need(Number.isSafeInteger(invocationMs) && invocationMs >= 1 && invocationMs <= 86400000 && Number.isSafeInteger(pollMs) && pollMs >= 1 && pollMs <= 30000, 'invalid-delivery-observation-budget');
  const deadline = clock() + invocationMs, verificationScope = new Map();
  while (true) {
    const result = await stepDelivery(journal, operationId, registry, { clock, progress, verificationScope });
    if (result.complete || result.closed || result.acceptanceGap || result.phases.some(p => ['failed', 'gap'].includes(p.state)) || clock() >= deadline) return result;
    await wait(Math.min(pollMs, Math.max(0, deadline - clock())));
  }
}
export async function deliveryMain(args) {
  const [mode, directory, value, extra] = args;
  need(['start', 'resume', 'status', 'checkpoint', 'reconcile-failure'].includes(mode) && (mode === 'checkpoint' ? args.length === 4 : args.length === 3), 'invalid-delivery-command');
  const journal = new ReleaseJournal(directory, { create: mode === 'start', readOnly: mode === 'status' });
  try {
    if (mode === 'status') return journal.deliveryStatus(value);
    if (mode === 'checkpoint') return journal.checkpointDelivery(value, JSON.parse(readReleaseInputFile(resolve(extra))));
    const { createDeliveryRegistry } = await import('./release-delivery-adapters.mjs');
    if (mode === 'reconcile-failure') return await reconcileFailedDelivery(journal,value,createDeliveryRegistry());
    let id = value;
    if (mode === 'start') {
      const inputPath = resolve(value), descriptor = deliveryDescriptorSchema.parse(JSON.parse(readReleaseInputFile(inputPath)));
      descriptor.target.path = resolve(dirname(inputPath), descriptor.target.path);
      for (const side of ['private', 'public']) descriptor.sources[side].root = resolve(dirname(inputPath), descriptor.sources[side].root);
      journal.initializeDelivery(descriptor); id = descriptor.operation.id;
    }
    const retained = journal.loadDelivery(id), remainingMs = retained.created_at + retained.descriptor.observationBudgetMs - Date.now();
    if (remainingMs <= 0) return { ...journal.deliveryStatus(id), observationBudgetExpired: true };
    return await deliver(journal, id, createDeliveryRegistry(), { invocationMs: remainingMs, progress: result => process.stderr.write(JSON.stringify(result) + '\n') });
  } finally { journal.close(); }
}
export function deliveryExitCode(mode, result) {
  return ['start', 'resume'].includes(mode) && !result.complete ? 2 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await deliveryMain(process.argv.slice(2)); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = deliveryExitCode(process.argv[2], result); }
  catch (error) { process.stdout.write(JSON.stringify({ kind: 'nova-release-delivery-error', reason: /^[a-z][a-z0-9-]{1,99}$/.test(error.message) ? error.message : 'delivery-input-or-producer-rejected', automaticReplayPermitted: false }) + '\n'); process.exitCode = 1; }
}
