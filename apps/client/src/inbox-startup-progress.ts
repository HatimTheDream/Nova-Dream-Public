export type InboxStartupProgress = { phase: 'accounts' | 'mailboxes' | 'messages' | 'ready'; completed: number; total?: number };

/** One preparation pass across accounts, first pages and settled messages. */
export function inboxLoadingPercent(progress: InboxStartupProgress) {
  if (progress.phase === 'ready') return 100;
  const fraction = progress.total ? Math.min(1, Math.max(0, progress.completed / progress.total)) : 0;
  if (progress.phase === 'accounts') return 0;
  if (progress.phase === 'mailboxes') return Math.floor(5 + 15 * fraction);
  return Math.floor(20 + 79 * fraction);
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
