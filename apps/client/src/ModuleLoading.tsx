export function LoadingRing({ label = 'Loading' }: { label?: string }) {
  return <span className="nova-loading-ring" role="status" aria-label={label}/>;
}
export function ModuleLoading({ module, error, retry }: { module: string; percent?: number; error?: string; retry?: () => void }) {
  return <section className="module-loading" aria-label={`${module} loading`} aria-busy={!error}>
    {error ? <div className="module-loading-error"><p role="alert">{error}</p>{retry && <button onClick={retry}>Try again</button>}</div> : <LoadingRing label={`Loading ${module}`}/>}
  </section>;
}
