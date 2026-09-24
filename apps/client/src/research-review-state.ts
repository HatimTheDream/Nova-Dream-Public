import { useEffect, useRef, useState } from 'react';
import type { AssistantPlan } from '../../../packages/domain/assistant-plan';
import { ApiError, readLocal, request, saveLocal } from './api';

type Action = 'approve' | 'amend' | 'hold' | 'cancel';
type Input = { requestId: string; epoch: string; id: string; expectedRevision: number; version: number; digest: string; text?: string };
type Receipt = { action: Action; input: Input; submittedText: string; accepted?: boolean; confirmed?: AssistantPlan };
type Options = { item?: AssistantPlan; epoch: string; ready: boolean; refresh: () => Promise<void>; readOnly?: boolean; onApproved?: () => void };
const reviewable = new Set<AssistantPlan['state']>(['ready', 'failed', 'cancelled']);
const labels = { drafting: 'Preparing your research plan', ready: 'Ready to research', implementing: 'Researching', completed: 'Research complete', failed: 'Research needs attention', cancelled: 'Research cancelled', unknown: 'Checking the original research' };
const actions: Action[] = ['approve', 'amend', 'hold', 'cancel'];

/** Server-owned research decisions. Acknowledged holds, never UI timers, enable editing. */
export function useResearchReview({ item: supplied, epoch, ready, refresh, readOnly = false, onApproved }: Options) {
  const source = supplied?.kind === 'research' && supplied.epoch === epoch ? supplied : undefined;
  const view = `${epoch}:${source?.id ?? 'none'}:${source?.version ?? 0}`;
  const draftKey = `e3:research-amendment:${epoch}:${source?.id ?? 'none'}`;
  const receiptKey = `e3:research-decision:${view}`;
  const [writing, setWriting] = useState(() => ({ key: draftKey, text: readLocal<string>(draftKey) ?? '' }));
  const [feedback, setFeedback] = useState({ view, error: '' });
  const [, redraw] = useState(0);
  const inFlight = useRef(new Set<string>());
  const receipts = useRef(new Map<string, Receipt>());
  const acknowledged = useRef(new Map<string, AssistantPlan>());
  const getReceipt = (): Receipt | undefined => {
    const value = receipts.current.get(receiptKey) ?? readLocal<Receipt>(receiptKey);
    return source && value && actions.includes(value.action) && value.input?.epoch === epoch && value.input.id === source.id && value.input.version === source.version ? value : undefined;
  };
  const receipt = getReceipt();
  const confirmed = receipt?.confirmed ?? acknowledged.current.get(view);
  const item = source && confirmed?.id === source.id && confirmed.epoch === epoch && confirmed.version >= source.version && confirmed.revision > source.revision ? confirmed : source;
  const version = item?.versions.find(value => value.version === item.version), proposal = version?.proposal;
  const text = writing.key === draftKey ? writing.text : readLocal<string>(draftKey) ?? '';
  const pending = receipt && !receipt.accepted ? receipt : undefined;
  const accepted = !!receipt?.accepted && (receipt.action === 'approve' || receipt.action === 'amend');
  const pendingAction = pending?.action ?? (accepted ? receipt?.action : undefined);
  const busy = inFlight.current.has(view);
  const editing = !!item && item.autoStartHeld === 'editing' && reviewable.has(item.state) && !item.approval && !accepted;
  const interactive = !!item && item.version === source?.version && ready && !readOnly && !busy && !pending && !accepted && !item.approval;
  const canApprove = interactive && item.state === 'ready' && !!proposal;
  const canAmend = interactive && editing;
  const canHold = interactive && reviewable.has(item.state) && !editing;
  const canCancel = interactive && reviewable.has(item.state) && item.state !== 'cancelled';
  const scope = useRef({ view, revision: item?.revision, alive: true, ready, readOnly, editing, text });
  scope.current = { ...scope.current, view, revision: item?.revision, ready, readOnly, editing, text };
  useEffect(() => { scope.current.alive = true; return () => { scope.current.alive = false; }; }, []);
  const currentView = () => scope.current.alive && scope.current.view === view && !scope.current.readOnly;
  const setError = (error: string) => { if (scope.current.alive && scope.current.view === view) setFeedback({ view, error }); };
  const keepReceipt = (value: Receipt | null) => {
    if (value) receipts.current.set(receiptKey, value); else receipts.current.delete(receiptKey);
    return saveLocal(receiptKey, value);
  };
  const setText = (value: string) => {
    if (!currentView() || !scope.current.editing) return;
    scope.current.text = value; setWriting({ key: draftKey, text: value });
    if (!saveLocal(draftKey, value)) setError('Your changes are only in this view. Free browser storage before leaving.');
  };
  const act = async (action: Action, retryOriginal = false): Promise<void> => {
    if (!item || !currentView() || !scope.current.ready || scope.current.revision !== item.revision || inFlight.current.has(view)) return;
    const prior = getReceipt();
    if (retryOriginal ? !prior || prior.accepted : prior && !prior.accepted) { setError('Check the original decision before submitting another. Your writing is kept.'); return; }
    if (!retryOriginal && (prior?.accepted && ['approve', 'amend'].includes(prior.action) || (prior?.confirmed?.revision ?? acknowledged.current.get(view)?.revision ?? 0) > item.revision)) return;
    if (!retryOriginal && !(action === 'approve' ? canApprove : action === 'amend' ? canAmend && scope.current.text.trim() : action === 'hold' ? canHold : canCancel)) return;
    const submittedText = scope.current.text;
    const decision: Receipt = retryOriginal ? prior! : { action, submittedText, ...(confirmed ? { confirmed } : {}), input: {
      requestId: crypto.randomUUID(), epoch, id: item.id, expectedRevision: item.revision, version: item.version,
      digest: item.reviewDigest ?? version?.digest ?? '', ...(action === 'amend' ? { text: submittedText.trim() } : {}),
    } };
    // Retain the exact decision before any effect, including Hold and Cancel.
    if (!saveLocal(receiptKey, decision)) { setError('Your decision could not be saved safely. Free browser storage before continuing; your writing is kept.'); return; }
    receipts.current.set(receiptKey, decision); inFlight.current.add(view); redraw(value => value + 1); setError('');
    try {
      const result = await request<AssistantPlan>(`assistant/plan/${decision.action}`, decision.input);
      if (decision.action === 'hold' || decision.action === 'cancel') {
        // A replay returns the current record: another device may already have
        // revised or started it. Reconcile that state without reopening an old
        // editor or relabelling running work as cancelled.
        if (result?.id !== item.id || result.epoch !== epoch || result.kind !== 'research' || !Number.isSafeInteger(result.version) || result.version < decision.input.version || !Number.isSafeInteger(result.revision) || result.revision < decision.input.expectedRevision || !(result.state in labels)) throw Error('The research decision could not be confirmed. Check its status before continuing.');
        acknowledged.current.set(view, result);
        keepReceipt({ ...decision, accepted: true, confirmed: result });
      } else {
        keepReceipt({ ...decision, accepted: true });
        if (currentView() && decision.action === 'amend' && scope.current.text === decision.submittedText) { scope.current.text = ''; setWriting({ key: draftKey, text: '' }); saveLocal(draftKey, ''); }
        if (currentView() && decision.action === 'approve') onApproved?.();
      }
    } catch (reason) {
      // Definite pre-admission rejection releases the receipt. Network errors
      // keep the same request, version, revision, digest and amendment text.
      if (reason instanceof ApiError && reason.status && [400, 403, 404, 409, 422].includes(reason.status) && reason.code !== 'request_reused') keepReceipt(null);
      setError(reason instanceof Error ? reason.message : 'The research decision could not be confirmed. Check its status before continuing.');
    } finally {
      try { await refresh(); } catch { setError('The latest research could not load. Reconnect before continuing.'); }
      inFlight.current.delete(view); if (scope.current.alive) redraw(value => value + 1);
    }
  };
  const check = async () => {
    if (!currentView() || !scope.current.ready || inFlight.current.has(view)) return;
    inFlight.current.add(view); redraw(value => value + 1); setError('');
    try { await refresh(); } catch { setError('The latest research could not load. Reconnect before continuing.'); }
    finally { inFlight.current.delete(view); if (scope.current.alive) redraw(value => value + 1); }
  };
  return { item, version, proposal, status: item ? accepted && item.state === 'ready' ? 'Decision confirmed; refreshing research' : labels[item.state] : '',
    text, setText, editing, canHold, canCancel, canApprove, canStart: canApprove, canAmend, busy,
    error: feedback.view === view ? feedback.error : '', pendingAction, accepted, ready, readOnly,
    approve: () => act('approve'), start: () => act('approve'), amend: () => act('amend'), hold: () => act('hold'), cancel: () => act('cancel'),
    retry: () => { const original = getReceipt(); return original ? act(original.action, true) : Promise.resolve(); }, check };
}
export type ResearchReviewController = ReturnType<typeof useResearchReview>;
