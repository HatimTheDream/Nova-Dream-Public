import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';

test('project removal and restore persist separately from context, files, drafts and revision history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-project-organization-')); let store = new Store(directory);
  try {
    const device = store.session().deviceId;
    const file = store.upload(device, randomUUID(), store.epoch, 'source.txt', Buffer.from('Shared source').toString('base64'));
    store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'project', entityId: 'project:work', expectedRevision: 0, payload: { name: 'Saved work', purpose: 'Retain captured context', space: 'work', attachments: [file] } });
    const project = store.readEntity('project', 'project:work')!;
    const localFile = join(project.value.workspace!.folder, 'unsaved-change.txt'); writeFileSync(localFile, 'Owner file changes');
    const draft = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: `draft:${device}:work`, expectedRevision: 0, payload: { title: 'Unsent', text: 'Keep my writing', projectId: project.id, space: 'work', attachments: [file] } });
    const before = store.snapshot(device), input = { requestId: randomUUID(), epoch: store.epoch, projectId: project.id, projectRevision: project.revision, expectedRevision: 0, action: 'delete' };
    const removed = store.organizeProject(device, input);
    assert.deepEqual(removed, { projectId: project.id, revision: 1, deleted: true });
    assert.equal(store.projectIsDeleted(project.id), true);
    assert.deepEqual(store.readEntity('project', project.id), project);
    assert.deepEqual(store.readEntityVersion('project', project.id, 1), project);
    assert.deepEqual(store.readEntity('draft', draft.id), draft);
    assert.equal(readFileSync(localFile, 'utf8'), 'Owner file changes');
    assert.equal(store.download(file.id).bytes.toString(), 'Shared source');
    assert.deepEqual(store.snapshot(device).projects, before.projects);
    assert.deepEqual(store.snapshot(device).projectOrganization, [removed]);
    const deletedCursor = store.entityCursor; assert.ok(deletedCursor > before.cursor);
    store.close(); store = new Store(directory);
    assert.deepEqual(store.organizeProject(device, input), removed);
    assert.equal(store.entityCursor, deletedCursor);
    const restored = store.organizeProject(device, { ...input, requestId: randomUUID(), expectedRevision: 1, action: 'restore' });
    assert.deepEqual(restored, { projectId: project.id, revision: 2, deleted: false });
    assert.equal(store.projectIsDeleted(project.id), false);
    assert.ok(store.entityCursor > deletedCursor);
    // A lost response to the older removal resolves its receipt without undoing a later restore.
    assert.deepEqual(store.organizeProject(device, input), removed);
    assert.equal(store.projectIsDeleted(project.id), false);
    assert.deepEqual(store.readEntity('project', project.id), project);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('project organization rejects stale context, organization, epoch and reused requests atomically', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-project-cas-')), store = new Store(directory);
  try {
    const device = store.session().deviceId;
    const create = { requestId: randomUUID(), epoch: store.epoch, kind: 'project' as const, entityId: 'project:chat', expectedRevision: 0, payload: { name: 'Chat context', purpose: '' } };
    const project = store.mutate(device, create);
    const input = { requestId: randomUUID(), epoch: store.epoch, projectId: project.id, projectRevision: project.revision, expectedRevision: 0, action: 'delete' };
    assert.throws(() => store.organizeProject(device, { ...input, epoch: randomUUID() }), { code: 'epoch_changed' });
    assert.throws(() => store.organizeProject(device, { ...input, projectId: 'project:missing' }), { code: 'project_changed' });
    assert.throws(() => store.organizeProject(device, { ...input, projectRevision: 2 }), { code: 'project_changed' });
    assert.throws(() => store.organizeProject(device, { ...input, unexpected: true }));
    assert.equal(store.projectIsDeleted(project.id), false);
    store.organizeProject(device, input);
    assert.throws(() => store.organizeProject(device, { ...input, requestId: randomUUID(), action: 'restore' }), { code: 'project_changed' });
    assert.throws(() => store.organizeProject(device, { ...input, action: 'restore' }), { code: 'request_reused' });
    assert.throws(() => store.organizeProject(store.session().deviceId, input), { code: 'request_reused' });
    store.mutate(device, { ...create, requestId: randomUUID(), expectedRevision: 1, payload: { name: 'New name', purpose: '' } });
    assert.throws(() => store.organizeProject(device, { ...input, requestId: randomUUID(), expectedRevision: 1, action: 'restore' }), { code: 'project_changed' });
    assert.equal(store.projectIsDeleted(project.id), true);
    assert.equal(store.readEntity('project', project.id)!.value.name, 'New name');
    assert.deepEqual(store.organizeProject(device, input), { projectId: project.id, revision: 1, deleted: true });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('project organization HTTP route requires workspace authority and supports paired phone access', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-project-http-')), server = await startServer({ directory, port: 0 });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await fetch(server.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1', 'Content-Type': 'application/json' }, body: '{}' });
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const device = server.store.session().deviceId;
  server.store.mutate(device, { requestId: randomUUID(), epoch: server.store.epoch, kind: 'project', entityId: 'project:fixture', expectedRevision: 0, payload: { name: 'Fixture', purpose: '' } });
  const input = { requestId: randomUUID(), epoch: server.store.epoch, projectId: 'project:fixture', projectRevision: 1, expectedRevision: 0, action: 'delete' };
  const post = (value: unknown, origin = server.origin, authenticated = true) => fetch(server.origin + '/api/projects/organize', { method: 'POST', headers: { ...(authenticated ? { cookie } : {}), Origin: origin, 'X-Edition3-Client': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await post(input, server.origin, false)).status, 401);
  assert.equal((await post(input, 'https://foreign.example')).status, 403);
  assert.equal((await post({ ...input, epoch: randomUUID() })).status, 409);
  assert.equal(server.store.projectIsDeleted(input.projectId), false);
  const response = await post(input); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { projectId: input.projectId, revision: 1, deleted: true });
  assert.equal((await post(input)).status, 200);
  assert.equal(phoneRouteAllowed('/api/projects/organize', 'POST'), true);
  assert.equal(phoneRouteAllowed('/api/projects/organize', 'DELETE'), false);
});
