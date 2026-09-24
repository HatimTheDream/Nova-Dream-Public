import type { AccountsState, ConnectedAccount } from '../../../packages/domain/accounts';

export const providerAccountStatus = (state: ConnectedAccount['state']) => ({ connected: 'Connected', refreshing: 'Refreshing…', reconnect: 'Sign-in needed', disconnected: 'Disconnected' })[state];

export function providerConnectionStatus(accounts: Pick<ConnectedAccount, 'state'>[], configured: boolean): string {
  if (accounts.some(account => account.state === 'reconnect')) return accounts.every(account => account.state === 'reconnect') ? 'Sign-in needed' : 'Some accounts need sign-in';
  if (accounts.some(account => account.state === 'refreshing')) return 'Refreshing…';
  if (accounts.some(account => account.state === 'connected')) return accounts.every(account => account.state === 'connected') ? 'Connected' : 'Partially connected';
  return accounts.length ? 'Disconnected' : configured ? 'Ready to connect' : 'Setup needed';
}

export const providerSignInActive = (state: string) => ['preparing', 'waiting', 'exchanging'].includes(state);
export const providerPollInterval = (active: boolean, attempts: AccountsState['attempts'] = []) => attempts.some(attempt => providerSignInActive(attempt.state)) ? 2000 : active ? 30000 : null;

export type ProviderPending = { action: 'configure' | 'start' | 'cancel' | 'disconnect'; command: { requestId: string; epoch: string; [key: string]: unknown } };
export function matchingProviderIntent(intent: unknown, epoch: string): ProviderPending | undefined {
  if (!intent || typeof intent !== 'object') return;
  const kept = intent as Partial<ProviderPending>, command = kept.command;
  return ['configure', 'start', 'cancel', 'disconnect'].includes(kept.action ?? '') && typeof command?.requestId === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(command.requestId) && command.epoch === epoch ? kept as ProviderPending : undefined;
}
