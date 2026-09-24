import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import postcss from 'postcss';

const require = createRequire(import.meta.url);
const interfaceTypography = require('../scripts/interface-typography.cjs');
const clientFile = fileURLToPath(new URL('../apps/client/src/styles.css', import.meta.url));
const transform = (css, from = clientFile, plugins = []) => postcss([...plugins, interfaceTypography()]).process(css, { from, map: false });
const declarations = result => {
  const values = {};
  result.root.walkDecls(declaration => { values[`${declaration.parent.selector}:${declaration.prop}`] = declaration.value; });
  return values;
};

test('Interface typography scales text and fixed leading without changing navigation or touch geometry', async () => {
  const result = declarations(await transform('.control{font-size:14px;line-height:20px;width:44px;height:44px;padding:8px;border-radius:12px}.icon{width:18px;height:18px}'));
  assert.equal(result['.control:font-size'], 'calc((14px) * var(--interface-text-scale, 1))');
  assert.equal(result['.control:line-height'], 'calc((20px) * var(--interface-text-scale, 1))');
  assert.equal(result['.control:width'], '44px');
  assert.equal(result['.control:height'], '44px');
  assert.equal(result['.control:padding'], '8px');
  assert.equal(result['.control:border-radius'], '12px');
  assert.equal(result['.icon:width'], '18px');
  assert.equal(result['.icon:height'], '18px');
});

test('Interface typography preserves relative inheritance, code font faces, and unitless leading', async () => {
  const result = declarations(await transform('.relative{font-size:.9em;line-height:1.6}.percent{font-size:90%;line-height:160%}.inherit{font-size:inherit}.code{font:12px/18px ui-monospace,monospace}.caption{font:12px/1.25 system-ui,sans-serif}'));
  assert.equal(result['.relative:font-size'], '.9em');
  assert.equal(result['.relative:line-height'], '1.6');
  assert.equal(result['.percent:font-size'], '90%');
  assert.equal(result['.percent:line-height'], '160%');
  assert.equal(result['.inherit:font-size'], 'inherit');
  assert.equal(result['.code:font'], 'calc((12px) * var(--interface-text-scale, 1))/calc((18px) * var(--interface-text-scale, 1)) ui-monospace,monospace');
  assert.equal(result['.caption:font'], 'calc((12px) * var(--interface-text-scale, 1))/1.25 system-ui,sans-serif');
});

test('Interface typography scales shared tokens at consumption once, including responsive and generated utilities', async () => {
  const generated = { postcssPlugin: 'fixture-utilities', Once(root) { root.append('.text-sm{font-size:.875rem;line-height:1.25rem}'); } };
  const result = await transform(':root{--type-control:14px}.control{font-size:var(--type-control)}.heading{font-size:clamp(20px,3vw,32px)}', clientFile, [generated]);
  const values = declarations(result);
  assert.equal(values[':root:--type-control'], '14px');
  assert.equal(values['.control:font-size'], 'calc((var(--type-control)) * var(--interface-text-scale, 1))');
  assert.equal(values['.heading:font-size'], 'calc((clamp(20px,3vw,32px)) * var(--interface-text-scale, 1))');
  assert.equal(values['.text-sm:font-size'], 'calc((.875rem) * var(--interface-text-scale, 1))');
  assert.equal(values['.text-sm:line-height'], 'calc((1.25rem) * var(--interface-text-scale, 1))');
  assert.equal((await transform(result.css)).css, result.css);
});

test('Message preferences and third-party font assets stay outside interface scaling', async () => {
  const readingFile = fileURLToPath(new URL('../apps/client/src/typography.css', import.meta.url));
  const reading = await readFile(readingFile, 'utf8');
  assert.equal((await transform(reading, readingFile)).css, reading);
  const external = '.external{font-size:18px;line-height:24px}';
  const externalFile = fileURLToPath(new URL('../node_modules/example/font.css', import.meta.url));
  assert.equal((await transform(external, externalFile)).css, external);
  assert.equal((await transform('.message{font-size:var(--assistant-text-size)}')).css, '.message{font-size:var(--assistant-text-size)}');
});
