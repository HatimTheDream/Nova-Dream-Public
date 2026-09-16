import { LoadingProgress } from './LoadingProgress';
import { moduleLoadingSubtitles } from './loading-progress';

export function ModuleLoading({ module, percent, error, retry }: { module: string; percent?: number; error?: string; retry?: () => void }) {
  return <section className="module-loading" aria-label={`${module} loading`} aria-busy={!error}>
    <div className="module-loading-card">
      <img src="/icons/nova-dream-brand-192-v2.png" width="52" height="52" alt=""/>
      <h2>{module}</h2>
      <p role={error ? 'alert' : 'status'}>{error || moduleLoadingSubtitles[module] || 'Getting a few good things ready…'}</p>
      <LoadingProgress percent={percent} label={`${module} loading`} paused={!!error}/>
      {error && retry && <button onClick={retry}>Try again</button>}
    </div>
  </section>;
}
