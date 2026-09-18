import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import type { Snapshot } from '../packages/domain/contracts';
import type { TeamWork } from '../packages/domain/team-work';
import { blankRecord } from '../packages/domain/workspace-records';
import { suggestedTeamMembers, teamWorkStatus, type TeamWorkStatus } from '../apps/client/src/team-work-state';
import { RefreshReader } from '../apps/client/src/refresh-reader';

// CSS has no effect on server-rendered form values; keep the actual component.
const styles = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { TeamWorkPanel } = await import('../apps/client/src/TeamWorkPanel');
styles.deregister();

const member = (position: string, id = position) => ({
  id, revision: 1, updatedAt: '2026-09-18T00:00:00Z', value: { ...blankRecord('agent', 'UTC'), name: id, position },
});
function permutations<T>(values: T[]): T[][] {
  return values.length ? values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest])) : [[]];
}
const selected = (agents: ReturnType<typeof member>[]) => suggestedTeamMembers(agents).map(step => step.agentId);

test('Maker, Reviewer and Researcher keep their intended stages in every roster order without changing access', () => {
  const roster = [member('Maker'), member('Reviewer'), member('Researcher')], saved = structuredClone(roster);
  for (const order of permutations(roster)) assert.deepEqual(selected(order), ['Researcher', 'Maker', 'Reviewer']);
  assert.deepEqual(roster, saved);
});

test('specialists are reserved before a unique generalist fallback, and missing roles remain unassigned', () => {
  for (const order of permutations([member('Reviewer'), member('Maker'), member('Coordinator')])) {
    assert.deepEqual(selected(order), ['Coordinator', 'Maker', 'Reviewer']);
  }
  assert.deepEqual(selected([member('Reviewer'), member('Maker')]), ['', 'Maker', 'Reviewer']);
  assert.deepEqual(selected([member('Researcher')]), ['Researcher', '', '']);
  assert.deepEqual(selected([]), ['', '', '']);
});

test('competing and multi-role specialists, and multiple fallback choices require an explicit choice', () => {
  for (const order of permutations([member('Reviewer'), member('Quality analyst'), member('Maker')])) {
    assert.deepEqual(selected(order), ['', 'Maker', '']);
  }
  for (const order of permutations([member('Reviewer'), member('Maker'), member('Coordinator'), member('Assistant')])) {
    assert.deepEqual(selected(order), ['', 'Maker', 'Reviewer']);
  }
  assert.deepEqual(selected([member('Researcher'), member('Developer'), member('Engineer'), member('Reviewer')]), ['Researcher', '', 'Reviewer']);
  const archived = { ...member('Maker'), value: { ...member('Maker').value, archived: true } };
  assert.deepEqual(selected([archived, member('Researcher'), member('Reviewer')]), ['Researcher', '', 'Reviewer']);
});

function renderForm(agents: ReturnType<typeof member>[], saved?: object, pending?: object, retry?: object) {
  const key = 'e3:team-work:epoch:device';
  const storage = new Map<string, string>();
  if (saved) storage.set(key, JSON.stringify(saved));
  if (pending) storage.set(key + ':pending', JSON.stringify(pending));
  if (retry) storage.set(key + ':retry', JSON.stringify(retry));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (name: string) => storage.get(name) ?? null } });
  try {
    const snapshot = { epoch: 'epoch', deviceId: 'device', projects: [{ id: 'project', value: { name: 'Fixture', space: 'work', workspace: { folder: '/fixture', environment: 'local' } } }], records: { agent: agents } } as unknown as Snapshot;
    const markup = renderToStaticMarkup(createElement(TeamWorkPanel, { snapshot, active: false, openConversation: () => {} }));
    const selects: { value: string; required: boolean }[] = [];
    let current: typeof selects[number] | undefined;
    let disabled = false, fieldsetDisabled = false;
    new Parser({ onopentag(name, attributes) {
      if (name === 'select') { current = { value: '', required: 'required' in attributes }; selects.push(current); }
      if (name === 'option' && current && 'selected' in attributes) current.value = attributes.value;
      if (name === 'button' && attributes.class === 'primary') disabled = 'disabled' in attributes;
      if (name === 'fieldset') fieldsetDisabled = 'disabled' in attributes;
    }, onclosetag(name) { if (name === 'select') current = undefined; } }).end(markup);
    return { markup, selects, disabled, fieldsetDisabled, storage };
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('the actual new-workflow form renders the same role choices for every roster order', () => {
  for (const order of permutations([member('Reviewer'), member('Researcher'), member('Maker')])) {
    const form = renderForm(order);
    assert.deepEqual(form.selects.slice(1, 4), [
      { value: 'Researcher', required: true }, { value: 'Maker', required: true }, { value: 'Reviewer', required: true },
    ]);
  }
  const missing = renderForm([member('Maker'), member('Reviewer')]);
  assert.deepEqual(missing.selects.slice(1, 4).map(select => select.value), ['', 'Maker', 'Reviewer']);
  assert.equal(missing.selects[1].required, true);
});

test('rendered saved choices, writing and pending request identity survive new suggestions', () => {
  const roster = [member('Researcher'), member('Maker'), member('Reviewer')];
  const draft = { projectId: 'project', title: 'My saved work', brief: 'Keep this exact draft.', maxMinutes: 20, steps: [
    { role: 'research', agentId: 'Reviewer' }, { role: 'build', agentId: 'Maker' }, { role: 'review', agentId: 'Researcher' },
  ] };
  const form = renderForm(roster, draft);
  assert.deepEqual(form.selects.map(select => select.value), ['project', 'Reviewer', 'Maker', 'Researcher', '20']);
  assert.match(form.markup, /My saved work/); assert.match(form.markup, /Keep this exact draft\./);
  assert.equal(form.disabled, false);
  const incomplete = renderForm(roster, { ...draft, steps: draft.steps.map((step, i) => i ? step : { ...step, agentId: '' }) });
  assert.equal(incomplete.selects[1].value, ''); assert.equal(incomplete.disabled, true);
  const pending = { ...draft, requestId: 'original-request', epoch: 'epoch' };
  const reconcile = renderForm(roster, draft, pending);
  assert.equal(reconcile.fieldsetDisabled, true); assert.equal(reconcile.disabled, false);
  assert.deepEqual(JSON.parse(reconcile.storage.get('e3:team-work:epoch:device:pending')!), pending);
});

test('a retained retry blocks a separate start on reload and keeps the exact command for reconciliation', () => {
  const retry = { requestId: 'original-retry', epoch: 'epoch', id: 'failed-team', revision: 7, action: 'retry' };
  const form = renderForm([member('Researcher'), member('Maker'), member('Reviewer')], undefined, undefined, retry);
  assert.equal(form.fieldsetDisabled, true); assert.equal(form.disabled, true);
  assert.match(form.markup, /Reconcile retry/);
  assert.deepEqual(JSON.parse(form.storage.get('e3:team-work:epoch:device:retry')!), retry);
});

test('an unconfirmed Apply findings request survives reopening and blocks new work until reconciled', () => {
  const pending = { requestId: 'original-findings', epoch: 'epoch', id: 'reviewed-team', revision: 14, action: 'apply_findings' };
  const form = renderForm([member('Researcher'), member('Maker'), member('Reviewer')], undefined, undefined, pending);
  assert.equal(form.fieldsetDisabled, true); assert.equal(form.disabled, true);
  assert.match(form.markup, /Reconcile findings request/);
  assert.deepEqual(JSON.parse(form.storage.get('e3:team-work:epoch:device:retry')!), pending);
});

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function readerFixture() {
  let state: TeamWorkStatus = { runs: [], readError: '', actionError: '' };
  const reads: { signal: AbortSignal; resolve: (runs: TeamWork[]) => void; reject: (error: Error) => void }[] = [];
  const reader = new RefreshReader({
    identity: () => 'epoch:device',
    read: signal => new Promise<TeamWork[]>((resolve, reject) => reads.push({ signal, resolve, reject })),
    accept: runs => { state = teamWorkStatus(state, { type: 'read', runs }); },
    fail: error => { state = teamWorkStatus(state, { type: 'readError', message: (error as Error).message }); },
  });
  return { reader, reads, state: () => state, actionError: (message: string) => { state = teamWorkStatus(state, { type: 'actionError', message }); } };
}

test('successful status recovery clears its read error but retains an unresolved mutation failure', async () => {
  const f = readerFixture(), first = f.reader.poll(); await flush();
  f.reads[0].reject(Error('Offline')); await first;
  assert.equal(f.state().readError, 'Offline');
  f.actionError('The start response was lost. Reconcile the original request.');
  const recovered = f.reader.poll(); await flush();
  const runs = [{ id: 'saved-run' }] as TeamWork[]; f.reads[1].resolve(runs); await recovered;
  assert.equal(f.state().readError, ''); assert.equal(f.state().runs, runs);
  assert.match(f.state().actionError, /original request/);
  const failedAgain = f.reader.poll(); await flush(); f.reads[2].reject(Error('Offline again')); await failedAgain;
  assert.equal(f.state().runs, runs); assert.equal(f.state().readError, 'Offline again');
  f.actionError(''); assert.equal(f.state().readError, 'Offline again');
});

test('late reads from a closed active lifecycle cannot restore errors or replace a reactivated view', async () => {
  for (const outcome of ['success', 'failure']) {
    const f = readerFixture(), old = f.reader.poll(); await flush();
    f.reader.cancel(); assert.equal(f.reads[0].signal.aborted, true);
    const current = f.reader.poll(); await flush();
    const runs = [{ id: 'current-run' }] as TeamWork[]; f.reads[1].resolve(runs); await current;
    if (outcome === 'success') f.reads[0].resolve([{ id: 'obsolete-run' }] as TeamWork[]);
    else f.reads[0].reject(Error('Obsolete error'));
    await old;
    assert.deepEqual(f.state(), { runs, readError: '', actionError: '' });
  }
});
