import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import type { ReviewApproval } from '../packages/domain/approvals';
import type { AssistantQuestion } from '../packages/domain/questions';

const deadlineFixture = Symbol.for('nova.test.requests.deadline');
// Model a deadline hook update independently of the persisted source snapshot.
// The hook itself owns its timer; the cards must consume its subscribed state.
const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('/useDeadline.ts')) return { format: 'module', shortCircuit: true, source: `export const useDeadline = () => globalThis[Symbol.for('nova.test.requests.deadline')];` };
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, context);
} });
const { ApprovalCard, ApprovalTray } = await import('../apps/client/src/ApprovalTray');
const { QuestionCard } = await import('../apps/client/src/QuestionCard');
hooks.deregister();

const refresh = async () => {};
function approval(): ReviewApproval {
  return {
    id: 'approval', revision: 3, epoch: 'epoch', connectionGeneration: 'generation', conversationId: 'conversation', nativeId: 'native', nativeKey: 'key', updatedAtMs: 100,
    snapshot: { id: 'native-approval', status: 'pending', createdAtMs: 100, expiresAtMs: Date.now() + 60000, presentation: {
      kind: 'exec', commandText: 'npm run build -- --mode production', host: 'Build host', warningText: 'This writes the application bundle.', allowedDecisions: ['allow-once', 'allow-always', 'deny'],
      scope: { kind: 'standing-grant', automation: 'Daily build', command: 'npm run build', expiresInDays: 7 },
    } },
  };
}
function question(): AssistantQuestion {
  return {
    id: 'question', revision: 2, epoch: 'epoch', connectionGeneration: 'generation', conversationId: 'conversation', nativeId: 'native', nativeKey: 'key', fingerprint: 'fingerprint', availability: 'live',
    snapshot: { id: 'native-question', sessionKey: 'key', status: 'pending', createdAtMs: 100, expiresAtMs: Date.now() + 60000, questions: [
      { questionId: 'format', header: 'Format', question: 'How much detail should I include?', options: [{ label: 'Brief', description: 'Only the key decisions.' }, { label: 'Detailed', description: 'Include the supporting context.' }], isOther: true },
    ] },
  };
}
function render(element: ReactElement, options: { expired?: boolean; writing?: unknown } = {}) {
  const previous = [deadlineFixture, 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, deadlineFixture, { configurable: true, value: { expired: !!options.expired, remaining: options.expired ? '0:00' : '1:00' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => key.startsWith('e3:question:') && options.writing ? JSON.stringify(options.writing) : null } });
  try {
    const markup = renderToStaticMarkup(element);
    const buttons: { label: string; disabled: boolean; className: string; type?: string }[] = [];
    const inputs: Record<string, string>[] = [], fieldsets: Record<string, string>[] = [], details: Record<string, string>[] = [];
    let current: typeof buttons[number] | undefined, named = false;
    new Parser({
      onopentag(name, attrs) {
        if (name === 'button') { named = !!attrs['aria-label']; current = { label: attrs['aria-label'] ?? '', disabled: 'disabled' in attrs, className: attrs.class ?? '', type: attrs.type }; buttons.push(current); }
        if (name === 'input') inputs.push(attrs);
        if (name === 'fieldset') fieldsets.push(attrs);
        if (name === 'details') details.push(attrs);
      },
      ontext(text) { if (current && !named) current.label += text; },
      onclosetag(name) { if (name === 'button') current = undefined; },
    }).end(markup);
    const button = (label: string) => { const found = buttons.find(item => item.label === label); assert.ok(found, `Missing ${label}`); return found; };
    return { markup, buttons, button, inputs, fieldsets, details };
  } finally {
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test('approval presents one primary action while preserving every allowed decision and its exact scope', () => {
  const view = render(createElement(ApprovalCard, { item: approval(), epoch: 'epoch', ready: true, refresh }));
  assert.deepEqual(view.buttons.map(button => button.label), ['Allow once', 'Always allow', 'Deny']);
  assert.deepEqual(view.buttons.filter(button => button.className.includes('request-primary')).map(button => button.label), ['Allow once']);
  assert.ok(view.buttons.every(button => !button.disabled));
  assert.match(view.markup, /npm run build -- --mode production/);
  assert.match(view.markup, /Always allow applies to npm run build in Daily build for 7 days/);
  assert.match(view.markup, /This writes the application bundle/);
  assert.match(view.markup, /Host: Build host/);
});

test('approval recovery checks the existing decision without offering a duplicate authorization', () => {
  const item = approval();
  item.action = { requestId: 'kept-request', decision: 'allow-once', state: 'unknown', message: 'The decision receipt is unconfirmed.' };
  const view = render(createElement(ApprovalCard, { item, epoch: 'epoch', ready: true, refresh }));
  assert.deepEqual(view.buttons.map(button => button.label), ['Check status']);
  assert.match(view.button('Check status').className, /request-primary/);
  assert.match(view.markup, /npm run build -- --mode production/);
  assert.match(view.markup, /The decision receipt is unconfirmed/);
  item.action.state = 'sending';
  const sending = render(createElement(ApprovalCard, { item, epoch: 'epoch', ready: true, refresh }));
  assert.equal(sending.buttons.length, 0);
  assert.match(sending.markup, /Confirming your decision/);
});

test('approval respects restricted and external decisions without inventing permissions', () => {
  const item = approval();
  item.snapshot.presentation = { kind: 'plugin', title: 'Connect an account?', description: 'Review the provider connection.', detail: 'Provider: GitHub\nAccount: selected account', toolName: 'provider.connect', severity: 'info', allowedDecisions: ['allow-once', 'deny'], externalResolution: { label: 'Open provider', decisions: ['allow-once'] } };
  const view = render(createElement(ApprovalCard, { item, epoch: 'epoch', ready: true, refresh }));
  assert.deepEqual(view.buttons.map(button => button.label), ['Open provider', 'Deny']);
  assert.match(view.markup, /Provider: GitHub\nAccount: selected account/);
  assert.match(view.markup, /aria-label="Action details"/);
});

test('questions keep saved selected choices, descriptions and a single submit action', () => {
  const view = render(createElement(QuestionCard, { item: question(), epoch: 'epoch', ready: true, refresh }), { writing: { choices: { format: ['Brief'] }, text: {} } });
  assert.deepEqual(view.buttons.map(button => button.label), ['Send answer', 'Cancel question']);
  assert.equal(view.button('Send answer').disabled, false);
  assert.match(view.button('Send answer').className, /request-primary/);
  assert.match(view.button('Cancel question').className, /request-secondary/);
  assert.equal(view.inputs.filter(input => input.type === 'radio').length, 2);
  assert.equal(view.inputs.filter(input => 'checked' in input).length, 1);
  assert.match(view.markup, /Only the key decisions/);
  assert.match(view.markup, /Or write your own answer/);
  assert.match(view.markup, /question-choice-number[^>]*>1<\/span>/);
  assert.match(view.markup, /question-choice-number[^>]*>2<\/span>/);
});

test('subscribed expiry disables a still-pending question and preserves its custom draft for recovery', () => {
  const item = question(), writing = { choices: { format: [] }, other: { format: true }, text: { format: 'Keep the decisions and examples.' } };
  const before = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh }), { writing });
  assert.equal(before.button('Send answer').disabled, false);
  assert.ok(!('disabled' in before.fieldsets[0]));
  // The source still says pending with a future timestamp; the subscribed clock
  // has advanced. This catches reverting the card to a one-off Date.now check.
  const after = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh }), { writing, expired: true });
  assert.deepEqual(after.buttons.map(button => button.label), ['Check status', 'Copy draft answer']);
  assert.ok('disabled' in after.fieldsets[0]);
  assert.match(after.markup, /Your draft answer is kept/);
  assert.match(after.markup, /Keep the decisions and examples/);
  assert.match(after.button('Check status').className, /request-primary/);
});

test('multi-select and custom answers retain their independent selected values', () => {
  const item = question();
  item.snapshot.questions[0].multiSelect = true;
  const view = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh }), { writing: { choices: { format: ['Brief', 'Detailed'] }, other: { format: true }, text: { format: 'Add links.' } } });
  assert.equal(view.inputs.filter(input => input.type === 'checkbox' && 'checked' in input).length, 3);
  assert.equal(view.button('Send answer').disabled, false);
  assert.match(view.markup, /Add links/);
});

test('unconfirmed answers and read-only views cannot offer submission again', () => {
  const item = question();
  item.action = { requestId: 'kept-request', kind: 'answer', state: 'unknown' };
  const uncertain = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh }));
  assert.deepEqual(uncertain.buttons.map(button => button.label), ['Check status']);
  assert.ok('disabled' in uncertain.fieldsets[0]);
  delete item.action;
  const saved = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh, readOnly: true }));
  assert.equal(saved.buttons.length, 0);
  assert.ok('disabled' in saved.fieldsets[0]);
  assert.match(saved.markup, /Restore this chat to answer/);
});

test('secure requests never read ordinary draft values into the secret field or offer draft copying', () => {
  const item = question();
  item.snapshot.questions = [{ questionId: 'token', header: 'Token', question: 'Enter the provider token.', options: [], isSecret: true, secretStore: { name: 'PROVIDER_TOKEN', kind: 'secret', allowedHosts: ['provider.example'] } }];
  const writing = { choices: {}, text: { token: 'MUST-NOT-APPEAR' } };
  const pending = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh }), { writing });
  assert.doesNotMatch(pending.markup, /MUST-NOT-APPEAR/);
  assert.equal(pending.inputs.find(input => input.type === 'password')?.value, '');
  assert.equal(pending.button('Save secret').disabled, true);
  const expired = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh }), { writing, expired: true });
  assert.deepEqual(expired.buttons.map(button => button.label), ['Check status']);
  assert.ok('disabled' in expired.fieldsets[0]);
});

test('answered question receipts stay collapsed without inflating the current request count', () => {
  const answered = question();
  answered.snapshot = { ...answered.snapshot, status: 'answered', answers: { answers: { format: ['Brief'] } } };
  const controller = { approvals: { state: 'ready', items: [] }, questions: { state: 'ready', items: [answered] }, conversations: [], refresh, select() {} } as unknown as ComponentProps<typeof ApprovalTray>['controller'];
  const past = render(createElement(ApprovalTray, { controller, conversationId: 'conversation', epoch: 'epoch', working: false }));
  assert.match(past.markup, /<summary>Past requests<\/summary>/);
  assert.ok(!('open' in past.details[0]));
  assert.match(past.markup, /Brief/);
  assert.ok(past.button('Dismiss'));
  controller.approvals!.items = [approval()];
  const mixed = render(createElement(ApprovalTray, { controller, conversationId: 'conversation', epoch: 'epoch', working: false }));
  assert.match(mixed.markup, /<summary>Approval needed<\/summary>/);
  assert.match(mixed.markup, /Past requests · 1/);
  assert.ok('open' in mixed.details[0]);
  assert.ok(!('open' in mixed.details[1]));
  assert.doesNotMatch(mixed.markup, /2 requests need your attention/);
});


test('the compact single question keeps numbered choices, a named send arrow and actual cancellation without a duplicate heading', () => {
  const controller = { approvals: { items: [], state: 'ready' }, questions: { items: [question()], state: 'ready' }, refresh, conversations: [], select: () => {} } as unknown as ComponentProps<typeof ApprovalTray>['controller'];
  const view = render(createElement(ApprovalTray, { controller, epoch: 'epoch', conversationId: 'conversation', working: true }), { writing: { choices: { format: ['Brief'] }, text: {} } });
  assert.doesNotMatch(view.markup, /Nova needs your answer/);
  assert.match(view.markup, /compact-question-tray/);
  assert.equal(view.button('Send answer').disabled, false); assert.equal(view.button('Cancel question').disabled, false);
  assert.equal(view.inputs.filter(input => input.type === 'radio').length, 2);
  assert.match(view.markup, /question-choice-number[^>]*>1<\/span>/);
  assert.match(view.markup, /Only the key decisions/);
});

function questionBatch(): AssistantQuestion {
  const item = question();
  item.snapshot.questions.push(
    { questionId: 'surfaces', header: 'Surfaces', question: 'Which screens should I cover?', options: [{ label: 'Desktop' }, { label: 'Phone' }], multiSelect: true, isOther: true },
    { questionId: 'notes', header: 'Notes', question: 'What should the proposal preserve?', options: [] },
  );
  return item;
}
const batchWriting = () => ({
  choices: { format: ['Brief'], surfaces: ['Desktop', 'Phone'] },
  other: { surfaces: true }, text: { surfaces: 'Also check the tablet.', notes: 'Preserve the existing navigation.' },
});
const navigation = (view: ReturnType<typeof render>, direction: 'Previous' | 'Next') => {
  const found = view.buttons.find(button => new RegExp(`^${direction}( question)?$`, 'i').test(button.label));
  assert.ok(found, `Missing ${direction} question navigation`); return found;
};

test('a pending question batch presents one page and cannot send the whole batch from its first page', () => {
  const item = questionBatch();
  const view = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh, compact: true }), { writing: batchWriting() });
  assert.equal(view.fieldsets.length, 1);
  assert.match(view.markup, /How much detail should I include/);
  assert.doesNotMatch(view.markup, /Which screens should I cover|What should the proposal preserve/);
  assert.match(view.markup, /1 of 3/);
  assert.equal(navigation(view, 'Next').disabled, false);
  assert.equal(navigation(view, 'Next').type, 'button');
  assert.equal(view.buttons.some(button => /^Send answers?$/.test(button.label)), false);
});

test('restoring an intermediate page preserves multi-select and custom answers while keeping navigation local', () => {
  const item = questionBatch(), writing = { ...batchWriting(), activeQuestionId: 'surfaces' };
  const view = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh, compact: true }), { writing });
  assert.equal(view.fieldsets.length, 1);
  assert.match(view.markup, /2 of 3/);
  assert.match(view.markup, /Which screens should I cover/);
  assert.doesNotMatch(view.markup, /How much detail should I include|What should the proposal preserve/);
  assert.equal(view.inputs.filter(input => input.type === 'checkbox' && 'checked' in input).length, 3);
  assert.match(view.markup, /Also check the tablet/);
  assert.equal(navigation(view, 'Previous').type, 'button');
  assert.equal(navigation(view, 'Previous').disabled, false);
  assert.equal(navigation(view, 'Next').disabled, false);
  assert.equal(view.buttons.some(button => /^Send answers?$/.test(button.label)), false);
});

test('question navigation validates the current page and final submission requires answers on every page', () => {
  const item = questionBatch();
  const blankMiddle = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh }), {
    writing: { activeQuestionId: 'surfaces', choices: { format: ['Brief'] }, text: { notes: 'Keep the draft.' } },
  });
  assert.equal(navigation(blankMiddle, 'Next').disabled, true);
  assert.equal(navigation(blankMiddle, 'Previous').disabled, false);
  const incomplete = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh }), {
    writing: { activeQuestionId: 'notes', choices: { surfaces: ['Phone'] }, text: { notes: 'Keep the draft.' } },
  });
  assert.equal(incomplete.fieldsets.length, 1);
  assert.equal(incomplete.button('Send answers').disabled, true);
  assert.equal(navigation(incomplete, 'Previous').disabled, false);
  const complete = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh }), {
    writing: { ...batchWriting(), activeQuestionId: 'notes' },
  });
  assert.match(complete.markup, /3 of 3/);
  assert.match(complete.markup, /Preserve the existing navigation/);
  assert.equal(complete.button('Send answers').disabled, false);
  assert.equal(complete.buttons.some(button => /^Next( question)?$/i.test(button.label)), false);
});

test('an unavailable saved question cursor falls back to the first page without inventing answers', () => {
  const view = render(createElement(QuestionCard, { item: questionBatch(), epoch: 'epoch', ready: true, refresh }), {
    writing: { activeQuestionId: 'question_from_an_earlier_batch', choices: {}, text: {} },
  });
  assert.equal(view.fieldsets.length, 1);
  assert.match(view.markup, /1 of 3/);
  assert.match(view.markup, /How much detail should I include/);
  assert.equal(navigation(view, 'Next').disabled, true);
  assert.equal(view.inputs.some(input => 'checked' in input), false);
});

test('expired, unconfirmed and read-only question batches remain navigable for review without resubmission', () => {
  for (const state of ['expired', 'unknown', 'readOnly'] as const) {
    const item = questionBatch();
    if (state === 'unknown') item.action = { requestId: 'original-request', kind: 'answer', state: 'unknown' };
    const view = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh, readOnly: state === 'readOnly' }), {
      writing: { ...batchWriting(), activeQuestionId: 'surfaces' }, expired: state === 'expired',
    });
    assert.equal(view.fieldsets.length, 1, state);
    assert.ok('disabled' in view.fieldsets[0], state);
    assert.equal(navigation(view, 'Previous').disabled, false, state);
    assert.equal(navigation(view, 'Next').disabled, false, state);
    assert.equal(navigation(view, 'Next').type, 'button', state);
    assert.equal(view.buttons.some(button => /^Send answers?$/.test(button.label)), false, state);
    assert.match(view.markup, /Also check the tablet/, state);
    if (state === 'expired') assert.ok(view.button('Copy draft answer'));
  }
});

test('answered batch history retains all questions and confirmed answers instead of the active page only', () => {
  const item = questionBatch();
  item.snapshot = { ...item.snapshot, status: 'answered', answers: { answers: {
    format: ['Brief'], surfaces: ['Desktop', 'Phone'], notes: ['Keep the confirmed plan.'],
  } } };
  const view = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh }), {
    writing: { ...batchWriting(), activeQuestionId: 'surfaces' },
  });
  assert.equal(view.fieldsets.length, 3);
  assert.match(view.markup, /How much detail should I include/);
  assert.match(view.markup, /Which screens should I cover/);
  assert.match(view.markup, /What should the proposal preserve/);
  assert.match(view.markup, /Keep the confirmed plan/);
  assert.equal(view.buttons.some(button => /^(?:Previous|Next)(?: question)?$/i.test(button.label)), false);
  assert.equal(view.buttons.some(button => /^Send answers?$/.test(button.label)), false);
});

test('the active batch uses the compact tray even when the current question allows multiple selections', () => {
  const controller = { approvals: { items: [], state: 'ready' }, questions: { items: [questionBatch()], state: 'ready' }, refresh, conversations: [], select: () => {} } as unknown as ComponentProps<typeof ApprovalTray>['controller'];
  const view = render(createElement(ApprovalTray, { controller, epoch: 'epoch', conversationId: 'conversation', working: true }), {
    writing: { ...batchWriting(), activeQuestionId: 'surfaces' },
  });
  assert.match(view.markup, /compact-question-tray/);
  assert.equal(view.fieldsets.length, 1);
  assert.match(view.markup, /2 of 3/);
  assert.doesNotMatch(view.markup, /Nova needs your answer/);
  assert.equal(view.inputs.filter(input => input.type === 'checkbox' && 'checked' in input).length, 3);
});
