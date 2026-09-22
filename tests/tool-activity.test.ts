import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolActivity, historyToolInfo, toolDisplayInput } from '../packages/domain/tool-activity.js';
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
  assert.deepEqual(historyToolInfo({ role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: 'notes.md', secret: 'do not retain' } }] }), { name: 'read', state: 'called', calls: ['read'], entries: [{ name: 'read', input: 'notes.md' }] });
  assert.equal(historyToolInfo({ role: 'assistant', content: 'hello' }), undefined);
});

test('native parallel calls retain exact identities and selected inputs without retaining arbitrary arguments', () => {
  const info = historyToolInfo({ role: 'assistant', content: [
    { type: 'toolCall', id: 'first', name: 'read', arguments: { path: 'src/App.tsx', env: { private: 'not retained' }, other: 'not retained' } },
    { type: 'toolCall', id: 'second', name: 'exec', arguments: { command: 'git status --short', env: { private: 'not retained' } } },
    { type: 'toolCall', id: '', name: 'web_search', arguments: { query: 'Nova setup guide' } },
  ] })!;
  assert.deepEqual(info.entries, [{ id: 'first', name: 'read', input: 'src/App.tsx' }, { id: 'second', name: 'exec', input: 'git status --short' }, { name: 'web_search', input: 'Nova setup guide' }]);
  assert.deepEqual(info.calls, ['read', 'exec', 'web_search']); assert.equal(info.id, undefined);
  assert.doesNotMatch(JSON.stringify(info), /not retained|env|other/);
  assert.equal(historyToolInfo({ role: 'assistant', content: [{ type: 'toolCall', id: 'only', name: 'read' }] })!.id, 'only');
  assert.equal(historyToolInfo({ role: 'toolResult', toolCallId: ' '.repeat(3) })!.id, undefined);
});

test('input summaries omit secrets, environment assignments, scripts and unrecognized tool arguments', () => {
  for (const command of ['TOKEN=fixture npm test', 'curl --header "Authorization: Bearer fixture" https://example.test', 'curl https://owner:fixture@example.test', 'echo ghp_1234567890abcdef', 'node -e "process.env"', 'echo first\necho second']) assert.equal(toolDisplayInput('exec', { command }), undefined, command);
  assert.equal(toolDisplayInput('exec', { command: 'npm test', env: { TOKEN: 'do not retain' }, token: 'do not retain' }), 'npm test');
  assert.equal(toolDisplayInput('unknown', { command: 'do not retain', path: 'do not retain', query: 'do not retain' }), undefined);
  assert.equal(toolDisplayInput('web_fetch', { url: 'https://example.test/docs?access=private' }), undefined);
  assert.equal(toolDisplayInput('web_fetch', { url: 'https://example.test/docs' }), 'https://example.test/docs');
  assert.equal(toolDisplayInput('read', { path: 'a'.repeat(700) })?.length, 600);
  assert(toolDisplayInput('read', { path: 'a'.repeat(700) })?.endsWith('…'));
  assert.equal(toolDisplayInput('read', { path: 'a'.repeat(4097) }), undefined);
  const start = toolActivity([], { phase: 'start', name: 'exec', toolCallId: 'one', args: { command: 'git status --short', env: { SECRET: 'never retain' } } }, 1);
  assert.equal(start[0].input, 'git status --short');
  assert.equal(toolActivity(start, { phase: 'result', name: 'exec', toolCallId: 'one', isError: false }, 2)[0].input, 'git status --short');
});

test('saved and live tools distinguish denied, failed and unconfirmed outcomes without guessing from prose', () => {
  const saved = (value: object) => historyToolInfo({ role: 'toolResult', toolCallId: 'one', toolName: 'exec', ...value })!.state;
  assert.equal(saved({ content: 'No explicit outcome' }), 'unknown');
  assert.equal(saved({ isError: false }), 'completed'); assert.equal(saved({ isError: true }), 'failed');
  assert.equal(saved({ error: { code: 'SYSTEM_RUN_DENIED' } }), 'blocked');
  assert.equal(saved({ content: [{ type: 'text', text: 'Exec denied (SYSTEM_RUN_DENIED: approval requires a resolved executable): git status' }] }), 'blocked');
  assert.equal(saved({ content: 'SYSTEM_RUN_DENIED: approval required' }), 'blocked');
  assert.equal(saved({ content: 'The document discusses SYSTEM_RUN_DENIED: and permission denied.' }), 'unknown');
  assert.equal(saved({ isError: true, content: 'Access denied while reading the file' }), 'failed');
  const blocked = toolActivity([], { phase: 'result', name: 'exec', toolCallId: 'one', result: { error: { code: 'SYSTEM_RUN_DENIED' } } }, 1);
  assert.equal(blocked[0].state, 'blocked');
  assert.equal(toolActivity(blocked, { phase: 'start', name: 'exec', toolCallId: 'one' }, 2), blocked);
});
