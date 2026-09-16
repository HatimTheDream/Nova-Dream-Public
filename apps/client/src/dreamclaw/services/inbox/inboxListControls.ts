export const INBOX_DEFAULT_PAGE_SIZE = 25;
export const INBOX_PAGE_SIZES = [25, 50, 100] as const;

export function normalizeInboxPageSize(value?: string | number | null): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return INBOX_PAGE_SIZES.includes(parsed as (typeof INBOX_PAGE_SIZES)[number])
    ? parsed
    : INBOX_DEFAULT_PAGE_SIZE;
}

export function clampInboxPage(value: string | number, pageCount: number, fallbackPage = 1): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  const fallback = Math.max(1, Math.trunc(fallbackPage));
  const requested = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(Math.max(1, Math.trunc(pageCount) || 1), Math.max(1, requested));
}

export function inboxPageRange(page: number, pageSize: number, itemCount: number): { start: number; end: number } {
  if (itemCount <= 0) return { start: 0, end: 0 };
  const safeSize = normalizeInboxPageSize(pageSize);
  const safePage = clampInboxPage(page, Math.ceil(itemCount / safeSize));
  return {
    start: (safePage - 1) * safeSize + 1,
    end: Math.min(safePage * safeSize, itemCount),
  };
}

export function normalizeInboxCategoryName(value: string): string {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}
