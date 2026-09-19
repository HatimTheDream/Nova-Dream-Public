import { ApiError } from './api';

// These checks run only after the endpoint has looked for its original receipt,
// and before it admits a new operation. Generic validation, authentication,
// client/epoch gates and upstream GitHub errors can block receipt replay itself:
// they do not prove that an earlier attempt with this ID was rejected.
const admissionRejections = new Set([
  'team_limit', 'team_project', 'team_agent', 'team_busy', 'team_checkout_busy',
  'team_changed', 'team_review_unfinished', 'team_review_limit', 'team_review_missing',
  'team_review_changed', 'team_review_builder', 'team_project_changed',
  'team_agent_changed', 'team_agent_busy', 'team_ended', 'team_retry_unconfirmed',
  'team_state', 'team_review', 'team_unsettled',
  'work_preparing', 'work_unmanaged', 'work_folder_changed', 'work_config_changed',
  'work_remote_changed', 'work_branch_changed', 'work_changed', 'work_busy',
  'work_read_only', 'work_publication_pending', 'work_empty', 'work_uncommitted',
  'browser_disabled', 'browser_tab', 'browser_stale',
]);

export const workRequestRejected = (error: unknown) => error instanceof ApiError &&
  error.status === 409 && admissionRejections.has(error.code);
