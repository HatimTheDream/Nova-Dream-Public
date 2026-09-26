// Date and time formatting helpers for the Inbox.
// Pure functions with no React or workspace dependencies.

export function formatMessageDate(value?: string): string {
  if (!value) return 'Unknown time';
  const normalized = String(value).trim();
  const date = /^\d+$/.test(normalized) ? new Date(Number(normalized)) : new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatThreadListDate(value?: string): string {
  if (!value) return '';
  const normalized = String(value).trim();
  const date = /^\d+$/.test(normalized) ? new Date(Number(normalized)) : new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
    }).format(date);
  }

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function formatFollowUpDeadline(deadline: Date): string {
  return deadline.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function toCalendarDateValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function toCalendarTimeValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function ensureReplySubject(subject: string): string {
  const trimmed = String(subject || '').trim();
  if (!trimmed) return 'Re: (no subject)';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}
