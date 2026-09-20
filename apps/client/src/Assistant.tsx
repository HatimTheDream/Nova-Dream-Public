import { LoadingRing } from './ModuleLoading';
import { AssistantActivityPanel } from './AssistantActivityPanel';
import { assistantSpace, spaceDraftId, type AssistantSpace } from '../../../packages/domain/assistant-space';
import { AssistantSpaceSwitch } from './AssistantSpaceSwitch';
import { ChatGoalControl } from './ChatGoal';
import type { MemorySeed } from './AssistantMemory';
import { ModuleActionTray } from './ModuleActionTray';
import { ApprovalTray, ApprovalCard } from './ApprovalTray';
import { HistoryTool, StepsPill, ToolActivity } from './ToolActivity';
import { ReadAloud } from './read-aloud';
import { ConversationHeaderTools } from './ConversationHeaderTools';
import { workModes } from '../../../packages/domain/work-mode';
import { UseOutputInContent, type ContentOutputActions } from './ContentOutputs';
import { ReplyText } from './ReplyText';
import { ConversationSearch } from './ConversationSearch';
import { ConversationReader } from './ConversationReader';
import type { BrowseTarget } from '../../../packages/domain/search';
import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { lazy } from './preload-lazy';
import { Archive, ArrowUp, Check, Download, File, Folder, MessageSquare, Mic, Paperclip, PanelLeft, Device, PanelRight, Plus, RotateCcw, Save, Settings2, Square, X, Shield, AudioLines, Trash2, MoreHorizontal, ChevronDown, Search, Research, Queue, Image, Target, List } from './icons';
import { canonical, emptyDraft, type Attachment, type Command, type Draft, type Entity, type Snapshot } from '../../../packages/domain/contracts';
import type { AssistantOperation, AssistantOutput, Conversation, ConversationMessage, PermissionMode } from '../../../packages/domain/assistant';
import { Conflict, Dialog, Empty, formatSaved } from './ui';
import { useRetained } from './useWorkspace';
import { useAttachments } from './useAttachments';
import type { AssistantController } from './useAssistant';
import type { VoiceController } from './voice-controller';
import { ApiError, commit, fetchSnapshot, readLocal, request, saveLocal } from './api';
import { GeneratedOutput } from './GeneratedOutput';
import { SidebarRow } from './SidebarRow';
import { ConversationRow } from './ConversationRow';
import { SavedDraftRow } from './SavedDraftRow';
import { MessageQueue } from './MessageQueue';
import { useDictation } from './useDictation';
import { ConversationSources } from './ConversationSources';
import { ConversationFiles, type ConversationSource } from './ConversationSummary';
import { ConversationProjectControl } from './ConversationProjectControl';
import { useWorkspaceTabs } from './useWorkspaceTabs';
import { type WorkspaceView } from './workspace-tabs';
import { AssistantSidePanel } from './AssistantSidePanel';
import { QuestionCard } from './QuestionCard';
import { transcriptCacheKey, transcriptPositionKey } from './transcript-position';
import { useTranscriptScroll } from './useTranscriptScroll';
import { VoicePanel } from './VoicePanel';
import { NovaAssistantMark } from './NovaAssistantMark';
import type { AppIconChoice } from '../../../packages/domain/contracts';
import { groupVoiceMessages, voiceHistoryMessages, type TranscriptMessage } from './voice-transcript';
import { VoiceMessage } from './VoiceMessage';
import { VirtualTranscript, type TranscriptHandle } from './VirtualTranscript';
import { MessageActions } from './MessageActions';
import { ComposerMenu } from './ComposerMenu';
import { AccessDetails, ResponseControls, responseModel, type ResponsePreferences, accessLabels, effortLabel } from './AssistantControls';
import './assistant-restoration.css';
import { useAssistantRail, type AssistantRailState } from './assistant-rail-state';
import { AssistantOrganizationRailFrame } from './dreamclaw/components/Chat/AssistantOrganizationRailFrame';
import { ChatTabs } from './dreamclaw/components/Chat/ChatTabs';
import './dreamclaw/assistant-rail.css';

const modeIcons = { chat: MessageSquare, image: Image, goal: Target, plan: List, research: Research };

const AssistantFilePreview = lazy(() => import('./AssistantFilePreview').then(module => ({ default: module.AssistantFilePreview })));
const TeamWorkPanel = lazy(() => import('./TeamWorkPanel').then(module => ({default:module.TeamWorkPanel})));
const HostBrowserPanel = lazy(() => import('./HostBrowserPanel').then(module => ({ default:module.HostBrowserPanel })));
const WorkProjectChanges = lazy(() => import('./WorkProjectChanges').then(module => ({ default: module.WorkProjectChanges })));
const MemoryPanel = lazy(() => import('./AssistantMemory').then(module => ({ default: module.MemoryPanel })));
const MemoryEditor = lazy(() => import('./AssistantMemory').then(module => ({ default: module.MemoryEditor })));
const ContinueSavedConversation = lazy(() => import('./ContinueSavedConversation').then(module => ({ default: module.ContinueSavedConversation })));

type Journal = ReturnType<typeof useRetained<Draft>>;
type Props = { appIcon: AppIconChoice; contentActions: ContentOutputActions; sourceRequest?: { target: BrowseTarget; nonce: string } | null; snapshot: Snapshot; controller: AssistantController; voice: VoiceController; legacyJournal: Journal; refreshWorkspace: () => Promise<void>; openSettings: () => void; newProject: () => void; editProject: (id: string) => void; initialPreview?: Entity<Draft> };
export function Assistant(props: Props) {
  const controller = props.controller;
  const rail = useAssistantRail(props.snapshot.deviceId);
  if (controller.selectedId && !controller.conversation) return <main className="page-scroll"><Empty title="Opening your conversation…" action={<button onClick={() => controller.select(null)}>Return to your draft</button>}>Saved work stays on this device while the host responds.</Empty></main>;
  return controller.conversation ? <ConversationDraft key={controller.conversation.id} {...props} rail={rail} controller={controller} conversation={controller.conversation}/> : controller.space === 'work' ? <WorkDraft {...props} rail={rail}/> : <Editor key="new-chat" {...props} rail={rail} controller={controller} journal={props.legacyJournal} draftId={spaceDraftId(props.snapshot.deviceId, 'chat')}/>;
}
function WorkDraft(props: Props & { rail: AssistantRailState }) {
  const id = spaceDraftId(props.snapshot.deviceId, 'work');
  const initial = useMemo(() => ({ ...emptyDraft, space: 'work' as const, title: 'New work' }), []);
  const journal = useRetained('draft', id, initial, props.snapshot.drafts.find(d => d.id === id), props.snapshot, props.refreshWorkspace);
  return <Editor key="new-work" {...props} journal={journal} draftId={id}/>;
}
function ConversationDraft(props: Props & { controller: AssistantController; conversation: Conversation; rail: AssistantRailState }) {
  const id = `draft:${props.snapshot.deviceId}:${props.conversation.id}`;
  const initial = useMemo(() => ({ ...emptyDraft, space: assistantSpace(props.conversation), title: props.conversation.title, conversationId: props.conversation.id, projectId: props.conversation.projectId }), [props.conversation.id, props.conversation.title, props.conversation.projectId]);
  const journal = useRetained('draft', id, initial, props.snapshot.drafts.find(d => d.id === id), props.snapshot, props.refreshWorkspace);
  const copyKey = `e3:conversation-copy:${id}`;
  const [copy, setCopy] = useState<Command | undefined>(() => readLocal<Command>(copyKey));
  const [copyError, setCopyError] = useState('');
  const restoreCopy = async () => { if (!copy) return; try { await commit(copy); localStorage.removeItem(copyKey); await props.refreshWorkspace(); setCopy(undefined); } catch (e) { setCopyError(e instanceof Error ? e.message : 'Copy not confirmed.'); } };
  useEffect(() => { void restoreCopy(); }, []);
  if (copy) return <main className="page-scroll"><Empty title="Your draft copy is kept." action={<button onClick={() => void restoreCopy()}>Reconcile draft copy</button>}>{copyError || 'Confirming the saved copy before opening this conversation.'}</Empty><pre className="conflict-copy">{(copy.payload as Draft).text}</pre><button onClick={() => props.controller.select(null)}>Return to original draft</button></main>;
  return <Editor {...props} journal={journal} draftId={id}/>;
}
function Editor({ snapshot, journal, controller, voice, appIcon, draftId, openSettings, newProject, editProject, initialPreview, refreshWorkspace, rail, contentActions, sourceRequest }: Props & { journal: Journal; controller: AssistantController; draftId: string; rail: AssistantRailState }) {
  const voiceState = useSyncExternalStore(voice.subscribe, voice.getSnapshot);
  const [aloud] = useState(() => new ReadAloud());
  const readingAloud = useSyncExternalStore(aloud.subscribe, aloud.getSnapshot);
  useEffect(() => () => aloud.stop(), [aloud]);
  useEffect(() => { aloud.stop(); }, [controller.conversation?.nativeId, controller.connection.generation, aloud]);
  useEffect(() => { if (voiceState.phase !== 'idle') aloud.stop(); }, [voiceState.phase, aloud]);
  const [memorySeed, setMemorySeed] = useState<MemorySeed | null>(null);
  const [continueSaved, setContinueSaved] = useState(false);
  const workspace = useWorkspaceTabs(`${snapshot.epoch}:${controller.space}:${controller.conversation?.id ?? draftId}`);
  const selectedView = workspace.tabs.find(tab => tab.id === workspace.active)!.view;
  const sidePanel = workspace.visible ? selectedView : null;
  const activityOpen = sidePanel?.kind === 'live';
  const setSidePanel = (view: WorkspaceView | null) => workspace.dispatch(view ? { type: 'open', view } : { type: 'visibility', visible: false });
  const [activityContainer, setActivityContainer] = useState<HTMLDivElement | null>(null);
  const [contextDialog, setContextDialog] = useState<{ kind: 'sources' | 'memory' | 'history' | 'technical'; operationId?: string } | null>(null);
  const [hasLiveView, setHasLiveView] = useState(false);
  const closePanel = () => { setSidePanel(null); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="Toggle side panel"]')?.focus()); };
  const openFile = (file: Attachment, output?: AssistantOutput) => { setSidePanel({ kind: 'file', file, ...(output ? { outputId: output.id, outputVersion: output.version } : {}) }); rail.closeMobile(); };
  const [preview, setPreview] = useState<Entity<Draft> | null>(initialPreview ?? null);
  useEffect(() => { if (preview && snapshot.draftRemovals?.some(item => item.draftId === preview.id && item.revision > preview.revision)) setPreview(null); }, [preview, snapshot.draftRemovals]);
  const [folder, setFolder] = useState<'active' | 'archive' | 'deleted'>('active');
  const archive = folder === 'archive';
  const matchesFolder = (item: Conversation) => folder === 'deleted' ? !!item.deleted : !item.deleted && item.archived === archive;
  const [managedId, setManagedId] = useState<string | null>(null);
  const readingKey = `e3:reading:${snapshot.deviceId}${controller.space === 'work' ? ':work' : ''}`;
  const [reading, setReadingState] = useState<BrowseTarget | null>(() => readLocal<BrowseTarget>(readingKey) ?? null);
  const setReading = (target: BrowseTarget | null) => { if (target) aloud.stop(); setReadingState(target); if (target) saveLocal(readingKey, { ...target, offset: undefined }); else localStorage.removeItem(readingKey); };
  useEffect(() => {
    if (sourceRequest && readLocal<string>(`e3:reading:${snapshot.deviceId}:source-request`) !== sourceRequest.nonce) {
      setReading(sourceRequest.target); saveLocal(`e3:reading:${snapshot.deviceId}:source-request`, sourceRequest.nonce);
    }
  }, [sourceRequest?.nonce]);
  const [searchOpen, setSearchOpen] = useState(false);
  const { expandedProjects, toggleProject } = rail;
  const organizationOpen = rail.open && (!(sidePanel || activityOpen) || rail.wide);
  const showOrganization = () => { setSidePanel(null); rail.setOpen(true); };
  const toggleOrganization = () => { if (organizationOpen) rail.setOpen(false); else showOrganization(); };
  const openNewDraft = () => { setFolder('active'); setReading(null); setPreview(null); controller.select(null); rail.closeMobile(); };
  const [dialog, setDialog] = useState<'settings' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const transcript = useRef<TranscriptHandle>(null);
  const [readingParent, setReadingParent] = useState<HTMLDivElement | null>(null);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const scroll = useTranscriptScroll(readingParent, controller.history?.hasNewer !== true);
  const { showLatest, latest: scrollToLatest } = scroll;
  const editorAlive = useRef(true);
  useEffect(() => { editorAlive.current = true; return () => { editorAlive.current = false; }; }, []);
  const preferencesKey = `e3:response-preferences:${snapshot.deviceId}`;
  const [preferences, setPreferences] = useState<ResponsePreferences>(() => readLocal<ResponsePreferences>(preferencesKey) ?? { model: null, thinking: null, fastMode: null });
  const accessKey = `e3:access-preferences:${snapshot.deviceId}`;
  const [accessPreference, setAccessPreference] = useState<PermissionMode>(() => readLocal<PermissionMode>(accessKey) ?? 'read-only');
  const attachments = useAttachments(snapshot, journal.value, journal.change, draftId);
  const filesPending = attachments.staging || attachments.pending.length > 0;
  const fileInput = useRef<HTMLInputElement>(null), textarea = useRef<HTMLTextAreaElement>(null);
  const draft = journal.value, conversation = controller.conversation;
  const response = conversation ? { model: conversation.model, thinking: conversation.thinking, fastMode: conversation.fastMode ?? null } : preferences;
  const responseName = responseModel(controller.models, response.model)?.name ?? response.model ?? 'Default model';
  const actualAccess = conversation ? controller.history?.nativeSettings?.permissionMode ?? conversation.permissionMode : accessPreference;
  useEffect(() => {
    const field = textarea.current; if (!field) return;
    const fit = () => { field.style.height = 'auto'; field.style.height = `${Math.min(180, Math.max(42, field.scrollHeight))}px`; };
    fit(); let width = field.clientWidth;
    const observer = new ResizeObserver(() => { if (field.clientWidth !== width) { width = field.clientWidth; fit(); } });
    observer.observe(field); return () => observer.disconnect();
  }, [draft.text, reading, conversation?.archived]);
  const dictation = useDictation(snapshot.epoch, draftId, text => { journal.change(value => ({ ...value, text: `${value.text}${value.text ? '\n' : ''}${text}` })); textarea.current?.focus(); });
  useEffect(() => { if (conversation && draft.projectId !== conversation.projectId) journal.change(value => ({ ...value, projectId: conversation.projectId })); }, [conversation?.projectId]);
  const project = snapshot.projects.find(p => p.id === draft.projectId);
  const sourceCount = new Set([...(project?.value.attachments ?? []), ...draft.attachments].map(file => file.id)).size;
  const operations = controller.operations.filter(op => op.conversationId === conversation?.id);
  const active = operations.find(op => !op.steerTarget && !['completed', 'failed', 'cancelled'].includes(op.state));
  const latest = operations[0];
  const planOperation = active ?? operations.find(operation => !operation.steerTarget);
  const currentPlan = planOperation?.plan;
  const voiceMessages = voiceHistoryMessages(voiceState, conversation, controller.history);
  const voiceTranscript = !controller.history ? groupVoiceMessages(voiceMessages).map(message => <VoiceMessage key={message.id} message={message}/>) : null;
  const callingHere = voiceState.attempt?.target.conversation.id === conversation?.id && ['preparing', 'connecting', 'connected', 'ending'].includes(voiceState.phase);
  useEffect(() => { if (voiceState.attempt?.target.conversation.id === conversation?.id && voiceState.attempt?.entries.some(e => e.saved)) void controller.loadHistory(conversation?.id); }, [voiceState.attempt?.entries.filter(e => e.saved).length, conversation?.id]);
  const removedIds = new Set(controller.removals?.filter(item => item.state === 'completed').map(item => item.conversationId));
  useEffect(() => { if (reading && removedIds.has(reading.conversationId)) setReading(null); }, [controller.removals, reading]);
  const others = snapshot.drafts.filter(item => assistantSpace(controller.conversations.find(c => c.id === item.value.conversationId) ?? item.value) === controller.space && !removedIds.has(item.value.conversationId ?? '') && item.id !== draftId && (item.value.text || item.value.attachments.length));
  const allRows = [
    ...controller.conversations.filter(item => assistantSpace(item) === controller.space).map(item => {
      const writing = snapshot.drafts.filter(d => d.value.conversationId === item.id);
      const activity = controller.operations.filter(op => op.conversationId === item.id);
      const updatedAt = [item.updatedAt, ...writing.map(d => d.updatedAt), ...activity.map(op => op.updatedAt)].sort().at(-1)!;
      return { kind: 'conversation' as const, item, updatedAt, pinned: !!item.pinned, projectId: item.projectId, folder: item.deleted ? 'deleted' : item.archived ? 'archive' : 'active' };
    }),
    ...others.filter(d => !(d.deviceId === snapshot.deviceId && d.id === `draft:${snapshot.deviceId}:${d.value.conversationId}` && controller.conversations.some(c => c.id === d.value.conversationId))).map(item => {
      const kept = snapshot.draftOrganization?.find(row => row.draftId === item.id);
      const organization = kept?.draftRevision === item.revision ? kept : undefined;
      return { kind: 'draft' as const, item, updatedAt: item.updatedAt, pinned: !!organization?.pinned, projectId: item.value.projectId, folder: organization?.folder ?? 'active' };
    }),
  ].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const recentRows = allRows.filter(row => row.folder === folder && (folder !== 'active' || !snapshot.projects.some(p => p.id === row.projectId)));
  const renderRow = (row: typeof allRows[number]) => {
    if (row.kind === 'draft') return <SavedDraftRow key={`draft:${row.item.id}`} item={row.item} snapshot={snapshot} refresh={refreshWorkspace} open={() => { setReading(null); setPreview(row.item); rail.closeMobile(); }}/>;
    const item = row.item;
    const hasDraft = snapshot.drafts.some(d => d.deviceId === snapshot.deviceId && d.id === `draft:${snapshot.deviceId}:${item.id}` && (d.value.text || d.value.attachments.length));
    return <ConversationRow refreshWorkspace={refreshWorkspace} key={item.id} conversation={item} controller={controller} snapshot={snapshot} hasDraft={!!hasDraft} updatedAt={row.updatedAt} selected={item.id === (reading?.conversationId ?? conversation?.id)} open={() => { if (item.archived && item.nativeId) { setReading({ epoch: snapshot.epoch, conversationId: item.id, nativeId: item.nativeId }); setSidePanel(null); } else { setReading(null); controller.select(item.id); } rail.closeMobile(); }}/>;
  };
  const ready = controller.statusRead === 'ready' && controller.connection.state === 'ready' && controller.connection.grantedScopes.includes('operator.write');
  const keepError = (e: unknown) => setNotice(e instanceof Error ? e.message : 'This action could not be confirmed. Your work is kept.');
  const append = (source: Draft) => {
    const combined = [...new Map([...draft.attachments, ...source.attachments].map(a => [a.id, a])).values()];
    if (combined.length > 10) { setNotice('This copy would exceed 10 attachments. Keep or export the originals before continuing.'); return; }
    journal.change(value => ({ ...value, text: `${value.text}${value.text && source.text ? '\n\n' : ''}${source.text}`, attachments: combined, ...(!value.text.trim() && !value.attachments.length ? { workMode: source.workMode ?? 'chat' } : {}), ...(source.refineSource ? { refineSource: source.refineSource } : {}), ...(conversation ? {} : { projectId: value.text ? value.projectId : source.projectId }) }));
    setPreview(null); textarea.current?.focus();
  };
  const exportDraft = () => {
    const file = new Blob([`${draft.title}\n\n${draft.text}\n\n${draft.attachments.map(a => `Attachment: ${a.name} (${a.size} bytes)`).join('\n')}`], { type: 'text/plain' });
    const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = 'conversation-draft.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const rejectedInput = (error: unknown) => error instanceof ApiError && ['draft_changed', 'conversation_changed', 'project_changed', 'attachment_changed', 'attachment_limit', 'empty_message', 'refinement_instructions', 'steer_project_changed', 'steer_attachments', 'steer_target_changed'].includes(error.code);
  const send = async () => {
    if (sourceCount > 10) { setContextDialog({ kind: 'sources' }); return; }
    if (!conversation) { await startAndSend(); return; }
    if (busy || active || journal.dirty || journal.saving || journal.conflict || filesPending) return;
    const key = `e3:submit:${draftId}`;
    const pending = readLocal<{ request: object; captured: Draft }>(key) ?? { request: { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, draftId, draftRevision: journal.revision, projectRevision: project?.revision ?? 0 }, captured: draft };
    if (!saveLocal(key, pending)) { setNotice('Free browser storage before sending. Your draft is kept.'); return; }
    setBusy(true); setNotice('');
    try {
      await request<AssistantOperation>('assistant/submit', pending.request);
      localStorage.removeItem(key);
      journal.change(value => {
        if (canonical(value) !== canonical(pending.captured)) return value;
        if (conversation.refineSource) return { ...value, text: '', attachments: value.attachments.filter(file => file.sha256 === conversation.refineSource!.sha256) };
        const { refineSource, ...kept } = value; return { ...kept, text: '', attachments: [], ...(kept.workMode === 'goal' ? { workMode: 'chat' as const } : {}) };
      });
      await controller.refresh();
    } catch (e) { if (rejectedInput(e)) localStorage.removeItem(key); keepError(e); }
    finally { setBusy(false); }
  };
  const steer = async () => {
    if (!conversation || !active || busy || journal.dirty || journal.saving || journal.conflict || filesPending || draft.attachments.length) return;
    const key = `e3:steer:${draftId}:${active.id}`;
    const pending = readLocal<{ request: object; captured: Draft }>(key) ?? { request: { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, targetOperationId: active.id, draftId, draftRevision: journal.revision, projectRevision: project?.revision ?? 0 }, captured: draft };
    if (!saveLocal(key, pending)) { setNotice('Free browser storage before sending direction.'); return; }
    setBusy(true); setNotice('');
    try { await request('assistant/steer', pending.request); localStorage.removeItem(key); journal.change(value => canonical(value) === canonical(pending.captured) ? { ...value, text: '' } : value); await controller.refresh(); }
    catch (e) { if (rejectedInput(e)) localStorage.removeItem(key); keepError(e); } finally { setBusy(false); }
  };
  const enqueue = async () => {
    if (sourceCount > 10) { setContextDialog({ kind: 'sources' }); return; }
    if (!conversation || busy || journal.dirty || journal.saving || journal.conflict || filesPending) return;
    const key = `e3:queue-capture:${draftId}`;
    const pending = readLocal<{ request: object; captured: Draft }>(key) ?? { request: { automatic: true, requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, draftId, draftRevision: journal.revision, projectRevision: project?.revision ?? 0 }, captured: draft };
    if (!saveLocal(key, pending)) { setNotice('Free browser storage before queuing this message. Your draft is kept.'); return; }
    setBusy(true); setNotice('');
    try {
      await request('assistant/queue', pending.request); localStorage.removeItem(key);
      journal.change(value => {
        if (canonical(value) !== canonical(pending.captured)) return value;
        if (conversation.refineSource) return { ...value, text: '', attachments: value.attachments.filter(file => file.sha256 === conversation.refineSource!.sha256) };
        const { refineSource, ...kept } = value; return { ...kept, text: '', attachments: [], ...(kept.workMode === 'goal' ? { workMode: 'chat' as const } : {}) };
      });
      await controller.refresh();
    } catch (reason) {
      if (reason instanceof ApiError && ['draft_changed', 'conversation_changed', 'project_changed', 'attachment_changed', 'attachment_limit', 'empty_message', 'refinement_instructions', 'queue_full'].includes(reason.code)) localStorage.removeItem(key);
      keepError(reason);
    } finally { setBusy(false); }
  };
  const cancel = async (reportFailure = false) => {
    if (!active) return;
    try { await request('assistant/cancel', { requestId: crypto.randomUUID(), epoch: snapshot.epoch, operationId: active.id }); await controller.refresh(); } catch (e) { keepError(e); if (reportFailure) throw e; }
  };
  const clearSubmittedDraft = async (entityId: string, expectedRevision: number, captured: Draft, submissionKey: string) => {
    const key = `${submissionKey}:clear`;
    const payload = { ...captured, text: '', attachments: [], ...(captured.workMode === 'goal' ? { workMode: 'chat' as const } : {}) };
    const command = readLocal<Command>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, kind: 'draft' as const, entityId, expectedRevision, payload };
    if (!saveLocal(key, command)) throw Error('Your message was submitted. Reopen the conversation to reconcile its retained draft.');
    await commit(command); localStorage.removeItem(key); localStorage.removeItem(submissionKey);
  };
  const startAndSend = async () => {
    if (busy || !ready || journal.dirty || journal.saving || journal.conflict || filesPending) return;
    const key = `e3:start-chat:${snapshot.deviceId}${controller.space === 'work' ? ':work' : ''}`;
    type Start = { requestId: string; copyRequestId: string; submitRequestId: string; space?: AssistantSpace; captured: Draft; preferences: ResponsePreferences; permissionMode: PermissionMode };
    const intent = readLocal<Start>(key) ?? { requestId: crypto.randomUUID(), copyRequestId: crypto.randomUUID(), submitRequestId: crypto.randomUUID(), space: controller.space, captured: draft, preferences, permissionMode: accessPreference };
    if (!saveLocal(key, intent)) { setNotice('Free browser storage before starting this conversation.'); return; }
    setBusy(true); setNotice('');
    let created: Conversation | undefined;
    try {
      const settings = intent.preferences, captured = intent.captured;
      const autoTitle = !captured.title.trim() || ['New conversation', 'New chat', 'New work'].includes(captured.title.trim());
      const title = autoTitle ? captured.text.trim().split('\n')[0].slice(0, 80) || captured.attachments[0]?.name || 'New chat' : captured.title.trim();
      created = await controller.create({ requestId: intent.requestId, space: intent.space ?? assistantSpace(captured), title, autoTitle, projectId: captured.projectId, permissionMode: intent.permissionMode ?? 'read-only', ...(settings.model ? { model: settings.model } : {}), ...(settings.thinking ? { thinking: settings.thinking } : {}), ...(settings.fastMode != null ? { fastMode: settings.fastMode } : {}) });
      const branchId = `draft:${snapshot.deviceId}:${created.id}`;
      const payload = { ...captured, space: assistantSpace(created), conversationId: created.id, projectId: created.projectId, title: created.title };
      const command = { requestId: intent.copyRequestId, epoch: snapshot.epoch, kind: 'draft' as const, entityId: branchId, expectedRevision: 0, payload };
      if (!saveLocal(`e3:conversation-copy:${branchId}`, command)) throw new Error('The new chat exists. Your original draft is still here. Free browser storage to continue.');
      const copy = await commit<Draft>(command); localStorage.removeItem(`e3:conversation-copy:${branchId}`);
      if (created.state !== 'ready') {
        // Only a definitive rejection without a native session releases this
        // creation intent. Unknown outcomes must keep their original identity.
        if (created.state === 'failed' && !created.nativeId) localStorage.removeItem(key);
        controller.select(created.id, assistantSpace(created));
        throw new Error(created.state === 'failed' ? 'Conversation setup was rejected. Your original draft is kept for a new chat.' : 'Conversation setup is unconfirmed. Check its status before sending.');
      }
      const requestInput = { requestId: intent.submitRequestId, epoch: snapshot.epoch, conversationId: created.id, conversationRevision: created.revision, draftId: branchId, draftRevision: copy.revision, projectRevision: snapshot.projects.find(p => p.id === created!.projectId)?.revision ?? 0 };
      const submitKey = `e3:submit:${branchId}`;
      if (!saveLocal(submitKey, { request: requestInput, captured: payload })) throw new Error('The new draft is saved. Free browser storage before sending.');
      await request<AssistantOperation>('assistant/submit', requestInput);
      await clearSubmittedDraft(branchId, copy.revision, payload, submitKey); localStorage.removeItem(key);
      journal.change(value => canonical(value) === canonical(captured) ? { ...value, text: '', attachments: [], ...(value.workMode === 'goal' ? { workMode: 'chat' as const } : {}) } : value);
      await refreshWorkspace(); await controller.refresh(); if (editorAlive.current) { controller.select(created.id, assistantSpace(created)); rail.closeMobile(); }
    } catch (e) { if (created && rejectedInput(e)) { localStorage.removeItem(`e3:submit:draft:${snapshot.deviceId}:${created.id}`); localStorage.removeItem(key); } if (editorAlive.current) keepError(e); if (created) { await refreshWorkspace(); await controller.refresh(); if (editorAlive.current) controller.select(created.id, assistantSpace(created)); } }
    finally { setBusy(false); }
  };
  const forkMessage = async (message: ConversationMessage, purpose: 'branch' | 'edit' | 'retry', text?: string) => {
    if (!conversation?.nativeId || active || busy) return;
    const key = `e3:fork:${conversation.id}:${message.id}:${purpose}`;
    const input = readLocal<object>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, conversationId: conversation.id, expectedRevision: conversation.revision, nativeId: conversation.nativeId, messageId: message.id, messageHash: message.textHash, purpose, ...(text !== undefined ? { text } : {}) };
    if (!saveLocal(key, input)) throw Error('Free browser storage before revising this message.');
    const branch = await request<Conversation>('assistant/conversation/fork', input);
    await controller.refresh(); await refreshWorkspace();
    if (branch.state !== 'ready') { if (editorAlive.current) controller.select(branch.id, assistantSpace(branch)); throw Error(branch.error ?? 'Branch creation is unconfirmed. Your revision is kept.'); }
    if (purpose !== 'branch') {
      const fresh = await fetchSnapshot(), draft = fresh.drafts.find(d => d.id === `draft:${fresh.deviceId}:${branch.id}`);
      if (fresh.epoch !== snapshot.epoch || !draft) throw Error('The branch draft needs to be reopened after workspace recovery.');
      const submitKey = `e3:submit:${draft.id}`;
      const kept = readLocal<{ request: object; captured: Draft }>(submitKey) ?? { request: { requestId: crypto.randomUUID(), epoch: fresh.epoch, conversationId: branch.id, conversationRevision: branch.revision, draftId: draft.id, draftRevision: draft.revision, projectRevision: fresh.projects.find(p => p.id === branch.projectId)?.revision ?? 0 }, captured: draft.value };
      if (!saveLocal(submitKey, kept)) throw Error('Your revision is saved. Free browser storage before sending.');
      await request('assistant/submit', kept.request);
      await clearSubmittedDraft(draft.id, draft.revision, kept.captured, submitKey);
      await refreshWorkspace(); await controller.refresh();
    }
    localStorage.removeItem(key); if (editorAlive.current) { controller.select(branch.id, assistantSpace(branch)); rail.closeMobile(); }
  };
  const create = async (title: string, model?: string) => {
    const key = `e3:new-conversation:${snapshot.deviceId}${controller.space === 'work' ? ':work' : ''}`;
    const intent = readLocal<{ space?: AssistantSpace; requestId: string; title: string; projectId: string | null; model?: string; thinking?: string; fastMode?: boolean | 'auto'; permissionMode?: PermissionMode }>(key) ?? { requestId: crypto.randomUUID(), space: controller.space, title, ...(title === 'Voice chat' ? { autoTitle: true } : {}), projectId: draft.projectId, model, thinking: preferences.thinking ?? undefined, fastMode: preferences.fastMode ?? undefined, permissionMode: accessPreference };
    if (!saveLocal(key, intent)) throw new Error('Free browser storage before creating a conversation.');
    const captured = draft;
    const created = await controller.create(intent);
    localStorage.removeItem(key);
    if (captured.text || captured.attachments.length) {
      const branchId = `draft:${snapshot.deviceId}:${created.id}`;
      const command = { requestId: crypto.randomUUID(), epoch: snapshot.epoch, kind: 'draft' as const, entityId: branchId, expectedRevision: 0, payload: { ...captured, space: assistantSpace(created), projectId: created.projectId, conversationId: created.id, title: created.title } };
      // Keep a recoverable copy before switching the editor, including an unknown copy response.
      if (!saveLocal(`e3:conversation-copy:${branchId}`, command)) throw new Error('The new conversation exists, but this browser cannot keep its draft copy. The original draft is unchanged.');
      controller.select(created.id, assistantSpace(created));
      await commit(command); localStorage.removeItem(`e3:conversation-copy:${branchId}`); await refreshWorkspace();
    } else controller.select(created.id, assistantSpace(created));
    return created;
  };
  const startVoice = async () => {
    if (busy || active || !ready || voiceState.phase !== 'idle') return;
    if (draft.attachments.length || filesPending) { setNotice('Send or remove the draft files before starting voice.'); return; }
    setBusy(true); setNotice('');
    try {
      if (journal.dirty) { await journal.flush(); if (journal.conflict) throw Error('Resolve the draft conflict before starting voice.'); }
      const target = conversation ?? await create('Voice chat', preferences.model ?? undefined);
      if (target.state !== 'ready') throw Error('Voice chat setup is not confirmed. Check its status before trying again.');
      await voice.start(target, snapshot.epoch, snapshot.projects.find(p => p.id === target.projectId)?.revision ?? 0);
    } catch (e) { keepError(e); } finally { setBusy(false); }
  };
  const refine = async (output: AssistantOutput) => {
    if (busy || !output.file) return;
    const source = output.file;
    const key = `e3:refine:${output.id}`;
    const intent = readLocal<{ space?: AssistantSpace; requestId: string; title: string; projectId: string | null; model?: string; refineSource?: Conversation['refineSource'] }>(key) ?? { requestId: crypto.randomUUID(), space: assistantSpace(controller.conversations.find(c => c.id === output.conversationId)), title: `Refine · ${output.name}`.slice(0, 150), projectId: output.projectId, refineSource: { outputId: output.id, version: output.version, sha256: source.sha256 }, ...(conversation?.model ? { model: conversation.model } : {}) };
    if (!saveLocal(key, intent)) { setNotice('Free browser storage before opening a refinement. Your existing draft is kept.'); return; }
    setBusy(true);
    try {
      const created = await controller.create(intent);
      const branchId = `draft:${snapshot.deviceId}:${created.id}`;
      const copyKey = `e3:conversation-copy:${branchId}`;
      const command = readLocal<Command>(copyKey) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, kind: 'draft' as const, entityId: branchId, expectedRevision: 0, payload: { ...emptyDraft, space: assistantSpace(created), title: created.title, projectId: created.projectId, conversationId: created.id, attachments: [source], refineSource: { outputId: output.id, version: output.version, sha256: source.sha256 } } };
      if (!saveLocal(copyKey, command)) throw new Error('The refinement conversation exists. Free browser storage to prepare its draft; your original draft is kept.');
      controller.select(created.id, assistantSpace(created));
      await commit(command); localStorage.removeItem(copyKey); localStorage.removeItem(key); await refreshWorkspace();
    } catch (e) { keepError(e); }
    finally { setBusy(false); }
  };
  const openVersion = (item: Conversation) => { setPreview(null); rail.closeMobile(); if (item.archived && item.nativeId) setReading({ epoch: snapshot.epoch, conversationId: item.id, nativeId: item.nativeId }); else { setReading(null); controller.select(item.id); } };
  const pins = (controller.pins ?? []).filter(p => p.pinned && p.conversationId === conversation?.id && p.nativeId === conversation?.nativeId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const messageOperation = (message: ConversationMessage) => operations.find(op => !!message.runId && op.nativeRunId === message.runId && op.nativeId === controller.history?.nativeId && !op.steerTarget);
  const conversationFiles = controller.outputs.filter(output => output.conversationId === conversation?.id && output.nativeId === conversation?.nativeId && output.state === 'ready' && output.file);
  const sourceFiles: ConversationSource[] = [...new Map([
    ...draft.attachments.map(file => ({ file, origin: 'Next message' })),
    ...(project?.value.attachments ?? []).map(file => ({ file, origin: 'Project source' })),
    ...operations.filter(op => op.nativeId === conversation?.nativeId).flatMap(op => op.context.attachments.map(file => ({ file, origin: 'Earlier message' }))),
  ].map(source => [`${source.file.id}:${source.file.sha256}`, source] as const).reverse()).values()].reverse();
  const openFiles = () => { setSidePanel({ kind: 'files' }); rail.closeMobile(); };
  const openChanges = controller.space === 'work' && conversation?.workspace ? () => { setSidePanel({ kind: 'changes' }); rail.closeMobile(); } : undefined;
  const openTeam = () => { setSidePanel({ kind: 'team' }); rail.closeMobile(); };
  const spaceSwitchDisabled = busy || !!journal.storageError || filesPending || dictation.phase !== 'idle' || !!dictation.preview;
  const switchSpace = (next: AssistantSpace) => { if (next !== controller.space) { void journal.flush(); controller.switchSpace(next); } };
  const addFiles = !conversation?.archived && !conversation?.deleted ? () => fileInput.current?.click() : undefined;
  const renderMessage = (message: ConversationMessage, index: number) => <article aria-label={`${message.role} message`} className={`chat-message message-${message.role} ${active?.nativeRunId && message.runId === active.nativeRunId ? 'message-progress' : ''} ${message.toolInfo && (message.role === 'tool' || !message.text.trim()) ? 'message-tool-compact' : ''}`} id={`message-${message.id}`} key={`${message.id}:${message.sequence ?? 0}:${index}`}>{(message.role === 'tool' && !message.toolInfo || message.role === 'system') && <div className="message-author">{message.role === 'tool' ? 'Tool activity' : 'Conversation note'}</div>}<HistoryTool message={message}/>{message.role !== 'tool' && <ReplyText text={message.authoredText ?? message.text} role={message.role}/>}{(message.role === 'user' || message.role === 'assistant' && !!message.text.trim() && message.runId !== active?.nativeRunId) && <MessageActions sources={messageOperation(message) ? () => setContextDialog({ kind: 'sources', operationId: messageOperation(message)!.id }) : undefined} remember={() => setMemorySeed({ text: message.authoredText ?? message.text, projectId: conversation!.projectId, source: { conversationId: conversation!.id, nativeId: conversation!.nativeId!, messageId: message.id, messageHash: message.textHash, role: message.role as 'user' | 'assistant' } })} message={message} previousUser={controller.history?.messages.slice(0, controller.history.messages.findIndex(m => m.id === message.id)).findLast(m => m.role === 'user')} conversation={conversation!} blocked={!!active || busy || callingHere || !!conversation?.pendingSettings} canFork={controller.connection.methods.includes('sessions.fork')} fork={forkMessage} pinned={pins.some(p => p.messageId === message.id && p.role === message.role)} pin={() => controller.pinMessage(conversation!, message, !pins.some(p => p.messageId === message.id && p.role === message.role)).then(() => undefined)} reading={readingAloud.messageId === message.id && ['speaking', 'paused'].includes(readingAloud.phase)} readAloud={() => readingAloud.messageId === message.id ? aloud.stop() : aloud.start(message.id, message.authoredText ?? message.text)} extras={message.role === 'assistant' && message.text.trim() ? <ReplyOutput open={openFile} message={message} conversation={conversation!} controller={controller} blocked={!!active || busy} refine={refine} contentActions={contentActions}/> : null}/>}{message.attachments.map(file => message.role === 'assistant' && file.artifactId ? <GeneratedOutput key={`${file.artifactId}:${message.textHash}`} open={openFile} attachment={file} message={message} conversation={conversation!} controller={controller} epoch={snapshot.epoch} blocked={!!active || busy} refine={refine} contentActions={contentActions}/> : <span className="source-link" key={file.artifactId}>{file.name}</span>)}</article>;
  const renderTranscriptMessage = (message: TranscriptMessage, index: number) => message.voiceParts || message.pendingVoice ? <VoiceMessage message={message} renderPart={renderMessage}/> : renderMessage(message, index);
  return <div className={`assistant-workspace ${sidePanel || activityOpen ? 'inspector-open' : ''}`}>
    <AssistantOrganizationRailFrame spaceSwitch={<AssistantSpaceSwitch value={controller.space} disabled={spaceSwitchDisabled} change={switchSpace}/>} newDraftLabel={controller.space === 'work' ? 'New work' : 'New chat'} open={organizationOpen} width={rail.width} setWidth={rail.setWidth} onToggle={toggleOrganization} onNewDraft={openNewDraft} onSearch={() => setSearchOpen(value => !value)}>
      <div className="organization original-organization-body">
      {searchOpen && <ConversationSearch snapshot={snapshot} controller={controller} open={target => { setReading(target); rail.closeMobile(); setSidePanel(null); }}/>}
      <div className="section-heading organization-heading"><span>Projects</span><button className="icon-button" aria-label="Create Project" onClick={newProject}><Plus size={16}/></button></div>
      {snapshot.projects.filter(item => assistantSpace(item.value) === controller.space).map(item => {
        const expanded = expandedProjects.includes(item.id), rows = allRows.filter(row => row.folder === 'active' && row.projectId === item.id);
        return <div className="assistant-project-group" key={item.id}>
          <SidebarRow title={item.value.name} rowClass="project-heading-row" expanded={expanded} controls={`project-chats-${item.id}`} open={() => toggleProject(item.id)} icon={<span className="project-row-icons"><ChevronDown className={`project-chevron ${expanded ? 'expanded' : ''}`} size={14}/><Folder size={16}/></span>}>{close => <button role="menuitem" onClick={() => { close(); editProject(item.id); }}><Settings2 size={17}/>Project settings</button>}</SidebarRow>
          {expanded && <div className="project-conversations" id={`project-chats-${item.id}`} role="group" aria-label={`${item.value.name} chats`}>{rows.map(renderRow)}{!rows.length && <p className="metadata organization-empty">{controller.space === 'work' ? 'No work yet.' : 'No chats yet.'}</p>}</div>}
        </div>;
      })}
      {folder === 'active' ? <div className="section-heading organization-heading recents-heading"><span>Recents</span></div> : <div className="archive-list-heading"><strong>{archive ? 'Archive' : 'Deleted'}</strong><button className="text-button" onClick={() => setFolder('active')}>{controller.space === 'work' ? 'Back to work' : 'Back to chats'}</button></div>}
      <div className="recent-conversations" aria-label={folder === 'active' ? 'Recents' : archive ? 'Archive' : 'Deleted'}>
      {recentRows.map(renderRow)}
      {!recentRows.length && <p className="metadata organization-empty">{folder === 'active' ? controller.space === 'work' ? 'Your recent work will appear here.' : 'Your recent chats will appear here.' : archive ? 'Archived conversations open read only.' : 'Deleted conversations will appear here.'}</p>}
      </div>
      </div>
    <div className="organization-footer"><button aria-pressed={archive} onClick={() => setFolder(value => value === 'archive' ? 'active' : 'archive')}><Archive size={17}/>Archive</button><button aria-pressed={folder === 'deleted'} onClick={() => setFolder(value => value === 'deleted' ? 'active' : 'deleted')}><Trash2 size={17}/>Deleted</button></div>
    </AssistantOrganizationRailFrame>
    {reading && <ConversationReader refreshWorkspace={refreshWorkspace} target={reading} snapshot={snapshot} controller={controller} close={() => setReading(null)} change={setReading} navigationCovered={organizationOpen && !rail.desktop} sidebarControls={<ChatTabs organizationOpen={organizationOpen} onToggleOrganization={toggleOrganization} onCreateConversation={openNewDraft}/>}/>}
    <div className={`conversation ${reading ? 'writing-kept' : ''}`} inert={organizationOpen && !rail.desktop}>
      <div className="conversation-header"><ChatTabs organizationOpen={organizationOpen} onToggleOrganization={toggleOrganization} onCreateConversation={openNewDraft} shortcutOwner={!reading}/><div className="conversation-title">{conversation ? <strong title={conversation.title}>{conversation.title}</strong> : <input aria-label="Conversation draft title" value={draft.title} onChange={e => journal.change(v => ({ ...v, title: e.target.value }))} maxLength={150}/>}<ConversationProjectControl snapshot={snapshot} draft={draft} conversation={conversation} blocked={!!journal.pending || !!journal.conflict || busy || !!active} choose={id => { journal.change(value => ({ ...value, projectId: id })); }} edit={editProject} settings={() => setDialog('settings')}/></div><ConversationHeaderTools blocked={!!active || busy || callingHere || !!conversation?.pendingSettings || conversation?.state !== 'ready' || !conversation?.nativeId} edit={changes => controller.edit(conversation!, changes)} projects={snapshot.projects} copyMessages={controller.history?.messages.length ? () => navigator.clipboard.writeText(controller.history!.messages.map(message => `${message.role}: ${message.authoredText ?? message.text}`).join('\n\n')) : undefined} conversation={conversation} conversations={controller.conversations} pins={pins} openVersion={openVersion} openPin={pin => { setReading({ epoch: snapshot.epoch, conversationId: pin.conversationId, nativeId: pin.nativeId, messageId: pin.messageId, messageHash: pin.messageHash, role: pin.role }); rail.closeMobile(); setSidePanel(null); }} removePin={pin => controller.pinMessage(conversation!, { id: pin.messageId, role: pin.role, textHash: pin.messageHash }, false).then(() => undefined)} settings={() => setDialog('settings')} sources={sourceCount || project || controller.memory?.entries.length ? () => setContextDialog({ kind: 'sources' }) : undefined} memory={() => setContextDialog({ kind: 'memory' })} exportDraft={exportDraft} runs={operations.length ? () => setContextDialog({ kind: 'history' }) : undefined} technical={conversation ? () => setContextDialog({ kind: 'technical' }) : undefined} queue={conversation && controller.queue?.some(q => q.conversationId === conversation.id && q.state !== 'submitted') ? () => setQueueExpanded(true) : undefined} summary={{ space: controller.space, conversation, outputs: conversationFiles, sourceFiles, openFile, openFiles, addFiles, changes: openChanges, projectSettings: project ? () => editProject(project.id) : undefined, projectFolder: project?.value.workspace?.folder }} panelOpen={!!sidePanel || activityOpen} togglePanel={() => { if (sidePanel || activityOpen) closePanel(); else { workspace.dispatch({ type: 'visibility', visible: true }); rail.closeMobile(); } }}/></div>
<div className="conversation-scroll-region"><div className="conversation-reading" ref={setReadingParent} tabIndex={0} aria-label="Conversation history">

        {(notice || controller.error) && <div className="notice warning" role="alert"><span>{notice || controller.error}</span><button className="text-button" onClick={() => { setNotice(''); controller.setError(''); }}>Dismiss</button></div>}
        {conversation?.pendingSettings && <div className="notice warning settings-recovery"><span>{conversation.pendingSettings.permissionMode ? `${accessLabels[conversation.pendingSettings.permissionMode]} hasn’t been confirmed.` : 'A settings change hasn’t been confirmed.'} Sending is paused until this is resolved.</span><div className="button-row"><button disabled={busy} onClick={async () => { setBusy(true); try { await controller.checkStatus(); } finally { setBusy(false); } }}>Check status</button>{(['retry', 'use-current'] as const).map(action => <button key={action} disabled={busy || !!active || callingHere} onClick={async () => { setBusy(true); setNotice(''); try { await controller.recoverSettings(conversation, action); } catch (e) { keepError(e); } finally { setBusy(false); } }}>{action === 'retry' ? 'Retry change' : 'Keep current settings'}</button>)}</div></div>}
        {preview ? <article className="draft-preview"><span className="eyebrow">Saved draft · read only</span><h2>{preview.value.title}</h2><p className="preserve-lines">{preview.value.text || 'This draft contains attachments.'}</p>{preview.value.attachments.map(a => <a className="source-link" key={a.id} href={`/api/attachments/${a.id}`}><File size={16}/>{a.name}</a>)}<button onClick={() => append(preview.value)}>Append to my draft</button><button className="quiet" onClick={() => setPreview(null)}>Back to my draft</button></article> : conversation ? <div className="chat-transcript" aria-label="Conversation messages">
          {controller.loading && !controller.history && <LoadingRing label="Loading your conversation…"/>}
          {conversation.state === 'failed' && !conversation.nativeId ? <div className="history-status" role="status"><div><strong>Conversation setup was rejected</strong><p>{conversation.error} Your original draft and this copy are kept.</p></div><button onClick={openNewDraft}>Return to original draft</button></div> : controller.historyError && <div className="history-status" role="status"><div><strong>{controller.history ? 'Showing the saved conversation' : 'Conversation history is unavailable'}</strong><p>{controller.history ? controller.history.retained ? (controller.history.retained.complete ? 'The saved transcript is available below. Reconnect its original Assistant to check for newer messages.' : 'Only the captured part of this conversation is available below. Its original Assistant archive and your draft are kept.') : 'Newer messages could not be checked. Your saved messages and draft remain here.' : 'This conversation could not be loaded. Your draft is still available below.'}</p></div><button disabled={controller.loading} onClick={() => void controller.loadHistory(conversation.id)}><RotateCcw size={16}/>{controller.loading ? 'Checking…' : 'Retry'}</button>{controller.history?.messages.length ? <button disabled={busy || !!active || callingHere} onClick={() => setContinueSaved(true)}>Continue in a fresh chat</button> : null}</div>}
          {controller.history?.hasMore && <button className="quiet" disabled={controller.loading} onClick={() => { transcript.current?.keepReadingPosition(); void controller.loadHistory(conversation.id, { offset: controller.history?.nextOffset }); }}>Earlier messages</button>}
          {readingParent && controller.history && <VirtualTranscript ref={transcript} key={`${conversation.id}:${conversation.nativeId}`} parent={readingParent} scroll={scroll} history={controller.history} cacheKey={transcriptCacheKey(snapshot.epoch, conversation)} positionKey={transcriptPositionKey(snapshot.epoch, snapshot.deviceId, conversation)} messages={groupVoiceMessages(voiceMessages.filter(m => !(active?.nativeRunId && m.runId === active.nativeRunId && (!!m.toolInfo && !m.text.trim() || m.role === 'tool' || m.role === 'assistant' && m.text === active.text)) && !(m.toolInfo?.id && active?.tools?.some(tool => tool.id === m.toolInfo?.id))))} render={renderTranscriptMessage} footer={<>
{controller.history && !voiceMessages.length && !controller.loading && !controller.historyError && !active && <Empty title={conversation.state === 'ready' ? 'A clear place to think.' : conversation.state === 'failed' ? 'Conversation setup was rejected.' : 'Waiting for OpenClaw confirmation.'}>{conversation.state === 'ready' ? 'Your first message will use this conversation and its selected Project.' : conversation.error ?? 'Use Check status to find the original native session. It will not be created again automatically.'}</Empty>}
          {active && !controller.history?.hasNewer && <article className="chat-message message-assistant live-message"><div className="working-status" role="status"><span className="working-dot" aria-hidden="true"/>{active.state === 'unknown' ? 'Progress not confirmed' : active.cancelRequested ? 'Stopping…' : active.state === 'running' ? 'Working…' : 'Starting…'}</div><ToolActivity operation={active}/>{active.text && <ReplyText text={active.text} role="assistant" streaming/>}{active.error && <p>{active.error}</p>}{active.state === 'unknown' && <button className="text-button" onClick={() => void controller.checkStatus()}>Check status</button>}</article>}
          {latest && ['failed', 'cancelled'].includes(latest.state) && <div className="notice warning"><span>{latest.error ?? 'The run stopped. Its submitted input is kept.'}</span><button onClick={() => setContextDialog({ kind: 'history' })}>Review input</button></div>}
          {controller.history?.hasNewer && <button className="quiet transcript-newer" disabled={controller.loading || controller.history.offset === undefined} onClick={() => { transcript.current?.keepReadingPosition(); void controller.loadHistory(conversation.id, { newer: true, offset: Math.max(0, (controller.history?.offset ?? 0) - 50) }); }}>Newer messages</button>}
          {['unknown', 'creating'].includes(conversation.state) && <button onClick={() => void controller.checkStatus()}>Check status</button>}</>}/>}
          {!controller.history && voiceTranscript}{!controller.history && active && <p className="metadata" role="status">Working…</p>}
        </div> : <div className="assistant-welcome"><NovaAssistantMark choice={appIcon} width="92" height="92" alt="Nova at rest"/><h1>{controller.space === 'work' ? 'What would you like to get done?' : 'What’s on your mind?'}</h1><p>{controller.space === 'work' ? 'Bring a task. We’ll work through it together.' : 'Bring a question, a plan, or an unfinished thought.'}</p><div className="suggestions">{controller.space==='work'?<><button onClick={newProject}>Open repository</button><button onClick={openTeam}>Team work</button><button onClick={()=>setSidePanel({kind:'browser'})}>Host browser</button></>:<><button onClick={() => journal.change(v => ({ ...v, text: `${v.text}${v.text ? '\n\n' : ''}Help me plan my day. The things I want to move forward are: ` }))}>Plan my day</button><button onClick={() => journal.change(v => ({ ...v, text: `${v.text}${v.text ? '\n\n' : ''}Help me think through this idea: ` }))}>Think through an idea</button></>}</div></div>}
      </div>
      {(showLatest || controller.history?.hasNewer || controller.historyError) && conversation && <button className="jump-to-latest" disabled={controller.loading} onClick={() => { scrollToLatest(); void controller.loadHistory(conversation.id, { latest: true }); }}>↓ Latest</button>}</div>
      {conversation?.archived ? <div className="archive-footer"><Archive size={19}/><span>This archive is read only. Your unsent draft is kept.</span><button onClick={() => void controller.edit(conversation, conversation.deleted ? { deleted: false } : { archived: false }).catch(keepError)}>Restore conversation</button></div> : <div className="composer-region">{!reading && <ModuleActionTray conversationId={conversation?.id} epoch={snapshot.epoch} refreshWorkspace={refreshWorkspace}/>} {!reading && <ApprovalTray controller={controller} conversationId={conversation?.id} epoch={snapshot.epoch} working={!!active}/>} {!reading && readingAloud.phase !== 'idle' && <div className="read-aloud-controls" role="group" aria-label="Read aloud controls"><span>{readingAloud.error ?? (readingAloud.phase === 'paused' ? 'Reading paused' : 'Reading reply')}</span>{readingAloud.phase !== 'error' && <button className="text-button" onClick={aloud.toggle}>{readingAloud.phase === 'paused' ? 'Resume reading' : 'Pause reading'}</button>}<button className="icon-button" aria-label={readingAloud.phase === 'error' ? 'Dismiss read aloud notice' : 'Stop reading'} onClick={aloud.stop}><X size={17}/></button></div>}{!reading && <VoicePanel appIcon={appIcon} conversationId={conversation?.id} controller={voice} openConversation={id => { setReading(null); setPreview(null); controller.select(id); }}/> }
        {conversation && (queueExpanded || controller.queue?.some(q => q.conversationId === conversation.id && q.state === 'paused')) && <details className="composer-queue" open={queueExpanded} onToggle={e => setQueueExpanded(e.currentTarget.open)}><summary>{(controller.queue ?? []).filter(q => q.conversationId === conversation.id && q.state === 'paused').length} queued</summary><MessageQueue controller={controller} conversationId={conversation.id} epoch={snapshot.epoch} blocked={!!active || callingHere || !!conversation.pendingSettings} copy={append}/></details>}
        {operations.some(op => op.steerTarget && !['completed', 'failed', 'cancelled'].includes(op.state)) && <div className="steering-status" role="status">{operations.some(op => op.steerTarget && op.state === 'unknown') ? 'Direction delivery is unconfirmed.' : 'Additional direction submitted.'}<button className="text-button" onClick={() => void controller.checkStatus()}>Check status</button></div>}
        {journal.conflict && <Conflict name="Draft" message={journal.conflict.message} current={journal.conflict.current?.value.text} reapplyLabel={journal.conflict.code === 'draft_removed' ? 'Keep as new draft' : undefined} reapply={journal.reapply} discard={journal.discard}/>}
        {!reading && <div className="composer-progress"><StepsPill key={planOperation?.id} plan={currentPlan} operation={planOperation}/>{!reading && conversation?.nativeId && controller.connection.methods.includes('sessions.goal.update') && <ChatGoalControl key={conversation.id} conversation={conversation} epoch={snapshot.epoch} refresh={controller.refresh}/>}</div>}
        <div className="composer" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void attachments.add(event.dataTransfer.files); } }}>
          {((draft.workMode && draft.workMode !== 'chat') || active && draft.text.trim()) && <div className="composer-mode-row">{draft.workMode && draft.workMode !== 'chat' && <button className="work-mode-chip" aria-label={`Turn off ${draft.workMode} mode`} title="Return to Chat" onClick={() => journal.change(value => ({ ...value, workMode: 'chat' }))}>{workModes.find(mode => mode.id === draft.workMode)?.label}<X size={13}/></button>}{active && draft.text.trim() && <button className="text-button steer-reply" disabled={draft.workMode === 'goal' || busy || journal.dirty || journal.saving || !!journal.conflict || !!draft.attachments.length || filesPending || active.cancelRequested || !active.nativeRunId} onClick={() => void steer()}>Steer current reply</button>}</div>}
          <label className="sr-only" htmlFor="assistant-draft">Message draft</label><textarea rows={1} id="assistant-draft" ref={textarea} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void attachments.add(event.clipboardData.files); } }} value={draft.text} maxLength={100000} placeholder={draft.refineSource ? 'What would you like to change in this output?' : controller.space === 'work' ? 'Describe what you want to get done…' : 'Write what’s on your mind…'} onChange={e => journal.change(v => ({ ...v, text: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); const button = textarea.current?.closest('.composer')?.querySelector<HTMLButtonElement>('.send-button'); if (button && !button.disabled && button.getAttribute('aria-label') !== 'Stop reply') button.click(); } }}/>
          {sourceCount > 10 && <p className="field-error" role="alert">{sourceCount} files selected; up to 10 can accompany a message. <button type="button" className="text-button" onClick={() => setContextDialog({ kind: 'sources' })}>Review sources</button></p>}
          <div className="attachment-list">{draft.attachments.map(file => <div className="attachment" key={file.id}><File size={17}/><button type="button" className="text-button" onClick={() => openFile(file)}>{file.name}</button><span className="metadata">{Math.max(1, Math.ceil(file.size / 1024))} KB</span><Check size={15} className="success-text"/><button className="icon-button" aria-label={`Remove ${file.name}`} onClick={() => journal.change(v => { const next = { ...v, attachments: v.attachments.filter(a => a.id !== file.id) }; if (next.refineSource?.sha256 === file.sha256) delete next.refineSource; return next; })}><X size={15}/></button></div>)}{attachments.pending.map(file => <div className="pending-file" key={file.id}><strong>{file.name}</strong><span>{attachments.errors[file.id] || 'Kept on this device · uploading…'}</span>{attachments.errors[file.id] && <div className="button-row"><button onClick={() => void attachments.retry(file)}>Retry upload</button><button onClick={() => void attachments.remove(file.id)}>Remove</button></div>}</div>)}</div>
          {attachments.staging && <p className="metadata" role="status">Preparing Files…</p>}
          {attachments.notice && <p className="field-error" role="alert">{attachments.notice}</p>}
          {(dictation.phase !== 'idle' || dictation.preview || dictation.error) && <div className="dictation-preview" role="status"><span>{dictation.phase === 'listening' ? 'Listening…' : dictation.phase === 'connecting' ? 'Connecting dictation…' : dictation.phase === 'finishing' ? 'Finishing dictation…' : 'Dictation'}</span>{dictation.preview && <p>{dictation.preview}</p>}{dictation.error && <p>{dictation.error}</p>}{dictation.phase === 'idle' && dictation.preview && <div className="button-row"><button onClick={dictation.useText}>Use transcript</button><button onClick={dictation.discard}>Discard transcript</button></div>}</div>}
          {!journal.conflict && (journal.storageError || journal.networkError) && <div className="composer-save-error" role="status"><span>{journal.storageError ? 'Draft is only kept in this window. Browser storage is full.' : 'Draft saved on this device. Waiting for connection.'}</span><button className="text-button" disabled={journal.saving} onClick={() => void journal.flush()}>Retry save</button></div>}
          <div className="composer-actions"><div className="button-row"><input ref={fileInput} className="sr-only" type="file" multiple aria-label="Attach files" tabIndex={-1} onChange={e => { void attachments.add(e.target.files); e.target.value = ''; }}/>
            <ComposerMenu kind="menu" label="Add to message" icon={<Plus size={20}/>}>
              {close => <>
                <button role="menuitem" onClick={() => { close(); fileInput.current?.click(); }}><Paperclip size={18}/><span>Attachments</span></button>
                {workModes.filter(mode => mode.id !== 'chat').map(mode => { const Icon = modeIcons[mode.id]; return <button role="menuitemradio" key={mode.id} className="work-mode-option" aria-checked={(draft.workMode ?? 'chat') === mode.id} onClick={() => { journal.change(value => ({ ...value, workMode: mode.id })); close(); }}><Icon size={18}/><span>{mode.label}</span>{(draft.workMode ?? 'chat') === mode.id && <Check size={16}/>}</button>; })}
              </>}

            </ComposerMenu><ComposerMenu label="Access / permissions" icon={<Shield size={20}/>} text={actualAccess ? accessLabels[actualAccess] : 'Access'} className="access-control">{() => <AccessDetails conversation={conversation} preference={accessPreference} blocked={!!active || busy || callingHere || !!conversation?.pendingSettings} save={async mode => { if (conversation) return controller.edit(conversation, { permissionMode: mode }); if (!saveLocal(accessKey, mode)) throw Error('The access preference could not be saved.'); setAccessPreference(mode); }}/>}</ComposerMenu></div><div className="composer-tools-right">
            <ComposerMenu label="Response settings" icon={<Settings2 size={20}/>} text={<>{responseName}{response.thinking && <em>{effortLabel(response.thinking)}</em>}<ChevronDown size={15}/></>} className="response-control" align="right">{() => <ResponseControls models={controller.models} modelStatus={controller.modelStatus} retryModels={controller.retryModels} value={response} blocked={!!active || callingHere || !!conversation?.pendingSettings} save={async next => { if (conversation) return controller.edit(conversation, next); if (!saveLocal(preferencesKey, next)) throw Error('The preferences could not be saved.'); setPreferences(next); }}/>}</ComposerMenu><button className={`composer-control-button ${dictation.phase !== 'idle' ? 'dictation-active' : ''}`} aria-label={dictation.phase === 'idle' ? 'Dictate a message' : 'Stop dictation'} title={dictation.phase === 'idle' ? 'Dictate a message' : 'Stop dictation'} disabled={callingHere || !ready || dictation.phase === 'finishing' || dictation.phase === 'connecting' || (dictation.phase === 'idle' && !!dictation.preview)} onClick={() => void (dictation.phase === 'idle' ? dictation.start() : dictation.stop())}>{dictation.phase === 'idle' ? <Mic size={20}/> : <Square size={20}/>}</button><button className="composer-control-button" aria-label="Start voice call" title="Start voice call" disabled={!ready || busy || !!active || callingHere || filesPending || dictation.phase !== 'idle' || !!journal.conflict} onClick={() => void startVoice()}><AudioLines size={20}/></button><button className="primary send-button" aria-label={active ? draft.text.trim() || draft.attachments.length ? 'Queue message' : 'Stop reply' : 'Send message'} title={callingHere ? 'End the voice call to send your draft' : active ? draft.text.trim() || draft.attachments.length ? 'Queue message' : 'Stop reply' : 'Send message'} onClick={() => void (active ? draft.text.trim() || draft.attachments.length ? enqueue() : cancel() : send())} disabled={active && !draft.text.trim() && !draft.attachments.length ? !active.nativeRunId || !!active.cancelRequested : !ready || busy || dictation.phase !== 'idle' || (!!conversation && conversation.state !== 'ready') || callingHere || !!conversation?.pendingSettings || !!journal.conflict || journal.dirty || journal.saving || filesPending || (!draft.text.trim() && (!!conversation?.refineSource || !draft.attachments.length))}>{active && !draft.text.trim() && !draft.attachments.length ? <Square size={19}/> : active ? <Queue size={19}/> : <ArrowUp size={19}/>}</button></div></div>
        </div>{!ready && <p className="composer-footnote">{controller.statusRead === 'loading' ? <span role="status">Checking the Assistant connection…</span> : controller.statusRead === 'error' ? <><span role="status">Chat updates paused · your draft is kept.</span><button type="button" className="text-button" onClick={() => void controller.refresh()}>Retry</button></> : <><span>Assistant disconnected · your draft is kept.</span><button type="button" className="text-button" onClick={openSettings}>Connect</button></>}</p>}
      </div>}
    </div>
    {(reading || conversation?.archived) && <VoicePanel appIcon={appIcon} floating controller={voice} openConversation={id => { setReading(null); controller.select(id); }}/> }
    {memorySeed && <Suspense fallback={<LoadingRing label="Opening memory…"/>}><MemoryEditor key={`${snapshot.epoch}:${memorySeed.source.messageId}`} snapshot={snapshot} seed={memorySeed} refresh={controller.refresh} close={() => setMemorySeed(null)}/></Suspense>}
    {continueSaved && conversation && <Suspense fallback={<LoadingRing label="Opening saved transcript…"/>}><ContinueSavedConversation conversationId={conversation.id} snapshot={snapshot} controller={controller} refreshWorkspace={refreshWorkspace} close={() => setContinueSaved(false)}/></Suspense>}
    {!reading && <AssistantActivityPanel key={conversation?.id ?? controller.space} operation={planOperation} open={activityOpen} container={activityContainer} available={setHasLiveView} show={() => setSidePanel({ kind: 'live' })} close={closePanel} stop={() => cancel(true)}/>}
    {!reading && workspace.opened && <AssistantSidePanel tabs={workspace.tabs} active={workspace.active} visible={workspace.visible} expanded={workspace.expanded} select={id => workspace.dispatch({ type: 'select', id })} closeTab={id => workspace.dispatch({ type: 'close', id })} addTab={() => setSidePanel({ kind: 'home' })} expand={() => workspace.dispatch({ type: 'expand', expanded: !workspace.expanded })} close={closePanel}>
      {workspace.tabs.map(tab => { const view = tab.view; const output = view.kind === 'file' ? conversationFiles.find(item => item.id === view.outputId && item.version === view.outputVersion) : undefined; return <section key={tab.id} className="workspace-tab-content" role="tabpanel" id={`workspace-view-${tab.id}`} aria-labelledby={`workspace-tab-${tab.id}`} hidden={workspace.active !== tab.id}>
        {view.kind === 'home' && <div className="assistant-workspace-launcher"><button onClick={openTeam}><Folder size={20}/>Team work</button><button onClick={()=>setSidePanel({kind:"browser"})}><Device size={20}/>Browser</button>{openChanges && <button onClick={openChanges}><List size={20}/>Review</button>}{hasLiveView && <button onClick={() => setSidePanel({ kind: 'live' })}><Device size={20}/>Live tool view</button>}<button onClick={openFiles}><Folder size={20}/>Files</button></div>}
        {view.kind === 'files' && <ConversationFiles outputs={conversationFiles} sourceFiles={sourceFiles} openFile={openFile} addFiles={addFiles}/>}
        {view.kind === "team" && <Suspense fallback={<LoadingRing label="Opening team work…"/>}><TeamWorkPanel snapshot={snapshot} projectId={project?.value.space === 'work' && project.value.workspace?.environment === 'local' ? project.id : undefined} openConversation={id=>controller.select(id,"work")} active={workspace.visible && workspace.active===tab.id}/></Suspense>}
        {view.kind === "browser" && <Suspense fallback={<LoadingRing label="Opening browser…"/>}><HostBrowserPanel epoch={snapshot.epoch} active={workspace.visible && workspace.active===tab.id}/></Suspense>}
        {view.kind === 'changes' && conversation && <Suspense fallback={<LoadingRing label="Opening changes…"/>}><WorkProjectChanges conversation={conversation} epoch={snapshot.epoch}/></Suspense>}
        {view.kind === 'live' && <div ref={setActivityContainer} className="workspace-live-container"/>}
        {view.kind === 'file' && <><div className="workspace-file-toolbar"><span title={view.file.name}>{view.file.name}</span><a className="icon-button output-download" aria-label="Download file" title="Download file" href={`/api/attachments/${view.file.id}`}><Download size={18}/></a></div><Suspense fallback={<LoadingRing label="Opening file…"/>}><AssistantFilePreview file={view.file}/></Suspense>{output && <div className="button-row"><button disabled={!!active || !!conversation?.archived} onClick={() => void refine(output)}>Refine</button><UseOutputInContent output={output} {...contentActions}/></div>}</>}
      </section>; })}
    </AssistantSidePanel>}
    {contextDialog && <Dialog title={contextDialog.kind === 'sources' ? contextDialog.operationId ? 'Sources used for this reply' : 'Message context' : contextDialog.kind === 'memory' ? 'Saved memories' : contextDialog.kind === 'history' ? 'Run history' : 'Technical details'} close={() => setContextDialog(null)}>
      {contextDialog.kind === 'sources' && <ConversationSources operationId={contextDialog.operationId} memory={controller.memory} operations={operations} conversation={conversation} snapshot={snapshot} draft={draft} editProject={id => { setContextDialog(null); editProject(id); }}/>}
      {contextDialog.kind === 'memory' && <Suspense fallback={<LoadingRing label="Opening memories…"/>}><MemoryPanel memory={controller.memory} snapshot={snapshot} refresh={controller.refresh} openSource={target => { setContextDialog(null); setReading(target); }}/></Suspense>}
      {contextDialog.kind === 'history' && <>{operations.map(op => <details key={op.id}><summary>{op.steerTarget ? 'Direction' : 'Reply'} · {op.state} · {formatSaved(op.createdAt)}</summary><p className="preserve-lines">{op.input}</p>{op.error && <p className="field-error">{op.error}</p>}<button onClick={() => setContextDialog({ kind: 'sources', operationId: op.id })}>View captured sources</button>{!['completed', 'failed', 'cancelled'].includes(op.state) && <button onClick={() => void controller.checkStatus(op.conversationId)}>Check status</button>}</details>)}{controller.questions?.items.filter(item => item.conversationId === conversation?.id).map(item => <details key={item.id}><summary>Question · {item.snapshot.status}</summary><QuestionCard item={item} epoch={snapshot.epoch} ready={controller.questions?.state === 'ready'} refresh={controller.refresh} readOnly={!!conversation?.archived}/></details>)}{controller.approvals?.items.filter(item => item.conversationId === conversation?.id).map(item => <details key={item.id}><summary>Approval · {item.snapshot.status}</summary><ApprovalCard item={item} epoch={snapshot.epoch} ready={controller.approvals?.state === 'ready'} refresh={controller.refresh} readOnly={!!conversation?.archived}/></details>)}</>}
      {contextDialog.kind === 'technical' && conversation && <><p>Conversation: {conversation.id}</p><p>Native session: {conversation.nativeId ?? 'Unconfirmed'}</p><p>Revision: {conversation.revision}</p><p>Model: {operations.find(op => op.effectiveModel)?.effectiveModel ?? conversation.model ?? 'Host default'}</p></>}
    </Dialog>}
    {dialog === 'settings' && (managedId ? controller.conversations.find(c => c.id === managedId) : conversation) && <ConversationSettings snapshot={snapshot} controller={controller} conversation={(managedId ? controller.conversations.find(c => c.id === managedId) : conversation)!} close={() => { setManagedId(null); setDialog(null); }}/>}
  </div>;
}
function ReplyOutput({ open, message, conversation, controller, blocked, refine, contentActions }: { open: (file: Attachment, output?: AssistantOutput) => void; contentActions: ContentOutputActions; message: ConversationMessage; conversation: Conversation; controller: AssistantController; blocked: boolean; refine: (output: AssistantOutput) => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const output = controller.outputs.find(o => !o.artifactId && o.conversationId === conversation.id && o.messageId === message.id && o.messageHash === message.textHash && o.state === 'ready');
  const save = async () => { setBusy(true); setError(''); try { await controller.saveOutput(conversation, message, conversation.title); } catch (e) { setError(e instanceof Error ? e.message : 'The output save was not confirmed.'); } finally { setBusy(false); } };
  return <div className="reply-output">{output?.file ? <><button className="text-button" onClick={() => open(output.file!, output)}><File size={16}/>{output.name}<span>v{output.version}</span></button><button disabled={busy || blocked || conversation.archived} onClick={() => void refine(output)}>Refine</button><UseOutputInContent key={`${contentActions.snapshot.epoch}:${output.id}:${output.version}`} output={output} {...contentActions}/><span className="metadata">Original version kept</span></> : <button className="text-button" disabled={busy || blocked} onClick={() => void save()}><Download size={15}/>{busy ? 'Saving document…' : 'Save as document'}</button>}{error && <p className="field-error" role="alert">{error}</p>}</div>;
}
function ConversationSettings({ snapshot, controller, conversation, close }: { snapshot: Snapshot; controller: AssistantController; conversation: Conversation; close: () => void }) {
  const [title, setTitle] = useState(conversation.title), [projectId, setProjectId] = useState(conversation.projectId ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = (changes: Parameters<AssistantController['edit']>[1] = {}) => { setBusy(true); void controller.edit(conversation, { title, projectId: projectId || null, ...changes }).then(close).catch(e => setError(e.message)).finally(() => setBusy(false)); };
  return <Dialog title="Conversation options" close={close}><form onSubmit={e => { e.preventDefault(); save(); }}><fieldset disabled={busy || !!conversation.pendingSettings}><label>Name<input required value={title} maxLength={150} onChange={e => setTitle(e.target.value)}/></label><label>Project<select disabled={assistantSpace(conversation) === 'work'} value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">No Project</option>{snapshot.projects.filter(p => assistantSpace(p.value) === assistantSpace(conversation)).map(p => <option key={p.id} value={p.id}>{p.value.name}</option>)}</select></label><div className="button-row"><button type="button" onClick={() => save({ pinned: !conversation.pinned })}>{conversation.pinned ? 'Unpin' : 'Pin'}</button><button type="button" onClick={() => save({ unread: !conversation.unread })}>{conversation.unread ? 'Mark read' : 'Mark unread'}</button></div></fieldset>{error && <p className="field-error" role="alert">{error}</p>}<div className="dialog-footer"><button type="button" disabled={busy || !!conversation.pendingSettings} onClick={() => save(conversation.deleted ? { deleted: false } : { archived: !conversation.archived })}><Archive size={17}/>{conversation.archived ? 'Restore' : 'Archive'}</button>{!conversation.deleted && <button type="button" disabled={busy || !!conversation.pendingSettings} onClick={() => save({ deleted: true })}><Trash2 size={17}/>Move to Deleted</button>}<button className="primary" disabled={busy || !!conversation.pendingSettings}>{busy ? 'Saving…' : 'Save changes'}</button></div></form></Dialog>;
}
