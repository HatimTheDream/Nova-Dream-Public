import type { Store } from './store.js';

// New execution is denied by default. These methods observe existing work or
// finish an existing call. Resolving a question/approval positively can restart
// native execution, so only explicit cancellation/rejection passes the hold.
const reads = new Set(['e3.workspace.policy', 'e3.accounts.snapshot', 'usage.status', 'usage.cost', 'sessions.diff', 'e3.assignments.capabilities', 'e3.assignments.status', 'models.list', 'models.authStatus', 'sessions.describe', 'sessions.list', 'sessions.search', 'sessions.subscribe', 'sessions.messages.subscribe', 'chat.history', 'agent.wait', 'artifacts.download', 'talk.catalog', 'skills.status', 'skills.proposals.list', 'skills.proposals.inspect', 'skills.proposals.events.list', 'question.list', 'question.get', 'approval.get']);
const settling = new Set(['chat.abort', 'e3.assignments.stop', 'talk.client.close', 'talk.client.transcript', 'talk.session.close', 'talk.session.appendAudio']);
export function maintenanceGatewayKind(method: string, params: unknown): 'read' | 'settling' | 'effect' {
  if (method === 'system.info' || method === 'gateway.suspend.status') return 'read';
  if (method === 'gateway.suspend.prepare' || method === 'gateway.suspend.resume') return 'settling';
  if (reads.has(method)) return 'read';
  if (settling.has(method)) return 'settling';
  const input = params && typeof params === 'object' ? params as Record<string, unknown> : {};
  if (method === 'question.resolve' && input.cancel === true || method === 'approval.resolve' && input.decision === 'deny') return 'settling';
  if (method === 'sessions.goal.clear' || method === 'sessions.goal.update' && ['pause', 'complete'].includes(String(input.action))) return 'settling';
  if (method === 'browser.request' && input.method === 'GET') return 'read';
  if (method === 'browser.request' && input.method === 'POST' && input.path === '/stop') return 'settling';
  return 'effect';
}

export type UpdateMaintenanceBlocker = { kind: string; count: number };
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const terminalOperation = (state: unknown) => ['completed', 'failed', 'cancelled'].includes(String(state));

// These predicates establish only that Nova cannot automatically dispatch the
// saved record again. They do not establish its outcome or native idleness.
// NativeUpdateLease must still hold the process-wide native suspension and
// qualify its durable startup journals before the root updater can activate.
function retainedAssistant(operation: Record<string, any>, conversations: Record<string, any>[], epoch: string) {
  const conversation = conversations.find(row => row.id === operation.conversationId);
  return operation.state === 'unknown' && operation.epoch === epoch
    && ['id', 'requestId', 'conversationId', 'nativeKey', 'nativeId', 'nativeRunId', 'connectionGeneration'].every(key => text(operation[key]))
    && !operation.cancelRequested && !operation.steerTarget
    && conversation?.state === 'ready' && !conversation.pendingSettings && !conversation.pendingResume
    && conversation.nativeId === operation.nativeId && conversation.nativeKey === operation.nativeKey
    && conversation.connectionGeneration === operation.connectionGeneration;
}
function retainedMeeting(meeting: Record<string, any>, assignments: Record<string, any>[], epoch: string) {
  // HubMeetings.advance only selects the current epoch. An ended old meeting
  // with no retained assignment cannot restart its uncertain last speaker.
  return text(meeting.epoch) && meeting.epoch !== epoch && meeting.state === 'ended' && Array.isArray(meeting.turns)
    && meeting.turns.every((turn: any) => turn && text(turn.planId)
      && !assignments.some(attempt => attempt.assignmentId === turn.planId || text(turn.attemptId) && attempt.id === turn.attemptId));
}
function retainedMailDraft(head: Record<string, any>, epoch: string) {
  // MailDelivery skips older epochs at construction and owned() rejects them.
  // Limit this to an unconfirmed draft creation, never an uncertain send or a
  // multi-stage operation with provider objects/files still requiring review.
  const review = head.review;
  return review && text(review.epoch) && review.epoch !== epoch && text(review.id)
    && review.state === 'uncertain' && review.mode === 'draft' && review.phase === 'create' && head.attempted === 'create'
    && Array.isArray(head.completed) && head.completed.length === 0 && !head.files && !review.providerDraftId && !review.providerMessageId;
}
/** Local evidence only. Empty blockers do not attest an external native host's
 * idle state. The supervisor must also verify its captured native authority. */
export function updateMaintenanceBlockers(store: Store, additional: Record<string, number | boolean> = {}): UpdateMaintenanceBlocker[] {
  const counts = new Map<string, number>();
  const add = (kind: string, count = 1) => { if (count > 0) counts.set(kind, (counts.get(kind) ?? 0) + count); };
  const list = (prefix: string) => store.internalList<Record<string, any>>(prefix);
  const states = (prefix: string, kind: string, terminal: string[], select = (row: any) => row) => {
    for (const row of list(prefix)) { const value = select(row); if (!value || typeof value.state !== 'string' || !terminal.includes(value.state)) add(kind); }
  };
  const conversations = list('assistant:conversation:'), assignments = list('assignments:summary:');
  for (const operation of list('assistant:operation:')) if (!terminalOperation(operation.state) && !retainedAssistant(operation, conversations, store.epoch)) add('assistant');
  for (const conversation of conversations) if (['creating', 'unknown'].includes(conversation.state) || conversation.pendingSettings || conversation.pendingResume) add('assistant-context');
  states('assistant:removal:', 'assistant-context', ['completed', 'rejected']);
  // Keep future autonomous dispatch sources out of a restart, even if their
  // next scheduled time is later than this particular readiness check.
  for (const queue of list('assistant:queue:')) if (!['paused', 'submitted', 'removed'].includes(queue.state) || queue.state === 'paused' && queue.automatic) add('automatic-queue');
  for (const plan of list('assistant:plan:')) if (plan.kind === 'research' && plan.state === 'ready' && !plan.approval && plan.autoStartAt && plan.autoStartRequestId && !plan.autoStartHeld) add('automatic-research');
  for (const routine of list('agent-routines:item:')) if (!routine.value || routine.value.enabled && !routine.value.archived && !routine.attention && routine.nextAt !== null) add('agent-routines');
  // Do not use assignmentHoldsSlot here: acknowledging an uncertain assignment
  // can release its UI slot without proving that its original native run ended.
  states('assignments:summary:', 'assignments', ['returned', 'failed', 'cancelled']);
  states('tasks:suggestion:', 'suggestions', ['completed', 'failed', 'cancelled']);
  for (const team of list('team:run:')) if (!['paused', 'complete', 'cancelled', 'attention'].includes(team.state) || team.steps?.some((step: any) => step.state === 'unknown')) add('teams');
  for (const meeting of list('hub:meeting:')) if (!retainedMeeting(meeting, assignments, store.epoch)
    && (!['gathered', 'paused', 'complete', 'ended'].includes(meeting.state) || !Array.isArray(meeting.turns) || meeting.turns.some((turn: any) => ['unknown', 'running', 'dispatching', 'stopping'].includes(turn?.state)))) add('meetings');
  for (const voice of list('voice:attempt:')) {
    if (!['ended', 'failed'].includes(voice.state) || !Array.isArray(voice.entries) || !Array.isArray(voice.consults) || voice.entries.some((entry: any) => entry.saved !== true) || voice.consults.some((consult: any) => !['completed', 'failed'].includes(consult.state))) add('voice');
  }
  for (const attempt of list('dictation:')) if (!['ended', 'failed'].includes(attempt.state) || attempt.cleanupPending) add('dictation');
  states('accounts:attempt:', 'sign-in', ['completed', 'failed', 'cancelled', 'expired']);
  for (const account of list('accounts:item:')) if (account.state === 'refreshing') add('account-refresh');
  states('accounts:order:', 'account-order', ['confirmed', 'not-sent']);
  const signInId = store.internalRead<string>('signin:chatgpt:current');
  if (signInId) { const attempt = store.internalRead<{ state: string; pid?: number }>('signin:chatgpt:' + signInId); if (!attempt || ['starting', 'waiting'].includes(attempt.state) || attempt.state === 'interrupted' && attempt.pid) add('sign-in'); }
  for (const head of list('mail:delivery:head:')) if (!retainedMailDraft(head, store.epoch) && !['prepared', 'saved', 'accepted', 'failed', 'cancelled'].includes(head.review?.state)) add('mail-delivery');
  states('calendar-write:operation:', 'calendar-write', ['review', 'confirmed', 'observed', 'conflict', 'failed', 'cancelled'], row => row.review);
  for (const head of list('mail:triage:head:')) if (head.running) add('mail-triage');
  for (const item of list('mail:triage:items:')) if (['applying', 'uncertain'].includes(item.outcome?.state) || ['applying', 'uncertain'].includes(item.outcome?.undo)) add('mail-triage');
  const accounts = list('accounts:item:');
  for (const link of list('crm:address-link:')) {
    if (link.intent || link.state === 'unknown') add('contact-write');
    if (link.mode === 'both' && !['paused', 'missing', 'conflict'].includes(link.state)
      && accounts.some(account => account.id === link.accountId && account.generation === link.generation && account.state === 'connected' && account.capabilities?.contactsRead)) add('automatic-contacts');
  }
  states('modules:action:', 'module-actions', ['pending', 'applied', 'cancelled', 'failed', 'partial']);
  states('work:checkout:', 'work-checkout', ['ready', 'failed']);
  states('work:publication:', 'work-publication', ['complete', 'failed']);
  states('skill-management:operation:', 'skills', ['confirmed', 'not-sent']);
  states('companion:operation:', 'computer', ['completed', 'refused', 'cancelled']);
  const github = store.internalRead<{ state: string }>('work:github:attempt');
  if (github && !['connected', 'cancelled', 'failed'].includes(github.state)) add('sign-in');
  states('backup:job:', 'backup', ['ready', 'failed', 'removed']);
  for (const [kind, count] of [...Object.entries(store.updateEffectsInFlight()), ...Object.entries(additional)]) {
    if (typeof count === 'boolean') { if (count) add(kind); }
    else if (!Number.isSafeInteger(count) || count < 0) add('unverified');
    else add(kind, count);
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}
