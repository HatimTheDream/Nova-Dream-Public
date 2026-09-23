import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';
import { Parser } from 'htmlparser2';
import { randomUUID } from 'node:crypto';
import type { Snapshot } from '../packages/domain/contracts';
import { activeProjects, projectIsDeleted } from '../packages/domain/project-organization';
import { ApiError } from '../apps/client/src/api';
import { runRetainedProjectOrganization, type PendingProjectOrganization } from '../apps/client/src/project-organization-action';
import { ProjectOptions } from '../apps/client/src/ProjectOptions';
import { releaseRejectedProjectRequest } from '../apps/client/src/project-admission';

const styles = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { ProjectOrganizationDialog, projectOrganizationKey } = await import('../apps/client/src/ProjectOrganizationDialog');
styles.deregister();

function snapshot(): Snapshot {
  return { epoch: randomUUID(), deviceId: randomUUID(), projects: [
    { id: 'project:legacy', revision: 1, deviceId: 'owner', updatedAt: '', value: { name: 'Legacy context', purpose: '' } },
    { id: 'project:active', revision: 2, deviceId: 'owner', updatedAt: '', value: { name: 'Active Work', purpose: '', space: 'work' } },
    { id: 'project:removed', revision: 4, deviceId: 'owner', updatedAt: '', value: { name: 'Saved Work', purpose: 'Keep these instructions', space: 'work' } },
  ], projectOrganization: [{ projectId: 'project:removed', revision: 1, deleted: true }] } as Snapshot;
}
function command(): PendingProjectOrganization { return { requestId: randomUUID(), epoch: randomUUID(), projectId: 'project:removed', projectRevision: 4, expectedRevision: 0, action: 'delete' }; }
const confirmed = { projectId: 'project:removed', revision: 1, deleted: true };

test('new destinations exclude removed projects while an existing selection keeps its original disabled label', () => {
  const saved = snapshot(), before = structuredClone(saved);
  assert.deepEqual(activeProjects(saved).map(project => project.id), ['project:legacy', 'project:active']);
  assert.equal(projectIsDeleted(saved, 'project:removed'), true);
  assert.equal(projectIsDeleted({ ...saved, projectOrganization: undefined }, 'project:removed'), false);
  const readOptions = (selected?: string, space?: 'chat' | 'work') => {
    const entries: { id: string; disabled: boolean; label: string }[] = []; let current: typeof entries[number] | undefined;
    const markup = renderToStaticMarkup(createElement(ProjectOptions, { snapshot: saved, selected, space }));
    new Parser({ onopentag(name, attributes) { if (name === 'option') { current = { id: attributes.value, disabled: 'disabled' in attributes, label: '' }; entries.push(current); } }, ontext(text) { if (current) current.label += text; }, onclosetag(name) { if (name === 'option') current = undefined; } }).end(markup);
    return entries;
  };
  assert.deepEqual(readOptions(undefined, 'work'), [{ id: 'project:active', disabled: false, label: 'Active Work' }]);
  assert.deepEqual(readOptions('project:removed', 'work'), [{ id: 'project:active', disabled: false, label: 'Active Work' }, { id: 'project:removed', disabled: true, label: 'Saved Work · Deleted' }]);
  assert.deepEqual(readOptions(undefined, 'chat'), [{ id: 'project:legacy', disabled: false, label: 'Legacy context' }]);
  assert.deepEqual(saved, before);
});

test('a remounted project dialog reconciles its saved removal even when the refreshed project is already Deleted', () => {
  const saved = snapshot(), project = saved.projects[2], original = { ...command(), epoch: saved.epoch };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => key === projectOrganizationKey(saved, project.id) ? JSON.stringify(original) : null } });
  try {
    const render = () => renderToStaticMarkup(createElement(ProjectOrganizationDialog, { snapshot: saved, project, close() { assert.fail('Rendering cannot close or dispatch'); }, async refresh() { assert.fail('Rendering cannot refresh or dispatch'); } }));
    for (let mount = 0; mount < 2; mount++) {
      const html = render(); assert.match(html, /Move project to Deleted\?/); assert.match(html, /Check change/); assert.match(html, /same request/); assert.doesNotMatch(html, /Restore project\?/);
    }
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('lost organization response and remount retain the exact request through authentication and workspace gates', async () => {
  for (const [status, code] of [[401, 'session_expired'], [403, 'phone_pair_required'], [409, 'epoch_changed'], [409, 'client_update'], [409, 'request_reused'], [400, 'validation']] as const) {
    let storage: string | undefined, effects = 0, stage: 'lost' | 'gated' | 'ready' = 'lost';
    const original = command(), sent: PendingProjectOrganization[] = [], receipts = new Map<string, typeof confirmed>();
    const mount = () => ({
      read: () => storage ? JSON.parse(storage) as PendingProjectOrganization : undefined,
      write(value: PendingProjectOrganization | null) { storage = value ? JSON.stringify(value) : undefined; return true; },
      retained() {}, async refresh() {},
      async send(value: PendingProjectOrganization) {
        sent.push(value);
        if (stage === 'gated') throw new ApiError(code, 'Reconnect first', undefined, status);
        if (!receipts.has(value.requestId)) { effects++; receipts.set(value.requestId, confirmed); }
        if (stage === 'lost') throw Error('Response lost after saving');
        return receipts.get(value.requestId)!;
      },
    });
    const first = await runRetainedProjectOrganization(mount(), original); assert.equal(first.confirmed, false); assert.deepEqual(first.pending, original);
    stage = 'gated'; const gated = await runRetainedProjectOrganization(mount()); assert.deepEqual(gated.pending, original, code);
    stage = 'ready'; const replay = await runRetainedProjectOrganization(mount(), { ...original, requestId: randomUUID(), action: 'restore' });
    assert.equal(replay.confirmed, true); assert.equal(replay.pending, undefined); assert.equal(storage, undefined); assert.equal(effects, 1);
    assert.deepEqual(sent, [original, original, original]);
  }
});

test('failed refresh or receipt cleanup keeps the saved action and cannot issue an opposite action', async () => {
  let saved: PendingProjectOrganization | undefined, refreshFails = true, clearFails = false;
  const original = command(), sent: PendingProjectOrganization[] = [];
  const options = { read: () => saved, write(value: PendingProjectOrganization | null) { if (!value && clearFails) return false; saved = value ?? undefined; return true; }, retained() {}, async send(value: PendingProjectOrganization) { sent.push(value); return confirmed; }, async refresh() { if (refreshFails) throw new ApiError('project_changed', 'Snapshot refresh failed', undefined, 409); } };
  const first = await runRetainedProjectOrganization(options, original); assert.deepEqual(first.pending, original); assert.equal(first.confirmed, false);
  refreshFails = false; clearFails = true;
  const second = await runRetainedProjectOrganization(options, { ...original, requestId: randomUUID(), action: 'restore' });
  assert.equal(second.confirmed, true); assert.deepEqual(second.pending, original);
  clearFails = false;
  const last = await runRetainedProjectOrganization(options); assert.equal(last.confirmed, true); assert.equal(last.pending, undefined);
  assert.deepEqual(sent, [original, original, original]);
});

test('storage failure prevents dispatch and a stale admission may clear only its own request', async () => {
  const original = command(); let saved: PendingProjectOrganization | undefined, sent = 0;
  const full = await runRetainedProjectOrganization({ read: () => undefined, write: () => false, retained() { assert.fail('Unsaved intent'); }, async send() { sent++; return confirmed; }, async refresh() {} }, original);
  assert.equal(sent, 0); assert.equal(full.confirmed, false); assert.equal(full.pending, undefined);
  const options = { read: () => saved, write(value: PendingProjectOrganization | null) { saved = value ?? undefined; return true; }, retained() {}, async send() { throw new ApiError('project_changed', 'Review current Project', undefined, 409); }, async refresh() {} };
  assert.equal((await runRetainedProjectOrganization(options, original)).pending, undefined);
  const newer = { ...original, requestId: randomUUID(), action: 'restore' as const };
  const delayed = await runRetainedProjectOrganization({ ...options, async send() { saved = newer; return confirmed; } }, original);
  assert.deepEqual(delayed.pending, newer); assert.deepEqual(saved, newer);
});

test('rejected project creation or move releases only its original intent while preserving writing and uncertain receipts', () => {
  const original = command(), records = new Map<string, string>(), key = 'creation-or-move', draftKey = 'kept-draft';
  records.set(key, JSON.stringify(original)); records.set(draftKey, JSON.stringify({ text: 'Unsent writing', attachments: ['kept-file'] }));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (id: string) => records.get(id) ?? null, removeItem: (id: string) => records.delete(id) } });
  try {
    for (const error of [new Error('Lost response'), new ApiError('epoch_changed', 'Workspace changed', undefined, 409), new ApiError('client_update', 'Reload', undefined, 409), new ApiError('session_expired', 'Sign in', undefined, 401), new ApiError('project_deleted', 'Upstream unavailable', undefined, 502)]) {
      assert.equal(releaseRejectedProjectRequest(key, original.requestId, error), false);
      assert.deepEqual(JSON.parse(records.get(key)!), original);
    }
    const rejection = new ApiError('project_deleted', 'Restore the Project', undefined, 409);
    assert.equal(releaseRejectedProjectRequest(key, randomUUID(), rejection), false);
    assert.equal(releaseRejectedProjectRequest(key, original.requestId, rejection), true);
    assert.equal(records.has(key), false);
    assert.deepEqual(JSON.parse(records.get(draftKey)!), { text: 'Unsent writing', attachments: ['kept-file'] });
    records.set(key, JSON.stringify({ ...original, requestId: 'new-request' }));
    assert.equal(releaseRejectedProjectRequest(key, original.requestId, rejection), false);
    assert.equal(JSON.parse(records.get(key)!).requestId, 'new-request');
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
