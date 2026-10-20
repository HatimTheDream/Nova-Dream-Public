import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defaultLayout } from '../packages/domain/contracts.js';
import { discoverHomeWriting, keepHomeWriting, keepSavedHomeWriting, homeWriterKey, readKeptHomeWriting, type HomeWritingScope, type HomeWritingStorage } from '../apps/client/src/home-writing-recovery.js';
import type { HomePreservationState } from '../packages/domain/home-library.js';
class Storage implements HomeWritingStorage {
 rows = new Map<string, string>(); reads: string[] = []; writes: string[] = []; fail = false;
 get length() { return this.rows.size; }
 key(index: number) { return [...this.rows.keys()][index] ?? null; }
 getItem(key: string) { this.reads.push(key);return this.rows.get(key) ?? null; }
 setItem(key: string, value: string) { if (this.fail) throw Error('Storage full');this.writes.push(key);this.rows.set(key, value); }
}
const scope = (): HomeWritingScope => ({ epoch: randomUUID(), deviceId: 'device:owner', windowId: 'current-window' });
const note = { id: 'widget:one', type: 'note', title: '', size: 'wide', hidden: true, settings: { text: 'Exact incomplete words\n雪' } };
const links = { id: 'widget:two', type: 'links', title: 'Kept links', size: 'wide', hidden: false, settings: { links: [{ id: 'a', label: '', url: 'not a url yet' }, { id: 'b', label: 'Again', url: 'not a url yet' }] } };
function fixture() {
 const s = new Storage(), owner = scope(), key = `e3:home-widget:${owner.epoch}:${owner.deviceId}:previous-window:new`;
 const raw = JSON.stringify({ version: 1, selected: 'links', forms: { note, links }, original: note });
 s.rows.set(key, raw);
 const selected = discoverHomeWriting(s, owner).entries[0];
 return { s, owner, key, raw, selected };
}
test('same-device scan retains all unfinished forms, invalid links, hidden text and full original bytes', () => {
 const { s, owner, key, raw } = fixture();
 s.rows.set(`e3:home-widget:${owner.epoch}:device:foreign:previous:new`, 'private foreign data');
 s.rows.set('e3:journal:device:owner:content:one:old', 'unrelated');
 const found = discoverHomeWriting(s, owner);
 assert.equal(found.entries.length, 1);assert.equal(found.entries[0].key, key);assert.equal(found.entries[0].raw, raw);
 assert.deepEqual(found.entries[0].forms.map(form => form.value), [
  { kind: 'note', title: '', body: note.settings.text, archived: false },
  { kind: 'link', title: '', url: 'not a url yet', body: '', archived: false },
  { kind: 'link', title: 'Again', url: 'not a url yet', body: '', archived: false },
 ]);
 assert.ok(!s.reads.some(key => key.includes('foreign') || key.includes('content:')));assert.deepEqual(s.writes, []);
});
test('foreign workspace and malformed records remain visible and refuse adoption', async () => {
 const { s, owner, key, raw } = fixture();
 const other = { ...owner, epoch: randomUUID() }, kept = discoverHomeWriting(s, other).entries[0];
 assert.match(kept.problem!, /earlier workspace/);
 await assert.rejects(keepHomeWriting(s, kept, kept.forms[0].id, other, () => true), /earlier workspace/);
 s.rows.set(key, '{"unfinished":');
 const malformed = discoverHomeWriting(s, owner).entries[0];assert.equal(malformed.raw, '{"unfinished":');assert.ok(malformed.problem);
 await assert.rejects(keepHomeWriting(s, malformed, 'form:note:note', owner, () => true));
 assert.deepEqual(s.writes, []);assert.notEqual(raw, malformed.raw);
});
test('Layout journal retains exact pending identity and unrelated appearance proposal without submitting it', () => {
 const { s, owner } = fixture(), key = `e3:journal:${owner.deviceId}:layout:old-window`;
 const value = { ...structuredClone(defaultLayout), widgets: [{ ...note, id: 'widget:' + randomUUID(), title: 'Kept original' }], theme: 'dark' };
 const pending = { kind: 'layout', entityId: 'layout', epoch: owner.epoch, requestId: randomUUID(), expectedRevision: 5, payload: value };
 const raw = JSON.stringify({ value, revision: 5, epoch: owner.epoch, dirty: true, pending });
 s.rows.set(key, raw);
 const entry = discoverHomeWriting(s, owner).entries.find(row => row.kind === 'layout')!;
 assert.deepEqual(entry.pending, pending);assert.equal(entry.raw, raw);assert.equal(entry.forms[0].value?.body, note.settings.text);assert.deepEqual(s.writes, []);
});
test('one writer write preserves exact source and embeds original hash; failed navigation reopens the same ID without recopy', async () => {
 const { s, owner, selected, key, raw } = fixture(), form = selected.forms[1];
 const kept = await keepHomeWriting(s, selected, form.id, owner, () => true);
 assert.equal(s.rows.get(key), raw);assert.equal(kept.writer.value.kind, 'link');
 assert.equal(kept.writer.value.kind === 'link' && kept.writer.value.url, 'not a url yet');
 assert.match(kept.writer.homeRecovery.sourceSha256, /^[a-f0-9]{64}$/);
 assert.deepEqual(s.writes, [homeWriterKey(owner)]);
 assert.deepEqual(await keepHomeWriting(s, selected, form.id, owner, () => true), kept);
 assert.deepEqual(readKeptHomeWriting(s, kept, owner, () => true), kept.writer);assert.equal(s.writes.length, 1);
});
test('newer destination writing and mismatched source refuse without overwriting either branch', async () => {
 const { s, owner, selected, key } = fixture(), form = selected.forms[0];
 const kept = await keepHomeWriting(s, selected, form.id, owner, () => true);
 const changed = JSON.stringify({ ...kept.writer, value: { ...kept.writer.value, body: 'Newer writing' } });
 s.rows.set(kept.key, changed);
 await assert.rejects(keepHomeWriting(s, selected, form.id, owner, () => true), /different Library writing/);
 assert.throws(() => readKeptHomeWriting(s, kept, owner, () => true), /changed/);
 assert.equal(s.rows.get(kept.key), changed);
 s.rows.set(key, selected.raw + ' ');
 await assert.rejects(keepHomeWriting(s, selected, form.id, owner, () => true), /original writing changed/);
 assert.equal(s.writes.length, 1);
});
test('scope changes during async hashing and full storage leave original and destination untouched', async () => {
 const { s, owner, selected } = fixture();
 let calls = 0;
 await assert.rejects(keepHomeWriting(s, selected, selected.forms[0].id, owner, () => ++calls === 1), /workspace or active editor changed/);
 assert.deepEqual(s.writes, []);
 s.fail = true;
 await assert.rejects(keepHomeWriting(s, selected, selected.forms[0].id, owner, () => true), /Storage full/);
 assert.equal(s.rows.get(homeWriterKey(owner)), undefined);assert.equal(s.rows.get(selected.key), selected.raw);
});
test('pending Library operation, collection writer and unreadable destination each refuse adoption', async () => {
 for (const suffix of ['command', 'collection', 'item']) {
  const { s, owner, selected } = fixture(), key = suffix === 'command' ? `e3:home-library-command:${owner.deviceId}:${owner.epoch}:${owner.windowId}` : homeWriterKey(owner).replace(/:item$/, ':' + suffix);
  s.rows.set(key, '{"incomplete":');
  await assert.rejects(keepHomeWriting(s, selected, selected.forms[0].id, owner, () => true));
  assert.equal(s.rows.get(key), '{"incomplete":');assert.deepEqual(s.writes, []);
 }
});
test('changed saved old-writer snapshot can be adopted explicitly, never substituted after a refresh', async () => {
 const s = new Storage(), owner = scope();
 const state: HomePreservationState = { status: 'changed', message: 'Kept', mappings: [], current: { revision: 7, updatedAt: '2026-10-20T05:00:00.000Z', widgets: [note, links] } };
 const kept = await keepSavedHomeWriting(s, state, 'current', 'saved:1:link:1', owner, () => state);
 assert.equal(kept.writer.value.title, 'Again');assert.equal(kept.writer.homeRecovery.sourceKey, 'home-layout:current:7');
 const changed = { ...state, current: { ...state.current!, revision: 8 } };
 await assert.rejects(keepSavedHomeWriting(new Storage(), state, 'current', 'saved:0:note', owner, () => changed), /source or workspace changed/);
});
test('scanner reports bounds and keeps oversized original bytes without parsing or silently discarding them', () => {
 const { s, owner, key } = fixture();
 s.rows.set(key, 'x'.repeat(512 * 1024 + 1));
 for (let i = 0; i < 4100; i++) s.rows.set('unrelated:' + i, 'untouched');
 const result = discoverHomeWriting(s, owner);
 assert.match(result.notice, /Only part/);assert.match(result.entries[0].problem!, /too large/);
 assert.equal(result.entries[0].raw.length, 512 * 1024 + 1);assert.deepEqual(s.writes, []);
});
