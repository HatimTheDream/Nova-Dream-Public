import type { AssistantSpace } from '../../../packages/domain/assistant-space';
import './assistant-spaces.css';

export function AssistantSpaceSwitch({ value, change, disabled }: { value: AssistantSpace; change: (space: AssistantSpace) => void; disabled?: boolean }) {
  return <div className="assistant-space-switch" role="group" aria-label="Assistant space">
    {(['chat', 'work'] as const).map(space => <button key={space} type="button" aria-pressed={value === space} disabled={disabled} onClick={event => {
      const keyboard = event.detail === 0;
      change(space);
      // Changing conversation remounts its editor; retain the keyboard anchor.
      if (keyboard) requestAnimationFrame(() => { if (document.activeElement === document.body) document.querySelector<HTMLButtonElement>('.assistant-space-switch > button[aria-pressed="true"]')?.focus(); });
    }}>{space === 'chat' ? 'Chat' : 'Work'}</button>)}
  </div>;
}
