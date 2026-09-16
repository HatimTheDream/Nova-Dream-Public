// Adapted from the original safeUrl helper. E3 has no predecessor URL base.
// Fragment links stay in their reply; only absolute HTTPS leaves the app.
export function toSafeReplyUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  if (/^#[a-zA-Z0-9_-]+$/.test(value)) return value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch { return null; }
}
