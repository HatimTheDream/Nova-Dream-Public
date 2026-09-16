import assert from 'node:assert/strict';
import test from 'node:test';
import { createLynxAppearance, resolveLynxAppearance } from '../packages/domain/lynx-appearance';
import { createPortraitRecipe, resolvePortraitRecipe } from '../apps/client/src/nova/lynx-portrait/recipe';

test('a 3D appearance round-trips every independent selection without mutating its source', () => {
  const saved = { ...createLynxAppearance(), body: 'plush', face: 'tapered', ears: 'short',
    furColor: '#617181', markingsColor: '#ffeedd', earsColor: '#cb9988', tailTipColor: '#ffffff',
    pattern: 'soft', outerwear: 'field-jacket', accessory: 'none' };
  const source = JSON.parse(JSON.stringify(saved));
  const resolved = resolveLynxAppearance(source);
  assert.equal(resolved.status, 'ready');
  if (resolved.status === 'ready') assert.deepEqual(resolved.recipe, saved);
  assert.deepEqual(source, saved);
});
test('existing original portraits and unknown future drafts retain their original data', () => {
  const original = createPortraitRecipe('james-original');
  assert.equal(resolvePortraitRecipe(original).status, 'ready');
  assert.equal(resolveLynxAppearance(original).status, 'unsupported');
  const future = { ...createLynxAppearance(), catalogRevision: 'future', unknownChoice: true };
  const result = resolveLynxAppearance(future);
  assert.equal(result.status, 'stale'); assert.equal(result.source, future);
  assert.equal(resolveLynxAppearance(null).status, 'unconfigured');
});
test('malformed palettes, unrecognized parts and accessors fail without substituting a character', () => {
  for (const invalid of [{ furColor: 'url(https://example.com)' }, { body: 'unknown' },
    { extraTail: true }, { outerwear: ['cream-cardigan', 'field-jacket'] }]) {
    assert.equal(resolveLynxAppearance({ ...createLynxAppearance(), ...invalid }).status, 'invalid');
  }
  let read = false;
  const source = { get schemaVersion() { read = true; return 2; } };
  assert.equal(resolveLynxAppearance(source).status, 'invalid'); assert.equal(read, false);
});
