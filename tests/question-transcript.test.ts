import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import type { AssistantOperation, ConversationHistory } from '../packages/domain/assistant';
import type { AssistantPlan } from '../packages/domain/assistant-plan';
import type { AssistantQuestion } from '../packages/domain/questions';
import { confirmedQuestion, withQuestionReceipts } from '../apps/client/src/question-transcript';
import { groupWorkMessages } from '../apps/client/src/work-transcript';
import { transcriptContains, transcriptParts, type TranscriptMessage } from '../apps/client/src/voice-transcript';

const base = Date.parse('2026-09-23T12:00:00Z');
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const source: NonNullable<TranscriptMessage['source']> = { bindingId: 'binding', nativeId: 'native', nativeKey: 'key', connectionGeneration: 'generation', kind: 'native', observedAt: at(90) };
function operation(changes: Partial<AssistantOperation> = {}): AssistantOperation {
  return { id: 'operation', epoch: 'epoch', conversationId: 'chat', connectionGeneration: 'generation', nativeId: 'native', nativeKey: 'key', nativeRunId: 'run', state: 'completed', text: 'Finished.', createdAt: at(0), updatedAt: at(90), settledAt: at(90), tools: [], ...changes } as AssistantOperation;
}
function message(id: string, seconds: number, changes: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return { id, novaId: `nova-${id}`, aliases: [`old-${id}`], role: 'assistant', text: 'Finished.', textHash: `hash-${id}`, attachments: [], source, operationId: 'operation', runId: 'run', createdAt: at(seconds), ...changes };
}
function question(changes: Partial<AssistantQuestion> = {}): AssistantQuestion {
  return {
    id: 'question', revision: 2, epoch: 'epoch', connectionGeneration: 'generation', conversationId: 'chat', nativeId: 'native', nativeKey: 'key', fingerprint: 'fingerprint', availability: 'live',
    snapshot: { id: 'native-question', sessionKey: 'key', runId: 'run', status: 'answered', createdAtMs: base + 30000, expiresAtMs: base + 60000, questions: [{ questionId: 'format', header: 'Format', question: 'Which format?', options: [{ label: 'Brief' }, { label: 'Detailed' }] }], answers: { answers: { format: ['Brief'] } } },
    ...changes,
  };
}
function options(messages: TranscriptMessage[], changes: Partial<Parameters<typeof withQuestionReceipts>[1]> = {}) {
  return { epoch: 'epoch', conversationId: 'chat', operations: [operation()], questions: [question()], history: { conversationId: 'chat', nativeId: 'native', messages, hasMore: false, activeRunIds: [] } satisfies ConversationHistory, ...changes };
}
const receipts = (rows: TranscriptMessage[]) => rows.flatMap(row => row.questionReceipts ?? []);

const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, context);
} });
const { ApprovalTray } = await import('../apps/client/src/ApprovalTray');
const { QuestionReceipts } = await import('../apps/client/src/QuestionReceipts');
hooks.deregister();
function tray(items: AssistantQuestion[], conversationId = 'chat') {
  const controller = { approvals: { state: 'ready', items: [] }, questions: { state: 'ready', items }, conversations: [{ id: 'chat', title: 'Original chat' }], refresh: async () => {}, select() {} } as unknown as ComponentProps<typeof ApprovalTray>['controller'];
  const markup = renderToStaticMarkup(createElement(ApprovalTray, { controller, conversationId, epoch: 'epoch', working: false }));
  const buttons: string[] = [];
  let current: string | undefined;
  new Parser({ onopentag(name) { if (name === 'button') current = ''; }, ontext(text) { if (current !== undefined) current += text; }, onclosetag(name) { if (name === 'button' && current !== undefined) { buttons.push(current); current = undefined; } } }).end(markup);
  return { markup, buttons };
}

test('question receipts enrich a proven turn without replacing any native message or search identity', () => {
  const messages = [message('comment', 10, { text: 'Checking.' }), message('final', 90)];
  const rows = groupWorkMessages(messages, { operations: [operation()], conversationId: 'chat', nativeId: 'native' });
  const before = structuredClone(rows), item = question();
  const result = withQuestionReceipts(rows, options(messages, { questions: [item] }));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].questionReceipts, [item]);
  assert.equal(result[0].workParts, rows[0].workParts);
  assert.equal(result[0].workFinal, rows[0].workFinal);
  assert.deepEqual(transcriptParts(result[0]), messages);
  for (const part of messages) {
    for (const id of [part.id, part.novaId!, ...part.aliases!]) assert.ok(transcriptContains(result[0], id, part.role));
    assert.equal(transcriptParts(result[0]).find(row => row.id === part.id)?.textHash, part.textHash);
  }
  assert.deepEqual(rows, before);
  assert.deepEqual(messages, before[0].workParts);
});

test('question, operation and native source scope must agree independently of wording', () => {
  const rows = [message('final', 90)];
  for (const changes of [
    { epoch: 'old' }, { conversationId: 'other' }, { nativeId: 'other' }, { nativeKey: 'other' }, { connectionGeneration: 'old' },
  ]) {
    assert.equal(receipts(withQuestionReceipts(rows, options(rows, { questions: [question(changes)] }))).length, 0);
    assert.equal(receipts(withQuestionReceipts(rows, options(rows, { operations: [operation(changes)] }))).length, 0);
  }
  for (const changes of [{ nativeId: 'other' }, { nativeKey: 'other' }, { connectionGeneration: 'old' }]) {
    const stale = [message('final', 90, { source: { ...source, ...changes } })];
    assert.equal(receipts(withQuestionReceipts(stale, options(stale))).length, 0);
  }
  for (const changes of [{ operationId: 'other' }, { runId: 'other' }, { operationId: undefined, runId: undefined }]) {
    const stale = [message('final', 90, changes)];
    assert.equal(receipts(withQuestionReceipts(stale, options(stale))).length, 0);
  }
  const staleHistory = { ...options(rows).history, conversationId: 'other' };
  assert.equal(withQuestionReceipts(rows, options(rows, { history: staleHistory })), rows);
  assert.equal(withQuestionReceipts(rows, options(rows, { history: undefined })), rows);
});

test('an older confirmed answer stays with its original source after a conversation continues on a new binding', () => {
  const older = message('old-final', 90);
  const newer = message('new-final', 180, { operationId: 'new-operation', runId: 'new-run', source: { ...source, bindingId: 'new-binding', nativeId: 'new-native', nativeKey: 'new-key', connectionGeneration: 'new-generation' } });
  const rows = [older, newer], config = options(rows);
  config.history.nativeId = 'new-native';
  const result = withQuestionReceipts(rows, config);
  assert.deepEqual(result[0].questionReceipts?.map(item => item.id), ['question']);
  assert.equal(result[1].questionReceipts, undefined);
  assert.equal(result[1], newer);
  const withoutSource = [{ ...older, source: undefined }];
  assert.equal(receipts(withQuestionReceipts(withoutSource, { ...config, history: { ...config.history, messages: withoutSource } })).length, 0);
});

test('repeated identical question wording remains attached to distinct runs and repeated batches retain their order', () => {
  const first = question(), second = question({ id: 'second-question', snapshot: { ...question().snapshot, id: 'second-native', createdAtMs: base + 45000 } });
  const later = question({ id: 'later-question', snapshot: { ...question().snapshot, id: 'later-native', runId: 'later-run', createdAtMs: base + 140000 } });
  const rows = [message('first-final', 90), message('later-final', 180, { operationId: 'later-operation', runId: 'later-run' })];
  const result = withQuestionReceipts(rows, options(rows, { questions: [later, second, first, first], operations: [operation(), operation({ id: 'later-operation', nativeRunId: 'later-run', createdAt: at(100), updatedAt: at(180), settledAt: at(180) })] }));
  assert.deepEqual(result.map(row => row.questionReceipts?.map(item => item.id)), [['question', 'second-question'], ['later-question']]);
  assert.deepEqual(rows.map(row => row.questionReceipts), [undefined, undefined]);
});

test('exact plan question links can resolve missing run IDs but unrelated or ambiguous links cannot', () => {
  const item = question(); delete item.snapshot.runId;
  const rows = [message('final', 90)];
  const overlapping = operation({ id: 'overlapping', nativeRunId: 'other-run' });
  const plan = { id: 'plan', epoch: 'epoch', conversationId: 'chat', versions: [{ version: 1, operationId: 'operation', createdAt: at(90), questionIds: [item.id] }] } as AssistantPlan;
  const config = options(rows, { questions: [item], operations: [operation(), overlapping] });
  assert.equal(receipts(withQuestionReceipts(rows, config)).length, 0);
  assert.deepEqual(receipts(withQuestionReceipts(rows, { ...config, plans: [plan] })), [item]);
  for (const changes of [{ epoch: 'old' }, { conversationId: 'other' }]) {
    assert.equal(receipts(withQuestionReceipts(rows, { ...config, plans: [{ ...plan, ...changes }] })).length, 0);
  }
  const ambiguous = { ...plan, versions: [...plan.versions, { version: 2, operationId: 'overlapping', createdAt: at(90), questionIds: [item.id] }] };
  assert.equal(receipts(withQuestionReceipts(rows, { ...config, plans: [ambiguous] })).length, 0);
  item.snapshot.runId = 'unrelated-run';
  assert.equal(receipts(withQuestionReceipts(rows, { ...config, plans: [plan] })).length, 0);
});

test('undated run metadata falls back only to one matching operation time window', () => {
  const item = question(); delete item.snapshot.runId;
  const rows = [message('final', 90)];
  assert.deepEqual(receipts(withQuestionReceipts(rows, options(rows, { questions: [item] }))), [item]);
  for (const changes of [{ createdAt: at(31) }, { settledAt: at(29) }, { createdAt: 'unknown' }, { steerTarget: 'operation' }]) {
    assert.equal(receipts(withQuestionReceipts(rows, options(rows, { questions: [item], operations: [operation(changes)] }))).length, 0);
  }
  assert.equal(receipts(withQuestionReceipts(rows, options(rows, { questions: [item], operations: [operation(), operation({ id: 'duplicate-owner' })] }))).length, 0);
});

test('partial history pages do not import batches from before or after their loaded time window', () => {
  const rows = [message('start', 40, { text: 'Continuing.' }), message('final', 90)];
  const config = options(rows), item = question();
  assert.equal(receipts(withQuestionReceipts(rows, { ...config, history: { ...config.history, hasMore: true } })).length, 0);
  item.snapshot.createdAtMs = base + 100000;
  assert.equal(receipts(withQuestionReceipts(rows, { ...config, questions: [item], history: { ...config.history, hasNewer: true } })).length, 0);
  item.snapshot.createdAtMs = base + 40000;
  assert.deepEqual(receipts(withQuestionReceipts(rows, { ...config, questions: [item], history: { ...config.history, hasMore: true, hasNewer: true } })), [item]);
  const undated = rows.map(row => ({ ...row, createdAt: undefined }));
  for (const boundary of [{ hasMore: true }, { hasNewer: true }]) assert.equal(receipts(withQuestionReceipts(undated, { ...config, history: { ...config.history, ...boundary, messages: undated } })).length, 0);
});

test('split turns place the receipt before a following assistant message from the same run, not an unrelated nearby reply', () => {
  const rows = [message('before', 10, { text: 'Before question.' }), message('other', 40, { operationId: 'other', runId: 'other-run' }), message('following', 60)];
  const result = withQuestionReceipts(rows, options(rows));
  assert.deepEqual(result.map(row => row.questionReceipts?.map(item => item.id)), [undefined, undefined, ['question']]);
  const notAnsweredHere = rows.slice(0, 2);
  assert.equal(receipts(withQuestionReceipts(notAnsweredHere, options(notAnsweredHere))).length, 0);
});

test('pending, sending and unknown outcomes stay out of confirmed transcript receipts', () => {
  const rows = [message('final', 90)];
  for (const status of ['pending', 'answered', 'cancelled', 'expired'] as const) {
    for (const state of ['sending', 'unknown', 'confirmed'] as const) {
      const item = question({ snapshot: { ...question().snapshot, status }, action: { requestId: 'original', kind: 'answer', state } });
      const confirmed = status !== 'pending' && state === 'confirmed';
      assert.equal(confirmedQuestion(item), confirmed);
      assert.equal(receipts(withQuestionReceipts(rows, options(rows, { questions: [item] }))).length, confirmed ? 1 : 0);
    }
  }
  assert.equal(receipts(withQuestionReceipts(rows, options(rows, { questions: [question({ dismissed: true })] }))).length, 0);
});

test('terminal but uncertain requests retain recovery in the tray without offering another answer or dismissal', () => {
  const item = question({ action: { requestId: 'original', kind: 'answer', state: 'unknown' } });
  const unknown = tray([item]);
  assert.deepEqual(unknown.buttons, ['Check status']);
  assert.ok(!unknown.markup.includes('Brief'));
  const elsewhere = tray([item], 'another-chat');
  assert.deepEqual(elsewhere.buttons, ['Review · Original chat']);
  item.action!.state = 'sending';
  const sending = tray([item]);
  assert.deepEqual(sending.buttons, []);
  assert.ok(sending.markup.includes('Confirming your answer'));
  item.action!.state = 'confirmed';
  assert.equal(tray([item]).markup, '');
});

test('completed series preserve every batch behind one closed disclosure while a single answer stays directly visible', () => {
  const first = question(), second = question({ id: 'second-batch' });
  second.snapshot.questions = [...second.snapshot.questions, { questionId: 'notes', header: 'Notes', question: 'Anything else?', options: [], isOther: true }];
  second.snapshot.answers = { answers: { format: ['Detailed'], notes: ['Keep my first line.\nAnd my second line.'] } };
  const inspect = (items: AssistantQuestion[]) => {
    const markup = renderToStaticMarkup(createElement(QuestionReceipts, { items }));
    const stack: { name: string; attrs: Record<string, string> }[] = [];
    const disclosures: Record<string, string>[] = [], answers: { text: string; behindSeries: boolean }[] = [];
    let answer: typeof answers[number] | undefined;
    const mutable: string[] = [];
    new Parser({
      onopentag(name, attrs) {
        if (name === 'details' && attrs.class === 'question-receipts') disclosures.push(attrs);
        if (['button', 'form', 'input', 'textarea', 'select'].includes(name)) mutable.push(name);
        if (name === 'p' && attrs.class === 'question-receipt-answer') {
          answer = { text: '', behindSeries: stack.some(parent => parent.name === 'details' && parent.attrs.class === 'question-receipts') };
          answers.push(answer);
        }
        stack.push({ name, attrs });
      },
      ontext(text) { if (answer) answer.text += text; },
      onclosetag(name) { if (name === 'p') answer = undefined; stack.pop(); },
    }).end(markup);
    return { markup, disclosures, answers, mutable };
  };
  const series = inspect([first, second]);
  assert.equal(series.disclosures.length, 1);
  assert.ok(!('open' in series.disclosures[0]));
  assert.match(series.markup, /Asked 3 questions/);
  assert.deepEqual(series.answers, [
    { text: 'Brief', behindSeries: true },
    { text: 'Detailed', behindSeries: true },
    { text: 'Keep my first line.\nAnd my second line.', behindSeries: true },
  ]);
  assert.deepEqual(series.mutable, []);
  const single = inspect([first]);
  assert.equal(single.disclosures.length, 0);
  assert.deepEqual(single.answers, [{ text: 'Brief', behindSeries: false }]);
  assert.deepEqual(single.mutable, []);
});
