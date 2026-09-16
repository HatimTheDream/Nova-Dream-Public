export type InboxStartupProgress = { phase: 'accounts' | 'mailboxes' | 'messages' | 'ready'; completed: number; total?: number };

export function inboxStartupView(progress: InboxStartupProgress) {
  const detail = { accounts: 'Checking your mail accounts…', mailboxes: 'Preparing your mailboxes…', messages: 'Preparing recent messages…', ready: 'Your workspace is ready.' }[progress.phase];
  const amount = progress.phase === 'accounts' ? 'Waiting for mail accounts' : progress.phase === 'ready' ? 'Inbox preparation complete' : `${progress.completed} of ${progress.total ?? 0} ${progress.phase === 'mailboxes' ? 'mailboxes checked' : 'recent messages'}`;
  const percent = progress.phase === 'ready' ? 100 : progress.total ? Math.floor(progress.completed / progress.total * 100) : undefined;
  return { detail, amount, percent };
}

/** Report settled message preparation, not requests merely put into a queue. */
export async function prepareRecentMessages<T>(items: T[], prepare: (item: T) => Promise<void>, report: (progress: InboxStartupProgress) => void) {
  let next = 0, completed = 0;
  report({ phase: 'messages', completed, total: items.length });
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await prepare(item);
      report({ phase: 'messages', completed: ++completed, total: items.length });
    }
  };
  await Promise.all([worker(), worker()]);
}
