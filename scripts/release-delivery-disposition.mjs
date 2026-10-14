/** Evidence-backed closure of one demonstrated prewrite failure class.
 * No caller-supplied success receipt, cancellation, cleanup or effect replay.
 * Other failures require their own qualified read-only reconciliation policy. */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { validateFrontendValidityPeriod } from './frontend-contract.mjs';

const need = (v, r) => { if (!v) throw Error(r); };
const canonical = v => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
export const PREWRITE_PREREQUISITES = Object.freeze(['private-source','public-source','private-ci','public-ci','artifacts','route']);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const failedDispositionSchema = z.object({ format:z.literal(1), kind:z.literal('nova-delivery-reconciled-failure'),
  policy:z.literal('frontend-validity-prewrite-v1'), operationId:z.uuid(), targetIdentity:hash, descriptorSha256:hash,
  adapterIdentity:hash, phaseKey:z.uuid(), inputSha256:hash, snapshotSha256:hash, reviewedAtMs:z.number().int().nonnegative(),
  prerequisiteProofs:z.array(z.object({phase:z.enum(PREWRITE_PREREQUISITES),key:z.uuid(),inputSha256:hash,observationSha256:hash}).strict()).length(6),
  failure:z.object({reason:z.literal('noncanonical-frontend-validity-period'),createdAt:z.string(),expiresAt:z.string(),
    canonicalCreatedAt:z.string(),canonicalExpiresAt:z.string(),sameMilliseconds:z.literal(true)}).strict(),
  absentOutputs:z.array(z.string()).length(2), originalFailurePreserved:z.literal(true), hostEffectsFromThisOperation:z.literal(false),
  automaticReplayPermitted:z.literal(false), originalTimelineSha256:hash }).strict();
function absent(path) {
  try { lstatSync(path); throw Error('disposition-partial-output-present'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
/** Synchronous checks are repeated inside the journal transaction immediately
 * before freeing the target. In-memory elapsed time or missing output alone is
 * never sufficient: the original immutable input must prove a prewrite guard. */
export function deriveFailedDisposition(journal, id, reviewedAtMs) {
  const retained = journal.loadDelivery(id), descriptor = retained.descriptor;
  need(retained.state === 'active', 'disposition-operation-not-active');
  need(Number.isSafeInteger(reviewedAtMs) && reviewedAtMs >= retained.created_at, 'disposition-clock-invalid');
  readEvidenceFile(descriptor.target, { maximum:256 * 1024 });
  const names = journal.db.prepare('SELECT phase FROM delivery_phases WHERE operation_id=? ORDER BY phase').all(id).map(r => r.phase);
  need(isDeepStrictEqual(names, [...PREWRITE_PREREQUISITES,'package'].sort()), 'disposition-later-or-unknown-reservation');
  const phases = PREWRITE_PREREQUISITES.map(name => journal.deliveryPhase(id,name)), failed = journal.deliveryPhase(id,'package');
  need(phases.every(p => p?.state === 'completed' && p.validation?.state !== 'failed'), 'disposition-prerequisites-not-complete');
  need(failed?.state === 'failed' && failed.current && failed.current.observedAtMs <= reviewedAtMs, 'disposition-positive-terminal-failure-required');
  need(failed.externalId === null && failed.current.receipt === null, 'disposition-effect-identity-present');
  // A rejected completed claim might conceal an actual effect. Only the known
  // synchronous packager's failed/uncertain response may satisfy this policy.
  const rejected = journal.db.prepare("SELECT payload_json,payload_hash FROM delivery_events WHERE operation_id=? AND kind='rejected-producer-observation'").all(id);
  for (const row of rejected) {
    need(sha256(row.payload_json) === row.payload_hash, 'disposition-rejected-history-changed');
    const value = JSON.parse(row.payload_json);
    if (value.phase === 'package') need(['uncertain','failed'].includes(value.claim?.state?.value), 'disposition-rejected-effect-claim');
  }
  need(!journal.db.prepare('SELECT id FROM operations WHERE id=?').get(id) && !journal.intent(id), 'disposition-coordinator-effect-present');
  const input = failed.input, route = phases.at(-1).current.output;
  need(input.route?.route === 'frontend' && isDeepStrictEqual(input.route,route), 'disposition-frontend-route-required');
  const { createdAt, expiresAt } = input.options ?? {};
  need(typeof createdAt === 'string' && typeof expiresAt === 'string', 'disposition-validity-evidence-required');
  let refused = false;
  try { validateFrontendValidityPeriod(createdAt,expiresAt); }
  catch (error) { need(error.message === 'Invalid frontend validity period.', 'disposition-unknown-validation-refusal'); refused = true; }
  need(refused && Number.isFinite(Date.parse(createdAt)) && Number.isFinite(Date.parse(expiresAt)), 'disposition-proven-prewrite-refusal-required');
  const canonicalCreatedAt = new Date(Date.parse(createdAt)).toISOString(), canonicalExpiresAt = new Date(Date.parse(expiresAt)).toISOString();
  validateFrontendValidityPeriod(canonicalCreatedAt,canonicalExpiresAt);
  need(createdAt !== canonicalCreatedAt || expiresAt !== canonicalExpiresAt, 'disposition-noncanonical-time-required');
  const outputs = [join(journal.directory,'delivery-package-'+failed.key),join(journal.directory,'delivery-signature-'+failed.key+'.sig')];
  outputs.forEach(absent);
  // All such local output names must be attributable. This first policy is
  // intentionally conservative when a shared journal has unrelated artifacts.
  need(!readdirSync(journal.directory).some(name => /^(delivery-package-|delivery-signature-|delivery-full-|dependency-)/.test(name)), 'disposition-unaccounted-local-output');
  for (const phase of phases) if (phase.current.receipt) readEvidenceFile(phase.current.receipt);
  const prerequisiteProofs = phases.map(p => ({phase:p.phase,key:p.key,inputSha256:p.inputSha256,observationSha256:sha256(canonical(p.current))}));
  return failedDispositionSchema.parse({format:1,kind:'nova-delivery-reconciled-failure',policy:'frontend-validity-prewrite-v1',
    operationId:id,targetIdentity:descriptor.targetIdentity,descriptorSha256:retained.descriptor_hash,adapterIdentity:descriptor.adapterIdentity,
    phaseKey:failed.key,inputSha256:failed.inputSha256,snapshotSha256:sha256(canonical([...phases,failed])),reviewedAtMs,prerequisiteProofs,
    failure:{reason:'noncanonical-frontend-validity-period',createdAt,expiresAt,canonicalCreatedAt,canonicalExpiresAt,sameMilliseconds:true},
    absentOutputs:outputs,originalFailurePreserved:true,hostEffectsFromThisOperation:false,automaticReplayPermitted:false,
    originalTimelineSha256:sha256(canonical(journal.deliveryTimeline(id,reviewedAtMs).timeline))});
}

export async function reconcileFailedDelivery(journal,id,registry,{clock=Date.now}={}) {
  const old = journal.deliveryDisposition(id);
  if (old) return journal.deliveryStatus(id,clock());
  const descriptor = journal.loadDelivery(id).descriptor;
  need(await registry.identity(descriptor) === descriptor.adapterIdentity, 'delivery-adapter-changed');
  need(await registry.targetIdentity(descriptor) === descriptor.targetIdentity, 'delivery-target-changed');
  const before = deriveFailedDisposition(journal,id,clock()), prior = {};
  for (const phase of PREWRITE_PREREQUISITES) {
    const intent = journal.deliveryPhase(id,phase), adapter = registry.adapter(phase,descriptor,prior);
    need(adapter && typeof adapter.validate === 'function' && typeof adapter.verify === 'function', 'disposition-prerequisite-verifier-missing');
    await adapter.validate({descriptor,prior,input:intent.input});
    await adapter.verify(intent.current,{descriptor,prior,intent,journal});
    prior[phase] = intent.current.output;
  }
  // The existing package validator verifies exact retained canonical sources.
  const pack = journal.deliveryPhase(id,'package'), adapter = registry.adapter('package',descriptor,prior);
  need(adapter && typeof adapter.validate === 'function', 'disposition-package-verifier-missing');
  await adapter.validate({descriptor,prior,input:pack.input});
  const after = deriveFailedDisposition(journal,id,before.reviewedAtMs);
  need(isDeepStrictEqual(before,after), 'disposition-original-operation-changed');
  need(await registry.identity(descriptor) === descriptor.adapterIdentity, 'delivery-adapter-changed');
  need(await registry.targetIdentity(descriptor) === descriptor.targetIdentity, 'delivery-target-changed');
  return journal.recordFailedDeliveryDisposition(id,after,clock());
}
