import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';
import { imageGenerationState, isImageGenerationTool } from '../packages/domain/image-generation';
import type { AssistantOperation } from '../packages/domain/assistant';
import type { ToolActivity } from '../packages/domain/tool-activity';
const css = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { WorkTranscript } = await import('../apps/client/src/WorkTranscript');
css.deregister();
const tool: ToolActivity = { id: 'generator', name: 'image_gen__imagegen', state: 'running', sequence: 2 };
const operation = { id: 'image-operation', nativeRunId: 'run', state: 'running', text: '', createdAt: '2026-09-23T01:00:00Z', updatedAt: '2026-09-23T01:00:01Z', context: { workMode: 'image' }, tools: [tool] } as AssistantOperation;

test('only observed image-generation calls animate; selected mode and image-reading tools do not', () => {
  for (const name of ['image_gen__imagegen', 'functions.image_generate', 'generate_image']) assert.ok(isImageGenerationTool(name));
  for (const name of ['image', 'read_image', 'image_search', 'exec', 'look_at_image']) assert.equal(imageGenerationState({ ...tool, name }, operation), null);
  assert.equal(imageGenerationState(tool, operation), 'generating');
  assert.equal(imageGenerationState(tool), 'unconfirmed');
});

test('stop requests freeze animation, missing outcomes stay unconfirmed, and all terminal results remove the placeholder', () => {
  assert.equal(imageGenerationState(tool, { state: 'running', cancelRequested: true }), 'stopping');
  assert.equal(imageGenerationState(tool, { state: 'unknown', cancelRequested: true }), 'unconfirmed');
  assert.equal(imageGenerationState({ ...tool, state: 'unknown' }, operation), 'unconfirmed');
  for (const state of ['completed', 'failed', 'cancelled'] as const) assert.equal(imageGenerationState(tool, { state }), null);
  for (const state of ['completed', 'failed', 'blocked'] as const) assert.equal(imageGenerationState({ ...tool, state }, operation), null);
});

test('one live tool renders one dotted square; completion replaces it with the returned image message', () => {
  const renderMessage = (message: any) => createElement('article', null, message.text);
  const render = (op: AssistantOperation, final?: any) => renderToStaticMarkup(createElement(WorkTranscript, { message: { id: 'turn', role: 'assistant', text: '', textHash: '', attachments: [], workParts: [], workOperation: op, workFinal: final }, renderMessage }));
  const active = render(operation);
  assert.equal((active.match(/class="image-generation-tile"/g) ?? []).length, 1);
  assert.match(active, /role="status" aria-live="polite" aria-label="Creating image…"/);
  const selected = render({ ...operation, tools: [] });
  assert.doesNotMatch(selected, /image-generation-tile/);
  const final = render({ ...operation, state: 'completed', tools: [{ ...tool, state: 'completed' }] }, { text: 'Your generated image', attachments: [] });
  assert.doesNotMatch(final, /image-generation-tile/);
  assert.match(final, /Your generated image/);
  const unknown = render({ ...operation, state: 'unknown' });
  assert.match(unknown, /Image status unconfirmed/);
  assert.doesNotMatch(unknown, /image-generation--generating/);
});
