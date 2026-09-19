import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store';
import { defaultLayout, layoutSchema, type Command, type Layout } from '../packages/domain/contracts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'nova-icon-storage-')), directory = join(root, 'source');
  let store = new Store(directory);
  const device = store.session().deviceId;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const command = (payload: unknown, revision = store.readEntity('layout', 'layout')!.revision): Command => ({ kind: 'layout', entityId: 'layout', payload, expectedRevision: revision, epoch: store.epoch, requestId: randomUUID() });
  const save = (payload: unknown) => store.mutate(device, command(payload));
  return { root, directory, device, command, save, get store() { return store; }, reopen() { store.close(); store = new Store(directory); } };
}

test('The chosen icon persists across restart and backup restore independently of theme and widget content', t => {
  const f = fixture(t), value = { ...structuredClone(defaultLayout), appIcon: 'cream' as const, theme: 'dark' as const, timezone: 'UTC' };
  const saved = f.save(value);
  f.reopen();
  assert.deepEqual(f.store.readEntity('layout', 'layout'), saved);
  const backup = f.store.captureBackup('fixture', { status: 'not-configured', notes: [] });
  const restored = Store.restoreBackup(join(f.root, 'restored'), backup);
  try { assert.deepEqual(restored.readEntity('layout', 'layout'), saved); }
  finally { restored.close(); }
  const changed = f.save({ ...value, appIcon: 'red' });
  assert.deepEqual(changed.value, { ...value, appIcon: 'red' });
});

test('Older layout writes preserve an existing icon, and stale edits still conflict without resetting it', t => {
  const f = fixture(t), original = f.store.readEntity('layout', 'layout')!;
  const selected = f.save({ ...original.value, appIcon: 'cream' });
  const { appIcon: _, ...legacy } = original.value;
  const stale = f.command({ ...legacy, theme: 'dark' }, original.revision);
  assert.throws(() => f.store.mutate(f.device, stale), /newer version/);
  assert.deepEqual(f.store.readEntity('layout', 'layout'), selected);
  const command = f.command({ ...legacy, theme: 'dark' });
  const saved = f.store.mutate(f.device, command);
  assert.equal((saved.value as Layout).appIcon, 'cream');
  assert.equal((saved.value as Layout).theme, 'dark');
  assert.deepEqual(f.store.mutate(f.device, command), saved, 'Retry replays the exact receipt');
  assert.equal(f.store.readEntity('layout', 'layout')!.revision, saved.revision);
  assert.throws(() => f.save({ ...legacy, appIcon: 'invalid' }));
  assert.deepEqual(f.store.readEntity('layout', 'layout'), saved);
});

test('A backup without the new preference restores its exact layout and obtains the compatible Red default', t => {
  const f = fixture(t), backup = f.store.captureBackup('fixture', { status: 'not-configured', notes: [] });
  const legacy = backup.entities.find(entity => entity.kind === 'layout')!;
  delete (legacy.value as Partial<Layout>).appIcon;
  const restored = Store.restoreBackup(join(f.root, 'legacy'), backup);
  try {
    const loaded = restored.readEntity('layout', 'layout')!;
    assert.deepEqual(loaded.value, legacy.value, 'Reading does not rewrite archived layout bytes');
    assert.equal(layoutSchema.parse(loaded.value).appIcon, 'red');
    const saved = restored.mutate(f.device, { kind: 'layout', entityId: 'layout', epoch: restored.epoch, expectedRevision: loaded.revision, payload: { ...loaded.value, theme: 'dark' }, requestId: randomUUID() });
    assert.equal((saved.value as Layout).appIcon, 'red');
    assert.deepEqual((saved.value as Layout).widgets, (legacy.value as Layout).widgets);
  } finally { restored.close(); }
});