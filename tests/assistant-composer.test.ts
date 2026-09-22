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
function renderComposer(files: FileState, existing = false, active = false, text = 'Keep this draft', options: { attachment?: boolean; cancelRequested?: boolean; noRunId?: boolean; invalidFile?: boolean; projectFile?: boolean; receipt?: boolean; voicePhase?: 'idle' | 'connecting' | 'connected' | 'ended'; disconnected?: boolean } = {}) {
  const globals = [attachmentFixture, 'localStorage', 'matchMedia'] as const;
  const previous = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const pending = files === 'uploading' || files === 'failed' ? [{ id: 'file', name: 'Fixture.txt' }] : [];
  Object.defineProperty(globalThis, attachmentFixture, { configurable: true, value: { staging: files === 'preparing', pending, errors: files === 'failed' ? { file: 'Upload paused' } : {}, notice: '', add() {}, retry() {}, remove() {} } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => options.receipt && /^e3:(submit|queue-capture|start-chat):/.test(key) ? JSON.stringify({ request: { requestId: 'original-request' }, captured: {} }) : null } });
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: true }) });
  try {
    const time = '2026-09-19T12:00:00Z';
    const conversation = existing ? { id: 'conversation', nativeId: 'native', nativeKey: 'native-key', connectionGeneration: 'generation', revision: 1, title: 'Fixture', state: 'ready', projectId: options.projectFile ? 'source-project' : null, archived: false, model: null, thinking: null, createdAt: time, updatedAt: time } : undefined;
    const sourceFile = { id: 'project-file', name: 'brief.docx', size: 12, sha256: 'b'.repeat(64), mimeType: 'application/octet-stream' };
    const draft = { ...emptyDraft, text, projectId: options.projectFile ? 'source-project' : null, attachments: options.attachment ? [{ id: 'kept-file', name: options.invalidFile ? 'brief.docx' : 'notes.txt', size: 12, sha256: 'a'.repeat(64), mime: 'text/plain' }] : [], ...(existing ? { conversationId: 'conversation' } : {}) };
    const props = {
      appIcon: 'red',
      snapshot: { epoch: 'epoch', deviceId: 'device', projects: options.projectFile ? [{ id: 'source-project', revision: 1, value: { name: 'Project', space: 'chat', purpose: '', instructions: '', attachments: [sourceFile] } }] : [], drafts: existing ? [{ id: 'draft:device:conversation', revision: 1, value: draft, updatedAt: time }] : [], records: {} },
      legacyJournal: { value: draft, revision: 1, dirty: false, saving: false, change() {}, flush: async () => {} },
      controller: { space: 'chat', selectedId: conversation?.id, conversation, conversations: conversation ? [conversation] : [], statusRead: 'ready', connection: { state: options.disconnected ? 'disconnected' : 'ready', generation: 'generation', methods: [], grantedScopes: ['operator.write'] }, operations: active ? [{ id: 'operation', conversationId: 'conversation', nativeId: 'native', nativeRunId: options.noRunId ? undefined : 'run', cancelRequested: options.cancelRequested, state: 'running', context: { project: null, attachments: [], draftId: 'draft:device:conversation', draftRevision: 1, digest: 'fixture-context' }, createdAt: time, updatedAt: time }] : [], models: [], outputs: [], queue: [], pins: [], removals: [], select() {}, refresh: async () => {} },
      voice: { subscribeLevels: () => () => {}, getLevelsSnapshot: () => ({input: 0, output: 0}), subscribe: () => () => {}, getSnapshot: () => ({ phase: options.voicePhase ?? 'idle', turns: [] }) },
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
      assert.equal(view.buttons.some(button => button.label === 'Start voice call'), false, 'Voice is secondary while a draft is being sent');
      const switches = view.buttons.filter(button => ['Chat', 'Work'].includes(button.label));
      assert.equal(switches.length, 2);
      assert.ok(switches.every(button => button.disabled));
      if (files === 'preparing') assert.match(view.markup, /role="status">Preparing Files/);
    }
    const ready = renderComposer('ready', existing);
    assert.equal(ready.button('Send message').disabled, false);
    assert.equal(ready.buttons.some(button => button.label === 'Start voice call'), false);
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


test('an active reply remains stoppable while text, files or pending uploads are kept in the composer', () => {
  for (const files of ['ready', 'preparing', 'uploading', 'failed'] as const) {
    const view = renderComposer(files, true, true);
    assert.equal(view.button('Stop reply').disabled, false);
    assert.match(view.markup, /Keep this draft/);
    assert.ok(view.button('Queue message'));
  }
  const attached = renderComposer('ready', true, true, '', { attachment: true });
  assert.equal(attached.button('Stop reply').disabled, false);
  assert.equal(attached.button('Queue message').disabled, false);
  assert.match(attached.markup, /notes.txt/);
  const stopping = renderComposer('ready', true, true, 'Keep this draft', { cancelRequested: true });
  assert.equal(stopping.button('Stopping…').disabled, true);
  assert.match(stopping.markup, /Keep this draft/);
  const waiting = renderComposer('ready', true, true, 'Keep this draft', { noRunId: true });
  assert.equal(waiting.button('Stop reply').disabled, true);
});

test('invalid draft and Project sources block a new dispatch while keeping writing and original receipt recovery', () => {
  for (const source of [{ attachment: true, invalidFile: true }, { projectFile: true }]) {
    for (const existing of [false, true]) {
      const view = renderComposer('ready', existing, false, 'Keep my original writing', source);
      assert.equal(view.button('Send message').disabled, true);
      assert.match(view.markup, /Keep my original writing/);
      assert.match(view.markup, /brief.docx cannot be sent/);
      assert.match(view.markup, /aria-describedby="assistant-source-issue"/);
      const reconcile = renderComposer('ready', existing, false, 'Keep my original writing', { ...source, receipt: true });
      assert.equal(reconcile.button('Send message').disabled, false, 'Existing request identity remains reconcilable');
    }
    const queued = renderComposer('ready', true, true, 'Keep my follow-up', source);
    assert.equal(queued.button('Queue message').disabled, true);
    assert.equal(queued.button('Stop reply').disabled, false);
  }
});


test('the empty idle composer offers one primary voice action with dictation kept separate', () => {
  for (const existing of [false, true]) {
    for (const text of ['', '  \n ']) {
      const view = renderComposer('ready', existing, false, text);
      const primary = view.buttons.filter(button => button.className.includes('send-button'));
      assert.equal(primary.length, 1);
      assert.equal(primary[0].label, 'Start voice call');
      assert.equal(primary[0].disabled, false);
      assert.equal(view.button('Dictate a message').disabled, false);
      assert.equal(view.buttons.some(button => button.label === 'Send message'), false);
    }
    for (const voicePhase of ['connecting', 'connected', 'ended'] as const) {
      assert.equal(renderComposer('ready', existing, false, '', { voicePhase }).button('Start voice call').disabled, true);
    }
    assert.equal(renderComposer('ready', existing, false, '', { disconnected: true }).button('Start voice call').disabled, true);
  }
});

test('text and file-only drafts offer Send, uploads do not flicker back to Voice, and active work keeps Stop or Queue', () => {
  for (const existing of [false, true]) {
    assert.equal(renderComposer('ready', existing, false, 'A written message').button('Send message').disabled, false);
    assert.equal(renderComposer('ready', existing, false, '', { attachment: true }).button('Send message').disabled, false);
    for (const files of ['preparing', 'uploading', 'failed'] as const) {
      const view = renderComposer(files, existing, false, '');
      assert.equal(view.button('Send message').disabled, true);
      assert.equal(view.buttons.some(button => button.label === 'Start voice call'), false);
    }
  }
  assert.equal(renderComposer('ready', true, true, '').button('Stop reply').disabled, false);
  assert.equal(renderComposer('ready', true, true, 'Follow up').button('Queue message').disabled, false);
});
