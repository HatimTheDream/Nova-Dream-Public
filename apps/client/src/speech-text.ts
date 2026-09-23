/** Turn presentation into speech without summarizing or rewriting the answer. */
export function speechText(markdown: string): string {
  const code: string[] = [];
  // Protect code from emphasis/link cleanup, and announce its boundaries.
  let text = markdown.replace(/\r\n?/g, '\n').replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:^[ \t]{0,3}\1[ \t]*$|$(?![\s\S]))/gm,
    (_all, _fence, body: string) => `\n\n\uE000${code.push(`Code block.\n${body.trim()}\nEnd of code block.`) - 1}\uE001\n\n`);
  text = text.replace(/(`+)([^`\n]+)\1/g, (_all, _ticks, body: string) => `\uE000${code.push(body) - 1}\uE001`);
  const definitions = new Map<string, string>();
  text = text.replace(/^[ \t]{0,3}\[([^\]]+)\]:[ \t]*\S+[^\n]*$/gm, (_all, label: string) => { definitions.set(label.toLowerCase(), label); return ''; });
  text = text.replace(/!\[([^\]]*)\]\((?:[^()\n]|\([^()]*\))*\)/g, (_all, alt: string) => alt ? `Image: ${alt}.` : 'Image.')
    .replace(/\[([^\]]+)\]\((?:[^()\n]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (all, label: string, ref: string) => definitions.has((ref || label).toLowerCase()) ? label : all)
    .replace(/\[([^\]]+)\]/g, (all, label: string) => definitions.has(label.toLowerCase()) ? label : all)
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?$/gm, '$1')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*[-+*][ \t]+\[([ xX])\][ \t]+/gm, (_all, checked: string) => checked.trim() ? 'Completed: ' : 'Not completed: ')
    .replace(/^[ \t]*[-+*][ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_all, row: string) => row.split('|').map(cell => cell.trim()).join('; ') + '.')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])([*_])(?=\S)([^\n]*?\S)\2(?=$|[\s).,!?;:])/g, '$1$3')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, 'Struck out: $1')
    .replace(/\\([\\`*_{}\[\]()#+.!>|~-])/g, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?(?:p|div|strong|em|b|i|span|blockquote|h[1-6])(?:\s[^<>]*)?>/gi, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[value]!)
    .replace(/\uE000(\d+)\uE001/g, (_all, index: string) => code[Number(index)] ?? '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** Prefer complete sentences/paragraphs; split an exceptional long sentence only at words/graphemes. */
export function speechChunks(text: string, maximum = 1600, language?: string): string[] {
  if (!Number.isInteger(maximum) || maximum < 16) throw new RangeError('Speech chunk limit must be at least 16.');
  const chunks: string[] = [];
  const segmenter = new Intl.Segmenter(language, { granularity: 'sentence' });
  let chunk = '';
  const flush = () => { if (chunk.trim()) chunks.push(chunk.trim()); chunk = ''; };
  const add = (part: string, join: string) => {
    if (chunk && chunk.length + join.length + part.length > maximum) flush();
    chunk += (chunk ? join : '') + part;
  };
  for (const paragraph of text.trim().split(/\n\s*\n/)) {
    let first = true;
    for (const sentence of segmenter.segment(paragraph)) {
      const value = sentence.segment.trim(); if (!value) continue;
      if (value.length <= maximum) add(value, first ? '\n\n' : ' ');
      else {
        flush();
        for (const word of value.split(/\s+/)) {
          if (word.length <= maximum) add(word, ' ');
          else {
            flush();
            for (const item of new Intl.Segmenter(language, { granularity: 'grapheme' }).segment(word)) {
              if (item.segment.length <= maximum) add(item.segment, '');
              // A pathological combining cluster can itself exceed the provider limit.
              else for (const point of item.segment) add(point, '');
            }
          }
        }
        flush();
      }
      first = false;
    }
  }
  flush(); return chunks;
}

export function selectSpeechVoice(voices: readonly SpeechSynthesisVoice[], language: string): SpeechSynthesisVoice | undefined {
  const tag = language.toLowerCase(), base = tag.split('-')[0];
  return [...voices].filter(voice => voice.lang.toLowerCase().split('-')[0] === base)
    .sort((a, b) => Number(b.lang.toLowerCase() === tag) - Number(a.lang.toLowerCase() === tag) || Number(b.default) - Number(a.default) || a.name.localeCompare(b.name))[0];
}
