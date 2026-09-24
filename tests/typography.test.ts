import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDocumentTypography, createTypographyStore, defaultTypography, readTypography, resolveTypography, typographyStorageKey } from '../apps/client/src/typography';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, clear: () => values.clear() };
}

test('Typography migrates the shared font and reading size without inventing an interface size', () => {
  const storage = memoryStorage();
  assert.deepEqual(readTypography(storage), defaultTypography);
  storage.setItem(typographyStorageKey, JSON.stringify({ font: 'serif', textSize: 'large' }));
  assert.deepEqual(readTypography(storage), { interfaceFont: 'serif', interfaceTextSize: 'standard', messageFont: 'serif', messageTextSize: 'large' });
  storage.setItem(typographyStorageKey, '{');
  assert.deepEqual(readTypography(storage), defaultTypography);
  assert.deepEqual(resolveTypography(null), defaultTypography);
});

test('Each preference independently validates and explicit new fields take precedence over legacy choices', () => {
  assert.deepEqual(resolveTypography({ font: 'serif', textSize: 'large', interfaceFont: 'sora', interfaceTextSize: 'small', messageFont: 'url(https://example.invalid/font)', messageTextSize: 1000 }), {
    interfaceFont: 'sora', interfaceTextSize: 'small', messageFont: 'system', messageTextSize: 'standard',
  });
});

test('Interface and message changes are independent, persist across reload and do not touch workspace or zoom', () => {
  const storage = memoryStorage();
  storage.setItem('e3:workspace', 'saved work');
  const root = { dataset: { theme: 'dark', font: 'serif', textSize: 'large' }, style: { zoom: '1' } };
  const target = { documentElement: root } as unknown as Document;
  const first = createTypographyStore(storage, value => applyDocumentTypography(value, target));
  first.apply();
  assert.deepEqual(root.dataset, { theme: 'dark', ...defaultTypography });
  assert.equal(first.update({ ...first.getSnapshot(), interfaceFont: 'sora', interfaceTextSize: 'large' }), true);
  assert.equal(first.getSnapshot().messageTextSize, 'standard');
  assert.equal(first.getSnapshot().messageFont, 'system');
  assert.equal(first.update({ ...first.getSnapshot(), messageFont: 'serif', messageTextSize: 'small' }), true);
  const reloaded = createTypographyStore(storage, value => applyDocumentTypography(value, target));
  reloaded.apply();
  const expected = { interfaceFont: 'sora', interfaceTextSize: 'large', messageFont: 'serif', messageTextSize: 'small' };
  assert.deepEqual(reloaded.getSnapshot(), expected);
  assert.deepEqual(root.dataset, { theme: 'dark', ...expected });
  assert.deepEqual(root.style, { zoom: '1' });
  assert.equal(storage.getItem('e3:workspace'), 'saved work');
});

test('Storage failure keeps the current window preference and reports the unsaved state', () => {
  const storage = { getItem() { throw Error('Unavailable'); }, setItem() { throw Error('Full'); } };
  let applied = { ...defaultTypography }, notifications = 0;
  const store = createTypographyStore(storage, value => { applied = value; });
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  const next = { ...defaultTypography, messageFont: 'serif', interfaceTextSize: 'small' } as const;
  assert.equal(store.update(next), false);
  assert.deepEqual(applied, next);
  assert.deepEqual(store.getSnapshot(), next);
  store.apply();
  assert.deepEqual(applied, next);
  assert.equal(notifications, 1);
  unsubscribe();
  store.update({ ...next, messageTextSize: 'large' });
  assert.equal(notifications, 1);
});

test('Other tabs synchronize all four choices and clearing resets both scopes', () => {
  const storage = memoryStorage();
  const store = createTypographyStore(storage, () => {});
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  const originalSnapshot = store.getSnapshot();
  store.receiveStorageChange('unrelated');
  assert.equal(store.getSnapshot(), originalSnapshot);
  assert.equal(notifications, 0);
  const next = { interfaceFont: 'serif', interfaceTextSize: 'large', messageFont: 'sora', messageTextSize: 'small' };
  storage.setItem(typographyStorageKey, JSON.stringify(next));
  store.receiveStorageChange(typographyStorageKey);
  assert.deepEqual(store.getSnapshot(), next);
  assert.equal(notifications, 1);
  store.receiveStorageChange(typographyStorageKey);
  assert.equal(notifications, 1);
  storage.clear();
  store.receiveStorageChange(null);
  assert.deepEqual(store.getSnapshot(), defaultTypography);
  assert.equal(notifications, 2);
});
