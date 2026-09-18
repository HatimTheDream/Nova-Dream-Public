import { decodeNamedCharacterReference } from 'decode-named-character-reference';

type PreviewThread = {
  subject: string;
  from: string;
  summary: string;
  latestBody: string;
  latestSnippet: string;
};

/** Display-only text cleanup. Never feed the result into an HTML renderer or provider data. */
export function normalizeInboxPreviewText(value: string): string {
  const decoded = String(value || '').replace(/&(#(?:\d+|x[\da-f]+)|[a-z][\da-z]{1,31});/gi, (entity, reference: string) => {
    if (!reference.startsWith('#')) return decodeNamedCharacterReference(reference) || entity;
    const hex = reference[1].toLowerCase() === 'x';
    const code = Number.parseInt(reference.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
      || (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 0x7f && code <= 0x9f)) return entity;
    return String.fromCodePoint(code);
  });
  // Preheaders repeat invisible characters, often alternating with spaces. Keep
  // individual joiners: they carry meaning in emoji, Persian and other scripts.
  const normalized = decoded.replace(/[\s\u00ad\u034f\u200b-\u200d\u2060\ufeff]+/gu, run => (
    run.replace(/\s/gu, '').length > 1 ? ' ' : run.replace(/\s+/gu, ' ')
  )).trim();
  return /^[\s\u00ad\u034f\u200b-\u200d\u2060\ufeff]*$/u.test(normalized) ? '' : normalized;
}

export function pickThreadPreviewText(thread: PreviewThread): string {
  const subject = normalizeInboxPreviewText(thread.subject);
  const lowerSubject = subject.toLowerCase();
  const sender = normalizeInboxPreviewText(thread.from).toLowerCase();
  for (const candidate of [thread.summary, thread.latestBody, thread.latestSnippet]) {
    const normalized = normalizeInboxPreviewText(candidate);
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (lower === lowerSubject || lower === sender || lower === `${lowerSubject} - ${sender}`) continue;
    if (subject && lower.startsWith(`${lowerSubject} `)) {
      const trimmed = normalized.slice(subject.length).trim();
      if (trimmed) return trimmed;
      continue;
    }
    return normalized;
  }
  return '';
}
