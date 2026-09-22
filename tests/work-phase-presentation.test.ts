import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';
import { Parser } from 'htmlparser2';
import type { AssistantOperation, ConversationMessage } from '../packages/domain/assistant';
import type { ToolActivity } from '../packages/domain/tool-activity';

const styles = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { WorkPhase, workPhaseLabel } = await import('../apps/client/src/WorkPhase');
const { ActivityRow, HistoryTool, copyActivityDetails } = await import('../apps/client/src/ToolActivity');
styles.deregister();
const operation = (changes: Partial<AssistantOperation> = {}) => ({ id: 'same-operation', state: 'running', createdAt: '2026-09-21T12:00:00Z', updatedAt: '2026-09-21T12:00:05Z', ...changes }) as AssistantOperation;

test('work duration stops at the first recorded settlement and uncertain progress never keeps ticking', () => {
  const later = Date.parse('2026-09-21T12:05:00Z');
  assert.equal(workPhaseLabel(operation(), true, later), 'Working for 5m 0s');
  assert.equal(workPhaseLabel(operation({ state: 'completed', settledAt: '2026-09-21T12:01:32Z', updatedAt: '2026-09-21T12:04:00Z' }), false, later), 'Worked for 1m 32s');
  assert.equal(workPhaseLabel(operation({ state: 'unknown' }), true, later), 'Progress unconfirmed · 5s observed');
  assert.equal(workPhaseLabel(operation({ state: 'cancelled' }), false, later), 'Stopped after 5s');
  assert.equal(workPhaseLabel(operation({ state: 'failed' }), false, later), 'Work interrupted after 5s');
  assert.equal(workPhaseLabel(undefined, false, later), 'Work details');
  assert.equal(workPhaseLabel(operation({ createdAt: 'unavailable' }), false, later), 'Progress unconfirmed');
  const long = operation({ state: 'completed', settledAt: '2026-09-21T13:02:03Z', updatedAt: '2026-09-21T14:00:00Z' });
  assert.equal(workPhaseLabel(long, false, Date.parse('2026-09-21T15:00:00Z')), 'Worked for 1h 2m 3s');
});

test('active work starts open, finished work collapses, and a matching search target opens the saved details', () => {
  const render = (props: { operation: AssistantOperation; forceOpen?: boolean }) => renderToStaticMarkup(createElement(WorkPhase, { ...props, children: createElement('p', null, 'Original commentary') }));
  assert.match(render({ operation: operation() }), /aria-expanded="true"/);
  const complete = operation({ state: 'completed' });
  assert.match(render({ operation: complete }), /aria-expanded="false"/);
  assert.match(render({ operation: complete }), /class="work-phase-content" hidden=""/);
  assert.match(render({ operation: complete, forceOpen: true }), /aria-expanded="true"/);
});

test('saved calls without results have an unconfirmed outcome rather than an active or successful label', () => {
  const message = { id: 'original-call', role: 'assistant', text: '', textHash: '', attachments: [], toolInfo: { name: 'read', state: 'called', entries: [{ id: 'read-1', name: 'read', input: 'README.md' }] } } as ConversationMessage;
  const markup = renderToStaticMarkup(createElement(HistoryTool, { message }));
  assert.match(markup, /Outcome unconfirmed/);
  assert.match(markup, /README\.md/);
  assert.doesNotMatch(markup, /Reading a file|Read a file|Tool call|>completed</);
  assert.equal(message.toolInfo?.state, 'called');
});

test('blocked commands explain that nothing ran and keep input and the exact reason in one disclosure', () => {
  const markup = renderToStaticMarkup(createElement(ActivityRow, { tool: { id: 'cmd-1', name: 'exec', state: 'blocked', input: 'rg -n github docs', output: 'Exec denied (SYSTEM_RUN_DENIED: approval requires a resolved executable): rg -n github docs', sequence: 1 } }));
  assert.match(markup, /The command did not run/);
  assert.match(markup, /aria-label="Shell details"/);
  assert.match(markup, /SYSTEM_RUN_DENIED/);
  assert.equal((markup.match(/<details /g) ?? []).length, 1);
  assert.equal((markup.match(/class="work-activity-value"/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /Ran a command|>Failed</);
});

test('large results have a bounded preview and an explicit full-text control', () => {
  const markup = renderToStaticMarkup(createElement(ActivityRow, { tool: { id: 'read-1', name: 'read', state: 'completed', output: Array.from({ length: 80 }, (_, i) => `Saved line ${i}`).join('\n'), truncated: true, sequence: 1 } }));
  assert.match(markup, /Saved line 11/);
  assert.doesNotMatch(markup, /Saved line 12/);
  assert.match(markup, /Show full saved text/);
  assert.match(markup, /Only part of this result was saved here/);
  assert.match(markup, /aria-label="Copy details"/);
  const searched = renderToStaticMarkup(createElement(ActivityRow, { forceOpen: true, tool: { id: 'read-1', name: 'read', state: 'completed', output: Array.from({ length: 80 }, (_, i) => `Saved line ${i}`).join('\n'), sequence: 1 } }));
  assert.match(searched, /Saved line 79/);
});

test('one shared detail surface retains the exact saved input and full output when expanded', () => {
  const tool: ToolActivity = { id: 'long-command', name: 'exec_command', state: 'completed', input: 'echo "<saved>"', output: Array.from({ length: 80 }, (_, i) => `<saved line="${i}">`).join('\n'), sequence: 1 };
  const original = JSON.stringify(tool);
  const compact = renderToStaticMarkup(createElement(ActivityRow, { tool }));
  assert.doesNotMatch(compact, /line=&quot;79&quot;/);
  const expanded = renderToStaticMarkup(createElement(ActivityRow, { tool, forceOpen: true }));
  const blocks: string[] = []; let inPre = false;
  new Parser({ onopentag(name) { if (name === 'pre') { inPre = true; blocks.push(''); } }, ontext(text) { if (inPre) blocks[blocks.length - 1] += text; }, onclosetag(name) { if (name === 'pre') inPre = false; } }).end(expanded);
  assert.deepEqual(blocks, [`${tool.input}\n\n${tool.output}`]);
  assert.equal((expanded.match(/aria-label="Copy details"/g) ?? []).length, 1);
  assert.doesNotMatch(expanded, /<saved line=/);
  assert.equal(JSON.stringify(tool), original);
});

test('missing saved details never turn an error or unconfirmed action into waiting or success', () => {
  for (const state of ['failed', 'blocked', 'unknown'] as const) {
    const markup = renderToStaticMarkup(createElement(ActivityRow, { tool: { id: state, name: 'exec', state, sequence: 1 } }));
    assert.match(markup, /Input details are not available/);
    assert.match(markup, /No output was included/);
    assert.doesNotMatch(markup, /Waiting for a result|Ran a command|Its result is below|Copy details/);
    assert.match(markup, state === 'unknown' ? /Outcome unconfirmed/ : state === 'blocked' ? />Blocked</ : />Failed</);
  }
  const running = renderToStaticMarkup(createElement(ActivityRow, { unconfirmed: true, tool: { id: 'old-run', name: 'exec', state: 'running', input: 'npm test', sequence: 1 } }));
  assert.match(running, /Outcome unconfirmed/);
  assert.match(running, /npm test/);
  assert.doesNotMatch(running, /Waiting for a result|Running a command/);
});

test('copy includes all saved details even beyond the preview and preserves clipboard failures', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const copied: string[] = [];
  const tool = { input: 'npm test', output: Array.from({ length: 80 }, (_, i) => `Original line ${i}`).join('\n') };
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (value: string) => { copied.push(value); } } } });
    await copyActivityDetails(tool);
    await copyActivityDetails({ output: tool.output });
    assert.deepEqual(copied, [`${tool.input}\n\n${tool.output}`, tool.output]);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw new Error('Clipboard unavailable'); } } } });
    await assert.rejects(copyActivityDetails(tool), /Clipboard unavailable/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
