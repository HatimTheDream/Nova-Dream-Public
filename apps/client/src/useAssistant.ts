import { assistantSpace, type AssistantSpace } from '../../../packages/domain/assistant-space';
import type { ConversationRemoval, RemoveConversation } from '../../../packages/domain/conversation-removal';
import type { MessagePin } from '../../../packages/domain/message-pins';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationChanges, AssistantModel, AssistantOutput, AssistantState, Conversation, ConversationHistory, ConversationMessage, MessageAttachment } from '../../../packages/domain/assistant';
import type { Snapshot } from '../../../packages/domain/contracts';
import { canonical } from '../../../packages/domain/contracts';
import { ApiError, mayPoll, readLocal, request, saveLocal } from './api';
import { cacheTranscriptWindow, readTranscriptPosition, transcriptPositionKey } from './transcript-position';
import { historyAfterReadFailure, historyRepairAnchor, mergeHistoryPage } from './assistant-history';
import { AssistantHistoryReader, type HistoryReadOptions } from './assistant-history-reader';
import { RefreshReader } from './refresh-reader';
import { pollReader } from './polling';
import { mayLeaveAssistantDraft } from './assistant-draft-navigation';

const initial: AssistantState = { connection: { state: 'unconfigured', message: 'Connect OpenClaw to use your ChatGPT account.', methods: [], grantedScopes: [], modelAuthReady: false }, conversations: [], operations: [] };
export function useAssistant(snapshot: Snapshot, visible = true) {
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
  const historyReader = useRef<AssistantHistoryReader>(undefined);
  const context = useRef({ snapshot, state, history }); context.current = { snapshot, state, history };
  const [modelReader] = useState(() => new RefreshReader({
    identity: () => canonical([context.current.snapshot.epoch, context.current.snapshot.deviceId, context.current.state.connection.state, context.current.state.connection.generation, context.current.state.connection.url]),
    read: signal => request<AssistantModel[]>('assistant/models', undefined, signal),
    accept: next => { setModels(current => canonical(current) === canonical(next) ? current : next); setModelStatus('ready'); },
    fail: () => setModelStatus('error'),
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
    void refresh();
    return () => { mounted.current = false; readers.forEach(reader => reader.cancel()); historyReader.current?.cancel(); };
  }, [readers, refresh, snapshot.epoch, snapshot.deviceId]);
  const active = state.operations.some(op => ['prepared', 'dispatching', 'accepted', 'running'].includes(op.state));
  useEffect(() => {
    const stops = readers.map(reader => pollReader(reader, () => active ? 1500 : visible ? 15000 : 60000, 60000));
    return () => stops.forEach(stop => stop());
  }, [readers, active, visible, snapshot.epoch, snapshot.deviceId]);
  const select = (id: string | null, hint?: AssistantSpace) => {
    const conversation = context.current.state.conversations.find(c => c.id === id);
    const nextSpace = hint ?? (conversation ? assistantSpace(conversation) : spaceRef.current);
    if ((id !== selectedRef.current || nextSpace !== spaceRef.current) && !mayLeaveAssistantDraft()) return false;
    if (nextSpace !== spaceRef.current) { setSpace(nextSpace); spaceRef.current = nextSpace; saveLocal(spaceKey, nextSpace); }
    saveLocal(selectionKey(nextSpace), id);
    if (id === selectedRef.current) return true;
    historyReader.current?.cancel(); generation.current++; historyRequest.current++; setSelectedId(id); selectedRef.current = id; setHistory(undefined); setHistorySource(undefined); setHistoryError(''); setLoading(false); setError('');
    return true;
  };
  const switchSpace = (next: AssistantSpace) => {
    if (next === spaceRef.current) return true;
    const kept = readLocal<string>(selectionKey(next));
    const target = context.current.state.conversations.find(c => c.id === kept && assistantSpace(c) === next && !c.deleted && !c.archived);
    return select(target?.id ?? null, next);
  };
  useEffect(() => {
    const selected = state.conversations.find(c => c.id === selectedRef.current);
    if (selected && assistantSpace(selected) !== spaceRef.current) select(selected.id, assistantSpace(selected));
  }, [state.conversations]);
  const readHistory = useCallback(async (id: string, options: HistoryReadOptions | undefined, signal: AbortSignal) => {
    if (!mounted.current || signal.aborted || selectedRef.current !== id) return;
    const currentGeneration = generation.current, ticket = ++historyRequest.current;
    const epoch = context.current.snapshot.epoch;
    const nativeId = context.current.state.conversations.find(c => c.id === id)?.nativeId;
    const isCurrent = () => mounted.current && !signal.aborted && selectedRef.current === id && generation.current === currentGeneration && historyRequest.current === ticket && context.current.snapshot.epoch === epoch;
    const cacheKey = `e3:history:${epoch}:${id}:nova`;
    const matches = (value: ConversationHistory | undefined): value is ConversationHistory => !!value && value.conversationId === id && (!!value.transcript || value.nativeId === nativeId) && Array.isArray(value.messages);
    setLoading(true);
    try {
      const conversation = context.current.state.conversations.find(c => c.id === id);
      const kept = !options && !matches(context.current.history) ? readTranscriptPosition(transcriptPositionKey(epoch, context.current.snapshot.deviceId, conversation)) : undefined;
      const restore = kept && !kept.following ? kept.anchor : undefined;
      const messageId = options?.messageId ?? restore?.id;
      const query = new URLSearchParams(); if (options?.offset !== undefined) query.set('offset', String(options.offset)); if (messageId) query.set('messageId', messageId); if (restore) query.set('resume', '1');
      let result = await request<ConversationHistory>(`assistant/history/${id}${query.size ? `?${query}` : ''}`, undefined, signal);
      if (!isCurrent()) return;
      const repair = !messageId && !options?.latest ? historyRepairAnchor(context.current.history, result, readTranscriptPosition(transcriptPositionKey(epoch, context.current.snapshot.deviceId, conversation))?.anchor?.id) : undefined;
      if (repair) result = await request<ConversationHistory>(`assistant/history/${id}?messageId=${encodeURIComponent(repair.novaId ?? repair.id)}`, undefined, signal);
      if (!isCurrent()) return;
      if (!matches(result)) throw new Error('The returned history belongs to a different conversation. Refresh this conversation to check its current identity.');
      if (repair && !result.messages.some(message => message.role === repair.role && (message.id === repair.id || !!repair.novaId && message.novaId === repair.novaId || message.aliases?.includes(repair.novaId ?? repair.id)))) throw new Error('The repaired transcript could not confirm your reading position. Your current messages are kept; open Latest to continue.');
      if (restore && !result.messages.some(m => (m.id === restore.id || m.novaId === restore.id || m.aliases?.includes(restore.id)) && m.role === restore.role)) throw new Error('Your saved reading position is no longer available. Open Latest to continue.');
      setHistory(current => { const next = messageId || repair || options?.latest || !!current?.retained !== !!result.retained ? result : mergeHistoryPage(current, result, options?.newer ? 'newer' : options?.offset !== undefined); saveLocal(cacheKey, cacheTranscriptWindow(next, readTranscriptPosition(transcriptPositionKey(epoch, context.current.snapshot.deviceId, conversation)))); return next; }); setHistorySource(result.retained ? 'saved' : 'live'); setHistoryError(result.retained && !result.transcript ? 'Showing saved messages.' : '');
    } catch (reason) {
      if (!isCurrent()) return;
      setHistoryError(reason instanceof Error ? reason.message : 'Conversation history is unavailable.');
      // Earlier versions keyed a cache only by conversation. Its native identity
      // must still match; a restored or replaced session cannot inherit it.
      const cached = readLocal<ConversationHistory>(cacheKey) ?? readLocal<ConversationHistory>(`e3:history:${epoch}:${id}:${nativeId}`) ?? readLocal<ConversationHistory>(`e3:history:${id}`);
      setHistory(current => historyAfterReadFailure(current, cached, id, nativeId));
      setHistorySource('saved');
    } finally { if (mounted.current && !signal.aborted && selectedRef.current === id && generation.current === currentGeneration && historyRequest.current === ticket) setLoading(false); }
  }, []);
  if (!historyReader.current) historyReader.current = new AssistantHistoryReader({
    identity: id => canonical([context.current.snapshot.epoch, context.current.snapshot.deviceId, generation.current, selectedRef.current, id]),
    read: readHistory,
  });
  const loadHistory = useCallback((id = selectedRef.current, options?: HistoryReadOptions) => id ? historyReader.current!.load(id, options) : Promise.resolve(), []);
  const pollHistory = useCallback((id: string) => historyReader.current!.poll(id), []);
  useEffect(() => { if (selectedId) void pollHistory(selectedId); }, [selectedId, state.connection.state, state.connection.generation, state.historyVersions?.[selectedId ?? ''], state.conversations.find(c => c.id === selectedId)?.nativeId, pollHistory]);
  const previousOperations = useRef('');
  useEffect(() => {
    const stamp = state.operations.filter(op => op.conversationId === selectedId).map(op => `${op.id}:${op.state}`).join(',');
    if (stamp !== previousOperations.current) { previousOperations.current = stamp; if (selectedId) void pollHistory(selectedId); }
  }, [state.operations, selectedId, pollHistory]);
  useEffect(() => {
    setModels([]); setModelStatus(state.connection.state === 'ready' ? 'loading' : 'offline');
    const stop = state.connection.state === 'ready' ? pollReader(modelReader, () => modelReader.failed ? 5000 : 60000, 120000) : undefined;
    return () => { stop?.(); modelReader.cancel(); };
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
    if (selectedRef.current === conversation.id && !mayLeaveAssistantDraft()) throw new Error('Keep the current draft before removing this conversation. Free browser storage and retry saving it.');
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
  const selectAccount = async (conversation: Conversation, profileId: string | null) => {
    const key = `e3:conversation-account:${snapshot.epoch}:${snapshot.deviceId}:${conversation.id}`;
    const input = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, expectedRevision: conversation.revision, profileId };
    if (!saveLocal(key, input)) throw new Error('Free browser storage before changing this account.');
    try { const result = await request<Conversation>('assistant/conversation/account', input); localStorage.removeItem(key); return result; }
    catch (error) { if (error instanceof ApiError && ['conversation_busy', 'account_missing', 'account_duplicate', 'account_unavailable', 'epoch_changed'].includes(error.code)) localStorage.removeItem(key); throw error; }
    finally { await refresh(); }
  };
  const pinMessage = async (conversation: Conversation, message: Pick<ConversationMessage, 'id' | 'role' | 'textHash'> & { source?: Pick<NonNullable<ConversationMessage['source']>, 'nativeId'> }, pinned: boolean) => {
    const nativeId = message.source?.nativeId ?? conversation.nativeId;
    const previous = context.current.state.pins?.find(p => p.conversationId === conversation.id && p.nativeId === nativeId && p.messageId === message.id && p.role === message.role);
    const key = `e3:message-pin:${snapshot.epoch}:${nativeId}:${message.role}:${message.id}`;
    const kept = readLocal<{ expectedRevision: number; pinned: boolean }>(key);
    if (kept && (previous?.revision ?? 0) > kept.expectedRevision) localStorage.removeItem(key);
    const input = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, nativeId, messageId: message.id, messageHash: message.textHash, role: message.role, pinned, expectedRevision: previous?.revision ?? 0 };
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
    const intent = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, nativeId: message.source?.nativeId ?? conversation.nativeId, messageId: message.id, messageHash: message.textHash, name };
    if (!saveLocal(key, intent)) throw new Error('Free browser storage before saving this output.');
    const output = await request<AssistantOutput>('assistant/outputs', intent); localStorage.removeItem(key); await refresh(); return output;
  };
  const saveArtifact = async (conversation: Conversation, message: ConversationMessage, attachment: MessageAttachment) => {
    const key = `e3:artifact:${message.source?.nativeId ?? conversation.nativeId}:${message.id}:${attachment.artifactId}:${message.textHash}`;
    const intent = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, nativeId: message.source?.nativeId ?? conversation.nativeId, messageId: message.id, messageHash: message.textHash, artifactId: attachment.artifactId, name: attachment.name.trim() || 'Generated output' };
    if (!saveLocal(key, intent)) throw new Error('Free browser storage before saving this output.');
    const output = await request<AssistantOutput>('assistant/artifact/save', intent); localStorage.removeItem(key); await refresh(); return output;
  };
  return { ...state, space, switchSpace, statusRead, selectedId, conversation: state.conversations.find(c => c.id === selectedId), history, historyError, historySource, models, modelStatus, retryModels, outputs, remove, pinMessage, saveOutput, saveArtifact, error, setError, loading, select, selectAccount, create, edit, recoverSettings, refresh, loadHistory, checkStatus };
}
export type AssistantController = ReturnType<typeof useAssistant>;
