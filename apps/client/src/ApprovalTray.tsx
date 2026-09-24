import { QuestionCard } from './QuestionCard';
import { confirmedQuestion } from './question-transcript';
import { useState } from 'react';
import type { ApprovalSnapshot, ReviewApproval } from '../../../packages/domain/approvals';
import type { AssistantController } from './useAssistant';
import { request } from './api';
import { useDeadline } from './useDeadline';
import './approval-requests.css';

const labels = { 'allow-once': 'Allow once', 'allow-always': 'Always allow', deny: 'Deny' };
function ApprovalContent({ snapshot }: { snapshot: ApprovalSnapshot }) {
  const p = snapshot.presentation, scope = 'scope' in p ? p.scope : undefined;
  return <div className="request-content"><strong className="request-title">{p.kind === 'exec' ? 'Run this command?' : p.title}</strong>{p.kind === 'exec' ? <><pre tabIndex={0} aria-label="Command to review">{p.commandText}</pre>{p.warningText && <p className="approval-warning">{p.warningText}</p>}{p.host && <p className="request-context">Host: {p.host}</p>}</> : <><p>{p.description}</p>{p.kind === 'plugin' && <>{p.detail?.trim() ? <pre tabIndex={0} aria-label="Action details">{p.detail}</pre> : p.toolName && <p className="request-context">Input details were not supplied for this action.</p>}{p.toolName && <p className="request-context">Tool: <code>{p.toolName}</code></p>}</>}</>}{scope && <p className="approval-scope">{scope.kind === 'message-send' ? `${scope.target} · ${scope.recipientCount} recipients${scope.audience ? ` · ${scope.audience}` : ''}${scope.recipients?.length ? ` · ${scope.recipients.join(', ')}` : ''}` : scope.kind === 'payment' ? `${scope.amount} ${scope.currency} to ${scope.target}` : scope.kind === 'external-post' ? `${scope.target} · ${scope.visibility}` : `Always allow applies to ${scope.command} in ${scope.automation}${scope.expiresInDays ? ` for ${scope.expiresInDays} days` : ' until revoked or the automation changes'}.`}</p>}</div>;
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
  const recovering = unknown || clock.expired || !!error;
  const primary = p.allowedDecisions.some(decision => decision === 'allow-once') ? 'allow-once' : p.allowedDecisions.some(decision => decision === 'allow-always') ? 'allow-always' : 'deny';
  return <section className="approval-card request-card" aria-label="Action approval"><ApprovalContent snapshot={item.snapshot}/>{pending ? <>
    {readOnly ? <p className="request-context">Approval is unavailable for this saved work.</p>
      : sending ? <p className="request-state" role="status">Confirming your decision…</p>
      : unknown ? <p className="request-state" role="status">{item.action?.message ?? 'Your decision is unconfirmed. Check its status before deciding again.'}</p>
      : clock.expired ? <p className="request-state" role="status">The review window ended. Check the outcome.</p>
      : <p className="request-context">{!ready ? 'Reconnect to review this action.' : <>Review available for <time dateTime={new Date(expiresAt).toISOString()}>{clock.remaining}</time>{deadlineAt !== undefined && ' · Included in the assignment time limit'}</>}</p>}
    <div className="request-actions">{!unknown && !sending && !clock.expired && !readOnly && p.allowedDecisions.map(decision => <button type="button" className={decision === primary ? 'primary request-primary' : 'request-secondary'} key={decision} disabled={busy || !ready} onClick={() => void check(decision)}>{p.kind === 'plugin' && p.externalResolution?.decisions.some(d => d === decision) ? <span className="preserve-case">{p.externalResolution.label}</span> : labels[decision]}</button>)}
      {recovering && !sending && <button type="button" className={unknown || clock.expired ? 'primary request-primary' : 'request-secondary'} disabled={busy || !ready} onClick={() => void check()}>Check status</button>}
    </div>
  </> : <p className="request-state">{item.snapshot.status === 'allowed' ? item.snapshot.decision === 'allow-always' ? 'Always allowed' : 'Allowed once' : item.snapshot.status === 'denied' ? 'Denied' : item.snapshot.status === 'expired' ? 'Expired' : 'Cancelled'}{item.snapshot.reason && item.snapshot.reason !== 'user' ? ` · ${item.snapshot.reason.replaceAll('-', ' ')}` : ''}{item.action?.message && item.action.message !== 'Decision confirmed.' && ` · ${item.action.message}`}</p>}{error && <p role="alert">{error}</p>}</section>;
}
export function ApprovalTray({ controller, conversationId, epoch, working }: { controller: AssistantController; conversationId?: string; epoch: string; working: boolean }) {
  const approvals = controller.approvals, questions = controller.questions;
  const pending = approvals?.items.filter(item => item.snapshot.status === 'pending') ?? [], visibleQuestions = questions?.items.filter(item => !item.dismissed) ?? [];
  const here = pending.filter(item => item.conversationId === conversationId), questionHere = visibleQuestions.filter(item => item.conversationId === conversationId && !confirmedQuestion(item));
  const count = here.length + questionHere.length, messages = [approvals?.message, questions?.message].filter(Boolean);
  if (!count && !(working && messages.length)) return null;
  const single = questionHere[0];
  if (!here.length && questionHere.length === 1 && !messages.length && single.snapshot.questions.every(question => !question.isSecret)) return <div className="approval-tray request-tray compact-question-tray"><QuestionCard key={single.id} item={single} epoch={epoch} ready={questions?.state === 'ready'} refresh={controller.refresh} compact/></div>;
  const title = count > 1 ? `${count} requests need your attention` : here.length ? 'Approval needed' : questionHere.length ? questionHere[0].availability === 'missing' || questionHere[0].action ? 'Review request status' : 'Nova needs your answer' : 'Review connection';
  return <details className="approval-tray request-tray" open={count > 0}><summary>{title}</summary><div className="approval-tray-content">{messages.map(message => <p className="request-context" role="status" key={message}>{message}</p>)}{questionHere.map(item => <QuestionCard key={item.id} item={item} epoch={epoch} ready={questions?.state === 'ready'} refresh={controller.refresh}/>)}{here.map(item => <ApprovalCard key={item.id} item={item} epoch={epoch} ready={approvals?.state === 'ready'} refresh={controller.refresh}/>)}</div></details>;
}
