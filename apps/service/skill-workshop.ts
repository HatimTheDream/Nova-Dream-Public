import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProposalEvaluation, ProposalEvents, ProposalList, ProposalView, SavedProposal, SavedProposalSummary } from '../../packages/domain/skill-workshop.js';
import type { AssistantTransport } from './gateway.js';
import { Fault, Store } from './store.js';

const text = z.string().max(20000), name = z.string().min(1).max(500), hash = z.string().regex(/^[a-f0-9]{64}$/);
const status = z.enum(['pending', 'applied', 'rejected', 'quarantined', 'stale']);
const scanState = z.enum(['pending', 'clean', 'failed', 'quarantined']);
const common = { id: name, kind: z.enum(['create', 'update']), status, title: text, description: text, createdAt: name, updatedAt: name };
const target = z.object({ skillName: name, skillKey: name, skillDir: name, skillFile: name, source: name.optional(), currentContentHash: hash.optional() });
const path = z.string().min(1).max(1024).refine(p => !/[\\:\0]/.test(p) && p.split('/').every(part => !!part && part !== '.' && part !== '..'), 'Use a relative support-file path.');
const supportMetadata = z.object({ path, sizeBytes: z.number().int().min(0).max(262144), hash, targetExisted: z.boolean().optional(), targetContentHash: hash.optional() });
const finding = z.object({ ruleId: name, severity: z.enum(['info', 'warn', 'critical']), file: text.optional().default('PROPOSAL.md'), line: z.number().int().positive().optional(), message: text, evidence: text.optional() });
const evaluation = z.object({
  id: name, proposedVersion: name, revisionHash: hash, trigger: z.enum(['manual', 'apply']), startedAt: name, completedAt: name,
  outcomes: z.array(z.object({ pluginId: name, evaluatorId: name, status: z.enum(['completed', 'skipped', 'error']), error: text.optional(),
    result: z.object({ summary: text.optional(), decision: z.enum(['pass', 'revise', 'block']).optional(), decisionReason: text.optional(), findings: z.array(finding).max(200).optional() }).optional(),
  })).max(64),
});
const recordSchema = z.object({
  schema: z.literal('openclaw.skill-workshop.proposal.v1'), ...common, proposedVersion: name, draftHash: hash, target,
  supportFiles: z.array(supportMetadata).max(64).optional(), goal: text.optional(), evidence: text.optional(), statusReason: text.optional(), evaluation: evaluation.optional(),
  scan: z.object({ state: scanState, critical: z.number().int().nonnegative(), warn: z.number().int().nonnegative(), info: z.number().int().nonnegative(), findings: z.array(finding).max(1000) }),
});
const inspectionSchema = z.object({ record: recordSchema, revisionHash: hash, content: z.string().min(1).max(1048576), supportFiles: z.array(z.object({ path, content: z.string().max(262144) })).max(64).optional() });
const listSchema = z.object({ schema: z.literal('openclaw.skill-workshop.proposals-manifest.v1'), proposals: z.array(z.object({ ...common, skillName: name, skillKey: name, scanState, degradedState: z.literal('draft-missing').optional() })).max(5000) });
const eventsSchema = z.object({ events: z.array(z.object({ sequence: z.number().int().positive(), eventId: name, proposalId: name, proposedVersion: name, revisionHash: hash, type: z.enum(['created', 'revised', 'evaluation_completed', 'applied', 'rejected', 'quarantined', 'stale']), occurredAt: name, actor: z.object({ type: z.enum(['agent', 'gateway', 'plugin', 'system']) }), correlationId: name.optional() })).max(200), nextSequence: z.number().int().positive().optional() });
const keepSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), generation: z.string().uuid(), proposalId: name, revisionHash: hash, targetFingerprint: hash }).strict();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = () => new Fault(502, 'workshop_response', 'The host returned an incomplete or unsupported proposal. Refresh before reviewing this version.');
const safeFile = (file: string) => /^[A-Za-z]:[\\/]|^[/\\]/.test(file) ? file.split(/[\\/]/).at(-1) || 'PROPOSAL.md' : file;
const snapshotKey = (id: string) => `skill-workshop:snapshot:${id}`;
const indexPrefix = 'skill-workshop:saved:';
type NativeRecord = z.infer<typeof recordSchema>;
const nativeRevision = (record: NativeRecord) => digest(JSON.stringify({ proposedVersion: record.proposedVersion, contentSha256: record.draftHash, supportFiles: (record.supportFiles ?? []).map(f => ({ path: f.path, sha256: f.hash, sizeBytes: f.sizeBytes })).sort((a, b) => a.path.localeCompare(b.path)) }));
const targetFingerprint = (record: NativeRecord) => digest(JSON.stringify({ kind: record.kind, target: record.target, supportTargets: (record.supportFiles ?? []).map(f => ({ path: f.path, targetExisted: f.targetExisted, targetContentHash: f.targetContentHash })).sort((a, b) => a.path.localeCompare(b.path)) }));
/** Mutation acknowledgements prove identity/status, never full support-file contents. */
export function proposalAcknowledgement(raw: unknown) {
  const parsed = z.union([recordSchema, z.object({ record: recordSchema })]).safeParse(raw);
  if (!parsed.success) throw invalid();
  const record = 'record' in parsed.data ? parsed.data.record : parsed.data;
  return { proposalId: record.id, revisionHash: nativeRevision(record), proposedVersion: record.proposedVersion, status: record.status, kind: record.kind, skillKey: record.target.skillKey, skillName: record.target.skillName, targetFingerprint: targetFingerprint(record) };
}

/** Native proposals remain authoritative. Local copies preserve exactly what was inspected. */
export class SkillWorkshop {
  constructor(private store: Store, private gateway: AssistantTransport, private now = Date.now) {}
  private async read(method: string, params: Record<string, unknown>) {
    const original = this.gateway.status(), epoch = this.store.epoch;
    if (original.state !== 'ready' || !original.generation) throw new Fault(503, 'workshop_disconnected', 'Connect the original Assistant host to read its proposals.');
    if (!original.grantedScopes.includes('operator.read')) throw new Fault(403, 'workshop_scope', 'This connection does not allow reading proposals.');
    if (!original.methods.includes(method)) throw new Fault(501, 'workshop_capability', 'This host does not expose the requested proposal operation.');
    let raw: unknown;
    try { raw = await this.gateway.request(method, { agentId: 'main', ...params }); }
    catch { throw new Fault(503, 'workshop_read', 'The proposal could not be read. Reconnect or refresh this original host.'); }
    const current = this.gateway.status();
    if (current.state !== 'ready' || current.generation !== original.generation || this.store.epoch !== epoch) throw new Fault(409, 'workshop_changed', 'The workspace or Assistant host changed while this proposal was loading.');
    return { raw, generation: original.generation, epoch, observedAt: this.now() };
  }
  async list(): Promise<ProposalList> {
    const read = await this.read('skills.proposals.list', {}), parsed = listSchema.safeParse(read.raw);
    if (!parsed.success || new Set(parsed.data.proposals.map(p => p.id)).size !== parsed.data.proposals.length) throw invalid();
    return { generation: read.generation, observedAt: read.observedAt, proposals: parsed.data.proposals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)) };
  }
  async inspect(proposalId: string): Promise<ProposalView> {
    name.parse(proposalId);
    const read = await this.read('skills.proposals.inspect', { proposalId }), parsed = inspectionSchema.safeParse(read.raw);
    if (!parsed.success) throw invalid();
    const { record, content, revisionHash } = parsed.data, metadata = record.supportFiles ?? [], files = parsed.data.supportFiles ?? [];
    if (record.id !== proposalId || digest(content) !== record.draftHash || new Set(metadata.map(f => f.path.toLowerCase())).size !== metadata.length || new Set(files.map(f => f.path.toLowerCase())).size !== files.length || files.length !== metadata.length) throw invalid();
    const supportFiles = metadata.map(meta => {
      const file = files.find(f => f.path === meta.path);
      if (!file || digest(file.content) !== meta.hash || Buffer.byteLength(file.content) !== meta.sizeBytes) throw invalid();
      return { path: meta.path, content: file.content, sha256: meta.hash, sizeBytes: meta.sizeBytes };
    });
    // Pinned native contract: this revision covers the draft and support files,
    // but NOT the target. Keep a separate target fingerprint for later decisions.
    const expectedRevision = nativeRevision(record);
    if (expectedRevision !== revisionHash) throw invalid();
    const report = record.evaluation && { ...record.evaluation, outcomes: record.evaluation.outcomes.map(o => ({ ...o, ...(o.result ? { result: { ...o.result, findings: o.result.findings?.map(f => ({ ...f, file: safeFile(f.file) })) } } : {}) })) } satisfies ProposalEvaluation | undefined;
    return {
      epoch: read.epoch, generation: read.generation, observedAt: read.observedAt, nativeAgentId: 'main', revisionHash, targetFingerprint: targetFingerprint(record), content, supportFiles,
      record: { id: record.id, kind: record.kind, status: record.status, title: record.title, description: record.description, createdAt: record.createdAt, updatedAt: record.updatedAt, skillName: record.target.skillName, skillKey: record.target.skillKey, source: record.target.source, proposedVersion: record.proposedVersion, goal: record.goal, evidence: record.evidence, statusReason: record.statusReason, scan: { ...record.scan, findings: record.scan.findings.map(f => ({ ...f, file: safeFile(f.file) })) }, evaluation: report },
    };
  }
  async events(proposalId: string, afterSequence = 0): Promise<ProposalEvents> {
    name.parse(proposalId); z.number().int().nonnegative().parse(afterSequence);
    const read = await this.read('skills.proposals.events.list', { proposalId, afterSequence, limit: 100 }), parsed = eventsSchema.safeParse(read.raw);
    if (!parsed.success) throw invalid();
    let previous = afterSequence;
    for (const event of parsed.data.events) { if (event.proposalId !== proposalId || event.sequence <= previous) throw invalid(); previous = event.sequence; }
    if (parsed.data.nextSequence !== undefined && (!parsed.data.events.length || parsed.data.nextSequence !== previous)) throw invalid();
    return { generation: read.generation, observedAt: read.observedAt, ...parsed.data };
  }
  async keep(device: string, input: unknown): Promise<SavedProposal> {
    const cmd = keepSchema.parse(input), intent = JSON.stringify(cmd), operationKey = `skill-workshop:kept-request:${cmd.requestId}`;
    const prior = this.store.internalRead<{ device: string; intent: string; savedId: string }>(operationKey);
    if (cmd.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Review this proposal again.');
    if (prior) {
      if (prior.device !== device || prior.intent !== intent) throw new Fault(409, 'workshop_request', 'This request belongs to another review.');
      return this.saved(prior.savedId);
    }
    const view = await this.inspect(cmd.proposalId);
    if (view.epoch !== cmd.epoch || view.generation !== cmd.generation || view.revisionHash !== cmd.revisionHash || view.targetFingerprint !== cmd.targetFingerprint) throw new Fault(409, 'workshop_revision', 'The proposal or its target changed. Inspect the current version before keeping a review copy.');
    const savedId = digest(JSON.stringify([view.epoch, view.generation, view.record.id, view.revisionHash, view.targetFingerprint]));
    return this.store.admit(device, cmd, { type: 'skill-workshop.keep', ...cmd }, () => {
      const existing = this.store.internalRead<SavedProposal>(snapshotKey(savedId));
      if (existing) { this.store.internalWrite(operationKey, { device, intent, savedId }); return existing; }
      const saved = { ...view, savedId, savedAt: this.now() }, bytes = Buffer.byteLength(JSON.stringify(saved));
      const quota = this.store.internalRead<{ bytes: number; count: number }>('skill-workshop:quota') ?? { bytes: 0, count: 0 };
      if (quota.bytes + bytes > 100 * 1024 * 1024 || quota.count >= 500) throw new Fault(507, 'workshop_storage', 'Saved skill review storage is full. Existing copies are kept.');
      const summary: SavedProposalSummary = { savedId, savedAt: saved.savedAt, epoch: saved.epoch, generation: saved.generation, revisionHash: saved.revisionHash, proposalId: saved.record.id, title: saved.record.title, proposedVersion: saved.record.proposedVersion, status: saved.record.status };
      this.store.internalWrite(snapshotKey(savedId), saved);
      this.store.internalWrite(indexPrefix + savedId, summary);
      this.store.internalWrite('skill-workshop:quota', { bytes: quota.bytes + bytes, count: quota.count + 1 });
      this.store.internalWrite(operationKey, { device, intent, savedId });
      return this.saved(savedId);
    }).value;
  }
  saved(id: string): SavedProposal {
    hash.parse(id); const saved = this.store.internalRead<SavedProposal>(snapshotKey(id));
    if (!saved) throw new Fault(404, 'workshop_saved_missing', 'This saved review copy is unavailable.');
    return saved;
  }
  savedList(): SavedProposalSummary[] { return this.store.internalList<SavedProposalSummary>(indexPrefix).sort((a, b) => b.savedAt - a.savedAt || a.savedId.localeCompare(b.savedId)); }
}
