import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDocumentTypography, createTypographyStore, defaultTypography, readTypography, resolveTypography, typographyStorageKey } from '../apps/client/src/typography';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, clear: () => values.clear() };
}

test('Typography uses compact defaults and independently recovers invalid saved choices', () => {
  const storage = memoryStorage();
  assert.deepEqual(readTypography(storage), { font: 'system', textSize: 'standard' });
  storage.setItem(typographyStorageKey, '{');
  assert.deepEqual(readTypography(storage), defaultTypography);
  storage.setItem(typographyStorageKey, JSON.stringify({ font: 'serif', textSize: 1000 }));
  assert.deepEqual(readTypography(storage), { font: 'serif', textSize: 'standard' });
  assert.deepEqual(resolveTypography({ font: 'url(https://example.invalid/font)', textSize: 'large' }), { font: 'system', textSize: 'large' });
  assert.deepEqual(resolveTypography(null), defaultTypography);
});

test('Saved typography applies before rendering and reload retains the preference without touching workspace data', () => {
  const storage = memoryStorage();
  storage.setItem('e3:workspace', 'saved work');
  const root = { dataset: { theme: 'dark' }, style: { zoom: '1' } };
  const target = { documentElement: root } as unknown as Document;
  const first = createTypographyStore(storage, value => applyDocumentTypography(value, target));
  first.apply();
  assert.deepEqual(root.dataset, { theme: 'dark', font: 'system', textSize: 'standard' });
  assert.equal(first.update({ font: 'sora', textSize: 'extra-large' }), true);
  const reloaded = createTypographyStore(storage, value => applyDocumentTypography(value, target));
  reloaded.apply();
  assert.deepEqual(reloaded.getSnapshot(), { font: 'sora', textSize: 'extra-large' });
  assert.deepEqual(root.dataset, { theme: 'dark', font: 'sora', textSize: 'extra-large' });
  assert.deepEqual(root.style, { zoom: '1' });
  assert.equal(storage.getItem('e3:workspace'), 'saved work');
});

test('Storage failure keeps a live preference for the current window and reports that it was not saved', () => {
  const storage = { getItem() { throw Error('Unavailable'); }, setItem() { throw Error('Full'); } };
  let applied = { ...defaultTypography }, notifications = 0;
  const store = createTypographyStore(storage, value => { applied = value; });
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  assert.deepEqual(store.getSnapshot(), defaultTypography);
  assert.equal(store.update({ font: 'serif', textSize: 'small' }), false);
  assert.deepEqual(applied, { font: 'serif', textSize: 'small' });
  assert.deepEqual(store.getSnapshot(), applied);
  store.apply();
  assert.deepEqual(applied, { font: 'serif', textSize: 'small' });
  assert.equal(notifications, 1);
  unsubscribe();
  store.update({ font: 'system', textSize: 'large' });
  assert.equal(notifications, 1);
});

test('Other tabs update text preferences, while unrelated storage changes do not overwrite this window', () => {
  const storage = memoryStorage();
  const store = createTypographyStore(storage, () => {});
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  const originalSnapshot = store.getSnapshot();
  store.receiveStorageChange('unrelated');
  assert.equal(store.getSnapshot(), originalSnapshot);
  assert.equal(notifications, 0);
  storage.setItem(typographyStorageKey, JSON.stringify({ font: 'sora', textSize: 'large' }));
  store.receiveStorageChange(typographyStorageKey);
  assert.deepEqual(store.getSnapshot(), { font: 'sora', textSize: 'large' });
  assert.equal(notifications, 1);
  store.receiveStorageChange(typographyStorageKey);
  assert.equal(notifications, 1);
  storage.clear();
  store.receiveStorageChange(null);
  assert.deepEqual(store.getSnapshot(), defaultTypography);
  assert.equal(notifications, 2);
});
