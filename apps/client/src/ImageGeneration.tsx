import type { AssistantOperation } from '../../../packages/domain/assistant';
import type { ToolActivity } from '../../../packages/domain/tool-activity';
import { imageGenerationState } from '../../../packages/domain/image-generation';
import './image-generation.css';

export function ImageGeneration({ tool, operation }: { tool: ToolActivity; operation?: AssistantOperation }) {
  const state = imageGenerationState(tool, operation);
  if (!state) return null;
  const label = state === 'generating' ? 'Creating image…' : state === 'stopping' ? 'Stopping image creation…' : 'Image status unconfirmed';
  return <div className={`image-generation image-generation--${state}`} role="status" aria-live="polite" aria-label={label}>
    <div className="image-generation-tile" aria-hidden="true"><div className="image-generation-dots"/></div>
    <span className={state === 'generating' ? 'sr-only' : 'image-generation-label'}>{label}</span>
  </div>;
}
