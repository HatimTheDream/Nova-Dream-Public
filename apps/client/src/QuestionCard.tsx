import { useEffect, useState } from 'react';
import type { AssistantQuestion, QuestionAnswers } from '../../../packages/domain/questions';
import { readLocal, request, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';

type Writing = { other?: Record<string, boolean>; choices: Record<string, string[]>; text: Record<string, string> };
const blank = (): Writing => ({ choices: {}, text: {} });
export function QuestionCard({ item, epoch, ready, refresh, readOnly = false }: { item: AssistantQuestion; epoch: string; ready: boolean; refresh: () => Promise<void>; readOnly?: boolean }) {
  const secret = item.snapshot.questions.some(q => q.isSecret), key = `e3:question:${epoch}:${retainedWindowId}:${item.id}`;
  const [writing, setWriting] = useState<Writing>(() => secret ? blank() : readLocal<Writing>(key) ?? blank());
  const [secretValue, setSecretValue] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notSaved, setNotSaved] = useState(false);
  const [errorAction, setErrorAction] = useState('');
  const pending = item.snapshot.status === 'pending', missing = item.availability === 'missing', uncertain = item.action?.state === 'unknown', sending = item.action?.state === 'sending';
  const live = pending && !missing, editable = live && !uncertain && !sending && !busy && !readOnly;
  useEffect(() => { if (!live || readOnly) setSecretValue(''); }, [live, readOnly]);
  const change = (next: Writing) => { setWriting(next); if (!secret) setNotSaved(!saveLocal(key, next)); };
  const answers: QuestionAnswers = {};
  for (const q of item.snapshot.questions) {
    const values = writing.choices[q.questionId] ?? [], text = q.isSecret ? secretValue : (writing.text[q.questionId] ?? '').trim();
    answers[q.questionId] = q.isSecret || !q.options.length ? [text] : [...values, ...(writing.other?.[q.questionId] ? [text] : [])];
  }
  const complete = Object.values(answers).every(values => values.length && values.every(v => !!v.length));
  const act = async (action: 'resolve' | 'cancel' | 'check' | 'dismiss') => {
    setBusy(true); setError(''); setErrorAction(action);
    const input = { requestId: crypto.randomUUID(), epoch, id: item.id, ...(action !== 'check' ? { expectedRevision: item.revision } : {}), ...(action === 'resolve' ? { answers } : action === 'cancel' ? { cancel: true } : {}) };
    if (secret) setSecretValue('');
    try { await request(`assistant/question/${action === 'cancel' ? 'resolve' : action}`, input, undefined, 30000); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The response could not be confirmed. Check this question’s status.'); }
    finally { await refresh(); setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(item.snapshot.questions.map(q => `${q.question}\n${answers[q.questionId].join(', ')}`).join('\n\n')); }
    catch { setErrorAction('copy'); setError('The draft could not be copied. Select its text in the kept answer below.'); }
  };
  return <section className="approval-card question-card" aria-label={secret ? 'Secure information request' : 'Question from Nova'}>
    <form onSubmit={event => { event.preventDefault(); if (complete && editable && ready) void act('resolve'); }}>
      {item.snapshot.questions.map(q => <fieldset key={q.questionId} disabled={!editable}>
        <legend>{q.question}</legend>
        {live ? <>{q.options.map(option => <label className="question-choice" key={option.label}><input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${item.id}:${q.questionId}`} checked={(writing.choices[q.questionId] ?? []).includes(option.label)} onChange={event => change({ ...writing, other: { ...writing.other, [q.questionId]: q.multiSelect ? !!writing.other?.[q.questionId] : false }, choices: { ...writing.choices, [q.questionId]: q.multiSelect ? event.target.checked ? [...(writing.choices[q.questionId] ?? []), option.label] : (writing.choices[q.questionId] ?? []).filter(v => v !== option.label) : [option.label] } })}/><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
          {!!q.options.length && q.isOther && <label className="question-choice"><input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${item.id}:${q.questionId}`} checked={!!writing.other?.[q.questionId]} onChange={event => change({ ...writing, other: { ...writing.other, [q.questionId]: event.target.checked }, choices: { ...writing.choices, [q.questionId]: q.multiSelect ? writing.choices[q.questionId] ?? [] : [] } })}/><span>Write an answer</span></label>}
          {q.isSecret ? <><p className="metadata">Save {q.secretStore!.name} in OpenClaw’s secret store{q.secretStoreExisting ? ', replacing the saved value' : ''}. {q.secretStore!.reason}</p><p className="metadata">{q.secretStore!.allowedHosts?.length ? `Allowed hosts: ${q.secretStore!.allowedHosts.join(', ')}` : 'Allowed hosts not specified.'}</p><input type="password" aria-label={q.question} autoComplete="off" spellCheck={false} maxLength={65536} value={secretValue} onChange={event => setSecretValue(event.target.value)}/><p className="metadata">This value is sent only when you save. It is not kept in your chat or draft answers.</p></> : (!q.options.length || writing.other?.[q.questionId]) && <textarea aria-label={`Answer: ${q.question}`} rows={2} maxLength={65536} value={writing.text[q.questionId] ?? ''} onChange={event => change({ ...writing, text: { ...writing.text, [q.questionId]: event.target.value } })}/>}</> : item.snapshot.answers && <p className="preserve-lines">{q.isSecret ? 'Secret stored. Its value is hidden.' : item.snapshot.answers.answers[q.questionId]?.join(', ')}</p>}
      </fieldset>)}
      {live ? <><div className="button-row">{!uncertain && !sending && <><button type="submit" disabled={!editable || !ready || !complete || Date.now() >= item.snapshot.expiresAtMs}>{secret ? item.snapshot.questions[0].secretStoreExisting ? 'Replace saved secret' : 'Save secret' : 'Submit answer'}</button><button type="button" className="text-button" disabled={!editable || !ready} onClick={() => void act('cancel')}>Cancel question</button></>}<button type="button" className="text-button" disabled={busy || !ready || sending} onClick={() => void act('check')}>{sending ? 'Confirming…' : 'Check status'}</button></div>{uncertain && <p role="status">{item.action?.message}</p>}{readOnly && <p className="metadata">Restore this chat to answer.</p>}{!ready && <p className="metadata">Reconnect to submit your answer.</p>}{Date.now() >= item.snapshot.expiresAtMs && <p className="metadata">This question’s time has elapsed. Check its final status.</p>}</> : <><p role="status">{missing ? 'This request is no longer available. Its outcome cannot be confirmed.' : item.action?.message ?? `Question ${item.snapshot.status}.`}</p><div className="button-row">{missing && <button type="button" disabled={busy || !ready} onClick={() => void act('check')}>Check status</button>}{!item.dismissed && <button type="button" disabled={busy} onClick={() => void act('dismiss')}>Dismiss</button>}</div>{!secret && Object.values(answers).some(v => v.some(Boolean)) && <details><summary>Your kept draft answer</summary><p className="preserve-lines">{Object.values(answers).map(v => v.join(', ')).join('\n')}</p><button type="button" onClick={() => void copy()}>Copy draft answer</button></details>}</>}
      {notSaved && <p role="alert">Browser storage is full. Keep this view open until you copy or submit your answer.</p>}{error && (pending || !['resolve', 'cancel'].includes(errorAction)) && <p role="alert">{error}</p>}
    </form>
  </section>;
}
