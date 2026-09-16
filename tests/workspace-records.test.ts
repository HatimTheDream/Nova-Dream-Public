import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../apps/service/store.js';
import type { Command, Entity, Task } from '../packages/domain/contracts.js';
import { blankRecord, contentSchema, type RecordKind, type RecordValue, type Contact, type Content, type Assignment } from '../packages/domain/workspace-records.js';
import { createPortraitRecipe, resolvePortraitRecipe } from '../apps/client/src/nova/lynx-portrait/recipe.js';
import { contentFile } from '../apps/client/src/record-files.js';
import { startServer } from '../apps/service/http.js';

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'edition3-records-')); let store = new Store(path);
  const command = (kind: Command['kind'], id: string, payload: unknown, expectedRevision = 0): Command => ({ kind, entityId: id, payload, expectedRevision, requestId: randomUUID(), epoch: store.epoch });
  return { path, get store() { return store; }, command, save(kind: RecordKind, id: string, value: RecordValue, revision = 0) { return store.mutate('owner', command(kind, id, value, revision)); }, restart() { store.close(); store = new Store(path); }, close() { store.close(); rmSync(path, { recursive: true, force: true }); } };
}
const contact = (): Contact => ({ ...blankRecord('contact', 'America/Los_Angeles') as Contact, name: 'Mina', email: 'mina@example.test', notes: 'Private fixture context — cafés ☕', tags: ['Design'] });
const content = (): Content => ({ ...blankRecord('content', 'UTC') as Content, title: 'Café notes', brief: 'A private fixture brief', body: '# Café\n\nExact bytes: 猫 🐾\n<script>literal, never executed</script>\n' });

test('saved record HTTP routes retain origin/client/session guards and strict request contracts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-records-http-')); const server = await startServer({ directory, port: 0 });
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Edition3-Client': '1' };
    for (const route of ['records/history', 'records/follow-up', 'assistant/draft/organize', 'assistant/draft/remove']) {
      assert.equal((await fetch(`${server.origin}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
      assert.equal((await fetch(`${server.origin}/api/${route}`, { method: 'POST', headers, body: '{}' })).status, 401);
    }
    const session = await fetch(server.origin + '/api/session', { method: 'POST', headers, body: '{}' }); const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const post = (route: string, data: unknown, extra = {}) => fetch(`${server.origin}/api/${route}`, { method: 'POST', headers: { ...headers, cookie, ...extra }, body: JSON.stringify(data) });
    const command = { kind: 'contact', entityId: 'contact:http', payload: contact(), requestId: randomUUID(), epoch: server.store.epoch, expectedRevision: 0 };
    assert.equal((await post('commands', command)).status, 200);
    assert.equal((await post('records/history', { kind: 'contact', id: 'contact:http' }, { Origin: 'https://foreign.test' })).status, 403);
    assert.equal((await post('records/history', { kind: 'contact', id: 'contact:http', extra: 'not allowed' })).status, 400);
    const history = await post('records/history', { kind: 'contact', id: 'contact:http' }); assert.equal(history.status, 200); assert.equal((await history.json()).versions.length, 1);
    const follow = { requestId: randomUUID(), epoch: server.store.epoch, title: 'HTTP follow-up', origin: { kind: 'contact', id: 'contact:http', revision: 1 } };
    const saved = await post('records/follow-up', follow); assert.equal(saved.status, 200); assert.equal((await saved.json()).value.origin.id, 'contact:http');
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('all missing module records share encrypted revisions, snapshots and retained history after restart', () => {
  const f = fixture(); try {
    const agent = { ...blankRecord('agent', 'UTC'), name: 'Nova', position: 'Research lead', appearance: { ...createPortraitRecipe('nova-original') } } as RecordValue;
    const values: [RecordKind, string, RecordValue][] = [
      ['contact', 'contact:mina', contact()], ['content', 'content:brief', content()], ['agent', 'agent:nova', agent],
      ['assignment', 'assignment:review', { ...blankRecord('assignment', 'UTC'), title: 'Review brief', agentId: 'agent:nova', agentRevision: 1 } as Assignment],
      ['profile', 'profile:owner', { name: 'Owner', position: 'Maker', about: 'Private profile', appearance: { ...createPortraitRecipe('james-original') } }],
    ];
    for (const [kind, id, value] of values) { const command = f.command(kind, id, value); const saved = f.store.mutate('owner', command); assert.deepEqual(f.store.mutate('owner', command), saved); }
    f.restart();
    for (const [kind, id, value] of values) { assert.deepEqual(f.store.readEntity(kind, id)?.value, value); assert.equal(f.store.snapshot('owner').records?.[kind].length, 1); assert.deepEqual(f.store.recordHistory({ kind, id }).versions[0].value, value); }
    const db = new DatabaseSync(join(f.path, 'workspace.sqlite'), { readOnly: true });
    for (const table of ['entities', 'history', 'receipts']) for (const row of db.prepare(`SELECT payload FROM ${table}`).all()) { const bytes = Buffer.from(row.payload as Uint8Array).toString('utf8'); assert.ok(!bytes.includes('Private fixture')); assert.ok(!bytes.includes('Exact bytes')); }
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 54); db.close();
  } finally { f.close(); }
});
test('revisions and request receipts reject competing, cross-device and changed-payload writes', () => {
  const f = fixture(); try {
    const command = f.command('contact', 'contact:mina', contact()); f.store.mutate('owner', command);
    assert.throws(() => f.store.mutate('other', command), /different work/);
    assert.throws(() => f.store.mutate('owner', { ...command, payload: { ...contact(), name: 'Changed' } }), /different work/);
    const next = f.command('contact', 'contact:mina', { ...contact(), notes: 'Host revision two' }, 1); f.store.mutate('owner', next);
    assert.throws(() => f.store.mutate('other', f.command('contact', 'contact:mina', { ...contact(), notes: 'Competing proposal' }, 1)), /newer version/);
    assert.equal(f.store.recordHistory({ kind: 'contact', id: 'contact:mina' }).versions.length, 2);
    assert.throws(() => f.store.mutate('owner', { ...next, requestId: randomUUID(), epoch: randomUUID() }), /recovered or replaced/);
  } finally { f.close(); }
});
test('follow-up creates one canonical Task with Project and source version; lost-result replay survives source change and restart', () => {
  const f = fixture(); try {
    f.store.mutate('owner', f.command('project', 'project:launch', { name: 'Launch', purpose: 'Shared project' }));
    const source = { ...contact(), projectId: 'project:launch' }; f.save('contact', 'contact:mina', source);
    const command = { requestId: randomUUID(), epoch: f.store.epoch, title: 'Send the reviewed brief', origin: { kind: 'contact', id: 'contact:mina', revision: 1 } };
    const task = f.store.createRecordTask('owner', command); assert.deepEqual(task.value.origin, command.origin); assert.equal(task.value.projectId, 'project:launch');
    f.save('contact', 'contact:mina', { ...source, archived: true }, 1); f.restart();
    assert.deepEqual(f.store.createRecordTask('owner', command), task); assert.equal(f.store.snapshot('owner').tasks.length, 1);
    assert.throws(() => f.store.createRecordTask('other', command), /different work/);
    assert.throws(() => f.store.createRecordTask('owner', { ...command, title: 'Different effect' }), /different work/);
    assert.throws(() => f.store.createRecordTask('owner', { ...command, requestId: randomUUID() }), /active saved record/);
    const completed = f.store.mutate('owner', f.command('task', task.id, { ...task.value, status: 'done' }, 1)) as Entity<Task>;
    assert.equal(f.store.snapshot('owner').taskState?.earnedXp, 10);
    assert.throws(() => f.store.mutate('owner', f.command('task', task.id, { ...completed.value, origin: undefined }, 2)), /original source/);
    f.store.mutate('owner', f.command('task', task.id, { ...completed.value, status: 'open' }, 2)); assert.equal(f.store.snapshot('owner').taskState?.earnedXp, 0);
    assert.equal(f.store.recordHistory({ kind: 'contact', id: 'contact:mina' }).versions[1].revision, task.value.origin?.revision);
  } finally { f.close(); }
});
test('follow-up rejects stale/missing source without creating an orphan, including after an atomic failure', () => {
  const f = fixture(); try {
    f.save('content', 'content:brief', content()); f.save('content', 'content:brief', { ...content(), title: 'Second title' }, 1);
    const command = { requestId: randomUUID(), epoch: f.store.epoch, title: 'Review', origin: { kind: 'content', id: 'content:brief', revision: 1 } };
    assert.throws(() => f.store.createRecordTask('owner', command), /source changed/);
    assert.throws(() => f.store.createRecordTask('owner', { ...command, origin: { ...command.origin, id: 'content:missing' } }), /active saved record/);
    assert.equal(f.store.snapshot('owner').tasks.length, 0);
    const valid = { ...command, origin: { ...command.origin, revision: 2 } };
    const originalWrite = f.store.internalWrite.bind(f.store); f.store.internalWrite = () => { throw new Error('Fixture disk failure'); };
    assert.throws(() => f.store.createRecordTask('owner', valid), /disk failure/); f.store.internalWrite = originalWrite;
    assert.equal(f.store.snapshot('owner').tasks.length, 0); f.store.createRecordTask('owner', valid); assert.equal(f.store.snapshot('owner').tasks.length, 1);
  } finally { f.close(); }
});
test('Content history is paged, kind-fenced and exact; export never includes an unsaved proposal', () => {
  const f = fixture(); try {
    for (let i = 0; i < 53; i++) f.save('content', 'content:brief', { ...content(), title: `Draft ${i + 1}` }, i);
    const first = f.store.recordHistory({ kind: 'content', id: 'content:brief' }); const second = f.store.recordHistory({ kind: 'content', id: 'content:brief', beforeRevision: first.beforeRevision });
    assert.deepEqual([...first.versions, ...second.versions].map(v => v.revision), Array.from({ length: 53 }, (_, i) => 53 - i)); assert.equal(second.beforeRevision, null);
    assert.throws(() => f.store.recordHistory({ kind: 'contact', id: 'content:brief' }), /unavailable/);
    const file = contentFile(first.versions[0].value as Content, 53); assert.equal(file.body, content().body); assert.equal(file.name, 'Draft-53-v53.md'); assert.ok(!file.name.includes('/'));
    assert.equal(contentFile({ ...content(), title: '../../Café 🐾' }, 1).name, 'Café-v1.md');
  } finally { f.close(); }
});
test('manual publication, target identities, Project references and agent design versions are validated', () => {
  const f = fixture(); try {
    assert.equal(contentSchema.safeParse({ ...content(), stage: 'published' }).success, false);
    assert.equal(contentSchema.safeParse({ ...content(), stage: 'published', publication: { kind: 'manual', date: '2026-09-08', note: 'Published by owner on personal site' } }).success, true);
    assert.throws(() => f.save('contact', 'contact:mina', { ...contact(), projectId: 'project:missing' }), /available Project/);
    assert.throws(() => f.save('profile', 'profile:other', { name: 'Owner', position: '', about: '', appearance: null }), /one workspace identity/);
    const agent = { ...blankRecord('agent', 'UTC'), name: 'Nova', position: 'Editor' } as RecordValue;
    const plan = { ...blankRecord('assignment', 'UTC'), title: 'Review draft', agentId: 'agent:nova', agentRevision: 1 } as Assignment;
    assert.throws(() => f.save('assignment', 'assignment:plan', plan), /saved agent design/);
    f.save('agent', 'agent:nova', agent); f.save('assignment', 'assignment:plan', plan); f.save('agent', 'agent:nova', { ...agent, name: 'Updated Nova' } as RecordValue, 1);
    assert.throws(() => f.save('assignment', 'assignment:another', plan), /agent design changed/);
    f.save('assignment', 'assignment:plan', { ...plan, brief: 'Keep the original version while refining the brief.' }, 1);
    f.save('assignment', 'assignment:plan', { ...plan, agentRevision: 2 }, 2);
    assert.equal(f.store.readEntity('assignment', 'assignment:plan')?.value.agentRevision, 2);
  } finally { f.close(); }
});
test('future portrait data survives unrelated edits without replacement, and future databases fail closed', () => {
  const f = fixture(); try {
    const appearance = { schemaVersion: 99, catalogRevision: 'future', customLayers: { fur: 'one' }, unrecognized: ['keep', 'all'] };
    const profile = { name: 'Owner', position: 'Maker', about: '', appearance };
    f.save('profile', 'profile:owner', profile); f.save('profile', 'profile:owner', { ...profile, name: 'New name' }, 1); f.restart();
    assert.deepEqual(f.store.readEntity('profile', 'profile:owner')?.value.appearance, appearance);
    const resolved = resolvePortraitRecipe(appearance); assert.notEqual(resolved.status, 'ready'); assert.deepEqual(resolved.source, appearance);
    const db = new DatabaseSync(join(f.path, 'workspace.sqlite')); db.exec('PRAGMA user_version=999'); db.close();
    const before = readFileSync(join(f.path, 'workspace.sqlite')); assert.throws(() => new Store(f.path), /newer Nova Dream/); assert.deepEqual(readFileSync(join(f.path, 'workspace.sqlite')), before);
  } finally { f.close(); }
});

test('draft organization keeps original writing and files, fences stale edits, and survives restart', () => {
  const f = fixture(); try {
    const sourceDevice = f.store.session().deviceId, viewer = f.store.session().deviceId;
    const file = f.store.upload(sourceDevice, randomUUID(), f.store.epoch, 'retained.txt', Buffer.from('Keep these bytes.').toString('base64'));
    const draftId = `draft:${sourceDevice}`;
    const draft = f.store.mutate(sourceDevice, f.command('draft', draftId, { title: 'Retained writing', text: 'Original unsent text.', projectId: null, attachments: [file] }));
    const command = { requestId: randomUUID(), epoch: f.store.epoch, draftId, draftRevision: draft.revision, expectedRevision: 0, action: 'delete' };
    const deleted = f.store.organizeDraft(viewer, command);
    assert.equal(deleted.folder, 'deleted'); assert.equal(f.store.organizeDraft(viewer, command).revision, 1);
    assert.deepEqual(f.store.readEntity('draft', draftId), draft);
    f.restart(); assert.deepEqual(f.store.snapshot(viewer).draftOrganization, [deleted]);
    const restored = f.store.organizeDraft(viewer, { ...command, requestId: randomUUID(), expectedRevision: 1, action: 'restore' });
    assert.equal(restored.folder, 'active');
    assert.throws(() => f.store.organizeDraft(viewer, { ...command, requestId: randomUUID() }), /changed/);
    f.store.mutate(sourceDevice, f.command('draft', draftId, { ...draft.value as object, text: 'New writing in the original editor.' }, draft.revision));
    assert.throws(() => f.store.organizeDraft(viewer, { ...command, requestId: randomUUID(), expectedRevision: restored.revision }), /changed/);
    assert.equal(f.store.blobMetadata(file.id).sha256, file.sha256);
    assert.throws(() => f.store.organizeDraft(viewer, { ...command, epoch: randomUUID() }), /workspace changed/);
  } finally { f.close(); }
});
