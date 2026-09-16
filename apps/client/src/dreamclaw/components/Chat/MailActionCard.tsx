import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Ban,
  Unblock,
  Unsubscribe,
  MailOpen,
  Check,
  Clock,
  Inbox,
  Loader2,
  Mail,
  Undo,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
  X,
} from '@dreamclaw/components/icons';
import { useInboxHost } from '../../inbox-host';
import type { MailActionKind, MailActionPlan } from '@dreamclaw/types/RenderBlock';
import clsx from 'clsx';

interface MailActionCardProps {
  messageId?: string;
  plan: MailActionPlan;
  onPlanChange?: (plan: MailActionPlan, prose: string) => void;
  onSettled?: (plan: MailActionPlan) => void | Promise<void>;
}

function actionLabel(action: MailActionKind, organization?: string): string {
  switch (action) {
    case 'delete': return 'Move to trash';
    case 'archive': return 'Archive';
    case 'mark-read': return 'Mark as read';
    case 'mark-unread': return 'Mark as unread';
    case 'flag': return 'Star or flag';
    case 'unflag': return 'Remove star or flag';
    case 'organize': return `Organize as ${organization || 'label'}`;
    case 'remove-organization': return `Remove ${organization || 'label'}`;
    case 'unsubscribe': return 'Unsubscribe';
    case 'block-sender': return 'Block sender';
    case 'unblock-sender': return 'Unblock sender';
  }
}

function ActionIcon({ action }: { action: MailActionKind }) {
  const props = { size: 18, emphasis: 'duotone' as const, decorative: true };
  if (action === 'delete') return <Trash2 {...props} tone="coral" />;
  if (action === 'archive') return <Archive {...props} tone="sky" />;
  if (action === 'flag' || action === 'unflag') return <Star {...props} tone="gold" />;
  if (action === 'organize' || action === 'remove-organization') return <Tag {...props} tone="violet" />;
  if (action === 'block-sender') return <Ban {...props} tone="coral" />;
  if (action === 'unblock-sender') return <Unblock {...props}/>;
  if (action === 'unsubscribe') return <Unsubscribe {...props}/>;
  if (action === 'mark-read') return <MailOpen {...props}/>;
  return <Mail {...props} tone="sky" />;
}

function serializePlan(plan: MailActionPlan, prose: string): string {
  return `${prose.trim()}\n\n<dreamclaw_mail_action>${JSON.stringify(plan)}</dreamclaw_mail_action>`;
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function MailActionCard({ messageId, plan, onPlanChange, onSettled }: MailActionCardProps) {
  const host = useInboxHost();
  const [busyAction, setBusyAction] = useState<string>();
  const busy=!!busyAction;
  const visibleTargets = useMemo(() => plan.targets, [plan.targets]);
  const awaiting = plan.status === 'awaiting_confirmation';
  const applying = plan.status === 'applying';
  const completed = plan.status === 'completed';
  const partial = plan.status === 'partial';
  const cancelled = plan.status === 'cancelled';
  const expired = plan.status === 'expired';
  const undone = plan.receipt?.status === 'undone';

  const replacePlan = (next: MailActionPlan, prose: string) => {
    if (onPlanChange) onPlanChange(next, prose);
    else if (messageId) throw new Error('This action needs its source conversation adapter.');
  };

  const [problem, setProblem] = useState('');
  const run = async (action:'apply'|'undo'|'cancel'|'check'|'acknowledge') => {
    if (busy) return;
    const api=host.api?.mailAssistant;if(!api)return;
    setBusyAction(action);setProblem('');
    try {
      const result = action==='undo' ? await api.undo({receiptId:plan.receipt!.id,digest:plan.receipt!.undo.digest!})
        : action==='check' ? await api.check({planId:plan.id})
        : await api[action]({planId:plan.id,digest:plan.digest});
      replacePlan(result.plan,result.message);
      await onSettled?.(result.plan);
    } catch(error) { setProblem(error instanceof Error ? error.message : 'The provider result is not confirmed. Check this saved review.'); }
    finally {setBusyAction(undefined);}
  };
  const handleApply=()=>run('apply'),handleUndo=()=>run('undo'),handleCancel=()=>run('cancel');

  return (
    <div className="px-5 py-2">
      <section
        data-mail-action-status={plan.status}
        className={clsx(
          'mx-auto max-w-[860px] overflow-hidden rounded-xl border bg-[rgb(var(--aegis-overlay)/0.035)] shadow-sm',
          plan.destructive && awaiting
            ? 'border-aegis-danger/35'
            : completed
              ? 'border-aegis-success/30'
              : partial || expired
                ? 'border-aegis-warning/35'
                : 'border-aegis-primary/25',
        )}
      >
        <header className="flex items-start gap-3 border-b border-[rgb(var(--aegis-overlay)/0.07)] px-4 py-3.5">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[rgb(var(--aegis-overlay)/0.06)]">
            {completed || undone
              ? <ShieldCheck size={19} emphasis="duotone" tone="success" decorative />
              : cancelled
                ? <X size={18} className="text-aegis-text-muted" />
                : <ActionIcon action={plan.action} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[14px] font-semibold text-aegis-text">{actionLabel(plan.action, plan.organization)}</h3>
              <span className={clsx(
                'rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]',
                awaiting ? 'border-aegis-warning/25 bg-aegis-warning/10 text-aegis-warning'
                  : completed ? 'border-aegis-success/25 bg-aegis-success/10 text-aegis-success'
                    : cancelled ? 'border-aegis-border text-aegis-text-muted'
                      : 'border-aegis-danger/25 bg-aegis-danger/10 text-aegis-danger',
              )}>
                {awaiting ? 'Confirmation required' : undone ? 'Undone' : plan.status.replace('_', ' ')}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-aegis-text-muted">{plan.summary}</p>
          </div>
        </header>

        {awaiting && (
          <div className="px-4 py-3">
            {plan.warning && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-aegis-warning/20 bg-aegis-warning/[0.07] px-3 py-2 text-[11px] leading-5 text-aegis-text-muted">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-aegis-warning" />
                <span>{plan.warning}</span>
              </div>
            )}
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              {plan.scopes.map((scope) => (
                <div key={`${scope.provider}:${plan.accountLabels?.[scope.accountId]??scope.accountId}`} className="rounded-lg border border-[rgb(var(--aegis-overlay)/0.08)] px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="font-semibold text-aegis-text">{scope.provider === 'gmail' ? 'Gmail' : 'Outlook'}</span>
                    <span className="truncate text-aegis-text-muted">{plan.accountLabels?.[scope.accountId]??scope.accountId}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[10px] text-aegis-text-muted">
                    <span>{scope.before}</span>
                    <span aria-hidden="true">→</span>
                    <span className="text-right font-medium text-aegis-text">{scope.after}</span>
                  </div>
                  <div className="mt-1.5 text-[10px] text-aegis-text-dim">
                    {scope.targetCount.toLocaleString()} conversation{scope.targetCount === 1 ? '' : 's'} · {scope.messageCount.toLocaleString()} message{scope.messageCount === 1 ? '' : 's'}
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              {visibleTargets.map((target) => (
                <div
                  key={`${target.provider}:${plan.accountLabels?.[target.accountId]??target.accountId}:${target.threadId}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-xl border border-[rgb(var(--aegis-overlay)/0.06)] bg-[rgb(var(--aegis-overlay)/0.025)] px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-semibold text-aegis-text">{target.subject}</div>
                    <div className="mt-0.5 truncate text-[10px] text-aegis-text-muted">{target.from}</div>
                    <div className="mt-1 text-[10px] text-aegis-text-dim">{target.before} → {target.after}</div>
                    {target.actionDetail && <div className="mt-1 text-[10px] leading-4 text-aegis-text-muted">{target.actionDetail}</div>}
                  </div>
                  <div className="text-right text-[9px] text-aegis-text-dim">
                    <div className="font-semibold uppercase tracking-wide">{target.provider === 'gmail' ? 'Gmail' : 'Outlook'}</div>
                    <div className="max-w-40 truncate">{plan.accountLabels?.[target.accountId]??target.accountId}</div>
                    <div>{formatDate(target.date)}</div>
                  </div>
                </div>
              ))}
            </div>
            {plan.targetCount > visibleTargets.length && (
              <div className="mt-2 text-[10px] text-aegis-text-dim">
                +{(plan.targetCount - visibleTargets.length).toLocaleString()} more matching conversations
              </div>
            )}
          </div>
        )}

        {!awaiting && (
          <div className="px-4 py-3">
            <div className="flex items-start gap-2 text-[12px] leading-5 text-aegis-text-muted">
              {completed ? <Check size={15} className="mt-0.5 shrink-0 text-aegis-success" /> : <Clock size={15} className="mt-0.5 shrink-0" />}
              <span>{plan.resultMessage || (applying ? 'Applying the approved provider changes…' : cancelled ? 'No email was changed.' : 'This email action is no longer pending.')}</span>
            </div>
            {plan.errors && plan.errors.length > 0 && (
              <ul className="mt-2 space-y-1 pl-5 text-[10px] text-aegis-danger">
                {plan.errors.map((error, index) => <li key={index}>{error}</li>)}
              </ul>
            )}
            {plan.receipt && (
              <div className="mt-3 rounded-lg border border-[rgb(var(--aegis-overlay)/0.08)] bg-[rgb(var(--aegis-overlay)/0.025)] px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[11px] font-semibold text-aegis-text">Approval receipt</div>
                    <div className="mt-0.5 text-[10px] text-aegis-text-dim">
                      Approved {new Date(plan.receipt.approvedAt).toLocaleString()} · Receipt {plan.receipt.id.slice(0, 8)}
                    </div>
                  </div>
                  <code className="rounded-md bg-[rgb(var(--aegis-overlay)/0.05)] px-2 py-1 text-[10px] text-aegis-text-muted">
                    {plan.receipt.approvalDigest.slice(0, 12)}
                  </code>
                </div>
                <div className="mt-2 text-[10px] text-aegis-text-muted">
                  {plan.receipt.succeeded.toLocaleString()} completed · {plan.receipt.failed.toLocaleString()} failed · {plan.receipt.scopes.map((scope) => `${scope.provider === 'gmail' ? 'Gmail' : 'Outlook'} ${plan.accountLabels?.[scope.accountId]??scope.accountId}`).join(' · ')}
                </div>
                {plan.receipt.undo.status !== 'available' && (
                  <div className={clsx(
                    'mt-2 text-[10px]',
                    plan.receipt.undo.status === 'completed' ? 'text-aegis-success' : 'text-aegis-text-dim',
                  )}>
                    {plan.receipt.undo.status === 'completed'
                      ? 'Rollback completed and recorded.'
                      : plan.receipt.undo.reason || `Undo is ${plan.receipt.undo.status}.`}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {problem && <p role="alert" className="px-4 py-2 text-[12px] text-aegis-danger">{problem}</p>}
        <details className="mail-outcomes mx-4 mb-3"><summary>Messages in this review ({plan.outcomes.length})</summary>
          <ol>{plan.outcomes.map(outcome=><li key={`${outcome.accountId}:${outcome.messageId}`}><strong>{outcome.subject||'No subject'}</strong><span>{outcome.state}{outcome.undo?` · Undo ${outcome.undo}`:''}</span>{outcome.detail&&<p>{outcome.detail}</p>}</li>)}</ol>
        </details>
        {plan.canCheck && !applying && <details className="mx-4 mb-3 text-[12px]"><summary>Keep the current state instead</summary><p>This reads the remaining uncertain messages and releases their review. It does not repeat the action or undo an uncertain change.</p><button className="mail-triage-button" disabled={busy} onClick={()=>void run('acknowledge')}>Keep current state</button></details>}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[rgb(var(--aegis-overlay)/0.07)] px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10px] text-aegis-text-dim">
            <ShieldCheck size={12} decorative />
            {awaiting?'Review expires in 10 minutes':'Saved review · no automatic retry'}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="mail-triage-button" disabled={busy} onClick={()=>void run('check')}>Check saved review</button>
            {!awaiting && plan.canUndo && (
              <button
                onClick={() => void handleUndo()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-aegis-primary/30 px-3 py-1.5 text-[11px] font-semibold text-aegis-primary transition-colors hover:bg-aegis-primary/10 disabled:opacity-50"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Undo size={13} />}
                {busyAction==='undo' ? 'Undoing…' : 'Undo provider changes'}
              </button>
            )}
            {!awaiting && (
              <button
                onClick={() => { host.triage.open(); }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-aegis-border px-3 py-1.5 text-[11px] font-semibold text-aegis-text-muted transition-colors hover:bg-[rgb(var(--aegis-overlay)/0.05)] hover:text-aegis-text"
              >
                <Inbox size={13} />
                Back to Inbox
              </button>
            )}
            {awaiting && (
              <>
                <button
                  onClick={() => void handleCancel()}
                  disabled={busy}
                  className="rounded-lg border border-aegis-border px-3 py-1.5 text-[11px] font-semibold text-aegis-text-muted transition-colors hover:bg-[rgb(var(--aegis-overlay)/0.05)] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleApply()}
                  disabled={busy}
                  className={clsx(
                    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold text-white transition-colors disabled:opacity-50',
                    plan.destructive ? 'bg-aegis-danger hover:bg-aegis-danger/85' : 'bg-aegis-primary hover:bg-aegis-primary/85',
                  )}
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <ActionIcon action={plan.action} />}
                  {busyAction==='apply' ? 'Applying…' : `Confirm ${actionLabel(plan.action, plan.organization)}`}
                </button>
              </>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
