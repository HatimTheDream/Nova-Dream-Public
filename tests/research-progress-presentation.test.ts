import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantOperation, ConversationMessage } from '../packages/domain/assistant.js';
import type { TranscriptMessage } from '../apps/client/src/voice-transcript.js';

const styles = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { ToolActivity, HistoryTool } = await import('../apps/client/src/ToolActivity.js');
const { WorkPhase } = await import('../apps/client/src/WorkPhase.js');
const { WorkTranscript } = await import('../apps/client/src/WorkTranscript.js');
const { ResearchReport } = await import('../apps/client/src/ResearchReport.js');
styles.deregister();

function operation(name = 'nova_research_progress') {
  return { id: 'operation', nativeRunId: 'run', conversationId: 'chat', nativeId: 'session', state: 'completed', createdAt: '2026-09-24T07:00:00Z', updatedAt: '2026-09-24T07:01:00Z', tools: [
    { id: 'estimate', name, state: 'completed', sequence: 1, output: 'ESTIMATE_INTERNAL_RESULT' },
    { id: 'source', name: 'web_fetch', state: 'completed', sequence: 2, output: 'Observed primary source' },
  ], text: 'The final report.', context: { researchWorkflow: 'chat-research-v1' } } as AssistantOperation;
}
const message = (id: string, changes: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ id, role: 'assistant', operationId: 'operation', text: '', textHash: id, attachments: [], ...changes });

test('research bookkeeping stays quiet in activity and summaries while real source work remains visible', () => {
  for (const name of ['nova_research_progress', 'functions.nova_research_progress', 'mcp__nova__nova_research_progress']) {
    const op = operation(name), original = JSON.stringify(op);
    const activity = renderToStaticMarkup(createElement(ToolActivity, { operation: op }));
    const phase = renderToStaticMarkup(createElement(WorkPhase, { operation: op, forceOpen: true, children: createElement('p', null, 'Retained commentary') }));
    assert.match(activity, /Read a page/); assert.match(phase, /Read a page/);
    assert.doesNotMatch(activity + phase, /Updated research progress|ESTIMATE_INTERNAL_RESULT|Nova research progress/);
    assert.equal(JSON.stringify(op), original, 'Presentation never removes the saved estimate tool evidence');
  }
});

test('paired saved estimate calls and results do not clutter the work transcript or duplicate the final report', () => {
  const op = operation('functions.nova_research_progress');
  const parts = [message('estimate-call', { toolInfo: { id: 'estimate', name: op.tools![0].name, state: 'called' } }), message('estimate-result', { role: 'tool', text: 'ESTIMATE_INTERNAL_RESULT', toolInfo: { id: 'estimate', name: op.tools![0].name, state: 'completed' } })];
  const final = message('final', { text: 'The final report.' });
  const row = { ...message('grouped'), workParts: [...parts, final], workOperation: op, workFinal: final };
  const html = renderToStaticMarkup(createElement(WorkTranscript, { message: row, renderMessage: (part: ConversationMessage) => createElement('p', { 'data-message': part.id }, part.text) }));
  assert.doesNotMatch(html, /ESTIMATE_INTERNAL_RESULT|Updated research progress|Nova research progress/);
  assert.match(html, /Read a page/);
  assert.equal((html.match(/The final report\./g) ?? []).length, 1);
  assert.equal(parts[1].text, 'ESTIMATE_INTERNAL_RESULT');
});

test('report activity affordance reflects real source work instead of an estimate-only tool list', () => {
  const op = operation('mcp__nova__nova_research_progress');
  const render = (value: AssistantOperation) => renderToStaticMarkup(createElement(ResearchReport, { text: '# Report\nSaved result', operation: value, children: createElement('p', null, 'Saved result') }));
  assert.doesNotMatch(render({ ...op, tools: op.tools!.slice(0, 1) }), />Activity<\/button>/);
  assert.match(render(op), />Activity<\/button>/);
});

test('explicit raw-history rendering retains a friendly label and the exact saved estimate result', () => {
  const raw = message('raw-result', { role: 'tool', text: 'ESTIMATE_INTERNAL_RESULT', toolInfo: { id: 'estimate', name: 'functions.nova_research_progress', state: 'completed' } });
  const html = renderToStaticMarkup(createElement(HistoryTool, { message: raw }));
  assert.match(html, /Updated research progress/); assert.match(html, /ESTIMATE_INTERNAL_RESULT/);
  assert.doesNotMatch(html, /functions\.nova_research_progress|Nova research progress/);
});
