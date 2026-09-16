import { z } from 'zod';
import { isBase64 } from './base64.js';

export const backupFormat = 'nova-dream-workspace-1' as const;
export const backupMaxBytes = 384 * 1024 * 1024;
export const backupPlainMaxBytes = 768 * 1024 * 1024;
const id = z.string().min(1).max(2048);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base64 = z.string().refine(isBase64, 'Invalid base64 encoding');
export const retainedNativeSchema = z.object({ archive: base64, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: integer.max(192 * 1024 * 1024) }).strict();
export const backupSnapshotSchema = z.object({
  format: z.literal(backupFormat), schema: z.union([z.literal(47), z.literal(48), z.literal(49), z.literal(50), z.literal(51), z.literal(52), z.literal(53)]), version: z.string().max(40),
  id: z.string().uuid(), createdAt: z.string().datetime(), epoch: z.string().uuid(), cursor: integer,
  entities: z.array(z.object({ id, kind: z.enum(['layout', 'task', 'draft', 'project', 'routine', 'contact', 'content', 'agent', 'assignment', 'profile']), revision: integer.min(1), deviceId: id, updatedAt: z.string().datetime(), value: z.unknown() }).strict()).max(100000),
  history: z.array(z.object({ cursor: integer.min(1), entityId: id, revision: integer.min(1), value: z.unknown() }).strict()).max(1000000),
  receipts: z.array(z.object({ requestId: id, digest: z.string().regex(/^[a-f0-9]{64}$/), deviceId: id, value: z.unknown() }).strict()).max(1000000),
  services: z.array(z.object({ id, revision: integer.min(1), value: z.unknown() }).strict()).max(1000000),
  files: z.array(z.object({ id: z.string().uuid(), deviceId: id, name: z.string().min(1).max(200), size: integer.max(8 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), base64 }).strict()).max(100000),
  references: z.array(z.object({ entityId: id, fileId: z.string().uuid() }).strict()).max(1000000),
  native: z.object({ status: z.enum(['included', 'not-configured', 'separate-host']), archive: base64.optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), bytes: integer.optional(), notes: z.array(z.string().max(500)).max(20), retained: z.array(retainedNativeSchema).max(10).optional() }).strict(),
}).strict();
export type BackupSnapshot = z.infer<typeof backupSnapshotSchema>;
export type BackupSummary = {
  id: string; createdAt: string; version: string; schema: number;
  counts: Record<string, number>; files: number; fileBytes: number; history: number;
  native: BackupSnapshot['native']['status']; notes: string[];
};
export const backupCommandSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), passphrase: z.string().min(12, 'Use at least 12 characters for your backup password.').max(256) }).strict();
export const restoreCommandSchema = backupCommandSchema.extend({ uploadId: z.string().uuid() });
export type RecoveryReview = { available: boolean; completed: boolean; fingerprint: string; accounts: number; taskRoutines: number; agentRoutines: number; queuedMessages: number; savedConversations: number; unconfirmedRuns: number };
export const recoveryResumeSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), confirmNewConnections: z.literal(true) }).strict();
export function summarizeBackup(value: BackupSnapshot): BackupSummary {
  const counts: Record<string, number> = {};
  for (const entity of value.entities) counts[entity.kind] = (counts[entity.kind] ?? 0) + 1;
  counts.quest = value.services.filter(record => record.id.startsWith('profile:quest:')).length;
  return { id: value.id, createdAt: value.createdAt, version: value.version, schema: value.schema, counts, files: value.files.length, fileBytes: value.files.reduce((total, f) => total + f.size, 0), history: value.history.length, native: value.native.status, notes: [...value.native.notes, ...(value.native.retained?.length ? [`Also preserves ${value.native.retained.length} earlier Assistant archive(s), without starting them.`] : []), 'Includes saved workspace drafts and uploaded files. Writing and files kept only in a browser are separate.', 'Connected services, routines and pending operations stay paused in the recovered copy until reviewed.'] };
}
