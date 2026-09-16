/** Observed host startup stages. Runtime health and model access are separate. */
export type RuntimeStatus = {
  state: 'stopped' | 'starting' | 'running' | 'unavailable' | 'error';
  phase: 'idle' | 'preparing' | 'process' | 'gateway' | 'ready' | 'stopping' | 'failed';
  message: string;
  platform: string;
  managedServiceInstalled: false;
  startedAt?: number;
  readyAt?: number;
  elapsedSeconds?: number;
  canSignIn?: boolean;
};
