import { createStore } from 'zustand/vanilla';
import { inboxTargetKey, readInboxTarget, type InboxTarget } from '../inbox-target';
import { readLocal, saveLocal } from '../api';
import { captureInboxMailScope } from './inbox-transport';
import { describeNativeGmailLinkedThread, describeNativeGmailThread, getNativeGmailThread, getNativeGmailSendAsAliases, getDefaultNativeGmailSendAs } from './services/native/gmail';
import { describeNativeMicrosoftConversation, getNativeMicrosoftConversation, mergeThreadDigests } from './services/native/microsoftMail';
import type { InboxAccount, InboxThreadDigest, InboxReaderSession } from './services/inbox/inboxSession';
import { inboxThreadLoadKey } from './services/inbox/threadLoadIdentity';
export type LinkedEmail = { account: InboxAccount; digest: InboxThreadDigest; reader: InboxReaderSession };
export async function readLinkedEmail(target: InboxTarget, account: InboxAccount): Promise<LinkedEmail> {
  const scope = captureInboxMailScope();
  let digest: InboxThreadDigest, reader: InboxReaderSession;
  if (target.source.provider === 'google') {
    const [result, aliases] = await Promise.all([getNativeGmailThread({ threadId: target.source.threadId, account: account.accountId }), getNativeGmailSendAsAliases({ account: account.accountId })]);
    scope.assertCurrent();
    if (!result.success || !result.thread) throw new Error(result.error || 'This Gmail conversation is unavailable. Its saved workspace link is kept.');
    if (result.account !== account.accountId || result.thread.id !== target.source.threadId || !result.thread.messages?.length || result.thread.messages.some(message => message.threadId && message.threadId !== target.source.threadId)) throw new Error('The returned Gmail conversation does not match this workspace link.');
    digest = describeNativeGmailLinkedThread(result.thread);
    const sendAs = aliases.success ? aliases.sendAs : [];
    reader = { loadKey: null, threadKey: null, status: 'ready', messages: describeNativeGmailThread(result.thread), sendAsAliases: sendAs, selectedFrom: getDefaultNativeGmailSendAs(sendAs)?.sendAsEmail || account.email, microsoftSignatureDraft: '', error: result.error || null };
  } else {
    const result = await getNativeMicrosoftConversation({ accountId: account.accountId, conversationId: target.source.threadId, messageId: target.messageId });
    scope.assertCurrent();
    if (!result.success) throw new Error(result.error || 'This Outlook conversation is unavailable. Its saved workspace link is kept.');
    if (result.accountId !== account.accountId || !result.messages.length || result.messages.some(message => message.conversationId !== target.source.threadId)) throw new Error('The returned Outlook conversation does not match this workspace link.');
    const summary = mergeThreadDigests(result.threads ?? []).find(thread => thread.id === target.source.threadId);
    if (!summary) throw new Error('The linked Outlook conversation summary is unavailable. Reconnect to the current host and retry.');
    digest = { ...summary, messageCount: new Set(result.messages.map(message => message.id)).size };
    reader = { loadKey: null, threadKey: null, status: 'ready', messages: describeNativeMicrosoftConversation(result.messages), sendAsAliases: [], selectedFrom: account.email, microsoftSignatureDraft: account.signatureText || '', error: result.error || null };
  }
  if (target.messageId && !reader.messages.some(message => message.id === target.messageId)) throw new Error('The exact source email is no longer available in this conversation. Its Contact link and your writing are kept.');
  reader.threadKey = `${account.provider}:${account.key}:${digest.id}`;
  reader.loadKey = inboxThreadLoadKey({ provider: account.provider, accountId: account.accountId, generation: account.generation, accountEmail: account.email, threadId: digest.id, sourceMessageId: digest.sourceMessageId, subject: digest.subject, sender: digest.from, messageCount: digest.messageCount, latestAt: digest.date });
  return { account, digest, reader };
}
type SourceState = { scope?: string; target?: InboxTarget; status: 'idle' | 'loading' | 'ready' | 'error'; value?: LinkedEmail; error?: string; storageError?: string };
type Options = { epoch: string; deviceId: string; windowId: string; previousWindowId?: string; read?: typeof readLinkedEmail };
/** Retains navigation identity only. Provider bodies remain in the existing transient reader lifecycle. */
export function createInboxSource(options: Options) {
  const key = inboxTargetKey(options.deviceId, options.windowId), read = options.read ?? readLinkedEmail;
  const store = createStore<SourceState>(() => ({ target: readInboxTarget(options.deviceId, options.windowId, options.previousWindowId), status: 'idle' }));
  let generation = 0, lastKey = '';
  const acceptStoredTarget = () => {
    const target = readInboxTarget(options.deviceId, options.windowId, options.previousWindowId);
    if (target?.nonce === store.getState().target?.nonce) return;
    generation++; lastKey = ''; store.setState({ target, status: 'idle', value: undefined, error: undefined, storageError: undefined });
  };
  const close = () => {
    if (!saveLocal(key, null)) { store.setState({ storageError: 'Free browser storage before leaving this linked email. Your other writing is kept.' }); return false; }
    generation++; lastKey = ''; store.setState({ target: undefined, status: 'idle', value: undefined, error: undefined, storageError: undefined }); return true;
  };
  const load = async (accounts: InboxAccount[], scope: string, force = false) => {
    const target = store.getState().target; if (!target) return;
    const provider = target.source.provider === 'google' ? 'gmail' : 'microsoft';
    const account = accounts.find(account => account.accountId === target.source.accountId && account.provider === provider && account.canRead);
    const nextKey = JSON.stringify([target.nonce, account, scope]); if (!force && lastKey === nextKey) return; lastKey = nextKey;
    const attempt = ++generation;
    if (target.epoch !== options.epoch) { store.setState({ status: 'error', value: undefined, error: 'This link belongs to an earlier workspace. Reopen its saved source after recovery.' }); return; }
    if (!account) { store.setState({ status: 'error', value: undefined, error: 'Connect the original mail account with read permission to open this email. Its saved source and your writing are kept.' }); return; }
    const previous = store.getState();
    const retained = previous.scope === scope && previous.value?.account.generation === account.generation ? previous.value : undefined;
    store.setState({ status: 'loading', value: retained, error: undefined });
    try {
      const value = await read(target, account);
      if (attempt !== generation || store.getState().target?.nonce !== target.nonce) return;
      if (value.account.accountId !== account.accountId || value.account.generation !== account.generation || value.account.provider !== provider || value.digest.id !== target.source.threadId) throw new Error('The returned email does not match this link and account connection.');
      store.setState({ status: 'ready', value, scope, error: undefined });
    } catch (error) { if (attempt === generation) store.setState({ status: 'error', error: error instanceof Error ? error.message : 'This linked email could not be opened.' }); }
  };
  const scroll = (nonce: string, top?: number) => {
    const scrollKey = key + ':scroll';
    if (top !== undefined && Number.isFinite(top)) { const bounded = Math.max(0, Math.min(10000000, top)); if (!saveLocal(scrollKey, { nonce, top: bounded })) store.setState({ storageError: 'Browser storage is full. Keep this email open to retain its reading position.' }); return bounded; }
    const saved = readLocal<{nonce:string;top:number}>(scrollKey); return saved?.nonce === nonce && Number.isFinite(saved.top) ? saved.top : 0;
  };
  const hasScroll = (nonce: string) => readLocal<{ nonce: string }>(key + ':scroll')?.nonce === nonce;
  return { store, acceptStoredTarget, close, load, scroll, hasScroll };
}
export type InboxSource = ReturnType<typeof createInboxSource>;
