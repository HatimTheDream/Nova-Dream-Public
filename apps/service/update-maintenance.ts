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
/** Local evidence only. Empty blockers do not attest an external native host's
 * idle state. The supervisor must also verify its captured native authority. */
export function updateMaintenanceBlockers(store: Store, additional: Record<string, number | boolean> = {}): UpdateMaintenanceBlocker[] {
  const counts = new Map<string, number>();
  const add = (kind: string, count = 1) => { if (count > 0) counts.set(kind, (counts.get(kind) ?? 0) + count); };
  const list = (prefix: string) => store.internalList<Record<string, any>>(prefix);
  const states = (prefix: string, kind: string, terminal: string[], select = (row: any) => row) => {
    for (const row of list(prefix)) { const value = select(row); if (!value || typeof value.state !== 'string' || !terminal.includes(value.state)) add(kind); }
  };
  states('assistant:operation:', 'assistant', ['completed', 'failed', 'cancelled']);
  for (const conversation of list('assistant:conversation:')) if (['creating', 'unknown'].includes(conversation.state) || conversation.pendingSettings || conversation.pendingResume) add('assistant-context');
  // Do not use assignmentHoldsSlot here: acknowledging an uncertain assignment
  // can release its UI slot without proving that its original native run ended.
  states('assignments:summary:', 'assignments', ['returned', 'failed', 'cancelled']);
  states('tasks:suggestion:', 'suggestions', ['completed', 'failed', 'cancelled']);
  for (const team of list('team:run:')) if (!['paused', 'complete', 'cancelled', 'attention'].includes(team.state) || team.steps?.some((step: any) => step.state === 'unknown')) add('teams');
  for (const meeting of list('hub:meeting:')) if (!['gathered', 'paused', 'complete', 'ended'].includes(meeting.state) || meeting.turns?.some((turn: any) => turn.state === 'unknown')) add('meetings');
  for (const voice of list('voice:attempt:')) {
    if (!['ended', 'failed'].includes(voice.state) || !Array.isArray(voice.entries) || !Array.isArray(voice.consults) || voice.entries.some((entry: any) => entry.saved !== true) || voice.consults.some((consult: any) => !['completed', 'failed'].includes(consult.state))) add('voice');
  }
  for (const attempt of list('dictation:')) if (!['ended', 'failed'].includes(attempt.state) || attempt.cleanupPending) add('dictation');
  states('accounts:attempt:', 'sign-in', ['completed', 'failed', 'cancelled', 'expired']);
  for (const account of list('accounts:item:')) if (account.state === 'refreshing') add('account-refresh');
  states('accounts:order:', 'account-order', ['confirmed', 'not-sent']);
  const signInId = store.internalRead<string>('signin:chatgpt:current');
  if (signInId) { const attempt = store.internalRead<{ state: string; pid?: number }>('signin:chatgpt:' + signInId); if (!attempt || ['starting', 'waiting'].includes(attempt.state) || attempt.state === 'interrupted' && attempt.pid) add('sign-in'); }
  states('mail:delivery:head:', 'mail-delivery', ['prepared', 'saved', 'accepted', 'failed', 'cancelled'], row => row.review);
  states('calendar-write:operation:', 'calendar-write', ['review', 'confirmed', 'observed', 'conflict', 'failed', 'cancelled'], row => row.review);
  for (const head of list('mail:triage:head:')) if (head.running) add('mail-triage');
  for (const item of list('mail:triage:items:')) if (['applying', 'uncertain'].includes(item.outcome?.state) || ['applying', 'uncertain'].includes(item.outcome?.undo)) add('mail-triage');
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
