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
    id: 'question', revision: 2, epoch: 'epoch', connectionGeneration: 'generation', conversationId: 'chat', nativeId: 'native', nativeKey: 'key', fingerprint: 'fingerprint', availability: 'live', resolvedAtMs: base + 40000,
    snapshot: { id: 'native-question', sessionKey: 'key', runId: 'run', status: 'answered', createdAtMs: base + 30000, expiresAtMs: base + 60000, questions: [{ questionId: 'format', header: 'Format', question: 'Which format?', options: [{ label: 'Brief' }, { label: 'Detailed' }] }], answers: { answers: { format: ['Brief'] } } },
    ...changes,
  };
}
function options(messages: TranscriptMessage[], changes: Partial<Parameters<typeof withQuestionReceipts>[1]> = {}) {
  return { epoch: 'epoch', conversationId: 'chat', operations: [operation()], questions: [question()], history: { conversationId: 'chat', nativeId: 'native', messages, hasMore: false, activeRunIds: [] } satisfies ConversationHistory, ...changes };
}
const partReceipts = (part: TranscriptMessage) => [...(part.questionReceipts ?? []), ...(part.questionReceiptsAfter ?? [])];
const receipts = (rows: TranscriptMessage[]) => rows.flatMap(row => row.workParts
  ? [...transcriptParts(row).flatMap(partReceipts), ...partReceipts(row)]
  : partReceipts(row));

const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, context);
} });
const { ApprovalTray } = await import('../apps/client/src/ApprovalTray');
const { QuestionReceipts } = await import('../apps/client/src/QuestionReceipts');
const { WorkTranscript } = await import('../apps/client/src/WorkTranscript');
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
  assert.equal(result[0].questionReceipts, undefined);
  assert.deepEqual(result[0].workFinal?.questionReceipts, [item]);
  assert.equal(result[0].workFinal, result[0].workParts![1]);
  assert.equal(result[0].workParts![0], rows[0].workParts![0]);
  assert.notEqual(result[0].workParts![1], rows[0].workParts![1]);
  assert.deepEqual(transcriptParts(result[0]).map(({ questionReceipts: _receipts, ...part }) => part), messages);
  for (const part of messages) {
    for (const id of [part.id, part.novaId!, ...part.aliases!]) assert.ok(transcriptContains(result[0], id, part.role));
    const projected = transcriptParts(result[0]).find(row => row.id === part.id)!;
    assert.equal(projected.textHash, part.textHash);
    assert.equal(projected.source, part.source);
    assert.equal(projected.attachments, part.attachments);
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
  const first = question(), second = question({ id: 'second-question', resolvedAtMs: base + 60000, snapshot: { ...question().snapshot, id: 'second-native', createdAtMs: base + 45000 } });
  const later = question({ id: 'later-question', resolvedAtMs: base + 150000, snapshot: { ...question().snapshot, id: 'later-native', runId: 'later-run', createdAtMs: base + 140000 } });
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

test('partial history pages use observed answer time rather than the earlier request time for their bounds', () => {
  const rows = [message('start', 40, { text: 'Continuing.' }), message('final', 90)];
  const item = question({ resolvedAtMs: base + 39000 }), config = options(rows, { questions: [item] });
  assert.equal(receipts(withQuestionReceipts(rows, { ...config, history: { ...config.history, hasMore: true } })).length, 0);
  item.resolvedAtMs = base + 100000;
  assert.equal(receipts(withQuestionReceipts(rows, { ...config, questions: [item], history: { ...config.history, hasNewer: true } })).length, 0);
  item.resolvedAtMs = base + 40000;
  assert.ok(item.snapshot.createdAtMs < base + 40000);
  assert.deepEqual(receipts(withQuestionReceipts(rows, { ...config, questions: [item], history: { ...config.history, hasMore: true, hasNewer: true } })), [item]);
  const undated = rows.map(row => ({ ...row, createdAt: undefined }));
  for (const boundary of [{ hasMore: true }, { hasNewer: true }]) assert.equal(receipts(withQuestionReceipts(undated, { ...config, history: { ...config.history, ...boundary, messages: undated } })).length, 0);
});

test('split turns place the receipt before a following assistant message from the same run, not an unrelated nearby reply', () => {
  const rows = [message('before', 35, { text: 'After the request, before the answer.' }), message('other', 45, { operationId: 'other', runId: 'other-run' }), message('following', 50)];
  const result = withQuestionReceipts(rows, options(rows));
  assert.deepEqual(result.map(row => row.questionReceipts?.map(item => item.id)), [undefined, undefined, ['question']]);
  const notAnsweredHere = rows.slice(0, 2);
  const late = withQuestionReceipts(notAnsweredHere, options(notAnsweredHere));
  assert.deepEqual(late[0].questionReceiptsAfter?.map(item => item.id), ['question']);
  assert.equal(late[1].questionReceiptsAfter, undefined);
});

test('late resolution observations stay after the proven final instead of being moved ahead of its timestamp', () => {
  const item = question({ resolvedAtMs: base + 95000 });
  const messages = [message('comment', 35, { text: 'Earlier narration.' }), message('final', 90)];
  const rows = groupWorkMessages(messages, { operations: [operation()], conversationId: 'chat', nativeId: 'native' });
  const result = withQuestionReceipts(rows, options(messages, { questions: [item] }));
  assert.equal(result[0].workFinal?.questionReceipts, undefined);
  assert.deepEqual(result[0].workFinal?.questionReceiptsAfter, [item]);
  assert.equal(result[0].workFinal, result[0].workParts!.at(-1));
  assert.deepEqual(receipts(result), [item]);
  assert.equal(rows[0].workFinal?.questionReceiptsAfter, undefined);
  const html = renderToStaticMarkup(createElement(WorkTranscript, {
    message: result[0], renderMessage: part => createElement('p', { 'data-native-message': part.id }, part.text),
  }));
  assert.ok(html.indexOf('class="question-receipt-answer"') > html.indexOf('data-native-message="final"'));
  assert.ok(html.indexOf('class="question-receipt-answer"') > html.lastIndexOf('</section>'));
  assert.equal((html.match(/class="question-receipt-answer"/g) ?? []).length, 1);
});

test('split activity keeps earlier and late batches on their exact ordinary narration row, with no receipts on tool fragments', () => {
  const first = question(), late = question({ id: 'late-question', resolvedAtMs: base + 60000 });
  const messages = [
    message('before', 35, { text: 'Before both answers.' }),
    message('tool-result', 36, { role: 'tool', text: 'File contents.', toolInfo: { id: 'read', name: 'read', state: 'completed' } }),
    message('steer', 37, { role: 'user', text: 'Additional request.', operationId: 'steer-operation', runId: undefined }),
    message('following', 50, { text: 'After the first answer, before the second.' }),
    message('unrelated', 80, { operationId: 'other-operation', runId: 'other-run' }),
  ];
  const rows = groupWorkMessages(messages, { operations: [operation()], conversationId: 'chat', nativeId: 'native' });
  assert.ok(rows.some(row => row.workActivityOperation));
  const result = withQuestionReceipts(rows, options(messages, { questions: [late, first] }));
  const following = result.find(row => row.id === 'following')!;
  assert.deepEqual(following.questionReceipts, [first]);
  assert.deepEqual(following.questionReceiptsAfter, [late]);
  assert.equal(result.find(row => row.id === 'unrelated')?.questionReceiptsAfter, undefined);
  assert.ok(result.filter(row => row.workParts).every(row => receipts([row]).length === 0));
  assert.equal(result.find(row => row.id === 'steer'), rows.find(row => row.id === 'steer'));
  assert.deepEqual(receipts(result).map(item => item.id), ['question', 'late-question']);
});

function interleaved() {
  const first = question();
  first.snapshot.questions = [...first.snapshot.questions, { questionId: 'desk', header: 'Desk', question: 'Can you attach a clamp?', options: [], isOther: true }];
  first.snapshot.answers = { answers: { format: ['One or two monitors'], desk: ['Freestanding items only'] } };
  const second = question({ id: 'second-batch', resolvedAtMs: base + 70000,
    snapshot: { ...question().snapshot, id: 'second-native', createdAtMs: base + 55000, questions: [{ questionId: 'laptop', header: 'Laptop', question: 'What laptop model will you use?', options: [], isOther: true }], answers: { answers: { laptop: ['OmniBook'] } } } });
  const messages = [
    message('before-first', 35, { text: 'Narration while the first answer is still pending.' }),
    message('after-first', 50, { text: 'Narration after the first answer.' }),
    message('before-second', 65, { text: 'Narration while the second answer is still pending.' }),
    message('after-second', 75, { text: 'Narration after the second answer.' }),
    message('final', 90),
  ];
  const rows = groupWorkMessages(messages, { operations: [operation()], conversationId: 'chat', nativeId: 'native' });
  return { first, second, messages, rows, projected: withQuestionReceipts(rows, options(messages, { questions: [second, first] })) };
}

test('two answered batches interleave with nested narration using resolution time, not question creation time', () => {
  const fixture = interleaved();
  assert.equal(fixture.projected.length, 1);
  const parts = transcriptParts(fixture.projected[0]);
  assert.deepEqual(parts.map(part => [part.id, part.questionReceipts?.map(item => item.id)]), [
    ['before-first', undefined], ['after-first', ['question']], ['before-second', undefined], ['after-second', ['second-batch']], ['final', undefined],
  ]);
  assert.equal(fixture.projected[0].questionReceipts, undefined);
  assert.equal(fixture.projected[0].workFinal, parts.at(-1));
  assert.deepEqual(receipts(fixture.projected).map(item => item.id), ['question', 'second-batch']);
  assert.ok(fixture.rows[0].workParts!.every(part => !part.questionReceipts));
});

test('legacy answers without an observed resolution time stay before the proven final instead of inventing chronology', () => {
  const fixture = interleaved();
  delete fixture.first.resolvedAtMs;
  const result = withQuestionReceipts(fixture.rows, options(fixture.messages, { questions: [fixture.first] }));
  assert.deepEqual(transcriptParts(result[0]).map(part => part.questionReceipts?.map(item => item.id)), [undefined, undefined, undefined, undefined, ['question']]);
  assert.equal(result[0].workFinal, result[0].workParts!.at(-1));
});

test('an active turn keeps an answered batch at its tail until later native narration supplies its exact position', () => {
  const item = question(), active = operation({ state: 'running', text: 'Waiting for the answer.', updatedAt: at(40), settledAt: undefined });
  const early = [message('waiting', 35, { text: active.text })];
  const group = (messages: TranscriptMessage[], op: AssistantOperation) => groupWorkMessages(messages, { operations: [op], active: op, conversationId: 'chat', nativeId: 'native' });
  const first = withQuestionReceipts(group(early, active), options(early, { questions: [item], operations: [active] }));
  assert.deepEqual(first[0].questionReceipts, [item]);
  assert.ok(first[0].workParts!.every(part => !part.questionReceipts));
  const later = [...early, message('continuing', 50, { text: 'Continuing from your answer.' })];
  const updated = { ...active, text: later[1].text, updatedAt: at(50) };
  const next = withQuestionReceipts(group(later, updated), options(later, { questions: [item], operations: [updated] }));
  assert.equal(next[0].questionReceipts, undefined);
  assert.deepEqual(next[0].workParts![1].questionReceipts, [item]);
  assert.equal(receipts(next).length, 1);
  assert.deepEqual(first[0].questionReceipts, [item]);
});

test('collapsing work details preserves both visible answer bubbles while expanding restores their narration order', () => {
  const { projected } = interleaved();
  const inspect = (expanded: boolean) => {
    const html = renderToStaticMarkup(createElement(WorkTranscript, {
      message: projected[0], ...(expanded ? { match: { id: 'after-first' } } : {}),
      renderMessage: part => createElement('p', { 'data-native-message': part.id }, part.text),
    }));
    const stack: Record<string, string>[] = [];
    const items: { kind: string; text: string; hidden: boolean }[] = [];
    const bubbles: Record<string, string>[] = [];
    let current: typeof items[number] | undefined;
    new Parser({
      onopentag(name, attrs) {
        if (name === 'article' && attrs.class?.includes('question-receipt')) bubbles.push(attrs);
        if (name === 'p' && (attrs.class === 'question-receipt-answer' || attrs['data-native-message'])) {
          current = { kind: attrs['data-native-message'] ?? 'answer', text: '', hidden: stack.some(parent => 'hidden' in parent) };
          items.push(current);
        }
        stack.push(attrs);
      },
      ontext(text) { if (current) current.text += text; },
      onclosetag(name) { if (name === 'p') current = undefined; stack.pop(); },
    }).end(html);
    return { html, items, bubbles };
  };
  for (const expanded of [false, true]) {
    const view = inspect(expanded);
    assert.equal(view.bubbles.length, 2);
    assert.ok(!view.html.includes('Asked 3 questions'));
    assert.deepEqual(view.items.filter(item => item.kind === 'answer').map(({ text, hidden }) => ({ text, hidden })), [
      { text: 'One or two monitors', hidden: false }, { text: 'Freestanding items only', hidden: false }, { text: 'OmniBook', hidden: false },
    ]);
    assert.ok(view.items.filter(item => item.kind !== 'answer' && item.kind !== 'final').every(item => item.hidden === !expanded));
    assert.equal(view.items.find(item => item.kind === 'final')?.hidden, false);
    assert.deepEqual(view.items.map(item => item.kind), ['before-first', 'answer', 'answer', 'after-first', 'before-second', 'answer', 'after-second', 'final']);
  }
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
  assert.equal(elsewhere.markup, '');
  assert.deepEqual(tray([item]).buttons, ['Check status']);
  item.action!.state = 'sending';
  const sending = tray([item]);
  assert.deepEqual(sending.buttons, []);
  assert.ok(sending.markup.includes('Confirming your answer'));
  item.action!.state = 'confirmed';
  assert.equal(tray([item]).markup, '');
});

test('completed batches remain separate visible reply bubbles without an Asked questions disclosure', () => {
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
  assert.equal(series.disclosures.length, 0);
  assert.ok(!series.markup.includes('Asked 3 questions'));
  assert.deepEqual(series.answers, [
    { text: 'Brief', behindSeries: false },
    { text: 'Detailed', behindSeries: false },
    { text: 'Keep my first line.\nAnd my second line.', behindSeries: false },
  ]);
  assert.deepEqual(series.mutable, []);
  const single = inspect([first]);
  assert.equal(single.disclosures.length, 0);
  assert.deepEqual(single.answers, [{ text: 'Brief', behindSeries: false }]);
  assert.deepEqual(single.mutable, []);
});
