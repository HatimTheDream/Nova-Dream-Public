import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultLayout, emptyDraft, type Snapshot, type Attachment } from '../packages/domain/contracts';
import type { AssistantOperation, Conversation } from '../packages/domain/assistant';
import type { AssistantController } from '../apps/client/src/useAssistant';
const loader = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { ConversationSources } = await import('../apps/client/src/ConversationSources');
const { AssistantRunHistory, focusConversationQuestion } = await import('../apps/client/src/AssistantRunHistory');
loader.deregister();
const time = '2026-10-19T12:00:00Z';
const file = (id: string, version: number): Attachment => ({ id, name: `Original Brief v${version}.txt`, size: 20, sha256: String(version).repeat(64) });
const oldFile = file('original-v1', 1), currentFile = file('current-v2', 2), draftFile = file('draft-only', 3);
const conversation: Conversation = { id: 'chat', revision: 4, title: 'Original Chat', projectId: 'project', archived: false, model: null, thinking: null, createdAt: time, updatedAt: time, connectionGeneration: 'generation', nativeKey: 'key', nativeId: 'native', state: 'ready' };
function snapshot(): Snapshot { return { epoch: 'epoch', deviceId: 'device', cursor: 0, layout: { id: 'layout', deviceId: 'device', revision: 1, updatedAt: time, value: defaultLayout }, tasks: [], drafts: [], capabilities: { assistant: true, voice: false, reason: '' }, projects: [{ id: 'project', deviceId: 'device', revision: 2, updatedAt: time, value: { name: 'Current Project', purpose: 'Current instructions', attachments: [currentFile] } }] }; }
function operation(id = 'original-reply'): AssistantOperation { return { id, requestId: 'original-request', deviceId: 'device', epoch: 'epoch', conversationId: 'chat', conversationRevision: 3, connectionGeneration: 'generation', nativeKey: 'key', nativeId: 'native', nativeRunId: 'native-run', state: 'unknown', input: 'The original exact input', context: { project: { id: 'project', revision: 1, name: 'Captured Project', purpose: 'Captured instructions' }, attachments: [oldFile], draftId: 'original-draft', draftRevision: 4, digest: 'a'.repeat(64) }, model: null, thinking: null, createdAt: time, updatedAt: time, text: '', lastSequence: 0 }; }
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];

test('source inspection and preview preserve current-v2, captured-v1 and original draft files without mutation', () => {
  const saved = snapshot(), original = operation(); let preview: Attachment | undefined, edited: string | undefined;
  const props = { snapshot: saved, conversation, draft: { ...emptyDraft, projectId: 'project', text: 'Keep my unsent writing', attachments: [draftFile] }, operations: [original], editProject: (id: string) => { edited = id; }, openFile: (value: Attachment) => { preview = value; } };
  const before = JSON.stringify(props);
  const current = renderToStaticMarkup(createElement(ConversationSources, props));
  const captured = renderToStaticMarkup(createElement(ConversationSources, { ...props, operationId: original.id }));
  assert.match(current, /Current Project Version 2/); assert.match(current, /current-v2/); assert.match(current, /draft-only/); assert.doesNotMatch(current, /original-v1/);
  assert.match(captured, /Project version 1/); assert.match(captured, /Captured instructions/); assert.match(captured, /original-v1/); assert.doesNotMatch(captured, /current-v2|draft-only/);
  const tree = ConversationSources({ ...props, operationId: original.id });
  nodes(tree).find(node => node.props['aria-label'] === 'Preview Original Brief v1.txt').props.onClick();
  assert.equal(preview, oldFile, 'preview receives the exact immutable original attachment object');
  assert.equal(edited, undefined); assert.equal(JSON.stringify(props), before);
  saved.projects[0].value.attachments = [];
  assert.equal(renderToStaticMarkup(createElement(ConversationSources, { ...props, operationId: original.id })), captured, 'removing a current source never changes its capture');
  nodes(ConversationSources(props)).find(node => node.type === 'button' && node.props.children === 'Project Settings').props.onClick();
  assert.equal(edited, 'project');
});

test('missing and reserved-looking captures stay unavailable instead of substituting current sources', () => {
  const props = { snapshot: snapshot(), conversation, draft: emptyDraft, operations: [operation()], editProject() {} };
  for (const operationId of ['missing-reply', 'next']) {
    const html = renderToStaticMarkup(createElement(ConversationSources, { ...props, operationId }));
    assert.match(html, /captured sources are unavailable/);
    assert.doesNotMatch(html, /Current Project|current-v2|Project Settings/);
  }
});

test('steering shows and previews its original reply files separately from the direction files', () => {
  const original = operation(), direction = { ...operation('direction'), steerTarget: original.id, context: { ...original.context, attachments: [draftFile] } };
  const selected: Attachment[] = [];
  const props = { snapshot: snapshot(), conversation, draft: emptyDraft, operations: [original, direction], operationId: direction.id, editProject() {}, openFile: (value: Attachment) => selected.push(value) };
  const html = renderToStaticMarkup(createElement(ConversationSources, props));
  assert.match(html, /Files added with this direction/); assert.match(html, /Original reply/);
  for (const node of nodes(ConversationSources(props)).filter(node => node.type === 'button' && node.props['aria-label']?.startsWith('Preview'))) node.props.onClick();
  assert.deepEqual(selected, [draftFile, oldFile]);
});

test('Run History inspection preserves exact source and original reconciliation callbacks without automatic action', () => {
  const original = operation(), completed = { ...operation('completed-reply'), state: 'completed' as const };
  const checks: string[] = [], captures: string[] = [];
  const controller = { checkStatus: async (id: string) => { checks.push(id); }, refresh: async () => {}, questions: { state: 'ready', items: [] }, approvals: { state: 'ready', items: [] } } as unknown as AssistantController;
  const tree = AssistantRunHistory({ operations: [original, completed], controller, conversation, epoch: 'epoch', openSources: id => captures.push(id), returnToQuestion() {} });
  assert.deepEqual(checks, []); assert.deepEqual(captures, []);
  const buttons = nodes(tree).filter(node => node.type === 'button');
  buttons.filter(node => node.props.children === 'View captured sources')[0].props.onClick();
  assert.deepEqual(captures, [original.id]); assert.deepEqual(checks, []);
  const reconcile = buttons.filter(node => node.props.children === 'Check status');
  assert.equal(reconcile.length, 1, 'completed work does not acquire a new check or retry');
  reconcile[0].props.onClick(); assert.deepEqual(checks, ['chat']);
  assert.equal(original.requestId, 'original-request'); assert.equal(original.input, 'The original exact input');
});

test('Return To Question opens the existing disclosure and focuses only the exact original card', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'HTMLDetailsElement');
  let focused = '', scrolled = 0;
  class Details { open = false; parentElement = { classList: { contains: () => true } }; classList = { contains: () => false }; }
  Object.defineProperty(globalThis, 'HTMLDetailsElement', { configurable: true, value: Details });
  const detail = new Details();
  const card = { dataset: { questionId: 'exact-question' }, parentElement: detail, querySelector: () => ({ focus() { assert.equal(detail.open, true); focused = 'exact-question'; } }), scrollIntoView() { scrolled++; } };
  const unrelated = { ...card, dataset: { questionId: 'other-question' }, querySelector: () => ({ focus() { focused = 'wrong'; } }) };
  const root = { querySelectorAll: () => [unrelated, card] } as unknown as Pick<Document, 'querySelectorAll'>;
  try {
    assert.equal(focusConversationQuestion('missing', root), false); assert.equal(scrolled, 0);
    assert.equal(focusConversationQuestion('exact-question', root), true); assert.equal(focused, 'exact-question'); assert.equal(scrolled, 1);
  } finally { if (previous) Object.defineProperty(globalThis, 'HTMLDetailsElement', previous); else Reflect.deleteProperty(globalThis, 'HTMLDetailsElement'); }
});
