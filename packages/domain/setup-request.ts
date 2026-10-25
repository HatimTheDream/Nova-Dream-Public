import { z } from 'zod';
import { assistantRequestSchema } from './assistant.js';
export const setupRequestReferenceSchema = assistantRequestSchema.extend({
  kind: z.enum(['runtime-start', 'gateway-connect']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const closeSetupRequestSchema = assistantRequestSchema.extend({
  original: setupRequestReferenceSchema,
  revision: z.number().int().nonnegative(),
}).strict();
export type SetupRequestReference = z.infer<typeof setupRequestReferenceSchema>;
export type CloseSetupRequest = z.infer<typeof closeSetupRequestSchema>;
export type SetupRequestView = SetupRequestReference & {
  revision: number;
  state: 'not-found' | 'working' | 'applied' | 'failed' | 'unknown' | 'closed';
  message: string;
  reviewedUnknown?: boolean;
  closedFrom?: 'not-found' | 'working' | 'applied' | 'failed' | 'unknown';
};
