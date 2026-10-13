import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { UpdateHeartbeat } from './update-host-client.js';
import { guardedUpdatePath, readUpdateJson, writeUpdateJson } from './update-storage.js';

export const frontendControlSocket = '/run/nova-update/frontend.sock';
const id = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const beginSchema = z.object({ operationId: id, baseCandidateId: hash, serviceInputsSha256: hash, workspaceEpoch: id }).strict();
const leaseSchema = z.object({ format: z.literal(1), ...beginSchema.shape, processIdentity: id, active: z.boolean(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative() }).strict();
export type FrontendLeaseRecord = z.infer<typeof leaseSchema>;
export interface FrontendLeaseStore { read(): unknown; find(id: string): unknown; save(value: FrontendLeaseRecord): void; }
export class FrontendLeaseError extends Error {}
const reject = (message: string): never => { throw new FrontendLeaseError(message); };

/** This exclusion lease never pauses workspace writes or acquires native hold. */
export class FrontendLease {
  private lease?: FrontendLeaseRecord;
  private beat?: UpdateHeartbeat & { at: number };
  private uncertain = false;
  private readonly instance = randomUUID();
  constructor(private readonly store: FrontendLeaseStore, private readonly current: () => { candidateId: string; serviceInputsSha256: string; apiVersion: number; schemaVersion: number }, private readonly assertAdmission: () => void, private readonly now = Date.now) {
    const saved = store.read(); if (saved !== undefined) this.lease = leaseSchema.parse(saved);
  }
  get active() { return this.uncertain || this.lease?.active === true; }
  observeHeartbeat(value: UpdateHeartbeat) { this.beat = { ...value, at: this.now() }; }
  private matching(candidateId: string, epoch: string) {
    const age = this.beat ? this.now() - this.beat.at : -1;
    return age >= 0 && age < 10000 && this.beat?.candidateId === candidateId && this.beat.epoch === epoch && this.beat.heldFor === null && !this.beat.nativeSuspended
      && !this.beat.blockers.some(blocker => ['recovery', 'workspace_switch'].includes(blocker.code));
  }
  private certain() { if (this.uncertain) reject('Frontend authority needs durable reconciliation.'); }
  private save(value: FrontendLeaseRecord) {
    this.certain(); leaseSchema.parse(value);
    try { this.store.save(value); } catch (error) { this.uncertain = true; throw error; }
    this.lease = value;
  }
  private view(operationId: string) {
    const current = this.current();
    const lease = this.lease;
    return { format: 1, operationId, leaseId: lease?.operationId ?? null, active: this.active, candidateId: current.candidateId, serviceInputsSha256: current.serviceInputsSha256, apiVersion: current.apiVersion, schemaVersion: current.schemaVersion, epoch: this.beat?.epoch ?? null, processIdentity: this.instance, leaseProcessIdentity: lease?.processIdentity ?? null };
  }
  begin(value: unknown) {
    this.certain(); const input = beginSchema.parse(value); this.assertAdmission(); const current = this.current();
    if (current.candidateId !== input.baseCandidateId || current.serviceInputsSha256 !== input.serviceInputsSha256 || !this.matching(input.baseCandidateId, input.workspaceEpoch)) reject('A fresh matching service and workspace are required.');
    if (this.lease?.operationId === input.operationId) {
      if (this.lease.baseCandidateId !== input.baseCandidateId || this.lease.serviceInputsSha256 !== input.serviceInputsSha256 || this.lease.workspaceEpoch !== input.workspaceEpoch || !this.lease.active) reject('The original frontend operation cannot be changed or replayed.');
      return this.view(input.operationId);
    }
    if (this.active || this.store.find(input.operationId) !== undefined) reject('The previous frontend operation must settle.');
    this.save({ format: 1, ...input, processIdentity: this.instance, active: true, createdAt: this.now(), updatedAt: this.now() });
    return this.view(input.operationId);
  }
  end(value: unknown) {
    this.certain(); const input = z.object({ operationId: id, leaseId: id }).strict().parse(value);
    if (input.operationId !== input.leaseId || this.lease?.operationId !== input.operationId) reject('This frontend lease is not current.');
    const lease = this.lease!;
    if (lease.active) {
      const current = this.current();
      if (current.candidateId !== lease.baseCandidateId || current.serviceInputsSha256 !== lease.serviceInputsSha256 || !this.matching(lease.baseCandidateId, lease.workspaceEpoch)) reject('The selected service or workspace needs reconciliation.');
      this.save({ ...lease, active: false, updatedAt: this.now() });
    }
    return this.view(input.operationId);
  }
  cancelBeforeBegin(value: unknown) {
    this.certain(); const input = beginSchema.parse(value); this.assertAdmission();
    if (this.active) reject('An admitted frontend lease must reconcile its selector before release.');
    const previous = this.store.find(input.operationId);
    if (previous !== undefined) {
      const record = leaseSchema.parse(previous);
      if (record.baseCandidateId !== input.baseCandidateId || record.serviceInputsSha256 !== input.serviceInputsSha256 || record.workspaceEpoch !== input.workspaceEpoch || record.active || this.lease?.operationId !== input.operationId) reject('The original frontend disposition needs reconciliation.');
      return this.view(input.operationId);
    }
    // This is a terminal fence, not admission. A delayed original begin will
    // find the durable inactive ID and cannot acquire authority, even if the
    // service changed while no frontend lease had yet been granted.
    this.save({ format: 1, ...input, processIdentity: this.instance, active: false, createdAt: this.now(), updatedAt: this.now() });
    return this.view(input.operationId);
  }
  observe(value: unknown) { this.certain(); const input = z.object({ operationId: id }).strict().parse(value); return this.view(input.operationId); }
}

export class FileFrontendLeaseStore implements FrontendLeaseStore {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); guardedUpdatePath(directory, true); }
  read() { const path = join(this.directory, 'current.json'); if (!existsSync(path)) return; guardedUpdatePath(path, false); return readUpdateJson(path, 8192); }
  find(operationId: string) { id.parse(operationId); const current = this.read(); if (current && leaseSchema.parse(current).operationId === operationId) return current; const path = join(this.directory, operationId + '.json'); if (!existsSync(path)) return; guardedUpdatePath(path, false); return readUpdateJson(path, 8192); }
  save(value: FrontendLeaseRecord) {
    leaseSchema.parse(value); const old = this.read();
    if (old && leaseSchema.parse(old).operationId !== value.operationId) {
      const prior = leaseSchema.parse(old); if (prior.active) throw Error('Cannot replace active frontend authority.');
      writeUpdateJson(join(this.directory, prior.operationId + '.json'), prior);
    }
    writeUpdateJson(join(this.directory, 'current.json'), value);
  }
}

export function frontendLeaseRequestHandler(control: FrontendLease) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, value: unknown) => { if (!response.destroyed && !response.writableEnded) { const bytes = Buffer.from(JSON.stringify(value)); response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', Connection: 'close' }); response.end(bytes); } };
    if (request.method !== 'POST' || !/^\/v1\/(begin|end|observe|cancel-before-begin)$/.test(request.url ?? '') || request.headers.origin || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') || request.headers['content-length'] && (!/^\d+$/.test(request.headers['content-length']) || Number(request.headers['content-length']) > 4096)) { send(400, { message: 'Invalid root frontend request.' }); request.resume(); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const part of request) { size += part.length; if (size > 4096) { send(413, { message: 'Frontend request exceeded its bound.' }); return; } chunks.push(part); }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      send(200, request.url === '/v1/begin' ? control.begin(value) : request.url === '/v1/end' ? control.end(value) : request.url === '/v1/cancel-before-begin' ? control.cancelBeforeBegin(value) : control.observe(value));
    } catch (error) { send(error instanceof FrontendLeaseError || error instanceof z.ZodError ? 409 : 500, { message: 'Frontend operation was refused or needs reconciliation.' }); }
  };
}
