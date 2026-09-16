import test from 'node:test';
import assert from 'node:assert/strict';
import { measureClient } from '../scripts/client-budget.mjs';

test('startup counts every static dependency once; deferred and unreferenced JS still count toward total', () => {
  const manifest = { page: { isEntry: true, file: 'page.js', imports: ['shared', 'other'], dynamicImports: ['markdown'] }, shared: { file: 'shared.js' }, other: { file: 'other.js', imports: ['shared'] }, markdown: { file: 'markdown.js' } };
  const sizes = new Map([['page.js', 30], ['shared.js', 20], ['other.js', 10], ['markdown.js', 40], ['orphan.js', 5]]);
  assert.deepEqual(measureClient(manifest, sizes, { startup: 61, total: 106, deferredChunk: 41 }).startupGzipBytes, 60);
  assert.throws(() => measureClient(manifest, sizes, { startup: 60, total: 106, deferredChunk: 41 }), /Startup/);
  assert.throws(() => measureClient(manifest, sizes, { startup: 61, total: 105, deferredChunk: 41 }), /Total/);
  assert.throws(() => measureClient(manifest, sizes, { startup: 61, total: 106, deferredChunk: 40 }), /Deferred/);
});

test('budget rejects missing manifests and missing entry or static dependency bytes', () => {
  assert.throws(() => measureClient({}, new Map()), /no entry/);
  assert.throws(() => measureClient({ page: { isEntry: true, file: 'page.js' } }, new Map()), /Missing entry/);
  assert.throws(() => measureClient({ page: { isEntry: true, file: 'page.js', imports: ['absent'] } }, new Map([['page.js', 1]])), /Missing static import/);
});
