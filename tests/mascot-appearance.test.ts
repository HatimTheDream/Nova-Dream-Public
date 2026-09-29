import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMascotAppearance, defaultMascotAppearance, editableMascotAppearance,
  mascotOptions, MASCOT_CATALOG, normalizeMascotAppearance, resolveMascotAppearance,
  type MascotAppearance,
} from '../packages/domain/mascot-appearance.js';
import {
  createSquareLynxAppearance, migrateV1SquareLynxAvatarId, parseSquareLynxAvatarId,
  squareLynxAvatarId, squareLynxClothingStyles, squareLynxColorways, squareLynxFaces,
  squareLynxPatterns, type SquareLynxModules,
} from '../packages/domain/square-lynx.js';

test('every new choice round trips independently through saved JSON', () => {
  const base: MascotAppearance = {
    face: 'curious', pattern: 'patches', outfit: 'utility', glasses: 'browline',
    fur: '#123456', markings: '#abcdef', eyes: '#112233', clothing: '#445566', accent: '#778899', glassesColor: '#0a1b2c',
  };
  const options = { ...mascotOptions, fur: ['#ffeedd'], markings: ['#123abc'], eyes: ['#000000'], clothing: ['#ffffff'], accent: ['#ccbbaa'], glassesColor: ['#876543'] };
  for (const key of Object.keys(options) as (keyof MascotAppearance)[]) {
    for (const value of options[key]) {
      const input = { ...base, [key]: value };
      const saved = createMascotAppearance(input);
      assert.equal(saved.catalogRevision, MASCOT_CATALOG);
      const reloaded = resolveMascotAppearance(JSON.parse(JSON.stringify(saved)));
      assert.equal(reloaded.status, 'ready');
      if (reloaded.status === 'ready') assert.deepEqual(reloaded.appearance, input, `changing ${key} must preserve every other choice`);
      assert.deepEqual(base, editableMascotAppearance(createMascotAppearance(base)));
    }
  }
});

test('normalization accepts only catalog choices and six-digit hex colors without mutating the input', () => {
  const input = Object.freeze({ ...defaultMascotAppearance, face: 'not-real', glasses: 'round', fur: '#AABBCC', markings: 'url(javascript:alert(1))', eyes: '#123', extra: 'ignored' });
  assert.deepEqual(normalizeMascotAppearance(input), { ...defaultMascotAppearance, glasses: 'round', fur: '#aabbcc' });
  assert.equal(input.fur, '#AABBCC');
  assert.deepEqual(createMascotAppearance().appearance, defaultMascotAppearance);
  assert.deepEqual(normalizeMascotAppearance(null), defaultMascotAppearance);
  assert.deepEqual(normalizeMascotAppearance([]), defaultMascotAppearance);
  const saved = createMascotAppearance();
  saved.appearance.face = 'bright';
  assert.equal(defaultMascotAppearance.face, 'classic');
});

test('valid records preserve their exact source, normalize hex case and return detached editable data', () => {
  const source = Object.freeze({ ...createMascotAppearance(), appearance: Object.freeze({ ...defaultMascotAppearance, fur: '#ABCDEF' }) });
  const resolved = resolveMascotAppearance(source);
  assert.equal(resolved.source, source);
  assert.equal(resolved.status, 'ready');
  if (resolved.status === 'ready') {
    assert.equal(resolved.appearance.fur, '#abcdef');
    resolved.appearance.face = 'cheerful';
    assert.equal(source.appearance.face, 'classic');
  }
  const nullPrototype = Object.assign(Object.create(null), source);
  assert.equal(resolveMascotAppearance(nullPrototype).status, 'ready');
});

test('original mascot saves keep their exact shape and acquire the original frame ink only in editable copies', () => {
  const source = Object.freeze({
    schemaVersion: 1, catalogRevision: 'nova-mascot-1',
    appearance: Object.freeze({
      face: 'curious', pattern: 'patches', outfit: 'utility', glasses: 'round',
      fur: '#123456', markings: '#ABCDEF', eyes: '#112233', clothing: '#445566', accent: '#778899',
    }),
  });
  const before = JSON.stringify(source);
  const resolved = resolveMascotAppearance(source);
  assert.equal(resolved.status, 'ready');
  assert.equal(resolved.source, source);
  if (resolved.status !== 'ready') return;
  assert.deepEqual(resolved.appearance, { ...source.appearance, markings: '#abcdef', glassesColor: '#25272b' });
  const editable = editableMascotAppearance(source);
  editable.glassesColor = '#998877';
  const saved = createMascotAppearance(editable);
  assert.equal(saved.catalogRevision, 'nova-mascot-2');
  assert.equal(saved.appearance.glassesColor, '#998877');
  assert.equal(resolved.appearance.glassesColor, '#25272b');
  assert.equal(JSON.stringify(source), before);
  assert.equal(Object.hasOwn(source.appearance, 'glassesColor'), false);
  assert.equal(resolveMascotAppearance({ ...source, appearance: { ...source.appearance, glassesColor: '#25272b' } }).status, 'invalid');
  assert.equal(resolveMascotAppearance({ ...source, catalogRevision: 'nova-mascot-2' }).status, 'invalid');
  assert.equal(resolveMascotAppearance({ ...source, appearance: { ...source.appearance, glasses: 'unknown' } }).status, 'invalid');
  assert.equal(resolveMascotAppearance({ ...source, appearance: { ...source.appearance, accent: 'url(#paint)' } }).status, 'invalid');
});

test('frame color validates independently and survives glasses style changes including None', () => {
  const appearance = { ...defaultMascotAppearance, glassesColor: '#A1B2C3' };
  for (const glasses of mascotOptions.glasses) {
    const saved = createMascotAppearance({ ...appearance, glasses });
    assert.deepEqual(saved.appearance, { ...appearance, glasses, glassesColor: '#a1b2c3' });
    const resolved = resolveMascotAppearance(JSON.parse(JSON.stringify(saved)));
    assert.equal(resolved.status, 'ready');
    if (resolved.status === 'ready') assert.deepEqual(resolved.appearance, saved.appearance);
  }
  for (const invalid of [undefined, null, 1, '#123', '#1234567', '#123456\n', '#123456;', 'red', 'url(#paint)', '\"><script>']) {
    const source = { ...createMascotAppearance(), appearance: { ...appearance, glassesColor: invalid } };
    assert.equal(resolveMascotAppearance(source).status, 'invalid');
    assert.equal(normalizeMascotAppearance(source.appearance).glassesColor, '#25272b');
  }
});

test('malformed known records fail closed while future and other catalogs retain their source', () => {
  for (const source of [null, undefined]) assert.equal(resolveMascotAppearance(source).status, 'unconfigured');
  for (const source of [false, 0, 'mascot', [], new Date()]) assert.equal(resolveMascotAppearance(source).status, 'invalid');
  for (const source of [
    { ...createMascotAppearance(), schemaVersion: 2 },
    { schemaVersion: 1, catalogRevision: 'future-mascot', other: { saved: true } },
    createSquareLynxAppearance(),
  ]) {
    const resolved = resolveMascotAppearance(source);
    assert.equal(resolved.status, 'unsupported');
    assert.equal(resolved.source, source);
  }
  const malformed = [
    { schemaVersion: 1, catalogRevision: MASCOT_CATALOG },
    { ...createMascotAppearance(), extra: true },
    { ...createMascotAppearance(), appearance: [] },
    { ...createMascotAppearance(), appearance: { ...defaultMascotAppearance, extra: true } },
    { ...createMascotAppearance(), appearance: { ...defaultMascotAppearance, glasses: undefined } },
    { ...createMascotAppearance(), appearance: { ...defaultMascotAppearance, face: 'constructor' } },
    { ...createMascotAppearance(), appearance: { ...defaultMascotAppearance, accent: '#123456;' } },
    { ...createMascotAppearance(), appearance: { ...defaultMascotAppearance, accent: '#123456\n' } },
  ];
  for (const source of malformed) {
    assert.equal(resolveMascotAppearance(source).status, 'invalid');
    assert.equal(resolveMascotAppearance(source).source, source);
  }
});

test('getters, inherited data and unsafe keys are rejected without executing accessors', () => {
  let reads = 0;
  const accessor = { enumerable: true, get() { reads += 1; throw new Error('must not execute'); } };
  const envelope = Object.defineProperty(createMascotAppearance(), 'appearance', accessor);
  const nested = Object.defineProperty({ ...defaultMascotAppearance }, 'fur', accessor);
  const frameAccessor = Object.defineProperty({ ...defaultMascotAppearance }, 'glassesColor', accessor);
  const legacy = Object.defineProperty(createSquareLynxAppearance(), 'avatarId', accessor);
  const inherited = Object.create(createMascotAppearance());
  for (const source of [envelope, { ...createMascotAppearance(), appearance: nested }, { ...createMascotAppearance(), appearance: frameAccessor }, inherited, legacy]) {
    assert.equal(resolveMascotAppearance(source).status, 'invalid');
    assert.deepEqual(editableMascotAppearance(source), defaultMascotAppearance);
  }
  assert.deepEqual(normalizeMascotAppearance(nested), defaultMascotAppearance);
  assert.deepEqual(normalizeMascotAppearance(frameAccessor), defaultMascotAppearance);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const unsafe = Object.defineProperty(createMascotAppearance(), key, { value: { polluted: true }, enumerable: true });
    assert.equal(resolveMascotAppearance(unsafe).status, 'invalid');
    const nestedUnsafe = Object.defineProperty({ ...defaultMascotAppearance }, key, { value: 'unsafe', enumerable: true });
    assert.equal(resolveMascotAppearance({ ...createMascotAppearance(), appearance: nestedUnsafe }).status, 'invalid');
  }
  const symbolRecord = { ...createMascotAppearance(), [Symbol('unexpected')]: true };
  assert.equal(resolveMascotAppearance(symbolRecord).status, 'invalid');
  const proxy = Proxy.revocable({}, {});
  proxy.revoke();
  assert.equal(resolveMascotAppearance(proxy.proxy).status, 'invalid');
  assert.deepEqual(normalizeMascotAppearance(proxy.proxy), defaultMascotAppearance);
  assert.equal(reads, 0);
});

test('all v2 legacy combinations map their independent choices only when editing', () => {
  const patterns = { stripes: 'signature', spots: 'freckles', blaze: 'blaze', solid: 'solid' };
  const faces = { bold: 'classic', sharp: 'focused', soft: 'gentle', calm: 'calm' };
  const colors = { red: '#cf2e3b', teal: '#1f9e8e', purple: '#7a5af8', gold: '#d9a41b' };
  let checked = 0;
  for (const pattern of Object.keys(squareLynxPatterns) as SquareLynxModules['pattern'][])
    for (const colorway of Object.keys(squareLynxColorways) as SquareLynxModules['colorway'][])
      for (const face of Object.keys(squareLynxFaces) as SquareLynxModules['face'][])
        for (const clothing of Object.keys(squareLynxClothingStyles) as SquareLynxModules['clothing'][]) {
          const source = Object.freeze(createSquareLynxAppearance(squareLynxAvatarId({ pattern, colorway, face, clothing })));
          const before = JSON.stringify(source);
          assert.deepEqual(editableMascotAppearance(source), {
            face: faces[face], pattern: patterns[pattern], outfit: clothing === 'tie' ? 'suit' : 'shirt',
            glasses: 'none', glassesColor: '#25272b', fur: '#f6e9d2', markings: colors[colorway], eyes: '#e8a020',
            clothing: clothing === 'tie' ? '#232327' : '#2e3d5c', accent: colors[colorway],
          });
          assert.equal(resolveMascotAppearance(source).status, 'unsupported');
          assert.equal(JSON.stringify(source), before);
          checked += 1;
        }
  assert.equal(checked, 128);
});

test('all v1 saves keep their original face assignment when opened for editing', () => {
  let checked = 0;
  for (const pattern of Object.keys(squareLynxPatterns))
    for (const colorway of Object.keys(squareLynxColorways))
      for (const clothing of Object.keys(squareLynxClothingStyles)) {
        const avatarId = `${pattern}-${colorway}-${clothing}`;
        const source = Object.freeze({ schemaVersion: 1, catalogRevision: 'nova-square-lynx-1', avatarId });
        const migrated = migrateV1SquareLynxAvatarId(avatarId)!;
        assert.ok(parseSquareLynxAvatarId(migrated));
        assert.deepEqual(editableMascotAppearance(source), editableMascotAppearance(createSquareLynxAppearance(migrated)));
        assert.equal(source.avatarId, avatarId);
        checked += 1;
      }
  assert.equal(checked, 32);
  for (const source of [
    { schemaVersion: 1, catalogRevision: 'nova-square-lynx-1', avatarId: 'missing' },
    { ...createSquareLynxAppearance(), extra: true },
    { schemaVersion: 1, catalogRevision: 'future-mascot', avatarId: 'saved' },
  ]) assert.deepEqual(editableMascotAppearance(source), defaultMascotAppearance);
});
