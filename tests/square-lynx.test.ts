import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSquareLynxAppearance,
  defaultSquareLynxAvatar,
  defaultSquareLynxModules,
  migrateV1SquareLynxAvatarId,
  parseSquareLynxAvatarId,
  resolveSquareLynxAppearance,
  squareLynxAvatarId,
  squareLynxSignatures,
  squareLynxPatterns,
  squareLynxColorways,
  squareLynxFaces,
  squareLynxClothingStyles,
  SQUARE_LYNX_CATALOG,
  type SquareLynxModules,
} from '../packages/domain/square-lynx.js';

test('the catalog is fully modular: every pattern x colorway x face x clothing exists', () => {
  const ids = new Set<string>();
  for (const pattern of Object.keys(squareLynxPatterns))
    for (const colorway of Object.keys(squareLynxColorways))
      for (const face of Object.keys(squareLynxFaces))
        for (const clothing of Object.keys(squareLynxClothingStyles)) {
          const modules = { pattern, colorway, face, clothing } as SquareLynxModules;
          const id = squareLynxAvatarId(modules);
          assert.deepEqual(parseSquareLynxAvatarId(id), modules);
          ids.add(id);
        }
  assert.equal(ids.size, 4 * 4 * 4 * 2);
});

test('modules are independent: changing one never changes the others', () => {
  const base: SquareLynxModules = { pattern: 'spots', colorway: 'teal', face: 'sharp', clothing: 'collar' };
  const options: Record<keyof SquareLynxModules, string[]> = {
    pattern: Object.keys(squareLynxPatterns),
    colorway: Object.keys(squareLynxColorways),
    face: Object.keys(squareLynxFaces),
    clothing: Object.keys(squareLynxClothingStyles),
  };
  for (const dim of Object.keys(base) as (keyof SquareLynxModules)[]) {
    for (const option of options[dim]) {
      const next = parseSquareLynxAvatarId(squareLynxAvatarId({ ...base, [dim]: option }))!;
      assert.equal(next[dim], option);
      for (const other of Object.keys(base) as (keyof SquareLynxModules)[]) {
        if (other !== dim) assert.equal(next[other], base[other], `${dim}=${option} changed ${other}`);
      }
    }
  }
});

test('new avatars default to the Nova original', () => {
  assert.deepEqual(defaultSquareLynxModules, { pattern: 'stripes', colorway: 'red', face: 'bold', clothing: 'tie' });
  assert.equal(defaultSquareLynxAvatar, 'stripes-red-bold-tie');
  const created = createSquareLynxAppearance();
  assert.equal(created.avatarId, 'stripes-red-bold-tie');
  assert.equal(created.catalogRevision, SQUARE_LYNX_CATALOG);
});

test('team signatures resolve to real avatars', () => {
  for (const id of Object.values(squareLynxSignatures)) {
    const resolved = resolveSquareLynxAppearance(createSquareLynxAppearance(id));
    assert.equal(resolved.status, 'ready');
  }
});

test('v1 baked-portrait saves migrate, keeping their face', () => {
  assert.equal(migrateV1SquareLynxAvatarId('stripes-red-tie'), 'stripes-red-bold-tie');
  assert.equal(migrateV1SquareLynxAvatarId('spots-teal-collar'), 'spots-teal-bold-collar');
  assert.equal(migrateV1SquareLynxAvatarId('blaze-purple-tie'), 'blaze-purple-sharp-tie');
  assert.equal(migrateV1SquareLynxAvatarId('nope'), undefined);
  const migrated = resolveSquareLynxAppearance({
    schemaVersion: 1, catalogRevision: 'nova-square-lynx-1', avatarId: 'stripes-red-tie',
  });
  assert.equal(migrated.status, 'ready');
  if (migrated.status === 'ready') {
    assert.equal(migrated.appearance.avatarId, 'stripes-red-bold-tie');
    assert.deepEqual(migrated.modules.face, 'bold');
  }
});

test('legacy portrait and pixel recipes are not silently migrated', () => {
  assert.equal(resolveSquareLynxAppearance(null).status, 'unconfigured');
  assert.equal(resolveSquareLynxAppearance({ schemaVersion: 2, catalogRevision: 'nova-lynx-pixel-1' }).status, 'unsupported');
  assert.equal(resolveSquareLynxAppearance({ schemaVersion: 1, catalogRevision: SQUARE_LYNX_CATALOG, avatarId: 'nope' }).status, 'invalid');
  assert.equal(resolveSquareLynxAppearance({ schemaVersion: 1, catalogRevision: 'nova-square-lynx-1', avatarId: 'nope' }).status, 'invalid');
  const resolved = resolveSquareLynxAppearance(createSquareLynxAppearance('spots-teal-sharp-tie'));
  assert.equal(resolved.status, 'ready');
  if (resolved.status === 'ready') {
    assert.deepEqual(resolved.modules, { pattern: 'spots', colorway: 'teal', face: 'sharp', clothing: 'tie' });
  }
});
