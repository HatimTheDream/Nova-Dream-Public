import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkEntry } from '../apps/client/src/work-transcript.js';
import { completedActionSummary, groupWorkActions, type WorkToolEntry } from '../apps/client/src/work-action-groups.js';

const tool = (id: string, name = 'read', state: WorkToolEntry['tool']['state'] = 'completed'): WorkToolEntry => ({
  kind: 'tool', tool: { id, name, state, sequence: 1, input: `${id}.txt`, output: `${id} output` },
  sources: [{ id: `source-${id}`, novaId: `nova-${id}`, aliases: [`old-${id}`], role: 'tool', text: `${id} output`, textHash: `${id}-hash`, attachments: [] }],
});
const narration: WorkEntry = { kind: 'message', message: { id: 'narration', role: 'assistant', text: 'Checking the next result.', textHash: 'narration-hash', attachments: [] } };

test('adjacent confirmed successes form a display group without changing any action identity or details', () => {
  const first = tool('first'), second = tool('second', 'exec'), entries = [first, second];
  const before = structuredClone(entries);
  const rows = groupWorkActions(entries);
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'actions');
  if (rows[0].kind === 'actions') {
    assert.equal(rows[0].entries[0], first); assert.equal(rows[0].entries[1], second);
    assert.equal(rows[0].entries[0].tool, first.tool); assert.equal(rows[0].entries[1].sources, second.sources);
  }
  assert.deepEqual(entries, before);
});

test('narration separates successful action groups and remains in its original position', () => {
  const before = [tool('first'), tool('second')], after = [tool('third'), tool('fourth')];
  const rows = groupWorkActions([...before, narration, ...after]);
  assert.equal(rows.length, 3); assert.equal(rows[1], narration);
  assert.deepEqual(rows.flatMap((row): WorkEntry[] => row.kind === 'actions' ? row.entries : [row]), [...before, narration, ...after]);
});

test('running, failed, blocked and unknown outcomes always remain separate and interrupt successful groups', () => {
  for (const state of ['running', 'failed', 'blocked', 'unknown'] as const) {
    const first = tool('first'), attention = tool('attention', 'exec', state), last = tool('last');
    const rows = groupWorkActions([first, attention, last]);
    assert.deepEqual(rows, [first, attention, last]); assert.equal(rows[1], attention);
  }
});

test('one successful action and an empty transcript do not introduce redundant group disclosures', () => {
  const single = tool('single');
  assert.deepEqual(groupWorkActions([]), []);
  assert.equal(groupWorkActions([single])[0], single);
  assert.deepEqual(groupWorkActions([narration, single]), [narration, single]);
});

test('summary families honor aliases, first appearance and the number of completed actions', () => {
  assert.equal(completedActionSummary([tool('one', 'functions.read_file'), tool('two', 'read'), tool('three', 'mcp__host__exec_command'), tool('four', 'run_command')]), 'Read files, ran commands');
  assert.equal(completedActionSummary([tool('command', 'exec'), tool('read', 'read')]), 'Ran a command, read a file');
  assert.equal(completedActionSummary([tool('read-1'), tool('exec', 'exec'), tool('read-2')]), 'Read files, ran a command');
  assert.equal(completedActionSummary([tool('github', 'github_identity_status'), tool('page', 'web_fetch')]), 'Checked GitHub identity, read a page');
});

test('summaries stay short for varied tool families and never invent success for pending or failed actions', () => {
  assert.equal(completedActionSummary([tool('one'), tool('two', 'exec'), tool('three', 'web_fetch'), tool('four', 'write'), tool('five', 'web_fetch')]), 'Read a file, ran a command, 3 other actions');
  assert.equal(completedActionSummary([tool('one', 'custom_connector_action'), tool('two', 'other_vendor_action')]), 'Completed actions');
  assert.equal(completedActionSummary([tool('one'), tool('two', 'exec', 'failed'), tool('three', 'read', 'running')]), 'Read a file');
  assert.equal(completedActionSummary([tool('one', 'exec', 'blocked'), tool('two', 'read', 'unknown')]), '');
});

test('attachments interrupt grouping and stay immediately visible at their original transcript level', () => {
  const before = [tool('one'), tool('two')], attached = tool('file'), after = [tool('three'), tool('four')];
  attached.sources[0].attachments.push({ artifactId: 'saved-report', name: 'report.pdf' });
  const rows = groupWorkActions([...before, attached, ...after]);
  assert.equal(rows.length, 3); assert.equal(rows[1], attached);
  assert.equal(rows[1].kind, 'tool');
  assert.deepEqual(rows.flatMap((row): WorkEntry[] => row.kind === 'actions' ? row.entries : [row]), [...before, attached, ...after]);
  assert.equal(attached.sources[0].attachments[0].artifactId, 'saved-report');
  assert.deepEqual(groupWorkActions([tool('single'), attached, tool('last')]).map(row => row.kind), ['tool', 'tool', 'tool']);
});

test('exact search identities remain attached to every grouped original entry', () => {
  const first = tool('first'), second = tool('second'), rows = groupWorkActions([first, second]);
  assert.equal(rows[0].kind, 'actions');
  if (rows[0].kind === 'actions') {
    assert.equal(rows[0].entries[0].sources[0], first.sources[0]); assert.equal(rows[0].entries[1].sources[0], second.sources[0]);
    assert.deepEqual(rows[0].entries.flatMap(entry => entry.sources.flatMap(source => [source.id, source.novaId, ...source.aliases ?? []])), ['source-first', 'nova-first', 'old-first', 'source-second', 'nova-second', 'old-second']);
  }
});

test('separate completed results with the same tool ID remain separate inspectable entries', () => {
  const first = tool('shared'), second = { ...tool('shared'), tool: { ...tool('shared').tool, output: 'A conflicting output' } };
  const rows = groupWorkActions([first, second]);
  assert.equal(rows[0].kind, 'actions');
  if (rows[0].kind === 'actions') {
    assert.equal(rows[0].entries.length, 2); assert.equal(rows[0].entries[0], first); assert.equal(rows[0].entries[1], second);
    assert.notEqual(rows[0].entries[0].tool.output, rows[0].entries[1].tool.output);
  }
});
