import { z } from 'zod';

export const assistantSpaceSchema = z.enum(['chat', 'work']);
export type AssistantSpace = z.infer<typeof assistantSpaceSchema>;
// Records created before the split remain in Chat without rewriting their history.
export const assistantSpace = (record?: { space?: AssistantSpace }) => record?.space ?? 'chat';
export const spaceDraftId = (device: string, space: AssistantSpace) => `draft:${device}${space === 'work' ? ':work' : ''}`;
export function spaceInstructions(space?: AssistantSpace) {
  if (!space) return ''; // Preserve the exact captured input of older runs.
  return space === 'work'
    ? 'You are in the Work space. Carry the owner’s requested work through to a concrete result. Use the available tools when useful, show concise progress for substantial work, and verify changes before reporting them. Respect the selected work mode and access permissions; this space grants no additional authority.'
    : 'You are in the Chat space. Help the owner think, learn, and create in a natural conversation. The same tools and app actions are available when the owner requests them. Respect the selected work mode and access permissions; this space grants no additional authority.';
}
