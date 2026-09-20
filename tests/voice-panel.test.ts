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

function renderPanel(appIcon: AppIconChoice, patch: Partial<VoiceView>, floating = false) {
  const voice: VoiceView = { phase: 'connected', muted: false, speaking: false, listening: false, processing: false, soundBlocked: false, message: '', turns: [], unsaved: 0, ...patch };
  const controller = { subscribe: () => () => {}, getSnapshot: () => voice } as unknown as VoiceController;
  const markup = renderToStaticMarkup(createElement(VoicePanel, { appIcon, controller, floating, openConversation() {} }));
  const images: Record<string, string>[] = [];
  new Parser({ onopentag(name, attributes) { if (name === 'img') images.push(attributes); } }).end(markup);
  return images;
}

test('inline and floating voice artwork follows the selected icon and live audio activity', () => {
  for (const choice of ['red', 'cream'] as const) for (const floating of [false, true]) {
    const resting = appIconAssets(choice).brand;
    assert.equal(renderPanel(choice, {}, floating)[0].src, resting);
    assert.equal(renderPanel(choice, { listening: true }, floating)[0].src, `/icons/nova-assistant-${choice}-listening-256-v1.webp`);
    assert.equal(renderPanel(choice, { speaking: true }, floating)[0].src, `/icons/nova-assistant-${choice}-speaking-256-v1.webp`);
    assert.equal(renderPanel(choice, { listening: true, muted: true }, floating)[0].src, resting);
    assert.equal(renderPanel(choice, { processing: true }, floating)[0].src, resting);
    assert.equal(renderPanel(choice, { speaking: true, muted: true }, floating)[0].src, `/icons/nova-assistant-${choice}-speaking-256-v1.webp`, 'muting the microphone does not stop actual Assistant playback');
  }
});

test('connecting and stopped voice never display stale listening or speaking activity', () => {
  for (const phase of ['permission', 'preparing', 'connecting', 'ending', 'ended', 'error'] as const) {
    assert.equal(renderPanel('cream', { phase, speaking: true, listening: true })[0].src, appIconAssets('cream').brand);
  }
  assert.equal(renderPanel('red', { phase: 'idle' }).length, 0);
});
