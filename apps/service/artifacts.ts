import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AssistantTransport } from './gateway.js';
import { Fault } from './store.js';
import { isBase64 } from '../../packages/domain/base64.js';

export const artifactByteLimit = 8 * 1024 * 1024;
export type ArtifactSource = { nativeKey: string; nativeId: string; connectionGeneration: string; artifactId: string };
export type ArtifactBytes = { bytes: Buffer; name: string; mimeType: string; sha256: string; type: string };
const grantSchema = z.object({
  artifact: z.object({ id: z.string(), sessionKey: z.string(), title: z.string().max(2000), type: z.string(), mimeType: z.string().max(200).optional(), sizeBytes: z.number().int().nonnegative().optional(), download: z.object({ mode: z.enum(['bytes', 'url', 'unsupported']) }) }),
  encoding: z.literal('base64').optional(), data: z.string().max(Math.ceil(artifactByteLimit / 3) * 4).optional(), url: z.string().max(12000).optional(), expiresAt: z.string().max(100).optional(),
});
const changed = () => new Fault(409, 'artifact_source_changed', 'The original output connection changed. Reopen its source before downloading.');

/** Reads transcript-authorized bytes. Grants and credentials never enter app records. */
export class ArtifactReader {
  private generation = 0;
  private closed = false;
  private pending = new Set<AbortController>();
  private unsubscribe: () => void;
  constructor(private gateway: AssistantTransport, private exchange: typeof fetch = fetch) {
    this.unsubscribe = gateway.subscribe(event => {
      if (event.event === 'e3.connected' || event.event === 'e3.history-gap') {
        ++this.generation;
        for (const controller of this.pending) controller.abort();
      }
    });
  }
  close() { this.closed = true; ++this.generation; this.unsubscribe(); for (const controller of this.pending) controller.abort(); }
  async read(source: ArtifactSource, verifySource: () => Promise<void>): Promise<ArtifactBytes> {
    const generation = this.generation, abort = new AbortController();
    this.pending.add(abort);
    const check = () => {
      const status = this.gateway.status();
      if (this.closed || abort.signal.aborted || generation !== this.generation || status.state !== 'ready' || status.generation !== source.connectionGeneration) throw changed();
      if (!status.grantedScopes.includes('operator.read') || !status.methods.includes('artifacts.download')) throw new Fault(409, 'artifact_unavailable', 'This host does not offer output downloads for Nova Dream.');
      return status;
    };
    try {
      check(); await verifySource(); check();
      for (let attempt = 0; attempt < 2; attempt++) {
        const grant = grantSchema.parse(await this.gateway.request('artifacts.download', { sessionKey: source.nativeKey, artifactId: source.artifactId }));
        const status = check(), artifact = grant.artifact;
        if (artifact.id !== source.artifactId || artifact.sessionKey !== source.nativeKey) throw changed();
        if (artifact.sizeBytes !== undefined && artifact.sizeBytes > artifactByteLimit) throw new Fault(413, 'artifact_too_large', 'This output exceeds the preview’s 8 MB file limit.');
        let bytes: Buffer;
        if (artifact.download.mode === 'bytes') {
          if (grant.encoding !== 'base64' || grant.data === undefined || !isBase64(grant.data)) throw new Fault(409, 'artifact_invalid', 'The host did not return valid output bytes.');
          bytes = Buffer.from(grant.data, 'base64');
        } else if (artifact.download.mode === 'url') {
          if (!status.url || !grant.url || !grant.expiresAt || !Number.isFinite(Date.parse(grant.expiresAt))) throw new Fault(409, 'artifact_unavailable', 'This output has no supported private download.');
          const gatewayUrl = new URL(status.url); gatewayUrl.protocol = gatewayUrl.protocol === 'wss:' ? 'https:' : 'http:';
          const url = new URL(grant.url, gatewayUrl.origin);
          const attachmentId = /^artifact_managed_(?:image|media)_([a-zA-Z0-9_-]+)$/.exec(source.artifactId)?.[1];
          const expectedPath = attachmentId && `/api/chat/media/outgoing/${encodeURIComponent(source.nativeKey)}/${attachmentId}/full`;
          if (url.origin !== gatewayUrl.origin || url.username || url.password || url.hash || url.pathname !== expectedPath || [...url.searchParams.keys()].length !== 1 || !url.searchParams.get('mediaTicket')) throw new Fault(409, 'artifact_unavailable', 'This output has no supported private download.');
          if (Date.parse(grant.expiresAt) <= Date.now()) { if (attempt === 0) continue; throw new Fault(409, 'artifact_expired', 'The output download expired. Reopen its source to try again.'); }
          // The short-lived, artifact-specific URL is the only authorization.
          // No Gateway bearer token, cookies, or redirect receives this grant.
          const response = await this.exchange(url.href, { redirect: 'error', credentials: 'omit', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]) });
          check();
          if ([401, 403, 410].includes(response.status) && attempt === 0) { await response.body?.cancel(); continue; }
          if (!response.ok || !response.body) throw new Fault(409, 'artifact_download_failed', 'The output could not be downloaded. Its source is kept.');
          const declared = response.headers.get('content-length');
          if (declared && (!/^\d+$/.test(declared) || Number(declared) > artifactByteLimit)) { await response.body.cancel(); throw new Fault(413, 'artifact_too_large', 'This output exceeds the preview’s 8 MB file limit.'); }
          const chunks: Uint8Array[] = []; let size = 0; const reader = response.body.getReader();
          try {
            for (;;) { const part = await reader.read(); check(); if (part.done) break; size += part.value.length; if (size > artifactByteLimit) throw new Fault(413, 'artifact_too_large', 'This output exceeds the preview’s 8 MB file limit.'); chunks.push(part.value); }
          } finally { await reader.cancel().catch(() => undefined); }
          bytes = Buffer.concat(chunks);
        } else throw new Fault(409, 'artifact_unavailable', 'This host cannot download this output.');
        if (bytes.length > artifactByteLimit || (artifact.sizeBytes !== undefined && bytes.length !== artifact.sizeBytes)) throw new Fault(409, 'artifact_size_changed', 'The downloaded output does not match its source size.');
        check(); await verifySource(); check();
        const mimeType = artifact.mimeType?.split(';')[0].trim().toLowerCase();
        return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), name: artifact.title.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 150) || 'Generated output', mimeType: mimeType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType) ? mimeType : 'application/octet-stream', type: artifact.type };
      }
      throw new Fault(409, 'artifact_expired', 'The output download expired. Reopen its source to try again.');
    } catch (error) {
      if (error instanceof Fault) throw error;
      // Provider errors can include temporary URLs. Expose a fixed message only.
      throw new Fault(409, 'artifact_download_failed', 'The output could not be verified. Reopen its original conversation to try again.');
    } finally { this.pending.delete(abort); }
  }
}
