function extractMailboxEmail(value: string): string {
  const input = String(value || '').trim();
  const angleMatch = input.match(/<([^>]+)>/);
  if (angleMatch?.[1]) return angleMatch[1].trim().toLowerCase();
  const plainMatch = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return String(plainMatch?.[0] || input).trim().toLowerCase();
}

export function formatInboxSenderLabel(value: string): string {
  const input = String(value || '').trim();
  if (!input) return '(unknown sender)';
  const angleMatch = input.match(/^(.*?)(?:\s*<[^>]+>)$/);
  const display = angleMatch?.[1]?.replace(/^"+|"+$/g, '').trim();
  return display || extractMailboxEmail(input) || input;
}

export function formatInboxConversationSummary(messageCount: number): string | null {
  const normalizedCount = Number.isFinite(messageCount)
    ? Math.max(0, Math.trunc(messageCount))
    : 0;
  if (normalizedCount <= 1) return null;
  return `${normalizedCount} messages in this conversation`;
}
