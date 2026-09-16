export type InboxMailFolder = 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash';

const INBOX_ACCOUNT_FILTER_SEPARATOR = '|';

function uniqueAccountKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
}

export function normalizeInboxAccountFilter(value?: string | null): string {
  if (typeof value !== 'string') return 'all';
  const normalized = value.trim();
  if (!normalized || normalized === 'all') return 'all';
  const keys = uniqueAccountKeys(normalized.split(INBOX_ACCOUNT_FILTER_SEPARATOR));
  return keys.length > 0 ? keys.join(INBOX_ACCOUNT_FILTER_SEPARATOR) : 'all';
}

export function inboxAccountFilterKeys(value?: string | null): string[] {
  const normalized = normalizeInboxAccountFilter(value);
  return normalized === 'all' ? [] : normalized.split(INBOX_ACCOUNT_FILTER_SEPARATOR);
}

export function inboxAccountFilterIncludes(value: string, accountKey: string): boolean {
  const normalized = normalizeInboxAccountFilter(value);
  return normalized === 'all' || inboxAccountFilterKeys(normalized).includes(accountKey);
}

export function reconcileInboxAccountFilter(
  value: string,
  availableAccountKeys: readonly string[],
): string {
  const available = uniqueAccountKeys(availableAccountKeys);
  if (available.length === 0) return 'all';
  const normalized = normalizeInboxAccountFilter(value);
  if (normalized === 'all') return 'all';
  const availableSet = new Set(available);
  const selected = inboxAccountFilterKeys(normalized).filter((key) => availableSet.has(key));
  if (selected.length === 0 || selected.length === available.length) return 'all';
  return selected.join(INBOX_ACCOUNT_FILTER_SEPARATOR);
}

export function toggleInboxAccountFilter(
  value: string,
  accountKey: string,
  availableAccountKeys: readonly string[],
): string {
  const available = uniqueAccountKeys(availableAccountKeys);
  if (!available.includes(accountKey)) return reconcileInboxAccountFilter(value, available);

  const normalized = reconcileInboxAccountFilter(value, available);
  if (normalized === 'all') return accountKey;

  const selected = new Set(inboxAccountFilterKeys(normalized));
  if (selected.has(accountKey)) {
    if (selected.size === 1) return normalized;
    selected.delete(accountKey);
  } else {
    selected.add(accountKey);
  }

  return reconcileInboxAccountFilter(
    available.filter((key) => selected.has(key)).join(INBOX_ACCOUNT_FILTER_SEPARATOR),
    available,
  );
}

export const INBOX_MAIL_FOLDERS: ReadonlyArray<{
  id: InboxMailFolder;
  label: string;
  description: string;
}> = [
  { id: 'inbox', label: 'Inbox', description: 'Mail waiting for you' },
  { id: 'sent', label: 'Sent', description: 'Messages you sent' },
  { id: 'drafts', label: 'Drafts', description: 'Messages not sent yet' },
  { id: 'archive', label: 'Archive', description: 'Mail kept out of the inbox' },
  { id: 'trash', label: 'Trash', description: 'Recently deleted mail' },
];

export function normalizeInboxMailFolder(value?: string | null): InboxMailFolder {
  return value === 'sent' || value === 'drafts' || value === 'archive' || value === 'trash'
    ? value
    : 'inbox';
}

export function gmailQueryForInboxFolder(folder: InboxMailFolder): string {
  switch (folder) {
    case 'sent': return 'in:sent';
    case 'drafts': return 'in:drafts';
    case 'archive': return '-in:inbox -in:sent -in:drafts -in:trash -in:spam';
    case 'trash': return 'in:trash';
    default: return 'in:inbox';
  }
}

export function microsoftFolderForInboxFolder(
  folder: InboxMailFolder,
): 'inbox' | 'sentitems' | 'drafts' | 'archive' | 'deleteditems' {
  switch (folder) {
    case 'sent': return 'sentitems';
    case 'drafts': return 'drafts';
    case 'archive': return 'archive';
    case 'trash': return 'deleteditems';
    default: return 'inbox';
  }
}

export function inboxFolderSupportsTriage(folder: InboxMailFolder): boolean {
  return folder === 'inbox';
}
