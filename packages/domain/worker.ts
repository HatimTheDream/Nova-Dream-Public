import { z } from 'zod';
import { nativeToolNamesSchema } from './agent-capabilities.js';
import { classifyWorkerFailure, workerFailureSchema } from './worker-failure.js';

export const workerContract = 2;
export const workerRuntimeVersion = '2026.9.2';
export const workerPluginId = 'edition3-worker';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const workerIdentitySchema = z.object({ epoch: z.string().uuid(), hostId: z.string().uuid(), attemptId: z.string().uuid(), inputHash: hash, toolMode: z.literal('workspace').optional(), nativeTools: nativeToolNamesSchema.optional() }).strict();
export const workerRunSchema = workerIdentitySchema.extend({ message: z.string().min(1).max(200000), deadlineAt: z.number().int().positive() }).strict();
export type WorkerIdentity = z.infer<typeof workerIdentitySchema>;
export const workerReceiptSchema = workerIdentitySchema.extend({
  sessionKey: z.string().min(1).max(200), runId: z.string().uuid(),
  state: z.enum(['dispatching', 'accepted', 'unknown', 'cancelled']), stopRequested: z.boolean(),
  createdAt: z.number().int().positive(), deadlineAt: z.number().int().positive().optional(),
  runtime: z.object({ harness: z.string(), provider: z.string(), model: z.string() }).optional(),
}).strict();
export type WorkerReceipt = z.infer<typeof workerReceiptSchema>;
export const workerCapabilitiesSchema = z.object({ contract: z.literal(workerContract), epoch: z.string().uuid(), hostId: z.string().uuid(), runtimeVersion: z.literal(workerRuntimeVersion), tools: z.enum(['none', 'workspace']), nativeTools: nativeToolNamesSchema.optional(), automaticDelivery: z.literal(false), durableReceipts: z.literal(true), durableOutcomes: z.literal(true), newRunsAvailable: z.boolean() }).strict();
export type WorkerCapabilities = z.infer<typeof workerCapabilitiesSchema>;
export const workerObservationSchema = z.object({
  runId: z.string().min(1), status: z.enum(['ok', 'error', 'pending', 'timeout']),
  startedAt: z.number().optional(), endedAt: z.number().optional(), stopReason: z.string().optional(),
  pendingError: z.boolean().optional(), yielded: z.boolean().optional(),
  failureReason: workerFailureSchema.optional(),
  terminalReceipt: z.object({ runId: z.string().min(1), sessionId: z.string().uuid(), turnId: z.string().min(1), effective: z.object({ provider: z.string(), model: z.string() }).passthrough(), successfulToolNames: z.array(z.string()), sourceReplyDelivered: z.boolean().optional() }).passthrough().optional(),
  terminalReply: z.discriminatedUnion('disposition', [z.object({ disposition: z.literal('visible'), text: z.string().max(8 * 1024 * 1024) }).passthrough(), z.object({ disposition: z.literal('silent') }), z.object({ disposition: z.literal('empty') }).passthrough()]).optional(),
}).strip();
export const workerStatusSchema = z.object({ receipt: workerReceiptSchema.nullable(), observation: workerObservationSchema.optional(), observationUnavailable: z.boolean().optional() }).strict();
export type WorkerStatus = z.infer<typeof workerStatusSchema>;
/** Capture the SDK's normalized error as a finite category before stripping
 * provider details. Pending and successful results cannot acquire a failure. */
export function readNativeWorkerObservation(raw:unknown): z.infer<typeof workerObservationSchema> {
  const {failureReason:_untrusted,...value}=workerObservationSchema.parse(raw);
  if(value.status!=='error'||!Number.isFinite(value.endedAt)||value.pendingError||value.yielded)return value;
  const reason=classifyWorkerFailure(raw&&typeof raw==='object'&&'error' in raw?raw.error:undefined);
  return {...value,...(reason?{failureReason:reason}:{})};
}
export function isSettledWorkerObservation(value: NonNullable<WorkerStatus['observation']>) {
  if (value.pendingError || value.yielded) return false;
  if (value.terminalReceipt && value.terminalReceipt.runId !== value.runId) return false;
  return value.status === 'ok' ? !!value.terminalReceipt : value.status === 'error' && Number.isFinite(value.endedAt);
}
