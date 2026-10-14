import { z } from 'zod';
export const updateCandidateIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const updateInstallRequestSchema = z.object({
    epoch: z.uuid(), candidateId: updateCandidateIdSchema, releaseId: updateCandidateIdSchema.optional(), idempotencyKey: z.uuid(), when: z.enum(['now', 'idle']),
}).strict();
export const updateCancelRequestSchema = z.object({ epoch: z.uuid(), jobId: z.uuid() }).strict();
export const updateDismissRequestSchema = z.object({ epoch: z.uuid(), candidateId: updateCandidateIdSchema }).strict();
