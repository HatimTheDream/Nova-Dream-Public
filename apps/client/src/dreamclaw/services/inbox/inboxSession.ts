import { subscribeInboxMailScope } from '../../inbox-transport';
import { create } from 'zustand';
import {
  buildNativeGmailSummaryDigests,
  getNativeGmailInboxStats,
  getNativeGmailStatus,
  type NativeGmailAccountStatus,
  type NativeGmailSendAsAlias,
  type NativeGmailThreadDigest,
  type NativeGmailThreadMessageView,
} from '@dreamclaw/services/native/gmail';
import {
  buildNativeMicrosoftMailboxSnapshot,
  getNativeMicrosoftMailStatus,
  type NativeMicrosoftMailAccountStatus,
  type NativeMicrosoftMailMessageView,
} from '@dreamclaw/services/native/microsoftMail';
import {
  getNativeMailIndexSnapshot,
  isNativeMailIndexAvailable,
  subscribeNativeMailIndex,
  syncNativeMailIndex,
  type NativeMailIndexSnapshot,
  type NativeMailIndexStatus,
} from '@dreamclaw/services/native/mailIndex';
import {
  gmailQueryForInboxFolder,
  microsoftFolderForInboxFolder,
  type InboxMailFolder,
} from '@dreamclaw/services/inbox/mailWorkspace';
import type { InboxThreadSelection } from '@dreamclaw/services/inbox/selectionAfterMutation';

export type InboxProvider = 'gmail' | 'microsoft';
export type InboxThreadDigest = Pick<
  NativeGmailThreadDigest,
  'id' | 'sourceMessageId' | 'subject' | 'from' | 'date' | 'labels' | 'messageCount' | 'category' | 'summary' | 'latestBody' | 'latestSnippet' | 'attentionScore' | 'providerTags'
>;
export type InboxThreadMessageView = NativeGmailThreadMessageView | NativeMicrosoftMailMessageView;

export interface InboxAccount {
  generation: string;
  provider: InboxProvider;
  key: string;
  accountId: string;
  email: string;
  label: string;
  signatureText?: string;
  canRead: boolean;
  canSend: boolean;
  canDraft: boolean;
  canModify: boolean;
  supportsSignature: boolean;
}

export interface InboxAccountSnapshot {
  provider: InboxProvider;
  account: InboxAccount;
  threads: InboxThreadDigest[];
  truncated: boolean;
  totalMessageCount?: number;
  totalThreadCount?: number;
  microsoftIdType?: 'immutable';
  indexStatus?: NativeMailIndexStatus;
  indexRevision?: number;
  indexUpdatedAt?: string;
  indexError?: string;
  pagesIndexed?: number;
}

export interface InboxReaderSession {
  loadKey: string | null;
  threadKey: string | null;
  status: 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';
  messages: InboxThreadMessageView[];
  sendAsAliases: NativeGmailSendAsAlias[];
  selectedFrom: string;
  microsoftSignatureDraft: string;
  error: string | null;
}

interface InboxFolderSession {
  snapshots: InboxAccountSnapshot[];
  loading: boolean;
  refreshing: boolean;
  loaded: boolean;
  error: string | null;
  lastLoadedAt: number | null;
  selectedThread: InboxThreadSelection | null;
  reader: InboxReaderSession;
}

interface InboxSessionState {
  folders: Record<InboxMailFolder, InboxFolderSession>;
  scrollPositions: Record<InboxMailFolder, InboxScrollPosition>;
  gmailAccounts: NativeGmailAccountStatus[];
  microsoftAccounts: NativeMicrosoftMailAccountStatus[];
  microsoftClientConfigured: boolean;
}

export interface InboxScrollPosition {
  listTop: number;
  readerTop: number;
  readerLoadKey: string | null;
}

type StateUpdate<T> = T | ((current: T) => T);

export const INBOX_STARTUP_WAIT_MS = 8_000;
const INBOX_INITIAL_THREADS = 25;
const INBOX_PANEL_PROMPT = 'INBOX_TRIAGE_PANEL';

function createReaderSession(): InboxReaderSession {
  return {
    loadKey: null,
    threadKey: null,
    status: 'idle',
    messages: [],
    sendAsAliases: [],
    selectedFrom: '',
    microsoftSignatureDraft: '',
    error: null,
  };
}

function createFolderSession(): InboxFolderSession {
  return {
    snapshots: [],
    loading: false,
    refreshing: false,
    loaded: false,
    error: null,
    lastLoadedAt: null,
    selectedThread: null,
    reader: createReaderSession(),
  };
}

function createScrollPosition(): InboxScrollPosition {
  return { listTop: 0, readerTop: 0, readerLoadKey: null };
}

export const useInboxSessionStore = create<InboxSessionState>(() => ({
  folders: {
    inbox: createFolderSession(),
    sent: createFolderSession(),
    drafts: createFolderSession(),
    archive: createFolderSession(),
    trash: createFolderSession(),
  },
  scrollPositions: {
    inbox: createScrollPosition(),
    sent: createScrollPosition(),
    drafts: createScrollPosition(),
    archive: createScrollPosition(),
    trash: createScrollPosition(),
  },
  gmailAccounts: [],
  microsoftAccounts: [],
  microsoftClientConfigured: false,
}));

export function getInboxScrollPosition(folder: InboxMailFolder): InboxScrollPosition {
  return useInboxSessionStore.getState().scrollPositions[folder];
}

export function setInboxScrollPosition(folder: InboxMailFolder, patch: Partial<InboxScrollPosition>): void {
  useInboxSessionStore.setState((state) => ({
    scrollPositions: {
      ...state.scrollPositions,
      [folder]: { ...state.scrollPositions[folder], ...patch },
    },
  }));
}

function updateFolder(folder: InboxMailFolder, updater: (current: InboxFolderSession) => InboxFolderSession): void {
  useInboxSessionStore.setState((state) => ({
    folders: {
      ...state.folders,
      [folder]: updater(state.folders[folder]),
    },
  }));
}

export function setInboxFolderSnapshots(
  folder: InboxMailFolder,
  update: StateUpdate<InboxAccountSnapshot[]>,
): void {
  updateFolder(folder, (current) => ({
    ...current,
    snapshots: typeof update === 'function' ? update(current.snapshots) : update,
  }));
}

export function setInboxFolderError(folder: InboxMailFolder, error: string | null): void {
  updateFolder(folder, (current) => ({ ...current, error }));
}

export function setInboxSelectedThread(
  folder: InboxMailFolder,
  update: StateUpdate<InboxThreadSelection | null>,
): void {
  updateFolder(folder, (current) => ({
    ...current,
    selectedThread: typeof update === 'function' ? update(current.selectedThread) : update,
  }));
}

export function setInboxReaderSession(folder: InboxMailFolder, reader: InboxReaderSession): void {
  updateFolder(folder, (current) => ({ ...current, reader }));
}

export function patchInboxReaderSession(folder: InboxMailFolder, patch: Partial<InboxReaderSession>): void {
  updateFolder(folder, (current) => ({
    ...current,
    reader: { ...current.reader, ...patch },
  }));
}

export function clearInboxReaderSession(folder: InboxMailFolder): void {
  setInboxReaderSession(folder, createReaderSession());
}

export function setInboxMicrosoftAccounts(update: StateUpdate<NativeMicrosoftMailAccountStatus[]>): void {
  useInboxSessionStore.setState((state) => ({
    microsoftAccounts: typeof update === 'function' ? update(state.microsoftAccounts) : update,
  }));
}

export function accountSnapshotFromIndex(
  account: InboxAccount,
  snapshot: NativeMailIndexSnapshot,
): InboxAccountSnapshot {
  return {
    provider: account.provider,
    account,
    threads: snapshot.threads,
    truncated: !snapshot.exhausted,
    totalMessageCount: snapshot.totalMessageCount,
    totalThreadCount: snapshot.totalThreadCount,
    microsoftIdType: snapshot.microsoftIdType,
    indexStatus: snapshot.status,
    indexRevision: snapshot.indexRevision,
    indexUpdatedAt: snapshot.updatedAt,
    indexError: snapshot.error,
    pagesIndexed: snapshot.pagesIndexed,
  };
}

export function mergeInboxAccountSnapshot(
  current: InboxAccountSnapshot | undefined,
  incoming: InboxAccountSnapshot,
): InboxAccountSnapshot {
  if (!current) return incoming;
  const byId = new Map(current.threads.map((thread) => [thread.id, thread]));
  for (const thread of incoming.threads) byId.set(thread.id, thread);
  return {
    ...current,
    ...incoming,
    threads: [...byId.values()].sort(
      (a, b) => (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0) || b.attentionScore - a.attentionScore,
    ),
    totalMessageCount: incoming.totalMessageCount ?? current.totalMessageCount,
    totalThreadCount: incoming.totalThreadCount ?? current.totalThreadCount,
  };
}

export function reconcileInboxAccountSnapshots(
  current: InboxAccountSnapshot[],
  incoming: InboxAccountSnapshot[],
  accounts: InboxAccount[],
  mergeIncoming = false,
): InboxAccountSnapshot[] {
  const allowedKeys = new Set(accounts.map((account) => account.key));
  const generations = new Map(accounts.map(account => [account.key, account.generation]));
  const byKey = new Map(
    current
      .filter((snapshot) => allowedKeys.has(snapshot.account.key) && generations.get(snapshot.account.key) === snapshot.account.generation)
      .map((snapshot) => [snapshot.account.key, snapshot]),
  );
  for (const snapshot of incoming) {
    if (!allowedKeys.has(snapshot.account.key) || generations.get(snapshot.account.key) !== snapshot.account.generation) continue;
    const previous = byKey.get(snapshot.account.key);
    if (previous?.indexRevision !== undefined && snapshot.indexRevision !== undefined && previous.indexRevision > snapshot.indexRevision) continue;
    byKey.set(
      snapshot.account.key,
      mergeIncoming ? mergeInboxAccountSnapshot(byKey.get(snapshot.account.key), snapshot) : snapshot,
    );
  }
  return accounts.flatMap((account) => {
    const snapshot = byKey.get(account.key);
    return snapshot ? [snapshot] : [];
  });
}

function isPresentObject<T extends object>(value: T | null | undefined): value is T {
  return Boolean(value && typeof value === 'object');
}

function inboxAccountFromGmail(account: NativeGmailAccountStatus): InboxAccount {
  return {
    provider: 'gmail',
    key: `gmail:${account.id}`,
    accountId: account.id,
    generation: account.generation,
    email: account.email,
    label: account.email,
    signatureText: '',
    canRead: account.canRead,
    canSend: account.canSend,
    canDraft: account.canDraft,
    canModify: account.canModify,
    supportsSignature: true,
  };
}

function inboxAccountFromMicrosoft(account: NativeMicrosoftMailAccountStatus): InboxAccount {
  return {
    provider: 'microsoft',
    key: `microsoft:${account.id}`,
    generation: account.generation,
    accountId: account.id,
    email: account.email,
    label: account.displayName ? `${account.displayName} <${account.email}>` : account.email,
    signatureText: account.signatureText || '',
    canRead: account.canRead,
    canSend: account.canSend,
    canDraft: account.canDraft,
    canModify: account.canModify,
    supportsSignature: true,
  };
}

function currentAccounts(): InboxAccount[] {
  const state = useInboxSessionStore.getState();
  return [
    ...state.gmailAccounts.map(inboxAccountFromGmail),
    ...state.microsoftAccounts.map(inboxAccountFromMicrosoft),
  ];
}

let indexUnsubscribe: (() => void) | null = null;

function ensureIndexSubscription(): void {
  if (indexUnsubscribe || !isNativeMailIndexAvailable()) return;
  indexUnsubscribe = subscribeNativeMailIndex((snapshot) => {
    const account = currentAccounts().find((candidate) => (
      candidate.provider === snapshot.provider && candidate.accountId === snapshot.accountId
    ));
    if (!account) return;
    const incoming = accountSnapshotFromIndex(account, snapshot);
    updateFolder('inbox', (current) => {
      const byKey = new Map(current.snapshots.map((item) => [item.account.key, item]));
      const previous = byKey.get(account.key);
      if (previous?.indexRevision !== undefined && incoming.indexRevision !== undefined && previous.indexRevision > incoming.indexRevision) return current;
      byKey.set(account.key, incoming);
      return {
        ...current,
        snapshots: [...byKey.values()],
        loading: false,
        refreshing: false,
        loaded: true,
        error: null,
        lastLoadedAt: Date.now(),
      };
    });
  });
}

const activeLoads = new Map<InboxMailFolder, Promise<void>>();
const queuedForcedLoads = new Map<InboxMailFolder, Promise<void>>();
const loadGenerations = new Map<InboxMailFolder, number>();

function loadGenerationIsCurrent(folder: InboxMailFolder, generation: number): boolean {
  return loadGenerations.get(folder) === generation;
}

function updateFolderForGeneration(
  folder: InboxMailFolder,
  generation: number,
  updater: (current: InboxFolderSession) => InboxFolderSession,
): void {
  if (!loadGenerationIsCurrent(folder, generation)) return;
  updateFolder(folder, updater);
}

async function performInboxFolderLoad(
  folder: InboxMailFolder,
  options: { force: boolean; maxThreads: number },
  generation: number,
): Promise<void> {
  const existing = useInboxSessionStore.getState().folders[folder];
  updateFolderForGeneration(folder, generation, (current) => ({
    ...current,
    loading: current.snapshots.length === 0,
    refreshing: current.snapshots.length > 0,
    error: null,
  }));

  try {
    const [gmailStatus, microsoftStatus] = await Promise.all([
      getNativeGmailStatus(options.force),
      getNativeMicrosoftMailStatus(options.force),
    ]);
    if (!loadGenerationIsCurrent(folder, generation)) return;
    const readableGmail = (gmailStatus.accounts || []).filter((account) => isPresentObject(account) && account.canRead);
    const readableMicrosoft = (microsoftStatus.accounts || []).filter((account) => isPresentObject(account) && account.canRead);
    useInboxSessionStore.setState({
      gmailAccounts: readableGmail,
      microsoftAccounts: readableMicrosoft,
      microsoftClientConfigured: Boolean(microsoftStatus.clientConfigured),
    });

    const gmailAccounts = readableGmail.map(inboxAccountFromGmail);
    const microsoftAccounts = readableMicrosoft.map(inboxAccountFromMicrosoft);
    const allAccounts = [...gmailAccounts, ...microsoftAccounts];
    if (allAccounts.length === 0) {
      updateFolderForGeneration(folder, generation, (current) => ({
        ...current,
        snapshots: [],
        loading: false,
        refreshing: false,
        loaded: true,
        error: 'No readable mail account is connected.',
        lastLoadedAt: Date.now(),
      }));
      return;
    }

    if (isNativeMailIndexAvailable() && folder === 'inbox') {
      ensureIndexSubscription();
      const cachedResults = await Promise.allSettled(allAccounts.map(async (account) => ({
        account,
        snapshot: await getNativeMailIndexSnapshot(account.provider, account.accountId),
      })));
      const cachedSnapshots = cachedResults.flatMap((result) => (
        result.status === 'fulfilled' && result.value.snapshot
          ? [accountSnapshotFromIndex(result.value.account, result.value.snapshot)]
          : []
      ));
      if (cachedSnapshots.length > 0) {
        updateFolderForGeneration('inbox', generation, (current) => ({
          ...current,
          snapshots: reconcileInboxAccountSnapshots(current.snapshots, cachedSnapshots, allAccounts),
          loading: false,
          refreshing: true,
          loaded: true,
        }));
      }

      const cachedByKey = new Map(cachedSnapshots.map((snapshot) => [snapshot.account.key, snapshot]));
      const syncResults = await Promise.allSettled(allAccounts.map(async (account) => {
        const cached = cachedByKey.get(account.key);
        if (!options.force && cached?.indexStatus === 'paused') return { account, snapshot: await getNativeMailIndexSnapshot(account.provider, account.accountId) };
        const needsOutlookIdMigration = account.provider === 'microsoft'
          && cached !== undefined
          && (
            cached.microsoftIdType !== 'immutable'
            || cached.threads.some((thread) => !thread.sourceMessageId)
          );
        const mode = needsOutlookIdMigration
          ? 'rebuild'
          : cached?.indexStatus === 'complete'
            ? 'refresh'
            : 'resume';
        return {
          account,
          snapshot: await syncNativeMailIndex(account.provider, account.accountId, mode),
        };
      }));
      const startedSnapshots = syncResults.flatMap((result) => (
        result.status === 'fulfilled' && result.value.snapshot
          ? [accountSnapshotFromIndex(result.value.account, result.value.snapshot)]
          : []
      ));
      updateFolderForGeneration(folder, generation, (current) => {
        const snapshots = reconcileInboxAccountSnapshots(
          current.snapshots,
          startedSnapshots.length > 0 ? startedSnapshots : cachedSnapshots,
          allAccounts,
        );
        return {
          ...current,
          snapshots,
          loading: false,
          refreshing: false,
          loaded: true,
          error: syncResults.some(result => result.status === 'rejected')
            ? 'Some mail indexes could not refresh. Saved mail remains available; refresh to retry.'
            : null,
          lastLoadedAt: Date.now(),
        };
      });
      return;
    }

    const gmailById = new Map(gmailAccounts.map((account) => [account.accountId, account]));
    const microsoftById = new Map(microsoftAccounts.map((account) => [account.accountId, account]));
    const results = await Promise.allSettled([
      ...readableGmail.map(async (account): Promise<InboxAccountSnapshot> => {
        const [summary, stats] = await Promise.all([
          buildNativeGmailSummaryDigests(gmailQueryForInboxFolder(folder), {
            account: account.id,
            maxThreads: options.maxThreads,
            prompt: INBOX_PANEL_PROMPT,
          }),
          folder === 'inbox'
            ? getNativeGmailInboxStats({ account: account.id })
            : Promise.resolve({ success: false, messagesTotal: undefined, threadsTotal: undefined }),
        ]);
        return {
          provider: 'gmail',
          account: gmailById.get(account.id)!,
          threads: summary.threads,
          truncated: summary.truncated,
          indexError: summary.warning,
          totalMessageCount: stats.success ? stats.messagesTotal : undefined,
          totalThreadCount: stats.success ? stats.threadsTotal : undefined,
        };
      }),
      ...readableMicrosoft.map(async (account): Promise<InboxAccountSnapshot> => {
        const snapshot = await buildNativeMicrosoftMailboxSnapshot({
          accountId: account.id,
          folder: microsoftFolderForInboxFolder(folder),
          force: options.force,
          maxThreads: options.maxThreads,
          unreadOnly: false,
        });
        return {
          provider: 'microsoft',
          account: microsoftById.get(account.id)!,
          threads: snapshot.threads,
          truncated: snapshot.truncated,
          indexError: snapshot.warning,
          totalMessageCount: snapshot.totalItemCount,
          microsoftIdType: 'immutable',
        };
      }),
    ]);
    const nextSnapshots = results
      .filter((result): result is PromiseFulfilledResult<InboxAccountSnapshot> => result.status === 'fulfilled')
      .map((result) => result.value);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    updateFolderForGeneration(folder, generation, (current) => {
      const snapshots = reconcileInboxAccountSnapshots(current.snapshots, nextSnapshots, allAccounts);
      return {
        ...current,
        snapshots,
        loading: false,
        refreshing: false,
        loaded: true,
        error: failures.length > 0 ? failures[0] : null,
        lastLoadedAt: Date.now(),
      };
    });
  } catch (error) {
    updateFolderForGeneration(folder, generation, (current) => ({
      ...current,
      loading: false,
      refreshing: false,
      loaded: current.loaded || existing.loaded || current.snapshots.length > 0,
      error: error instanceof Error ? error.message : 'Inbox load failed.',
    }));
  }
}

export function loadInboxFolder(
  folder: InboxMailFolder,
  options: { force?: boolean; maxThreads?: number } = {},
): Promise<void> {
  const force = options.force === true;
  const current = useInboxSessionStore.getState().folders[folder];
  if (!force && current.loaded) return Promise.resolve();
  const active = activeLoads.get(folder);
  if (active) {
    if (!force) return active;
    const queued = queuedForcedLoads.get(folder);
    if (queued) return queued;
    const queuedSession = sessionRevision;
    let queuedRequest: Promise<void>;
    queuedRequest = active
      .catch(() => undefined)
      .then(() => queuedSession === sessionRevision ? loadInboxFolder(folder, { ...options, force: true }) : undefined)
      .finally(() => {
        if (queuedForcedLoads.get(folder) === queuedRequest) queuedForcedLoads.delete(folder);
      });
    queuedForcedLoads.set(folder, queuedRequest);
    return queuedRequest;
  }

  const generation = (loadGenerations.get(folder) || 0) + 1;
  loadGenerations.set(folder, generation);
  let request: Promise<void>;
  request = performInboxFolderLoad(folder, {
    force,
    maxThreads: Math.max(1, options.maxThreads ?? INBOX_INITIAL_THREADS),
  }, generation).finally(() => {
    if (activeLoads.get(folder) === request) activeLoads.delete(folder);
  });
  activeLoads.set(folder, request);
  return request;
}

let initialized = false;
let startupLoad: Promise<void> | null = null;

/** Warm the shared Inbox list while the lightweight startup window is visible. */
export function initializeInboxSession(): Promise<void> {
  if (initialized) return startupLoad || Promise.resolve();
  initialized = true;
  startupLoad = loadInboxFolder('inbox', { maxThreads: INBOX_INITIAL_THREADS });
  return startupLoad;
}

/** Keep startup bounded when an account provider or local mail index is slow. */
export function waitForInboxStartup(maxWaitMs = INBOX_STARTUP_WAIT_MS): Promise<void> {
  const warmup = initializeInboxSession();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, Math.max(0, maxWaitMs));
    void warmup.then(finish, finish);
  });
}

// Retained reading/scroll belongs to one workspace/account generation. This does
// not touch kept compose/reply journals; those require explicit recovery review.
let sessionRevision = 0;
subscribeInboxMailScope(() => {
  sessionRevision += 1;
  indexUnsubscribe?.(); indexUnsubscribe = null;
  activeLoads.clear(); queuedForcedLoads.clear();
  const folders = useInboxSessionStore.getState().folders;
  for (const folder of Object.keys(folders) as InboxMailFolder[]) loadGenerations.set(folder, (loadGenerations.get(folder) ?? 0) + 1);
  useInboxSessionStore.setState({
    folders: Object.fromEntries(Object.keys(folders).map(folder => [folder, createFolderSession()])) as InboxSessionState['folders'],
    scrollPositions: Object.fromEntries(Object.keys(folders).map(folder => [folder, createScrollPosition()])) as InboxSessionState['scrollPositions'],
    gmailAccounts: [], microsoftAccounts: [], microsoftClientConfigured: false,
  });
  initialized = false; startupLoad = null;
});
