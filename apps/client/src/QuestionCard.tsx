import { useEffect, useRef, useState } from 'react';
import type { AssistantQuestion, QuestionAnswers } from '../../../packages/domain/questions';
import { readLocal, request, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { useDeadline } from './useDeadline';
import './approval-requests.css';
import { ArrowUp, X } from './icons';

type Writing = { activeQuestionId?: string; other?: Record<string, boolean>; choices: Record<string, string[]>; text: Record<string, string> };
const blank = (): Writing => ({ choices: {}, text: {} });
type QuestionCardProps = { item: AssistantQuestion; epoch: string; ready: boolean; refresh: () => Promise<void>; readOnly?: boolean; compact?: boolean };
export function QuestionCard(props: QuestionCardProps) {
  return <QuestionForm key={`${props.epoch}:${props.item.id}`} {...props}/>;
}
function QuestionForm({ item, epoch, ready, refresh, readOnly = false, compact = false }: QuestionCardProps) {
  const secret = item.snapshot.questions.some(q => q.isSecret), key = `e3:question:${epoch}:${retainedWindowId}:${item.id}`;
  const [writing, setWriting] = useState<Writing>(() => secret ? blank() : readLocal<Writing>(key) ?? blank());
  const [secretValue, setSecretValue] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notSaved, setNotSaved] = useState(false);
  const [errorAction, setErrorAction] = useState('');
  const activeField = useRef<HTMLFieldSetElement>(null), focusQuestion = useRef(false);
  const pending = item.snapshot.status === 'pending', missing = item.availability === 'missing', uncertain = item.action?.state === 'unknown', sending = item.action?.state === 'sending';
  const live = pending && !missing, clock = useDeadline(item.snapshot.expiresAtMs, live && !readOnly);
  const editable = live && !uncertain && !sending && !busy && !readOnly && !clock.expired;
  useEffect(() => { if (!live || readOnly || clock.expired) setSecretValue(''); }, [live, readOnly, clock.expired]);
  const change = (next: Writing) => { setWriting(next); if (!secret) setNotSaved(!saveLocal(key, next)); };
  const answers: QuestionAnswers = {};
  for (const q of item.snapshot.questions) {
    const values = writing.choices[q.questionId] ?? [], text = q.isSecret ? secretValue : (writing.text[q.questionId] ?? '').trim();
    answers[q.questionId] = q.isSecret || !q.options.length ? [text] : [...values, ...(writing.other?.[q.questionId] ? [text] : [])];
  }
  const complete = Object.values(answers).every(values => values.length && values.every(v => !!v.length));
  const paged = live && !secret && item.snapshot.questions.length > 1;
  const page = Math.max(0, item.snapshot.questions.findIndex(q => q.questionId === writing.activeQuestionId));
  const current = item.snapshot.questions[page], last = page === item.snapshot.questions.length - 1;
  const currentComplete = answers[current.questionId].length > 0 && answers[current.questionId].every(value => !!value.length);
  const canNext = !busy && !sending && (!editable || currentComplete);
  const move = (offset: number) => {
    const next = item.snapshot.questions[page + offset];
    if (!next || busy || sending || offset > 0 && !canNext) return;
    focusQuestion.current = true;
    change({ ...writing, activeQuestionId: next.questionId });
  };
  useEffect(() => { if (focusQuestion.current) { activeField.current?.focus(); focusQuestion.current = false; } }, [current.questionId]);
  const hasDraft = !secret && Object.values(answers).some(values => values.some(Boolean));
  const act = async (action: 'resolve' | 'cancel' | 'check' | 'dismiss') => {
    if ((action === 'resolve' || action === 'cancel') && (!editable || !ready || Date.now() >= item.snapshot.expiresAtMs)) return;
    if (action === 'resolve' && (!complete || paged && !last)) return;
    setBusy(true); setError(''); setErrorAction(action);
    const input = { requestId: crypto.randomUUID(), epoch, id: item.id, ...(action !== 'check' ? { expectedRevision: item.revision } : {}), ...(action === 'resolve' ? { answers } : action === 'cancel' ? { cancel: true } : {}) };
    if (secret) setSecretValue('');
    try { await request(`assistant/question/${action === 'cancel' ? 'resolve' : action}`, input, undefined, 30000); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The response could not be confirmed. Check this question’s status.'); }
    finally { try { await refresh(); } catch { setError('The latest request status could not load. Check its status before continuing.'); } finally { setBusy(false); } }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(item.snapshot.questions.map(q => `${q.question}\n${answers[q.questionId].join(', ')}`).join('\n\n')); }
    catch { setErrorAction('copy'); setError('The draft could not be copied. Select its text in the kept answer below.'); }
  };
  const single = item.snapshot.questions[0];
  if (compact && live && !secret && item.snapshot.questions.length === 1 && !single.multiSelect && !uncertain && !sending && !clock.expired && !error && !readOnly) return <section className="approval-card request-card question-card compact-question" aria-label="Question from Nova">
    <form onSubmit={event => { event.preventDefault(); if (complete && editable && ready) void act('resolve'); }}>
      <button type="button" className="compact-question-cancel" aria-label="Cancel question" title="Cancel question" disabled={!editable || !ready} onClick={() => void act('cancel')}><X size={16}/></button>
      <fieldset disabled={!editable}><legend>{single.question}</legend>
        {single.options.map((option, index) => <label className="question-choice" key={option.label}><input type="radio" name={`${item.id}:${single.questionId}`} checked={(writing.choices[single.questionId] ?? []).includes(option.label)} onChange={() => change({ ...writing, other: { ...writing.other, [single.questionId]: false }, choices: { ...writing.choices, [single.questionId]: [option.label] } })}/><span className="question-choice-number" aria-hidden="true">{index + 1}</span><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
        <div className="compact-question-answer">{(!single.options.length || single.isOther) && <textarea aria-label={`Answer: ${single.question}`} rows={1} placeholder={single.options.length ? 'Or write your own answer…' : 'Your answer…'} maxLength={65536} value={writing.text[single.questionId] ?? ''} onChange={event => change({ ...writing, other: { ...writing.other, [single.questionId]: !!event.target.value.trim() }, choices: { ...writing.choices, [single.questionId]: [] }, text: { ...writing.text, [single.questionId]: event.target.value } })}/>}<button type="submit" className="compact-question-send" aria-label="Send answer" title="Send answer" disabled={!editable || !ready || !complete}><ArrowUp size={18}/></button></div>
      </fieldset>
      {!ready && <p className="request-context">Reconnect to submit your answer.</p>}{notSaved && <p role="alert">Your answer is not saved on this browser. Keep this view open until you submit it.</p>}
    </form>
  </section>;
  return <section className={`approval-card request-card question-card${paged ? ' paged-question' : ''}`} aria-label={secret ? 'Secure information request' : 'Question from Nova'}>
    <form onSubmit={event => { event.preventDefault(); if (paged && !last) move(1); else if (complete && editable && ready) void act('resolve'); }} onKeyDown={event => {
      if (!paged || event.key !== 'Enter' || event.nativeEvent.isComposing || !(event.target instanceof HTMLInputElement) || !['radio', 'checkbox'].includes(event.target.type)) return;
      event.preventDefault();
      if (!last) move(1); else if (complete && editable && ready) void act('resolve');
    }}>
      {(paged ? [current] : item.snapshot.questions).map((q, index) => <fieldset key={q.questionId} ref={paged ? activeField : undefined} tabIndex={paged ? -1 : undefined} disabled={!editable}>
        <legend>{item.snapshot.questions.length > 1 && <span className="question-number" aria-live={paged ? 'polite' : undefined} aria-atomic={paged ? true : undefined}>Question {(paged ? page : index) + 1} of {item.snapshot.questions.length}</span>}{q.question}</legend>
        {live ? <>{q.options.map((option, choiceIndex) => <label className="question-choice" key={option.label}><input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${item.id}:${q.questionId}`} checked={(writing.choices[q.questionId] ?? []).includes(option.label)} onChange={event => change({ ...writing, other: { ...writing.other, [q.questionId]: q.multiSelect ? !!writing.other?.[q.questionId] : false }, choices: { ...writing.choices, [q.questionId]: q.multiSelect ? event.target.checked ? [...(writing.choices[q.questionId] ?? []), option.label] : (writing.choices[q.questionId] ?? []).filter(v => v !== option.label) : [option.label] } })}/><span className="question-choice-number" aria-hidden="true">{choiceIndex + 1}</span><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
          {!!q.options.length && q.isOther && q.multiSelect && <label className="question-choice"><input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${item.id}:${q.questionId}`} checked={!!writing.other?.[q.questionId]} onChange={event => change({ ...writing, other: { ...writing.other, [q.questionId]: event.target.checked }, choices: { ...writing.choices, [q.questionId]: q.multiSelect ? writing.choices[q.questionId] ?? [] : [] } })}/><span>Write an answer</span></label>}
          {q.isSecret ? <><p className="metadata">Save {q.secretStore!.name} in OpenClaw’s secret store{q.secretStoreExisting ? ', replacing the saved value' : ''}. {q.secretStore!.reason}</p><p className="metadata">{q.secretStore!.allowedHosts?.length ? `Allowed hosts: ${q.secretStore!.allowedHosts.join(', ')}` : 'Allowed hosts not specified.'}</p><input type="password" aria-label={q.question} autoComplete="off" spellCheck={false} maxLength={65536} value={secretValue} onChange={event => setSecretValue(event.target.value)}/><p className="metadata">This value is sent only when you save. It is not kept in your chat or draft answers.</p></> : (!q.options.length || q.isOther || writing.other?.[q.questionId]) && <textarea aria-label={`Answer: ${q.question}`} rows={1} placeholder="Or write your own answer…" maxLength={65536} value={writing.text[q.questionId] ?? ''} onChange={event => change({ ...writing, ...(q.options.length && q.isOther && !q.multiSelect ? { other: { ...writing.other, [q.questionId]: !!event.target.value.trim() }, choices: { ...writing.choices, [q.questionId]: [] } } : {}), text: { ...writing.text, [q.questionId]: event.target.value } })}/>}</> : !uncertain && !sending && item.snapshot.answers && <p className="preserve-lines">{q.isSecret ? 'Secret stored. Its value is hidden.' : item.snapshot.answers.answers[q.questionId]?.join(', ')}</p>}
      </fieldset>)}
      {live ? <>
        {readOnly ? <p className="request-context">Restore this chat to answer.</p>
          : sending ? <p className="request-state" role="status">Confirming your answer…</p>
          : uncertain ? <p className="request-state" role="status">{item.action?.message ?? 'Your answer is unconfirmed. Check its status before answering again.'}</p>
          : clock.expired ? <p className="request-state" role="status">The answer window ended.{hasDraft ? ' Your draft answer is kept.' : ''} Check the outcome.</p>
          : !ready && <p className="request-context">Reconnect to submit your answer.</p>}
        {paged && <div className="question-navigation" aria-label="Question navigation">
          <button key="previous-question" type="button" className="request-secondary" disabled={!page || busy || sending} onClick={event => { event.preventDefault(); move(-1); }}>Previous</button>
          {!last ? <button key="next-question" type="button" className="primary request-primary" disabled={!canNext} onClick={event => { event.preventDefault(); move(1); }}>Next</button>
            : !uncertain && !sending && !clock.expired && !readOnly && <button key="send-answers" type="submit" className="primary request-primary" disabled={!editable || !ready || !complete}>Send answers</button>}
        </div>}
        <div className="request-actions">{!uncertain && !sending && !clock.expired && !readOnly && <>{!paged && <button type="submit" className="primary request-primary" disabled={!editable || !ready || !complete}>{secret ? item.snapshot.questions[0].secretStoreExisting ? 'Replace saved secret' : 'Save secret' : 'Send answer'}</button>}<button type="button" className="request-secondary" disabled={!editable || !ready} onClick={() => void act('cancel')}>Cancel question</button></>}
          {(uncertain || clock.expired || !!error) && !sending && <button type="button" className={uncertain || clock.expired ? 'primary request-primary' : 'request-secondary'} disabled={busy || !ready} onClick={() => void act('check')}>Check status</button>}
          {clock.expired && hasDraft && <button type="button" className="request-secondary" onClick={() => void copy()}>Copy draft answer</button>}
        </div>
      </> : <><p className="request-state" role="status">{sending ? 'Confirming your answer...' : uncertain ? item.action?.message ?? 'Your answer is unconfirmed. Check its status before continuing.' : missing ? 'This request is no longer available. Its outcome cannot be confirmed.' : item.action?.message ?? `Question ${item.snapshot.status}.`}</p><div className="request-actions">{(missing || uncertain) && !sending && <button type="button" className="primary request-primary" disabled={busy || !ready} onClick={() => void act('check')}>Check status</button>}{!item.dismissed && !uncertain && !sending && <button type="button" className="request-secondary" disabled={busy} onClick={() => void act('dismiss')}>Dismiss</button>}</div>{hasDraft && <details className="request-history"><summary>Your kept draft answer</summary><p className="preserve-lines">{Object.values(answers).map(v => v.join(', ')).join('\n')}</p><button type="button" className="request-secondary" onClick={() => void copy()}>Copy draft answer</button></details>}</>}
      {notSaved && <p role="alert">Browser storage is full. Keep this view open until you copy or submit your answer.</p>}{error && (pending || !['resolve', 'cancel'].includes(errorAction)) && <p role="alert">{error}</p>}
    </form>
  </section>;
}
