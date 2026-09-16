export type EmailImages = { accountId: string; generation: string; threadId: string; messageId: string; images: Record<string, string>; unavailable: number };
export function emailImageUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim().startsWith('//') ? 'https:' + value.trim() : value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) return;
    url.hash = ''; return url.href;
  } catch { return; }
}
export function mapEmailImageCss(value: string, image: (src: string) => string | undefined): string {
  // Remote stylesheets and font files are not images. Remove their rules in
  // both discovery and rendering; the email keeps its declared fallback fonts.
  // Tokenize strings/comments so a quoted semicolon or brace cannot end a rule.
  let css = '', cursor = 0, skipping = false, depth = 0;
  const tokens = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\[\s\S]|@(?:import|font-face)\b|[{};]/gi;
  for (const match of value.matchAll(tokens)) {
    const token = match[0], end = match.index! + token.length;
    if (skipping) {
      if (token === '{') depth++;
      if (token === '}' && depth) depth--;
      if (!depth && (token === ';' || token === '}')) { skipping = false; cursor = end; }
    } else if (token.startsWith('/*')) {
      css += value.slice(cursor, match.index); cursor = end;
    } else if (token.startsWith('@')) {
      css += value.slice(cursor, match.index); cursor = end; skipping = true;
    }
  }
  if (!skipping) css += value.slice(cursor);
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, source: string) => {
    const url = emailImageUrl(source), replacement = url && image(url);
    return replacement ? `url("${replacement}")` : 'none';
  });
}
