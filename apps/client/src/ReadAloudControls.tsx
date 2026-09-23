import type { ReadAloud, ReadingState } from './read-aloud';
import { X } from './icons';
import './read-aloud.css';

export function ReadAloudControls({ reader, state }: { reader: ReadAloud; state: ReadingState }) {
  if (state.phase === 'idle') return null;
  const active = state.phase !== 'error';
  return <div className="read-aloud-controls" role="group" aria-label="Read aloud controls">
    <span role="status">{state.error ?? (state.phase === 'preparing' ? 'Preparing audio…' : state.phase === 'paused' ? 'Reading paused' : state.route === 'device' ? 'Reading with device voice' : 'Reading reply')}</span>
    {state.phase === 'error' && state.canUseDevice && <button type="button" className="text-button" onClick={reader.useDeviceVoice} title="Restart this reply from the beginning using device speech">Use device voice</button>}
    {['speaking', 'paused'].includes(state.phase) && <button type="button" className="text-button" onClick={reader.toggle}>{state.phase === 'paused' ? 'Resume' : 'Pause'}</button>}
    <button type="button" className="icon-button" aria-label={active ? 'Stop reading' : 'Dismiss reading notice'} onClick={reader.stop}><X size={17}/></button>
  </div>;
}
