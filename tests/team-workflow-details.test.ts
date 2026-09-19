import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import type { TeamHandoff, TeamHandoffPage, TeamStep, TeamWork } from '../packages/domain/team-work';
import type { TeamReviewReport } from '../packages/domain/team-review';
import { TeamWorkflowDetails, TeamHandoffPreview, teamActions } from '../apps/client/src/TeamWorkflowDetails';
import { emptyHandoffRead, TeamHandoffReader, type HandoffReadState } from '../apps/client/src/team-handoff-reader';

function run(step: Partial<TeamStep> = {}, state: TeamWork['state'] = 'attention'): TeamWork {
  return { id: 'team', revision: 4, projectId: 'project', projectName: 'Fixture project', title: 'Fixture team', brief: 'Keep the existing changes.', folder: '/checkout/current', maxMinutes: 10, state, message: 'Review the original attempt.', next: 1, createdAt: 1, updatedAt: 999,
    steps: [
      { agentId: 'researcher', agentName: 'Researcher', agentRevision: 1, role: 'research', state: 'complete', result: 'Plan' },
      { agentId: 'maker', agentName: 'Maker', agentRevision: 2, role: 'build', state: 'failed', operationId: 'operation', conversationId: 'conversation', ...step },
      { agentId: 'reviewer', agentName: 'Reviewer', agentRevision: 1, role: 'review', state: 'waiting' },
    ] };
}
function render(run: TeamWork, blocked = false) {
  const markup = renderToStaticMarkup(createElement(TeamWorkflowDetails, { run, blocked, control: () => {}, openConversation: () => {}, refresh: () => {} }));
  const buttons: { text: string; disabled: boolean }[] = [];
  let current: typeof buttons[number] | undefined;
  new Parser({ onopentag(name, attrs) { if (name === 'button') { current = { text: '', disabled: 'disabled' in attrs }; buttons.push(current); } }, ontext(text) { if (current) current.text += text; }, onclosetag(name) { if (name === 'button') current = undefined; } }).end(markup);
  return { markup, buttons, labels: buttons.map(button => button.text) };
}

test('only a failed current execution offers a retry; unknown and stopped executions cannot create a new attempt', () => {
  assert.deepEqual(teamActions(run()), ['retry', 'skip', 'stop']);
  const failed = render(run());
  assert.ok(failed.labels.includes('Retry failed stage'));
  assert.ok(!failed.labels.includes('Resume'));
  assert.match(failed.markup, /captured instructions and access/);
  assert.match(failed.markup, /Existing file changes remain/);
  assert.match(failed.markup, /\/checkout\/current/);
  for (const state of ['unknown', 'running', 'waiting', 'cancelled'] as const) {
    const detail = render(run({ state }));
    assert.ok(!detail.labels.includes('Retry failed stage'), state);
    if (state === 'unknown') {
      assert.ok(!detail.labels.includes('Skip this stage')); assert.ok(!detail.labels.includes('Resume'));
      assert.ok(detail.labels.includes('Open conversation')); assert.ok(detail.labels.includes('Check status'));
      assert.match(detail.markup, /reconcile its outcome/);
    }
  }
  assert.ok(!render(run({ operationId: undefined })).labels.includes('Retry failed stage'));
  assert.ok(!render(run({}, 'stopping')).labels.includes('Retry failed stage'));
});

test('pending requests disable mutations while reads remain available, and progress counts only finished stages', () => {
  const detail = render(run(), true);
  assert.ok(detail.buttons.filter(button => ['Retry failed stage', 'Skip this stage', 'Stop team'].includes(button.text)).every(button => button.disabled));
  assert.equal(detail.buttons.find(button => button.text === 'Check status')?.disabled, false);
  assert.match(detail.markup, /1 of 3 stages finished/);
  assert.match(render(run({ state: 'unknown' }, 'stopping')).markup, /stop is not confirmed yet/);
  assert.match(render(run({ state: 'running' }, 'paused')).markup, /current stage may still be working/);
  const complete = run({}, 'complete'); complete.next = 3; complete.steps = complete.steps.map(step => ({ ...step, state: 'complete' }));
  assert.match(render(complete).markup, /3 of 3 stages finished/);
  assert.match(render(complete).markup, /do not mean the changes have been accepted or published/);
  assert.deepEqual(teamActions(complete), []);
});

test('a failed or cancelled stage without its execution identity cannot offer a skip the host will reject', () => {
  for (const state of ['failed', 'cancelled'] as const) {
    const detail = render(run({ state, operationId: undefined }));
    assert.ok(!detail.labels.includes('Skip this stage'));
    assert.ok(!detail.labels.includes('Retry failed stage'));
    assert.ok(detail.labels.includes('Open conversation'));
    assert.ok(detail.labels.includes('Check status'));
    assert.ok(render(run({ state })).labels.includes('Skip this stage'));
  }
});

const review: TeamReviewReport = { verdict: 'needs_changes', summary: 'The retry path loses the original request.', findings: [{ id: 'retry', priority: 'high', title: 'Keep the original request', detail: 'Reload after a lost response must reconcile the saved command.', location: 'src/panel.tsx:30' }], checks: [{ name: 'Recovery check', outcome: 'failed', detail: 'A reload currently creates another request.' }], operationId: 'review-operation', stage: 2, attempt: 1, createdAt: 8, digest: 'review-digest' };
function reviewed(report: TeamReviewReport = review): TeamWork {
  const value = run({}, 'complete'); value.next = 3; value.steps = value.steps.map(step => ({ ...step, state: 'complete' }));
  value.steps[2].review = report; value.reviewOutcome = report.verdict; value.reviewRound = 0;
  value.applyFindings = { available: report.verdict === 'needs_changes', round: 0, limit: 3 };
  return value;
}
test('structured findings offer an explicit bounded fix round while an unreported or ready review cannot start fixes', () => {
  const changes = render(reviewed());
  assert.ok(changes.labels.includes('Apply findings')); assert.match(changes.markup, /Needs changes/);
  assert.match(changes.markup, /src\/panel.tsx:30/); assert.match(changes.markup, /Reviewer-reported checks/);
  assert.match(changes.markup, /Starts fix round 1 of 3/);
  assert.equal(render(reviewed(), true).buttons.find(button => button.text === 'Apply findings')?.disabled, true);
  const ready = reviewed({ ...review, verdict: 'ready_for_review', findings: [], checks: [{ name: 'Recovery check', outcome: 'passed', detail: 'The original request is retained.' }] });
  assert.match(render(ready).markup, /Ready for your review/); assert.ok(!render(ready).labels.includes('Apply findings'));
  assert.match(render(ready).markup, /before accepting or publishing/);
  const absent = reviewed(); absent.reviewOutcome = 'unreported'; absent.steps[2].review = undefined; absent.applyFindings = { available: false, round: 0, limit: 3 };
  assert.match(render(absent).markup, /Review report unavailable/); assert.ok(!render(absent).labels.includes('Apply findings'));
  assert.doesNotMatch(render(absent).markup, /Ready for your review/);
});
test('fix rounds retain earlier reports without presenting them as a new verdict or offering duplicate fixes', () => {
  const value = reviewed(); value.state = 'running'; value.reviewOutcome = undefined; value.reviewRound = 1;
  value.applyFindings = { available: false, round: 1, limit: 3 };
  value.steps.push({ ...value.steps[1], state: 'running', reviewRound: 1 }, { ...value.steps[2], state: 'waiting', review: undefined, reviewRound: 1 });
  const active = render(value);
  assert.match(active.markup, /Earlier review/); assert.match(active.markup, /Fix round 1 of 3/); assert.match(active.markup, /Re-review/);
  assert.ok(!active.labels.includes('Apply findings')); assert.match(active.markup, /Keep the original request/);
  const limited = reviewed(); limited.reviewRound = 3; limited.applyFindings = { available: false, reason: 'All three fix rounds have been used. Review the remaining findings manually.', round: 3, limit: 3 };
  assert.match(render(limited).markup, /All three fix rounds have been used/); assert.ok(!render(limited).labels.includes('Apply findings'));
  const escaped = reviewed({ ...review, summary: '<script>summary</script>', findings: [{ ...review.findings[0], detail: '<img src=x onerror=alert(1)>' }] });
  assert.match(render(escaped).markup, /&lt;script&gt;summary&lt;\/script&gt;/); assert.doesNotMatch(render(escaped).markup, /<script>|<img src=x/);
});

const handoff: TeamHandoff = { id: 'handoff', sha256: 'immutable-hash', characters: 30000, bytes: 30000, state: 'completed', createdAt: 4 };
test('history retains original conversations and outputs and labels incomplete or failed output accurately', () => {
  const prior = { attempt: 1, state: 'failed' as const, conversationId: 'original', operationId: 'original-op', result: '<script>retained failure</script>', handoff: { ...handoff, state: 'failed' as const } };
  const current = run({ state: 'running', attempt: 2, attempts: [prior] }, 'running');
  const detail = render(current);
  assert.match(detail.markup, /Attempt 2/); assert.match(detail.markup, /Previous attempts \(1\)/);
  assert.ok(detail.labels.includes('Open attempt 1 conversation'));
  assert.match(detail.markup, /&lt;script&gt;retained failure&lt;\/script&gt;/);
  assert.match(detail.markup, /Output from a failed attempt/);
  assert.match(detail.markup, /This excerpt is shortened/);
  assert.ok(detail.labels.includes('Read complete handoff'));
  const legacy = renderToStaticMarkup(createElement(TeamHandoffPreview, { teamId: 'team', attempt: { result: 'Older saved content' } }));
  assert.match(legacy, /Completeness is unavailable/); assert.doesNotMatch(legacy, /Read complete handoff/);
  const unicode = renderToStaticMarkup(createElement(TeamHandoffPreview, { teamId: 'team', attempt: { result: '😀', handoff: { ...handoff, characters: 1, bytes: 4 } } }));
  assert.doesNotMatch(unicode, /shortened|Read complete handoff/);
});

function readerFixture(text: string) {
  const points = Array.from(text), reference = { ...handoff, characters: points.length };
  let state: HandoffReadState = emptyHandoffRead();
  const reads: { offset: number; signal: AbortSignal; resolve: (page: TeamHandoffPage) => void; reject: (error: Error) => void }[] = [];
  const reader = new TeamHandoffReader(reference, (offset, signal) => new Promise((resolve, reject) => reads.push({ offset, signal, resolve, reject })), value => { state = value; });
  const page = (offset: number, end = points.length): TeamHandoffPage => ({ ...reference, text: points.slice(offset, end).join(''), offset, nextOffset: end === points.length ? null : end });
  return { reader, reads, page, state: () => state };
}
test('full handoff pages preserve Unicode, coalesce repeated clicks and retry only the failed page', async () => {
  const text = 'A😀B\n' + 'Original complete output beyond old cutoff. '.repeat(700), f = readerFixture(text);
  const first = f.reader.load(); void f.reader.load(); assert.equal(f.reads.length, 1);
  f.reads[0].resolve(f.page(0, 3)); await first;
  assert.equal(f.state().text, 'A😀B'); assert.equal(f.state().loaded, 3); assert.equal(f.state().complete, false);
  const second = f.reader.load(); f.reads[1].reject(Error('Disconnected')); await second;
  assert.equal(f.state().text, 'A😀B'); assert.equal(f.state().error, 'Disconnected');
  const retry = f.reader.load(); assert.equal(f.reads[2].offset, 3);
  f.reads[2].resolve(f.page(3)); await retry;
  assert.equal(f.state().text, text); assert.equal(f.state().complete, true); assert.equal(f.state().error, '');
  await f.reader.load(); assert.equal(f.reads.length, 3);
});
test('a late page cannot replace a closed reader or append content from a different immutable result', async () => {
  const old = readerFixture('Old'), pending = old.reader.load(), before = old.state(); old.reader.close();
  assert.equal(old.reads[0].signal.aborted, true); old.reads[0].resolve(old.page(0)); await pending;
  assert.equal(old.state(), before);
  const next = readerFixture('New'), request = next.reader.load();
  next.reads[0].resolve({ ...next.page(0), id: 'different-result' }); await request;
  assert.equal(next.state().text, ''); assert.equal(next.state().complete, false); assert.match(next.state().error, /did not match/);
  const retry = next.reader.load(); next.reads[1].resolve(next.page(0)); await retry;
  assert.equal(next.state().text, 'New');
});
