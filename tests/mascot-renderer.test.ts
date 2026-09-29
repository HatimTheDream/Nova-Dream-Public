import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultMascotAppearance, createMascotAppearance, mascotOptions, resolveMascotAppearance } from '../packages/domain/mascot-appearance.js';
import { createSquareLynxAppearance, resolveSquareLynxAppearance } from '../packages/domain/square-lynx.js';
import { renderMascot } from '../apps/client/src/nova/square-lynx/mascot-art.js';
import { SquareLynxSvg } from '../apps/client/src/nova/square-lynx/SquareLynxSvg.js';

test('every mascot choice changes the artwork and emits bounded local SVG', () => {
  for (const [key, choices] of Object.entries(mascotOptions)) {
    const seen = new Set<string>();
    for (const choice of choices) {
      const svg = renderMascot({ ...defaultMascotAppearance, [key]: choice }, { uid: 'test' });
      assert.match(svg, /^<svg /);
      assert.ok(svg.length < 20000);
      assert.doesNotMatch(svg, /<script|<foreignObject|onload=|href=/i);
      seen.add(svg.replace(/aria-label="[^"]*"/, ''));
    }
    assert.equal(seen.size, choices.length, `${key} choices must produce different drawings`);
  }
});

test('activity previews do not modify the saved identity', () => {
  const identity = Object.freeze({ ...defaultMascotAppearance, face: 'curious' as const, glasses: 'round' as const });
  const before = createMascotAppearance(identity);
  const idle = renderMascot(identity, { uid: 'pose', expression: 'idle' });
  assert.notEqual(renderMascot(identity, { uid: 'pose', expression: 'listening' }), idle);
  assert.notEqual(renderMascot(identity, { uid: 'pose', expression: 'speaking' }), idle);
  assert.deepEqual(createMascotAppearance(identity), before);
});

test('untrusted colors and identifiers cannot inject SVG elements or attributes', () => {
  const svg = renderMascot({ ...defaultMascotAppearance, fur: '\"><script>alert(1)</script>', glasses: '<foreignObject>' }, { uid: '\"><script>' });
  assert.doesNotMatch(svg, /<script|<foreignObject|onload=/i);
  assert.match(svg, /fill="#f7ecd6"/);
});

test('frame color changes only eyewear and cannot inject SVG content', () => {
  for (const glasses of mascotOptions.glasses) {
    const appearance = { ...defaultMascotAppearance, glasses };
    const original = renderMascot(appearance, { uid: 'frame-color' });
    const recolored = renderMascot({ ...appearance, glassesColor: '#13579B' }, { uid: 'frame-color' });
    if (glasses === 'none') assert.equal(recolored, original);
    else {
      assert.equal(recolored.split('stroke="#13579b"').length - 1, 1);
      assert.equal(recolored.replace('stroke="#13579b"', 'stroke="#25272b"'), original);
      assert.match(recolored, /fill="#25272b"/); // Pupils, nose and brows retain their own ink.
    }
    for (const glassesColor of ['\"><script>alert(1)</script>', '\" onload=\"alert(1)', 'url(https://example.com/paint)', '#123456\n']) {
      const unsafe = renderMascot({ ...appearance, glassesColor }, { uid: 'frame-color' });
      assert.equal(unsafe, original);
      assert.doesNotMatch(unsafe, /<script|<foreignObject|onload=|https:\/\//i);
    }
  }
});

test('nova-mascot-1 recipes render the exact pre-extension artwork for every glasses style', () => {
  // Captured from the original renderer before it gained a frame color input.
  const originalHashes = {
    none: '8f7c7ca75905b989aecbebdc18239fb7a60dcf5bd0b9b7d1c5c4a2c95f9ee371',
    round: 'a8ce735c5d46be90c254e2432d1496e159afa35e0b69f80750cc377443a8d778',
    square: 'ae83c471d6a7223430a3f2a1a758e212d7b1a80acd9490b08819a438bbd66bf6',
    browline: '167a3c01cbff084a4ebb5197b29ca36f1fd2f5440c3cbd525f4ab4f2a7848c54',
  };
  for (const glasses of mascotOptions.glasses) {
    const source = Object.freeze({
      schemaVersion: 1, catalogRevision: 'nova-mascot-1',
      appearance: Object.freeze({ face: 'curious', pattern: 'patches', outfit: 'utility', glasses,
        fur: '#123456', markings: '#abcdef', eyes: '#112233', clothing: '#445566', accent: '#778899' }),
    });
    const before = JSON.stringify(source);
    const resolved = resolveMascotAppearance(source);
    assert.equal(resolved.status, 'ready');
    if (resolved.status !== 'ready') continue;
    const svg = renderMascot(resolved.appearance, { uid: 'catalog-one' });
    assert.equal(createHash('sha256').update(svg).digest('hex'), originalHashes[glasses]);
    assert.equal(JSON.stringify(source), before);
  }
});

test('legacy appearance resolution and artwork stay deterministic after new creator saves', () => {
  const saved = createSquareLynxAppearance('spots-teal-sharp-collar');
  const legacy = resolveSquareLynxAppearance(saved);
  assert.equal(legacy.status, 'ready');
  if (legacy.status !== 'ready') return;
  const before = renderToStaticMarkup(createElement(SquareLynxSvg, { modules: legacy.modules }));
  createMascotAppearance({ ...defaultMascotAppearance, fur: '#ffffff', outfit: 'hoodie' });
  assert.deepEqual(resolveSquareLynxAppearance(saved), legacy);
  assert.equal(renderToStaticMarkup(createElement(SquareLynxSvg, { modules: legacy.modules })), before);
});
