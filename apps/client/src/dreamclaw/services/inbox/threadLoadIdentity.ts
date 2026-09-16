export interface InboxThreadLoadIdentity {
  provider: 'gmail' | 'microsoft';
  accountId: string;
  generation?: string;
  accountEmail: string;
  threadId: string;
  sourceMessageId?: string;
  subject: string;
  sender: string;
  messageCount: number;
  latestAt: string;
}

/**
 * Identifies the message content that belongs in the reading pane. Index
 * progress timestamps and recreated snapshot objects are deliberately omitted
 * so background index updates cannot reload an unchanged open conversation.
 */
export function inboxThreadLoadKey(identity: InboxThreadLoadIdentity | null): string {
  if (!identity) return '';
  return JSON.stringify([
    identity.provider,
    identity.accountId,
    identity.generation ?? '',
    identity.accountEmail,
    identity.threadId,
    identity.sourceMessageId || '',
    identity.subject,
    identity.sender,
    identity.messageCount,
    identity.latestAt,
  ]);
}
