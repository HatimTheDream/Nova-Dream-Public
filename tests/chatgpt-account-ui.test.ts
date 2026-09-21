import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import type { ChatGptAccount, ChatGptAccountStatus } from '../packages/domain/sign-in.js';
import type { Conversation } from '../packages/domain/assistant.js';
import { accountIntentWasNotAdmitted, accountOrder, accountSummary, keepSignInIntent, moveAccount, remainingAllowance } from '../apps/client/src/chatgpt-account-controls.js';

const styles = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { ChatGptAccountList, ChatGptAccountAllowances } = await import('../apps/client/src/ChatGptAccounts.js');
const { ConversationAccountSelect } = await import('../apps/client/src/ConversationAccount.js');
styles.deregister();

const account = (id: string, fields: Partial<ChatGptAccount> = {}): ChatGptAccount => ({ profileId: `openai:${id}`, label: `${id} Account`, health: 'ready', cooldownUntil: null, expiresAt: null, usage: { state: 'ready', checkedAt: 1000, reportedAt: 500, windows: [{ label: '5h', usedPercent: 20, resetAt: null }], plan: null, credits: null }, ...fields });
const status = (accounts: ChatGptAccount[], fields: Partial<ChatGptAccountStatus> = {}): ChatGptAccountStatus => ({ state: 'available', emails: [], profileCount: accounts.length, message: '', accounts, order: accounts.map(a => a.profileId), preferredProfileId: accounts[0]?.profileId ?? null, canManage: true, ...fields });
function elements(html: string, tag: string) {
  const found: Record<string, string>[] = [];
  new Parser({ onopentag(name, attributes) { if (name === tag) found.push(attributes); } }).end(html);
  return found;
}

test('uncertain Add and Reconnect retain the exact operation without silently retargeting', () => {
  let ids = 0;
  const next = { epoch: 'workspace', method: 'device-code' as const, intent: 'reconnect' as const, profileId: 'openai:first' };
  const kept = keepSignInIntent(undefined, next, () => `receipt-${++ids}`);
  assert.equal(keepSignInIntent(kept, next, () => `receipt-${++ids}`), kept);
  for (const changed of [{ ...next, epoch: 'other' }, { ...next, profileId: 'openai:second' }, { ...next, intent: 'add' as const, profileId: undefined }, { ...next, method: 'browser' as const }]) assert.throws(() => keepSignInIntent(kept, changed, () => `receipt-${++ids}`), /Resume the earlier/);
  assert.equal(ids, 1);
  const legacy = { epoch: 'workspace', requestId: 'old-request' };
  assert.equal(keepSignInIntent(legacy, { epoch: 'workspace', method: 'device-code', intent: 'add' }, () => assert.fail('Must reuse the original request')), legacy);
  assert.deepEqual(legacy, { epoch: 'workspace', requestId: 'old-request' });
});

test('only proven pre-admission rejections permit clearing a retained account request', () => {
  for (const code of ['signin_active', 'signin_closed', 'signin_process_present', 'validation', 'account_order_unavailable', 'account_order_busy', 'account_order_membership']) assert.equal(accountIntentWasNotAdmitted(code), true);
  for (const code of ['account_host_changed', 'account_order_unknown', 'request_failed', 'host_unavailable', 'epoch_mismatch', 'request_conflict']) assert.equal(accountIntentWasNotAdmitted(code), false);
});

test('an unavailable account read cannot claim there are no connected accounts', () => {
  const unavailable = status([], { state: 'unavailable' });
  assert.equal(accountSummary(unavailable), 'Account Status Unavailable');
  assert.equal(accountSummary(status([], { state: 'empty' })), 'No Account Connected');
  assert.equal(accountSummary(status([])), 'No Account Connected');
  assert.equal(accountSummary({ ...unavailable, profileCount: 2 }), '2 Saved Accounts');
  assert.equal(accountSummary({ ...unavailable, profileCount: 1, emails: ['saved@example.com'] }), 'saved@example.com');
});

test('changing preferred and backup order preserves every current account exactly once', () => {
  const current = status([account('one'), account('two'), account('three')], { order: ['openai:removed', 'openai:two', 'openai:two'] });
  assert.deepEqual(accountOrder(current), ['openai:two', 'openai:one', 'openai:three']);
  const preferred = moveAccount(accountOrder(current), 'openai:three', 0);
  assert.deepEqual(preferred, ['openai:three', 'openai:two', 'openai:one']);
  assert.deepEqual(moveAccount(preferred, 'openai:one', 1), ['openai:three', 'openai:one', 'openai:two']);
  assert.equal(moveAccount(preferred, 'missing', 0), preferred);
});

test('Reconnect remains available when host cannot manage the global order', () => {
  const html = renderToStaticMarkup(createElement(ChatGptAccountList, { status: status([account('one'), account('two')], { canManage: false }), disabled: false, reconnect: () => assert.fail('Render must not reconnect'), reorder: () => assert.fail('Render must not reorder') }));
  assert.equal(elements(html, 'button').filter(button => !('disabled' in button)).length, 2);
  assert.match(html, /<button disabled="">Make Preferred/);
  assert.match(html, /Preferred/); assert.match(html, /Backup 1/);
});

test('missing allowance is not zero consumption and account readings never share quota by accident', () => {
  assert.equal(remainingAllowance(null), null); assert.equal(remainingAllowance(undefined), null); assert.equal(remainingAllowance(NaN), null);
  assert.equal(remainingAllowance(0), 100); assert.equal(remainingAllowance(100), 0);
  const unknown = account('Unknown', { usage: { state: 'unavailable', checkedAt: null, reportedAt: null, windows: [], plan: null, credits: null } });
  const empty = account('Empty', { usage: { state: 'ready', checkedAt: 2000, reportedAt: null, windows: [{ label: '5h', usedPercent: 100, resetAt: null }, { label: 'Week', usedPercent: null, resetAt: null }], plan: null, credits: null } });
  const full = account('Full'), duplicate = account('Duplicate', { duplicateOf: full.profileId });
  const html = renderToStaticMarkup(createElement(ChatGptAccountAllowances, { status: status([unknown, empty, full, duplicate]), stale: true }));
  assert.equal(elements(html, 'progress').length, 2);
  assert.match(html, /Empty Account · 5-Hour Allowance Remaining[^>]+value="0"/);
  assert.equal((html.match(/80% Left/g) ?? []).length, 1);
  assert.match(html, /Allowance Unavailable/); assert.match(html, /Shares An Existing Account Allowance/);
  assert.match(html, /Last Known · No Account Usage Timestamp Reported/);
  assert.match(html, /Last Known · Checked/); assert.match(html, /Last Known · Reported/);
});

test('conversation selection retains an unavailable choice and distinguishes confirmed backup selection from next preference', () => {
  const first = account('one', { health: 'reconnect' }), second = account('two'), duplicate = account('duplicate', { duplicateOf: second.profileId });
  const conversation = { preferredAccountId: first.profileId, accountSelection: { profileId: second.profileId, label: second.label, reason: 'backup', selectedAt: new Date(0).toISOString() } } as Conversation;
  const html = renderToStaticMarkup(createElement(ConversationAccountSelect, { status: status([first, second, duplicate]), conversation, blocked: false, onChange: () => assert.fail('Render must not change an account') }));
  const options = elements(html, 'option');
  assert.equal(options.length, 3);
  assert.ok(options.find(option => option.value === first.profileId && 'selected' in option && 'disabled' in option));
  assert.ok(options.find(option => option.value === second.profileId && !('disabled' in option)));
  assert.match(html, /Backup Selected: two Account/);
  assert.doesNotMatch(html, /duplicate Account/);
  const blocked = renderToStaticMarkup(createElement(ConversationAccountSelect, { status: status([first, second]), conversation, blocked: true, onChange: () => assert.fail('Render must not change an account') }));
  assert.ok('disabled' in elements(blocked, 'select')[0]);
});

test('a removed selected account stays visible instead of silently choosing the default', () => {
  const conversation = { preferredAccountId: 'openai:removed', accountSelection: { profileId: 'openai:removed', label: 'Earlier Account', selectedAt: new Date(0).toISOString() } } as Conversation;
  const html = renderToStaticMarkup(createElement(ConversationAccountSelect, { status: status([account('one')]), conversation, blocked: false, onChange: () => assert.fail('Render must not retarget') }));
  assert.ok(elements(html, 'option').find(option => option.value === 'openai:removed' && 'selected' in option && 'disabled' in option));
  assert.match(html, /Earlier Account · Unavailable/);
});
