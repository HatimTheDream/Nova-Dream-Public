import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../apps/service/store';
import { defaultLayout, emptyDraft, type Command, type Layout } from '../packages/domain/contracts';
import { createHomeWidget } from '../packages/domain/home-widgets';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'nova-home-storage-')), directory = join(root, 'source');
  let store = new Store(directory);
  const device = store.session().deviceId;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const save = (kind: Command['kind'], entityId: string, payload: unknown, expectedRevision = 0) => store.mutate(device, { kind, entityId, payload, expectedRevision, epoch: store.epoch, requestId: randomUUID() });
  return { root, directory, device, save, get store() { return store; }, reopen(asSchema?: number) {
    store.close();
    if (asSchema !== undefined) { const db = new DatabaseSync(join(directory, 'workspace.sqlite')); db.exec(`PRAGMA user_version=${asSchema}`); db.close(); }
    store = new Store(directory);
  } };
}
const schemaVersion = (directory: string) => {
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'), { readOnly: true });
  try { return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; } finally { db.close(); }
};

test('Opening a schema54 workspace preserves legacy Home layout and saved writing while fencing old builds', t => {
  const f = fixture(t);
  const legacy: Layout = { ...structuredClone(defaultLayout), nav: [...defaultLayout.nav].reverse(), showCompleted: true, widgets: [...defaultLayout.widgets].reverse().map(widget => ({ ...widget, hidden: widget.id === 'draft', size: 'compact' })) };
  const savedLayout = f.save('layout', 'layout', legacy, f.store.readEntity('layout', 'layout')!.revision);
  const savedDraft = f.save('draft', `draft:${f.device}`, { ...emptyDraft, title: 'Writing before the upgrade', text: 'Keep every word\nand this second line.' });
  const epoch = f.store.epoch, before = f.store.captureBackup('fixture', { status: 'not-configured', notes: [] });
  f.reopen(54);
  assert.equal(schemaVersion(f.directory), 55);
  assert.equal(f.store.epoch, epoch);
  assert.deepEqual(f.store.readEntity('layout', 'layout'), savedLayout);
  assert.deepEqual(f.store.readEntity('draft', savedDraft.id), savedDraft);
  const after = f.store.captureBackup('fixture', before.native);
  assert.deepEqual(after.entities, before.entities);
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.receipts, before.receipts);
  const oldArchive = { ...before, schema: 54 };
  const restored = Store.restoreBackup(join(f.root, 'legacy-copy'), oldArchive);
  try {
    assert.equal(schemaVersion(restored.directory), 55);
    assert.deepEqual(restored.readEntity('layout', 'layout'), savedLayout);
    assert.deepEqual(restored.readEntity('draft', savedDraft.id), savedDraft);
  } finally { restored.close(); }
});

test('Multiple widget instances, colors, notes and quick links survive restart and schema55 backup restoration', t => {
  const f = fixture(t), first = createHomeWidget('note'), second = createHomeWidget('note'), links = createHomeWidget('links'), tasks = createHomeWidget('next');
  first.title = 'One note'; first.color = 'cream'; first.settings = { text: 'Exact first note\nA second line — 猫' };
  second.title = 'Another note'; second.color = 'slate'; second.hidden = true; second.settings = { text: 'Independent writing' };
  links.color = 'rose';
  links.settings = { links: [{ id: randomUUID(), label: 'Reference', url: 'https://example.test/reference#one' }] };
  tasks.settings = { view: 'attention', projectId: 'project:fixture', limit: 4 };
  const layout: Layout = { ...structuredClone(defaultLayout), widgets: [first, links, ...defaultLayout.widgets, second, tasks] };
  const saved = f.save('layout', 'layout', layout, f.store.readEntity('layout', 'layout')!.revision);
  f.reopen();
  assert.deepEqual(f.store.readEntity('layout', 'layout'), saved);
  const backup = f.store.captureBackup('fixture', { status: 'not-configured', notes: [] });
  assert.equal(backup.schema, 55);
  const target = join(f.root, 'restored');
  let restored = Store.restoreBackup(target, backup);
  try {
    assert.equal(schemaVersion(target), 55);
    assert.deepEqual(restored.readEntity('layout', 'layout'), saved);
    assert.deepEqual(restored.snapshot(f.device).layout.value.widgets, layout.widgets);
    const captured = restored.captureBackup('fixture', backup.native);
    assert.deepEqual(captured.entities, backup.entities);
    assert.deepEqual(captured.history, backup.history);
    restored.close(); restored = new Store(target);
    assert.deepEqual(restored.readEntity('layout', 'layout'), saved);
  } finally { restored.close(); }
});

test('Service layout writes reject invalid widget contents without changing saved notes', t => {
  const f = fixture(t), note = createHomeWidget('note'); note.settings = { text: 'Retained note' };
  const layout: Layout = { ...structuredClone(defaultLayout), widgets: [note] };
  const saved = f.save('layout', 'layout', layout, f.store.readEntity('layout', 'layout')!.revision);
  const invalid = [
    { ...note, color: '#ffffff' },
    { ...note, settings: { links: [{ id: randomUUID(), label: 'Wrong type', url: 'https://example.test' }] } },
    { ...createHomeWidget('links'), settings: { links: [{ id: randomUUID(), label: 'Unsafe', url: 'javascript:alert(1)' }] } },
  ];
  for (const widget of invalid) {
    assert.throws(() => f.save('layout', 'layout', { ...layout, widgets: [widget] }, saved.revision));
    assert.deepEqual(f.store.readEntity('layout', 'layout'), saved);
  }
});
