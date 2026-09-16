import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import type { AssistantOutput } from '../packages/domain/assistant.js';
import type { Content } from '../packages/domain/workspace-records.js';

function savedOutput(store: Store, bytes: Buffer, patch: Partial<AssistantOutput> = {}) {
  const name = patch.name ?? 'Café notes.md';
  const file = store.upload('owner', randomUUID(), store.epoch, name, bytes.toString('base64'));
  const output: AssistantOutput = { id: randomUUID(), version: 1, conversationId: randomUUID(), nativeId: randomUUID(), projectId: null, createdAt: new Date().toISOString(), messageId: 'exact-message', messageHash: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8'), name, uploadRequestId: randomUUID(), state: 'ready', ...patch, file };
  store.internalWrite(`assistant:output:${output.id}`, output);
  const input = { requestId: randomUUID(), epoch: store.epoch, outputId: output.id, version: output.version, sha256: file.sha256 };
  return { output, file, input };
}
function fixture(run: (f: { store: Store; directory: string }) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-content-output-')), store = new Store(directory);
  try { run({ store, directory }); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('Content imports complete UTF-8 bytes, exact source identity and Project; editing retains original and history', () => fixture(({ store, directory }) => {
  const body = '\ufeff# Café 猫 🐾\r\n\r\n<script>literal text</script>\r\n';
  store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'project', entityId: 'project:source', expectedRevision: 0, payload: { name: 'Source Project', purpose: 'Fixture purpose' } });
  const { output, file, input } = savedOutput(store, Buffer.from(body), { projectId: 'project:source', version: 4 });
  const content = store.createContentFromOutput('owner', input);
  assert.equal(content.value.body, body); assert.equal(content.value.title, 'Café notes'); assert.equal(content.value.projectId, output.projectId); assert.equal(content.value.stage, 'drafting');
  assert.deepEqual(content.value.source, { outputId: output.id, version: 4, sha256: file.sha256, conversationId: output.conversationId, nativeId: output.nativeId, messageId: output.messageId, messageHash: output.messageHash, fileId: file.id, name: output.name, importedText: true });
  assert.deepEqual(content.value.assets, [file]);
  store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'content', entityId: content.id, expectedRevision: 1, payload: { ...content.value, body: 'Edited proposal', archived: true } });
  assert.equal((store.recordHistory({ kind: 'content', id: content.id }).versions[1].value as Content).body, body);
  assert.deepEqual(store.download(file.id).bytes, Buffer.from(body));
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT blob_id FROM blob_refs WHERE entity_id=?').get(content.id)?.blob_id, file.id); db.close();
}));

test('binary, oversized and invalid UTF-8 originals stay attached without lossy text conversion', () => fixture(({ store }) => {
  for (const [bytes, patch] of [
    [Buffer.from([0, 255, 254, 0, 10]), { artifactId: 'artifact_binary', name: 'image.png', mimeType: 'image/png' }],
    [Buffer.from('a'.repeat(100001)), { artifactId: 'artifact_large', mimeType: 'text/plain', name: 'long.txt' }],
    [Buffer.from([0xc3, 0x28]), { artifactId: 'artifact_invalid', mimeType: 'text/plain', name: 'invalid.txt' }],
  ] as [Buffer, Partial<AssistantOutput>][]) {
    const { file, input } = savedOutput(store, bytes, patch); const result = store.createContentFromOutput('owner', input);
    assert.equal(result.value.body, ''); assert.equal(result.value.source?.importedText, false); assert.deepEqual(store.download(file.id).bytes, bytes); assert.deepEqual(result.value.assets, [file]);
  }
  const { input } = savedOutput(store, Buffer.from('Plain original'), { artifactId: 'artifact_text', mimeType: 'text/plain', name: '.txt' });
  const result = store.createContentFromOutput('owner', input); assert.equal(result.value.body, 'Plain original'); assert.equal(result.value.format, 'text'); assert.equal(result.value.title, '.txt');
}));

test('lost Content acknowledgment replays after source change and service restart without a duplicate', () => fixture(({ store, directory }) => {
  const { output, input } = savedOutput(store, Buffer.from('Original')); const result = store.createContentFromOutput('owner', input);
  store.internalWrite(`assistant:output:${output.id}`, { ...output, version: 99, state: 'prepared', file: undefined });
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.createContentFromOutput('owner', input), result); assert.equal(reopened.snapshot('owner').records?.content.length, 1);
    assert.throws(() => reopened.createContentFromOutput('other', input), /different work/);
    assert.throws(() => reopened.createContentFromOutput('owner', { ...input, version: 2 }), /different work/);
    assert.throws(() => reopened.createContentFromOutput('owner', { ...input, epoch: randomUUID() }), /workspace changed/);
    assert.throws(() => reopened.createContentFromOutput('owner', { ...input, requestId: randomUUID() }), /exact saved output/);
  } finally { reopened.close(); }
}));

test('Content rejects stale output and forged or removed provenance without writing records or revisions', () => fixture(({ store }) => {
  const { input } = savedOutput(store, Buffer.from('Source'));
  for (const patch of [{ version: 2 }, { sha256: 'f'.repeat(64) }, { outputId: randomUUID() }]) assert.throws(() => store.createContentFromOutput('owner', { ...input, ...patch }), /exact saved output/);
  assert.equal(store.snapshot('owner').records?.content.length, 0);
  const content = store.createContentFromOutput('owner', input);
  const edit = (payload: Content, entityId = content.id, expectedRevision = 1) => store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'content', entityId, expectedRevision, payload });
  assert.throws(() => edit({ ...content.value, source: undefined }), /original source/);
  const source = content.value.source!; assert.ok(source.kind !== 'assignment');
  assert.throws(() => edit({ ...content.value, source: { ...source, version: 5 } }), /original source/);
  assert.throws(() => edit(content.value, 'content:forged', 0), /original source/);
  assert.throws(() => edit({ ...content.value, assets: [] }), /original source file/);
  assert.throws(() => edit({ ...content.value, assets: [{ ...content.value.assets![0], name: 'wrong.txt' }] }), /file could not be verified/);
  assert.equal(store.recordHistory({ kind: 'content', id: content.id }).versions.length, 1);
  assert.equal(store.snapshot('owner').records?.content.length, 1);
}));

test('an attachment-reference failure rolls back Content, history and its receipt together', () => fixture(({ store, directory }) => {
  const { input } = savedOutput(store, Buffer.from('Source'));
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
  db.exec("CREATE TRIGGER fixture_fail_ref BEFORE INSERT ON blob_refs BEGIN SELECT RAISE(ABORT,'Fixture reference write failure'); END;");
  try {
    assert.throws(() => store.createContentFromOutput('owner', input), /Fixture reference write failure/);
    assert.equal(store.snapshot('owner').records?.content.length, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM history WHERE entity_id LIKE 'content:%'").get()?.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM receipts WHERE request_id=?').get(input.requestId)?.n, 0);
    db.exec('DROP TRIGGER fixture_fail_ref');
    assert.equal(store.createContentFromOutput('owner', input).revision, 1);
  } finally { db.close(); }
}));

test('Content output endpoint enforces browser/session/origin and exact command contracts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-content-http-')), server = await startServer({ directory, port: 0 });
  try {
    const url = server.origin + '/api/content/from-output', headers = { 'Content-Type': 'application/json', 'X-Edition3-Client': '1' };
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 401);
    const session = await fetch(server.origin + '/api/session', { method: 'POST', headers, body: '{}' }), cookie = session.headers.get('set-cookie')!.split(';')[0];
    const { input } = savedOutput(server.store, Buffer.from('HTTP source'));
    const post = (body: unknown, extra = {}) => fetch(url, { method: 'POST', headers: { ...headers, cookie, ...extra }, body: JSON.stringify(body) });
    assert.equal((await post(input, { Origin: 'https://foreign.test' })).status, 403);
    assert.equal((await post({ ...input, body: 'forged text' })).status, 400);
    const result = await post(input); assert.equal(result.status, 200); const content = await result.json(); assert.equal(content.value.body, 'HTTP source');
    assert.deepEqual(await (await post(input)).json(), content);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});
