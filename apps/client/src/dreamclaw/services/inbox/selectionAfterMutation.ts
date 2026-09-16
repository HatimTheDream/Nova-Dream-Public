export interface InboxSelectableThread {
  provider: 'gmail' | 'microsoft';
  accountKey: string;
  id: string;
}

export interface InboxThreadSelection {
  provider: 'gmail' | 'microsoft';
  accountKey: string;
  threadId: string;
}

export function inboxMutationThreadKey(thread: Pick<InboxSelectableThread, 'accountKey' | 'id'>): string {
  return `${thread.accountKey}:${thread.id}`;
}

function selectionKey(selection: InboxThreadSelection): string {
  return `${selection.accountKey}:${selection.threadId}`;
}

function toSelection(thread: InboxSelectableThread | undefined): InboxThreadSelection | null {
  return thread
    ? { provider: thread.provider, accountKey: thread.accountKey, threadId: thread.id }
    : null;
}

export function selectInboxThreadAfterRemoval(
  threads: readonly InboxSelectableThread[],
  current: InboxThreadSelection | null,
  removedThreadKeys: ReadonlySet<string>,
): InboxThreadSelection | null {
  const visibleThreads = threads.filter((thread) => !removedThreadKeys.has(inboxMutationThreadKey(thread)));
  if (!current) return toSelection(visibleThreads[0]);

  const currentKey = selectionKey(current);
  if (!removedThreadKeys.has(currentKey) && visibleThreads.some((thread) => inboxMutationThreadKey(thread) === currentKey)) {
    return current;
  }

  const currentIndex = threads.findIndex((thread) => inboxMutationThreadKey(thread) === currentKey);
  if (currentIndex >= 0) {
    const next = threads.slice(currentIndex + 1).find((thread) => !removedThreadKeys.has(inboxMutationThreadKey(thread)));
    if (next) return toSelection(next);
    const previous = threads.slice(0, currentIndex).reverse().find((thread) => !removedThreadKeys.has(inboxMutationThreadKey(thread)));
    if (previous) return toSelection(previous);
  }

  return toSelection(visibleThreads[0]);
}
