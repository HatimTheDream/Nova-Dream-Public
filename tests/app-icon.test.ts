import test from 'node:test';
import assert from 'node:assert/strict';
import { appIconAssets, appIconCacheKey, applyDocumentAppIcon, cacheAppIcon, readCachedAppIcon, resolveAppIcon, startupAppIcon } from '../apps/client/src/app-icon';
import { defaultLayout, layoutSchema } from '../packages/domain/contracts';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test('Legacy layouts adopt Red without changing their theme, widgets or navigation', () => {
  const { appIcon: _, ...legacy } = structuredClone(defaultLayout);
  legacy.theme = 'dark'; legacy.nav.reverse();
  const parsed = layoutSchema.parse(legacy);
  assert.deepEqual(parsed, { ...legacy, appIcon: 'red' });
  assert.equal(resolveAppIcon(undefined), 'red');
  assert.equal(layoutSchema.parse({ ...legacy, appIcon: 'cream' }).theme, 'dark');
  assert.equal(layoutSchema.safeParse({ ...legacy, appIcon: 'blue' }).success, false);
  assert.equal(layoutSchema.safeParse({ ...legacy, appIcon: null }).success, false);
});

test('The startup hint survives reload, follows a later saved choice and safely ignores unavailable storage', () => {
  const storage = memoryStorage();
  assert.equal(readCachedAppIcon(storage), 'red');
  assert.equal(cacheAppIcon('cream', storage), true);
  assert.equal(readCachedAppIcon(storage), 'cream');
  cacheAppIcon('red', storage);
  assert.equal(readCachedAppIcon(storage), 'red');
  storage.setItem(appIconCacheKey, 'not-an-icon');
  assert.equal(readCachedAppIcon(storage), 'red');
  const blocked = { getItem() { throw Error('Unavailable'); }, setItem() { throw Error('Unavailable'); } };
  assert.equal(readCachedAppIcon(blocked), 'red');
  assert.equal(cacheAppIcon('cream', blocked), false);
});

test('Switching the document icon updates browser, fresh-install manifest and touch export together', () => {
  const icon = { href: '/old.png', type: 'image/png' }, touch = { href: '/old-touch.png' }, manifest = { href: '/nova-dream.webmanifest' };
  const other = { href: '/unrelated.css' };
  const links: Record<string, object[]> = { 'link[rel="icon"]': [icon], 'link[rel="apple-touch-icon"]': [touch], 'link[rel="manifest"]': [manifest] };
  const document = { querySelectorAll: (selector: string) => links[selector] ?? [] } as unknown as Document;
  for (const choice of ['cream', 'red'] as const) {
    applyDocumentAppIcon(choice, document);
    const assets = appIconAssets(choice);
    assert.equal(icon.href, assets.brand);
    assert.equal(touch.href, assets.touch);
    assert.equal(manifest.href, assets.manifest);
    assert.equal(other.href, '/unrelated.css');
  }
  assert.equal(appIconAssets('unrecognized').brand, appIconAssets('red').brand);
});
test('Startup uses the known workspace while preserving only its same-window unsaved icon proposal', () => {
  const red = { epoch: 'current-workspace', layout: { value: { appIcon: 'red' } } };
  const cream = { ...red, layout: { value: { appIcon: 'cream' } } };
  const proposal = { epoch: red.epoch, dirty: true, value: { appIcon: 'cream' } };
  assert.equal(startupAppIcon(undefined, undefined, 'cream'), 'cream');
  assert.equal(startupAppIcon(red, undefined, 'cream'), 'red');
  assert.equal(startupAppIcon(cream, undefined, 'red'), 'cream');
  assert.equal(startupAppIcon({ ...red, layout: { value: {} } }, undefined, 'cream'), 'red');
  assert.equal(startupAppIcon(red, proposal, 'red'), 'cream');
  assert.equal(startupAppIcon(red, { ...proposal, dirty: false, pending: { requestId: 'unconfirmed' } }, 'red'), 'cream');
  assert.equal(startupAppIcon(red, { ...proposal, epoch: 'other-workspace' }, 'cream'), 'red');
  assert.equal(startupAppIcon(red, { ...proposal, dirty: false }, 'cream'), 'red');
  assert.equal(startupAppIcon(red, { ...proposal, value: { appIcon: 'unknown' } }, 'cream'), 'red');
  assert.equal(startupAppIcon(cream, { ...proposal, value: {} }, 'red'), 'cream');
});