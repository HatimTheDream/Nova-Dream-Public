import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import { emptyDraft } from '../packages/domain/contracts';

const attachmentFixture = Symbol.for('nova.test.composer.attachments');
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
// Render the actual composer without starting uploads, subscriptions or effects.
// External stores provide their current fixture snapshot during server rendering.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:composer-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:composer-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(reactUrl)};
      import React from ${JSON.stringify(reactUrl)};
      export default React;
      export const useSyncExternalStore = (subscribe, snapshot, server = snapshot) => React.useSyncExternalStore(subscribe, snapshot, server);
    ` };
    if (url.endsWith('/useAttachments.ts')) return { format: 'module', shortCircuit: true, source: `export const useAttachments = () => globalThis[Symbol.for('nova.test.composer.attachments')];` };
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  },
});
const { Assistant } = await import('../apps/client/src/Assistant');
hooks.deregister();

type FileState = 'ready' | 'preparing' | 'uploading' | 'failed';
function renderComposer(files: FileState, existing = false, active = false, text = 'Keep this draft') {
  const globals = [attachmentFixture, 'localStorage', 'matchMedia'] as const;
  const previous = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const pending = files === 'uploading' || files === 'failed' ? [{ id: 'file', name: 'Fixture.txt' }] : [];
  Object.defineProperty(globalThis, attachmentFixture, { configurable: true, value: { staging: files === 'preparing', pending, errors: files === 'failed' ? { file: 'Upload paused' } : {}, notice: '', add() {}, retry() {}, remove() {} } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: true }) });
  try {
    const time = '2026-09-19T12:00:00Z';
    const conversation = existing ? { id: 'conversation', nativeId: 'native', nativeKey: 'native-key', connectionGeneration: 'generation', revision: 1, title: 'Fixture', state: 'ready', projectId: null, archived: false, model: null, thinking: null, createdAt: time, updatedAt: time } : undefined;
    const draft = { ...emptyDraft, text, ...(existing ? { conversationId: 'conversation' } : {}) };
    const props = {
      snapshot: { epoch: 'epoch', deviceId: 'device', projects: [], drafts: existing ? [{ id: 'draft:device:conversation', revision: 1, value: draft, updatedAt: time }] : [], records: {} },
      legacyJournal: { value: draft, revision: 1, dirty: false, saving: false, change() {}, flush: async () => {} },
      controller: { space: 'chat', selectedId: conversation?.id, conversation, conversations: conversation ? [conversation] : [], statusRead: 'ready', connection: { state: 'ready', generation: 'generation', methods: [], grantedScopes: ['operator.write'] }, operations: active ? [{ id: 'operation', conversationId: 'conversation', nativeRunId: 'run', state: 'running', createdAt: time, updatedAt: time }] : [], models: [], outputs: [], queue: [], pins: [], removals: [], select() {}, refresh: async () => {} },
      voice: { subscribe: () => () => {}, getSnapshot: () => ({ phase: 'idle', turns: [] }) },
      contentActions: {}, refreshWorkspace: async () => {}, openSettings() {}, newProject() {}, editProject() {},
    } as unknown as ComponentProps<typeof Assistant>;
    const markup = renderToStaticMarkup(createElement(Assistant, props));
    const buttons: { label: string; disabled: boolean; className: string }[] = [];
    let current: typeof buttons[number] | undefined;
    new Parser({
      onopentag(name, attrs) { if (name === 'button') { current = { label: attrs['aria-label'] ?? '', disabled: 'disabled' in attrs, className: attrs.class ?? '' }; buttons.push(current); } },
      ontext(value) { if (current) current.label += value; },
      onclosetag(name) { if (name === 'button') current = undefined; },
    }).end(markup);
    const button = (label: string) => { const found = buttons.find(item => item.label === label); assert.ok(found, `Missing ${label}`); return found; };
    return { markup, buttons, button };
  } finally {
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test('new and existing composers block sending and voice while files are prepared, uploading or paused', () => {
  for (const existing of [false, true]) {
    for (const files of ['preparing', 'uploading', 'failed'] as const) {
      const view = renderComposer(files, existing);
      assert.equal(view.button('Send message').disabled, true);
      assert.equal(view.button('Start voice call').disabled, true);
      const switches = view.buttons.filter(button => ['Chat', 'Work'].includes(button.label));
      assert.equal(switches.length, 4);
      assert.ok(switches.every(button => button.disabled));
      if (files === 'preparing') assert.match(view.markup, /role="status">Preparing Files/);
    }
    const ready = renderComposer('ready', existing);
    assert.equal(ready.button('Send message').disabled, false);
    assert.equal(ready.button('Start voice call').disabled, false);
  }
});

test('preparing files blocks queue and steer while retaining Stop Reply for an empty draft', () => {
  const pending = renderComposer('preparing', true, true);
  assert.equal(pending.button('Queue message').disabled, true);
  assert.equal(pending.button('Steer current reply').disabled, true);
  const ready = renderComposer('ready', true, true);
  assert.equal(ready.button('Queue message').disabled, false);
  assert.equal(ready.button('Steer current reply').disabled, false);
  const stop = renderComposer('preparing', true, true, '');
  assert.equal(stop.button('Stop reply').disabled, false);
});
