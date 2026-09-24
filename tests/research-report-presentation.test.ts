import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantOperation } from '../packages/domain/assistant';

const styles = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { ResearchReport } = await import('../apps/client/src/ResearchReport');
styles.deregister();

test('saved Research remains in the conversation with one source-bearing body and an inline expansion control', () => {
  const operation = { state: 'completed', createdAt: '2026-09-24T01:00:00Z', updatedAt: '2026-09-24T01:01:00Z', tools: [{ id: 'read', name: 'web_fetch', state: 'completed', sequence: 1 }] } as AssistantOperation;
  const html = renderToStaticMarkup(createElement('article', { 'aria-label': 'Assistant message' }, createElement(ResearchReport, { text: '# Seasons\nSource answer', operation, children: createElement('p', { 'data-source-message': 'saved-report' }, 'Source answer') })));
  assert.equal((html.match(/data-source-message="saved-report"/g) ?? []).length, 1);
  assert.match(html, /Research completed in 1m 0s/);
  assert.match(html, /aria-expanded="false" aria-controls="[^"]+"/);
  assert.match(html, />Expand<\/button>/);
  assert.match(html, />Activity<\/button>/);
  assert.doesNotMatch(html, /<dialog|aria-modal|role="dialog"/);
});

test('Research expansion is confined to document flow rather than a modal or overlay path', () => {
  const component = readFileSync(new URL('../apps/client/src/ResearchReport.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../apps/client/src/research-report.css', import.meta.url), 'utf8');
  assert.doesNotMatch(component, /\bDialog\b|\bcreatePortal\b|showModal\s*\(|role=["']dialog/);
  assert.doesNotMatch(css, /position\s*:\s*(fixed|absolute)|::backdrop|\.dialog\b|\binset\s*:/);
});
