import { getInboxMailApi, captureInboxMailScope, subscribeInboxMailScope } from '../../inbox-transport';

export type NativeMailIndexProvider = 'gmail' | 'microsoft';
export type NativeMailIndexStatus = 'idle' | 'indexing' | 'paused' | 'complete' | 'error';

export interface NativeMailIndexThread {
  id: string;
  sourceMessageId?: string;
  subject: string;
  from: string;
  date: string;
  labels: string[];
  providerTags: string[];
  messageCount: number;
  category: string;
  summary: string;
  latestBody: string;
  latestSnippet: string;
  attentionScore: number;
}

export interface NativeMailIndexSnapshot {
  schemaVersion: 1;
  /** Monotonic within the current Nova Dream account generation. */
  indexRevision?: number;
  provider: NativeMailIndexProvider;
  accountId: string;
  query: 'inbox';
  microsoftIdType?: 'immutable';
  status: NativeMailIndexStatus;
  threads: NativeMailIndexThread[];
  nextCursor?: string;
  exhausted: boolean;
  totalMessageCount?: number;
  totalThreadCount?: number;
  pagesIndexed: number;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  lastSuccessfulPageAt?: string;
  error?: string;
}

function getApi() {
  return getInboxMailApi()?.mailIndex;
}

export function isNativeMailIndexAvailable(): boolean {
  return Boolean(getApi());
}

export async function getNativeMailIndexSnapshot(
  provider: NativeMailIndexProvider,
  accountId: string,
): Promise<NativeMailIndexSnapshot | null> {
  const api = getApi();
  if (!api) return null;
  const scope = captureInboxMailScope();
  const result = await api.getSnapshot({ provider, accountId });
  scope.assertCurrent();
  if (!result.success) throw new Error(result.error || 'The local mail index could not be opened.');
  return result.snapshot || null;
}

export async function syncNativeMailIndex(
  provider: NativeMailIndexProvider,
  accountId: string,
  mode: 'resume' | 'refresh' | 'rebuild' = 'resume',
): Promise<NativeMailIndexSnapshot | null> {
  const api = getApi();
  if (!api) return null;
  const scope = captureInboxMailScope();
  const result = await api.sync({ provider, accountId, mode });
  scope.assertCurrent();
  if (!result.success) throw new Error(result.error || 'Mail indexing could not be started.');
  return result.snapshot || null;
}

export async function pauseNativeMailIndex(
  provider: NativeMailIndexProvider,
  accountId: string,
): Promise<NativeMailIndexSnapshot | null> {
  const api = getApi();
  if (!api) return null;
  const scope = captureInboxMailScope();
  const result = await api.pause({ provider, accountId });
  scope.assertCurrent();
  if (!result.success) throw new Error(result.error || 'Mail indexing could not be paused.');
  return result.snapshot || null;
}

export function subscribeNativeMailIndex(
  callback: (snapshot: NativeMailIndexSnapshot) => void,
): () => void {
  const api = getApi();
  if (!api) return () => undefined;
  const scope = captureInboxMailScope();
  const stop = api.onProgress(snapshot => { scope.assertCurrent(); callback(snapshot); });
  const stopScope = subscribeInboxMailScope(stop);
  return () => { stop(); stopScope(); };
}
