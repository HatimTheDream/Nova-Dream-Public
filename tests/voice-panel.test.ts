import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import type { AppIconChoice } from '../packages/domain/contracts';
import type { VoiceController, VoiceView } from '../apps/client/src/voice-controller';
import { appIconAssets } from '../apps/client/src/app-icon';

const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:voice-panel-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:voice-panel-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(reactUrl)};
      import React from ${JSON.stringify(reactUrl)};
      export const useSyncExternalStore = (subscribe, snapshot) => React.useSyncExternalStore(subscribe, snapshot, snapshot);
    ` };
    return next(url, context);
  },
});
const { VoicePanel } = await import('../apps/client/src/VoicePanel');
hooks.deregister();

type Element = { name: string; attributes: Record<string, string>; text: string; children: Element[] };
function renderPanel(appIcon: AppIconChoice, patch: Partial<VoiceView>, floating = false) {
  const voice: VoiceView = { phase: 'connected', muted: false, speaking: false, listening: false, processing: false, soundBlocked: false, message: '', turns: [], unsaved: 0, ...patch };
  const controller = { subscribe: () => () => {}, getSnapshot: () => voice } as unknown as VoiceController;
  const markup = renderToStaticMarkup(createElement(VoicePanel, { appIcon, controller, floating, openConversation() {} }));
  const elements: Element[] = [], stack: Element[] = [];
  new Parser({
    onopentag(name, attributes) {
      const element = { name, attributes, text: '', children: [] };
      stack.at(-1)?.children.push(element); elements.push(element); stack.push(element);
    },
    ontext(text) { for (const element of stack) element.text += text; },
    onclosetag() { stack.pop(); },
  }).end(markup);
  const withClass = (className: string) => elements.find(element => element.attributes.class?.split(' ').includes(className));
  return {
    elements, images: elements.filter(element => element.name === 'img'),
    summary: withClass('voice-summary'), pulse: withClass('voice-connection-pulse'),
    status: elements.find(element => element.attributes.role === 'status'),
    button: (label: string) => elements.find(element => element.name === 'button' && element.attributes['aria-label'] === label),
  };
}
const expressionSource = (choice: AppIconChoice, expression: 'listening' | 'speaking') => '/icons/nova-assistant-' + choice + '-' + expression + '-256-v1.webp';

test('inline and floating voice use the selected artwork while the ready microphone waits for speech', () => {
  for (const choice of ['red', 'cream'] as const) for (const floating of [false, true]) {
    for (const listening of [false, true]) {
      const panel = renderPanel(choice, { listening }, floating);
      assert.equal(panel.images[0].attributes.src, expressionSource(choice, 'listening'));
      assert.equal(panel.images[0].attributes.width, '60');
      assert.equal(panel.images[0].attributes.height, '60');
      assert.equal(panel.status?.text, 'Listening');
      assert.equal(panel.pulse, undefined);
    }
  }
});

test('processing and mute show rest, actual playback takes priority, and readiness restores listening', () => {
  for (const choice of ['red', 'cream'] as const) {
    const voice: Partial<VoiceView> = {};
    const transition = (patch: Partial<VoiceView>, source: string, status: string) => {
      Object.assign(voice, patch);
      const panel = renderPanel(choice, voice);
      assert.equal(panel.images[0].attributes.src, source);
      assert.equal(panel.status?.text, status);
    };
    transition({ processing: true }, appIconAssets(choice).brand, 'Thinking');
    transition({ speaking: true }, expressionSource(choice, 'speaking'), 'Speaking');
    transition({ muted: true }, expressionSource(choice, 'speaking'), 'Speaking');
    transition({ speaking: false, processing: false, listening: true }, appIconAssets(choice).brand, 'Muted');
    transition({ muted: false, listening: false }, expressionSource(choice, 'listening'), 'Listening');
    transition({ processing: true }, appIconAssets(choice).brand, 'Thinking');
    transition({ processing: false }, expressionSource(choice, 'listening'), 'Listening');
  }
});

test('connection stages replace stale activity artwork with a pulse and retain the End control', () => {
  for (const choice of ['red', 'cream'] as const) for (const floating of [false, true]) {
    for (const phase of ['permission', 'preparing', 'connecting'] as const) {
      const panel = renderPanel(choice, { phase, speaking: true, listening: true, processing: true, muted: true }, floating);
      assert.equal(panel.images.length, 0);
      assert.ok(panel.pulse);
      assert.equal(panel.pulse.attributes['aria-hidden'], 'true');
      assert.equal(panel.status?.text, 'Connecting');
      assert.ok(panel.button('End voice call'));
      assert.equal(panel.button('End voice call')?.attributes.disabled, undefined);
    }
  }
});

test('stopped calls use resting art and retain caption recovery without showing stale activity', () => {
  for (const phase of ['ending', 'ended', 'error'] as const) {
    const panel = renderPanel('cream', { phase, speaking: true, listening: true, processing: true });
    assert.equal(panel.images[0].attributes.src, appIconAssets('cream').brand);
    assert.equal(panel.pulse, undefined);
    assert.equal(panel.status?.text, 'Audio is off');
    if (phase !== 'ending') {
      assert.ok(panel.button('Close voice call'));
      assert.equal(panel.button('End voice call'), undefined);
      const unsaved = renderPanel('cream', { phase, unsaved: 2 });
      assert.ok(unsaved.button('Retry saving voice captions'));
      assert.equal(unsaved.button('Close voice call'), undefined);
    }
  }
  assert.equal(renderPanel('red', { phase: 'idle' }).elements.length, 0);
});

test('the compact details control is art-only while call status and original conversation remain accessible', () => {
  const attempt = { target: { conversation: { id: 'original-call', title: 'Original call' } } } as VoiceView['attempt'];
  for (const floating of [false, true]) for (const phase of ['connected', 'connecting', 'ended'] as const) {
    const panel = renderPanel('red', { phase, attempt }, floating);
    assert.ok(panel.summary);
    assert.equal(panel.summary.text, '', 'the tile has no visible state or conversation subtitle');
    assert.equal(panel.summary.children.length, 1, 'the tile contains artwork or the connection pulse only');
    assert.equal(panel.summary.attributes['aria-label'], 'Voice call details');
    assert.equal(panel.summary.attributes['aria-expanded'], 'false');
    assert.ok(panel.status?.attributes.class?.split(' ').includes('sr-only'));
    assert.ok(panel.status?.text.endsWith(' · Original call'));
  }
  const blockedSound = renderPanel('red', { soundBlocked: true });
  assert.ok(blockedSound.button('Enable sound'));
});
