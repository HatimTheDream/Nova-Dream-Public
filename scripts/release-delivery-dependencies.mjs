/** Fixed dependency preparation substeps in the existing ReleaseJournal.
 * The internal maintained transport is still a required capability. This module
 * never accepts command text, manual receipts or replacement recovery guards. */
import { isDeepStrictEqual } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_SUBSTEPS, deliveryObservationSchema } from './release-delivery-journal.mjs';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { createFullBundleAdapter } from './release-delivery-full.mjs';

const need = (value, code) => { if (!value) throw Error(code); };
const reason = e => /^[a-z][a-z0-9-]{0,99}$/.test(e?.message ?? '') ? e.message : 'dependency-result-rejected';
const phases = PACKAGE_SUBSTEPS.filter(name => name !== 'bundle');
const result = (state, why, context, output = null) => ({ state, reason: why, externalId: context.intent.key, receipt: null, output });
const digest = value => sha256(JSON.stringify(value));
function parent(context) {
  need(isDeepStrictEqual(context.journal.loadDelivery(context.descriptor.operation.id).descriptor, context.descriptor), 'dependency-descriptor-changed');
  const stored = context.journal.deliveryPhase(context.descriptor.operation.id, 'package');
  need(stored && stored.key === context.intent.key && stored.inputSha256 === context.intent.inputSha256, 'dependency-parent-changed');
  return stored;
}
function childContext(context, intent, prior) {
  return { ...context, parentIntent: context.intent, intent, input: intent.input.payload, priorSubsteps: prior,
    // Derived from the immutable reservation, never from the resume clock.
    worker: { operationId: context.intent.key, phaseKey: intent.key, reservedAtMs: intent.createdAtMs,
      runtimeLimitMs: 600000, stopTimeoutMs: 15000, deadlineAtMs: intent.createdAtMs + 615000 } };
}
async function verifyStored(context, name, adapter, prior, clock = Date.now) {
  const row = context.journal.deliveryPhase(context.descriptor.operation.id, 'package/' + name);
  need(row?.state === 'completed', 'dependency-prerequisite-incomplete');
  const child = childContext(context, row, prior);
  try {
    need(row.input.parentKey === context.intent.key && row.input.parentInputSha256 === context.intent.inputSha256, 'dependency-parent-changed');
    need(row.input.priorResultsSha256 === digest(prior), 'dependency-prerequisite-output-changed');
    await adapter.validate(child);
    if (row.current.receipt) readEvidenceFile(row.current.receipt);
    await adapter.verify(row.current, child);
    if (row.validation?.state === 'failed') context.journal.recordDeliveryRevalidation(context.descriptor.operation.id, row.phase,
      { state: 'passed', reason: 'dependency-result-reverified' }, clock());
  } catch (error) {
    context.journal.recordDeliveryRevalidation(context.descriptor.operation.id, row.phase, { state: 'failed', reason: reason(error) }, clock());
    throw error;
  }
  return row.current.output;
}

/** The one-winner/observe-only rule is identical for local writes and remote
 * worker dispatch. `admit` is read-only and runs immediately before reservation. */
export async function advancePackageSubstep(context, name, adapter, { prior = {}, admit, clock = Date.now, inspectOnly = false } = {}) {
  need(PACKAGE_SUBSTEPS.includes(name), 'unsupported-package-substep'); parent(context);
  const id = context.descriptor.operation.id, phase = 'package/' + name;
  const old = context.journal.deliveryPhase(id, phase);
  if (old?.state === 'failed') return old.current;
  if (old?.state === 'completed') { await verifyStored(context, name, adapter, prior, clock); return old.current; }
  if (inspectOnly) return old?.current ?? { state: 'uncertain', key: old?.key ?? context.intent.key,
    externalId: old?.externalId ?? null, reason: 'original-substep-not-completed', receipt: null, output: null };
  const payload = old?.input.payload ?? await adapter.input({ ...context, priorSubsteps: prior });
  const input = old?.input ?? { parentKey: context.intent.key, parentInputSha256: context.intent.inputSha256,
    priorResultsSha256: digest(prior), payload };
  need(input.priorResultsSha256 === digest(prior), 'dependency-prerequisite-output-changed');
  await adapter.validate({ ...context, input: payload, priorSubsteps: prior });
  if (!old) {
    need(typeof context.beforeNewEffect === 'function' && typeof admit === 'function', 'dependency-fresh-admission-required');
    await context.beforeNewEffect(); await admit();
    parent(context);
  }
  const reserved = context.journal.reserveDeliveryPhase(id, phase, input, clock());
  // Another invoker can finish between our initial read and this transaction.
  if (reserved.intent.state === 'completed') { await verifyStored(context, name, adapter, prior, clock); return reserved.intent.current; }
  if (reserved.intent.state === 'failed') return reserved.intent.current;
  const child = childContext(context, reserved.intent, prior);
  let observed, rejectedObservation;
  try { observed = await (reserved.newlyReserved ? adapter.execute(child) : adapter.observe(child)); }
  catch { observed = { state: 'uncertain', externalId: reserved.intent.externalId, receipt: null, output: null, reason: 'dependency-response-unavailable' }; }
  try {
    deliveryObservationSchema.parse({ ...observed, key: reserved.intent.key });
    need(!reserved.intent.externalId || !observed.externalId || reserved.intent.externalId === observed.externalId, 'dependency-external-identity-changed');
    await adapter.verify(observed, child);
  } catch (error) {
    rejectedObservation = observed;
    observed = { state: 'failed', externalId: reserved.intent.externalId, receipt: null, output: { verificationFailed: true }, reason: reason(error) };
  }
  return context.journal.recordDeliveryObservation(id, phase, { ...observed, key: reserved.intent.key }, clock(), { rejectedObservation }).current;
}

export function createDependencyPairProducer({ maintained = null, clock = Date.now } = {}) {
  const missing = context => result('gap', 'qualified-dependency-worker-transport-not-integrated', context);
  const verifyPrefix = async (context, count) => {
    await maintained.validate(context); const prior = {};
    for (const name of phases.slice(0, count)) prior[name] = await verifyStored(context, name, maintained.steps[name], prior, clock);
    return prior;
  };
  const run = async (context, inspectOnly = false) => {
    if (!maintained) return missing(context);
    need(phases.every(name => ['input', 'validate', 'execute', 'observe', 'verify'].every(method => typeof maintained.steps?.[name]?.[method] === 'function'))
      && typeof maintained.normalizePair === 'function' && typeof maintained.verifyPair === 'function', 'maintained-dependency-capabilities-incomplete');
    parent(context); await maintained.validate(context); const prior = {};
    for (const [index, name] of phases.entries()) {
      const value = await advancePackageSubstep(context, name, maintained.steps[name], { clock, prior, inspectOnly,
        admit: async () => { const fresh = await verifyPrefix(context, index); need(isDeepStrictEqual(fresh, prior), 'dependency-prerequisite-output-changed'); } });
      if (value.state !== 'completed') return result(value.state, value.reason, context);
      prior[name] = value.output;
    }
    const output = await maintained.normalizePair(prior.pair, context);
    need(output?.kind === 'maintained-qualified-update-pair' && output.operationId === context.descriptor.operation.id && output.key === context.intent.key
      && isDeepStrictEqual(output.sourceCommits, context.descriptor.operation.sourceCommits)
      && output.candidateId === context.intent.input.route.targetCandidateId && output.publicCandidateId === context.intent.input.route.publicCandidateId
      && output.priorCandidateId === context.descriptor.operation.priorCandidateId, 'dependency-pair-identity-changed');
    await maintained.verifyPair(output, context);
    return result('completed', 'maintained-dependency-pair-completed', context, output);
  };
  return { protocol: 'durable-dependency-substeps-v1', validate: async context => { if (maintained) await maintained.validate(context); },
    execute: context => run(context), observe: context => run(context), inspect: context => run(context, true),
    verify: async (value, context) => { if (value.state === 'completed') need(isDeepStrictEqual(value.output, (await run(context, true)).output), 'dependency-pair-result-changed'); } };
}

/** A completed dependency worker may precede a never-started bundle. Only the
 * newly reserved bundle substep may package; an uncertain bundle only observes. */
export function createDurableFullBundleAdapter({ options, pairProducer = null, pack, clock = Date.now }) {
  const readonlyPair = { validate: context => pairProducer.validate(context), execute: context => pairProducer.inspect(context),
    observe: context => pairProducer.inspect(context), verify: (value, context) => pairProducer.verify(value, context) };
  const base = createFullBundleAdapter({ options, pairProducer: pairProducer ? readonlyPair : null, ...(pack ? { pack } : {}) });
  const run = async (context, inspectOnly = false) => {
    if (!pairProducer) return base.observe(context);
    need(typeof pairProducer.inspect === 'function', 'read-only-pair-inspection-required');
    const pair = await (inspectOnly ? pairProducer.inspect(context) : pairProducer.observe(context));
    await pairProducer.verify(pair, context);
    if (pair.state !== 'completed') return pair;
    const bundlePath = join(context.journal.directory, `delivery-full-${context.intent.key}.json`);
    if (!context.journal.deliveryPhase(context.descriptor.operation.id, 'package/bundle')
      && (existsSync(bundlePath) || existsSync(bundlePath + '.metadata.json')))
      return result('uncertain', 'unreserved-full-bundle-output-present', context);
    const childAdapter = { input: async () => ({ pair: pair.output }), validate: async () => { await base.validate({ ...context, input: context.intent.input }); },
      execute: async () => base.execute(context), observe: async () => base.observe(context), verify: (value) => base.verify(value, context) };
    const value = await advancePackageSubstep(context, 'bundle', childAdapter, { clock, inspectOnly,
      admit: async () => { const fresh = await pairProducer.inspect(context); await pairProducer.verify(fresh, context);
        need(isDeepStrictEqual(fresh, pair), 'bundle-pair-changed-before-effect'); } });
    // Child keys and journal timestamps stay on the child observation. The
    // parent producer returns only fields accepted by the observation contract.
    return { state: value.state, reason: value.reason, externalId: context.intent.key,
      receipt: value.receipt, output: value.output };
  };
  return { input: base.input, validate: base.validate, execute: context => run(context), observe: context => run(context),
    verify: async (value, context) => { if (value.state === 'completed') need(isDeepStrictEqual(value.output, (await run(context, true)).output), 'durable-full-bundle-result-changed'); } };
}
