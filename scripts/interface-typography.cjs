const path = require('node:path');

const sourceRoot = path.resolve(__dirname, '../apps/client/src');
const scale = 'var(--interface-text-scale, 1)';
const absoluteLength = /(?:\d*\.)?\d+(?:px|rem|vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|cqw|cqh|cqi|cqb|cqmin|cqmax|pt|pc|in|cm|mm|q)\b/i;
const relativeLength = /(?:\d*\.)?\d+(?:em|ex|ch|cap|ic|lh)\b|%/i;

function scaled(value) {
  // Relative text already inherits the parent's scale. Custom size tokens are
  // deliberately unscaled at their definitions and scaled only when consumed.
  if (value.includes('--interface-text-scale') || relativeLength.test(value)) return value;
  if (!absoluteLength.test(value) && !/^var\(--type-[\w-]+(?:,[^)]*)?\)$/.test(value.trim())) return value;
  return `calc((${value}) * ${scale})`;
}

/** Scale first-party text declarations, never geometry or third-party assets. */
module.exports = () => ({
  postcssPlugin: 'nova-interface-typography',
  OnceExit(root) {
    const file = root.source?.input.file;
    if (!file) return;
    const relative = path.relative(sourceRoot, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative === 'typography.css') return;
    root.walkDecls(declaration => {
      if (declaration.prop === 'font-size' || declaration.prop === 'line-height') {
        declaration.value = scaled(declaration.value);
      } else if (declaration.prop === 'font' && !declaration.value.includes('--interface-text-scale')) {
        // Preserve font family and weights, including explicit monospace. The
        // existing shorthand declarations use one literal size and optional
        // literal line height; inherited/system-font shorthands stay untouched.
        declaration.value = declaration.value.replace(/(?<![\w.-])(?:\d*\.)?\d+(?:px|rem)\b/g, value => scaled(value));
      }
    });
  },
});
