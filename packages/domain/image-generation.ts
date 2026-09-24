import type { AssistantOperation } from './assistant.js';
import type { ToolActivity } from './tool-activity.js';

/** Only an observed generator call is evidence of image generation. An Image
 * composer chip, an image-reader call or prose mentioning images is not. */
export function isImageGenerationTool(name: string): boolean {
  const leaf = name.split(/__|\./).at(-1);
  return leaf === 'imagegen' || leaf === 'image_generate' || leaf === 'generate_image';
}

export function imageGenerationState(tool: ToolActivity, operation?: Pick<AssistantOperation, 'state' | 'cancelRequested'>): 'generating' | 'stopping' | 'unconfirmed' | null {
  if (!isImageGenerationTool(tool.name) || !['running', 'unknown'].includes(tool.state)) return null;
  if (operation && ['completed', 'failed', 'cancelled'].includes(operation.state)) return null;
  if (tool.state === 'unknown' || !operation || operation.state === 'unknown') return 'unconfirmed';
  if (operation.cancelRequested) return 'stopping';
  return 'generating';
}
