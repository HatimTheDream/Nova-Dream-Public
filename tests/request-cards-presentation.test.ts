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
    const buttons: { label: string; disabled: boolean; className: string }[] = [];
    const inputs: Record<string, string>[] = [], fieldsets: Record<string, string>[] = [], details: Record<string, string>[] = [];
    let current: typeof buttons[number] | undefined;
    new Parser({
      onopentag(name, attrs) {
        if (name === 'button') { current = { label: attrs['aria-label'] ?? '', disabled: 'disabled' in attrs, className: attrs.class ?? '' }; buttons.push(current); }
        if (name === 'input') inputs.push(attrs);
        if (name === 'fieldset') fieldsets.push(attrs);
        if (name === 'details') details.push(attrs);
      },
      ontext(text) { if (current) current.label += text; },
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
  assert.deepEqual(view.buttons.map(button => button.label), ['Submit answer', 'Cancel question']);
  assert.equal(view.button('Submit answer').disabled, false);
  assert.match(view.button('Submit answer').className, /request-primary/);
  assert.match(view.button('Cancel question').className, /request-secondary/);
  assert.equal(view.inputs.filter(input => input.type === 'radio').length, 3);
  assert.equal(view.inputs.filter(input => 'checked' in input).length, 1);
  assert.match(view.markup, /Only the key decisions/);
  assert.match(view.markup, /Write an answer/);
});

test('subscribed expiry disables a still-pending question and preserves its custom draft for recovery', () => {
  const item = question(), writing = { choices: { format: [] }, other: { format: true }, text: { format: 'Keep the decisions and examples.' } };
  const before = render(createElement(QuestionCard, { item, epoch: 'epoch', ready: true, refresh }), { writing });
  assert.equal(before.button('Submit answer').disabled, false);
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
  assert.equal(view.button('Submit answer').disabled, false);
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
