import { z } from 'zod';
export const suggestionRequestSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), owner: z.string().min(1).max(2500), title: z.string().trim().min(1).max(300), notes: z.string().max(10000), existing: z.array(z.string().max(300)).max(500) }).strict();
export type SuggestionRequest = z.infer<typeof suggestionRequestSchema>;
export type SubtaskSuggestion = { id: string; owner: string; title: string; state: 'prepared' | 'dispatching' | 'running' | 'unknown' | 'completed' | 'failed' | 'cancelled'; message: string; createdAt: number; steps?: string[] };
export const suggestionTerminal = (state: SubtaskSuggestion['state']) => ['completed', 'failed', 'cancelled'].includes(state);
export function readSuggestedSteps(text: string): string[] {
  if (text.length > 30000) throw Error('The suggested breakdown was too long.');
  const source = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  const steps = z.array(z.string().trim().min(1).max(300)).min(1).max(50).parse(JSON.parse(source));
  return [...new Map(steps.map(step => [step.toLocaleLowerCase(), step])).values()];
}
