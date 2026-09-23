import { useEffect, useRef, useState } from 'react';
import type { AssistantPlan } from '../../../packages/domain/assistant-plan';
import { ApiError, readLocal, request, saveLocal } from './api';

type Decision = 'approve' | 'amend';
type DecisionInput = { requestId: string; epoch: string; id: string; expectedRevision: number; version: number; digest: string; text?: string };
type PendingDecision = { action: Decision; input: DecisionInput; signature: string; submittedText: string; accepted?: boolean };
type Options = { item?: AssistantPlan; epoch: string; ready: boolean; refresh: () => Promise<void>; readOnly?: boolean; onApproved?: () => void };
const statusLabels = { drafting: 'Preparing your plan', ready: 'Ready for review', implementing: 'Implementing approved plan', completed: 'Approved work finished', failed: 'Plan needs attention', cancelled: 'Planning stopped', unknown: 'Checking the original work' };

/** One review controller shared by the inline document and composer question. */
export function usePlanReview({ item, epoch, ready, refresh, readOnly = false, onApproved }: Options) {
  const version = item?.versions.find(value => value.version === item.version), proposal = version?.proposal;
  const draftKey = `e3:plan-amendment:${epoch}:${item?.id ?? 'none'}`;
  const decisionKey = `e3:plan-decision:${epoch}:${item?.id ?? 'none'}:${item?.version ?? 0}`;
  const identity = `${decisionKey}:${item?.revision ?? 0}`;
  const [writing, setWriting] = useState(() => ({ key: draftKey, value: readLocal<string>(draftKey) ?? '' }));
  const text = writing.key === draftKey ? writing.value : readLocal<string>(draftKey) ?? '';
  const [hidden, setHidden] = useState(() => ({ key: decisionKey, value: readLocal<boolean>(decisionKey) === true }));
  const skipped = hidden.key === decisionKey ? hidden.value : readLocal<boolean>(decisionKey) === true;
  const [feedback, setFeedback] = useState({ identity, error: '' });
  const [, updateBusy] = useState(0);
  const inFlight = useRef(new Set<string>());
  const scope = useRef({ identity, draftKey, text, alive: true, readOnly, ready });
  scope.current = { ...scope.current, identity, draftKey, text, readOnly, ready };
  useEffect(() => { scope.current.alive = true; return () => { scope.current.alive = false; }; }, []);
  const busy = inFlight.current.has(identity);
  const error = feedback.identity === identity ? feedback.error : '';
  const setError = (message: string) => { if (scope.current.alive && scope.current.identity === identity) setFeedback({ identity, error: message }); };
  const getPending = (): PendingDecision | undefined => {
    if (!item) return;
    const kept = readLocal<PendingDecision>(`${decisionKey}:pending`);
    if (kept?.input?.id === item.id && kept.input.epoch === epoch && kept.input.version === item.version && ['approve', 'amend'].includes(kept.action)) return kept;
    // Reopen decisions retained by earlier clients with their original identity.
    for (const action of ['amend', 'approve'] as const) {
      const prior = readLocal<{ requestId: string; signature: string }>(`${draftKey}:${item.revision}:${action}`);
      if (prior?.requestId && typeof prior.signature === 'string') return { action, signature: prior.signature, submittedText: prior.signature, input: { requestId: prior.requestId, epoch, id: item.id, expectedRevision: item.revision, version: item.version, digest: item.reviewDigest ?? version?.digest ?? '', ...(action === 'amend' ? { text: prior.signature } : {}) } };
    }
  };
  const pending = getPending(), pendingAction = pending?.action;
  const accepted = !!pending?.accepted;
  const needsDecision = !!item && !item.approval && (['ready', 'failed', 'cancelled'].includes(item.state) || !!pending && !accepted);
  const canReview = needsDecision && !readOnly && !accepted;
  const decisionVisible = canReview && !skipped;
  const interactive = !!item && !readOnly && ready && !busy && !accepted;
  const canApprove = interactive && !pending && item.state === 'ready' && !!proposal && !item.approval;
  const canAmend = interactive && !pending && ['ready', 'failed', 'cancelled'].includes(item.state) && !item.approval;

  const setText = (value: string) => {
    if (!item || readOnly || scope.current.readOnly || scope.current.identity !== identity) return;
    scope.current.text = value;
    setWriting({ key: draftKey, value });
    if (!saveLocal(draftKey, value)) setError('Your changes are only in this view. Free browser storage before leaving.');
  };
  const openDecision = () => {
    if (!canReview || scope.current.identity !== identity) return;
    saveLocal(decisionKey, false); setHidden({ key: decisionKey, value: false });
  };
  const skip = () => {
    if (!canReview || inFlight.current.has(identity) || scope.current.identity !== identity) return;
    // Only defer presentation. Keep the amendment draft and unresolved receipt.
    if (!saveLocal(draftKey, scope.current.text)) { setError('Your changes are only in this view. Free browser storage before reviewing later.'); return; }
    saveLocal(decisionKey, true); setHidden({ key: decisionKey, value: true });
  };
  const act = async (action: Decision, retryOriginal = false) => {
    if (!item || !interactive || scope.current.readOnly || !scope.current.ready || inFlight.current.has(identity) || scope.current.identity !== identity) return;
    const prior = getPending();
    if (retryOriginal ? !prior || prior.accepted : !!prior) { setError('Check the original decision before submitting different changes. Your writing is kept.'); return; }
    if (!retryOriginal && (action === 'approve' ? !canApprove : !canAmend || !scope.current.text.trim())) return;
    const submittedText = scope.current.text, signature = action === 'amend' ? submittedText.trim() : 'approve';
    const receipt: PendingDecision = retryOriginal ? prior! : { action, signature, submittedText, input: { requestId: crypto.randomUUID(), epoch, id: item.id, expectedRevision: item.revision, version: item.version, digest: item.reviewDigest ?? version?.digest ?? '', ...(action === 'amend' ? { text: signature } : {}) } };
    const legacyKey = `${draftKey}:${receipt.input.expectedRevision}:${receipt.action}`;
    if (!saveLocal(legacyKey, { requestId: receipt.input.requestId, signature: receipt.signature }) || !saveLocal(`${decisionKey}:pending`, receipt)) { setError('Your decision could not be saved safely. Free browser storage before continuing; your writing is kept.'); return; }
    inFlight.current.add(identity); updateBusy(value => value + 1); setError('');
    const currentView = () => scope.current.alive && scope.current.identity === identity && !scope.current.readOnly;
    try {
      await request(`assistant/plan/${receipt.action}`, receipt.input);
      saveLocal(`${decisionKey}:pending`, { ...receipt, accepted: true });
      if (currentView() && receipt.action === 'amend' && scope.current.text === receipt.submittedText) { scope.current.text = ''; setWriting({ key: draftKey, value: '' }); saveLocal(draftKey, ''); }
      if (currentView() && receipt.action === 'approve') onApproved?.();
    } catch (reason) {
      // A definitive pre-admission rejection releases the decision. A transport
      // failure retains the exact captured version, revision, digest and text.
      if (reason instanceof ApiError && reason.status && [400, 403, 404, 409, 422].includes(reason.status) && reason.code !== 'request_reused') { saveLocal(legacyKey, null); saveLocal(`${decisionKey}:pending`, null); }
      setError(reason instanceof Error ? reason.message : 'The decision could not be confirmed. Check its status before continuing.');
    } finally {
      try { await refresh(); } catch { setError('The latest plan could not load. Reconnect before continuing.'); }
      inFlight.current.delete(identity);
      if (scope.current.alive) updateBusy(value => value + 1);
    }
  };
  const check = async () => {
    if (!ready || inFlight.current.has(identity)) return;
    inFlight.current.add(identity); updateBusy(value => value + 1); setError('');
    try { await refresh(); } catch { setError('The latest plan could not load. Reconnect before continuing.'); }
    finally { inFlight.current.delete(identity); if (scope.current.alive) updateBusy(value => value + 1); }
  };
  return { item, version, proposal, status: item ? accepted && item.state === 'ready' ? 'Decision confirmed; refreshing plan' : statusLabels[item.state] : '', decisionVisible, canReview, openDecision, skip, text, setText, busy, error, pendingAction, accepted, ready, readOnly, canApprove, canAmend, approve: () => act('approve'), amend: () => act('amend'), retry: () => { const prior = getPending(); return prior ? act(prior.action, true) : Promise.resolve(); }, check };
}
export type PlanReviewController = ReturnType<typeof usePlanReview>;
