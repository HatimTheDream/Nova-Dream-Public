import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccountsState, ConnectedAccount } from '../packages/domain/accounts.js';
import { matchingProviderIntent, providerConnectionStatus, providerPollInterval } from '../apps/client/src/settings-account-status.js';

test('provider summary cannot hide a failed account behind another connected account', () => {
  const states = (...values: ConnectedAccount['state'][]) => values.map(state => ({ state }));
  assert.equal(providerConnectionStatus(states('connected', 'reconnect'), true), 'Some accounts need sign-in');
  assert.equal(providerConnectionStatus(states('reconnect', 'reconnect'), true), 'Sign-in needed');
  assert.equal(providerConnectionStatus(states('connected', 'disconnected'), true), 'Partially connected');
  assert.equal(providerConnectionStatus(states('connected', 'refreshing'), true), 'Refreshing…');
  assert.equal(providerConnectionStatus(states('connected', 'connected'), true), 'Connected');
  assert.equal(providerConnectionStatus([], true), 'Ready to connect');
  assert.equal(providerConnectionStatus([], false), 'Setup needed');
});

test('inactive settings stop background account reads without dropping an active sign-in', () => {
  assert.equal(providerPollInterval(false), null);
  assert.equal(providerPollInterval(true), 30000);
  const attempts = (state: AccountsState['attempts'][number]['state']) => [{ state }] as AccountsState['attempts'];
  for (const state of ['preparing', 'waiting', 'exchanging'] as const) {
    assert.equal(providerPollInterval(true, attempts(state)), 2000);
    assert.equal(providerPollInterval(false, attempts(state)), 2000);
  }
  for (const state of ['completed', 'cancelled', 'expired', 'failed', 'unknown'] as const) assert.equal(providerPollInterval(false, attempts(state)), null);
});

test('a saved account request is recovered only in its original workspace epoch', () => {
  const saved = { action: 'configure', command: { epoch: 'original', requestId: '35b6aebd-1814-42d6-8cd8-d3ebce3211f7' } };
  assert.equal(matchingProviderIntent(saved, 'original'), saved);
  assert.equal(matchingProviderIntent(saved, 'different'), undefined);
  assert.equal(matchingProviderIntent(undefined, 'original'), undefined);
  assert.equal(saved.command.requestId, '35b6aebd-1814-42d6-8cd8-d3ebce3211f7');
});

test('malformed account journals do not crash Settings or become executable intents', () => {
  for (const saved of [null, false, 'text', {}, { action: 'start' }, { action: 'start', command: null }, { action: 'start', command: [] }, { action: 'start', command: { epoch: 'original', requestId: 42 } }, { action: 'start', command: { epoch: 'original', requestId: 'not-a-request' } }, { action: 'unexpected', command: { epoch: 'original', requestId: '35b6aebd-1814-42d6-8cd8-d3ebce3211f7' } }]) assert.equal(matchingProviderIntent(saved, 'original'), undefined);
});
