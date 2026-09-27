import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSquareLynxAppearance,
  defaultSquareLynxAvatar,
  resolveSquareLynxAppearance,
  squareLynxAvatarIds,
  squareLynxAvatars,
  squareLynxSignatures,
  SQUARE_LYNX_CATALOG,
} from '../packages/domain/square-lynx';

test('the catalog is fully modular: every pattern x colorway x clothing exists', () => {
  assert.equal(squareLynxAvatars.length, 32);
  assert.equal(new Set(squareLynxAvatarIds).size, 32);
  for (const avatar of squareLynxAvatars) {
    assert.equal(avatar.id, `${avatar.pattern}-${avatar.colorway}-${avatar.clothing}`);
  }
});

test('new avatars default to the Nova original', () => {
  assert.equal(defaultSquareLynxAvatar, 'stripes-red-tie');
  const created = createSquareLynxAppearance();
  assert.equal(created.avatarId, 'stripes-red-tie');
  assert.equal(created.catalogRevision, SQUARE_LYNX_CATALOG);
});

test('team signatures resolve to real avatars', () => {
  for (const id of Object.values(squareLynxSignatures)) {
    const resolved = resolveSquareLynxAppearance(createSquareLynxAppearance(id));
    assert.equal(resolved.status, 'ready');
  }
});

test('legacy portrait and pixel recipes are not silently migrated', () => {
  assert.equal(resolveSquareLynxAppearance(null).status, 'unconfigured');
  assert.equal(resolveSquareLynxAppearance({ schemaVersion: 2, catalogRevision: 'nova-lynx-pixel-1' }).status, 'unsupported');
  assert.equal(resolveSquareLynxAppearance({ schemaVersion: 1, catalogRevision: SQUARE_LYNX_CATALOG, avatarId: 'nope' }).status, 'invalid');
  const resolved = resolveSquareLynxAppearance(createSquareLynxAppearance('spots-teal-tie'));
  assert.equal(resolved.status, 'ready');
  if (resolved.status === 'ready') assert.equal(resolved.avatar.label, 'Lagoon spots');
});
