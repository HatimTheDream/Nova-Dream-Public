import { z } from 'zod';
import { assistantRequestSchema } from './assistant.js';
export const chatGoalSchema = z.object({ id: z.string().min(1).max(200), objective: z.string().max(100000), status: z.enum(['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete']), tokensUsed: z.number().nonnegative().optional(), createdAt: z.number().nonnegative().optional(), updatedAt: z.number().nonnegative().optional(), pausedAt: z.number().nonnegative().optional(), blockedAt: z.number().nonnegative().optional(), usageLimitedAt: z.number().nonnegative().optional(), budgetLimitedAt: z.number().nonnegative().optional(), completedAt: z.number().nonnegative().optional() });
export type ChatGoal = z.infer<typeof chatGoalSchema> & { displayObjective?: string };
export const chatGoalActionSchema = assistantRequestSchema.extend({ conversationId: z.string().uuid(), nativeId: z.string().uuid(), goalId: z.string().min(1).max(200), issuedAtMs: z.number().int().nonnegative(), action: z.enum(['pause', 'resume', 'complete', 'clear']) }).strict();

// Match the native goal clock: elapsed from creation, frozen at the current stop state.
export function goalElapsedMs(goal: ChatGoal, now: number): number | undefined {
  if (goal.createdAt === undefined) return;
  const stoppedAt = goal.status === 'paused' ? goal.pausedAt : goal.status === 'blocked' ? goal.blockedAt : goal.status === 'usage_limited' ? goal.usageLimitedAt : goal.status === 'budget_limited' ? goal.budgetLimitedAt : goal.completedAt;
  const end = goal.status === 'active' ? now : stoppedAt ?? goal.updatedAt;
  return end === undefined ? undefined : Math.max(0, end - goal.createdAt);
}
export function goalElapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000)), minutes = Math.floor(seconds / 60);
  return seconds < 60 ? `${seconds}s` : minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m ${String(seconds % 60).padStart(2, '0')}s`;
}
