import { z } from 'zod';
import type { AssistantOperation, ContextManifest, PermissionMode } from './assistant.js';

export const planProposalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(12000),
  steps: z.array(z.string().trim().min(1).max(4000)).min(1).max(20),
  stepTitles: z.array(z.string().trim().min(1).max(80)).min(1).max(20).optional().describe('For Chat Research, one short action title per step in the same order, usually 3–7 words. Keep the full investigation detail in steps.'),
  assumptions: z.array(z.string().trim().min(1).max(2000)).max(12),
  verification: z.array(z.string().trim().min(1).max(2000)).min(1).max(12),
}).strict().refine(proposal => !proposal.stepTitles || proposal.stepTitles.length === proposal.steps.length, { message: 'Provide one action title for every research step.', path: ['stepTitles'] });
export type PlanProposal = z.infer<typeof planProposalSchema>;
export type PlanReference = { id: string; version: number };
export type PlanVersion = {
  version: number; operationId: string; createdAt: string; amendment?: string;
  proposal?: PlanProposal; digest?: string; questionIds?: string[];
};
export type AssistantPlan = {
  /** Missing on legacy records and ordinary implementation plans. */
  kind?: 'research';
  id: string; epoch: string; conversationId: string; revision: number; version: number;
  state: 'drafting' | 'ready' | 'implementing' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  versions: PlanVersion[]; createdAt: string; updatedAt: string;
  permissionMode: PermissionMode; sourceContext: ContextManifest;
  approval?: { requestId: string; version: number; digest: string; operationId: string; approvedAt: string };
  error?: string; reviewDigest?: string;
  /** Service-owned research countdown; a client countdown never admits work. */
  autoStartAt?: string; autoStartRequestId?: string;
  autoStartHeld?: 'editing' | 'restarted' | 'needs-review'; autoStartError?: string;
};
export const planDecisionSchema = z.object({
  requestId: z.uuid(), epoch: z.uuid(), id: z.uuid(), expectedRevision: z.number().int().positive(),
  version: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const planAmendSchema = planDecisionSchema.extend({ text: z.string().trim().min(1).max(12000) }).strict();
export const planToolSchema = z.object({
  epoch: z.uuid(), nativeKey: z.string().min(1).max(300), nativeId: z.uuid(),
  runId: z.string().min(1).max(500).optional(), toolCallId: z.string().min(1).max(500),
  proposal: planProposalSchema,
}).strict();
export const planningReadTools = new Set(['nova_read', 'nova_plan', 'read', 'read_file', 'list_dir', 'grep', 'glob', 'web_search', 'web_fetch', 'request_user_input', 'update_plan', 'progress_card', 'session_status']);
/** Preparation may inspect supplied context and clarify scope, but not begin web research. */
export const researchPreparationTools = new Set(['nova_read', 'nova_plan', 'read', 'read_file', 'list_dir', 'grep', 'glob', 'request_user_input', 'update_plan', 'progress_card', 'session_status']);
/** Explicit reads only. Shell/Code Mode, browser actions, delegation and unknown tools are not read-only. */
export function planningToolAllowed(name: string) { return planningReadTools.has(name); }
export const planTerminal = new Set<AssistantOperation['state']>(['completed', 'failed', 'cancelled']);
