import { z } from 'zod';

const workItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/).describe('Stable ID for the same concrete work item across updates.'),
  title: z.string().trim().min(1).max(120),
  effort: z.number().finite().positive().max(1000).describe('Relative expected effort for this concrete item, not elapsed time or a percentage.'),
  status: z.enum(['pending', 'active', 'complete']),
}).strict();
const estimateContent = {
  activity: z.string().trim().min(1).max(240),
  basis: z.string().trim().min(1).max(500).describe('Explain the task-specific effort estimate and any change in remaining scope.'),
  items: z.array(workItemSchema).min(1).max(80).refine(items => new Set(items.map(item => item.id)).size === items.length, { message: 'Work item IDs must be unique.' }),
};
export const researchEstimateInputSchema = z.object({ expectedRevision: z.number().int().nonnegative(), ...estimateContent }).strict();
export type ResearchEstimateInput = z.infer<typeof researchEstimateInputSchema>;

const bindingSchema = z.object({
  operationId: z.string().min(1).max(500), epoch: z.string().min(1).max(500), nativeRunId: z.string().min(1).max(500),
  planId: z.string().min(1).max(500), planVersion: z.number().int().positive(), planDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ResearchEstimateBinding = z.infer<typeof bindingSchema>;
export const researchEstimateSchema = z.object({
  revision: z.number().int().positive(), updatedAt: z.iso.datetime(), observedSequence: z.number().int().nonnegative(), binding: bindingSchema,
  ...estimateContent,
}).strict().refine(estimate => estimate.items.some(item => item.status !== 'complete'), { message: 'Retain unfinished work until the native run confirms the finished report.' });
export type ResearchEstimate = z.infer<typeof researchEstimateSchema>;

export class ResearchEstimateError extends Error {
  constructor(public readonly code: 'revision_conflict' | 'binding_changed' | 'completed_item_changed' | 'unfinished_work_required', message: string) { super(message); this.name = 'ResearchEstimateError'; }
}
const sameBinding = (left: ResearchEstimateBinding, right: ResearchEstimateBinding) => Object.keys(left).every(key => left[key as keyof ResearchEstimateBinding] === right[key as keyof ResearchEstimateBinding]);

/** Pure estimate update. Run admission and exact tool-call replay belong to the service. */
export function reconcileResearchEstimate(previous: ResearchEstimate | undefined, raw: unknown, updatedAt: string, observedSequence: number, binding: ResearchEstimateBinding): ResearchEstimate {
  const input = researchEstimateInputSchema.parse(raw);
  const prior = previous && researchEstimateSchema.parse(previous), scope = bindingSchema.parse(binding);
  if (input.expectedRevision !== (prior?.revision ?? 0)) throw new ResearchEstimateError('revision_conflict', 'Refresh the current research estimate before updating it.');
  if (prior && !sameBinding(prior.binding, scope)) throw new ResearchEstimateError('binding_changed', 'The research estimate belongs to the original approved run.');
  for (const completed of prior?.items.filter(item => item.status === 'complete') ?? []) {
    const current = input.items.find(item => item.id === completed.id);
    if (!current || current.status !== 'complete' || current.effort !== completed.effort || current.title !== completed.title) throw new ResearchEstimateError('completed_item_changed', 'Keep completed work items unchanged; describe additional or repeated work as a new item.');
  }
  if (!input.items.some(item => item.status !== 'complete')) throw new ResearchEstimateError('unfinished_work_required', 'Keep the unfinished verification or report delivery item until the native run confirms completion.');
  return researchEstimateSchema.parse({ revision: (prior?.revision ?? 0) + 1, updatedAt, observedSequence, binding: scope, activity: input.activity, basis: input.basis, items: input.items });
}

/** Estimated effort completed, never a measurement or a substitute for terminal proof. */
export function researchEstimateFraction(estimate?: ResearchEstimate): number | null {
  const parsed = researchEstimateSchema.safeParse(estimate);
  if (!parsed.success) return null;
  const total = parsed.data.items.reduce((sum, item) => sum + item.effort, 0);
  const completed = parsed.data.items.reduce((sum, item) => sum + (item.status === 'complete' ? item.effort : 0), 0);
  // Floating-point rounding must not turn tiny remaining effort into completion.
  return Math.min(completed / total, 1 - Number.EPSILON);
}
