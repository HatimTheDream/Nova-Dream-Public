import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../apps/service/store.js';
import type { Command, Draft, Entity } from '../packages/domain/contracts.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'e3-draft-removal-')); let store = new Store(dir);
  const owner = store.session().deviceId, viewer = store.session().deviceId, id = `draft:${owner}`;
  const command = (text = 'Unsent text to remove', revision = 0): Command => ({ requestId: randomUUID(), epoch: store.epoch, entityId: id, kind: 'draft', expectedRevision: revision, payload: { text, title: 'Disposable draft', projectId: null, attachments: [] } });
  const trash = (draftRevision: number, expectedRevision = 0) => store.organizeDraft(viewer, { requestId: randomUUID(), epoch: store.epoch, draftId: id, draftRevision, expectedRevision, action: 'delete' });
  const removal = (draftRevision = 1, expectedRevision = 1) => ({ requestId: randomUUID(), epoch: store.epoch, draftId: id, draftRevision, expectedRevision });
  return { dir, owner, viewer, id, command, trash, removal, get store() { return store; }, restart() { store.close(); store = new Store(dir); }, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('permanent draft removal clears current text, history and receipts while preserving shared files and other saved work', () => {
  const f = fixture(); try {
    const file = f.store.upload(f.owner, randomUUID(), f.store.epoch, 'shared.txt', Buffer.from('A separately saved file').toString('base64'));
    const command = f.command(); (command.payload as Draft).attachments = [file];
    const saved = f.store.mutate(f.owner, command); f.trash(saved.revision);
    const other = f.store.mutate(f.viewer, { ...f.command('Another device keeps its words'), entityId: `draft:${f.viewer}` });
    f.store.internalWrite('assistant:output:keep', { text: 'Saved output' });
    f.store.internalWrite('assistant:memory', { text: 'Saved memory' });
    f.store.internalWrite('dictation:ended', { id: 'ended', draftId: f.id, state: 'ended', text: 'Unsent dictation to remove' });
    const cursor = f.store.snapshot(f.viewer).cursor, intent = f.removal();
    const result = f.store.removeDraft(f.viewer, intent);
    assert.deepEqual(result, { draftId: f.id, revision: 2 });
    assert.equal(f.store.readEntity('draft', f.id), undefined); assert.equal(f.store.readEntityVersion('draft', f.id, 1), undefined);
    assert.equal(f.store.internalRead(`assistant:draft-organization:${f.id}`), undefined); assert.equal(f.store.internalRead('dictation:ended'), undefined);
    assert.deepEqual(f.store.readEntity('draft', other.id), other); assert.ok(f.store.internalRead('assistant:output:keep')); assert.ok(f.store.internalRead('assistant:memory'));
    assert.equal(f.store.blobMetadata(file.id).sha256, file.sha256); assert.ok(f.store.snapshot(f.viewer).cursor > cursor);
    // Verify plaintext has gone from current encrypted payloads, without claiming physical secure erasure.
    const key = readFileSync(join(f.dir, 'preview.key')), db = new DatabaseSync(join(f.dir, 'workspace.sqlite'), { readOnly: true });
    try { for (const row of db.prepare('SELECT request_id,payload FROM receipts').all()) {
      const bytes = Buffer.from(row.payload as Uint8Array), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`receipt:${row.request_id}`)); decipher.setAuthTag(bytes.subarray(12, 28));
      const text = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
      assert.ok(!text.includes('Unsent text to remove')); assert.ok(!text.includes('Unsent dictation to remove'));
    } } finally { db.close(); }
    f.restart(); assert.deepEqual(f.store.removeDraft(f.viewer, intent), result);
    assert.throws(() => f.store.mutate(f.owner, command), { code: 'draft_removed' });
    assert.throws(() => f.store.mutate(f.owner, f.command('An offline window tries to restore old writing', 1)), { code: 'draft_removed' });
    const next = f.store.mutate(f.owner, f.command('Reviewed new writing', result.revision)) as Entity<Draft>;
    assert.equal(next.revision, 3); assert.equal(next.value.text, 'Reviewed new writing');
    assert.deepEqual(f.store.removeDraft(f.viewer, intent), result); assert.deepEqual(f.store.readEntity('draft', f.id), next);
    assert.ok(f.store.snapshot(f.owner).cursor > cursor + 1);
    assert.throws(() => f.store.removeDraft(f.owner, intent), { code: 'request_reused' });
  } finally { f.close(); }
});

test('draft removal requires the exact deleted version and settled dictation, and cannot remove newer writing after a stale review', () => {
  const f = fixture(); try {
    f.store.mutate(f.owner, f.command());
    assert.throws(() => f.store.removeDraft(f.viewer, f.removal()), { code: 'draft_changed' }); f.trash(1);
    const restore = f.store.organizeDraft(f.viewer, { ...f.removal(), action: 'restore' });
    assert.throws(() => f.store.removeDraft(f.viewer, f.removal()), { code: 'draft_changed' }); f.trash(1, restore.revision);
    f.store.mutate(f.owner, f.command('New writing after review', 1));
    assert.throws(() => f.store.removeDraft(f.viewer, f.removal(1, 3)), { code: 'draft_changed' }); f.trash(2, 3);
    const intent = f.removal(2, 4);
    f.store.internalWrite('dictation:busy', { id: 'busy', draftId: f.id, state: 'listening' });
    assert.throws(() => f.store.removeDraft(f.viewer, intent), { code: 'draft_busy' });
    f.store.internalWrite('dictation:busy', { id: 'busy', draftId: f.id, state: 'ended', cleanupPending: true });
    assert.throws(() => f.store.removeDraft(f.viewer, intent), { code: 'draft_busy' });
    f.store.internalWrite('dictation:busy', { id: 'busy', draftId: f.id, state: 'ended' });
    assert.throws(() => f.store.removeDraft(f.viewer, { ...intent, epoch: randomUUID() }), { code: 'epoch_changed' });
    assert.throws(() => f.store.removeDraft(f.viewer, { ...intent, unexpected: true }));
    assert.deepEqual(f.store.removeDraft(f.viewer, intent), { draftId: f.id, revision: 3 });
  } finally { f.close(); }
});

test('removing the newest history after migration advances the snapshot cursor, including when no cursor metadata existed', () => {
  const f = fixture(); try {
    f.store.mutate(f.owner, f.command()); f.trash(1);
    const before = f.store.snapshot(f.owner).cursor;
    const db = new DatabaseSync(join(f.dir, 'workspace.sqlite'));
    db.prepare("DELETE FROM meta WHERE key='workspace-cursor'").run(); db.exec('PRAGMA user_version=31'); db.close();
    f.restart(); assert.equal(f.store.entityCursor, before);
    f.store.removeDraft(f.viewer, f.removal()); assert.ok(f.store.entityCursor > before);
    f.restart(); const after = f.store.entityCursor; assert.ok(after > before);
    f.store.mutate(f.owner, f.command('New draft after reload', 2)); assert.ok(f.store.entityCursor > after);
  } finally { f.close(); }
});
