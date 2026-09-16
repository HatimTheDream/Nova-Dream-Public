import { startupProgress, type StartupPhase } from './startup-progress';

export function StartupScreen({ phase, error, reconnect }: { phase: StartupPhase; error?: string; reconnect?: () => void }) {
  const { percent, detail } = startupProgress[phase];
  return <main className="startup startup-screen" aria-labelledby="startup-title">
    <img className="startup-logo" src="/icons/nova-dream-brand-192-v2.png" alt="Nova Dream logo" width="112" height="112"/>
    <div className="startup-copy"><h1 id="startup-title">Nova Dream</h1><p role={error ? 'alert' : 'status'}>{error || detail}</p></div>
    <div className="startup-progress">
      <div className="startup-track" role="progressbar" aria-label="Opening Nova Dream" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={error ? `${percent}% · Waiting to reconnect` : `${percent}% · ${detail}`}>
        <span className="startup-fill" style={{ width: `${percent}%` }}/>
      </div>
      <p className="startup-percent" aria-hidden="true">{percent}%</p>
    </div>
    {error && reconnect && <button className="primary" onClick={reconnect}>Reconnect</button>}
  </main>;
}
