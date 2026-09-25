import { z } from 'zod';
import type { AgentServiceInfo } from './agent-service.js';

export const updateCandidateIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const updateInstallRequestSchema = z.object({
  epoch: z.uuid(), candidateId: updateCandidateIdSchema, releaseId: updateCandidateIdSchema.optional(), idempotencyKey: z.uuid(), when: z.enum(['now', 'idle']),
}).strict();
export const updateCancelRequestSchema = z.object({ epoch: z.uuid(), jobId: z.uuid() }).strict();
export const updateDismissRequestSchema = z.object({ epoch: z.uuid(), candidateId: updateCandidateIdSchema }).strict();
export type UpdateInstallRequest = z.infer<typeof updateInstallRequestSchema>;

/** Deliberately excludes artifact addresses, host paths and execution details. */
export type SoftwareUpdateReleaseSummary = {
  candidateId: string; releaseId?: string; novaVersion: string; agentVersion: string; notes: string[]; downloadBytes: number;
};
export type SoftwareUpdateJobState = 'waiting' | 'downloading' | 'verifying' | 'preparing' | 'installing' | 'restarting' | 'checking' | 'completed' | 'restored' | 'failed' | 'cancelled';
export type SoftwareUpdateJob = {
  id: string; candidateId: string; releaseId?: string; state: SoftwareUpdateJobState; message?: string;
  download?: { received: number; total: number }; requestedAt: number; updatedAt: number;
};
export type SoftwareUpdateBlocker = { code: string; message: string };
export type UpdateAvailability = 'checking' | 'current' | 'available' | 'unavailable' | 'error';
export type AgentUpdateStatus = { state: 'checking' | 'current' | 'available' | 'unavailable'; version?: string; checkedAt?: number; releaseNotesUrl?: string };
export type SoftwareUpdateStatus = {
  installed: { novaVersion: string; candidateId: string; agent: AgentServiceInfo };
  availability: UpdateAvailability; checkedAt?: number; release?: SoftwareUpdateReleaseSummary; error?: string;
  installation: { supported: boolean; reason?: string };
  job?: SoftwareUpdateJob; blocker?: SoftwareUpdateBlocker; notification?: { candidateId: string };
  agentUpdate?: AgentUpdateStatus;
};
export type UpdateStatus = SoftwareUpdateStatus;
