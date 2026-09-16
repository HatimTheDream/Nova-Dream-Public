export type StartupPhase = 'connecting' | 'session' | 'workspace' | 'modules' | 'inbox' | 'ready';

// Completed startup checkpoints, not an estimate of downloaded bytes or time.
export const startupProgress: Record<StartupPhase, { percent: number; detail: string }> = {
  connecting: { percent: 0, detail: 'Connecting to your workspace…' },
  session: { percent: 20, detail: 'Opening your session…' },
  workspace: { percent: 40, detail: 'Loading your saved work…' },
  modules: { percent: 60, detail: 'Preparing your workspace…' },
  inbox: { percent: 80, detail: 'Getting things ready…' },
  ready: { percent: 100, detail: 'Your workspace is ready.' },
};

/** Optional Inbox preparation keeps its existing eight-second opening limit. */
export function prepareWorkspaceStartup(
  load: () => Promise<() => Promise<void>>,
  report: (phase: 'inbox' | 'ready') => void,
  waitMs = 8000,
) {
  let cancelled = false, ready = false;
  const finish = () => {
    if (cancelled || ready) return;
    ready = true; clearTimeout(timer); report('ready');
  };
  const timer = setTimeout(finish, waitMs);
  void Promise.resolve().then(load).then(prepare => {
    if (cancelled) return;
    if (!ready) report('inbox');
    // After the opening limit, recent mail may still prepare in the background.
    return prepare();
  }).then(finish, finish);
  return () => { cancelled = true; clearTimeout(timer); };
}
