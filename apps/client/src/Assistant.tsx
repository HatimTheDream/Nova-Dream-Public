import { SavedDraftArticle } from './SavedDraftArticle';
import { AssistantGroup } from './AssistantGroup';
import { useAssistantGroups } from './useAssistantGroups';
import type { GroupViewTarget } from './assistant-group-view';
import { DirectAgentStatus, DirectAgentAccount } from './DirectAgentChat';
import { directChatStorage, hasKeptDirectSubmit, observedDirectSubmit } from './direct-agent-chat';
import { retainedWindowId } from './useWorkspace';
import { matchesSearchQuery, type SearchQueryRequest, type LocalSearchDraft } from './search-workspace';
import { ConversationCleanupPanel } from './ConversationCleanupPanel';
import { TranscriptIdentity, MessageWriting, messageSpeaker } from './TranscriptIdentity';
import type { AppDestination } from '../../../packages/domain/app-actions';
import { withQuestionReceipts } from './question-transcript';
import { QuestionReceipts } from './QuestionReceipts';
import { activeProjects, projectIsDeleted } from '../../../packages/domain/project-organization';
import { ProjectManager } from './ProjectManager';
import { mayLeaveRecordDrafts } from './record-draft-navigation';
import type { ProjectManagerRequest } from './project-manager-view';
import { ProjectOptions } from './ProjectOptions';
import { ProjectOrganizationDialog } from './ProjectOrganizationDialog';
import { releaseRejectedProjectRequest } from './project-admission';
import { LoadingRing } from './ModuleLoading';
import { AssistantActivityPanel } from './AssistantActivityPanel';
import { assistantSpace, spaceDraftId, type AssistantSpace } from '../../../packages/domain/assistant-space';
import { AssistantSpaceSwitch } from './AssistantSpaceSwitch';
import { ChatGoalControl } from './ChatGoal';
import type { MemorySeed } from './AssistantMemory';
import { ModuleActionTray } from './ModuleActionTray';
import { ApprovalTray } from './ApprovalTray';
import { HistoryTool, StepsPill } from './ToolActivity';
import { WorkTranscript } from './WorkTranscript';
import { groupWorkMessages, hasVisibleOperationText, unrepresentedWorkTools } from './work-transcript';
import { ReadAloud } from './read-aloud';
import { ReadAloudControls } from './ReadAloudControls';
import { PlanReviewCard, PlanReviewDecision, PlanReviewDocument } from './PlanReviewCard';
import { usePlanReview } from './plan-review-state';
import { ConversationHeaderTools } from './ConversationHeaderTools';
import { assistantAttachmentAccept, assistantAttachmentsIssue } from '../../../packages/domain/assistant-attachments';
import { workModes } from '../../../packages/domain/work-mode';
import { consumeDraftMode, useComposerMode } from './useComposerMode';
import { UseOutputInContent, type ContentOutputActions } from './ContentOutputs';
import { ReplyText, SavedMessageText } from './ReplyText';
import { ConversationSearch } from './ConversationSearch';
import { ConversationReader } from './ConversationReader';
import type { BrowseTarget } from '../../../packages/domain/search';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { lazy } from './preload-lazy';
import { Archive, ArrowDown, ArrowUp, Check, Download, File, Folder, MessageSquare, Mic, Paperclip, PanelLeft, Device, PanelRight, Plus, RotateCcw, Save, Settings2, Square, X, Shield, AudioLines, Trash2, MoreHorizontal, ChevronDown, Search, Research, Queue, Image, Target, List, Users } from './icons';
import { canonical, emptyDraft, type Attachment, type Command, type Draft, type Entity, type Snapshot } from '../../../packages/domain/contracts';
import type { AssistantState, AssistantOperation, AssistantOutput, Conversation, ConversationMessage, PermissionMode } from '../../../packages/domain/assistant';
import { Conflict, Dialog, Empty, formatSaved } from './ui';
import { useRetained } from './useWorkspace';
import { useAttachments } from './useAttachments';
import { registerAssistantDraftNavigation } from './assistant-draft-navigation';
import type { AssistantController } from './useAssistant';
import type { VoiceController } from './voice-controller';
import { ApiError, commit, fetchSnapshot, readLocal, request, saveLocal } from './api';
import { savedMessageOutput } from './saved-message-output';
const GeneratedOutput = lazy(() => import('./GeneratedOutput').then(module => ({ default: module.GeneratedOutput })));
const ResearchReport = lazy(() => import('./ResearchReport').then(module => ({ default: module.ResearchReport })));
import { researchReportOperation } from './research-report';
const ResearchWorkflow = lazy(() => import('./ResearchWorkflow').then(module => ({ default: module.ResearchWorkflow })));
import { ConversationAccountPanel, useConversationAccount } from './ConversationAccount';
import { UserRound } from './icons';
import type { MessagePin } from '../../../packages/domain/message-pins';
import type { ConversationHistory } from '../../../packages/domain/assistant';
import { SidebarRow } from './SidebarRow';
import { ConversationRow } from './ConversationRow';
import { ConversationSettings } from './ConversationSettings';
import { ConversationRestoreStatus } from './ConversationRestoreStatus';
import { conversationVisibilityBlocked, conversationWritePending } from './conversation-visibility';
import { SavedDraftRow } from './SavedDraftRow';
import { MessageQueue } from './MessageQueue';
import { useDictation } from './useDictation';
import { DictationDraft } from './dictation-draft';
import { ConversationSources } from './ConversationSources';
import { ConversationFiles, type ConversationSource } from './ConversationSummary';
import { ConversationProjectControl } from './ConversationProjectControl';
import { useWorkspaceTabs } from './useWorkspaceTabs';
import { filePreviewReturn, viewTitle, type WorkspaceView, type WorkspaceAction } from './workspace-tabs';
import { AssistantSidePanel } from './AssistantSidePanel';
import { AssistantRunHistory, focusConversationQuestion } from './AssistantRunHistory';
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
import { effortPreference } from '../../../packages/domain/auto-effort';
import './assistant-restoration.css';
import { useAssistantRail, useMediaQuery, type AssistantRailState } from './assistant-rail-state';
import { AssistantOrganizationRailFrame } from './dreamclaw/components/Chat/AssistantOrganizationRailFrame';
import { ChatTabs } from './dreamclaw/components/Chat/ChatTabs';
import './dreamclaw/assistant-rail.css';

export function resolveMessageActions(message: ConversationMessage, conversation: Conversation, history: ConversationHistory | undefined, operations: AssistantOperation[], pins: MessagePin[]) {
  const nativeId = message.source?.nativeId ?? conversation.nativeId;
  const sameMessage = (value: ConversationMessage) => value.role === message.role && (message.novaId ? value.novaId === message.novaId : value.id === message.id && value.textHash === message.textHash && (value.source?.nativeId ?? history?.nativeId) === (message.source?.nativeId ?? history?.nativeId));
  const index = history?.messages.findIndex(sameMessage) ?? -1;
  const previousUser = index < 0 ? undefined : history?.messages.slice(0, index).findLast(value => value.role === 'user' && (value.source?.nativeId ?? history.nativeId) === nativeId && (!value.source || !message.source || value.source.bindingId === message.source.bindingId));
  const operation = operations.find(op => op.conversationId === conversation.id && !op.steerTarget && !!message.operationId && op.id === message.operationId)
    ?? operations.find(op => op.conversationId === conversation.id && !op.steerTarget && !!message.runId && op.nativeRunId === message.runId && op.nativeId === (message.source?.nativeId ?? history?.nativeId));
  const ids = new Set([message.id, message.source?.nativeMessageId, ...(message.aliases ?? [])]);
  const pinned = pins.some(pin => pin.pinned && pin.conversationId === conversation.id && pin.nativeId === nativeId && ids.has(pin.messageId) && pin.role === message.role && pin.messageHash === message.textHash);
  return { nativeId, operation, previousUser, pinned, canFork: !!nativeId && nativeId === conversation.nativeId && (!message.source || message.source.connectionGeneration === conversation.connectionGeneration) };
}
export function TranscriptCoverage({ history }: { history?: ConversationHistory }) {
  const coverage = history?.transcript;
  const notes = coverage ? [!coverage.complete && (coverage.bindings.some(binding => binding.status === 'capturing') ? 'Capturing Earlier Messages' : 'Partial Saved Transcript'), coverage.conflicts > 0 && `${coverage.conflicts} Message ${coverage.conflicts === 1 ? 'Conflict' : 'Conflicts'} Kept`, coverage.unavailableAttachments > 0 && `${coverage.unavailableAttachments} ${coverage.unavailableAttachments === 1 ? 'File' : 'Files'} Not Captured Locally`].filter(Boolean) : history?.retained && !history.retained.complete ? ['Partial Saved Transcript'] : [];
  return notes.length ? <p className="metadata" role="status">{notes.join(' · ')}</p> : null;
}

const modeIcons = { chat: MessageSquare, image: Image, goal: Target, plan: List, research: Research };

const AssistantFilePreview = lazy(() => import('./AssistantFilePreview').then(module => ({ default: module.AssistantFilePreview })));
const TeamWorkPanel = lazy(() => import('./TeamWorkPanel').then(module => ({default:module.TeamWorkPanel})));
const HostBrowserPanel = lazy(() => import('./HostBrowserPanel').then(module => ({ default:module.HostBrowserPanel })));
const WorkProjectChanges = lazy(() => import('./WorkProjectChanges').then(module => ({ default: module.WorkProjectChanges })));
const MemoryPanel = lazy(() => import('./AssistantMemory').then(module => ({ default: module.MemoryPanel })));
const MemoryEditor = lazy(() => import('./AssistantMemory').then(module => ({ default: module.MemoryEditor })));
const ContinueSavedConversation = lazy(() => import('./ContinueSavedConversation').then(module => ({ default: module.ContinueSavedConversation })));

type Journal = ReturnType<typeof useRetained<Draft>>;
type Props = { openAgentChat?: (id: string, revision: number) => boolean; directBack?: () => boolean; searchRequest?: SearchQueryRequest; searchPreview?: { id: string; nonce: string; epoch: string; revision: number }; onSearchDraft?: (owner: string, draft?: LocalSearchDraft) => void; appIcon: AppIconChoice; contentActions: ContentOutputActions; sourceRequest?: { target: BrowseTarget; nonce: string } | null; snapshot: Snapshot; controller: AssistantController; voice: VoiceController; legacyJournal: Journal; refreshWorkspace: () => Promise<void>; onOpenApp?: (destination: AppDestination) => boolean; openSettings: () => void; newProject: () => void; editProject: (id: string) => void; initialPreview?: Entity<Draft> };
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
function Editor({ openAgentChat, directBack, snapshot, journal, controller, voice, appIcon, draftId, onOpenApp, openSettings, initialPreview, refreshWorkspace, rail, contentActions, sourceRequest, searchRequest, searchPreview, onSearchDraft }: Props & { journal: Journal; controller: AssistantController; draftId: string; rail: AssistantRailState }) {
  const [organizingProject, setOrganizingProject] = useState<string>();
  const visibleProjects = activeProjects(snapshot);
  const removedProjects = snapshot.projects.filter(item => projectIsDeleted(snapshot, item.id) && assistantSpace(item.value) === controller.space);

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
  const planPanelWide = useMediaQuery('(min-width: 1101px)');
  const panelVisible = workspace.visible && (selectedView.kind !== 'plan' || planPanelWide);
  const sidePanel = panelVisible ? selectedView : null;
  const activityOpen = sidePanel?.kind === 'live';
  const dispatchWorkspace = (action: WorkspaceAction) => {
    if (!mayLeaveRecordDrafts()) return false;
    workspace.dispatch(action); return true;
  };
  const setSidePanel = (view: WorkspaceView | null) => {
    if (view?.kind === 'plan' && !matchMedia('(min-width: 1101px)').matches) return false;
    if (view?.kind === 'projects' && !journal.retainForNavigation()) return false;
    if (view && groupTarget && !groups.select(null)) return false;
    if (!dispatchWorkspace(view ? { type: 'open', view } : { type: 'visibility', visible: false })) return false;
    if (view?.kind === 'plan') workspace.dispatch({ type: 'expand', expanded: false });
    if (view) rail.closeMobile(); return true;
  };
  const manageProjects = (target?: ProjectManagerRequest['target']) => setSidePanel({ kind: 'projects', ...(target ? { request: { requestId: crypto.randomUUID(), target } } : {}) });
  const newProject = () => manageProjects({ kind: 'create', space: controller.space });
  const editProject = (id: string) => manageProjects({ kind: 'project', id, tab: 'settings' });
  useEffect(() => { if (!planPanelWide && selectedView.kind === 'plan' && workspace.visible) workspace.dispatch({ type: 'visibility', visible: false }); }, [planPanelWide, selectedView.kind, workspace.visible]);
  const [activityContainer, setActivityContainer] = useState<HTMLDivElement | null>(null);
  const [contextDialog, setContextDialog] = useState<{ kind: 'memory' | 'technical' } | null>(null);
  const [hasLiveView, setHasLiveView] = useState(false);
  const closePanel = () => setSidePanel(null);
  const questionReturn = useRef<string | null>(null);
  const returnToQuestion = (id: string) => { questionReturn.current = id; closePanel(); };
  useEffect(() => {
    if (panelVisible || !questionReturn.current) return;
    const id = questionReturn.current; questionReturn.current = null;
    // Run after the workspace restores its opener, so this explicit return
    // focuses the one existing question editor rather than a hidden History tab.
    const frame = requestAnimationFrame(() => { focusConversationQuestion(id); });
    return () => cancelAnimationFrame(frame);
  }, [panelVisible]);
  const panelFocusFallback = () => [selectedView.kind === 'plan' ? document.querySelector<HTMLButtonElement>('[aria-label="Open plan in side panel"]') : null, document.querySelector<HTMLButtonElement>('[aria-label="Toggle side panel"]'), document.querySelector<HTMLButtonElement>('[aria-label="Conversation menu"]')].find(target => target?.getClientRects().length && !target.closest('[inert]')) ?? null;
  const openFile = (file: Attachment, output?: AssistantOutput, returnTabId?: string, returnProjectId?: string) => setSidePanel({ kind: 'file', file, ...(output ? { outputId: output.id, outputVersion: output.version } : {}), ...(returnTabId ? { returnTabId } : {}), ...(returnProjectId ? { returnProjectId } : {}) });
  const [preview, setPreview] = useState<Entity<Draft> | null>(initialPreview ?? null);
  useEffect(() => { if (preview && snapshot.draftRemovals?.some(item => item.draftId === preview.id && item.revision > preview.revision)) setPreview(null); }, [preview, snapshot.draftRemovals]);
  const [folder, setFolder] = useState<'active' | 'archive' | 'deleted'>('active');
  const archive = folder === 'archive';
  const matchesFolder = (item: Conversation) => folder === 'deleted' ? !!item.deleted : !item.deleted && item.archived === archive;
  const [managedId, setManagedId] = useState<string | null>(null);
  const groups = useAssistantGroups(snapshot, draftId, () => {
    if (voiceState.phase !== 'idle' || dictation.phase !== 'idle' || dictation.preview) {
      setNotice('Finish the current voice session or dictation before opening a Group.'); return false;
    }
    return mayLeaveRecordDrafts() && retainBeforeLeaving.current();
  }, controller.space === 'chat');
  const groupTarget = groups.selection;
  const groupOpener = useRef<HTMLElement | null>(null);
  const groupReturnFocus = useRef(false);
  const visibleWorkspace = !groupTarget && panelVisible;
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [groupPanelCloseRequest, setGroupPanelCloseRequest] = useState(0);
  const openGroup = (target: NonNullable<GroupViewTarget>) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!groups.select(target)) return false;
    if (!groupTarget) groupOpener.current = opener;
    aloud.stop(); rail.closeMobile(); return true;
  };
  const backFromGroup = () => {
    if (!groups.select(null)) return false;
    groupReturnFocus.current = true; return true;
  };
  const newGroup = () => openGroup({ kind: 'create', groupId: crypto.randomUUID() });
  const readingKey = `e3:reading:${snapshot.deviceId}${controller.space === 'work' ? ':work' : ''}`;
  const [reading, setReadingState] = useState<BrowseTarget | null>(() => readLocal<BrowseTarget>(readingKey) ?? null);
  const setReading = (target: BrowseTarget | null) => { if (!mayLeaveRecordDrafts() || target && groupTarget && !groups.select(null)) return false; if (target) aloud.stop(); setReadingState(target); if (target) saveLocal(readingKey, { ...target, offset: undefined }); else localStorage.removeItem(readingKey); return true; };
  useEffect(() => {
    if (sourceRequest && readLocal<string>(`e3:reading:${snapshot.deviceId}:source-request`) !== sourceRequest.nonce) {
      if (!setReading(sourceRequest.target)) return; saveLocal(`e3:reading:${snapshot.deviceId}:source-request`, sourceRequest.nonce);
    }
  }, [sourceRequest?.nonce]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchOwner] = useState(() => crypto.randomUUID());
  const consumedSearch = useRef<string | undefined>(undefined);
  const [querySeed, setQuerySeed] = useState<SearchQueryRequest>();
  useEffect(() => {
    if (journal.epoch !== snapshot.epoch) { onSearchDraft?.(searchOwner); return; }
    onSearchDraft?.(searchOwner, { token: searchOwner, id: draftId, value: journal.value, revision: journal.revision, epoch: journal.epoch, deviceId: snapshot.deviceId, pending: !!journal.pending });
  }, [journal.value, journal.revision, journal.epoch, journal.pending, snapshot.epoch, snapshot.deviceId, draftId, searchOwner, onSearchDraft]);
  useEffect(() => () => onSearchDraft?.(searchOwner), [onSearchDraft, searchOwner]);
  useEffect(() => {
    if (!matchesSearchQuery(searchRequest, snapshot) || consumedSearch.current === searchRequest!.nonce) return;
    consumedSearch.current = searchRequest!.nonce; setQuerySeed(searchRequest); setSearchOpen(true);
  }, [searchRequest?.nonce, snapshot.epoch, snapshot.deviceId]);
  useEffect(() => {
    if (!searchPreview || searchPreview.epoch !== snapshot.epoch) return;
    const row = snapshot.drafts.find(item => item.id === searchPreview.id && item.revision === searchPreview.revision);
    if (row && !snapshot.draftRemovals?.some(item => item.draftId === row.id && item.revision >= row.revision)) setPreview(row);
  }, [searchPreview?.nonce]);
  const { expandedProjects, toggleProject } = rail;
  // Leave room for the saved rail width, conversation and workspace together.
  // This temporary collapse never rewrites the user's rail preference.
  const panelRoomForRail = useMediaQuery('(min-width: 1601px)');
  const organizationOpen = rail.open && (!(groupTarget ? groupPanelOpen : sidePanel || activityOpen) || panelRoomForRail);
  const showOrganization = () => { if (setSidePanel(null)) { if (groupTarget && groupPanelOpen) setGroupPanelCloseRequest(value => value + 1); rail.setOpen(true); } };
  const toggleOrganization = () => { if (organizationOpen) rail.setOpen(false); else showOrganization(); };
  const openNewDraft = () => { if (groupTarget && !groups.select(null) || !controller.select(null)) return; setFolder('active'); setReading(null); setPreview(null); rail.closeMobile(); };
  const [dialog, setDialog] = useState<'settings' | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [notice, setNotice] = useState('');
  const [researchUpdateId, setResearchUpdateId] = useState<string>();
  const transcript = useRef<TranscriptHandle>(null);
  const [readingParent, setReadingParent] = useState<HTMLDivElement | null>(null);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const scroll = useTranscriptScroll(readingParent, controller.history?.hasNewer !== true);
  const { showLatest, latest: scrollToLatest } = scroll;
  const editorAlive = useRef(true);
  useEffect(() => { editorAlive.current = true; return () => { editorAlive.current = false; }; }, []);
  const preferencesKey = `e3:response-preferences:${snapshot.deviceId}`;
  const [preferences, setPreferences] = useState<ResponsePreferences>(() => { const saved = readLocal<ResponsePreferences>(preferencesKey) ?? { model: null, thinking: 'auto', fastMode: null }; return { ...saved, thinking: effortPreference(saved.thinking) }; });
  const accessKey = `e3:access-preferences:${snapshot.deviceId}`;
  const [accessPreference, setAccessPreference] = useState<PermissionMode>(() => readLocal<PermissionMode>(accessKey) ?? 'read-only');
  const attachments = useAttachments(snapshot, journal.value, journal.change, draftId, 'draft', { assistant: true, uploadEnabled: !controller.conversation?.directAgent });
  const filesPending = attachments.staging || attachments.pending.length > 0;
  const fileInput = useRef<HTMLInputElement>(null), textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (groupTarget || !groupReturnFocus.current) return;
    groupReturnFocus.current = false;
    const frame = requestAnimationFrame(() => {
      const target = [groupOpener.current, textarea.current, panelFocusFallback()]
        .find(item => item?.isConnected && item.getClientRects().length && !item.closest('[inert]'));
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [groupTarget]);
  const retainBeforeLeaving = useRef<() => boolean>(() => true);
  retainBeforeLeaving.current = () => {
    if (journal.retainForNavigation()) return true;
    setReading(null); rail.closeMobile();
    setNotice('Your latest draft is only in this window. Free browser storage, then choose Retry save before leaving. You can also export the draft from the conversation menu.');
    requestAnimationFrame(() => textarea.current?.focus());
    return false;
  };
  useLayoutEffect(() => registerAssistantDraftNavigation(() => retainBeforeLeaving.current()), []);
  const draft = journal.value, conversation = controller.conversation;
  const direct = !!conversation?.directAgent;
  const directAgent = conversation?.directAgent && snapshot.records?.agent.find(row => row.id === conversation.directAgent!.recipient.agentId);
  const directAvailable = !direct || !!directAgent && !directAgent.value.archived && directAgent.revision >= conversation!.directAgent!.recipient.agentRevision;
  const composerMode = useComposerMode(snapshot.epoch, draftId, journal);
  const workMode = direct ? draft.workMode ?? 'chat' : composerMode.mode;
  const response = conversation ? { model: conversation.model, thinking: effortPreference(conversation.thinking), fastMode: conversation.fastMode ?? null } : preferences;
  const responseName = responseModel(controller.models, response.model)?.name ?? response.model ?? 'Default model';
  const [compactComposer, setCompactComposer] = useState(false);
  const actualAccess = conversation ? controller.history?.nativeSettings?.permissionMode ?? conversation.permissionMode : accessPreference;
  const dictatedDraft = useRef(new DictationDraft());
  const dictation = useDictation(snapshot.epoch, draftId, (text, attemptId) => journal.change(value => ({ ...value, text: dictatedDraft.current.update(value.text, text, attemptId) })));
  const startDictation = () => { dictatedDraft.current.begin(draft.text, textarea.current?.selectionStart ?? draft.text.length, textarea.current?.selectionEnd ?? draft.text.length); return dictation.start(); };
  const editDraft = (text: string) => { dictatedDraft.current.replace(text); journal.change(value => ({ ...value, text })); if (dictation.phase !== 'idle') void dictation.cancel(); };
  useEffect(() => { if (conversation && draft.projectId !== conversation.projectId) journal.change(value => ({ ...value, projectId: conversation.projectId })); }, [conversation?.projectId]);
  const dictationLabel = dictation.phase === 'idle' ? 'Dictate a message' : dictation.phase === 'connecting' ? 'Cancel dictation' : 'Stop dictation';
  const project = snapshot.projects.find(p => p.id === draft.projectId);
  const sourceCount = new Set([...(project?.value.attachments ?? []), ...draft.attachments].map(file => file.id)).size;
  const attachmentIssue = assistantAttachmentsIssue([...(project?.value.attachments ?? []), ...draft.attachments]);
  const operations = controller.operations.filter(op => op.conversationId === conversation?.id);
  const active = operations.find(op => !op.steerTarget && !['completed', 'failed', 'cancelled'].includes(op.state));
  const hasFollowUp = !!draft.text.trim() || !!draft.attachments.length;
  const retainedDispatch = direct ? hasKeptDirectSubmit(directChatStorage, `e3:submit:${draftId}`) || !!composerMode.pendingKey
    : readLocal(conversation ? `e3:${active ? 'queue-capture' : 'submit'}:${draftId}` : `e3:start-chat:${snapshot.deviceId}${controller.space === 'work' ? ':work' : ''}`);
  const latest = operations[0];
  const latestGoal = operations.find(operation => operation.context.workMode === 'goal');
  const goalSupported = ['sessions.goal.update', 'sessions.describe'].every(method => controller.connection.methods.includes(method));
  const planOperation = active ?? operations.find(operation => !operation.steerTarget);
  const currentPlan = planOperation?.plan;
  const planReview = controller.plans?.filter(item => item.conversationId === conversation?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
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
  const recentRows = allRows.filter(row => row.folder === folder && (folder !== 'active' || !visibleProjects.some(p => p.id === row.projectId)));
  const renderRow = (row: typeof allRows[number]) => {
    if (row.kind === 'draft') return <SavedDraftRow key={`draft:${row.item.id}`} item={row.item} snapshot={snapshot} refresh={refreshWorkspace} open={() => { if (groupTarget && !groups.select(null) || !setReading(null)) return; setPreview(row.item); rail.closeMobile(); }}/>;
    const item = row.item;
    const hasDraft = snapshot.drafts.some(d => d.deviceId === snapshot.deviceId && d.id === `draft:${snapshot.deviceId}:${item.id}` && (d.value.text || d.value.attachments.length));
    return <ConversationRow refreshWorkspace={refreshWorkspace} key={item.id} conversation={item} controller={controller} snapshot={snapshot} hasDraft={!!hasDraft} updatedAt={row.updatedAt} selected={item.id === (reading?.conversationId ?? conversation?.id)} open={() => { if (groupTarget && !groups.select(null)) return; if (item.archived && item.nativeId) { if (!setReading({ epoch: snapshot.epoch, conversationId: item.id, nativeId: item.nativeId })) return; setSidePanel(null); } else { if (!controller.select(item.id)) return; setReading(null); } rail.closeMobile(); }}/>;
  };
  const ready = controller.statusRead === 'ready' && controller.connection.state === 'ready' && controller.connection.grantedScopes.includes('operator.write')
    && (!direct || !!conversation?.nativeId && directAvailable && !conversation.nativeRestorePending);
  const planReviewController = usePlanReview({ item: planReview?.kind === 'research' ? undefined : planReview, epoch: snapshot.epoch, ready: ready && !active && !busy && !callingHere && !conversationWritePending(conversation) && conversation?.state === 'ready', readOnly: !!conversation?.archived || !!reading, refresh: async () => { await controller.refresh(); if (conversation) await controller.loadHistory(conversation.id); } });
  const showPlanDecision = planReviewController.decisionVisible && !reading && !preview && !active && !callingHere && dictation.phase === 'idle' && !dictation.preview && !controller.history?.hasNewer && !conversation?.archived;
  const priorPlanDecision = useRef(false);
  useLayoutEffect(() => { if (priorPlanDecision.current && !showPlanDecision && !reading && !conversation?.archived) textarea.current?.focus({ preventScroll: true }); priorPlanDecision.current = showPlanDecision; }, [showPlanDecision, reading, conversation?.archived]);
  useEffect(() => {
    const field = textarea.current; if (!field) return;
    const region = field.closest<HTMLElement>('.composer-region') ?? field;
    const fit = () => { if (!showPlanDecision) { field.style.height = 'auto'; field.style.height = `${Math.min(180, Math.max(42, field.scrollHeight))}px`; } setCompactComposer(region.clientWidth < 520); };
    fit(); let width = region.clientWidth;
    const observer = new ResizeObserver(() => { if (region.clientWidth !== width) { width = region.clientWidth; fit(); } });
    observer.observe(region); return () => observer.disconnect();
  }, [draft.text, reading, conversation?.archived, showPlanDecision]);
  const updatingResearch = !!active && active.id === researchUpdateId && active.context.researchWorkflow === 'chat-research-v1' && !!active.nativeRunId && !active.cancelRequested && active.state !== 'unknown' && workMode === 'chat' && !draft.attachments.length && !filesPending;
  const primaryAction = direct ? active ? 'stop' : 'send' : active ? hasFollowUp ? updatingResearch ? 'send' : 'queue' : 'stop' : hasFollowUp || filesPending ? 'send' : 'voice';
  const primaryLabel = updatingResearch && primaryAction === 'send' ? 'Update research' : { voice: 'Start voice call', send: 'Send message', queue: 'Queue message', stop: 'Stop reply' }[primaryAction];
  const voiceDisabled = !ready || busy || !!active || voiceState.phase !== 'idle' || !!draft.attachments.length || filesPending || dictation.phase !== 'idle' || !!dictation.preview || !!journal.conflict || journal.saving || conversationWritePending(conversation) || (!!conversation && conversation.state !== 'ready');
  const keepError = (e: unknown) => setNotice(e instanceof Error ? e.message : 'This action could not be confirmed. Your work is kept.');
  const append = (source: Draft) => {
    const combined = [...new Map([...draft.attachments, ...source.attachments].map(a => [a.id, a])).values()];
    if (combined.length > 10) { setNotice('This copy would exceed 10 attachments. Keep or export the originals before continuing.'); return; }
    if (!draft.text.trim() && !draft.attachments.length) composerMode.select(source.workMode ?? 'chat');
    journal.change(value => ({ ...value, text: `${value.text}${value.text && source.text ? '\n\n' : ''}${source.text}`, attachments: combined, ...(!value.text.trim() && !value.attachments.length ? { workMode: source.workMode ?? 'chat' } : {}), ...(source.refineSource ? { refineSource: source.refineSource } : {}), ...(conversation ? {} : { projectId: value.text ? value.projectId : source.projectId }) }));
    setPreview(null); textarea.current?.focus();
  };
  const exportDraft = () => {
    const file = new Blob([`${draft.title}\n\n${draft.text}\n\n${draft.attachments.map(a => `Attachment: ${a.name} (${a.size} bytes)`).join('\n')}`], { type: 'text/plain' });
    const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = 'conversation-draft.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const rejectedInput = (error: unknown) => error instanceof ApiError && ['draft_changed', 'conversation_changed', 'project_changed', 'attachment_changed', 'attachment_limit', 'attachment_type', 'unsupported_attachment', 'empty_message', 'refinement_instructions', 'steer_project_changed', 'steer_attachments', 'steer_target_changed', 'queue_full', 'mode_steering'].includes(error.code);
  const dispatchDraft = async (action: 'submit' | 'queue' | 'steer') => {
    if (dictation.phase !== 'idle' || dictation.preview) return;
    if (direct && (action !== 'submit' || workMode !== 'chat' || draft.attachments.length || filesPending || !directAvailable)) { setNotice('This direct chat currently supports a read-only text reply. Your original writing and sources are kept.'); return; }
    if (sourceCount > 10) { setSidePanel({ kind: 'sources' }); return; }
    if (!conversation) { await startAndSend(); return; }
    if (busy || submitting.current || filesPending) return;
    const requestedKey = action === 'queue' ? `e3:queue-capture:${draftId}` : action === 'steer' ? `e3:steer:${draftId}:${active?.id}` : `e3:submit:${draftId}`;
    if (direct && (hasKeptDirectSubmit(directChatStorage, requestedKey) || composerMode.pendingKey)) { setNotice('The original message request is kept or cannot be read. Check its original result before sending; nothing was resent.'); return; }
    // Reconcile a prior uncertain send before capturing or saving new writing.
    const key = composerMode.pendingKey ?? [`e3:submit:${draftId}`, `e3:queue-capture:${draftId}`].find(key => readLocal(key)) ?? requestedKey;
    const retained = readLocal<{ request: object; captured: Draft }>(key);
    const endpoint = key.startsWith('e3:queue-capture:') ? 'queue' : key.startsWith('e3:steer:') ? 'steer' : 'submit';
    if (direct && retained) { await controller.checkStatus(conversation.id); setNotice('The original message request is kept. Status was checked without resending.'); return; }
    if (!retained && (journal.submitBlocked || endpoint === 'submit' && active || endpoint === 'steer' && (!active || draft.attachments.length))) return;
    if (!retained && attachmentIssue) { setNotice(attachmentIssue); return; }
    // React's busy state updates next render; this latch owns rapid Enter/clicks now.
    submitting.current = true; setBusy(true); setNotice('');
    let consumed: ReturnType<typeof composerMode.consume> | undefined;
    try {
      const saved = retained ? undefined : await journal.flushForSubmit();
      if (!editorAlive.current) return;
      if (direct && hasKeptDirectSubmit(directChatStorage, requestedKey)) throw Error('An original message request appeared while keeping this draft. It has not been replaced or resent.');
      const pending = retained ?? { request: { requestId: crypto.randomUUID(), epoch: saved!.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, draftId, draftRevision: saved!.revision, projectRevision: project?.revision ?? 0, ...(endpoint === 'queue' ? { automatic: true } : endpoint === 'steer' ? { targetOperationId: active!.id } : {}) }, captured: saved!.value };
      consumed = composerMode.consume(key);
      if (endpoint === 'steer') setResearchUpdateId(undefined);
      if (!saveLocal(key, pending)) { composerMode.finish(consumed); setNotice('Free browser storage before sending. Your draft is kept.'); return; }
      await request(`assistant/${endpoint}`, pending.request); localStorage.removeItem(key);
      composerMode.finish(consumed, pending.captured, conversation.refineSource?.sha256);
      await controller.refresh();
    } catch (e) { if (rejectedInput(e)) { localStorage.removeItem(key); if (consumed) composerMode.finish(consumed); } if (editorAlive.current) keepError(e); }
    finally { submitting.current = false; if (editorAlive.current) setBusy(false); }
  };
  const checkDirectMessage = async () => {
    if (!direct || !conversation || busy) return;
    const key = `e3:submit:${draftId}`;
    setBusy(true); setNotice('');
    try {
      const raw = localStorage.getItem(key);
      if (!raw) { await controller.checkStatus(conversation.id); return; }
      const pending: unknown = JSON.parse(raw);
      await controller.checkStatus(conversation.id);
      const state = await request<AssistantState>('assistant/state');
      if (!editorAlive.current || localStorage.getItem(key) !== raw) return;
      const confirmed = observedDirectSubmit(pending, state, { epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId: retainedWindowId }, conversation);
      if (!confirmed) { setNotice('The original message result is unavailable. Your original request and writing remain kept; nothing was resent.'); return; }
      const marker = `${key}:confirmed:${confirmed.request.requestId}`, existing = localStorage.getItem(marker);
      if (existing !== null && existing !== raw) throw Error('The saved original message marker changed. Your writing remains kept.');
      if (existing === null) localStorage.setItem(marker, raw);
      if (!journal.change(value => canonical(value) === canonical(confirmed.captured) ? { ...value, text: '', attachments: [] } : value)) throw Error('Keep the confirmed draft result before leaving this window.');
      if (localStorage.getItem(key) !== raw) throw Error('A newer message request is kept. It was not replaced.');
      localStorage.removeItem(key);
      setNotice('The original message operation is confirmed. Newer writing is preserved.');
    } catch (reason) { if (editorAlive.current) keepError(reason); }
    finally { if (editorAlive.current) setBusy(false); }
  };
  const cancel = async (reportFailure = false) => {
    if (!active) return;
    try { await request('assistant/cancel', { requestId: crypto.randomUUID(), epoch: snapshot.epoch, operationId: active.id }); await controller.refresh(); } catch (e) { keepError(e); if (reportFailure) throw e; }
  };
  const clearSubmittedDraft = async (entityId: string, expectedRevision: number, captured: Draft, submissionKey: string) => {
    const key = `${submissionKey}:clear`;
    const payload = { ...captured, text: '', attachments: [], workMode: 'chat' as const };
    const command = readLocal<Command>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, kind: 'draft' as const, entityId, expectedRevision, payload };
    if (!saveLocal(key, command)) throw Error('Your message was submitted. Reopen the conversation to reconcile its retained draft.');
    await commit(command); localStorage.removeItem(key); localStorage.removeItem(submissionKey);
  };
  const startAndSend = async () => {
    if (busy || submitting.current || !ready || filesPending) return;
    const key = `e3:start-chat:${snapshot.deviceId}${controller.space === 'work' ? ':work' : ''}`;
    type Start = { requestId: string; copyRequestId: string; submitRequestId: string; space?: AssistantSpace; captured: Draft; preferences: ResponsePreferences; permissionMode: PermissionMode };
    const retained = readLocal<Start>(key);
    if (!retained && journal.submitBlocked) return;
    if (!retained && attachmentIssue) { setNotice(attachmentIssue); return; }
    submitting.current = true; setBusy(true); setNotice('');
    let created: Conversation | undefined, intent: Start | undefined, consumed: ReturnType<typeof composerMode.consume> | undefined;
    try {
      const saved = retained ? undefined : await journal.flushForSubmit();
      if (!editorAlive.current) return;
      intent = retained ?? { requestId: crypto.randomUUID(), copyRequestId: crypto.randomUUID(), submitRequestId: crypto.randomUUID(), space: controller.space, captured: saved!.value, preferences, permissionMode: accessPreference };
      consumed = composerMode.consume(key);
      if (!saveLocal(key, intent)) { composerMode.finish(consumed); setNotice('Free browser storage before starting this conversation.'); return; }
      const settings = intent.preferences, captured = intent.captured;
      const autoTitle = !captured.title.trim() || ['New conversation', 'New chat', 'New work'].includes(captured.title.trim());
      const title = autoTitle ? captured.text.trim().split('\n')[0].slice(0, 80) || captured.attachments[0]?.name || 'New chat' : captured.title.trim();
      created = await controller.create({ requestId: intent.requestId, space: intent.space ?? assistantSpace(captured), title, autoTitle, projectId: captured.projectId, permissionMode: intent.permissionMode ?? 'read-only', ...(settings.model ? { model: settings.model } : {}), ...(settings.thinking ? { thinking: settings.thinking } : {}), ...(settings.fastMode != null ? { fastMode: settings.fastMode } : {}) });
      const branchId = `draft:${snapshot.deviceId}:${created.id}`;
      const payload = { ...captured, space: assistantSpace(created), conversationId: created.id, projectId: created.projectId, title: created.title };
      consumeDraftMode(snapshot.epoch, branchId, `e3:submit:${branchId}`, payload.workMode);
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
      composerMode.finish(consumed, captured);
      await refreshWorkspace(); await controller.refresh(); if (editorAlive.current) { controller.select(created.id, assistantSpace(created)); rail.closeMobile(); }
    } catch (e) { if (!created && intent) releaseRejectedProjectRequest(key, intent.requestId, e); if (created && rejectedInput(e)) { localStorage.removeItem(`e3:submit:draft:${snapshot.deviceId}:${created.id}`); localStorage.removeItem(key); } if (!readLocal(key) && consumed) composerMode.finish(consumed); if (editorAlive.current) keepError(e); if (created) { await refreshWorkspace(); await controller.refresh(); if (editorAlive.current) controller.select(created.id, assistantSpace(created)); } }
    finally { submitting.current = false; if (editorAlive.current) setBusy(false); }
  };
  const forkMessage = async (message: ConversationMessage, purpose: 'branch' | 'edit' | 'retry', text?: string) => {
    if (!conversation?.nativeId || active || busy) return;
    if (!resolveMessageActions(message, conversation, controller.history, operations, controller.pins ?? []).canFork) throw Error('This message belongs to an earlier connection. Its original conversation is kept.');
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
    const created = await controller.create(intent).catch(error => { releaseRejectedProjectRequest(key, intent.requestId, error); throw error; });
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
    if (voiceDisabled) return;
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
      const created = await controller.create(intent).catch(error => { releaseRejectedProjectRequest(key, intent.requestId, error); throw error; });
      const branchId = `draft:${snapshot.deviceId}:${created.id}`;
      const copyKey = `e3:conversation-copy:${branchId}`;
      const command = readLocal<Command>(copyKey) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, kind: 'draft' as const, entityId: branchId, expectedRevision: 0, payload: { ...emptyDraft, space: assistantSpace(created), title: created.title, projectId: created.projectId, conversationId: created.id, attachments: [source], refineSource: { outputId: output.id, version: output.version, sha256: source.sha256 } } };
      if (!saveLocal(copyKey, command)) throw new Error('The refinement conversation exists. Free browser storage to prepare its draft; your original draft is kept.');
      controller.select(created.id, assistantSpace(created));
      await commit(command); localStorage.removeItem(copyKey); localStorage.removeItem(key); await refreshWorkspace();
    } catch (e) { keepError(e); }
    finally { setBusy(false); }
  };
  const openVersion = (item: Conversation) => { if (item.archived && item.nativeId) { if (!setReading({ epoch: snapshot.epoch, conversationId: item.id, nativeId: item.nativeId })) return; } else { if (!controller.select(item.id)) return; setReading(null); } setPreview(null); rail.closeMobile(); };
  const pins = (controller.pins ?? []).filter(p => p.pinned && p.conversationId === conversation?.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const conversationFiles = controller.outputs.filter(output => output.conversationId === conversation?.id && output.state === 'ready' && output.file);
  const sourceFiles: ConversationSource[] = [...new Map([
    ...draft.attachments.map(file => ({ file, origin: 'Next message' })),
    ...(project?.value.attachments ?? []).map(file => ({ file, origin: 'Project source' })),
    ...operations.flatMap(op => op.context.attachments.map(file => ({ file, origin: 'Earlier message' }))),
  ].map(source => [`${source.file.id}:${source.file.sha256}`, source] as const).reverse()).values()].reverse();
  const openFiles = () => { setSidePanel({ kind: 'files' }); rail.closeMobile(); };
  const openChanges = controller.space === 'work' && conversation?.workspace ? () => { setSidePanel({ kind: 'changes' }); rail.closeMobile(); } : undefined;
  const openTeam = () => { setSidePanel({ kind: 'team' }); rail.closeMobile(); };
  const spaceSwitchDisabled = busy || filesPending || dictation.phase !== 'idle' || !!dictation.preview;
  const switchSpace = (next: AssistantSpace) => { if (next !== controller.space) { if (groupTarget && !groups.select(null)) return; void journal.flush(); controller.switchSpace(next); } };
  const addFiles = !conversation?.archived && !conversation?.deleted ? () => fileInput.current?.click() : undefined;
  const renderMessage = (message: ConversationMessage, options?: { hideTool?: boolean }) => {
    const source = resolveMessageActions(message, conversation!, controller.history, operations, pins);
    const progressing = !!active && source.operation?.id === active.id;
    const reportOperation = researchReportOperation(message, operations, conversation!.id, controller.history?.nativeId, assistantSpace(conversation));
    const delivery = message.role === 'user' ? message.delivery === 'unknown' ? 'Delivery Unconfirmed' : message.delivery === 'failed' ? 'Reply Failed · Input Saved' : message.delivery === 'cancelled' ? 'Stopped · Input Saved' : ['prepared', 'dispatching'].includes(message.delivery ?? '') ? 'Sending…' : undefined : undefined;
    return <article aria-label={`${message.role} message`} className={`chat-message message-${message.role} ${messageSpeaker(message) ? 'message-with-identity' : ''} ${progressing ? 'message-progress' : ''} ${message.toolInfo && (message.role === 'tool' || !message.text.trim()) ? 'message-tool-compact' : ''}`} id={`message-${message.novaId ?? message.id}`} key={message.novaId ?? `${message.role}:${message.id}`}>
      <TranscriptIdentity message={message}/>
      {(message.role === 'tool' && !message.toolInfo || message.role === 'system') && <div className="message-author">{message.role === 'tool' ? 'Tool activity' : 'Conversation note'}</div>}
      <MessageWriting message={message}>{!options?.hideTool && <HistoryTool message={message}/>}{reportOperation ? <Suspense fallback={<SavedMessageText message={message}/>}><ResearchReport key={`${snapshot.epoch}:${conversation!.id}:${message.id}:${message.textHash}`} text={message.authoredText ?? message.text} operation={reportOperation}><SavedMessageText message={message}/></ResearchReport></Suspense> : <SavedMessageText message={message}/>}</MessageWriting>
      {delivery && <p className="metadata" role="status">{delivery}</p>}
      {direct && (message.role === 'user' || message.role === 'assistant' && !!message.text.trim()) && <div className="message-actions"><button className="text-button" onClick={() => void navigator.clipboard.writeText(message.authoredText ?? message.text).catch(() => setNotice('Copy was unavailable. Select the saved text to copy it.'))}>Copy Message</button>{source.operation && <button className="text-button" onClick={() => setSidePanel({ kind: 'sources', operationId: source.operation!.id })}>Sources Used</button>}</div>}
      {!direct && (message.role === 'user' || message.role === 'assistant' && !!message.text.trim() && !progressing) && <MessageActions
        sources={source.operation ? () => setSidePanel({ kind: 'sources', operationId: source.operation!.id }) : undefined}
        remember={source.nativeId ? () => setMemorySeed({ text: message.authoredText ?? message.text, projectId: conversation!.projectId, source: { conversationId: conversation!.id, nativeId: source.nativeId!, messageId: message.id, messageHash: message.textHash, role: message.role as 'user' | 'assistant' } }) : undefined}
        message={message} previousUser={source.previousUser} conversation={conversation!} blocked={!!active || busy || callingHere || conversationWritePending(conversation)}
        canFork={source.canFork && controller.connection.methods.includes('sessions.fork')} fork={forkMessage} pinned={source.pinned}
        pin={() => controller.pinMessage(conversation!, message, !source.pinned).then(() => undefined)}
        reading={readingAloud.messageId === (message.novaId ?? message.id) && ['preparing', 'speaking', 'paused'].includes(readingAloud.phase)} readAloud={() => readingAloud.messageId === (message.novaId ?? message.id) ? aloud.stop() : aloud.start(message.novaId ?? message.id, message.authoredText ?? message.text)}
        extras={message.role === 'assistant' && message.text.trim() ? <ReplyOutput open={openFile} message={message} conversation={conversation!} controller={controller} blocked={!!active || busy} refine={refine} contentActions={contentActions}/> : null}/>
      }
      {message.attachments.map((file, index) => message.role === 'assistant' && (file.artifactId || file.localFile) ? <Suspense key={`${file.artifactId ?? file.localFile?.id}:${message.textHash}`} fallback={<LoadingRing label="Opening output…"/>}><GeneratedOutput open={openFile} attachment={file} message={message} conversation={conversation!} controller={controller} epoch={snapshot.epoch} blocked={!!active || busy} refine={refine} contentActions={contentActions}/></Suspense> : file.localFile && file.availability !== 'unavailable' ? <button className="source-link" key={file.localFile.id} onClick={() => openFile(file.localFile!)}>{file.name}</button> : <span className="source-link" key={file.artifactId ?? `${file.name}:${index}`}>{file.name}</span>)}
    </article>;
  };
  const transcriptRows = withQuestionReceipts(groupWorkMessages(groupVoiceMessages(voiceMessages), { operations, conversationId: conversation?.id ?? '', nativeId: controller.history?.nativeId, active: controller.history?.hasNewer ? undefined : active }), { epoch: snapshot.epoch, conversationId: conversation?.id ?? '', operations, questions: controller.questions?.items, plans: controller.plans, history: controller.history });
  const activeInTranscript = !!active && transcriptRows.some(message => message.workOperation?.id === active.id);
  const activeTextInTranscript = !!active && hasVisibleOperationText(voiceMessages, active, controller.history?.nativeId);
  const renderTranscriptMessage = (message: TranscriptMessage) => message.workParts
    ? <WorkTranscript message={message} renderMessage={renderMessage} checkStatus={() => void controller.checkStatus()}/>
    : <><QuestionReceipts items={message.questionReceipts}/>{message.voiceParts || message.pendingVoice ? <VoiceMessage message={message} renderPart={part => renderMessage(part)}/> : renderMessage(message)}<QuestionReceipts items={message.questionReceiptsAfter}/></>;
  const accountControl = useConversationAccount({ snapshot, conversation: direct ? undefined : conversation, blocked: busy || !!active || callingHere || conversationWritePending(conversation) || !!conversation?.pendingResume || dictation.phase !== 'idle', onChange: async profileId => { if (conversation) await controller.selectAccount(conversation, profileId); } });
  const researchWorkflow = planReview?.kind === 'research' ? <Suspense fallback={null}><ResearchWorkflow key={`${snapshot.epoch}:${planReview.id}:${planReview.version}`} item={planReview} operations={operations} epoch={snapshot.epoch} connected={controller.statusRead === 'ready' && controller.connection.state === 'ready'} connectionGeneration={controller.connection.generation} questions={controller.questions?.items} ready={ready && !busy && !callingHere && !conversationWritePending(conversation) && conversation?.state === 'ready'} readOnly={!!conversation?.archived || !!reading} refresh={async () => { await controller.refresh(); if (conversation) await controller.loadHistory(conversation.id); }} stop={id => { if (id === active?.id) void cancel(); }} update={id => { if (id === active?.id) { setResearchUpdateId(id); textarea.current?.focus(); } }}/></Suspense> : null;
  return <div className={`assistant-workspace ${!groupTarget && (sidePanel || activityOpen) ? 'inspector-open' : ''}`}>
    {organizingProject && snapshot.projects.find(item => item.id === organizingProject) && <ProjectOrganizationDialog snapshot={snapshot} project={snapshot.projects.find(item => item.id === organizingProject)!} close={() => setOrganizingProject(undefined)} refresh={refreshWorkspace}/>}
    <AssistantOrganizationRailFrame spaceSwitch={<AssistantSpaceSwitch value={controller.space} disabled={spaceSwitchDisabled} change={switchSpace}/>} newDraftLabel={controller.space === 'work' ? 'New work' : 'New chat'} open={organizationOpen} width={rail.width} setWidth={rail.setWidth} onToggle={toggleOrganization} onNewDraft={openNewDraft} onSearch={() => setSearchOpen(value => !value)}>
      <div className="organization original-organization-body">
      {searchOpen && <ConversationSearch seed={querySeed} seedAccepted={nonce => setQuerySeed(current => current?.nonce === nonce ? undefined : current)} snapshot={snapshot} controller={controller} open={target => { if (!setReading(target)) return; rail.closeMobile(); setSidePanel(null); }}/>}
      {folder === 'active' && <div className="section-heading organization-heading"><span>Projects</span><div className="button-row"><button className="text-button" onClick={() => manageProjects()}>Manage</button><button className="icon-button" aria-label="Create Project" onClick={newProject}><Plus size={16}/></button></div></div>}
      {folder === 'active' && visibleProjects.filter(item => assistantSpace(item.value) === controller.space).map(item => {
        const expanded = expandedProjects.includes(item.id), rows = allRows.filter(row => row.folder === 'active' && row.projectId === item.id);
        return <div className="assistant-project-group" key={item.id}>
          <SidebarRow title={item.value.name} rowClass="project-heading-row" expanded={expanded} controls={`project-chats-${item.id}`} open={() => toggleProject(item.id)} icon={<span className="project-row-icons"><ChevronDown className={`project-chevron ${expanded ? 'expanded' : ''}`} size={14}/><Folder size={16}/></span>}>{close => <><button role="menuitem" onClick={() => { close(); editProject(item.id); }}><Settings2 size={17}/>Project settings</button><button role="menuitem" className="chat-delete-action" onClick={() => { close(); setOrganizingProject(item.id); }}><Trash2 size={17}/>Move project to Deleted</button></>}</SidebarRow>
          {expanded && <div className="project-conversations" id={`project-chats-${item.id}`} role="group" aria-label={`${item.value.name} chats`}>{rows.map(renderRow)}{!rows.length && <p className="metadata organization-empty">{controller.space === 'work' ? 'No work yet.' : 'No chats yet.'}</p>}</div>}
        </div>;
      })}
      {controller.space === 'chat' && <section aria-label="Saved Groups">
        <div className="section-heading organization-heading"><span>Groups</span><button className="icon-button" aria-label="New Group" disabled={!groups.readable} onClick={newGroup}><Plus size={16}/></button></div>
        {groups.list.groups.filter(group => folder === 'deleted' ? group.trashed : folder === 'archive' ? group.archived && !group.trashed : !group.archived && !group.trashed).map(group => <SidebarRow key={group.id} title={group.title} icon={<Users size={16}/>} selected={groupTarget?.groupId === group.id} secondary={`${group.activeMembershipIds.length} Members`} open={() => openGroup({ kind: 'group', groupId: group.id })}>{close => <button role="menuitem" onClick={() => { if (openGroup({ kind: 'group', groupId: group.id })) close(); }}>Open Group</button>}</SidebarRow>)}
        {(groups.error || groups.list.error) && <div className="group-rail-status" role="alert">{groups.error || groups.list.error}<button disabled={groups.list.busy} onClick={() => { groups.reopen(); void groups.refresh(); }}>Check Saved Groups</button></div>}
        {groups.list.next && <button className="text-button" disabled={groups.list.busy} onClick={() => void groups.refresh(true)}>Load More Groups</button>}
      </section>}
      {folder === 'active' ? <div className="section-heading organization-heading recents-heading"><span>Recents</span></div> : <div className="archive-list-heading"><strong>{archive ? 'Archive' : 'Deleted'}</strong><button className="text-button" onClick={() => setFolder('active')}>{controller.space === 'work' ? 'Back to work' : 'Back to chats'}</button></div>}
      <div className="recent-conversations" aria-label={folder === 'active' ? 'Recents' : archive ? 'Archive' : 'Deleted'}>
      {folder === 'deleted' && removedProjects.map(item => <SidebarRow key={item.id} title={item.value.name} icon={<Folder size={16}/>} secondary="Deleted project" open={() => setOrganizingProject(item.id)}>{close => <button role="menuitem" onClick={() => { close(); setOrganizingProject(item.id); }}><RotateCcw size={17}/>Restore project</button>}</SidebarRow>)}
      {recentRows.map(renderRow)}
      {!recentRows.length && !(folder === 'deleted' && removedProjects.length) && <p className="metadata organization-empty">{folder === 'active' ? controller.space === 'work' ? 'Your recent work will appear here.' : 'Your recent chats will appear here.' : archive ? 'Archived conversations open read only.' : 'Deleted projects and conversations will appear here.'}</p>}
      </div>
      </div>
    <div className="organization-footer"><button onClick={() => setSidePanel({ kind: 'cleanup' })}><List size={17}/>Cleanup</button><button aria-pressed={archive} onClick={() => setFolder(value => value === 'archive' ? 'active' : 'archive')}><Archive size={17}/>Archive</button><button aria-pressed={folder === 'deleted'} onClick={() => setFolder(value => value === 'deleted' ? 'active' : 'deleted')}><Trash2 size={17}/>Deleted</button></div>
    </AssistantOrganizationRailFrame>
    {groupTarget && <AssistantGroup key={`${snapshot.epoch}:${snapshot.deviceId}:${groups.scope.windowId}:${groupTarget.groupId}`} snapshot={snapshot} windowId={groups.scope.windowId} target={groupTarget} refreshWorkspace={refreshWorkspace} panelChanged={setGroupPanelOpen} closePanelRequest={groupPanelCloseRequest} back={backFromGroup} changed={() => { if (groupTarget.kind === 'create') groups.select({ kind: 'group', groupId: groupTarget.groupId }); void groups.refresh(); }} navigationCovered={organizationOpen && !rail.desktop} sidebarControls={<ChatTabs newDraftLabel="New Chat" organizationOpen={organizationOpen} onToggleOrganization={toggleOrganization} onCreateConversation={openNewDraft}/>}/>}
    {reading && !groupTarget && <ConversationReader refreshWorkspace={refreshWorkspace} target={reading} snapshot={snapshot} controller={controller} close={() => setReading(null)} change={setReading} navigationCovered={organizationOpen && !rail.desktop} sidebarControls={<ChatTabs newDraftLabel={controller.space === 'work' ? 'New work' : 'New chat'} organizationOpen={organizationOpen} onToggleOrganization={toggleOrganization} onCreateConversation={openNewDraft}/>}/>}
    <div className={`conversation ${reading || groupTarget ? 'writing-kept' : ''}`} inert={!!groupTarget || organizationOpen && !rail.desktop}>
      {direct && conversation ? <><div className="conversation-header"><ChatTabs newDraftLabel="New chat" organizationOpen={organizationOpen} onToggleOrganization={toggleOrganization} onCreateConversation={openNewDraft} shortcutOwner={!reading && !groupTarget}/><div className="conversation-title"><strong>{conversation.title}</strong><span className="metadata">Read-only direct chat</span></div><button disabled={!!active || busy || conversation.archived} onClick={() => void controller.edit(conversation, { archived: true }).catch(keepError)}>Archive</button></div><DirectAgentStatus key={conversation.id} conversation={conversation} snapshot={snapshot} controller={controller} scope={{ epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId: retainedWindowId }} back={directBack}/></> : <>
      <div className="conversation-header"><ChatTabs newDraftLabel={controller.space === 'work' ? 'New work' : 'New chat'} organizationOpen={organizationOpen} onToggleOrganization={toggleOrganization} onCreateConversation={openNewDraft} shortcutOwner={!reading && !groupTarget}/><div className="conversation-title">{conversation ? <strong title={conversation.title}>{conversation.title}</strong> : <input aria-label="Conversation draft title" value={draft.title} onChange={e => journal.change(v => ({ ...v, title: e.target.value }))} maxLength={150}/>}<ConversationProjectControl snapshot={snapshot} draft={draft} conversation={conversation} blocked={!!journal.pending || !!journal.conflict || busy || !!active || conversationWritePending(conversation)} choose={id => { journal.change(value => ({ ...value, projectId: id })); }} edit={editProject} settings={() => setDialog('settings')}/></div><ConversationHeaderTools visibilityBlocked={hiding => !conversation || conversationVisibilityBlocked(conversation, controller.operations, controller.removals, busy || hiding && callingHere, hiding)} blocked={!!active || busy || callingHere || conversationWritePending(conversation) || conversation?.state !== 'ready' || !conversation?.nativeId} edit={changes => controller.edit(conversation!, changes)} projects={visibleProjects} copyMessages={controller.history?.messages.length ? () => navigator.clipboard.writeText(controller.history!.messages.map(message => `${message.role}: ${message.authoredText ?? message.text}`).join('\n\n')) : undefined} conversation={conversation} conversations={controller.conversations} pins={pins} openVersion={openVersion} openPin={pin => { if (!setReading({ epoch: snapshot.epoch, conversationId: pin.conversationId, nativeId: pin.nativeId, messageId: pin.messageId, messageHash: pin.messageHash, role: pin.role })) return; rail.closeMobile(); setSidePanel(null); }} removePin={pin => controller.pinMessage(conversation!, { id: pin.messageId, role: pin.role, textHash: pin.messageHash, source: { nativeId: pin.nativeId } }, false).then(() => undefined)} settings={() => setDialog('settings')} sources={sourceCount || project || controller.memory?.entries.length ? () => setSidePanel({ kind: 'sources' }) : undefined} memory={() => setContextDialog({ kind: 'memory' })} exportDraft={exportDraft} runs={operations.length ? () => setSidePanel({ kind: 'history' }) : undefined} technical={conversation ? () => setContextDialog({ kind: 'technical' }) : undefined} queue={conversation && controller.queue?.some(q => q.conversationId === conversation.id) ? () => setQueueExpanded(true) : undefined} summary={{ space: controller.space, conversation, outputs: conversationFiles, sourceFiles, openFile, openFiles, addFiles, changes: openChanges, projectSettings: project ? () => editProject(project.id) : undefined, projectFolder: project?.value.workspace?.folder }} panelOpen={!!sidePanel || activityOpen} togglePanel={() => { if (sidePanel || activityOpen) closePanel(); else { workspace.dispatch({ type: 'visibility', visible: true }); rail.closeMobile(); } }}/></div>
      </>}
      {controller.space === 'chat' && openAgentChat && <div className="direct-agent-recipient"><ComposerMenu label="Chat recipient" text="Chat with an agent" icon={null}>{close => <><button role="menuitem" onClick={() => { if (newGroup()) close(); }}><Users size={17}/>New Group</button>{groups.list.groups.filter(group => !group.archived && !group.trashed).map(group => <button key={group.id} role="menuitem" onClick={() => { if (openGroup({ kind: 'group', groupId: group.id })) close(); }}><Users size={16}/>{group.title}</button>)}{(snapshot.records?.agent ?? []).filter(agent => !agent.value.archived).map(agent => <button key={agent.id} role="menuitem" onClick={() => { if (openAgentChat(agent.id, agent.revision)) close(); }}>{agent.value.name}<small> · {agent.value.position || 'Saved agent'}</small></button>)}{!snapshot.records?.agent.some(agent => !agent.value.archived) && <p className="metadata">Create a saved agent in Team to open a direct chat.</p>}</>}</ComposerMenu></div>}
<div className="conversation-scroll-region"><div className="conversation-reading" ref={setReadingParent} tabIndex={0} aria-label="Conversation history">

        {!conversation && project && projectIsDeleted(snapshot, project.id) && <div className="notice warning" role="status"><span>This draft uses a deleted project. Restore it or choose another project before starting new work. Your writing is kept.</span><button onClick={() => setOrganizingProject(project.id)}>Restore project</button></div>}
        {(notice || controller.error) && <div className="notice warning" role="alert"><span>{notice || controller.error}</span><button className="text-button" onClick={() => { setNotice(''); controller.setError(''); }}>Dismiss</button></div>}
        {!direct && <ConversationRestoreStatus conversation={conversation} connected={ready} busy={busy} checkStatus={() => { setBusy(true); void controller.checkStatus().finally(() => setBusy(false)); }}/>}
        {conversation?.pendingSettings && <div className="notice warning settings-recovery"><span>{conversation.pendingSettings.permissionMode ? `${accessLabels[conversation.pendingSettings.permissionMode]} hasn’t been confirmed.` : 'A settings change hasn’t been confirmed.'} Sending is paused until this is resolved.</span><div className="button-row"><button disabled={busy} onClick={async () => { setBusy(true); try { await controller.checkStatus(); } finally { setBusy(false); } }}>Check status</button>{(['retry', 'use-current'] as const).map(action => <button key={action} disabled={busy || !!active || callingHere} onClick={async () => { setBusy(true); setNotice(''); try { await controller.recoverSettings(conversation, action); } catch (e) { keepError(e); } finally { setBusy(false); } }}>{action === 'retry' ? 'Retry change' : 'Keep current settings'}</button>)}</div></div>}
        {preview ? <SavedDraftArticle draft={preview} append={append} back={() => setPreview(null)}/> : conversation ? <div className="chat-transcript" aria-label="Conversation messages">
          {controller.loading && !controller.history && <LoadingRing label="Loading your conversation…"/>}
          {!direct && conversation.state === 'failed' && !conversation.nativeId ? <div className="history-status" role="status"><div><strong>Conversation setup was rejected</strong><p>{conversation.error} Your original draft and this copy are kept.</p></div><button onClick={openNewDraft}>Return to original draft</button></div> : controller.historyError && <div className="history-status" role="status"><div><strong>{controller.history ? 'Showing the saved conversation' : 'Conversation history is unavailable'}</strong><p>{controller.history ? 'Newer messages could not be checked. Your saved messages and draft remain here.' : 'This conversation could not be loaded. Your draft is still available below.'}</p></div><button disabled={controller.loading} onClick={() => void controller.loadHistory(conversation.id)}><RotateCcw size={16}/>{controller.loading ? 'Checking…' : 'Retry'}</button></div>}
          <TranscriptCoverage history={controller.history}/>
          {!direct && !conversation.archived && (conversation.pendingResume || controller.history?.transcript?.bindingUnavailable || !!controller.history?.messages.length && !!controller.connection.generation && conversation.connectionGeneration !== controller.connection.generation) && <div className="history-status"><span>Saved Chat · Current Connection Needed To Continue</span><button disabled={busy || !!active || callingHere || !ready} onClick={() => setContinueSaved(true)}>Resume Chat</button></div>}
          {controller.history?.hasMore && <button className="quiet" disabled={controller.loading} onClick={() => { transcript.current?.keepReadingPosition(); void controller.loadHistory(conversation.id, { offset: controller.history?.nextOffset }); }}>Earlier messages</button>}
          {readingParent && controller.history && <VirtualTranscript ref={transcript} key={conversation.id} parent={readingParent} scroll={scroll} history={controller.history} cacheKey={transcriptCacheKey(snapshot.epoch, conversation)} positionKey={transcriptPositionKey(snapshot.epoch, snapshot.deviceId, conversation)} messages={transcriptRows} render={renderTranscriptMessage} footer={<>
{controller.history && !voiceMessages.length && !controller.loading && !controller.historyError && !active && <Empty title={conversation.state === 'ready' ? 'A clear place to think.' : conversation.state === 'failed' ? 'Conversation setup was rejected.' : 'Waiting for OpenClaw confirmation.'}>{conversation.state === 'ready' ? 'Your first message will use this conversation and its selected Project.' : conversation.error ?? 'Use Check status to find the original native session. It will not be created again automatically.'}</Empty>}
          {active && !activeInTranscript && !controller.history?.hasNewer && <WorkTranscript message={{ id: `active:${active.id}`, role: 'assistant', text: '', textHash: '', attachments: [], workParts: [], workOperation: { ...active, tools: unrepresentedWorkTools(transcriptRows, active) } }} hideStream={activeTextInTranscript} renderMessage={renderMessage} checkStatus={() => void controller.checkStatus()}/>}
          {planReview && !controller.history?.hasNewer && (planReview.kind === 'research' ? researchWorkflow : <PlanReviewCard key={planReview.id} review={planReviewController} onOpenPanel={planPanelWide ? () => setSidePanel({ kind: 'plan', planId: planReview.id }) : undefined}/>)}
          {latest && ['failed', 'cancelled'].includes(latest.state) && <div className="notice warning"><span>{latest.error ?? 'The run stopped. Its submitted input is kept.'}</span><button onClick={() => setSidePanel({ kind: 'history' })}>Review input</button></div>}
          {controller.history?.hasNewer && <button className="quiet transcript-newer" disabled={controller.loading || controller.history.offset === undefined} onClick={() => { transcript.current?.keepReadingPosition(); void controller.loadHistory(conversation.id, { newer: true, offset: Math.max(0, (controller.history?.offset ?? 0) - 50) }); }}>Newer messages</button>}
          {['unknown', 'creating'].includes(conversation.state) && <button onClick={() => void controller.checkStatus()}>Check status</button>}</>}/>}
          {(!readingParent || !controller.history) && planReview && !controller.history?.hasNewer && (planReview.kind === 'research' ? researchWorkflow : <PlanReviewCard key={planReview.id} review={planReviewController} onOpenPanel={planPanelWide ? () => setSidePanel({ kind: 'plan', planId: planReview.id }) : undefined}/>)}
          {!controller.history && voiceTranscript}{!controller.history && active && <p className="metadata" role="status">Working…</p>}
        </div> : <div className="assistant-welcome"><NovaAssistantMark choice={appIcon} width="92" height="92" alt="Nova at rest"/><h1>{controller.space === 'work' ? 'What would you like to get done?' : 'What’s on your mind?'}</h1><p>{controller.space === 'work' ? 'Bring a task. We’ll work through it together.' : 'Bring a question, a plan, or an unfinished thought.'}</p><div className="suggestions">{controller.space==='work'?<><button onClick={newProject}>Open repository</button><button onClick={openTeam}>Team work</button><button onClick={()=>setSidePanel({kind:'browser'})}>Host browser</button></>:<><button onClick={() => journal.change(v => ({ ...v, text: `${v.text}${v.text ? '\n\n' : ''}Help me plan my day. The things I want to move forward are: ` }))}>Plan my day</button><button onClick={() => journal.change(v => ({ ...v, text: `${v.text}${v.text ? '\n\n' : ''}Help me think through this idea: ` }))}>Think through an idea</button></>}</div></div>}
      </div>
      {(showLatest || controller.history?.hasNewer || controller.historyError) && conversation && <button className="jump-to-latest icon-button" aria-label="Latest messages" title="Latest messages" disabled={controller.loading} onClick={() => { scrollToLatest(); void controller.loadHistory(conversation.id, { latest: true }); }}><ArrowDown size={20}/></button>}</div>
      {!reading && !direct && <ModuleActionTray conversationId={conversation?.id} epoch={snapshot.epoch} deviceId={snapshot.deviceId} onOpenApp={onOpenApp} refreshWorkspace={async () => { await Promise.all([refreshWorkspace(), controller.refresh()]); }} working={!!active && active.state !== 'unknown'}/>}
      {conversation?.archived ? <div className="archive-footer"><Archive size={19}/><span>{conversation.deleted ? 'Deleted conversation. Your unsent draft is kept.' : 'This archive is read only. Your unsent draft is kept.'}</span><button onClick={() => void controller.edit(conversation, conversation.deleted ? { deleted: false } : { archived: false }).catch(keepError)}>{conversation.deleted ? 'Restore chat' : 'Restore conversation'}</button></div> : <div className="composer-region">{!reading && !direct && <ApprovalTray controller={controller} conversationId={conversation?.id} epoch={snapshot.epoch} working={!!active}/>} {!reading && <ReadAloudControls reader={aloud} state={readingAloud}/>}{!reading && !direct && <VoicePanel appIcon={appIcon} conversationId={conversation?.id} controller={voice} openConversation={id => { setReading(null); setPreview(null); controller.select(id); }}/> }
        {operations.some(op => op.steerTarget && !['completed', 'failed', 'cancelled'].includes(op.state)) && <div className="steering-status" role="status">{operations.some(op => op.steerTarget && op.state === 'unknown') ? 'Direction delivery is unconfirmed.' : 'Additional direction submitted.'}<button className="text-button" onClick={() => void controller.checkStatus()}>Check status</button></div>}
        {journal.conflict && <Conflict name="Draft" message={journal.conflict.message} current={journal.conflict.current?.value.text} reapplyLabel={journal.conflict.code === 'draft_removed' ? 'Keep as new draft' : undefined} reapply={journal.reapply} discard={journal.discard}/>}
        {!reading && <div className="composer-progress">{planOperation?.context.researchWorkflow !== 'chat-research-v1' && <StepsPill key={planOperation?.id} plan={currentPlan} operation={planOperation}/>}{!reading && !direct && conversation?.nativeId && goalSupported && <ChatGoalControl key={conversation.id} conversation={conversation} epoch={snapshot.epoch} refresh={controller.refresh} activityKey={latestGoal ? `${latestGoal.id}:${latestGoal.state}` : undefined}/>}</div>}
        {conversation && !direct && <MessageQueue controller={controller} conversationId={conversation.id} epoch={snapshot.epoch} blocked={!!active || callingHere || conversationWritePending(conversation)} copy={append} historyOpen={queueExpanded} onHistoryToggle={open => { setQueueExpanded(open); if (!open) textarea.current?.focus(); }}/>}
        {showPlanDecision && <PlanReviewDecision review={planReviewController}/>}
        <div className={`composer${showPlanDecision ? ' plan-decision-composer' : ''}`} onDragOver={event => { if (!showPlanDecision && event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (!showPlanDecision && event.dataTransfer.files.length) { event.preventDefault(); if (direct) setNotice('File sources are not enabled for this direct chat. Your existing sources are kept.'); else void attachments.add(event.dataTransfer.files); } }}>
          {((workMode !== 'chat') || active && hasFollowUp) && <div className="composer-mode-row">{workMode !== 'chat' && <button className="work-mode-chip" aria-label={`Turn off ${workMode} mode`} title="Return to Chat" onClick={() => { composerMode.select('chat'); textarea.current?.focus(); }}>{workModes.find(mode => mode.id === workMode)?.label}<X size={13}/></button>}{active && hasFollowUp && <button className="text-button stop-reply" disabled={!active.nativeRunId || !!active.cancelRequested} onClick={() => void cancel()}><Square size={15}/>{active.cancelRequested ? 'Stopping…' : 'Stop reply'}</button>}{updatingResearch && <button className="text-button" onClick={() => setResearchUpdateId(undefined)}>Cancel update</button>}{!direct && active && !updatingResearch && draft.text.trim() && <button className="text-button steer-reply" disabled={dictation.phase !== 'idle' || !!dictation.preview || workMode === 'goal' || busy || conversationWritePending(conversation) || journal.submitBlocked || !!draft.attachments.length || filesPending || active.cancelRequested || !active.nativeRunId} onClick={() => void dispatchDraft('steer')}>Steer current reply</button>}</div>}
          <label className="sr-only" htmlFor="assistant-draft">Message draft</label><textarea rows={1} id="assistant-draft" ref={textarea} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); if (direct) setNotice('File sources are not enabled for this direct chat.'); else void attachments.add(event.clipboardData.files); } }} value={draft.text} maxLength={100000} placeholder={draft.refineSource ? 'What would you like to change in this output?' : controller.space === 'work' ? 'Describe what you want to get done…' : 'Write what’s on your mind…'} onChange={e => editDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); const button = textarea.current?.closest('.composer')?.querySelector<HTMLButtonElement>('.send-button'); if (button && !button.disabled && (primaryAction === 'send' || primaryAction === 'queue')) button.click(); } }}/>
          {attachmentIssue && <p id="assistant-source-issue" className="field-error" role="alert">{attachmentIssue.replace(/ (?:Use TXT, Markdown, JSON, CSV, PDF, PNG, JPEG or WebP\. )?Your draft and saved files are kept\.$/, '')} <button type="button" className="text-button" onClick={() => setSidePanel({ kind: 'sources' })}>Review sources</button></p>}
          {sourceCount > 10 && <p className="field-error" role="alert">{sourceCount} files selected; up to 10 can accompany a message. <button type="button" className="text-button" onClick={() => setSidePanel({ kind: 'sources' })}>Review sources</button></p>}
          <div className="attachment-list">{draft.attachments.map(file => <div className="attachment" key={file.id}><File size={17}/><button type="button" className="text-button attachment-open" title={file.name} onClick={() => openFile(file)}><span>{file.name}</span></button><span className="metadata">{Math.max(1, Math.ceil(file.size / 1024))} KB</span><Check size={15} className="success-text"/><button className="icon-button" aria-label={`Remove ${file.name}`} onClick={() => journal.change(v => { const next = { ...v, attachments: v.attachments.filter(a => a.id !== file.id) }; if (next.refineSource?.sha256 === file.sha256) delete next.refineSource; return next; })}><X size={15}/></button></div>)}{attachments.pending.map(file => <div className="pending-file" key={file.id}><strong>{file.name}</strong><span>{direct ? 'Kept on this device · uploads paused' : attachments.errors[file.id] || 'Kept on this device · uploading…'}</span>{(direct || attachments.errors[file.id]) && <div className="button-row">{!direct && <button onClick={() => void attachments.retry(file)}>Retry upload</button>}<button onClick={() => void attachments.remove(file.id)}>Remove</button></div>}</div>)}</div>
          {attachments.staging && <p className="metadata" role="status">Preparing Files…</p>}
          {attachments.notice && <p className="field-error" role="alert">{attachments.notice}</p>}
          {(dictation.preview || dictation.error) && <div className="dictation-recovery" role="status">{dictation.error && <p>{dictation.error}</p>}{dictation.preview && <details><summary>Recover dictated text</summary><p>{dictation.preview}</p>{dictation.phase === 'idle' && <div className="button-row"><button onClick={async () => { if (dictation.canInsertRecovery) dictation.useText(); else try { await navigator.clipboard.writeText(dictation.preview); setNotice('Transcript copied. Paste the words you need into your draft.'); } catch { setNotice('Copy was unavailable. Select the recovered text to copy it.'); } }}>{dictation.canInsertRecovery ? 'Use transcript' : 'Copy transcript'}</button><button onClick={dictation.discard}>Discard transcript</button></div>}</details>}</div>}
          {!journal.conflict && (journal.storageError || journal.networkError) && <div className="composer-save-error" role="status"><span>{journal.storageError ? 'Draft is only kept in this window. Browser storage is full.' : 'Draft saved on this device. Waiting for connection.'}</span><button className="text-button" disabled={journal.saving} onClick={() => void journal.flush()}>Retry save</button></div>}
          {direct && conversation ? <div className="composer-actions"><DirectAgentAccount conversation={conversation} history={controller.history} operations={operations}/><div className="button-row"><span className="metadata">Text · Read only</span>{!!retainedDispatch && <button disabled={busy} onClick={() => void checkDirectMessage()}>Check Original Message</button>}<button className="primary send-button" aria-label={active ? 'Stop reply' : 'Send message'} disabled={busy || (active ? !active.nativeRunId || !!active.cancelRequested : !ready || !!retainedDispatch || workMode !== 'chat' || journal.submitBlocked || filesPending || !!draft.attachments.length || !draft.text.trim() || conversation.state !== 'ready')} onClick={() => void (active ? cancel() : dispatchDraft('submit'))}>{active ? <Square size={19}/> : <ArrowUp size={19}/>}</button></div></div> : <>
          <div className="composer-actions"><div className="button-row"><input ref={fileInput} className="sr-only" type="file" multiple accept={assistantAttachmentAccept} aria-label="Attach files" tabIndex={-1} onChange={e => { void attachments.add(e.target.files); e.target.value = ''; }}/>
            <ComposerMenu kind="menu" label="Add to message" icon={<Plus size={20}/>}>
              {close => <>
                <button role="menuitem" title="TXT, Markdown, JSON, CSV, PDF, PNG, JPEG or WebP · up to 8 MB each · 10 sources per message" onClick={() => { close(); fileInput.current?.click(); }}><Paperclip size={18}/><span>Attachments</span></button>
                {primaryAction !== 'voice' && <button role="menuitem" disabled={voiceDisabled} onClick={() => { close(); void startVoice(); }}><AudioLines size={18}/><span>Start voice call</span></button>}
                {workModes.filter(mode => mode.id !== 'chat').map(mode => { const Icon = modeIcons[mode.id], unavailable = mode.id === 'goal' && !goalSupported; return <button role="menuitemradio" key={mode.id} className="work-mode-option" disabled={unavailable} title={unavailable ? 'Connect a runtime with Goal support to start an objective.' : undefined} aria-checked={workMode === mode.id} onClick={() => { composerMode.select(mode.id); close(); requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true })); }}><Icon size={18}/><span>{mode.label}</span>{workMode === mode.id && <Check size={16}/>}</button>; })}
              </>}

            </ComposerMenu><ComposerMenu label="Access / permissions" description={`${actualAccess ? accessLabels[actualAccess] : 'Access not confirmed'}${conversation?.pendingSettings?.permissionMode ? '; change awaiting confirmation' : ''}`} icon={<Shield size={20}/>} text={actualAccess ? accessLabels[actualAccess] : 'Access'} className="access-control">{() => <AccessDetails conversation={conversation} preference={accessPreference} blocked={!!active || busy || callingHere || conversationWritePending(conversation)} save={async mode => { if (conversation) return controller.edit(conversation, { permissionMode: mode }); if (!saveLocal(accessKey, mode)) throw Error('The access preference could not be saved.'); setAccessPreference(mode); }}/>}</ComposerMenu></div><div className="composer-tools-right">
            {conversation && !compactComposer && <ComposerMenu label="ChatGPT Account" icon={<UserRound size={20}/>} align="right">{() => <ConversationAccountPanel {...accountControl}/>}</ComposerMenu>}
            <ComposerMenu label="Response settings" description={`${responseName}; ${effortLabel(response.thinking)} reasoning; ${response.fastMode === true ? 'Fast speed' : response.fastMode === false ? 'Standard speed' : response.fastMode === 'auto' ? 'Automatic speed' : 'Default speed'}${conversation?.pendingSettings ? '; change awaiting confirmation' : ''}`} icon={null} text={<><span className="response-model-name">{responseName}</span>{response.thinking && <em>{effortLabel(response.thinking)}</em>}<ChevronDown size={15}/></>} className="response-control" align="right">{() => <><ResponseControls models={controller.models} modelStatus={controller.modelStatus} retryModels={controller.retryModels} value={response} blocked={!!active || callingHere || conversationWritePending(conversation)} save={async next => { if (conversation) return controller.edit(conversation, next); if (!saveLocal(preferencesKey, next)) throw Error('The preferences could not be saved.'); setPreferences(next); }}/>{conversation && compactComposer && <ConversationAccountPanel {...accountControl}/>}</>}</ComposerMenu><button className={`composer-control-button ${dictation.phase !== 'idle' ? 'dictation-active' : ''}`} aria-label={dictationLabel} title={dictationLabel} aria-pressed={dictation.phase !== 'idle'} aria-busy={dictation.phase === 'connecting' || dictation.phase === 'finishing'} disabled={dictation.phase === 'finishing' || (dictation.phase === 'idle' && (callingHere || !ready || !!dictation.preview))} onClick={() => void (dictation.phase === 'idle' ? startDictation() : dictation.phase === 'connecting' ? dictation.cancel() : dictation.stop())}>{dictation.phase === 'idle' ? <Mic size={20}/> : <Square size={20}/>}</button><button className="primary send-button" aria-describedby={primaryAction !== 'voice' && attachmentIssue ? 'assistant-source-issue' : undefined} aria-label={primaryLabel} title={callingHere ? 'End the voice call to continue' : primaryLabel} onClick={() => void (primaryAction === 'voice' ? startVoice() : primaryAction === 'stop' ? cancel() : dispatchDraft(updatingResearch ? 'steer' : primaryAction === 'queue' ? 'queue' : 'submit'))} disabled={primaryAction === 'voice' ? voiceDisabled : primaryAction === 'stop' ? !active?.nativeRunId || !!active?.cancelRequested : !ready || busy || dictation.phase !== 'idle' || !!dictation.preview || (!!conversation && conversation.state !== 'ready') || callingHere || conversationWritePending(conversation) || journal.submitBlocked && !retainedDispatch || filesPending || !!attachmentIssue && !retainedDispatch || sourceCount > 10 || (!draft.text.trim() && (!!conversation?.refineSource || !draft.attachments.length))}>{primaryAction === 'voice' ? <AudioLines size={20}/> : primaryAction === 'stop' ? <Square size={19}/> : primaryAction === 'queue' ? <Queue size={19}/> : <ArrowUp size={19}/>}</button></div></div>
          </>}
          {direct && (workMode !== 'chat' || draft.attachments.length > 0 || filesPending) && <p className="composer-footnote">This direct chat currently accepts text only. Your other mode or sources stay in this draft until you explicitly change them.</p>}
        </div>{!ready && <p className="composer-footnote">{controller.statusRead === 'loading' ? <span role="status">Checking the Assistant connection…</span> : controller.statusRead === 'error' ? <><span role="status">Chat updates paused · your draft is kept.</span><button type="button" className="text-button" onClick={() => void controller.refresh()}>Retry</button></> : <><span>Assistant disconnected · your draft is kept.</span><button type="button" className="text-button" onClick={openSettings}>Connect</button></>}</p>}
      </div>}
    </div>
    {(reading || conversation?.archived) && <VoicePanel appIcon={appIcon} floating controller={voice} openConversation={id => { setReading(null); controller.select(id); }}/> }
    {memorySeed && <Suspense fallback={<LoadingRing label="Opening memory…"/>}><MemoryEditor key={`${snapshot.epoch}:${memorySeed.source.messageId}`} snapshot={snapshot} seed={memorySeed} refresh={controller.refresh} close={() => setMemorySeed(null)}/></Suspense>}
    {continueSaved && conversation && <Suspense fallback={<LoadingRing label="Opening saved transcript…"/>}><ContinueSavedConversation conversationId={conversation.id} snapshot={snapshot} controller={controller} refreshWorkspace={refreshWorkspace} close={() => setContinueSaved(false)}/></Suspense>}
    {!reading && <AssistantActivityPanel key={conversation?.id ?? controller.space} operation={planOperation} open={visibleWorkspace && activityOpen} container={activityContainer} available={setHasLiveView} show={() => setSidePanel({ kind: 'live' })} close={closePanel} stop={() => cancel(true)}/>}
    {!reading && workspace.opened && <AssistantSidePanel tabs={workspace.tabs} active={workspace.active} visible={visibleWorkspace} expanded={workspace.expanded} backLabel={controller.space === 'work' ? 'Back To Work' : 'Back To Chat'} select={id => dispatchWorkspace({ type: 'select', id })} closeTab={id => dispatchWorkspace({ type: 'close', id })} addTab={() => setSidePanel({ kind: 'home' })} expand={() => workspace.dispatch({ type: 'expand', expanded: !workspace.expanded })} close={closePanel} fallbackFocus={panelFocusFallback}>
      {workspace.tabs.map(tab => { const view = tab.view; const output = view.kind === 'file' ? conversationFiles.find(item => item.id === view.outputId && item.version === view.outputVersion) : undefined; return <section key={tab.id} className="workspace-tab-content" role="tabpanel" id={`workspace-view-${tab.id}`} aria-labelledby={`workspace-tab-${tab.id}`} hidden={workspace.active !== tab.id}>
        {view.kind === 'projects' && panelVisible && (workspace.active === tab.id || selectedView.kind === 'file' && selectedView.returnTabId === tab.id) && <ProjectManager snapshot={snapshot} conversations={controller.conversations} draftId={draftId} conversationId={conversation?.id ?? null} space={controller.space} request={view.request} openFile={(file, projectId) => openFile(file, undefined, tab.id, projectId)} refresh={refreshWorkspace} close={closePanel}/>}
        {view.kind === 'home' && <div className="assistant-workspace-launcher"><button onClick={() => manageProjects()}><Folder size={20}/>Projects</button><button onClick={openTeam}><Folder size={20}/>Team work</button><button onClick={()=>setSidePanel({kind:"browser"})}><Device size={20}/>Browser</button>{openChanges && <button onClick={openChanges}><List size={20}/>Review</button>}{hasLiveView && <button onClick={() => setSidePanel({ kind: 'live' })}><Device size={20}/>Live tool view</button>}<button onClick={openFiles}><Folder size={20}/>Files</button></div>}
        {view.kind === 'sources' && <ConversationSources operationId={view.operationId} openFile={file => openFile(file, undefined, tab.id)} memory={controller.memory} operations={operations} conversation={conversation} snapshot={snapshot} draft={draft} editProject={editProject}/>}
        {view.kind === 'cleanup' && <ConversationCleanupPanel epoch={snapshot.epoch} deviceId={snapshot.deviceId} conversations={controller.conversations} currentScope={{ space: controller.space, folder: folder === 'archive' ? 'archived' : folder, query: '' }} active={visibleWorkspace && workspace.active === tab.id} refresh={() => controller.refresh()}/>}
        {view.kind === 'history' && <AssistantRunHistory operations={operations} controller={controller} conversation={conversation} epoch={snapshot.epoch} openSources={operationId => setSidePanel({ kind: 'sources', operationId })} returnToQuestion={returnToQuestion}/>}
        {view.kind === 'files' && <ConversationFiles outputs={conversationFiles} sourceFiles={sourceFiles} openFile={(file, output) => openFile(file, output, tab.id)} addFiles={addFiles}/>}
        {view.kind === 'plan' && (() => { const item = controller.plans?.find(item => item.id === view.planId && item.conversationId === conversation?.id && item.epoch === snapshot.epoch); return item ? <PlanReviewDocument key={`${item.id}:${item.version}`} item={item}/> : <Empty title="Plan unavailable">Return to the conversation to review the latest saved plan.</Empty>; })()}
        {view.kind === "team" && <Suspense fallback={<LoadingRing label="Opening team work…"/>}><TeamWorkPanel openProjects={newProject} snapshot={snapshot} projectId={project?.value.space === 'work' && project.value.workspace?.environment === 'local' ? project.id : undefined} openConversation={id=>controller.select(id,"work")} active={visibleWorkspace && workspace.active===tab.id}/></Suspense>}
        {view.kind === "browser" && <Suspense fallback={<LoadingRing label="Opening browser…"/>}><HostBrowserPanel epoch={snapshot.epoch} active={visibleWorkspace && workspace.active===tab.id}/></Suspense>}
        {view.kind === 'changes' && conversation && <Suspense fallback={<LoadingRing label="Opening changes…"/>}><WorkProjectChanges conversation={conversation} epoch={snapshot.epoch}/></Suspense>}
        {view.kind === 'live' && <div ref={setActivityContainer} className="workspace-live-container"/>}
        {view.kind === 'file' && <><div className="workspace-file-toolbar"><button className="text-button workspace-file-return" onClick={() => { const origin = filePreviewReturn(workspace, view); if (origin?.view.kind === 'projects' && view.returnProjectId) manageProjects({ kind: 'project', id: view.returnProjectId, tab: 'sources' }); else if (origin) dispatchWorkspace({ type: 'select', id: origin.id }); else closePanel(); }}>Back To {(() => { const origin = filePreviewReturn(workspace, view); return origin ? viewTitle(origin.view) : 'Conversation'; })()}</button><span title={view.file.name}>{view.file.name}</span><a className="icon-button output-download" aria-label="Download file" title="Download file" href={`/api/attachments/${view.file.id}`}><Download size={18}/></a></div><Suspense fallback={<LoadingRing label="Opening file…"/>}><AssistantFilePreview file={view.file}/></Suspense>{output && <div className="button-row"><button disabled={!!active || !!conversation?.archived} onClick={() => void refine(output)}>Refine</button><UseOutputInContent output={output} {...contentActions}/></div>}</>}
      </section>; })}
    </AssistantSidePanel>}
    {contextDialog && <Dialog title={contextDialog.kind === 'memory' ? 'Saved memories' : 'Technical details'} close={() => setContextDialog(null)}>
      {contextDialog.kind === 'memory' && <Suspense fallback={<LoadingRing label="Opening memories…"/>}><MemoryPanel memory={controller.memory} snapshot={snapshot} refresh={controller.refresh} openSource={target => { if (setReading(target)) setContextDialog(null); }}/></Suspense>}
      {contextDialog.kind === 'technical' && conversation && <><p>Conversation: {conversation.id}</p><p>Native session: {conversation.nativeId ?? 'Unconfirmed'}</p><p>Revision: {conversation.revision}</p><p>Model: {operations.find(op => op.effectiveModel)?.effectiveModel ?? conversation.model ?? 'Host default'}</p></>}
    </Dialog>}
    {dialog === 'settings' && (managedId ? controller.conversations.find(c => c.id === managedId) : conversation) && <ConversationSettings snapshot={snapshot} controller={controller} conversation={(managedId ? controller.conversations.find(c => c.id === managedId) : conversation)!} close={() => { setManagedId(null); setDialog(null); }}/>}
  </div>;
}
function ReplyOutput({ open, message, conversation, controller, blocked, refine, contentActions }: { open: (file: Attachment, output?: AssistantOutput) => void; contentActions: ContentOutputActions; message: ConversationMessage; conversation: Conversation; controller: AssistantController; blocked: boolean; refine: (output: AssistantOutput) => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const output = savedMessageOutput(controller.outputs, conversation, message);
  const save = async () => { setBusy(true); setError(''); try { await controller.saveOutput(conversation, message, conversation.title); } catch (e) { setError(e instanceof Error ? e.message : 'The output save was not confirmed.'); } finally { setBusy(false); } };
  return <div className="reply-output">{output?.file ? <><button className="text-button" onClick={() => open(output.file!, output)}><File size={16}/>{output.name}<span>v{output.version}</span></button><button disabled={busy || blocked || conversation.archived} onClick={() => void refine(output)}>Refine</button><UseOutputInContent key={`${contentActions.snapshot.epoch}:${output.id}:${output.version}`} output={output} {...contentActions}/><span className="metadata">Original version kept</span></> : <button className="text-button" disabled={busy || blocked} onClick={() => void save()}><Download size={15}/>{busy ? 'Saving document…' : 'Save as document'}</button>}{error && <p className="field-error" role="alert">{error}</p>}</div>;
}
