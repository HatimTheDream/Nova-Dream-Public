type MarkdownNode = {
  type: string;
  value?: string;
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

const UNDERLINE_MARKER = '^^';
const UNDERLINE_EXCLUDED_PARENTS = new Set([
  'code',
  'definition',
  'html',
  'image',
  'imageReference',
  'inlineCode',
  'link',
  'linkReference',
]);

function isOpeningBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  const character = value[index - 1];
  return /\s/u.test(character) || `([{'"“‘:;,.!?`.includes(character);
}

function isClosingBoundary(value: string, index: number): boolean {
  if (index >= value.length) return true;
  const character = value[index];
  return /\s/u.test(character) || `)]}'"”’:;,.!?`.includes(character);
}

/**
 * Split a Markdown text node into plain and safely underlined segments.
 *
 * The explicit ^^text^^ marker is intentionally narrow: it must be complete,
 * stay on one line, avoid nested carets, and sit at prose boundaries. That
 * keeps ordinary punctuation, C++, links, citations, and partial streaming
 * fragments unchanged.
 */
export function splitUnderlineText(value: string): MarkdownNode[] {
  const source = String(value || '');
  const nodes: MarkdownNode[] = [];
  let emittedThrough = 0;
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const opening = source.indexOf(UNDERLINE_MARKER, searchFrom);
    if (opening < 0) break;

    const closing = source.indexOf(UNDERLINE_MARKER, opening + UNDERLINE_MARKER.length);
    if (closing < 0) break;

    const escaped = opening > 0 && source[opening - 1] === '\\';
    const content = source.slice(opening + UNDERLINE_MARKER.length, closing);
    const valid = !escaped
      && content.length > 0
      && content.trim() === content
      && !content.includes('\n')
      && !content.includes('^')
      && isOpeningBoundary(source, opening)
      && isClosingBoundary(source, closing + UNDERLINE_MARKER.length);

    if (!valid) {
      searchFrom = closing + UNDERLINE_MARKER.length;
      continue;
    }

    if (opening > emittedThrough) {
      nodes.push({ type: 'text', value: source.slice(emittedThrough, opening) });
    }
    nodes.push({
      type: 'underline',
      data: {
        hName: 'u',
        hProperties: { className: ['dc-markdown-underline'] },
      },
      children: [{ type: 'text', value: content }],
    });
    emittedThrough = closing + UNDERLINE_MARKER.length;
    searchFrom = emittedThrough;
  }

  if (emittedThrough < source.length) {
    nodes.push({ type: 'text', value: source.slice(emittedThrough) });
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', value: source }];
}

function containsEscapedUnderlineMarker(node: MarkdownNode, source: string): boolean {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  return source.slice(start, end).includes('\\^^');
}

function transformUnderlineNodes(node: MarkdownNode, source: string): void {
  if (!node.children || UNDERLINE_EXCLUDED_PARENTS.has(node.type)) return;

  const transformed: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      // CommonMark removes the escape slash before remark plugins run. Consult
      // the original source range so an explicit \\^^ escape stays literal.
      if (containsEscapedUnderlineMarker(child, source)) {
        transformed.push(child);
        continue;
      }
      transformed.push(...splitUnderlineText(child.value));
      continue;
    }
    transformUnderlineNodes(child, source);
    transformed.push(child);
  }
  node.children = transformed;
}

/** A raw-HTML-free remark extension for the explicit ^^underline^^ syntax. */
export default function remarkUnderline() {
  return (tree: MarkdownNode, file?: { value?: unknown }): void => {
    transformUnderlineNodes(tree, typeof file?.value === 'string' ? file.value : '');
  };
}
