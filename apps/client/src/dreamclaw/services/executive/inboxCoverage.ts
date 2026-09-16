export interface InboxCoverageAccount {
  loadedCount: number;
  totalMessageCount?: number;
  totalThreadCount?: number;
  truncated: boolean;
}

export interface InboxCoverageSummary {
  loadedConversations: number;
  messageCount: number;
  messageCountIsExact: boolean;
  hasMore: boolean;
}

export function summarizeInboxCoverage(accounts: InboxCoverageAccount[]): InboxCoverageSummary {
  const loadedConversations = accounts.reduce((sum, account) => sum + Math.max(0, account.loadedCount), 0);
  const messageCountIsExact = accounts.length > 0
    && accounts.every((account) => Number.isFinite(account.totalMessageCount));
  const messageCount = accounts.reduce((sum, account) => {
    if (Number.isFinite(account.totalMessageCount)) {
      return sum + Math.max(0, Number(account.totalMessageCount));
    }
    return sum + Math.max(0, account.loadedCount);
  }, 0);
  const hasMore = accounts.some((account) => (
    account.truncated
    || (Number.isFinite(account.totalThreadCount) && Number(account.totalThreadCount) > account.loadedCount)
  ));

  return {
    loadedConversations,
    messageCount,
    messageCountIsExact,
    hasMore,
  };
}

export function formatInboxCoverage(summary: InboxCoverageSummary): string {
  const emailCount = summary.messageCount.toLocaleString('en-US');
  const loadedCount = summary.loadedConversations.toLocaleString('en-US');
  return `${emailCount}${summary.messageCountIsExact ? '' : '+'} emails · ${loadedCount} searchable conversations`;
}
