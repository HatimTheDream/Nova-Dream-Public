import type { AssistantSpace } from '../../../packages/domain/assistant-space';
import './assistant-spaces.css';

export function AssistantSpaceSwitch({ value, change, disabled, id = 'assistant-sidebar-space-switch' }: { value: AssistantSpace; change: (space: AssistantSpace) => void; disabled?: boolean; id?: string }) {
  return <div id={id} className="assistant-space-switch" role="group" aria-label="Assistant space">
    {(['chat', 'work'] as const).map(space => <button key={space} type="button" aria-pressed={value === space} disabled={disabled} onClick={event => {
      const keyboard = event.detail === 0;
      change(space);
      // Changing conversation remounts its editor; retain the keyboard anchor.
      if (keyboard) requestAnimationFrame(() => { if (document.activeElement === document.body) document.getElementById(id)?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus(); });
    }}>{space === 'chat' ? 'Chat' : 'Work'}</button>)}
  </div>;
}

export function AssistantNavigation({ space, change, disabled, teamOpen, openTeam }: { space: AssistantSpace; change: (space: AssistantSpace) => void; disabled: boolean; teamOpen: boolean; openTeam: () => void }) {
  return <nav className="assistant-navigation" aria-label="Assistant navigation">
    <AssistantSpaceSwitch id="assistant-navigation-space-switch" value={space} change={change} disabled={disabled}/>
    <button type="button" className="assistant-team-button" aria-expanded={teamOpen} onClick={openTeam}>Team work</button>
  </nav>;
}
