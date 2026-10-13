import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appIconAssets } from '../apps/client/src/app-icon';
import { frontendAssetPath, readClientIdentity, readFrontendAssetBase } from '../apps/client/src/client-identity';

const host = 'https://nova.example';
const first = `${host}/__frontend/${'a'.repeat(64)}/`;
const second = `${host}/__frontend/${'b'.repeat(64)}/`;

test('immutable asset selection leaves the current document and query unchanged for footnotes', () => {
  const documentUrl = `${host}/?workspace=kept#prior`;
  const html = readFileSync(new URL('../apps/client/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<base\b/);
  assert.equal(new URL('#reply-kept-fn-1', documentUrl).href, `${host}/?workspace=kept#reply-kept-fn-1`);
});

test('each document keeps icons, manifest icons and relative chunks in its own frontend namespace', () => {
  const html = readFileSync(new URL('../apps/client/index.html', import.meta.url), 'utf8');
  const links = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)].map(match => match[1]);
  for (const base of [first, second]) {
    const prefix = new URL(base).pathname;
    const target = { querySelector: () => ({ content: prefix }) } as Pick<Document, 'querySelector'>;
    assert.equal(readFrontendAssetBase(target), prefix);
    const assets = appIconAssets('cream', prefix);
    for (const asset of [...links.map(link => frontendAssetPath(link, prefix)), ...Object.values(assets), frontendAssetPath('./assets/Assistant-old.js', prefix)]) {
      assert.ok(new URL(asset, base).href.startsWith(base), `${asset} must stay in this document's namespace`);
    }
    for (const name of ['nova-dream.webmanifest', 'nova-dream-red.webmanifest', 'nova-dream-cream.webmanifest']) {
      const manifest = JSON.parse(readFileSync(new URL(`../apps/client/public/${name}`, import.meta.url), 'utf8'));
      assert.deepEqual([manifest.id, manifest.start_url, manifest.scope], ['/', '/', '/']);
      const manifestUrl = new URL(name, base);
      for (const icon of manifest.icons) assert.ok(new URL(icon.src, manifestUrl).href.startsWith(base));
      assert.equal(new URL(manifest.start_url, manifestUrl).href, `${host}/`);
    }
    assert.equal(new URL('/api/commands', base).href, `${host}/api/commands`);
  }
  assert.notEqual(appIconAssets('red', new URL(first).pathname).brand, appIconAssets('red', new URL(second).pathname).brand);
  for (const invalid of ['https://elsewhere.example/', '//elsewhere.example/', '/__frontend/invalid/', '/__frontend/' + 'a'.repeat(64) + '/../']) {
    assert.equal(readFrontendAssetBase({ querySelector: () => ({ content: invalid }) } as Pick<Document, 'querySelector'>), '/');
  }
  assert.equal(frontendAssetPath('icons/kept.png', readFrontendAssetBase({ querySelector: () => null })), '/icons/kept.png');
});

test('the frontend identity is independent of the backend write fence and missing metadata uses the compiled fallback', async t => {
  const values: Record<string, string> = { 'e3-candidate': 'c'.repeat(64), 'e3-frontend': 'a'.repeat(64), 'e3-frontend-version': '2.3.0', 'e3-frontend-build': '1.0.287' };
  const document = { querySelector: (selector: string) => {
    const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
    return name && values[name] ? { content: values[name] } : null;
  } } as Pick<Document, 'querySelector'>;
  const fallback = { version: '2.2.4', build: '1.0.285' };
  assert.deepEqual(readClientIdentity(document, fallback), { version: '2.3.0', build: '1.0.287', frontendId: 'a'.repeat(64) });
  assert.deepEqual(readClientIdentity(undefined, fallback), fallback);
  assert.deepEqual(readClientIdentity({ querySelector: () => null }, fallback), fallback);

  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  const { clientHeaders, request } = await import('../apps/client/src/api');
  const headers = clientHeaders();
  assert.equal(headers['X-Edition3-Candidate'], values['e3-candidate']);
  assert.notEqual(headers['X-Edition3-Candidate'], values['e3-frontend']);
  values['e3-frontend'] = 'b'.repeat(64);
  values['e3-candidate'] = 'd'.repeat(64);
  assert.deepEqual(clientHeaders(), headers, 'the loaded document must not silently adopt another backend identity');

  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls++;
    assert.equal(url, '/api/commands');
    assert.equal((init.headers as Record<string, string>)['X-Edition3-Candidate'], headers['X-Edition3-Candidate']);
    assert.deepEqual(JSON.parse(String(init.body)), { requestId: 'original', text: 'kept writing' });
    return new Response(JSON.stringify({ accepted: true }));
  });
  assert.deepEqual(await request('commands', { requestId: 'original', text: 'kept writing' }), { accepted: true });
  assert.equal(calls, 1, 'frontend identity changes do not replay the request');
});
