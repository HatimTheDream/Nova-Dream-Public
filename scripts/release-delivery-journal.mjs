/** Additive early-phase records in ReleaseJournal's existing database.
 * Never dispatches, installs, snapshots or opens another journal. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assessTimeline, readEvidenceFile, releaseOperationSchema, releaseTimelineSchema, sha256, validateOperationContinuation } from './release-plan.mjs';
import { deriveFailedDisposition, failedDispositionSchema } from './release-delivery-disposition.mjs';
import { capabilityDispositionSchema, deriveCapabilityDisposition, predecessorRecoverySchema } from './release-delivery-capability-disposition.mjs';

const hash = z.string().regex(/^[a-f0-9]{64}$/), commit = z.string().regex(/^[a-f0-9]{40}$/);
const reference = z.object({ path: z.string().min(1).max(4096), sha256: hash }).strict();
const source = z.object({ root: z.string().min(1).max(4096), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), commit, baseCommit: commit, branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_/-]{0,99}$/) }).strict();
export const DELIVERY_PHASES = Object.freeze(['private-source', 'public-source', 'private-ci', 'public-ci', 'artifacts', 'route', 'package', 'sign', 'capacity', 'recovery', 'publication', 'installation', 'assistant', 'browser']);
export const PACKAGE_SUBSTEPS = Object.freeze(['dependency-stage', 'dependency-plan', 'dependency-intent', 'dependency-execute', 'dependency-retrieval', 'pair', 'bundle']);
export const ASSISTANT_SUBSTEPS = Object.freeze(['session', 'create', 'draft', 'submit', 'saved-reply']);
export const closedDeliveryState = state => ['reconciled-failed','reconciled-gap'].includes(state);
const dispositionSchema = z.discriminatedUnion('kind',[failedDispositionSchema,capabilityDispositionSchema]);
export const deliveryDescriptorSchema = z.object({ format: z.literal(1), operation: releaseOperationSchema,
  sources: z.object({ private: source, public: source }).strict(), target: reference, targetIdentity: hash,
  timeline: releaseTimelineSchema, adapterIdentity: hash, predecessorRecovery:predecessorRecoverySchema.optional(), observationBudgetMs: z.number().int().min(60000).max(86400000).default(14400000) }).strict().superRefine((v, ctx) => {
  if (v.sources.private.repository === v.sources.public.repository || v.sources.private.root === v.sources.public.root)
    ctx.addIssue({ code: 'custom', message: 'Independent source histories required.' });
  for (const side of ['private', 'public']) if (v.operation.sourceCommits[side] !== v.sources[side].commit)
    ctx.addIssue({ code: 'custom', message: 'Committed source identity mismatch.' });
});
const stateSchema = z.enum(['running', 'completed', 'failed', 'uncertain', 'gap']);
export const deliveryObservationSchema = z.object({ state: stateSchema, key: z.uuid(),
  externalId: z.string().min(1).max(256).nullable(), reason: z.string().regex(/^[a-z][a-z0-9-]{0,99}$/),
  receipt: reference.nullable(), output: z.record(z.string(), z.unknown()).nullable() }).strict();
const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const need = (v, code) => { if (!v) throw Error(code); };
const time = n => { need(Number.isSafeInteger(n) && n >= 0, 'invalid-clock'); return n; };
const encoded = v => { const text = canonical(v); need(Buffer.byteLength(text) <= 2 * 1024 ** 2, 'delivery-record-too-large'); return { text, hash: sha256(text) }; };
const decoded = (text, digest) => { need(sha256(text) === digest, 'delivery-record-hash-mismatch'); return JSON.parse(text); };
function rejectedClaim(raw) {
  // Diagnostic claims only: never open a claimed receipt or use its ID as an
  // observation identity. Retain bounded original fields even when malformed.
  const bounded = (v, limit) => typeof v === 'string' ? { value: v.slice(0, limit), truncated: v.length > limit } : { value: null, type: typeof v };
  let output; try { output = canonical(raw?.output ?? null); } catch { output = '[unserializable]'; }
  return { authority: 'untrusted-rejected-producer-claim', state: bounded(raw?.state, 64), reason: bounded(raw?.reason, 256),
    externalId: bounded(raw?.externalId, 256), receipt: { path: bounded(raw?.receipt?.path, 4096), sha256: bounded(raw?.receipt?.sha256, 256) },
    output: bounded(output, 65536) };
}

// user_version remains 1: additive tables allow the original coordinator to
// continue reading its own immutable operations/checkpoints/intents/events.
export function ensureDeliverySchema(journal) {
  const present = journal.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deliveries'").get();
  const dispositions = journal.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_dispositions'").get();
  if (present && dispositions) {
    if(journal.readOnly)return;
    const index=journal.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='delivery_active_target'").get();
    if(index?.sql.includes("'reconciled-gap'"))return;
    journal.transaction(()=>journal.db.exec("DROP INDEX IF EXISTS delivery_active_target; CREATE UNIQUE INDEX delivery_active_target ON deliveries(target_identity) WHERE state NOT IN ('completed','reconciled-failed','reconciled-gap');"));return;
  }
  if (present && journal.readOnly) return;
  need(!journal.readOnly, 'delivery-schema-not-initialized');
  journal.transaction(() => journal.db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, descriptor_json TEXT NOT NULL, descriptor_hash TEXT NOT NULL, target_identity TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL);
    DROP INDEX IF EXISTS delivery_active_target;
    CREATE UNIQUE INDEX delivery_active_target ON deliveries(target_identity) WHERE state NOT IN ('completed','reconciled-failed','reconciled-gap');
    CREATE TABLE IF NOT EXISTS delivery_dispositions(operation_id TEXT PRIMARY KEY REFERENCES deliveries(id), at_ms INTEGER NOT NULL, proof_json TEXT NOT NULL, proof_hash TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS delivery_dispositions_no_update BEFORE UPDATE ON delivery_dispositions BEGIN SELECT RAISE(ABORT,'immutable-delivery-disposition'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_dispositions_no_delete BEFORE DELETE ON delivery_dispositions BEGIN SELECT RAISE(ABORT,'immutable-delivery-disposition'); END;
    CREATE TABLE IF NOT EXISTS delivery_phases(operation_id TEXT NOT NULL REFERENCES deliveries(id), phase TEXT NOT NULL, key TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL, input_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(operation_id,phase));
    CREATE TABLE IF NOT EXISTS delivery_observations(id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, phase TEXT NOT NULL, at_ms INTEGER NOT NULL, observation_json TEXT NOT NULL, observation_hash TEXT NOT NULL, FOREIGN KEY(operation_id,phase) REFERENCES delivery_phases(operation_id,phase));
    CREATE TABLE IF NOT EXISTS delivery_events(id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES deliveries(id), at_ms INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS delivery_phases_no_update BEFORE UPDATE ON delivery_phases BEGIN SELECT RAISE(ABORT,'immutable-delivery-phase'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_phases_no_delete BEFORE DELETE ON delivery_phases BEGIN SELECT RAISE(ABORT,'immutable-delivery-phase'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_observations_no_update BEFORE UPDATE ON delivery_observations BEGIN SELECT RAISE(ABORT,'immutable-delivery-observation'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_observations_no_delete BEFORE DELETE ON delivery_observations BEGIN SELECT RAISE(ABORT,'immutable-delivery-observation'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_events_no_update BEFORE UPDATE ON delivery_events BEGIN SELECT RAISE(ABORT,'immutable-delivery-event'); END;
    CREATE TRIGGER IF NOT EXISTS delivery_events_no_delete BEFORE DELETE ON delivery_events BEGIN SELECT RAISE(ABORT,'immutable-delivery-event'); END;
  `));
}
function event(journal, id, kind, value, now) {
  const latest = journal.db.prepare('SELECT at_ms FROM delivery_events WHERE operation_id=? ORDER BY id DESC LIMIT 1').get(id);
  need(!latest || time(now) >= latest.at_ms, 'journal-clock-moved-backwards');
  need(journal.db.prepare('SELECT count(*) AS n FROM delivery_events').get().n < 10000, 'release-journal-event-limit');
  const v = encoded(value); journal.db.prepare('INSERT INTO delivery_events(operation_id,at_ms,kind,payload_json,payload_hash) VALUES(?,?,?,?,?)').run(id, now, kind, v.text, v.hash);
}
export const deliveryJournalMethods = {
  initializeDelivery(raw, now = Date.now()) {
    const d = deliveryDescriptorSchema.parse(raw), v = encoded(d); ensureDeliverySchema(this);
    readEvidenceFile(d.target, { maximum: 256 * 1024 });
    return this.transaction(() => {
      const old = this.db.prepare('SELECT descriptor_hash FROM deliveries WHERE id=?').get(d.operation.id);
      if (old) { need(old.descriptor_hash === v.hash, 'existing-delivery-input-changed'); return this.deliveryStatus(d.operation.id, now); }
      need(!this.db.prepare("SELECT operation_id FROM intents WHERE transport_identity=? AND state IN ('reserved','running','uncertain') AND operation_id<>?").get(d.targetIdentity, d.operation.id), 'target-install-already-active');
      this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?)').run(d.operation.id, v.text, v.hash, d.targetIdentity, time(now), 'active');
      event(this, d.operation.id, 'initialized', { descriptorSha256: v.hash, originalDeadline: d.timeline.original }, now);
      event(this, d.operation.id, 'timeline', this.deliveryTimeline(d.operation.id, now), now);
      return this.deliveryStatus(d.operation.id, now);
    });
  },
  loadDelivery(id) {
    z.uuid().parse(id); const row = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id); need(row, 'delivery-not-found');
    return { ...row, descriptor: deliveryDescriptorSchema.parse(decoded(row.descriptor_json, row.descriptor_hash)) };
  },
  deliveryDisposition(id) {
    z.uuid().parse(id);
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_dispositions'").get()) return null;
    const row = this.db.prepare('SELECT * FROM delivery_dispositions WHERE operation_id=?').get(id);
    if (!row) return null;
    const proof = dispositionSchema.parse(decoded(row.proof_json,row.proof_hash));
    need(proof.operationId === id, 'stored-disposition-operation-changed');
    return { recordedAtMs:row.at_ms, proof, sha256:row.proof_hash };
  },
  recordFailedDeliveryDisposition(id, raw, now = Date.now()) {
    ensureDeliverySchema(this); const proof = failedDispositionSchema.parse(raw);
    return this.transaction(() => {
      const old = this.deliveryDisposition(id);
      if (old) { need(canonical(old.proof) === canonical(proof), 'existing-disposition-changed'); return this.deliveryStatus(id,now); }
      need(proof.operationId === id && time(now) >= proof.reviewedAtMs && now-proof.reviewedAtMs <= 60000, 'disposition-stale-or-wrong-operation');
      need(canonical(proof) === canonical(deriveFailedDisposition(this,id,proof.reviewedAtMs)), 'disposition-evidence-changed');
      const value = encoded(proof);
      this.db.prepare('INSERT INTO delivery_dispositions VALUES(?,?,?,?)').run(id,now,value.text,value.hash);
      this.db.prepare("UPDATE deliveries SET state='reconciled-failed' WHERE id=? AND state='active'").run(id);
      event(this,id,'failed-operation-reconciled',{policy:proof.policy,proofSha256:value.hash,phaseKey:proof.phaseKey,automaticReplayPermitted:false},now);
      return this.deliveryStatus(id,now);
    });
  },
  recordCapabilityDisposition(id,raw,now=Date.now(),{assertAbsent}={}) {
    ensureDeliverySchema(this);const proof=capabilityDispositionSchema.parse(raw);
    return this.transaction(()=>{
      const old=this.deliveryDisposition(id);
      if(old){need(canonical(old.proof)===canonical(proof),'existing-disposition-changed');return this.deliveryStatus(id,now);}
      need(proof.operationId===id&&time(now)>=proof.reviewedAtMs&&now-proof.reviewedAtMs<=60000,'disposition-stale-or-wrong-operation');
      need(canonical(proof)===canonical(deriveCapabilityDisposition(this,id,proof.request,proof.reviewedAtMs,{assertAbsent})),'disposition-evidence-changed');
      const value=encoded(proof);this.db.prepare('INSERT INTO delivery_dispositions VALUES(?,?,?,?)').run(id,now,value.text,value.hash);
      this.db.prepare("UPDATE deliveries SET state='reconciled-gap' WHERE id=? AND state='active'").run(id);
      event(this,id,'capability-gap-reconciled',{policy:proof.policy,proofSha256:value.hash,phase:'package',reserved:false,automaticReplayPermitted:false},now);
      return this.deliveryStatus(id,now);
    });
  },
  deliveryPhase(id, phase) {
    const row = this.db.prepare('SELECT * FROM delivery_phases WHERE operation_id=? AND phase=?').get(id, phase); if (!row) return null;
    const observations = this.db.prepare('SELECT * FROM delivery_observations WHERE operation_id=? AND phase=? ORDER BY id').all(id, phase);
    let current = null, terminal = false, externalId = null;
    for (const item of observations) {
      const value = deliveryObservationSchema.parse(decoded(item.observation_json, item.observation_hash));
      need(value.key === row.key, 'stored-phase-key-changed');
      if (terminal) continue;
      need(!externalId || !value.externalId || value.externalId === externalId, 'stored-external-identity-changed');
      externalId = value.externalId ?? externalId; current = { ...value, externalId, observedAtMs: item.at_ms };
      terminal = ['completed', 'failed'].includes(value.state);
    }
    const validation = this.db.prepare("SELECT payload_json,payload_hash FROM delivery_events WHERE operation_id=? AND kind='phase-revalidated' ORDER BY id DESC").all(id)
      .map(item => decoded(item.payload_json, item.payload_hash)).find(item => item.phase === phase) ?? null;
    return { phase, key: row.key, createdAtMs: row.created_at, input: decoded(row.input_json, row.input_hash), inputSha256: row.input_hash,
      state: current?.state ?? 'reserved', externalId, current, validation };
  },
  reserveDeliveryPhase(id, phase, input, now = Date.now()) {
    const substep = phase.startsWith('package/') ? phase.slice(8) : null;
    const assistantStep = phase.startsWith('assistant/') ? phase.slice(10) : null;
    need(DELIVERY_PHASES.includes(phase) || PACKAGE_SUBSTEPS.includes(substep) || ASSISTANT_SUBSTEPS.includes(assistantStep), 'unsupported-delivery-phase'); const v = encoded(input);
    return this.transaction(() => {
      need(!closedDeliveryState(this.loadDelivery(id).state), 'delivery-operation-reconciled'); const old = this.deliveryPhase(id, phase);
      if (old) { need(old.inputSha256 === v.hash, 'phase-input-changed'); return { newlyReserved: false, intent: old }; }
      if (substep) {
        const parent = this.deliveryPhase(id, 'package');
        need(parent && !['completed', 'failed'].includes(parent.state) && parent.validation?.state !== 'failed'
          && input.parentKey === parent.key && input.parentInputSha256 === parent.inputSha256, 'package-parent-intent-mismatch');
        const dependencies = PACKAGE_SUBSTEPS.slice(0, PACKAGE_SUBSTEPS.indexOf(substep));
        // A bundle may also consume a separately qualified pair producer. Its
        // own adapter verifies that producer before this reservation.
        if (substep !== 'bundle') for (const name of dependencies) {
          const dependency = this.deliveryPhase(id, 'package/' + name);
          need(dependency?.state === 'completed' && dependency.validation?.state !== 'failed', 'package-substep-prerequisite-incomplete');
        }
      }
      if (assistantStep) {
        const parent = this.deliveryPhase(id, 'assistant');
        need(parent && !['completed', 'failed'].includes(parent.state) && parent.validation?.state !== 'failed'
          && input.parentKey === parent.key && input.parentInputSha256 === parent.inputSha256
          && input.deadlineAtMs === parent.createdAtMs + 300000 && time(now) < input.deadlineAtMs, 'assistant-parent-intent-mismatch');
        for (const name of ASSISTANT_SUBSTEPS.slice(0, ASSISTANT_SUBSTEPS.indexOf(assistantStep))) {
          const dependency = this.deliveryPhase(id, 'assistant/' + name);
          need(dependency?.state === 'completed' && dependency.validation?.state !== 'failed', 'assistant-substep-prerequisite-incomplete');
        }
      }
      const assessed = this.deliveryTimeline(id, now);
      need(assessed.eta.dueReviews.length === 0 && assessed.eta.suspendNewAttemptsFor.length === 0, 'delivery-overrun-review-required');
      const key = randomUUID(); this.db.prepare('INSERT INTO delivery_phases VALUES(?,?,?,?,?,?)').run(id, phase, key, v.text, v.hash, time(now));
      event(this, id, 'phase-reserved', { phase, key, inputSha256: v.hash }, now);
      return { newlyReserved: true, intent: this.deliveryPhase(id, phase) };
    });
  },
  recordDeliveryObservation(id, phase, raw, now = Date.now(), { rejectedObservation } = {}) {
    const value = deliveryObservationSchema.parse(raw); if (value.receipt) readEvidenceFile(value.receipt);
    need(value.state !== 'completed' || value.output !== null, 'completed-phase-output-required');
    return this.transaction(() => {
      need(!closedDeliveryState(this.loadDelivery(id).state), 'delivery-operation-reconciled');
      const old = this.deliveryPhase(id, phase); need(old && value.key === old.key, 'phase-intent-mismatch');
      need(!old.externalId || !value.externalId || old.externalId === value.externalId, 'external-job-identity-changed');
      need(time(now) >= (old.current?.observedAtMs ?? old.createdAtMs), 'journal-clock-moved-backwards');
      if (rejectedObservation !== undefined) {
        need(value.state === 'failed' && value.externalId === old.externalId && value.receipt === null, 'rejected-observation-cannot-admit-identity');
        event(this, id, 'rejected-producer-observation', { phase, key: old.key, trustedExternalId: old.externalId, reason: value.reason,
          claim: rejectedClaim(rejectedObservation) }, now);
      }
      const v = encoded(value); this.db.prepare('INSERT INTO delivery_observations(operation_id,phase,at_ms,observation_json,observation_hash) VALUES(?,?,?,?,?)').run(id, phase, now, v.text, v.hash);
      event(this, id, ['completed', 'failed'].includes(old.state) ? 'terminal-observation-retained' : 'phase-observed', { phase, observationSha256: v.hash }, now);
      event(this, id, 'timeline', this.deliveryTimeline(id, now), now);
      return this.deliveryPhase(id, phase);
    });
  },
  recordDeliveryRevalidation(id, phase, validation, now = Date.now()) {
    const value = z.object({ state: z.enum(['passed', 'failed']), reason: z.string().regex(/^[a-z][a-z0-9-]{0,99}$/) }).strict().parse(validation);
    return this.transaction(() => { need(!closedDeliveryState(this.loadDelivery(id).state), 'delivery-operation-reconciled');
      need(this.deliveryPhase(id, phase)?.state === 'completed', 'revalidation-requires-completed-phase');
      event(this, id, 'phase-revalidated', { phase, ...value }, now); return this.deliveryPhase(id, phase); });
  },
  attachDeliveryCoordinator(id, descriptor, description, now = Date.now()) {
    const retained = this.loadDelivery(id); need(!closedDeliveryState(retained.state), 'delivery-operation-reconciled');
    const d = retained.descriptor;
    validateOperationContinuation(descriptor.input.operation, d.operation);
    need(descriptor.input.operation.id === id, 'coordinator-operation-changed');
    need(description.scopeIdentity === d.targetIdentity, 'coordinator-target-changed');
    const timeline = this.deliveryTimeline(id, now).timeline;
    need(canonical(descriptor.input.timeline) === canonical(timeline), 'coordinator-timeline-changed');
    return this.initialize(descriptor, description, now);
  },
  deliveryTimeline(id, now = Date.now(), proposed) {
    const descriptor = this.loadDelivery(id).descriptor;
    const row = this.db.prepare("SELECT payload_json,payload_hash FROM delivery_events WHERE operation_id=? AND kind='timeline' ORDER BY id DESC LIMIT 1").get(id);
    const previous = row ? decoded(row.payload_json, row.payload_hash) : null;
    const timeline = releaseTimelineSchema.parse(proposed ?? previous?.timeline ?? descriptor.timeline);
    const map = { 'private-ci': ['private-ci'], 'public-ci': ['public-ci'], package: ['package', 'sign'], capacity: ['capacity'], recovery: ['recovery'],
      publication: ['publication'], installation: ['installation'], acceptance: ['assistant', 'browser'] };
    const phases = Object.entries(map).map(([name, children]) => {
      const rows = children.map(phase => this.deliveryPhase(id, phase));
      return rows.every(p => p?.state === 'completed' && p.validation?.state !== 'failed') ? { id: name, state: 'passed', firstVerifiedAtMs: Math.max(...rows.map(p => p.current.observedAtMs)), verifiedAtMs: Math.max(...rows.map(p => p.current.observedAtMs)) }
        : { id: name, state: 'missing' };
    });
    const completedAt = phases.every(p => p.state === 'passed') ? Math.max(...phases.map(p => p.verifiedAtMs)) : undefined;
    return { timeline, eta: assessTimeline(timeline, { nowMs: now, previous: previous?.timeline ?? descriptor.timeline, previousAssessments: previous?.eta.deadlineAssessments ?? [], phases, operationCompletedAtMs: completedAt }) };
  },
  checkpointDelivery(id, timeline, now = Date.now()) {
    return this.transaction(() => { need(!closedDeliveryState(this.loadDelivery(id).state), 'delivery-operation-reconciled');
      const value = this.deliveryTimeline(id, now, timeline); event(this, id, 'timeline', value, now); return value; });
  },
  deliveryStatus(id, now = Date.now()) {
    const d = this.loadDelivery(id), phases = DELIVERY_PHASES.map(phase => this.deliveryPhase(id, phase));
    const complete = phases.every(p => p?.state === 'completed' && p.validation?.state !== 'failed');
    const disposition = this.deliveryDisposition(id);
    need(!closedDeliveryState(d.state) || disposition, 'delivery-disposition-missing');
    return { format: 1, kind: 'nova-release-delivery', operationId: id, complete, closed: closedDeliveryState(d.state), disposition,
      createdAtMs: d.created_at, elapsedMs: Math.max(0, now - d.created_at),
      originalEstimate: d.descriptor.timeline.original, originalDeadlineAtMs: d.descriptor.timeline.original.remainingMs === null ? null : d.descriptor.timeline.original.issuedAtMs + d.descriptor.timeline.original.remainingMs[1], eta: this.deliveryTimeline(id, now).eta,
      packageSubsteps: PACKAGE_SUBSTEPS.map(name => { const row = this.deliveryPhase(id, 'package/' + name); return { name,
        state: row?.validation?.state === 'failed' ? 'failed' : row?.state ?? 'pending', key: row?.key ?? null,
        externalId: row?.externalId ?? null, createdAtMs: row?.createdAtMs ?? null, observedAtMs: row?.current?.observedAtMs ?? null }; }),
      assistantSubsteps: ASSISTANT_SUBSTEPS.map(name => { const row = this.deliveryPhase(id, 'assistant/' + name); return { name,
        state: row?.validation?.state === 'failed' ? 'failed' : row?.state ?? 'pending', key: row?.key ?? null,
        externalId: row?.externalId ?? null, createdAtMs: row?.createdAtMs ?? null, observedAtMs: row?.current?.observedAtMs ?? null }; }),
      phases: DELIVERY_PHASES.map((phase, i) => ({ phase, state: phases[i]?.validation?.state === 'failed' ? 'failed' : phases[i]?.state ?? 'pending', key: phases[i]?.key ?? null,
        externalId: phases[i]?.externalId ?? null, elapsedMs: phases[i] ? Math.max(0, (phases[i].current?.observedAtMs ?? now) - phases[i].createdAtMs) : null,
        reason: phases[i]?.validation?.state === 'failed' ? phases[i].validation.reason : phases[i]?.current?.reason ?? null })) };
  },
  completeDelivery(id, now = Date.now()) {
    return this.transaction(() => { need(this.deliveryStatus(id, now).complete, 'delivery-acceptance-incomplete');
      this.db.prepare("UPDATE deliveries SET state='completed' WHERE id=?").run(id); event(this, id, 'completed', {}, now); return this.deliveryStatus(id, now); });
  },
};
