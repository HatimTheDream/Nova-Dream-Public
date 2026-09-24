// Adapted from Nova 04138bc1, apps/web/src/lib/chat-runs.ts: applyRunPlan/findPlan.
// A real structured plan is the sole authority for step progress.
export type RunStep = { id: string; label: string; detail: string; status: 'waiting' | 'active' | 'complete'; sourceId?: string; explanation?: string };
export const planningGuidance = 'For work requiring multiple dependent actions, use the available structured planning tool (progress_card or update_plan) before substantive work and update its steps as work advances. Use only as many meaningful steps as the work requires. Answer simple questions directly without creating a plan. During longer work provide concise progress messages with concrete findings or decisions. Do not claim a step complete until its actual work is done.';
export function readRunPlan(value: unknown, depth = 0, inheritedExplanation?: string): RunStep[] | undefined {
  if (!value || typeof value !== 'object' || depth > 5) return;
  const raw = value as Record<string, unknown>, plan = Array.isArray(raw.plan) ? raw.plan : Array.isArray(raw.steps) ? raw.steps : undefined;
  if (raw.hideFromChannelProgress === true) return;
  const explanation = typeof raw.explanation === 'string' && raw.explanation.trim() ? raw.explanation.trim().slice(0, 2000) : inheritedExplanation;
  if (!plan) { for (const key of ['details', 'result', 'data', 'args', 'input']) { const found = readRunPlan(raw[key], depth + 1, explanation); if (found) return found; } return; }
  const steps = plan.slice(0, 100).flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as Record<string, unknown>, label = [candidate.step, candidate.text, candidate.label].find(v => typeof v === 'string' && v.trim()) as string | undefined;
    if (!label) return [];
    const status = candidate.status === 'completed' || candidate.status === 'complete' ? 'complete' as const : ['in_progress', 'inProgress', 'active'].includes(String(candidate.status)) ? 'active' as const : 'waiting' as const;
    // Preserve the old index key and detail for ordinary Work. Explicit native
    // IDs and public plan explanations are optional additional observations.
    const sourceId = typeof candidate.id === 'string' && /^[a-zA-Z0-9:_.-]{1,200}$/.test(candidate.id) ? candidate.id : undefined;
    return [{ id: `plan-${index}`, label: label.trim().slice(0, 1000), detail: typeof candidate.detail === 'string' ? candidate.detail.trim().slice(0, 2000) : '', status, ...(sourceId ? { sourceId } : {}), ...(status === 'active' && explanation ? { explanation } : {}) }];
  });
  return steps.length ? steps : undefined;
}
