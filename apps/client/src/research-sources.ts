/** Collect only links the saved reply actually renders, without visiting them
 * or claiming a linked page was independently verified. */
export function researchSources(links: { href: string; title: string }[]): { href: string; title: string; host: string }[] {
  const sources = new Map<string, { href: string; title: string; host: string }>();
  for (const link of links) {
    try {
      const url = new URL(link.href);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
      if (!sources.has(url.href)) sources.set(url.href, { href: url.href, title: link.title.trim() || url.hostname, host: url.hostname.replace(/^www\./, '') });
    } catch { /* Local anchors and malformed links are not external sources. */ }
  }
  return [...sources.values()];
}
