// Email address parsing, normalization, and validation helpers for the Inbox.
// Pure functions with no React or workspace dependencies.

export function normalizeEmail(value: string): string {
  return String(value || '').trim().toLowerCase();
}

export function extractEmail(value: string): string {
  const input = String(value || '').trim();
  const angleMatch = input.match(/<([^>]+)>/);
  if (angleMatch?.[1]) return normalizeEmail(angleMatch[1]);
  const plainMatch = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return normalizeEmail(plainMatch?.[0] || input);
}

export function parseAddressList(value: string): string[] {
  return String(value || '')
    .split(',')
    .map((part) => extractEmail(part))
    .filter(Boolean);
}

export function isValidEmailAddress(value: string): boolean {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value);
}

export function sanitizeEmailHref(value: string): string | null {
  const href = String(value || '').trim();
  if (!href) return null;
  if (href.startsWith('mailto:')) return href;
  try {
    const parsed = new URL(href);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch {
    return null;
  }
  return null;
}

export function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildManualSignatureHtml(value?: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return `<div dir="ltr">${escapeHtml(trimmed).replace(/\n/g, '<br>')}</div>`;
}
