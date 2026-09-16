import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolActivity, historyToolInfo } from '../packages/domain/tool-activity.js';
test('tool events merge by call identity without replay, raw arguments or invented success', () => {
  const start = toolActivity([], { phase: 'start', name: 'exec', toolCallId: 'one', args: { secret: 'do not retain' } }, 1);
  assert.equal(start[0].state, 'running'); assert.equal(JSON.stringify(start).includes('secret'), false);
  assert.equal(toolActivity(start, { phase: 'result', name: 'exec', toolCallId: 'one', result: 'done' }, 1), start);
  const result = toolActivity(start, { phase: 'result', name: 'exec', toolCallId: 'one', isError: false, output: 'x'.repeat(20000) }, 3);
  assert.equal(result.length, 1); assert.equal(result[0].state, 'completed'); assert.equal(result[0].output?.length, 16000); assert.equal(result[0].truncated, true);
  assert.equal(toolActivity(result, { phase: 'start', name: 'exec', toolCallId: 'one' }, 4), result);
  assert.equal(toolActivity(start, { phase: 'result', name: 'exec', toolCallId: 'one', result: 'unconfirmed' }, 4)[0].state, 'unknown');
  assert.equal(toolActivity(start, { phase: 'update', name: 'exec', toolCallId: 'one', hideFromChannelProgress: true }, 4), start);
});
test('native tool results and assistant calls stay distinct from ordinary replies', () => {
  assert.deepEqual(historyToolInfo({ role: 'toolResult', toolName: 'read', isError: true }), { name: 'read', state: 'failed' });
  assert.deepEqual(historyToolInfo({ role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: 'private' } }] }), { name: 'read', state: 'called', calls: ['read'] });
  assert.equal(historyToolInfo({ role: 'assistant', content: 'hello' }), undefined);
});
