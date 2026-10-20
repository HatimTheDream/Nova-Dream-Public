import { useEffect, useRef, useState } from 'react';
import type { AssistantState, Conversation, ConversationHistory, AssistantOperation, DirectConnectionStatus } from '../../../packages/domain/assistant';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { AssistantController } from './useAssistant';
import { request } from './api';
import { Dialog } from './ui';
import { SquareLynx } from './nova/square-lynx/SquareLynx';
import {
  DirectChatCommands, createDirectChat, continueDirectChat, directChatCommandKey, directChatStorage,
  registerDirectChatOwner, type DirectChatScope, type DirectChatTarget,
} from './direct-agent-chat';
import './direct-agent-chat.css';

function useCommands(scope: DirectChatScope, recipient: NonNullable<Conversation['directAgent']>['recipient'], key: string) {
  const [owner] = useState(() => new DirectChatCommands(directChatStorage, directChatCommandKey(scope, key), scope, recipient));
  const alive = useRef(true), [, update] = useState(0);
  useEffect(() => {
    alive.current = true;
    const retain = () => { const kept = !owner.busy && owner.retain(); if (!kept && alive.current) update(v => v + 1); return kept; };
    const unregister = registerDirectChatOwner(retain);
    const unload = (event: BeforeUnloadEvent) => { if (!retain()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { alive.current = false; unregister(); window.removeEventListener('beforeunload', unload); };
  }, [owner]);
  return { owner, alive, changed: () => { if (alive.current) update(v => v + 1); } };
}

export function DirectAgentChooser({ target, snapshot, controller, current, open, close }: {
  target: DirectChatTarget; snapshot: Snapshot; controller: AssistantController;
  current: () => boolean; open: (conversation: Conversation) => boolean; close: () => void;
}) {
  const agent = snapshot.records?.agent.find(value => value.id === target.recipient.agentId);
  const { owner, alive, changed } = useCommands(target.scope, target.recipient, `create:${target.recipient.agentId}`);
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const latest = useRef({ snapshot, controller, target, current }); latest.current = { snapshot, controller, target, current };
  const exact = () => alive.current && latest.current.current()
    && latest.current.snapshot.epoch === target.scope.epoch && latest.current.snapshot.deviceId === target.scope.deviceId;
  const available = !!agent && !agent.value.archived && agent.revision === target.recipient.agentRevision;
  const matches = controller.conversations.filter(c => c.directAgent?.recipient.agentId === target.recipient.agentId);
  const create = async () => {
    const currentAgent = latest.current.snapshot.records?.agent.find(value => value.id === target.recipient.agentId);
    if (!exact() || !available || !currentAgent || currentAgent.revision !== target.recipient.agentRevision
      || currentAgent.value.archived || busy || !owner.retain()) { changed(); return; }
    setBusy(true); setNotice('');
    try {
      await owner.send(createDirectChat(target.scope, target.recipient, agent.value.name, crypto.randomUUID()), request, exact);
      changed();
      if (exact()) await controller.refresh();
    } catch (reason) { if (exact()) setNotice(reason instanceof Error ? reason.message : 'The saved chat list could not be refreshed. The original request is kept.'); }
    finally { if (exact()) setBusy(false); }
  };
  const observe = async () => {
    if (!exact() || busy) return;
    setBusy(true); setNotice('');
    try {
      if (!owner.retain()) { changed(); return; }
      const state = await request<AssistantState>('assistant/state');
      if (!exact()) return;
      const found = owner.observe(state); changed();
      setNotice(found ? 'The original saved chat is confirmed. Open it below.' : 'The original result is not available. Its request is kept; no replacement was sent.');
      await controller.refresh();
    } catch (reason) { if (exact()) setNotice(reason instanceof Error ? reason.message : 'Original status is unavailable.'); }
    finally { if (exact()) setBusy(false); }
  };
  return <Dialog title="Chat With Agent" close={() => { if (!busy && owner.retain()) close(); else changed(); }}><div className="direct-agent-chooser">
    <div className="direct-agent-person">{agent && <SquareLynx appearance={agent.value.appearance} size="icon" accessibility={{ mode: 'decorative' }}/>}<div><strong>{agent?.value.name ?? 'Saved agent unavailable'}</strong><p className="metadata">{agent?.value.position || 'Your saved recipient'} · Revision {target.recipient.agentRevision}</p></div></div>
    <p>This opens a separate direct conversation. Your ordinary Chat and Work writing stays in its original draft.</p>
    {!available && <p className="notice" role="status">This exact saved agent changed or is unavailable. Existing conversations remain below. Reopen the current agent profile before creating a new chat.</p>}
    {matches.length > 0 && <div className="direct-agent-chat-list" aria-label="Existing direct chats">{matches.map(conversation => <button key={conversation.id} disabled={busy} onClick={() => { if (exact() && owner.retain()) open(conversation); else changed(); }}><strong>{conversation.title}</strong><small>{conversation.deleted ? 'Deleted · Read only' : conversation.archived ? 'Archived · Read only' : conversation.nativeId && conversation.state === 'ready' ? 'Saved conversation' : 'Connection needs review'}</small></button>)}</div>}
    {owner.value?.confirmation && <p className="metadata" role="status">The original chat was saved. Open that conversation above; no second creation request will be sent.</p>}
    {owner.value && !owner.value.confirmation && <p className="notice" role="status">The original creation request is kept. Check it before starting another chat.</p>}
    {(owner.error || notice) && <p className="field-error" role="status">{owner.error || notice}</p>}
    <div className="dialog-footer">
      {owner.value ? <button disabled={busy} onClick={() => void observe()}>{busy ? 'Checking…' : 'Check Original Status'}</button>
        : <button className="primary" disabled={!available || busy || !!owner.error} onClick={() => void create()}>{busy ? 'Connecting…' : 'Create Chat & Connect'}</button>}
      {owner.value?.confirmation && <button disabled={busy || !available} onClick={() => { owner.beginAnother(); changed(); }}>New Separate Chat</button>}
      <button disabled={busy} onClick={() => { if (owner.retain()) close(); else changed(); }}>Back</button>
    </div>
  </div></Dialog>;
}

export function DirectAgentAccount({ conversation, history, operations }: {
  conversation: Conversation; history?: ConversationHistory; operations: AssistantOperation[];
}) {
  // A selected account on a failed/unfinished attempt is not a reply.
  const message = !history?.hasNewer && history?.conversationId === conversation.id
    ? [...history.messages].reverse().find(row => row.role === 'assistant' && row.author?.conversationId === conversation.id && row.operationId)
    : undefined;
  const operation = message && operations.find(row => row.id === message.operationId && row.conversationId === conversation.id
    && row.context.directAgent && row.context.directAgent.operationId === row.id && row.state === 'completed'
    && row.requestId === message.author?.requestId);
  return <div className="metadata direct-agent-account">
    <span>Next turn: {conversation.preferredAccountId ? 'Saved account preference' : 'Default account preference'}</span>
    <span>Last confirmed reply: {operation?.accountSelection?.label ?? (operation?.accountSelection ? 'Saved account' : 'Unavailable')}</span>
    <span>Account changes are not available in direct chats yet.</span>
  </div>;
}

export function DirectAgentStatus({ conversation, snapshot, controller, scope, back }: {
  conversation: Conversation; snapshot: Snapshot; controller: AssistantController; scope: DirectChatScope; back?: () => void;
}) {
  const binding = conversation.directAgent!;
  const agent = snapshot.records?.agent.find(value => value.id === binding.recipient.agentId);
  const { owner, alive, changed } = useCommands(scope, binding.recipient, `connect:${conversation.id}`);
  const current = useRef({ conversation, scope, controller }); current.current = { conversation, scope, controller };
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const sameOwner = () => alive.current && current.current.scope.epoch === scope.epoch && current.current.scope.deviceId === scope.deviceId && current.current.scope.windowId === scope.windowId
    && current.current.conversation.id === conversation.id && current.current.controller.selectedId === conversation.id;
  const exact = () => sameOwner() && current.current.conversation.revision === conversation.revision;
  const statuses = controller.directConnections?.filter(row => row.conversationId === conversation.id) ?? [];
  const status: DirectConnectionStatus | undefined = statuses.length === 1 && statuses[0].conversationRevision === conversation.revision ? statuses[0] : undefined;
  const unavailable = !agent || agent.value.archived || agent.revision < binding.recipient.agentRevision;
  const connected = !!conversation.nativeId && conversation.state === 'ready' && !conversation.nativeRestorePending;
  const check = async () => {
    if (!exact() || busy) return;
    setBusy(true); setNotice('');
    try {
      if (!owner.retain()) { changed(); return; }
      if (await controller.checkStatus(conversation.id)) {
        if (sameOwner()) setNotice('Original status was checked. No connection or message was resent.');
      }
    } finally { if (sameOwner()) setBusy(false); }
  };
  const proceed = async () => {
    if (!exact() || busy || unavailable || !status || !owner.retain()) { changed(); return; }
    setBusy(true); setNotice('');
    try {
      if (owner.value && !owner.beginAnother()) { changed(); return; }
      const command = continueDirectChat(scope, conversation, status, crypto.randomUUID());
      await owner.send(command, request, exact); changed();
      if (exact()) await controller.refresh();
    } catch (reason) { if (sameOwner()) setNotice(reason instanceof Error ? reason.message : 'The original connection cannot be continued.'); }
    finally { if (sameOwner()) setBusy(false); }
  };
  return <section className="direct-agent-status" aria-label="Direct chat recipient">
    <div className="direct-agent-person"><SquareLynx appearance={binding.design.appearance} size="icon" accessibility={{ mode: 'decorative' }}/><div><strong>{binding.design.name}</strong><span className="metadata">Direct chat · {binding.design.position || 'Saved agent'} · Original revision {binding.recipient.agentRevision}</span></div>{back && <button className="text-button" onClick={() => { if (owner.retain()) back(); else changed(); }}>Back</button>}</div>
    {unavailable ? <p role="status">This agent is unavailable. Saved messages and your draft are kept.</p> : agent.revision !== binding.recipient.agentRevision && <p className="metadata">Current agent revision {agent.revision}. Earlier messages keep their original captured identity and access.</p>}
    {!connected && <div className="direct-agent-connection"><span role="status">{status?.canContinueUnsent ? 'Saved chat · the original connection failed before dispatch.' : status?.state === 'preparing' || status?.state === 'dispatching' ? 'Original connection in progress · no second request will be sent.' : status ? 'Original connection is unconfirmed. Your draft is kept.' : 'Connection status is unavailable. A missing status is not permission to connect again.'}</span><button disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check Original Status'}</button>
      {status?.canContinueUnsent && (!owner.value || owner.value.confirmation) && <button disabled={busy || unavailable || !!owner.error || conversation.archived || conversation.deleted} onClick={() => void proceed()}>Continue Original Connection</button>}</div>}
    {owner.value && <p className="metadata" role="status">{owner.value.confirmation ? 'The continuation reply is kept. Current connection status is shown separately.' : 'The original continuation request is kept. Check status; it will not be resent.'}</p>}
    {(owner.error || notice) && <p className="field-error" role="status">{owner.error || notice}</p>}
    {conversation.error && !connected && <p className="metadata">{conversation.error}</p>}
  </section>;
}
