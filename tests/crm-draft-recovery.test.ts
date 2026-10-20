import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CrmDraft, crmDraftId, readCrmJournal, type CrmCommand, type CrmJournal, type CrmKind, type CrmRecord, type CrmValues } from '../apps/client/src/crm-draft-client';
import { checkCrmCopy, copyCrmDraft, crmRecoveryKey, discoverCrmDrafts, type CrmRecoveryScope } from '../apps/client/src/crm-draft-recovery';

class Memory {
  rows = new Map<string, string>();
  reads: string[] = []; keys: number[] = []; writes: { key: string; raw: string }[] = [];
  failRead = false; failWrite = false; failLength = false; failKey = false;
  readback: 'normal' | 'throw' | 'mismatch' = 'normal';
  private written = false;
  get length() { if (this.failLength) throw Error('Synthetic enumeration refusal'); return this.rows.size; }
  key(index: number) { this.keys.push(index); if (this.failKey) throw Error('Synthetic key refusal'); return [...this.rows.keys()][index] ?? null; }
  getItem(key: string) {
    this.reads.push(key);
    if (this.failRead || this.written && this.readback === 'throw') throw Error('Synthetic read refusal');
    if (this.written && this.readback === 'mismatch') return 'Different stored value';
    return this.rows.get(key) ?? null;
  }
  setItem(key: string, raw: string) {
    if (this.failWrite) throw Error('Synthetic storage full');
    this.writes.push({ key, raw }); this.rows.set(key, raw); this.written = true;
  }
}
function value<K extends CrmKind>(kind: K): CrmValues[K] {
  return (kind === 'activity' ? { kind: 'note', at: '2026-10-19T12:00:00.000Z', text: 'Original activity writing', archived: false }
    : { name: 'Original Organization', website: '', phone: '', industry: '', notes: 'Original organization writing' }) as CrmValues[K];
}
function fixture<K extends CrmKind>(kind: K, revision = 0) {
  const memory = new Memory(), id = kind + ':original', epoch = randomUUID(), deviceId = randomUUID();
  const contactId = kind === 'activity' ? 'contact:original' : undefined;
  const journal: CrmJournal<K> = { format: 1, kind, id, epoch, contactId, revision, value: value(kind), dirty: true };
  const current = (savedRevision: number): CrmRecord<K> => {
    const common = { id, revision: savedRevision, deviceId: 'original-creator', updatedAt: '2026-10-20T08:00:00.000Z' };
    const records = {
      activity: { ...common, value: value('activity'), contactId: 'contact:original' } satisfies CrmRecord<'activity'>,
      organization: { ...common, value: value('organization'), memberIds: [] } satisfies CrmRecord<'organization'>,
    };
    return records[kind] as CrmRecord<K>;
  };
  const scope: CrmRecoveryScope = { kind, epoch, deviceId, windowId: 'destination-window', contactId, records: revision ? [current(revision)] : [] };
  const slot = revision ? id : kind === 'activity' ? contactId + ':new' : 'new';
  const sourceKey = crmRecoveryKey({ ...scope, windowId: 'source-window' }, slot);
  const destinationKey = crmRecoveryKey(scope, slot);
  const raw = JSON.stringify(journal, null, 2); memory.rows.set(sourceKey, raw);
  const entry = () => {
    const result = discoverCrmDrafts(memory, scope).entries.find(row => row.key === sourceKey);
    assert(result); return result;
  };
  const pending: CrmCommand<K> = { requestId: randomUUID(), epoch, id, expectedRevision: revision, value: value(kind), ...(contactId ? { contactId } : {}) };
  const calls: CrmCommand<K>[] = [];
  const owner = () => new CrmDraft(memory, destinationKey, { kind, id: crmDraftId(memory, destinationKey, kind, revision ? id : undefined), epoch, deviceId, contactId },
    { ...journal, dirty: false }, async command => {
      calls.push(structuredClone(command));
      return { ...current(command.expectedRevision + 1), value: structuredClone(command.value) };
    });
  return { kind, memory, journal, scope, id, contactId, slot, sourceKey, destinationKey, raw, pending, entry, current, calls, owner };
}

test('discovery reads only exact same-device and current-contact drafts without writing', () => {
  const f = fixture('activity'), foreignDevice = crmRecoveryKey({ ...f.scope, deviceId: 'other-device' }, f.slot);
  const foreignContact = crmRecoveryKey({ ...f.scope, contactId: 'contact:other' }, 'contact:other:new');
  const foreignExisting = crmRecoveryKey(f.scope, 'activity:other');
  f.memory.rows.set(foreignDevice, f.raw);
  f.memory.rows.set(foreignContact, JSON.stringify({ ...f.journal, contactId: 'contact:other' }));
  f.memory.rows.set(foreignExisting, JSON.stringify({ ...f.journal, id: 'activity:other', contactId: 'contact:other' }));
  f.memory.rows.set('e3:unrelated-writing', 'Do not inspect');
  const before = [...f.memory.rows], result = discoverCrmDrafts(f.memory, f.scope);
  assert.deepEqual(result.entries.map(row => row.key), [f.sourceKey]);
  assert(!f.memory.reads.includes(foreignDevice)); assert(!f.memory.reads.includes(foreignContact));
  assert(!f.memory.reads.includes('e3:unrelated-writing')); assert.deepEqual([...f.memory.rows], before);
  assert.equal(f.memory.writes.length, 0);
});

test('valid original identifiers with embedded colons survive discovery and exact editor routing', () => {
  for (const kind of ['activity', 'organization'] as const) {
    const f = fixture(kind, 2), id = kind + ':imported:original';
    const sourceKey = crmRecoveryKey({ ...f.scope, windowId: 'source-window' }, id);
    const journal = { ...f.journal, id };
    f.memory.rows.clear(); f.memory.rows.set(sourceKey, JSON.stringify(journal));
    f.scope.records = [{ ...f.current(2), id }];
    const entries = discoverCrmDrafts(f.memory, f.scope).entries;
    assert.equal(entries.length, 1); assert.equal(entries[0].problem, undefined);
    const copy = copyCrmDraft(f.memory, entries[0], f.scope);
    assert.equal(copy.slot, id); assert.equal(copy.key, crmRecoveryKey(f.scope, id)); checkCrmCopy(f.memory, copy, f.scope);
  }
});

test('discovery bounds retained entries and inspected keys, leaving overflow bytes untouched', () => {
  const f = fixture('organization'); f.memory.rows.clear();
  for (let i = 0; i < 140; i++) f.memory.rows.set(crmRecoveryKey({ ...f.scope, windowId: `source-${i}` }, 'new'), f.raw);
  const before = [...f.memory.rows], result = discoverCrmDrafts(f.memory, f.scope);
  assert.equal(result.entries.length, 128); assert(result.notice); assert.equal(f.memory.reads.length, 128);
  assert.deepEqual([...f.memory.rows], before); assert.equal(f.memory.writes.length, 0);
  const unrelated = new Memory();
  for (let i = 0; i < 4100; i++) unrelated.rows.set(`unrelated-${i}`, 'not read');
  unrelated.rows.set(f.sourceKey, f.raw);
  const limited = discoverCrmDrafts(unrelated, f.scope);
  assert.equal(unrelated.keys.length, 4096); assert.equal(unrelated.reads.length, 0);
  assert.equal(limited.entries.length, 0); assert(limited.notice); assert.equal(unrelated.writes.length, 0);
});

test('oversized retained values are not parsed into recovery entries and preserve every original byte', () => {
  const f = fixture('organization'), large = 'x'.repeat(4 * 1024 * 1024 + 1);
  f.memory.rows.set(f.sourceKey, large);
  const result = discoverCrmDrafts(f.memory, f.scope);
  assert.equal(result.entries.length, 0); assert(result.notice);
  assert.equal(f.memory.rows.get(f.sourceKey), large); assert.equal(f.memory.writes.length, 0);
});

test('unsupported schema, foreign epoch, wrong editor identity and missing saved records remain read-only', () => {
  for (const kind of ['activity', 'organization'] as const) for (const mode of ['schema', 'epoch', 'identity', 'missing'] as const) {
    const f = fixture(kind, 2);
    const journal = { ...f.journal, ...(mode === 'schema' ? { format: 99 } : mode === 'epoch' ? { epoch: randomUUID() } : mode === 'identity' ? { id: kind + ':different' } : {}) };
    const raw = JSON.stringify(journal); f.memory.rows.set(f.sourceKey, raw);
    if (mode === 'missing') f.scope.records = [];
    const selected = f.entry(); assert(selected.problem);
    assert.throws(() => copyCrmDraft(f.memory, selected, f.scope));
    assert.equal(f.memory.rows.get(f.sourceKey), raw); assert.equal(f.memory.rows.has(f.destinationKey), false);
    assert.equal(f.memory.writes.length, 0);
  }
});

test('malformed keys are ignored and clean completed journals are not offered as unfinished writing', () => {
  const f = fixture('organization');
  f.memory.rows.set(f.sourceKey, JSON.stringify({ ...f.journal, dirty: false }));
  for (const slot of ['contact:other', '../organization:original', 'organization:' + 'x'.repeat(100)])
    f.memory.rows.set(crmRecoveryKey(f.scope, slot), f.raw);
  f.memory.rows.set(crmRecoveryKey({ ...f.scope, windowId: '../window' }, 'new'), f.raw);
  assert.equal(discoverCrmDrafts(f.memory, f.scope).entries.length, 0); assert.equal(f.memory.writes.length, 0);
});

test('legacy idle activity drafts require exact contact slot or the existing original contact record', () => {
  const f = fixture('activity', 2), raw = JSON.stringify({ value: value('activity'), revision: 2 });
  f.memory.rows.set(f.sourceKey, raw);
  assert.equal(f.entry().problem, undefined); assert(f.entry().legacy);
  f.scope.records = [];
  assert.equal(discoverCrmDrafts(f.memory, f.scope).entries.length, 0);
  f.scope.records = [{ ...f.current(2), contactId: 'contact:other' }];
  assert.equal(discoverCrmDrafts(f.memory, f.scope).entries.length, 0);
  assert.equal(f.memory.rows.get(f.sourceKey), raw); assert.equal(f.memory.writes.length, 0);
});

test('legacy pending writing copies byte-exactly and stays blocked until explicit original-command adoption', async () => {
  for (const kind of ['activity', 'organization'] as const) {
    const f = fixture(kind), raw = JSON.stringify({ value: value(kind), revision: 0, pending: f.pending }, null, 2);
    f.memory.rows.set(f.sourceKey, raw);
    const selected = f.entry(); assert(selected.legacy); assert.equal(selected.problem, undefined);
    const copy = copyCrmDraft(f.memory, selected, f.scope); checkCrmCopy(f.memory, copy, f.scope);
    assert.equal(copy.raw, raw); assert.equal(f.memory.rows.get(f.sourceKey), raw);
    const owner = f.owner(); assert(owner.legacy); assert(owner.blocked);
    assert.deepEqual(owner.journal.pending, f.pending); assert.equal(await owner.save(), undefined); assert.equal(f.calls.length, 0);
    assert(owner.adoptLegacy()); assert.equal(owner.journal.legacyOriginal, raw); assert.deepEqual(owner.journal.pending, f.pending);
    assert.equal(f.calls.length, 0); await owner.save();
    assert.deepEqual(f.calls, [f.pending]); assert.equal(f.memory.rows.get(f.sourceKey), raw);
  }
});

test('legacy pending wrong epoch, request shape, record, contact or expected revision cannot be copied', () => {
  for (const mode of ['epoch', 'shape', 'record', 'contact', 'revision'] as const) {
    const f = fixture('activity', 2);
    const pending = { ...f.pending, ...(mode === 'epoch' ? { epoch: randomUUID() } : mode === 'shape' ? { requestId: 'not-a-request' } :
      mode === 'record' ? { id: 'activity:other' } : mode === 'contact' ? { contactId: 'contact:other' } : { expectedRevision: 0 }) };
    const raw = JSON.stringify({ value: value('activity'), revision: 2, pending }); f.memory.rows.set(f.sourceKey, raw);
    assert(f.entry().problem); assert.throws(() => copyCrmDraft(f.memory, f.entry(), f.scope));
    assert.equal(f.memory.rows.get(f.sourceKey), raw); assert.equal(f.memory.writes.length, 0);
  }
});

test('same-window recovery checks the unchanged original and performs no storage write', () => {
  for (const kind of ['activity', 'organization'] as const) {
    const f = fixture(kind), scope = { ...f.scope, windowId: 'source-window' };
    const copy = copyCrmDraft(f.memory, f.entry(), scope); checkCrmCopy(f.memory, copy, scope);
    assert.equal(copy.key, f.sourceKey); assert.equal(copy.raw, f.raw); assert.equal(f.memory.writes.length, 0);
  }
});

test('dirty, pending, legacy-original, foreign and unreadable destinations are never replaced', () => {
  for (const mode of ['dirty', 'pending', 'original', 'legacy', 'epoch', 'contact', 'identity', 'malformed'] as const) {
    const f = fixture('activity', 2), selected = f.entry();
    const destination = { ...f.journal, dirty: false,
      ...(mode === 'dirty' ? { dirty: true } : mode === 'pending' ? { dirty: true, pending: f.pending } :
        mode === 'original' ? { legacyOriginal: 'Earlier exact writing' } : mode === 'epoch' ? { epoch: randomUUID() } :
          mode === 'contact' ? { contactId: 'contact:other' } : mode === 'identity' ? { id: 'activity:other' } : {}) };
    const raw = mode === 'malformed' ? '{original' : mode === 'legacy' ? JSON.stringify({ value: value('activity'), revision: 2 }) : JSON.stringify(destination);
    f.memory.rows.set(f.destinationKey, raw);
    assert.throws(() => copyCrmDraft(f.memory, selected, f.scope));
    assert.equal(f.memory.rows.get(f.destinationKey), raw); assert.equal(f.memory.rows.get(f.sourceKey), f.raw); assert.equal(f.memory.writes.length, 0);
  }
});

test('a clean matching destination can hold the exact recovered bytes without mutating the source', () => {
  const f = fixture('organization', 2), selected = f.entry();
  f.memory.rows.set(f.destinationKey, JSON.stringify({ ...f.journal, dirty: false }));
  const copy = copyCrmDraft(f.memory, selected, f.scope); checkCrmCopy(f.memory, copy, f.scope);
  assert.equal(copy.raw, f.raw); assert.equal(f.memory.rows.get(f.sourceKey), f.raw);
  assert.deepEqual(f.memory.writes, [{ key: f.destinationKey, raw: f.raw }]); assert.equal(f.calls.length, 0);
});

test('source change or disappearance after discovery refuses the copy before any destination write', () => {
  for (const missing of [false, true]) {
    const f = fixture('organization'), selected = f.entry();
    const replacement = JSON.stringify({ ...f.journal, value: { ...value('organization'), notes: 'Newer original' } });
    if (missing) f.memory.rows.delete(f.sourceKey); else f.memory.rows.set(f.sourceKey, replacement);
    assert.throws(() => copyCrmDraft(f.memory, selected, f.scope), /source writing changed/i);
    assert.equal(f.memory.rows.get(f.sourceKey), missing ? undefined : replacement); assert.equal(f.memory.writes.length, 0);
  }
});

test('copy read, write and readback failures never claim a confirmed copy or change source writing', () => {
  for (const mode of ['read', 'write', 'readback-throw', 'readback-mismatch'] as const) {
    const f = fixture('organization'), selected = f.entry();
    if (mode === 'read') f.memory.failRead = true;
    if (mode === 'write') f.memory.failWrite = true;
    if (mode === 'readback-throw') f.memory.readback = 'throw';
    if (mode === 'readback-mismatch') f.memory.readback = 'mismatch';
    assert.throws(() => copyCrmDraft(f.memory, selected, f.scope)); assert.equal(f.memory.rows.get(f.sourceKey), f.raw);
    assert.equal(f.calls.length, 0);
    assert.equal(f.memory.writes.length, mode.startsWith('readback') ? 1 : 0);
    if (mode.startsWith('readback')) assert.equal(f.memory.rows.get(f.destinationKey), f.raw);
  }
});

test('copy revalidation refuses changed target bytes, destination scope, epoch or now-unavailable record', () => {
  for (const mode of ['bytes', 'window', 'epoch', 'record'] as const) {
    const f = fixture('activity', 2), copy = copyCrmDraft(f.memory, f.entry(), f.scope);
    const scope = { ...f.scope };
    if (mode === 'bytes') f.memory.rows.set(copy.key, 'New original destination writing');
    if (mode === 'window') scope.windowId = 'different-window';
    if (mode === 'epoch') scope.epoch = randomUUID();
    if (mode === 'record') scope.records = [];
    assert.throws(() => checkCrmCopy(f.memory, copy, scope));
    assert.equal(f.memory.rows.get(f.sourceKey), f.raw); assert.equal(f.memory.writes.length, 1);
  }
});

test('copied original pending request survives a newer host revision and explicit reconciliation sends only that request', async () => {
  const f = fixture('activity', 2), raw = JSON.stringify({ ...f.journal, pending: f.pending }, null, 2);
  f.memory.rows.set(f.sourceKey, raw); f.scope.records = [f.current(3)];
  const copy = copyCrmDraft(f.memory, f.entry(), f.scope); checkCrmCopy(f.memory, copy, f.scope);
  const owner = f.owner(); assert(owner.changed(f.current(3))); assert(!owner.review(f.current(3)));
  assert.deepEqual(owner.journal.pending, f.pending); assert.equal(f.calls.length, 0);
  assert.equal((await owner.save(f.current(3)))?.revision, 3); assert.deepEqual(f.calls, [f.pending]);
  assert.equal(f.memory.rows.get(f.sourceKey), raw); assert.equal(readCrmJournal(f.memory.rows.get(f.destinationKey)!, 'activity')?.pending, undefined);
});

test('changed saved revision requires explicit editor review while preserving recovered writing and original source', async () => {
  for (const kind of ['activity', 'organization'] as const) {
    const f = fixture(kind, 2); f.scope.records = [f.current(4)];
    const copy = copyCrmDraft(f.memory, f.entry(), f.scope); checkCrmCopy(f.memory, copy, f.scope);
    const owner = f.owner(); assert(owner.changed(f.current(4))); assert.equal(await owner.save(f.current(4)), undefined);
    assert.equal(f.calls.length, 0); assert.equal(owner.journal.revision, 2); assert.deepEqual(owner.journal.value, f.journal.value);
    assert(owner.review(f.current(4))); assert.equal(owner.journal.revision, 4); assert.deepEqual(owner.journal.value, f.journal.value);
    assert.equal(f.calls.length, 0); assert.equal(f.memory.rows.get(f.sourceKey), f.raw);
    const reopened = f.owner(); assert.equal(reopened.journal.revision, 4); assert.deepEqual(reopened.journal.value, f.journal.value);
  }
});

test('discovery storage failures are readable and never write, erase or invent retained entries', () => {
  for (const mode of ['length', 'key', 'read'] as const) {
    const f = fixture('organization');
    f.memory.failLength = mode === 'length'; f.memory.failKey = mode === 'key'; f.memory.failRead = mode === 'read';
    const result = discoverCrmDrafts(f.memory, f.scope);
    assert(result.notice); assert.equal(result.entries.length, 0);
    assert.equal(f.memory.rows.get(f.sourceKey), f.raw); assert.equal(f.memory.writes.length, 0);
  }
});
