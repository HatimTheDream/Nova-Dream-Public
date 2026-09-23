import type { ProjectOrganization } from '../../../packages/domain/contracts';
import { ApiError } from './api';

export type PendingProjectOrganization = { requestId: string; epoch: string; projectId: string; projectRevision: number; expectedRevision: number; action: 'delete' | 'restore' };
type Options = {
  read(): PendingProjectOrganization | undefined;
  write(command: PendingProjectOrganization | null): boolean;
  retained(command: PendingProjectOrganization): void;
  send(command: PendingProjectOrganization): Promise<ProjectOrganization>;
  refresh(): Promise<void>;
};
type Result = { pending?: PendingProjectOrganization; confirmed: boolean; acknowledged?: ProjectOrganization; error: string };

/** Keep the exact receipt through the request and refresh attempt; the dialog observes the visible revision. */
export async function runRetainedProjectOrganization(options: Options, proposed?: PendingProjectOrganization): Promise<Result> {
  const command = options.read() ?? proposed;
  if (!command) return { confirmed: false, error: '' };
  if (!options.write(command)) return { pending: options.read(), confirmed: false, error: 'Free browser storage before changing this project.' };
  options.retained(command);
  const pending = () => options.read() ?? command;
  const clear = () => options.read()?.requestId === command.requestId && options.write(null);
  let acknowledged: ProjectOrganization;
  try { acknowledged = await options.send(command); }
  catch (failure) {
    // Only an endpoint admission conflict proves that this exact request did not run.
    const cleared = failure instanceof ApiError && failure.status === 409 && failure.code === 'project_changed' && clear();
    if (cleared) await options.refresh().catch(() => undefined);
    return { pending: cleared ? undefined : pending(), confirmed: false, error: failure instanceof Error ? failure.message : 'This change is not confirmed. Check again to finish the same request.' };
  }
  try { await options.refresh(); }
  catch (failure) { return { pending: pending(), confirmed: false, error: failure instanceof Error ? failure.message : 'The change is saved, but the latest project list could not load. Check again.' }; }
  const cleared = clear();
  return { pending: cleared ? undefined : pending(), confirmed: true, acknowledged, error: cleared ? '' : 'The change is saved, but its local receipt could not clear. Check again to finish the same request.' };
}
