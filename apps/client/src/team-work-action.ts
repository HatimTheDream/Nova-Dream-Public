import { workRequestRejected } from './work-request';
import type { TeamStep, TeamWork } from '../../../packages/domain/team-work';

export type PendingTeamAction = { requestId: string; epoch: string; id: string; revision: number; action: 'retry' | 'apply_findings' };
export type TeamWorkForm = Pick<TeamWork, 'projectId' | 'title' | 'brief' | 'maxMinutes'> & { steps: Pick<TeamStep, 'agentId' | 'role'>[] };
export type PendingTeamStart = TeamWorkForm & { requestId: string; epoch: string };
type Result<Command, Response> = { command?: Command; pending?: Command; response?: Response; confirmed: boolean; error: string };
type RetainedOptions<Command, Response> = {
  read(): Command | undefined;
  write(command: Command | null): boolean;
  retained(command: Command): void;
  send(command: Command): Promise<Response>;
};

export function runRetainedTeamAction(options: RetainedOptions<PendingTeamAction, unknown>, proposed?: PendingTeamAction) {
  return runRetainedTeamRequest(options, proposed);
}

export function runRetainedTeamStart(options: RetainedOptions<PendingTeamStart, TeamWork>, proposed?: PendingTeamStart) {
  return runRetainedTeamRequest(options, proposed);
}

/** Persist before dispatch; an uncertain response always reuses the original command. */
async function runRetainedTeamRequest<Command extends { requestId: string }, Response>(options: RetainedOptions<Command, Response>, proposed?: Command): Promise<Result<Command, Response>> {
  const command = options.read() ?? proposed;
  if (!command) return { confirmed: false, error: '' };
  if (!options.write(command)) return { command, pending: options.read() ?? command, confirmed: false, error: 'Free browser storage before continuing. Your saved work and original request are kept.' };
  options.retained(command);
  const clear = () => {
    const current = options.read();
    return current?.requestId === command.requestId && options.write(null);
  };
  try {
    const response = await options.send(command);
    const cleared = clear();
    return { command, pending: cleared ? undefined : options.read() ?? command, response, confirmed: true, error: cleared ? '' : 'The action was confirmed, but its local receipt could not clear. Reconcile the original request after freeing browser storage.' };
  } catch (reason) {
    const cleared = workRequestRejected(reason) && clear();
    return { command, pending: cleared ? undefined : options.read() ?? command, confirmed: false, error: reason instanceof Error ? reason.message : 'This action was not confirmed. Reconcile the original request.' };
  }
}
