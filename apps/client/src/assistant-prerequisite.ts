import type { AssistantConnection, Conversation } from '../../../packages/domain/assistant';
import type { ChatGptAccountStatus } from '../../../packages/domain/sign-in';

export type AssistantPrerequisite = { title: string; message: string; section: 'accounts' | 'assistant'; check?: boolean };
export function assistantPrerequisite(connection: AssistantConnection, read: 'loading' | 'ready' | 'error',
  account?: ChatGptAccountStatus, stale = false, conversation?: Conversation): AssistantPrerequisite | undefined {
  if (read === 'loading') return { title: 'Checking Assistant', message: 'Reading the host connection. Your writing is kept.', section: 'assistant', check: true };
  if (read === 'error') return { title: 'Host Status Unavailable', message: 'The Assistant host could not be checked. Last-known account status does not confirm a disconnection.', section: 'assistant', check: true };
  if (connection.state !== 'ready') return { title: connection.state === 'pairing' ? 'Host Approval Needed' : connection.state === 'connecting' ? 'Connecting To Host' : 'Assistant Host Unavailable',
    message: connection.message, section: 'assistant', check: true };
  // A previous reply's account is evidence about that reply, never the preference.
  const selected = conversation?.preferredAccountId;
  const preferred = stale ? undefined : account?.accounts?.find(item => item.profileId === selected);
  if (preferred?.health === 'reconnect') return { title: 'Account Reconnect Needed', message: `Reconnect ${preferred.label}, the account selected for the next message.`, section: 'accounts' };
  if (!connection.modelAuthReady && !stale && account?.state === 'empty') return { title: 'Account Needed', message: 'Connect a ChatGPT account on the Assistant host before sending.', section: 'accounts' };
  if (!connection.modelAuthReady) return { title: 'Model Access Unconfirmed', message: 'Check Accounts on the Assistant host. Your selected account and unsent writing are kept.', section: 'accounts', check: true };
  return undefined;
}
