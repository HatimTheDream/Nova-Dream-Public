import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantOperation, ConversationMessage } from '../packages/domain/assistant';
import { isResearchReport } from '../apps/client/src/research-report';
import { researchSources } from '../apps/client/src/research-sources';
const message = { id: 'result', role: 'assistant', text: 'A sourced answer', operationId: 'op', attachments: [] } as unknown as ConversationMessage;
const operation = { id: 'op', conversationId: 'chat-a', nativeId: 'session-a', nativeRunId: 'run', state: 'completed', context: { workMode: 'research' }, text: message.text } as AssistantOperation;
test('only the exact completed Research answer gets report controls, including saved native messages', () => {
  assert.ok(isResearchReport(message, [operation], 'chat-a', 'session-a'));
  assert.ok(isResearchReport({ ...message, operationId: undefined, runId: 'run' }, [operation], 'chat-a', 'session-a'));
  assert.equal(isResearchReport(message, [operation], 'chat-b'), false);
  assert.equal(isResearchReport({ ...message, operationId: undefined, runId: 'run' }, [operation], 'chat-a', 'session-b'), false);
  assert.equal(isResearchReport({ ...message, text: 'I will search now.' }, [operation], 'chat-a'), false);
  assert.equal(isResearchReport(message, [{ ...operation, state: 'running' }], 'chat-a'), false);
  assert.equal(isResearchReport(message, [{ ...operation, context: { ...operation.context, workMode: 'chat' } }], 'chat-a'), false);
  assert.equal(isResearchReport({ ...message, runId: 'different-run' }, [operation], 'chat-a', 'session-a'), false);
  assert.equal(isResearchReport({ ...message, source: { nativeId: 'different-session' } as any }, [operation], 'chat-a', 'session-a'), false);
  assert.equal(isResearchReport({ ...message, operationId: undefined, runId: 'run', source: { nativeId: 'session-a', nativeKey: 'other-binding', connectionGeneration: 'other-generation' } as any }, [operation], 'chat-a', 'session-a'), false);
});
test('source disclosure preserves actual distinct links and excludes unsafe URLs and local anchors', () => {
  const sources = researchSources([{ href: 'https://science.nasa.gov/earth/', title: ' NASA Earth ' }, { href: 'https://science.nasa.gov/earth/', title: 'Repeated citation' }, { href: 'https://www.noaa.gov/', title: '' }, ...['#footnote', 'javascript:alert(1)', 'file:///private', 'https://user:password@example.com'].map(href => ({ href, title: 'Unsafe' }))]);
  assert.deepEqual(sources, [{ href: 'https://science.nasa.gov/earth/', title: 'NASA Earth', host: 'science.nasa.gov' }, { href: 'https://www.noaa.gov/', title: 'www.noaa.gov', host: 'noaa.gov' }]);
});

test('Chat reports use captured space and completed execution, never a Work answer or research preparation', () => {
  const research = { ...operation, context: { ...operation.context, space: 'chat' as const, researchWorkflow: 'chat-research-v1' as const, approvedPlan: { id: 'plan', version: 1, digest: 'a'.repeat(64), proposal: { title: 'Seasons', summary: 'Explain seasons', steps: ['Compare'], assumptions: [], verification: ['Check citations'] } } } };
  assert.ok(isResearchReport(message, [research], 'chat-a', 'session-a', 'work'), 'captured Chat remains Chat when another space is selected');
  assert.equal(isResearchReport(message, [{ ...research, context: { ...research.context, space: 'work' } }], 'chat-a', 'session-a'), false);
  assert.equal(isResearchReport(message, [{ ...research, context: { ...research.context, approvedPlan: undefined, planReview: { id: 'plan', version: 1 } } }], 'chat-a', 'session-a'), false);
  assert.equal(isResearchReport(message, [operation], 'chat-a', 'session-a', 'work'), false, 'legacy Work reports stay ordinary answers');
  assert.equal(isResearchReport(message, [{ ...research, steerTarget: 'other' } as AssistantOperation], 'chat-a', 'session-a'), false);
});
