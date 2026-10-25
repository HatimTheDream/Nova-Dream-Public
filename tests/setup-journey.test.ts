import test from 'node:test';
import assert from 'node:assert/strict';
import { SetupJourneyJournal, captureSetupPosition, restoreSetupPosition, type SetupJourney } from '../apps/client/src/setup-journey';
import { assistantPrerequisite } from '../apps/client/src/assistant-prerequisite';
import type { AssistantConnection, Conversation } from '../packages/domain/assistant';
import type { ChatGptAccountStatus } from '../packages/domain/sign-in';

const scope = { epoch: 'epoch', deviceId: 'device', windowId: 'window' };
const journey: SetupJourney = { format: 1, scope, origin: 'assistant', token: 'original', section: 'accounts', selection: { id: 'original-chat', space: 'work' } };
function fixture() {
  const values = new Map<string, string>();
  let fail = false, loseReadback = false, writes = 0;
  const storage = { getItem: (key: string) => { if (loseReadback && writes) throw Error(); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (fail) throw Error(); values.set(key, value); writes++; } };
  return { values, storage, journal: new SetupJourneyJournal(storage, scope), fail: (value: boolean) => { fail = value; }, readback: (value: boolean) => { loseReadback = value; } };
}
test('exact setup return survives reload with original work selection and section without copying writing', () => {
  const f = fixture(); assert.equal(f.journal.keep(journey), true);
  const next = new SetupJourneyJournal(f.storage, scope);
  assert.deepEqual(next.value, journey);
  assert.equal(next.matchesSelection('original-chat', 'work'), true);
  assert.equal(next.matchesSelection('original-chat', 'chat'), false);
  assert.equal(next.matchesSelection('other', 'work'), false);
  assert.equal(next.keep({ ...journey, section: 'phone' }), true);
  assert.deepEqual(new SetupJourneyJournal(f.storage, scope).value, { ...journey, section: 'phone' });
  assert.equal(next.keep(undefined), true); assert.equal(new SetupJourneyJournal(f.storage, scope).value, undefined);
});
test('unreadable, foreign and oversized setup returns cannot be overwritten', () => {
  for (const raw of ['{broken', JSON.stringify({ ...journey, scope: { ...scope, epoch: 'other' } }), ' '.repeat(4097)]) {
    const f = fixture(); f.values.set(f.journal.key, raw); const journal = new SetupJourneyJournal(f.storage, scope);
    assert.ok(journal.error); assert.equal(journal.keep(journey), false); assert.equal(f.values.get(journal.key), raw);
  }
});
test('full storage, changed bytes and failed readback do not authorize navigation', () => {
  const f = fixture(); f.fail(true); assert.equal(f.journal.keep(journey), false); assert.equal(f.journal.value, undefined);
  f.fail(false); f.readback(true); assert.equal(f.journal.keep(journey), false); assert.equal(f.journal.value, undefined);
  f.readback(false); assert.equal(f.journal.keep(journey), true, 'only identical attempted bytes may be adopted');
  const foreign = JSON.stringify({ ...journey, token: 'other-window' }); f.values.set(f.journal.key, foreign);
  assert.equal(f.journal.keep(undefined), false); assert.equal(f.values.get(f.journal.key), foreign);
});
test('return restores original connected writing, caret and all scroll positions without scrolling focus', () => {
  const calls: unknown[] = [], writer = { tagName: 'TEXTAREA', isConnected: true, selectionStart: 4, selectionEnd: 9, selectionDirection: 'backward',
    scrollTop: 80, scrollLeft: 2, focus: (options: unknown) => calls.push(options), setSelectionRange: (...args: unknown[]) => calls.push(args) } as unknown as HTMLTextAreaElement;
  const region = { isConnected: true, scrollTop: 500, scrollLeft: 0, contains: (value: unknown) => value === writer, querySelectorAll: () => [writer] } as unknown as HTMLElement;
  const kept = captureSetupPosition(region, writer);
  region.scrollTop = 0; writer.scrollTop = 0;
  restoreSetupPosition(kept); assert.deepEqual(calls, [{ preventScroll: true }, [4, 9, 'backward']]); assert.equal(region.scrollTop, 500); assert.equal(writer.scrollTop, 80);
  Object.assign(writer, { isConnected: false }); calls.length = 0; restoreSetupPosition(kept); assert.deepEqual(calls, []);
});
const ready: AssistantConnection = { state: 'ready', message: 'Connected', methods: [], grantedScopes: [], modelAuthReady: true };
test('healthy readiness adds no composer notice and never borrows the previous reply account', () => {
  const account = { state: 'available', accounts: [{ profileId: 'old', label: 'Old', health: 'reconnect' }] } as ChatGptAccountStatus;
  const conversation = { preferredAccountId: 'next', accountSelection: { profileId: 'old' } } as Conversation;
  assert.equal(assistantPrerequisite(ready, 'ready', account, false, conversation), undefined);
  assert.equal(assistantPrerequisite(ready, 'ready', account, true, { ...conversation, preferredAccountId: 'old' }), undefined);
});
test('host read failure and host approval stay distinct from current account reconnection', () => {
  const account = { state: 'available', accounts: [{ profileId: 'next', label: 'Selected Account', health: 'reconnect' }] } as ChatGptAccountStatus;
  const conversation = { preferredAccountId: 'next' } as Conversation;
  assert.equal(assistantPrerequisite(ready, 'error', account, false, conversation)?.title, 'Host Status Unavailable');
  assert.equal(assistantPrerequisite({ ...ready, state: 'pairing' }, 'ready', account, false, conversation)?.section, 'assistant');
  assert.equal(assistantPrerequisite(ready, 'ready', account, false, conversation)?.title, 'Account Reconnect Needed');
  assert.match(assistantPrerequisite(ready, 'ready', account, false, conversation)!.message, /Selected Account/);
});
test('model access routes to Accounts without mistaking unknown state for an expired account', () => {
  const connection = { ...ready, modelAuthReady: false };
  assert.equal(assistantPrerequisite(connection, 'ready')?.title, 'Model Access Unconfirmed');
  assert.equal(assistantPrerequisite(connection, 'ready', { state: 'empty' } as ChatGptAccountStatus)?.title, 'Account Needed');
  assert.equal(assistantPrerequisite(connection, 'loading')?.section, 'assistant');
});
