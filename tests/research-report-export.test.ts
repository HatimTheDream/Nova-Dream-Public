import test from 'node:test';
import assert from 'node:assert/strict';
import { researchReportElapsed, researchReportExport, researchReportTitle } from '../apps/client/src/research-report-export';

test('report title is derived from authored headings outside code, with a bounded fallback', () => {
  assert.equal(researchReportTitle('```md\n# Example only\n```\n# Why **Earth** has seasons\n\nText', 'Draft plan'), 'Why Earth has seasons');
  assert.equal(researchReportTitle('~~~markdown\n# Example only\n~~~\n## [NASA research](https://nasa.gov) ##'), 'NASA research');
  assert.equal(researchReportTitle('A short answer.', 'Saved research title'), 'Saved research title');
  assert.equal(researchReportTitle('    # An indented example'), 'Research report');
  assert.equal(researchReportTitle('', 'x'.repeat(1000)).length, 180);
});
test('Markdown export preserves the exact saved report and creates a safe single filename', () => {
  const report = '# Seasons: evidence/limits?\r\n\r\nA [source](https://nasa.gov).\n```html\n<script>alert(1)</script>\n```\n';
  const file = researchReportExport(report);
  assert.equal(file.text, report);
  assert.equal(file.mimeType, 'text/markdown;charset=utf-8');
  assert.equal(file.name, 'Seasons- evidence-limits-.md');
  for (const name of ['CON', 'nul', 'COM1.txt', '..', '  ']) assert.equal(researchReportExport('No heading', name).name, 'Research report.md');
  assert.doesNotMatch(researchReportExport('No heading', '../private\\file\u0000').name, /[\\/\u0000]/);
});
test('completed Research elapsed time uses the saved end and does not invent progress', () => {
  const operation = { state: 'completed' as const, createdAt: '2026-09-24T01:00:00Z', settledAt: '2026-09-24T01:01:32Z', updatedAt: '2026-10-10T01:00:00Z' };
  assert.equal(researchReportElapsed(operation), '1m 32s');
  assert.equal(researchReportElapsed({ ...operation, settledAt: undefined, updatedAt: '2026-09-24T01:00:12Z' }), '12s');
  assert.equal(researchReportElapsed({ ...operation, state: 'unknown' }), undefined);
  assert.equal(researchReportElapsed({ ...operation, state: 'running' }), undefined);
  assert.equal(researchReportElapsed({ ...operation, settledAt: '2026-09-24T00:59:00Z' }), undefined);
  assert.equal(researchReportElapsed({ ...operation, createdAt: 'invalid' }), undefined);
});
