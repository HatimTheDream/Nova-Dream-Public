import { z } from 'zod';
export const workModeSchema = z.enum(['chat', 'plan', 'research', 'image', 'goal']);
export type WorkMode = z.infer<typeof workModeSchema>;
export const workModes: { id: WorkMode; label: string; description: string }[] = [
  { id: 'chat', label: 'Chat', description: 'Ask, create, and get things done' },
  { id: 'image', label: 'Image', description: 'Create an image from your description' },
  { id: 'goal', label: 'Goal', description: 'Set an objective to keep pursuing' },
  { id: 'plan', label: 'Plan', description: 'Think through the steps before acting' },
  { id: 'research', label: 'Research', description: 'Investigate and compare sources' },
];
/** Captured with the submitted draft; it never grants additional tool permissions. */
export function workModeInstructions(mode?: WorkMode): string {
  if (mode === 'goal') return 'The owner explicitly selected Goal. Pursue this objective until its required outcome is verified. Use nova_read with operation goal.read and input {} to inspect the saved goal. Once achieved, use nova_write with operation goal.update and input {goalId: the exact current goal ID, status: "complete"}; report "blocked" only after the same blocker recurs on at least three consecutive Goal turns. This status-only action is available in read-only Goal requests and grants no permission to edit files or workspace records. Do not confuse completed planning steps or a final reply with a completed goal. Confirm the saved goal status from the tool result, then provide the requested visible answer. If no supported goal tool is available, say that the status could not be updated; never claim it was saved.';
  if (mode === 'image') return 'The owner selected Image. Generate an actual image with the available image-generation tool from their description and supplied reference attachments. Return the generated image in the conversation. Do not substitute a text-only description or claim an image exists without a successful tool result. If generation is unavailable, explain the missing capability plainly.';
  if (mode === 'plan') return 'The owner selected Plan mode. Produce a concrete plan before implementation: clarify the intended outcome, inspect relevant available context, identify dependencies and meaningful decisions, and propose ordered steps and verification. Ask only necessary questions. Do not implement the plan, change files, publish, or take external actions in this turn. Finish with the plan ready for review.';
  if (mode === 'research') return 'The owner selected Research mode. Investigate the question using available search and source-reading tools. Prefer primary sources, compare relevant evidence, check current facts, and cite direct source links near supported claims. Distinguish evidence, inference, uncertainty, and missing access. Do not invent citations or claim research that was not performed. If search is unavailable, say so clearly and limit the answer accordingly. Produce a useful sourced synthesis; do not modify external systems.';
  return '';
}
