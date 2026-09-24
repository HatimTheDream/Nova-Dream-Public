const postcss = require('postcss');
const tailwind = require('tailwindcss');
const config = require('./tailwind.original.cjs');

module.exports = { plugins: [
  {
    postcssPlugin: 'edition3-original-module-utilities',
    async Once(root, { result }) {
      if (!root.source?.input.file?.replaceAll('\\', '/').endsWith('/dreamclaw/styles.css')) return;
      const expanded = await postcss([tailwind(config)]).process(root.toString(), { ...result.opts, from: root.source.input.file, map: false });
      root.removeAll(); root.append(expanded.root.nodes);
    },
  },
  require('./scripts/interface-typography.cjs')(),
  require('autoprefixer'),
] };
