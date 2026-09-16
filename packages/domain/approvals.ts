import { z } from 'zod';
import { assistantRequestSchema } from './assistant.js';

export const approvalDecision = z.enum(['allow-once', 'allow-always', 'deny']);
const short = z.string().min(1).max(256);
const scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message-send'), target: short, recipientCount: z.number().int().positive().max(1000000), recipients: z.array(short).max(5).optional(), audience: z.enum(['internal', 'external']).optional() }).strict(),
  z.object({ kind: z.literal('payment'), amount: short, currency: short, target: short }).strict(),
  z.object({ kind: z.literal('external-post'), target: short, visibility: z.enum(['public', 'restricted']) }).strict(),
  z.object({ kind: z.literal('standing-grant'), automation: short, command: short, expiresInDays: z.number().int().min(1).max(3650).optional() }).strict(),
]);
const common = { agentId: short.nullable().optional(), allowedDecisions: z.array(approvalDecision).min(1).max(3).refine(values => values.includes('deny')) };
const presentation = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('exec'), commandText: z.string().min(1).max(65536), commandPreview: z.string().max(65536).nullable().optional(), warningText: z.string().max(65536).nullable().optional(), host: short.nullable().optional(), nodeId: short.nullable().optional(), scope: scope.optional() }).strict(),
  z.object({ ...common, kind: z.literal('plugin'), title: z.string().min(1).max(80), description: z.string().min(1).max(512), detail: z.string().max(16384).optional(), severity: z.enum(['info', 'warning', 'critical']), pluginId: short.nullable().optional(), toolName: short.nullable().optional(), scope: scope.optional(), externalResolution: z.object({ label: z.string().min(1).max(80), decisions: z.array(z.enum(['allow-once', 'allow-always'])).min(1).max(2) }).strict().optional() }).strict(),
  z.object({ agentId: common.agentId, allowedDecisions: z.tuple([z.literal('allow-once'), z.literal('deny')]), kind: z.literal('system-agent'), title: z.string().min(1).max(80), description: z.string().min(1).max(512), proposalHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
// Only the runtime's reviewer-safe projection crosses this boundary. Never store
// raw exec requests, environment values, execution plans, or caller overrides.
export const approvalSnapshotSchema = z.object({
  id: z.string().min(1).max(500), status: z.enum(['pending', 'allowed', 'denied', 'expired', 'cancelled']),
  presentation, createdAtMs: z.number().int().nonnegative(), expiresAtMs: z.number().int().nonnegative(),
  resolvedAtMs: z.number().int().nonnegative().optional(), decision: approvalDecision.optional(), reason: z.enum(['user', 'timeout', 'malformed-verdict', 'no-route', 'run-aborted', 'gateway-restart', 'storage-corrupt']).optional(),
}).refine(value => value.status === 'pending' ? value.resolvedAtMs === undefined && value.decision === undefined : value.resolvedAtMs !== undefined && value.reason !== undefined && (value.status === 'allowed' ? ['allow-once', 'allow-always'].some(d => d === value.decision) && value.reason === 'user' : value.status === 'denied' ? value.decision === 'deny' : value.decision === undefined), 'The native approval outcome is incomplete.');
export type ApprovalSnapshot = z.infer<typeof approvalSnapshotSchema>;
export type ReviewApproval = {
  id: string; revision: number; epoch: string; connectionGeneration: string; conversationId: string; nativeId: string; nativeKey: string;
  sourceSessionKey?: string; snapshot: ApprovalSnapshot; updatedAtMs: number;
  action?: { requestId: string; decision: z.infer<typeof approvalDecision>; state: 'sending' | 'unknown' | 'confirmed'; message?: string };
};
export type ApprovalState = { state: 'unavailable' | 'connecting' | 'ready' | 'error'; message?: string; items: ReviewApproval[] };
export const resolveApprovalSchema = assistantRequestSchema.extend({ id: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.number().int().positive(), decision: approvalDecision }).strict();
export const checkApprovalSchema = assistantRequestSchema.extend({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
