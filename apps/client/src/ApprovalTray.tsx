import { QuestionCard } from './QuestionCard';
import { useState } from 'react';
import type { ApprovalSnapshot, ReviewApproval } from '../../../packages/domain/approvals';
import type { AssistantController } from './useAssistant';
import { request } from './api';
import { useDeadline } from './useDeadline';

const labels = { 'allow-once': 'Allow once', 'allow-always': 'Always allow', deny: 'Deny' };
function ApprovalContent({ snapshot }: { snapshot: ApprovalSnapshot }) {
  const p = snapshot.presentation, scope = 'scope' in p ? p.scope : undefined;
  return <><strong>{p.kind === 'exec' ? 'Run this command?' : p.title}</strong>{p.kind === 'exec' ? <><pre>{p.commandText}</pre>{p.warningText && <p className="approval-warning">{p.warningText}</p>}{p.host && <p className="metadata">Host: {p.host}</p>}</> : <><p>{p.description}</p>{p.kind === 'plugin' && <>{p.toolName && <p className="metadata">Tool: <code>{p.toolName}</code></p>}{p.detail?.trim() ? <details open><summary>Action details</summary><pre>{p.detail}</pre></details> : p.toolName && <p className="metadata">This tool did not supply action arguments for review. Its name alone does not describe the input it will use.</p>}</>}</>}{scope && <p className="approval-scope">{scope.kind === 'message-send' ? `${scope.target} · ${scope.recipientCount} recipients${scope.audience ? ` · ${scope.audience}` : ''}${scope.recipients?.length ? ` · ${scope.recipients.join(', ')}` : ''}` : scope.kind === 'payment' ? `${scope.amount} ${scope.currency} to ${scope.target}` : scope.kind === 'external-post' ? `${scope.target} · ${scope.visibility}` : `Always allow applies to ${scope.command} in ${scope.automation}${scope.expiresInDays ? ` for ${scope.expiresInDays} days` : ' until revoked or the automation changes'}.`}</p>}</>;
}
export function ApprovalCard({ item, epoch, ready, refresh, readOnly = false, deadlineAt }: { item: ReviewApproval; epoch: string; ready: boolean; refresh: () => Promise<void>; readOnly?: boolean; deadlineAt?: number }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = item.snapshot.status === 'pending', sending = item.action?.state === 'sending', unknown = item.action?.state === 'unknown';
  const expiresAt = Math.min(item.snapshot.expiresAtMs, deadlineAt ?? Infinity);
  const clock = useDeadline(expiresAt, pending && !readOnly);
  const check = async (decision?: keyof typeof labels) => {
    if (decision && (readOnly || Date.now() >= expiresAt)) return;
    setBusy(true); setError('');
    try { await request(`assistant/approval/${decision ? 'resolve' : 'check'}`, { requestId: crypto.randomUUID(), epoch, id: item.id, ...(decision ? { expectedRevision: item.revision, decision } : {}) }, undefined, 30000); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The approval could not be confirmed. Check its status.'); }
    finally { try { await refresh(); } catch { setError('The latest approval status could not load. Check its status before continuing.'); } finally { setBusy(false); } }
  };
  const p = item.snapshot.presentation;
  return <section className="approval-card" aria-label="Action approval"><ApprovalContent snapshot={item.snapshot}/>{pending ? <>{!readOnly && <p className="metadata">{clock.expired ? 'The review window has elapsed. Check its final status.' : <>Review available for <time dateTime={new Date(expiresAt).toISOString()}>{clock.remaining}</time>{deadlineAt !== undefined && ' · Assignment time includes approval waiting.'}</>}</p>}<div className="button-row">{!unknown && !sending && p.allowedDecisions.map(decision => <button key={decision} disabled={busy || !ready || readOnly || clock.expired} onClick={() => void check(decision)}>{p.kind === 'plugin' && p.externalResolution?.decisions.some(d => d === decision) ? <span className="preserve-case">{p.externalResolution.label}</span> : labels[decision]}</button>)}<button className="text-button" disabled={busy || !ready || sending} onClick={() => void check()}>{sending ? 'Confirming…' : 'Check status'}</button></div>{unknown && <p role="status">{item.action?.message}</p>}{readOnly && <p className="metadata">Approval is unavailable for this saved work.</p>}</> : <p className="approval-outcome">{item.snapshot.status === 'allowed' ? labels[item.snapshot.decision === 'allow-always' ? 'allow-always' : 'allow-once'] : item.snapshot.status}{item.snapshot.reason && item.snapshot.reason !== 'user' ? ` · ${item.snapshot.reason.replaceAll('-', ' ')}` : ''}{item.action?.message && ` · ${item.action.message}`}</p>}{error && <p role="alert">{error}</p>}</section>;
}
export function ApprovalTray({ controller, conversationId, epoch, working }: { controller: AssistantController; conversationId?: string; epoch: string; working: boolean }) {
  const approvals = controller.approvals, questions = controller.questions;
  const pending = approvals?.items.filter(item => item.snapshot.status === 'pending') ?? [], visibleQuestions = questions?.items.filter(item => !item.dismissed) ?? [];
  const here = pending.filter(item => item.conversationId === conversationId), questionHere = visibleQuestions.filter(item => item.conversationId === conversationId);
  const elsewhere = [...new Set([...pending, ...visibleQuestions.filter(q => q.snapshot.status === 'pending')].filter(item => item.conversationId !== conversationId).map(item => item.conversationId))];
  const count = here.length + questionHere.length, messages = [approvals?.message, questions?.message].filter(Boolean);
  if (!count && !elsewhere.length && !(working && messages.length)) return null;
  return <details className="approval-tray" open={count > 0}><summary>{count ? questionHere.length ? `${count} ${count === 1 ? 'request' : 'requests'} from Nova` : `${here.length} ${here.length === 1 ? 'action needs' : 'actions need'} your approval` : elsewhere.length ? 'Requests in other chats' : 'Review connection'}</summary><div className="approval-tray-content">{messages.map(message => <p role="status" key={message}>{message}</p>)}{questionHere.map(item => <QuestionCard key={item.id} item={item} epoch={epoch} ready={questions?.state === 'ready'} refresh={controller.refresh}/>)}{here.map(item => <ApprovalCard key={item.id} item={item} epoch={epoch} ready={approvals?.state === 'ready'} refresh={controller.refresh}/>)}{elsewhere.map(id => <button className="text-button" key={id} onClick={() => controller.select(id)}>Review · <span className="preserve-case">{controller.conversations.find(c => c.id === id)?.title ?? 'Conversation'}</span></button>)}</div></details>;
}
