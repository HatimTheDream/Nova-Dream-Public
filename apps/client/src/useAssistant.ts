import { assistantSpace, type AssistantSpace } from '../../../packages/domain/assistant-space';
import type { ConversationRemoval, RemoveConversation } from '../../../packages/domain/conversation-removal';
import type { MessagePin } from '../../../packages/domain/message-pins';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationChanges, AssistantModel, AssistantOutput, AssistantState, Conversation, ConversationHistory, ConversationMessage, MessageAttachment } from '../../../packages/domain/assistant';
import type { Snapshot } from '../../../packages/domain/contracts';
import { canonical } from '../../../packages/domain/contracts';
import { ApiError, mayPoll, readLocal, request, saveLocal } from './api';
import { cacheTranscriptWindow, readTranscriptPosition, transcriptPositionKey } from './transcript-position';
import { mergeHistoryPage } from './assistant-history';
import { RefreshReader } from './refresh-reader';

const initial: AssistantState = { connection: { state: 'unconfigured', message: 'Connect OpenClaw to use your ChatGPT account.', methods: [], grantedScopes: [], modelAuthReady: false }, conversations: [], operations: [] };
export function useAssistant(snapshot: Snapshot) {
  const [state, setState] = useState<AssistantState>(initial);
  const spaceKey = `e3:assistant-space:${snapshot.epoch}:${snapshot.deviceId}`;
  const [space, setSpace] = useState<AssistantSpace>(() => readLocal<string>(spaceKey) === 'work' ? 'work' : 'chat');
  const spaceRef = useRef(space); spaceRef.current = space;
  const selectionKey = (value: AssistantSpace) => `e3:conversation:${snapshot.deviceId}${value === 'work' ? ':work' : ''}`;
  const [selectedId, setSelectedId] = useState<string | null>(() => readLocal<string>(selectionKey(space)) ?? null);
  const [history, setHistory] = useState<ConversationHistory>();
  const [models, setModels] = useState<AssistantModel[]>([]);
  const [modelStatus, setModelStatus] = useState<'loading' | 'ready' | 'error' | 'offline'>('loading');
  const [outputs, setOutputs] = useState<AssistantOutput[]>([]);
  const [statusRead, setStatusRead] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [historySource, setHistorySource] = useState<'live' | 'saved'>();
  const [loading, setLoading] = useState(false);
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const generation = useRef(0);
  const historyRequest = useRef(0), mounted = useRef(false);
  const context = useRef({ snapshot, state, history }); context.current = { snapshot, state, history };
  const modelsReady = useRef(false);
  const [modelReader] = useState(() => new RefreshReader({
    identity: () => canonical([context.current.snapshot.epoch, context.current.snapshot.deviceId, context.current.state.connection.state, context.current.state.connection.generation, context.current.state.connection.url]),
    read: signal => request<AssistantModel[]>('assistant/models', undefined, signal),
    accept: next => { setModels(current => canonical(current) === canonical(next) ? current : next); modelsReady.current = true; setModelStatus('ready'); },
    fail: () => { modelsReady.current = false; setModelStatus('error'); },
  }));
  const retryModels = useCallback(async () => { if (context.current.state.connection.state === 'ready') { setModelStatus('loading'); await modelReader.poll(); } }, [modelReader]);
  const [readers] = useState(() => {
    const identity = () => canonical([context.current.snapshot.epoch, context.current.snapshot.deviceId]);
    return [
      new RefreshReader({ identity, mayPoll: () => mayPoll('assistant/state'), read: signal => request<AssistantState>('assistant/state', undefined, signal), accept: next => { setState(current => canonical(current) === canonical(next) ? current : next); setStatusRead('ready'); }, fail: () => setStatusRead('error') }),
      new RefreshReader({ identity, mayPoll: () => mayPoll('assistant/outputs'), read: signal => request<AssistantOutput[]>('assistant/outputs', undefined, signal), accept: next => setOutputs(current => canonical(current) === canonical(next) ? current : next) }),
    ];
  });
  const refresh = useCallback(async () => {
    if (mounted.current) await Promise.all(readers.map(reader => reader.refresh()));
  }, [readers]);
  useEffect(() => {
    mounted.current = true;
    setStatusRead('loading'); setState(initial); setOutputs([]); setModels([]); setHistory(undefined); setHistorySource(undefined); setHistoryError('');
    generation.current++; historyRequest.current++;
    const poll = () => { for (const reader of readers) void reader.poll(); };
    void refresh(); const timer = setInterval(poll, 1500);
    return () => { mounted.current = false; clearInterval(timer); readers.forEach(reader => reader.cancel()); };
  }, [readers, refresh, snapshot.epoch, snapshot.deviceId]);
  const select = (id: string | null, hint?: AssistantSpace) => {
    const conversation = context.current.state.conversations.find(c => c.id === id);
    const nextSpace = hint ?? (conversation ? assistantSpace(conversation) : spaceRef.current);
    if (nextSpace !== spaceRef.current) { setSpace(nextSpace); spaceRef.current = nextSpace; saveLocal(spaceKey, nextSpace); }
    saveLocal(selectionKey(nextSpace), id);
    if (id === selectedRef.current) return;
    generation.current++; historyRequest.current++; setSelectedId(id); selectedRef.current = id; setHistory(undefined); setHistorySource(undefined); setHistoryError(''); setLoading(false); setError('');
  };
  const switchSpace = (next: AssistantSpace) => {
    if (next === spaceRef.current) return;
    const kept = readLocal<string>(selectionKey(next));
    const target = context.current.state.conversations.find(c => c.id === kept && assistantSpace(c) === next && !c.deleted && !c.archived);
    select(target?.id ?? null, next);
  };
  useEffect(() => {
    const selected = state.conversations.find(c => c.id === selectedRef.current);
    if (selected && assistantSpace(selected) !== spaceRef.current) select(selected.id, assistantSpace(selected));
  }, [state.conversations]);
  const loadHistory = useCallback(async (id = selectedRef.current, options?: { offset?: number; messageId?: string; newer?: boolean; latest?: boolean }) => {
    if (!id) return;
    const currentGeneration = generation.current, ticket = ++historyRequest.current;
    const epoch = context.current.snapshot.epoch;
    const nativeId = context.current.state.conversations.find(c => c.id === id)?.nativeId;
    const host = context.current.state.connection.generation;
    const isCurrent = () => selectedRef.current === id && generation.current === currentGeneration && historyRequest.current === ticket && context.current.snapshot.epoch === epoch && context.current.state.connection.generation === host && context.current.state.conversations.find(c => c.id === id)?.nativeId === nativeId;
    const cacheKey = `e3:history:${epoch}:${id}:${nativeId}`;
    const matches = (value: ConversationHistory | undefined): value is ConversationHistory => !!value && value.conversationId === id && value.nativeId === nativeId && Array.isArray(value.messages);
    setLoading(true);
    try {
      const conversation = context.current.state.conversations.find(c => c.id === id);
      const kept = !options && !matches(context.current.history) ? readTranscriptPosition(transcriptPositionKey(epoch, context.current.snapshot.deviceId, conversation)) : undefined;
      const restore = kept && !kept.following ? kept.anchor : undefined;
      const messageId = options?.messageId ?? restore?.id;
      const query = new URLSearchParams(); if (options?.offset !== undefined) query.set('offset', String(options.offset)); if (messageId) query.set('messageId', messageId); if (restore) query.set('resume', '1');
      const result = await request<ConversationHistory>(`assistant/history/${id}${query.size ? `?${query}` : ''}`);
      if (!isCurrent()) return;
      if (!matches(result)) throw new Error('The returned history belongs to a different conversation. Refresh this conversation to check its current identity.');
      if (restore && !result.messages.some(m => m.id === restore.id && m.role === restore.role)) throw new Error('Your saved reading position is no longer available. Open Latest to continue.');
      setHistory(current => { const next = messageId || options?.latest || !!current?.retained !== !!result.retained ? result : mergeHistoryPage(current, result, options?.newer ? 'newer' : options?.offset !== undefined); saveLocal(cacheKey, cacheTranscriptWindow(next, readTranscriptPosition(transcriptPositionKey(epoch, context.current.snapshot.deviceId, conversation)))); return next; }); setHistorySource(result.retained ? 'saved' : 'live'); setHistoryError(result.retained ? 'Showing saved messages. Reconnect the original Assistant to check for updates.' : '');
    } catch (reason) {
      if (!isCurrent()) return;
      setHistoryError(reason instanceof Error ? reason.message : 'Conversation history is unavailable.');
      // Earlier versions keyed a cache only by conversation. Its native identity
      // must still match; a restored or replaced session cannot inherit it.
      const cached = readLocal<ConversationHistory>(cacheKey) ?? readLocal<ConversationHistory>(`e3:history:${id}`);
      if (matches(cached)) { setHistory(cached); setHistorySource('saved'); }
    } finally { if (selectedRef.current === id && generation.current === currentGeneration && historyRequest.current === ticket) setLoading(false); }
  }, []);
  useEffect(() => { if (selectedId) void loadHistory(selectedId); }, [selectedId, state.connection.state, state.connection.generation, state.historyVersions?.[selectedId ?? ''], state.conversations.find(c => c.id === selectedId)?.nativeId, loadHistory]);
  const previousOperations = useRef('');
  useEffect(() => {
    const stamp = state.operations.filter(op => op.conversationId === selectedId).map(op => `${op.id}:${op.state}`).join(',');
    if (stamp !== previousOperations.current) { previousOperations.current = stamp; if (selectedId) void loadHistory(selectedId); }
  }, [state.operations, selectedId, loadHistory]);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    modelsReady.current = false; setModels([]); setModelStatus(state.connection.state === 'ready' ? 'loading' : 'offline');
    const poll = async () => { await modelReader.poll(); if (alive) timer = setTimeout(() => void poll(), modelsReady.current ? 30000 : 5000); };
    if (state.connection.state === 'ready') void poll();
    return () => { alive = false; clearTimeout(timer); modelReader.cancel(); };
  }, [modelReader, snapshot.epoch, snapshot.deviceId, state.connection.state, state.connection.generation, state.connection.url, state.connection.modelAuthReady]);
  const create = async (input: { space?: AssistantSpace; requestId: string; title: string; autoTitle?: boolean; projectId: string | null; model?: string; thinking?: string; fastMode?: boolean | 'auto'; permissionMode?: Conversation['permissionMode']; refineSource?: Conversation['refineSource'] }) => {
    const conversation = await request<Conversation>('assistant/conversations', { ...input, epoch: snapshot.epoch }, undefined, 30000); await refresh(); return conversation;
  };
  const edit = async (conversation: Conversation, changes: ConversationChanges) => {
    const key = `e3:conversation-edit:${conversation.id}`;
    const kept = readLocal<ConversationChanges & { requestId: string; expectedRevision: number }>(key);
    // No pending edit and a newer revision mean the old intent was resolved or
    // superseded, even if another device has since chosen different settings.
    const settled = kept && !conversation.pendingSettings && (conversation.revision > kept.expectedRevision || conversation.settingsResult?.requestId === kept.requestId);
    if (settled) localStorage.removeItem(key);
    const intent = (settled ? undefined : kept) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, expectedRevision: conversation.revision, ...changes };
    if (!saveLocal(key, intent)) throw new Error('Free browser storage before changing this conversation.');
    try {
      const result = await request<Conversation>('assistant/conversation/edit', intent, undefined, 30000);
      if (!result.pendingSettings) localStorage.removeItem(key);
      return result;
    } catch (e) { if (e instanceof ApiError && e.code === 'edit_rejected') localStorage.removeItem(key); throw e; }
    finally { await refresh(); if (selectedRef.current === conversation.id) await loadHistory(conversation.id); }
  };
  const remove = async (conversation: Conversation) => {
    const key = `e3:conversation-remove:${snapshot.epoch}:${conversation.id}`;
    const existing = state.removals?.find(item => item.conversationId === conversation.id && ['prepared', 'unknown'].includes(item.state));
    const kept = readLocal<RemoveConversation>(key);
    const rejected = kept && state.removals?.some(item => item.requestId === kept.requestId && item.state === 'rejected');
    const intent: RemoveConversation = existing ? { requestId: existing.deviceId === snapshot.deviceId ? existing.requestId : kept?.requestId ?? crypto.randomUUID(), epoch: existing.epoch, conversationId: existing.conversationId, expectedRevision: existing.expectedRevision } : !rejected && kept || { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, expectedRevision: conversation.revision };
    if (!saveLocal(key, intent)) throw new Error('This removal could not be kept safely. Try again after freeing browser storage.');
    try {
      const result = await request<ConversationRemoval>('assistant/conversation/remove', intent, undefined, 30000);
      if (['completed', 'rejected'].includes(result.state)) localStorage.removeItem(key);
      if (result.state !== 'completed') throw new Error(result.message ?? 'Removal is not confirmed. Check again.');
      if (selectedRef.current === conversation.id) select(null);
      return result;
    } finally { await refresh(); }
  };
  useEffect(() => {
    const removed = state.removals?.filter(item => item.state === 'completed') ?? [];
    for (const item of removed) {
      for (const key of Object.keys(localStorage)) if ((key.startsWith('e3:history:') || key.startsWith('e3:transcript-position:')) && key.split(':').includes(item.conversationId)) localStorage.removeItem(key);
    }
    if (removed.some(item => item.conversationId === selectedRef.current)) select(null);
  }, [state.removals]);
  const recoverSettings = async (conversation: Conversation, action: 'retry' | 'use-current') => {
    if (!conversation.pendingSettings) return conversation;
    const key = `e3:settings-recovery:${snapshot.epoch}:${conversation.id}:${conversation.pendingSettings.requestId}:${action}`;
    const intent = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, expectedRevision: conversation.revision, pendingRequestId: conversation.pendingSettings.requestId, action };
    if (!saveLocal(key, intent)) throw new Error('Free browser storage before resolving these settings.');
    try {
      const result = await request<Conversation>('assistant/conversation/recover-settings', intent, undefined, 30000);
      localStorage.removeItem(key);
      if (!result.pendingSettings) localStorage.removeItem(`e3:conversation-edit:${conversation.id}`);
      return result;
    } catch (e) {
      if (e instanceof ApiError && ['edit_rejected', 'edit_unknown', 'settings_unverified', 'settings_busy', 'conversation_changed'].includes(e.code)) localStorage.removeItem(key);
      if (e instanceof ApiError && e.code === 'edit_rejected') localStorage.removeItem(`e3:conversation-edit:${conversation.id}`);
      throw e;
    } finally { await refresh(); if (selectedRef.current === conversation.id) await loadHistory(conversation.id); }
  };
  const checkStatus = async (id = selectedRef.current) => { if (!id) return false; try { await request(`assistant/reconcile/${id}`); await refresh(); if (id === selectedRef.current) await loadHistory(); return true; } catch (e) { setError(e instanceof Error ? e.message : 'Status unavailable.'); return false; } };
  const pinMessage = async (conversation: Conversation, message: Pick<ConversationMessage, 'id' | 'role' | 'textHash'>, pinned: boolean) => {
    const previous = context.current.state.pins?.find(p => p.conversationId === conversation.id && p.nativeId === conversation.nativeId && p.messageId === message.id && p.role === message.role);
    const key = `e3:message-pin:${snapshot.epoch}:${conversation.nativeId}:${message.role}:${message.id}`;
    const kept = readLocal<{ expectedRevision: number; pinned: boolean }>(key);
    if (kept && (previous?.revision ?? 0) > kept.expectedRevision) localStorage.removeItem(key);
    const input = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, nativeId: conversation.nativeId, messageId: message.id, messageHash: message.textHash, role: message.role, pinned, expectedRevision: previous?.revision ?? 0 };
    if (!saveLocal(key, input)) throw new Error('Free browser storage before changing this pin.');
    try {
      // Exact source read does not replace the writer's reading window.
      if (pinned) await request(`assistant/history/${conversation.id}?messageId=${encodeURIComponent(message.id)}`);
      const result = await request<MessagePin>('assistant/message-pin', input); localStorage.removeItem(key); return result;
    } catch (e) { if (e instanceof ApiError && ['pin_changed', 'pin_source_changed'].includes(e.code)) localStorage.removeItem(key); throw e; }
    finally { await refresh(); }
  };
  const saveOutput = async (conversation: Conversation, message: ConversationMessage, name: string) => {
    const key = `e3:output:${conversation.id}:${message.id}:${message.textHash}`;
    const intent = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, nativeId: conversation.nativeId, messageId: message.id, messageHash: message.textHash, name };
    if (!saveLocal(key, intent)) throw new Error('Free browser storage before saving this output.');
    const output = await request<AssistantOutput>('assistant/outputs', intent); localStorage.removeItem(key); await refresh(); return output;
  };
  const saveArtifact = async (conversation: Conversation, message: ConversationMessage, attachment: MessageAttachment) => {
    const key = `e3:artifact:${conversation.nativeId}:${message.id}:${attachment.artifactId}:${message.textHash}`;
    const intent = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, nativeId: conversation.nativeId, messageId: message.id, messageHash: message.textHash, artifactId: attachment.artifactId, name: attachment.name.trim() || 'Generated output' };
    if (!saveLocal(key, intent)) throw new Error('Free browser storage before saving this output.');
    const output = await request<AssistantOutput>('assistant/artifact/save', intent); localStorage.removeItem(key); await refresh(); return output;
  };
  return { ...state, space, switchSpace, statusRead, selectedId, conversation: state.conversations.find(c => c.id === selectedId), history, historyError, historySource, models, modelStatus, retryModels, outputs, remove, pinMessage, saveOutput, saveArtifact, error, setError, loading, select, create, edit, recoverSettings, refresh, loadHistory, checkStatus };
}
export type AssistantController = ReturnType<typeof useAssistant>;
