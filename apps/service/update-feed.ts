import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { updateCandidateIdSchema, type SoftwareUpdateReleaseSummary, type SoftwareUpdateStatus } from '../../packages/domain/software-update.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const updateFeedLimits = Object.freeze({ maxBytes: 128 * 1024, timeoutMs: 10_000, freshnessMs: 36 * HOUR, manualIntervalMs: 5 * 60_000, automaticIntervalMs: DAY });
const version = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[A-Za-z0-9.-]{1,40})?$/);
const hex = updateCandidateIdSchema;
// A signed observation of the installed pair can establish current status
// without inventing an installable bundle for an already installed release.
const currentCandidateSchema = z.object({
  candidateId: hex, novaVersion: version, agentVersion: version,
  platform: z.literal('linux'), arch: z.enum(['x64', 'arm64']), nodeMajor: z.number().int().min(22).max(30),
  schemaVersion: z.number().int().min(1).max(100_000), protocolVersion: z.literal(4),
}).strict();
const releaseSchema = z.object({
  candidateId: hex, novaVersion: version, agentVersion: version, fromCandidateId: hex,
  platform: z.literal('linux'), arch: z.enum(['x64', 'arm64']), nodeMajor: z.number().int().min(22).max(30),
  notes: z.array(z.string().trim().min(1).max(240).regex(/^[^\u0000-\u001f\u007f]*$/)).max(8),
  compatibility: z.object({
    reviewed: z.literal(true), gatewayProtocol: z.literal(4), fromNovaVersion: version, fromAgentVersion: version,
    fromSchemaVersion: z.number().int().min(1).max(100_000), toSchemaVersion: z.number().int().min(1).max(100_000), pluginVersion: version,
  }).strict(),
  recovery: z.object({ pairedSnapshot: z.literal(true), independentRestore: z.literal(true), readinessTimeoutSeconds: z.number().int().min(30).max(600) }).strict(),
  bundle: z.object({ url: z.string().max(2048).url(), bytes: z.number().int().positive().max(8 * 1024 ** 3), sha256: hex, runnerSha256: hex }).strict(),
}).strict().refine(release => release.compatibility.pluginVersion === release.novaVersion, 'The reviewed plugin must match Nova.');
export const updateManifestSchema = z.object({
  format: z.literal(1), channel: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), releases: z.array(releaseSchema).max(32),
  currentCandidates: z.array(currentCandidateSchema).max(32).optional(),
}).strict().refine(manifest => {
  const identities = [...manifest.releases, ...(manifest.currentCandidates ?? [])].map(record => record.candidateId);
  return new Set(identities).size === identities.length;
}, 'Candidate identities must be unique.');
export type UpdateRelease = z.infer<typeof releaseSchema>;
export type UpdateCurrentCandidate = z.infer<typeof currentCandidateSchema>;
export type UpdateManifest = z.infer<typeof updateManifestSchema>;
/** Obtained only after signature, freshness, rollback and exact host checks. Never send this object to the browser. */
export type VerifiedUpdateRelease = UpdateRelease & { manifestSequence: number; manifestExpiresAt: number };
export type UpdateFeedTrust = { url: string; publicKey: string; channel: string; artifactOrigins: string[] };
export type UpdateFeedInstalled = {
  candidateId: string; novaVersion: string; agentVersion?: string; platform: string; arch: string; nodeMajor: number; schemaVersion: number; protocolVersion: number;
};
export type UpdateFeedStore = { read(): unknown; write(state: unknown): void };
export type UpdateFeedStatus = Pick<SoftwareUpdateStatus, 'availability' | 'checkedAt' | 'release' | 'error' | 'notification'>;
export type UpdateFeedOptions = {
  store: UpdateFeedStore; installed(): UpdateFeedInstalled; trust?: UpdateFeedTrust; fetch?: typeof globalThis.fetch; now?: () => number; random?: () => number;
};
const base64 = z.string().min(4).max(updateFeedLimits.maxBytes).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const envelopeSchema = z.object({ payload: base64, signature: z.string().length(88).regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
type Envelope = z.infer<typeof envelopeSchema>;
const cacheSchema = z.object({
  format: z.literal(1), trustId: hex, highestSequence: z.number().int().nonnegative(), highestPayloadHash: hex.optional(),
  envelope: envelopeSchema.optional(), checkedAt: z.number().nonnegative().optional(), attemptedAt: z.number().nonnegative().optional(),
  nextAutomaticAt: z.number().nonnegative().default(0), retryAt: z.number().nonnegative().default(0), failures: z.number().int().min(0).max(30).default(0),
  etag: z.string().max(300).regex(/^[\x20-\x7e]*$/).optional(), error: z.enum(['network', 'invalid', 'storage']).optional(),
  dismissedCandidateId: hex.optional(), notifiedCandidateId: hex.optional(),
}).strict();
type Cache = z.infer<typeof cacheSchema>;
const safeErrors = {
  network: 'Could not reach the update service. Check again later.',
  invalid: 'The update information could not be verified. Check again later.',
  storage: 'The update check could not be saved. Check again later.',
} as const;

function trustedHttps(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('HTTPS address required');
  return url;
}

/** One instance belongs to the workspace host. All tabs reuse its persisted result and in-flight request. */
export class UpdateFeed {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly fetch: typeof globalThis.fetch;
  private readonly key?: KeyObject;
  private readonly trust?: UpdateFeedTrust;
  private cache: Cache;
  private configurationError = false;
  private cacheUnavailable = false;
  private inFlight?: Promise<UpdateFeedStatus>;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private running = false;

  constructor(private readonly options: UpdateFeedOptions) {
    this.now = options.now ?? Date.now; this.random = options.random ?? Math.random; this.fetch = options.fetch ?? globalThis.fetch;
    let trustId = '0'.repeat(64);
    if (options.trust) {
      try {
        const url = trustedHttps(options.trust.url);
        const origins = options.trust.artifactOrigins.map(origin => {
          const parsed = trustedHttps(origin);
          if (parsed.href !== parsed.origin + '/') throw Error('Artifact trust must name an origin');
          return parsed.origin;
        });
        if (!origins.length || origins.length > 8 || !/^[a-z][a-z0-9-]{0,31}$/.test(options.trust.channel)) throw Error('Invalid release trust');
        const key = createPublicKey(options.trust.publicKey);
        if (key.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 required');
        this.key = key;
        this.trust = { ...options.trust, url: url.href, artifactOrigins: [...new Set(origins)].sort() };
        trustId = createHash('sha256').update(JSON.stringify({ ...this.trust, publicKey: key.export({ type: 'spki', format: 'pem' }) })).digest('hex');
      } catch { this.configurationError = true; }
    }
    this.cache = { format: 1, trustId, highestSequence: 0, nextAutomaticAt: 0, retryAt: 0, failures: 0 };
    try {
      const saved = options.store.read();
      const parsed = cacheSchema.safeParse(saved);
      if (parsed.success && parsed.data.trustId === trustId) this.cache = parsed.data;
      // A malformed cache must not silently erase the signed-sequence high water mark.
      else if (!parsed.success && saved !== undefined && saved !== null) this.cacheUnavailable = true;
    } catch { this.cacheUnavailable = true; }
  }

  private decode(envelope: Envelope): { manifest: UpdateManifest; payloadHash: string } {
    if (!this.trust || !this.key) throw Error('No trust');
    const bytes = Buffer.from(envelope.payload, 'base64');
    if (bytes.toString('base64') !== envelope.payload || bytes.length > updateFeedLimits.maxBytes || !verify(null, bytes, this.key, Buffer.from(envelope.signature, 'base64'))) throw Error('Invalid signature');
    const manifest = updateManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const now = this.now(), created = Date.parse(manifest.createdAt), expires = Date.parse(manifest.expiresAt);
    if (manifest.channel !== this.trust.channel || created > now + 5 * 60_000 || expires <= now || expires <= created || expires - created > 31 * DAY) throw Error('Invalid validity period');
    const payloadHash = createHash('sha256').update(bytes).digest('hex');
    if (manifest.sequence < this.cache.highestSequence || (manifest.sequence === this.cache.highestSequence && payloadHash !== this.cache.highestPayloadHash)) throw Error('Release sequence rollback');
    for (const release of manifest.releases) if (!this.trust.artifactOrigins.includes(trustedHttps(release.bundle.url).origin)) throw Error('Untrusted artifact origin');
    return { manifest, payloadHash };
  }

  private latest(): { manifest: UpdateManifest; release?: UpdateRelease; current: boolean } | undefined {
    if (!this.cache.envelope || this.cache.checkedAt === undefined || this.cache.error || this.now() < this.cache.checkedAt || this.now() - this.cache.checkedAt > updateFeedLimits.freshnessMs) return;
    let manifest: UpdateManifest;
    try { manifest = this.decode(this.cache.envelope).manifest; } catch { return; }
    const host = this.options.installed();
    const compatible = manifest.releases.filter(release => release.platform === host.platform && release.arch === host.arch && release.nodeMajor === host.nodeMajor && release.compatibility.gatewayProtocol === host.protocolVersion);
    const current = compatible.some(release => release.candidateId === host.candidateId && release.novaVersion === host.novaVersion && release.agentVersion === host.agentVersion && release.compatibility.toSchemaVersion === host.schemaVersion)
      || (manifest.currentCandidates ?? []).some(record => record.candidateId === host.candidateId && record.novaVersion === host.novaVersion && record.agentVersion === host.agentVersion && record.platform === host.platform && record.arch === host.arch && record.nodeMajor === host.nodeMajor && record.schemaVersion === host.schemaVersion && record.protocolVersion === host.protocolVersion);
    const targets = compatible.filter(release => release.candidateId !== host.candidateId && release.fromCandidateId === host.candidateId && release.compatibility.fromNovaVersion === host.novaVersion && release.compatibility.fromAgentVersion === host.agentVersion && release.compatibility.fromSchemaVersion === host.schemaVersion);
    // Multiple successors would make the supposedly exact review ambiguous.
    return { manifest, ...(targets.length === 1 ? { release: targets[0] } : {}), current: targets.length === 0 && current };
  }

  private summary(release: UpdateRelease): SoftwareUpdateReleaseSummary {
    return { candidateId: release.candidateId, novaVersion: release.novaVersion, agentVersion: release.agentVersion, notes: [...release.notes], downloadBytes: release.bundle.bytes };
  }

  status(): UpdateFeedStatus {
    const checked = this.cache.checkedAt === undefined ? {} : { checkedAt: this.cache.checkedAt };
    if (this.inFlight) return { ...checked, availability: 'checking' };
    if (!this.trust) return { ...checked, availability: 'unavailable', error: this.configurationError ? 'The trusted update service needs host configuration.' : 'A trusted update service has not been configured for this host.' };
    if (this.cacheUnavailable) return { ...checked, availability: 'error', error: 'Saved update verification needs host repair before checking again.' };
    if (this.cache.error) return { ...checked, availability: 'error', error: safeErrors[this.cache.error] };
    const latest = this.latest();
    if (!latest) return { ...checked, availability: 'unavailable', error: this.cache.checkedAt === undefined ? 'Updates have not been checked yet.' : 'The last update information is no longer current. Check again before installing.' };
    if (latest.release) return { ...checked, availability: 'available', release: this.summary(latest.release), ...(this.cache.notifiedCandidateId !== latest.release.candidateId && this.cache.dismissedCandidateId !== latest.release.candidateId ? { notification: { candidateId: latest.release.candidateId } } : {}) };
    if (latest.current) return { ...checked, availability: 'current' };
    return { ...checked, availability: 'unavailable', error: 'No reviewed update is available for this host and its current agent service.' };
  }

  verifiedRelease(candidateId: string): VerifiedUpdateRelease | undefined {
    if (this.inFlight) return;
    const latest = this.latest();
    if (latest?.release?.candidateId !== candidateId) return;
    return { ...structuredClone(latest.release), manifestSequence: latest.manifest.sequence, manifestExpiresAt: Date.parse(latest.manifest.expiresAt) };
  }

  /** The caller emits a quiet workspace event only when this returns a new identity. */
  notification(): SoftwareUpdateReleaseSummary | undefined {
    const state = this.status();
    if (!state.notification || !state.release) return;
    this.cache.notifiedCandidateId = state.notification.candidateId;
    if (!this.persist()) return;
    return state.release;
  }

  dismiss(candidateId: string): UpdateFeedStatus {
    if (updateCandidateIdSchema.safeParse(candidateId).success && this.status().release?.candidateId === candidateId) { this.cache.dismissedCandidateId = candidateId; this.persist(); }
    return this.status();
  }

  private persist() {
    try { this.options.store.write(structuredClone(this.cache)); return true; }
    catch { this.cache.error = 'storage'; return false; }
  }

  check(manual = false): Promise<UpdateFeedStatus> {
    if (this.inFlight) return this.inFlight;
    if (!this.trust || this.cacheUnavailable) return Promise.resolve(this.status());
    const now = this.now();
    if (now < this.cache.retryAt || (manual ? this.cache.attemptedAt !== undefined && now - this.cache.attemptedAt < updateFeedLimits.manualIntervalMs : now < this.cache.nextAutomaticAt)) return Promise.resolve(this.status());
    // Resolve after clearing the checking flag, so every coalesced caller gets the actual result.
    this.inFlight = this.performCheck().finally(() => { this.inFlight = undefined; if (this.running) this.schedule(); }).then(() => this.status());
    return this.inFlight;
  }

  private async performCheck(): Promise<UpdateFeedStatus> {
    const attemptedAt = this.now();
    this.cache.attemptedAt = attemptedAt;
    this.cache.nextAutomaticAt = attemptedAt + DAY + Math.floor(Math.max(0, Math.min(1, this.random())) * 2 * HOUR);
    // Persist admission before network I/O so a service restart cannot bypass poll bounds.
    if (!this.persist()) return this.status();
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), updateFeedLimits.timeoutMs); timeout.unref?.();
    let failure: 'network' | 'invalid' = 'network';
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.cache.etag && this.cache.envelope) headers['If-None-Match'] = this.cache.etag;
      const response = await this.fetch(this.trust!.url, { method: 'GET', headers, redirect: 'error', signal: controller.signal, credentials: 'omit', cache: 'no-store' });
      failure = 'invalid';
      if (response.redirected || (response.url && response.url !== this.trust!.url)) throw Error('Feed redirected');
      let envelope: Envelope;
      if (response.status === 304 && this.cache.envelope) envelope = this.cache.envelope;
      else {
        if (response.status !== 200) { failure = 'network'; throw Error('Feed request failed'); }
        const declared = response.headers.get('content-length');
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > updateFeedLimits.maxBytes)) throw Error('Feed too large');
        if (!response.body) throw Error('Missing feed');
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let received = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            received += value.byteLength;
            if (received > updateFeedLimits.maxBytes) throw Error('Feed too large');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        envelope = envelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      }
      const { manifest, payloadHash } = this.decode(envelope);
      const etag = response.headers.get('etag');
      this.cache = { ...this.cache, envelope, checkedAt: this.now(), highestSequence: manifest.sequence, highestPayloadHash: payloadHash, failures: 0, retryAt: 0, error: undefined,
        etag: etag && etag.length <= 300 && /^[\x20-\x7e]*$/.test(etag) ? etag : response.status === 304 ? this.cache.etag : undefined };
      this.persist();
    } catch {
      const failures = Math.min(30, this.cache.failures + 1);
      this.cache = { ...this.cache, failures, error: failure, retryAt: attemptedAt + Math.min(6 * HOUR, updateFeedLimits.manualIntervalMs * 2 ** Math.min(failures - 1, 20)),
        nextAutomaticAt: Math.max(this.cache.nextAutomaticAt, attemptedAt + Math.min(7 * DAY, DAY * 2 ** Math.min(failures - 1, 4))) };
      this.persist();
    } finally { clearTimeout(timeout); if (this.controller === controller) this.controller = undefined; }
    return this.status();
  }

  start() { if (!this.running) { this.running = true; void this.check(); this.schedule(); } }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.running || !this.trust || this.cacheUnavailable) return;
    const delay = Math.max(1_000, Math.max(this.cache.nextAutomaticAt, this.cache.retryAt) - this.now());
    this.timer = setTimeout(() => { void this.check(); }, delay); this.timer.unref?.();
  }
  stop() { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.controller?.abort(); }
}
