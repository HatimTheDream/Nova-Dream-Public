import { workRequestRejected } from './work-request';

export type PendingTeamAction = { requestId: string; epoch: string; id: string; revision: number; action: 'retry' | 'apply_findings' };
type Result = { command?: PendingTeamAction; pending?: PendingTeamAction; confirmed: boolean; error: string };

/** Persist before dispatch; an uncertain response always reuses the original command. */
export async function runRetainedTeamAction(options: {
  read(): PendingTeamAction | undefined;
  write(command: PendingTeamAction | null): boolean;
  retained(command: PendingTeamAction): void;
  send(command: PendingTeamAction): Promise<unknown>;
}, proposed?: PendingTeamAction): Promise<Result> {
  const command = options.read() ?? proposed;
  if (!command) return { confirmed: false, error: '' };
  if (!options.write(command)) return { command, pending: options.read(), confirmed: false, error: 'Free browser storage before continuing. Your saved work and original request are kept.' };
  options.retained(command);
  const clear = () => {
    const current = options.read();
    return current?.requestId === command.requestId && options.write(null);
  };
  try {
    await options.send(command);
    const cleared = clear();
    return { command, pending: cleared ? undefined : options.read() ?? command, confirmed: true, error: cleared ? '' : 'The action was confirmed, but its local receipt could not clear. Reconcile the original request after freeing browser storage.' };
  } catch (reason) {
    const cleared = workRequestRejected(reason) && clear();
    return { command, pending: cleared ? undefined : options.read() ?? command, confirmed: false, error: reason instanceof Error ? reason.message : 'This action was not confirmed. Reconcile the original request.' };
  }
}
