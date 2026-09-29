import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultMascotAppearance, createMascotAppearance, mascotOptions } from '../packages/domain/mascot-appearance.js';
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
